import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Grid3x3, Scan, X } from "lucide-react";
import { api, materialImageUrl, type Material } from "../api";
import { cropImage, findOpaqueBounds } from "../imageops/client";
import type { CropRect } from "../imageops/ops";
import { notify } from "../notice";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string) => void;
}

const clampCell = (n: number) => Math.max(1, Math.min(8, Math.floor(n) || 1));

function gridFromMaterialName(name: string): { cols: number; rows: number } {
  const match = /_(\d+)x(\d+)$/.exec(name.trim());
  return match ? { cols: clampCell(Number(match[1])), rows: clampCell(Number(match[2])) } : { cols: 2, rows: 2 };
}

function clampRegion(r: CropRect, imgW: number, imgH: number): CropRect {
  let { x, y, w, h } = r;
  w = Math.max(1, Math.min(Math.round(w), imgW));
  h = Math.max(1, Math.min(Math.round(h), imgH));
  x = Math.max(0, Math.min(Math.round(x), imgW - w));
  y = Math.max(0, Math.min(Math.round(y), imgH - h));
  return { x, y, w, h };
}

/**
 * 多宫格精灵图网格切分：
 * - 可拖动网格区域对齐角色（图片坐标系）
 * - 等分行×列切成独立素材
 * - 可选每格自动裁透明边
 */
export default function GridSplitModal({ material: m, v, onClose, onDone, onToast }: Props) {
  const slot = m.processed_path ? "processed" : "raw";
  const initialGrid = gridFromMaterialName(m.name);
  const [rows, setRows] = useState(initialGrid.rows);
  const [cols, setCols] = useState(initialGrid.cols);
  const [autoMatting, setAutoMatting] = useState(!m.processed_path);
  const [autoTrim, setAutoTrim] = useState(true); // 每格裁透明边
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [region, setRegion] = useState<CropRect | null>(null);
  const [disp, setDisp] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ ax: number; ay: number; rx: number; ry: number } | null>(null);
  const t = useT();
  useModalEscClose(onClose);

  const total = rows * cols;

  // 载入尺寸，默认网格盖住整图
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(materialImageUrl(m.id, v, slot));
        if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        if (!alive) {
          bmp.close();
          return;
        }
        setImgSize({ w: bmp.width, h: bmp.height });
        setRegion({ x: 0, y: 0, w: bmp.width, h: bmp.height });
        bmp.close();
      } catch (e) {
        notify(t("msg.failed_to_read_material_image") + `: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [m.id, v, slot, t]);

  const syncDisp = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    setDisp({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
  }, []);

  useEffect(() => {
    syncDisp();
    window.addEventListener("resize", syncDisp);
    return () => window.removeEventListener("resize", syncDisp);
  }, [syncDisp, imgSize]);

  const scaleX = imgSize ? disp.w / imgSize.w : 1;
  const scaleY = imgSize ? disp.h / imgSize.h : 1;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!region || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { ax: e.clientX, ay: e.clientY, rx: region.x, ry: region.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !imgSize) return;
    const dx = (e.clientX - d.ax) / scaleX;
    const dy = (e.clientY - d.ay) / scaleY;
    // 拖动 = 移动网格区域（对齐图片内容）
    setRegion((prev) => {
      if (!prev) return prev;
      return clampRegion({ ...prev, x: d.rx + dx, y: d.ry + dy }, imgSize.w, imgSize.h);
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /** 把网格区域收成整图不透明包围盒 */
  const fitOpaque = async () => {
    if (!imgSize || busy) return;
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
      const bounds = await findOpaqueBounds(blob);
      if (!bounds) {
        notify(t("msg.no_opaque_region_found"), "info");
        return;
      }
      setRegion(clampRegion(bounds, imgSize.w, imgSize.h));
    } catch (e) {
      notify(t("msg.auto_select_failed_msg", { msg: (e as Error).message }));
    }
  };

  const resetRegion = () => {
    if (!imgSize) return;
    setRegion({ x: 0, y: 0, w: imgSize.w, h: imgSize.h });
  };

  const nudge = (dx: number, dy: number) => {
    if (!region || !imgSize) return;
    setRegion(clampRegion({ ...region, x: region.x + dx, y: region.y + dy }, imgSize.w, imgSize.h));
  };

  const split = async () => {
    if (busy || !region || !imgSize) return;
    if (region.w < cols || region.h < rows) {
      notify(t("msg.region_w_h_smaller_than_grid_cols_rows", { w: region.w, h: region.h, cols, rows }));
      return;
    }
    setBusy(true);
    let ok = 0;
    let fail = 0;
    let trimmed = 0;
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
      let rawBlob = blob;
      if (m.processed_path) {
        const rawResponse = await fetch(materialImageUrl(m.id, v, "raw"));
        if (!rawResponse.ok) throw new Error(t("msg.failed_to_read_material_image"));
        rawBlob = await rawResponse.blob();
      }
      const cw = Math.floor(region.w / cols);
      const ch = Math.floor(region.h / rows);
      const base = m.name.replace(/\s*#\d+$/, "").trim() || t("common.material");
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c + 1;
          setProgress(t("msg.uploading_split_i_total", { i, total }));
          try {
            const w = c === cols - 1 ? region.w - cw * c : cw;
            const h = r === rows - 1 ? region.h - ch * r : ch;
            const cellRect = {
              x: region.x + cw * c,
              y: region.y + ch * r,
              w,
              h,
            };
            let cell = await cropImage(blob, cellRect);
            let rawCell = m.processed_path ? await cropImage(rawBlob, cellRect) : cell;
            if (autoTrim) {
              const bounds = await findOpaqueBounds(cell);
              if (bounds && (bounds.w < w || bounds.h < h || bounds.x > 0 || bounds.y > 0)) {
                cell = await cropImage(cell, bounds);
                if (m.processed_path) rawCell = await cropImage(rawCell, bounds);
                trimmed++;
              }
            }
            const fd = new FormData();
            fd.append("file", rawCell, `${base}_r${r + 1}c${c + 1}.png`);
            if (m.processed_path) fd.append("processedFile", cell, `${base}_r${r + 1}c${c + 1}_processed.png`);
            fd.append("autoMatting", String(autoMatting && !m.processed_path));
            fd.append("metadata", JSON.stringify({
              gridSplit: {
                fromMaterial: m.id,
                rows,
                cols,
                row: r + 1,
                col: c + 1,
                sourceSlot: slot,
                autoTrim,
              },
            }));
            if (m.folder_id) fd.append("folderId", m.folder_id);
            await api.uploadMaterial(fd);
            ok++;
          } catch {
            fail++;
          }
        }
      }
      onDone();
      const msg = fail
        ? t("msg.split_done_ok_ok_fail_failed", { ok, fail })
        : autoTrim && trimmed > 0
          ? t("msg.split_ok_materials_auto_trimmed_trimmed", { ok, trimmed })
          : t("msg.created_ok_materials", { ok });
      onToast(msg);
      onClose();
    } catch (e) {
      notify(t("msg.split_failed_msg", { msg: (e as Error).message }));
      setBusy(false);
      setProgress("");
    }
  };

  const regionStyle =
    region && imgSize
      ? {
          left: region.x * scaleX,
          top: region.y * scaleY,
          width: region.w * scaleX,
          height: region.h * scaleY,
        }
      : undefined;

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}  >
      <motion.div
        className="modal pixel-panel gs-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("msg.grid_split")}</h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="hint">
          {t("msg.target_target_drag_grid_to_align_split_cells_into_materi", {
            target: slot === "processed" ? t("msg.matted") : t("msg.original"),
          })}
        </div>

        <div
          className="gs-wrap"
          ref={wrapRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <img
            ref={imgRef}
            src={materialImageUrl(m.id, v, slot)}
            alt={m.name}
            draggable={false}
            onLoad={syncDisp}
          />
          {regionStyle && (
            <div className="gs-region" style={regionStyle}>
              {Array.from({ length: cols - 1 }, (_, i) => (
                <div key={`v${i}`} className="gs-line v" style={{ left: `${((i + 1) / cols) * 100}%` }} />
              ))}
              {Array.from({ length: rows - 1 }, (_, i) => (
                <div key={`h${i}`} className="gs-line h" style={{ top: `${((i + 1) / rows) * 100}%` }} />
              ))}
            </div>
          )}
        </div>

        <div className="form-inline gs-tools">
          <IconBtn title={t("msg.fit_opaque_bounds")} disabled={busy || !imgSize} onClick={() => void fitOpaque()}>
            <Scan size={14} />
          </IconBtn>
          <button type="button" className="px-btn mini" disabled={busy || !imgSize} onClick={resetRegion}>
            {t("msg.reset_to_full_image")}
          </button>
          <button type="button" className="px-btn mini" disabled={busy || !region} onClick={() => nudge(-1, 0)}>
            ←
          </button>
          <button type="button" className="px-btn mini" disabled={busy || !region} onClick={() => nudge(1, 0)}>
            →
          </button>
          <button type="button" className="px-btn mini" disabled={busy || !region} onClick={() => nudge(0, -1)}>
            ↑
          </button>
          <button type="button" className="px-btn mini" disabled={busy || !region} onClick={() => nudge(0, 1)}>
            ↓
          </button>
          {region && imgSize && (
            <span className="gs-total">
              {t("msg.region_x_y_w_h", { x: region.x, y: region.y, w: region.w, h: region.h })}
            </span>
          )}
        </div>

        <div className="form-inline">
          <label className="px-check">
            {t("msg.cols")}
            <input
              className="px-input num"
              type="number"
              min={1}
              max={8}
              value={cols}
              disabled={busy}
              onChange={(e) => setCols(clampCell(Number(e.target.value)))}
            />
          </label>
          <label className="px-check">
            {t("msg.rows")}
            <input
              className="px-input num"
              type="number"
              min={1}
              max={8}
              value={rows}
              disabled={busy}
              onChange={(e) => setRows(clampCell(Number(e.target.value)))}
            />
          </label>
          <span className="gs-total">{t("msg.total_cells", { total })}</span>
        </div>

        <label className="px-check">
          <input type="checkbox" checked={autoTrim} disabled={busy} onChange={(e) => setAutoTrim(e.target.checked)} />
          {t("msg.auto_trim_transparent_edges_per_cell")}
        </label>

        {!m.processed_path && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}

        <div className="modal-actions">
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={busy || !region}
            onClick={() => void split()}
          >
            <Grid3x3 size={14} /> {busy ? progress || t("msg.splitting") : t("msg.split_into_total_materials", { total })}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
