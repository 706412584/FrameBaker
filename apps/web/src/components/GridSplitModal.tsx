import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Bone, Grid3x3, Scan, X } from "lucide-react";
import { CHARACTER_PART_ROLES, type CharacterPartRole, type CharacterPartSet, type CharacterPartSetMember } from "@framebaker/shared";
import { api, materialImageUrl, type Material } from "../api";
import { cropImage, findOpaqueBounds } from "../imageops/client";
import type { CropRect } from "../imageops/ops";
import { notify } from "../notice";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import PxSelect from "./PxSelect";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string) => void;
}

const clampCell = (n: number) => Math.max(1, Math.min(8, Math.floor(n) || 1));
const DEFAULT_PART_ROLES: CharacterPartRole[] = ["head", "torso", "arm-left", "arm-right", "leg-left", "leg-right", "weapon", "accessory"];

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
  const t = useT();
  const slot = m.processed_path ? "processed" : "raw";
  const guidedSkeletalSplit = m.metadata.intent === "skeletal-parts" || m.metadata.intent === "skeletal-decompose";
  const hintedPartSetId = typeof m.metadata.characterPartSetId === "string" ? m.metadata.characterPartSetId : "";
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(guidedSkeletalSplit ? 3 : 2);
  const [autoMatting, setAutoMatting] = useState(true);
  const [autoTrim, setAutoTrim] = useState(true); // 每格裁透明边
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [splitLine, setSplitLine] = useState<"frame" | "skeletal">(guidedSkeletalSplit ? "skeletal" : "frame");
  const [partSets, setPartSets] = useState<CharacterPartSet[]>([]);
  const [partSetId, setPartSetId] = useState(hintedPartSetId);
  const [partSetName, setPartSetName] = useState(`${m.name} · ${t("skeletal.parts.setSuffix")}`);
  const [partDrafts, setPartDrafts] = useState<Array<{ role: CharacterPartRole; name: string }>>([]);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [region, setRegion] = useState<CropRect | null>(null);
  const [disp, setDisp] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ ax: number; ay: number; rx: number; ry: number } | null>(null);
  useModalEscClose(onClose);

  const total = rows * cols;

  useEffect(() => {
    api.listCharacterPartSets().then((sets) => {
      setPartSets(sets);
      if (hintedPartSetId && !sets.some((set) => set.id === hintedPartSetId)) setPartSetId("");
    }).catch(() => setPartSets([]));
  }, [hintedPartSetId]);

  useEffect(() => {
    setPartDrafts((current) => Array.from({ length: total }, (_, index) => current[index] ?? {
      role: DEFAULT_PART_ROLES[index] ?? "custom",
      name: t(`skeletal.partRole.${DEFAULT_PART_ROLES[index] ?? "custom"}`),
    }));
  }, [total, t]);

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
    const createdMembers: CharacterPartSetMember[] = [];
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
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
            let cell = await cropImage(blob, {
              x: region.x + cw * c,
              y: region.y + ch * r,
              w,
              h,
            });
            if (autoTrim) {
              const bounds = await findOpaqueBounds(cell);
              if (bounds && (bounds.w < w || bounds.h < h || bounds.x > 0 || bounds.y > 0)) {
                cell = await cropImage(cell, bounds);
                trimmed++;
              }
            }
            const fd = new FormData();
            fd.append("file", cell, `${base}_r${r + 1}c${c + 1}.png`);
            fd.append("autoMatting", String(autoMatting));
            if (m.folder_id) fd.append("folderId", m.folder_id);
            const uploaded = await api.uploadMaterial(fd);
            if (splitLine === "skeletal") {
              if (!("materialId" in uploaded)) throw new Error(t("skeletal.split.imageUploadExpected"));
              const draft = partDrafts[i - 1];
              createdMembers.push({ materialId: uploaded.materialId, role: draft.role, name: draft.name.trim() || `${base} ${i}` });
            }
            ok++;
          } catch {
            fail++;
          }
        }
      }
      if (splitLine === "skeletal" && createdMembers.length > 0) {
        if (partSetId) {
          const target = partSets.find((set) => set.id === partSetId) ?? await api.getCharacterPartSet(partSetId);
          const updated = await api.putCharacterPartSet(target.id, {
            name: target.name,
            referenceMaterialId: target.referenceMaterialId ?? m.id,
            members: [...target.members, ...createdMembers],
          });
          setPartSets((items) => items.map((set) => set.id === updated.id ? updated : set));
        } else {
          const created = await api.createCharacterPartSet({
            name: partSetName.trim(),
            source: "decomposed",
            referenceMaterialId: m.id,
            members: createdMembers,
          });
          setPartSets((items) => [created, ...items]);
          setPartSetId(created.id);
        }
      }
      onDone();
      const msg = splitLine === "skeletal" && fail === 0
        ? t("skeletal.split.createdParts", { count: createdMembers.length })
        : fail
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
        className={`modal pixel-panel gs-modal ${splitLine === "skeletal" ? "skeletal-mode" : "frame-mode"}`}
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gs-header">
          <div>
            <h2>{t("msg.grid_split")}</h2>
            <p>
              {t("msg.target_target_drag_grid_to_align_split_cells_into_materi", {
                target: slot === "processed" ? t("msg.matted") : t("msg.original"),
              })}
            </p>
          </div>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </header>

        <div className="generation-line-tabs" role="tablist" aria-label={t("skeletal.split.lineTitle")}>
          <button type="button" role="tab" aria-selected={splitLine === "frame"} className={splitLine === "frame" ? "active" : ""} disabled={busy} onClick={() => setSplitLine("frame")}>
            <Grid3x3 size={14} /> {t("skeletal.split.frameCells")}
          </button>
          <button type="button" role="tab" aria-selected={splitLine === "skeletal"} className={splitLine === "skeletal" ? "active" : ""} disabled={busy} onClick={() => setSplitLine("skeletal")}>
            <Bone size={14} /> {t("skeletal.split.characterParts")}
          </button>
        </div>

        <div className="gs-layout">
          <section className="gs-preview-pane">
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

            <div className="gs-preview-controls">
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

              <div className="form-inline gs-grid-settings">
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
                <strong className="gs-total">{t("msg.total_cells", { total })}</strong>
              </div>

              <div className="gs-options">
                <label className="px-check">
                  <input type="checkbox" checked={autoTrim} disabled={busy} onChange={(e) => setAutoTrim(e.target.checked)} />
                  {t("msg.auto_trim_transparent_edges_per_cell")}
                </label>
                <MattingOption checked={autoMatting} onChange={setAutoMatting} />
              </div>
            </div>
          </section>

          {splitLine === "skeletal" && (
            <aside className="skeletal-split-setup">
              <div>
                <strong>{t("skeletal.split.destination")}</strong>
                <div className="hint">{t("skeletal.split.destinationHint")}</div>
              </div>
              <PxSelect
                value={partSetId}
                options={[{ value: "", label: t("skeletal.split.createNewSet") }, ...partSets.map((set) => ({ value: set.id, label: `${set.name} · ${set.members.length}` }))]}
                onChange={setPartSetId}
              />
              {!partSetId && (
                <input className="px-input" value={partSetName} disabled={busy} onChange={(e) => setPartSetName(e.target.value)} placeholder={t("skeletal.parts.newSetName")} />
              )}
              <div className="skeletal-split-members">
                {partDrafts.map((draft, index) => (
                  <div className="skeletal-split-member" key={index}>
                    <span>{t("skeletal.split.cell", { index: index + 1 })}</span>
                    <PxSelect
                      value={draft.role}
                      options={CHARACTER_PART_ROLES.map((role) => ({ value: role, label: t(`skeletal.partRole.${role}`) }))}
                      onChange={(role) => setPartDrafts((items) => items.map((item, i) => i === index ? { ...item, role: role as CharacterPartRole } : item))}
                      disabled={busy}
                    />
                    <input
                      className="px-input"
                      value={draft.name}
                      disabled={busy}
                      onChange={(e) => setPartDrafts((items) => items.map((item, i) => i === index ? { ...item, name: e.target.value } : item))}
                      aria-label={t("skeletal.split.partName", { index: index + 1 })}
                    />
                  </div>
                ))}
              </div>
            </aside>
          )}
        </div>

        <footer className="modal-actions gs-footer">
          <button type="button" className="px-btn" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={busy || !region || (splitLine === "skeletal" && !partSetId && !partSetName.trim())}
            onClick={() => void split()}
          >
            <Grid3x3 size={14} /> {busy ? progress || t("msg.splitting") : t("msg.split_into_total_materials", { total })}
          </motion.button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
