import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Bone, Grid3x3, Scan, X } from "lucide-react";
import { ARTICULATED_CHARACTER_PART_ROLES, type CharacterPartRole, type CharacterPartSet, type CharacterPartSetMember } from "@framebaker/shared";
import { api, materialImageUrl, type Material } from "../api";
import { analyzeImage, cropImage, findOpaqueBounds } from "../imageops/client";
import { findSkeletalPartQualityIssues, type CropRect, type SkeletalPartQualityIssue } from "../imageops/ops";
import { notify } from "../notice";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import PxSelect from "./PxSelect";

interface Props {
  material: Material;
  v: number;
  initialLine?: "frame" | "skeletal";
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string) => void;
}

const clampCell = (n: number) => Math.max(1, Math.min(8, Math.floor(n) || 1));
const MAX_CELL_SHIFT_RATIO = 0.4;
const DEFAULT_PART_ROLES: CharacterPartRole[] = [...ARTICULATED_CHARACTER_PART_ROLES];
type CellOffset = { x: number; y: number };

interface SkeletalReview {
  cells: Blob[];
  previews: string[];
  issues: SkeletalPartQualityIssue[];
}

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
export default function GridSplitModal({ material: m, v, initialLine, onClose, onDone, onToast }: Props) {
  const t = useT();
  const slot = m.processed_path ? "processed" : "raw";
  const guidedSkeletalSplit = m.metadata.intent === "skeletal-parts" || m.metadata.intent === "skeletal-decompose";
  const hintedPartSetId = typeof m.metadata.characterPartSetId === "string" ? m.metadata.characterPartSetId : "";
  const hintedRows = typeof m.metadata.gridRows === "number" ? clampCell(m.metadata.gridRows) : 3;
  const hintedCols = typeof m.metadata.gridCols === "number" ? clampCell(m.metadata.gridCols) : 4;
  const initialGrid = gridFromMaterialName(m.name);
  const startsSkeletal = initialLine === "skeletal" || (initialLine == null && guidedSkeletalSplit);
  const [rows, setRows] = useState(startsSkeletal ? hintedRows : initialGrid.rows);
  const [cols, setCols] = useState(startsSkeletal ? hintedCols : initialGrid.cols);
  const [autoMatting, setAutoMatting] = useState(!m.processed_path);
  const [autoTrim, setAutoTrim] = useState(true); // 每格裁透明边
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [splitLine, setSplitLine] = useState<"frame" | "skeletal">(initialLine ?? (guidedSkeletalSplit ? "skeletal" : "frame"));
  const [partSets, setPartSets] = useState<CharacterPartSet[]>([]);
  const [partSetId, setPartSetId] = useState(hintedPartSetId);
  const [partSetName, setPartSetName] = useState(`${m.name} · ${t("skeletal.parts.setSuffix")}`);
  const [partDrafts, setPartDrafts] = useState<Array<{ role: CharacterPartRole; name: string }>>([]);
  const [skeletalReview, setSkeletalReview] = useState<SkeletalReview | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [region, setRegion] = useState<CropRect | null>(null);
  const [cellViewportSize, setCellViewportSize] = useState<{ w: number; h: number } | null>(null);
  const [cellOffsets, setCellOffsets] = useState<CellOffset[]>([]);
  const [disp, setDisp] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ ax: number; ay: number; rx: number; ry: number } | null>(null);
  const cellDragRef = useRef<{ index: number; ax: number; ay: number; ox: number; oy: number } | null>(null);
  useModalEscClose(onClose);

  const skipCenter = splitLine === "frame" && /_8directions_3x3$/.test(m.name.trim()) && rows === 3 && cols === 3;
  const total = rows * cols - (skipCenter ? 1 : 0);
  const standardHumanoidGrid = splitLine === "skeletal" && rows === 3 && cols === 4;

  useEffect(() => () => {
    skeletalReview?.previews.forEach((url) => URL.revokeObjectURL(url));
  }, [skeletalReview]);

  useEffect(() => {
    setSkeletalReview(null);
    setReviewConfirmed(false);
    setCellOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
  }, [region?.x, region?.y, region?.w, region?.h, rows, cols, slot, cellViewportSize?.w, cellViewportSize?.h]);

  useEffect(() => setReviewConfirmed(false), [partSetId]);

  useEffect(() => {
    api.listCharacterPartSets().then((sets) => {
      setPartSets(sets);
      if (hintedPartSetId && !sets.some((set) => set.id === hintedPartSetId)) setPartSetId("");
    }).catch(() => setPartSets([]));
  }, [hintedPartSetId]);

  useEffect(() => {
    setPartDrafts(Array.from({ length: total }, (_, index) => ({
      role: standardHumanoidGrid ? DEFAULT_PART_ROLES[index] ?? "custom" : "custom",
      name: standardHumanoidGrid ? t(`skeletal.partRole.${DEFAULT_PART_ROLES[index] ?? "custom"}`) : t("skeletal.split.customPartName", { index: index + 1 }),
    })));
  }, [standardHumanoidGrid, total, t]);

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
        setCellViewportSize(null);
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

  const baseCellRect = (index: number): CropRect | null => {
    if (!region) return null;
    const row = Math.floor(index / cols);
    const col = index % cols;
    const cellWidth = Math.floor(region.w / cols);
    const cellHeight = Math.floor(region.h / rows);
    const slot = {
      x: region.x + cellWidth * col,
      y: region.y + cellHeight * row,
      w: col === cols - 1 ? region.w - cellWidth * col : cellWidth,
      h: row === rows - 1 ? region.h - cellHeight * row : cellHeight,
    };
    if (splitLine !== "skeletal" || !cellViewportSize || !imgSize) return slot;
    const w = Math.max(1, Math.min(cellViewportSize.w, imgSize.w));
    const h = Math.max(1, Math.min(cellViewportSize.h, imgSize.h));
    return {
      x: Math.max(0, Math.min(imgSize.w - w, Math.round(slot.x + slot.w / 2 - w / 2))),
      y: Math.max(0, Math.min(imgSize.h - h, Math.round(slot.y + slot.h / 2 - h / 2))),
      w,
      h,
    };
  };

  const adjustedCellRect = (index: number): CropRect | null => {
    const base = baseCellRect(index);
    if (!base) return null;
    const offset = cellOffsets[index] ?? { x: 0, y: 0 };
    return { ...base, x: base.x + offset.x, y: base.y + offset.y };
  };

  const clampCellOffset = (index: number, offset: CellOffset): CellOffset => {
    const base = baseCellRect(index);
    if (!base || !imgSize) return { x: 0, y: 0 };
    const maxX = Math.max(1, Math.round(base.w * MAX_CELL_SHIFT_RATIO));
    const maxY = Math.max(1, Math.round(base.h * MAX_CELL_SHIFT_RATIO));
    return {
      x: Math.max(-maxX, -base.x, Math.min(maxX, imgSize.w - base.w - base.x, Math.round(offset.x))),
      y: Math.max(-maxY, -base.y, Math.min(maxY, imgSize.h - base.h - base.y, Math.round(offset.y))),
    };
  };

  const onCellPointerDown = (index: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const offset = cellOffsets[index] ?? { x: 0, y: 0 };
    cellDragRef.current = { index, ax: e.clientX, ay: e.clientY, ox: offset.x, oy: offset.y };
    setSkeletalReview(null);
    setReviewConfirmed(false);
  };

  const onCellPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = cellDragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const dx = (e.clientX - drag.ax) / scaleX;
    const dy = (e.clientY - drag.ay) / scaleY;
    const next = clampCellOffset(drag.index, { x: drag.ox - dx, y: drag.oy - dy });
    setCellOffsets((items) => items.map((item, index) => index === drag.index ? next : item));
  };

  const onCellPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    cellDragRef.current = null;
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

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

  const selectSplitLine = (line: "frame" | "skeletal") => {
    setSplitLine(line);
    setCellViewportSize(null);
    setSkeletalReview(null);
    setReviewConfirmed(false);
    if (line === "skeletal") {
      setCols(guidedSkeletalSplit ? hintedCols : 4);
      setRows(guidedSkeletalSplit ? hintedRows : 3);
    }
  };

  const prepareSkeletalReview = async () => {
    if (!region || !imgSize) return;
    setBusy(true);
    setProgress(t("skeletal.split.analyzing", { count: total }));
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
      const cells: Blob[] = [];
      for (let index = 0; index < rows * cols; index++) {
        const rect = adjustedCellRect(index);
        if (rect) cells.push(await cropImage(blob, rect));
      }
      const analyses = await Promise.all(cells.map(analyzeImage));
      const issues = findSkeletalPartQualityIssues(analyses);
      setSkeletalReview({ cells, issues, previews: cells.map((cell) => URL.createObjectURL(cell)) });
      setReviewConfirmed(false);
      if (issues.length > 0) notify(t("skeletal.split.qualityBlocked", { count: issues.length }));
    } catch (e) {
      notify(t("skeletal.split.analysisFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const split = async () => {
    if (busy || !region || !imgSize) return;
    if (splitLine === "skeletal" && !skeletalReview) {
      await prepareSkeletalReview();
      return;
    }
    if (splitLine === "skeletal" && skeletalReview?.issues.length) {
      notify(t("skeletal.split.mustFixQuality"));
      return;
    }
    if (splitLine === "skeletal" && !reviewConfirmed) {
      notify(t("skeletal.split.mustConfirmReview"));
      return;
    }
    if (region.w < cols || region.h < rows) {
      notify(t("msg.region_w_h_smaller_than_grid_cols_rows", { w: region.w, h: region.h, cols, rows }));
      return;
    }
    setBusy(true);
    let ok = 0;
    let fail = 0;
    let trimmed = 0;
    const createdMembers: CharacterPartSetMember[] = [];
    let firstError = "";
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
      const preparedCells = splitLine === "skeletal" ? skeletalReview!.cells : null;
      const base = m.name.replace(/\s*#\d+$/, "").trim() || t("common.material");
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (skipCenter && r === 1 && c === 1) continue;
          const i = r * cols + c + 1 - (skipCenter && r > 1 ? 1 : 0);
          setProgress(t("msg.uploading_split_i_total", { i, total }));
          try {
            const cellIndex = r * cols + c;
            const cellRect = splitLine === "skeletal" ? adjustedCellRect(cellIndex)! : baseCellRect(cellIndex)!;
            const { w, h } = cellRect;
            let cell = preparedCells?.[i - 1] ?? await cropImage(blob, cellRect);
            let rawCell = m.processed_path ? await cropImage(rawBlob, cellRect) : cell;
            if (autoTrim) {
              const bounds = await findOpaqueBounds(cell);
              if (bounds && (bounds.w < w || bounds.h < h || bounds.x > 0 || bounds.y > 0)) {
                cell = await cropImage(cell, bounds);
                if (m.processed_path) rawCell = await cropImage(rawCell, bounds);
                trimmed++;
              }
            }
            const draft = splitLine === "skeletal" ? partDrafts[i - 1] : undefined;
            const fd = new FormData();
            const partName = draft?.name.trim();
            const cellName = draft ? partName || `${base}_${draft.role}` : `${base}_r${r + 1}c${c + 1}`;
            fd.append("file", rawCell, `${cellName}.png`);
            if (m.processed_path) fd.append("processedFile", cell, `${cellName}_processed.png`);
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
                ...(splitLine === "skeletal" ? {
                  offset: cellOffsets[cellIndex] ?? { x: 0, y: 0 },
                  viewport: { w: cellRect.w, h: cellRect.h },
                } : {}),
              },
            }));
            if (m.folder_id) fd.append("folderId", m.folder_id);
            const uploaded = await api.uploadMaterial(fd);
            if (splitLine === "skeletal") {
              if (!("materialId" in uploaded)) throw new Error(t("skeletal.split.imageUploadExpected"));
              createdMembers.push({ materialId: uploaded.materialId, role: draft!.role, name: partName || `${base} ${i}` });
            }
            ok++;
          } catch (e) {
            fail++;
            firstError ||= (e as Error).message;
          }
        }
      }
      if (splitLine === "skeletal" && (fail > 0 || createdMembers.length !== total)) {
        throw new Error(t("skeletal.split.partialUploadBlocked", { ok, fail }));
      }
      if (splitLine === "skeletal") {
        const lineageReferenceId = typeof m.metadata.referenceMaterialId === "string" ? m.metadata.referenceMaterialId : null;
        if (partSetId) {
          const target = partSets.find((set) => set.id === partSetId) ?? await api.getCharacterPartSet(partSetId);
          const preservedMembers = standardHumanoidGrid ? target.members.filter((member) => !ARTICULATED_CHARACTER_PART_ROLES.includes(member.role as typeof ARTICULATED_CHARACTER_PART_ROLES[number])) : [];
          const updated = await api.putCharacterPartSet(target.id, {
            name: target.name,
            referenceMaterialId: lineageReferenceId ?? target.referenceMaterialId,
            members: [...preservedMembers, ...createdMembers],
          });
          setPartSets((items) => items.map((set) => set.id === updated.id ? updated : set));
        } else {
          const created = await api.createCharacterPartSet({
            name: partSetName.trim(),
            source: "decomposed",
            referenceMaterialId: lineageReferenceId,
            members: createdMembers,
          });
          setPartSets((items) => [created, ...items]);
          setPartSetId(created.id);
        }
      }
      if (ok === 0 && firstError) throw new Error(firstError);
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
          <button type="button" role="tab" aria-selected={splitLine === "frame"} className={splitLine === "frame" ? "active" : ""} disabled={busy} onClick={() => selectSplitLine("frame")}>
            <Grid3x3 size={14} /> {t("skeletal.split.frameCells")}
          </button>
          <button type="button" role="tab" aria-selected={splitLine === "skeletal"} className={splitLine === "skeletal" ? "active" : ""} disabled={busy} onClick={() => selectSplitLine("skeletal")}>
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
                <div className={`gs-region${splitLine === "skeletal" ? " skeletal-cells" : ""}`} style={regionStyle}>
                  {splitLine === "skeletal" ? Array.from({ length: rows * cols }, (_, index) => {
                    const base = baseCellRect(index)!;
                    const adjusted = adjustedCellRect(index)!;
                    return <div
                      className="gs-cell-window"
                      key={index}
                      style={{
                        left: (base.x - region!.x) * scaleX,
                        top: (base.y - region!.y) * scaleY,
                        width: base.w * scaleX,
                        height: base.h * scaleY,
                      }}
                      onPointerDown={(event) => onCellPointerDown(index, event)}
                      onPointerMove={onCellPointerMove}
                      onPointerUp={onCellPointerUp}
                      onPointerCancel={onCellPointerUp}
                      onDoubleClick={() => setCellOffsets((items) => items.map((item, itemIndex) => itemIndex === index ? { x: 0, y: 0 } : item))}
                    >
                      <img
                        src={materialImageUrl(m.id, v, slot)}
                        alt=""
                        draggable={false}
                        style={{
                          width: disp.w,
                          height: disp.h,
                          left: -adjusted.x * scaleX,
                          top: -adjusted.y * scaleY,
                        }}
                      />
                      <span>{index + 1}</span>
                    </div>;
                  }) : <>
                    {Array.from({ length: cols - 1 }, (_, i) => (
                      <div key={`v${i}`} className="gs-line v" style={{ left: `${((i + 1) / cols) * 100}%` }} />
                    ))}
                    {Array.from({ length: rows - 1 }, (_, i) => (
                      <div key={`h${i}`} className="gs-line h" style={{ top: `${((i + 1) / rows) * 100}%` }} />
                    ))}
                  </>}
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

              {splitLine === "skeletal" && region && imgSize && <div className="gs-cell-size-settings">
                <label className="px-check">
                  {t("skeletal.split.cellWidthPx")}
                  <input
                    className="px-input num"
                    type="number"
                    min={1}
                    max={imgSize.w}
                    value={cellViewportSize?.w ?? Math.max(1, Math.floor(region.w / cols))}
                    disabled={busy}
                    onChange={(event) => setCellViewportSize((size) => ({
                      w: Math.max(1, Math.min(imgSize.w, Math.round(Number(event.target.value)) || 1)),
                      h: size?.h ?? Math.max(1, Math.floor(region.h / rows)),
                    }))}
                  />
                </label>
                <label className="px-check">
                  {t("skeletal.split.cellHeightPx")}
                  <input
                    className="px-input num"
                    type="number"
                    min={1}
                    max={imgSize.h}
                    value={cellViewportSize?.h ?? Math.max(1, Math.floor(region.h / rows))}
                    disabled={busy}
                    onChange={(event) => setCellViewportSize((size) => ({
                      w: size?.w ?? Math.max(1, Math.floor(region.w / cols)),
                      h: Math.max(1, Math.min(imgSize.h, Math.round(Number(event.target.value)) || 1)),
                    }))}
                  />
                </label>
                <button type="button" className="px-btn mini" disabled={busy || !cellViewportSize} onClick={() => setCellViewportSize(null)}>
                  {t("skeletal.split.resetCellSize")}
                </button>
                <span className="hint">{t("skeletal.split.cellSizeHint")}</span>
              </div>}

              <div className="gs-options">
                <label className="px-check">
                  <input type="checkbox" checked={autoTrim} disabled={busy} onChange={(e) => setAutoTrim(e.target.checked)} />
                  {t("msg.auto_trim_transparent_edges_per_cell")}
                </label>
                {!m.processed_path && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}
              </div>
            </div>
          </section>

          {splitLine === "skeletal" && (
            <aside className="skeletal-split-setup">
              <div>
                <strong>{t("skeletal.split.destination")}</strong>
                <div className="hint">{t("skeletal.split.destinationHint")}</div>
                <div className="hint">{t("skeletal.split.qualityHint")}</div>
                <div className="hint">{t("skeletal.split.dragCellsHint")}</div>
              </div>
              <PxSelect
                value={partSetId}
                options={[{ value: "", label: t("skeletal.split.createNewSet") }, ...partSets.map((set) => ({ value: set.id, label: `${set.name} · ${set.members.length}` }))]}
                onChange={setPartSetId}
              />
              {!partSetId && (
                <input className="px-input" value={partSetName} disabled={busy} onChange={(e) => setPartSetName(e.target.value)} placeholder={t("skeletal.parts.newSetName")} />
              )}
              {(() => {
                const target = partSets.find((set) => set.id === partSetId);
                const lineageReferenceId = typeof m.metadata.referenceMaterialId === "string" ? m.metadata.referenceMaterialId : null;
                const referenceId = lineageReferenceId ?? target?.referenceMaterialId;
                return referenceId ? <div className="skeletal-identity-reference">
                  <img src={materialImageUrl(referenceId, v, "processed")} alt={t("skeletal.split.identityReference")} />
                  <span><strong>{t("skeletal.split.identityReference")}</strong><small>{t("skeletal.split.identityReferenceHint")}</small></span>
                </div> : null;
              })()}
              {skeletalReview && <div className={`skeletal-quality-summary ${skeletalReview.issues.length ? "error" : "ok"}`}>
                <strong>{t(skeletalReview.issues.length ? "skeletal.split.qualityFailed" : "skeletal.split.qualityPassed")}</strong>
                {skeletalReview.issues.map((issue, index) => <span key={`${issue.code}-${issue.cells.join("-")}-${index}`}>
                  {t(`skeletal.split.quality.${issue.code}`, { cells: issue.cells.join(", ") })}
                </span>)}
              </div>}
              <div className="skeletal-split-members">
                {partDrafts.map((draft, index) => (
                  <div className={`skeletal-split-member${skeletalReview?.issues.some((issue) => issue.cells.includes(index + 1)) ? " error" : ""}`} key={index}>
                    <div className="skeletal-part-preview">
                      {skeletalReview?.previews[index]
                        ? <img src={skeletalReview.previews[index]} alt={draft.name} />
                        : <span>{index + 1}</span>}
                    </div>
                    <span>{t("skeletal.split.cell", { index: index + 1 })}</span>
                    <strong>{t(`skeletal.partRole.${draft.role}`)}</strong>
                    <input
                      className="px-input"
                      value={draft.name}
                      disabled={busy}
                      aria-label={t("skeletal.split.partName", { index: index + 1 })}
                      placeholder={t("skeletal.split.partMaterialNamePlaceholder")}
                      onChange={(event) => setPartDrafts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))}
                    />
                  </div>
                ))}
              </div>
              {skeletalReview && skeletalReview.issues.length === 0 && <label className="px-check skeletal-review-confirm">
                <input type="checkbox" checked={reviewConfirmed} disabled={busy} onChange={(event) => setReviewConfirmed(event.target.checked)} />
                <span>{t(standardHumanoidGrid ? "skeletal.split.semanticConfirmation" : "skeletal.split.customConfirmation", { count: total })}</span>
              </label>}
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
            disabled={busy || !region || (splitLine === "skeletal" && (
              (!partSetId && !partSetName.trim())
              || partDrafts.some((draft) => !draft.name.trim())
              || Boolean(skeletalReview?.issues.length)
              || Boolean(skeletalReview && !reviewConfirmed)
            ))}
            onClick={() => void split()}
          >
            <Grid3x3 size={14} /> {busy
              ? progress || t("msg.splitting")
              : splitLine === "skeletal" && !skeletalReview
                ? t("skeletal.split.runQualityCheck", { count: total })
                : t("msg.split_into_total_materials", { total })}
          </motion.button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
