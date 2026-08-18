import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Bone, Columns2, Eraser, Grid3x3, Move, Rows2, Scan, ScanSearch, X } from "lucide-react";
import { ARTICULATED_CHARACTER_PART_ROLES, type CharacterPartRole, type CharacterPartSet, type CharacterPartSetMember } from "@framebaker/shared";
import { api, materialImageUrl, type Material } from "../api";
import { analyzeImage, cropImage, detectComponents, findOpaqueBounds } from "../imageops/client";
import { reviewSkeletalGrid, type CropRect, type SkeletalPartQualityIssue } from "../imageops/ops";
import { notify } from "../notice";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import { useMaterialEditor } from "./MaterialEditor";
import ContextMenu, { type CtxMenuItem } from "./ContextMenu";

interface Props {
  material: Material;
  v: number;
  initialLine?: "frame" | "skeletal";
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string) => void;
}

const clampCell = (n: number) => Math.max(1, Math.min(8, Math.floor(n) || 1));
const DEFAULT_PART_ROLES: CharacterPartRole[] = [...ARTICULATED_CHARACTER_PART_ROLES];
type CellOffset = { x: number; y: number };
type CellResizeEdge = "left" | "right" | "top" | "bottom";
type CellResizeAxis = "right" | "bottom";
type CellResizeNeighbor = { group: number[]; rect: CropRect };
type CellSplit = { parentId: number; children: [number, number] };
type ManualMergedCell = { id: number; children: number[] };

interface SkeletalReview {
  cells: Blob[];
  previews: string[];
  issues: SkeletalPartQualityIssue[];
  activeGroupIndexes: number[];
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
  const openMaterialEditor = useMaterialEditor();
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
  const [dragMode, setDragMode] = useState<"grid" | "cell" | "merge">("cell");
  const [targetPartSet, setTargetPartSet] = useState<CharacterPartSet | null>(null);
  const [partDrafts, setPartDrafts] = useState<Array<{ role: CharacterPartRole; name: string }>>([]);
  const [skeletalReview, setSkeletalReview] = useState<SkeletalReview | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [region, setRegion] = useState<CropRect | null>(null);
  const [cellOffsets, setCellOffsets] = useState<CellOffset[]>([]);
  const [cellSourceSizes, setCellSourceSizes] = useState<Array<{ w: number; h: number } | null>>([]);
  const [cellFrameOffsets, setCellFrameOffsets] = useState<CellOffset[]>([]);
  const [activeCellIndex, setActiveCellIndex] = useState<number | null>(null);
  const [mergedCellGroups, setMergedCellGroups] = useState<number[][]>([]);
  const [cellSplits, setCellSplits] = useState<CellSplit[]>([]);
  const [manualMergedCells, setManualMergedCells] = useState<ManualMergedCell[]>([]);
  // 连通域自动检测得到的部件单元（合成 id 单格组）；非空时取代均匀网格作为基础布局。
  const [detectedGroups, setDetectedGroups] = useState<number[][] | null>(null);
  const [splitCellRects, setSplitCellRects] = useState<Record<number, CropRect>>({});
  const [selectedCells, setSelectedCells] = useState<number[]>([]);
  const [cellContextMenu, setCellContextMenu] = useState<{ x: number; y: number; groupId: number } | null>(null);
  const [disp, setDisp] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ ax: number; ay: number; rx: number; ry: number } | null>(null);
  const cellDragRef = useRef<{ group: number[]; ax: number; ay: number; ox: number; oy: number } | null>(null);
  const cellResizeRef = useRef<{
    edge: CellResizeAxis;
    ax: number;
    ay: number;
    boundary: number;
    leaders: CellResizeNeighbor[];
    neighbors: CellResizeNeighbor[];
  } | null>(null);
  const nextSplitCellIdRef = useRef(1000);
  const previousDraftGroupsRef = useRef<number[][]>([]);
  const previousDraftShapeRef = useRef("");
  useModalEscClose(onClose);

  const skipCenter = splitLine === "frame" && /_8directions_3x3$/.test(m.name.trim()) && rows === 3 && cols === 3;
  const standardHumanoidGrid = splitLine === "skeletal" && rows === 3 && cols === 4 && !detectedGroups;
  const cellGroups = useMemo(() => {
    if (splitLine !== "skeletal") return Array.from({ length: rows * cols }, (_, index) => [index]);
    let baseGroups: number[][];
    if (detectedGroups) {
      baseGroups = detectedGroups;
    } else {
      const owner = new Map<number, number[]>();
      for (const group of mergedCellGroups) for (const index of group) owner.set(index, group);
      baseGroups = [];
      for (let index = 0; index < rows * cols; index++) {
        const group = owner.get(index) ?? [index];
        if (group[0] === index) baseGroups.push(group);
      }
    }
    const splitByParent = new Map(cellSplits.map((split) => [split.parentId, split.children]));
    const expand = (group: number[]): number[][] => {
      const children = splitByParent.get(group[0]);
      return children ? children.flatMap((child) => expand([child])) : [group];
    };
    const expandedGroups = baseGroups.flatMap(expand);
    const manualOwner = new Map<number, ManualMergedCell>();
    for (const merged of manualMergedCells) for (const child of merged.children) manualOwner.set(child, merged);
    const emitted = new Set<number>();
    const mergedGroups = expandedGroups.flatMap((group) => {
      const merged = manualOwner.get(group[0]);
      if (!merged || emitted.has(merged.id)) return merged ? [] : [group];
      emitted.add(merged.id);
      return [[merged.id]];
    });
    return mergedGroups.flatMap(expand);
  }, [cellSplits, cols, detectedGroups, manualMergedCells, mergedCellGroups, rows, splitLine]);
  const cellGroupsKey = cellGroups.map((group) => group.join(",")).join("|");
  const cellGroupLabel = (group: number[]) => detectedGroups || cellSplits.length
    ? String(cellGroups.findIndex((candidate) => candidate[0] === group[0]) + 1)
    : group.map((index) => index + 1).join("+");
  const standardSemanticLayout = standardHumanoidGrid && mergedCellGroups.length === 0 && cellSplits.length === 0;
  const activeGroupIndexes = skeletalReview?.activeGroupIndexes ?? cellGroups.map((_, index) => index);
  const total = splitLine === "skeletal" ? activeGroupIndexes.length : rows * cols - (skipCenter ? 1 : 0);
  const activeCellGroup = activeCellIndex == null ? null : cellGroups.find((group) => group.includes(activeCellIndex)) ?? null;

  useEffect(() => () => {
    skeletalReview?.previews.forEach((url) => URL.revokeObjectURL(url));
  }, [skeletalReview]);

  useEffect(() => {
    setSkeletalReview(null);
    setReviewConfirmed(false);
  }, [region?.x, region?.y, region?.w, region?.h, rows, cols, slot]);

  useEffect(() => {
    setMergedCellGroups([]);
    setCellSplits([]);
    setManualMergedCells([]);
    setSplitCellRects({});
    setSelectedCells([]);
    setCellContextMenu(null);
    setActiveCellIndex(null);
    setDetectedGroups(null);
    setCellOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setCellSourceSizes(Array.from({ length: rows * cols }, () => null));
    setCellFrameOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
  }, [cols, rows, slot, splitLine]);

  useEffect(() => {
    if (!hintedPartSetId) {
      setTargetPartSet(null);
      return;
    }
    api.getCharacterPartSet(hintedPartSetId).then(setTargetPartSet).catch(() => setTargetPartSet(null));
  }, [hintedPartSetId]);

  useEffect(() => {
    const shape = `${splitLine}:${rows}x${cols}`;
    const preserveExisting = previousDraftShapeRef.current === shape;
    const previousDrafts = new Map<number, { role: CharacterPartRole; name: string }>();
    if (preserveExisting) {
      previousDraftGroupsRef.current.forEach((group, index) => {
        const draft = partDrafts[index];
        if (draft) previousDrafts.set(group[0], draft);
      });
    }
    setPartDrafts(cellGroups.map((group, index) => {
      const existing = previousDrafts.get(group[0]);
      if (existing) return existing;
      const role = standardHumanoidGrid ? DEFAULT_PART_ROLES[group[0]] ?? "custom" : "custom";
      return {
        role,
        name: standardHumanoidGrid ? t(`skeletal.partRole.${role}`) : t("skeletal.split.customPartName", { index: index + 1 }),
      };
    }));
    previousDraftGroupsRef.current = cellGroups;
    previousDraftShapeRef.current = shape;
    // cellGroupsKey 是布局变化的稳定触发器；partDrafts 通过 ref 按格子 id 延续，不能加入依赖造成循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellGroupsKey, cols, rows, splitLine, standardHumanoidGrid, t]);

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

  const baseCellRect = (index: number): CropRect | null => {
    if (!region) return null;
    const row = Math.floor(index / cols);
    const col = index % cols;
    const cellWidth = Math.floor(region.w / cols);
    const cellHeight = Math.floor(region.h / rows);
    return {
      x: region.x + cellWidth * col,
      y: region.y + cellHeight * row,
      w: col === cols - 1 ? region.w - cellWidth * col : cellWidth,
      h: row === rows - 1 ? region.h - cellHeight * row : cellHeight,
    };
  };

  const cellGroupDefaultRect = (group: number[], size?: { w: number; h: number } | null): CropRect | null => {
    const splitRect = splitCellRects[group[0]];
    if (splitRect && region) {
      const baseX = region.x + splitRect.x;
      const baseY = region.y + splitRect.y;
      const customSize = size === undefined ? cellSourceSizes[group[0]] : size;
      const w = Math.min(imgSize?.w ?? splitRect.w, Math.max(1, customSize?.w ?? splitRect.w));
      const h = Math.min(imgSize?.h ?? splitRect.h, Math.max(1, customSize?.h ?? splitRect.h));
      const x = Math.max(0, Math.min(Math.max(0, (imgSize?.w ?? baseX + splitRect.w) - w), baseX + (splitRect.w - w) / 2));
      const y = Math.max(0, Math.min(Math.max(0, (imgSize?.h ?? baseY + splitRect.h) - h), baseY + (splitRect.h - h) / 2));
      return { x, y, w, h };
    }
    const rects = group.map(baseCellRect).filter((rect): rect is CropRect => rect != null);
    if (!rects.length) return null;
    const baseX = Math.min(...rects.map((rect) => rect.x));
    const baseY = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
    const customSize = size === undefined ? cellSourceSizes[group[0]] : size;
    const w = Math.min(imgSize?.w ?? right - baseX, Math.max(1, customSize?.w ?? right - baseX));
    const h = Math.min(imgSize?.h ?? bottom - baseY, Math.max(1, customSize?.h ?? bottom - baseY));
    const x = Math.max(0, Math.min(Math.max(0, (imgSize?.w ?? right) - w), (baseX + right - w) / 2));
    const y = Math.max(0, Math.min(Math.max(0, (imgSize?.h ?? bottom) - h), (baseY + bottom - h) / 2));
    return { x, y, w, h };
  };

  const cellGroupBaseRect = (group: number[], size?: { w: number; h: number } | null): CropRect | null => {
    const base = cellGroupDefaultRect(group, size);
    if (!base) return null;
    const offset = cellFrameOffsets[group[0]] ?? { x: 0, y: 0 };
    return { ...base, x: base.x + offset.x, y: base.y + offset.y };
  };

  const cellGroupRect = (group: number[], adjusted = true): CropRect | null => {
    const base = cellGroupBaseRect(group);
    if (!base) return null;
    const offset = adjusted ? cellOffsets[group[0]] ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    return { ...base, x: base.x + offset.x, y: base.y + offset.y };
  };

  const clampCellOffset = (group: number[], offset: CellOffset, size?: { w: number; h: number }): CellOffset => {
    const base = cellGroupBaseRect(group, size);
    if (!base || !imgSize) return { x: 0, y: 0 };
    return {
      x: Math.max(-base.x, Math.min(imgSize.w - base.w - base.x, Math.round(offset.x))),
      y: Math.max(-base.y, Math.min(imgSize.h - base.h - base.y, Math.round(offset.y))),
    };
  };

  const toggleGroupSelection = (group: number[]) => {
    setSelectedCells((current) => {
      const selected = new Set(current);
      const remove = group.every((index) => selected.has(index));
      group.forEach((index) => remove ? selected.delete(index) : selected.add(index));
      return [...selected].sort((a, b) => a - b);
    });
  };

  const setGroupOffset = (group: number[], offset: CellOffset) => {
    setCellOffsets((items) => {
      const copy = [...items];
      copy[group[0]] = offset;
      return copy;
    });
  };

  const resetCellAdjustment = (group: number[] | null) => {
    if (!group) return;
    setCellSourceSizes(Array.from({ length: rows * cols }, () => null));
    setCellFrameOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setCellOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setSkeletalReview(null);
    setReviewConfirmed(false);
  };

  const changeDragMode = (mode: "grid" | "cell" | "merge") => {
    setDragMode(mode);
    setSelectedCells([]);
    setCellContextMenu(null);
  };

  const splitCell = (group: number[], direction: "vertical" | "horizontal") => {
    const rect = cellGroupRect(group, false);
    if (!rect || !region) return;
    const vertical = direction === "vertical";
    if ((vertical ? rect.w : rect.h) < 2) return;
    const firstId = nextSplitCellIdRef.current++;
    const secondId = nextSplitCellIdRef.current++;
    const firstSize = Math.floor((vertical ? rect.w : rect.h) / 2);
    const firstRect: CropRect = vertical
      ? { x: rect.x, y: rect.y, w: firstSize, h: rect.h }
      : { x: rect.x, y: rect.y, w: rect.w, h: firstSize };
    const secondRect: CropRect = vertical
      ? { x: rect.x + firstSize, y: rect.y, w: rect.w - firstSize, h: rect.h }
      : { x: rect.x, y: rect.y + firstSize, w: rect.w, h: rect.h - firstSize };
    const relative = (item: CropRect): CropRect => ({ ...item, x: item.x - region.x, y: item.y - region.y });
    setCellSplits((splits) => [...splits, { parentId: group[0], children: [firstId, secondId] }]);
    setSplitCellRects((rects) => ({ ...rects, [firstId]: relative(firstRect), [secondId]: relative(secondRect) }));
    setSelectedCells([]);
    setActiveCellIndex(firstId);
    setSkeletalReview(null);
    setReviewConfirmed(false);
  };

  const linkedResizeSides = (group: number[], edge: CellResizeEdge): {
    axis: CellResizeAxis;
    boundary: number;
    leaders: CellResizeNeighbor[];
    neighbors: CellResizeNeighbor[];
  } | null => {
    const rect = cellGroupRect(group, false);
    if (!rect) return null;
    const vertical = edge === "left" || edge === "right";
    const axis: CellResizeAxis = vertical ? "right" : "bottom";
    const selectedIsLeader = edge === "right" || edge === "bottom";
    const boundary = vertical
      ? (edge === "right" ? rect.x + rect.w : rect.x)
      : (edge === "bottom" ? rect.y + rect.h : rect.y);
    const leaders: CellResizeNeighbor[] = selectedIsLeader ? [{ group, rect }] : [];
    const neighbors: CellResizeNeighbor[] = selectedIsLeader ? [] : [{ group, rect }];
    const overlapsSelectedEdge = (candidateRect: CropRect) => vertical
      ? Math.min(rect.y + rect.h, candidateRect.y + candidateRect.h) - Math.max(rect.y, candidateRect.y) > 1
      : Math.min(rect.x + rect.w, candidateRect.x + candidateRect.w) - Math.max(rect.x, candidateRect.x) > 1;
    for (const candidate of cellGroups) {
      if (candidate[0] === group[0]) continue;
      const candidateRect = cellGroupRect(candidate, false);
      if (!candidateRect) continue;
      const trailingBoundary = vertical ? candidateRect.x + candidateRect.w : candidateRect.y + candidateRect.h;
      const leadingBoundary = vertical ? candidateRect.x : candidateRect.y;
      if (!overlapsSelectedEdge(candidateRect)) continue;
      if (!selectedIsLeader && Math.abs(trailingBoundary - boundary) <= 1) leaders.push({ group: candidate, rect: candidateRect });
      else if (selectedIsLeader && Math.abs(leadingBoundary - boundary) <= 1) neighbors.push({ group: candidate, rect: candidateRect });
    }
    if (!leaders.length || !neighbors.length) return null;
    return { axis, boundary, leaders, neighbors };
  };

  const onCellResizePointerDown = (group: number[], edge: CellResizeEdge, e: React.PointerEvent<HTMLDivElement>) => {
    if (busy || dragMode !== "cell") return;
    e.preventDefault();
    e.stopPropagation();
    const rect = cellGroupRect(group, false);
    if (!rect) return;
    const linked = linkedResizeSides(group, edge);
    if (!linked) return;
    setActiveCellIndex(group[0]);
    e.currentTarget.setPointerCapture(e.pointerId);
    cellResizeRef.current = { edge: linked.axis, ax: e.clientX, ay: e.clientY, boundary: linked.boundary, leaders: linked.leaders, neighbors: linked.neighbors };
    setSkeletalReview(null);
    setReviewConfirmed(false);
  };

  const onCellResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const resize = cellResizeRef.current;
    if (!resize || !imgSize) return;
    e.preventDefault();
    e.stopPropagation();
    const minW = Math.max(1, Math.round(16 / scaleX));
    const minH = Math.max(1, Math.round(16 / scaleY));
    const pointerDelta = resize.edge === "right" ? (e.clientX - resize.ax) / scaleX : (e.clientY - resize.ay) / scaleY;
    const minBoundary = Math.max(...resize.leaders.map(({ rect }) =>
      (resize.edge === "right" ? rect.x + minW : rect.y + minH)
    ));
    const maxBoundary = Math.min(...resize.neighbors.map(({ rect }) =>
      (resize.edge === "right" ? rect.x + rect.w - minW : rect.y + rect.h - minH)
    ));
    const boundary = Math.round(Math.max(minBoundary, Math.min(maxBoundary, resize.boundary + pointerDelta)));
    const updates = [
      ...resize.leaders.map((leader) => ({
        group: leader.group,
        rect: resize.edge === "right"
          ? { ...leader.rect, w: boundary - leader.rect.x }
          : { ...leader.rect, h: boundary - leader.rect.y },
      })),
      ...resize.neighbors.map((neighbor) => ({
        group: neighbor.group,
        rect: resize.edge === "right"
          ? { ...neighbor.rect, x: boundary, w: neighbor.rect.x + neighbor.rect.w - boundary }
          : { ...neighbor.rect, y: boundary, h: neighbor.rect.y + neighbor.rect.h - boundary },
      })),
    ];
    setCellSourceSizes((sizes) => {
      const copy = [...sizes];
      for (const update of updates) copy[update.group[0]] = { w: update.rect.w, h: update.rect.h };
      return copy;
    });
    setCellFrameOffsets((offsets) => {
      const copy = [...offsets];
      for (const update of updates) {
        const natural = cellGroupDefaultRect(update.group, { w: update.rect.w, h: update.rect.h });
        if (natural) copy[update.group[0]] = { x: update.rect.x - natural.x, y: update.rect.y - natural.y };
      }
      return copy;
    });
    setCellOffsets((offsets) => {
      const copy = [...offsets];
      for (const update of updates) {
        const offset = copy[update.group[0]] ?? { x: 0, y: 0 };
        copy[update.group[0]] = {
          x: Math.max(-update.rect.x, Math.min(imgSize.w - update.rect.w - update.rect.x, offset.x)),
          y: Math.max(-update.rect.y, Math.min(imgSize.h - update.rect.h - update.rect.y, offset.y)),
        };
      }
      return copy;
    });
  };

  const onCellResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    cellResizeRef.current = null;
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onCellPointerDown = (group: number[], e: React.PointerEvent<HTMLDivElement>) => {
    if (busy || e.button !== 0) return;
    e.stopPropagation();
    setActiveCellIndex(group[0]);
    if (dragMode === "merge") {
      toggleGroupSelection(group);
      return;
    }
    if (dragMode !== "cell") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const offset = cellOffsets[group[0]] ?? { x: 0, y: 0 };
    cellDragRef.current = { group, ax: e.clientX, ay: e.clientY, ox: offset.x, oy: offset.y };
    setSkeletalReview(null);
    setReviewConfirmed(false);
  };

  const onCellPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = cellDragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const dx = (e.clientX - drag.ax) / scaleX;
    const dy = (e.clientY - drag.ay) / scaleY;
    const next = clampCellOffset(drag.group, { x: drag.ox - dx, y: drag.oy - dy });
    setGroupOffset(drag.group, next);
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
    if (!region || busy || (splitLine === "skeletal" && dragMode !== "grid")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { ax: e.clientX, ay: e.clientY, rx: region.x, ry: region.y };
  };

  const mergeSelectedCells = () => {
    const selected = new Set(selectedCells);
    const selectedGroups = cellGroups.filter((group) => group.every((index) => selected.has(index)));
    if (selectedGroups.length < 2) {
      notify(t("skeletal.split.selectCellsToMerge"), "info");
      return;
    }
    if (selectedCells.some((index) => index >= rows * cols)) {
      const rects = selectedGroups.map((group) => cellGroupRect(group, false)).filter((rect): rect is CropRect => rect != null);
      const left = Math.min(...rects.map((rect) => rect.x));
      const top = Math.min(...rects.map((rect) => rect.y));
      const right = Math.max(...rects.map((rect) => rect.x + rect.w));
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
      const area = rects.reduce((sum, rect) => sum + rect.w * rect.h, 0);
      if (rects.length !== selectedGroups.length || Math.abs(area - (right - left) * (bottom - top)) > 1) {
        notify(t("skeletal.split.mergeRectangleOnly"));
        return;
      }
      const mergedId = nextSplitCellIdRef.current++;
      const selectedLeaders = new Set(selectedGroups.map((group) => group[0]));
      const children = selectedGroups.flatMap((group) =>
        manualMergedCells.find((merged) => merged.id === group[0])?.children ?? [group[0]]
      );
      setManualMergedCells((groups) => [
        ...groups.filter((group) => !selectedLeaders.has(group.id)),
        { id: mergedId, children },
      ]);
      setSplitCellRects((items) => ({
        ...items,
        [mergedId]: { x: left - region!.x, y: top - region!.y, w: right - left, h: bottom - top },
      }));
      setActiveCellIndex(mergedId);
      setSelectedCells([]);
      setSkeletalReview(null);
      setReviewConfirmed(false);
      return;
    }
    const selectedRows = selectedCells.map((index) => Math.floor(index / cols));
    const selectedCols = selectedCells.map((index) => index % cols);
    const minRow = Math.min(...selectedRows);
    const maxRow = Math.max(...selectedRows);
    const minCol = Math.min(...selectedCols);
    const maxCol = Math.max(...selectedCols);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        if (!selected.has(row * cols + col)) {
          notify(t("skeletal.split.mergeRectangleOnly"));
          return;
        }
      }
    }
    setMergedCellGroups((groups) => [
      ...groups.filter((group) => !group.some((index) => selected.has(index))),
      [...selectedCells],
    ].sort((a, b) => a[0] - b[0]));
    setCellOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setCellSourceSizes(Array.from({ length: rows * cols }, () => null));
    setCellFrameOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setActiveCellIndex(selectedCells[0]);
    setSelectedCells([]);
    setSkeletalReview(null);
    setReviewConfirmed(false);
  };

  const unmergeSelectedCells = () => {
    if (!selectedCells.length) return;
    const selected = new Set(selectedCells);
    const manualMerged = manualMergedCells.find((group) => selected.has(group.id));
    if (manualMerged) {
      setManualMergedCells((groups) => groups.filter((group) => group.id !== manualMerged.id));
      setActiveCellIndex(manualMerged.children[0] ?? null);
      setSelectedCells([]);
      setSkeletalReview(null);
      setReviewConfirmed(false);
      return;
    }
    setMergedCellGroups((groups) => groups.filter((group) => !group.some((index) => selected.has(index))));
    setCellOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setCellSourceSizes(Array.from({ length: rows * cols }, () => null));
    setCellFrameOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setActiveCellIndex(selectedCells[0] ?? null);
    setSelectedCells([]);
    setSkeletalReview(null);
    setReviewConfirmed(false);
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

  /** 连通域自动检测：按不透明块生成部件单元，铺满整图后即可逐格微调/命名/切分。 */
  const autoDetectComponents = async () => {
    if (!imgSize || busy) return;
    setBusy(true);
    setProgress(t("skeletal.split.detecting"));
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
      const rects = await detectComponents(blob, { minAreaRatio: 0.004, maxComponents: 64 });
      if (!rects.length) {
        notify(t("skeletal.split.noComponents"), "info");
        return;
      }
      const ids: number[] = [];
      const nextRects: Record<number, CropRect> = {};
      // 检测在整图坐标进行：把网格区域重置为整图，splitCellRects 的相对坐标即等于绝对坐标。
      for (const rect of rects) {
        const id = nextSplitCellIdRef.current++;
        ids.push(id);
        nextRects[id] = { ...rect };
      }
      setRegion({ x: 0, y: 0, w: imgSize.w, h: imgSize.h });
      setSplitCellRects(nextRects);
      setMergedCellGroups([]);
      setCellSplits([]);
      setManualMergedCells([]);
      setCellOffsets([]);
      setCellSourceSizes([]);
      setCellFrameOffsets([]);
      setSelectedCells([]);
      setCellContextMenu(null);
      setActiveCellIndex(ids[0] ?? null);
      setDetectedGroups(ids.map((id) => [id]));
      setSkeletalReview(null);
      setReviewConfirmed(false);
      onToast(t("skeletal.split.detectedComponents", { count: rects.length }));
    } catch (e) {
      notify(t("skeletal.split.detectFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const clearDetection = () => {
    setDetectedGroups(null);
    setSplitCellRects({});
    setMergedCellGroups([]);
    setCellSplits([]);
    setManualMergedCells([]);
    setCellOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setCellSourceSizes(Array.from({ length: rows * cols }, () => null));
    setCellFrameOffsets(Array.from({ length: rows * cols }, () => ({ x: 0, y: 0 })));
    setSelectedCells([]);
    setCellContextMenu(null);
    setActiveCellIndex(null);
    setSkeletalReview(null);
    setReviewConfirmed(false);
  };

  const nudge = (dx: number, dy: number) => {
    if (!region || !imgSize) return;
    setRegion(clampRegion({ ...region, x: region.x + dx, y: region.y + dy }, imgSize.w, imgSize.h));
  };

  const selectSplitLine = (line: "frame" | "skeletal") => {
    setSplitLine(line);
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
      for (const group of cellGroups) {
        const rect = cellGroupRect(group);
        if (rect) cells.push(await cropImage(blob, rect));
      }
      const analyses = await Promise.all(cells.map(analyzeImage));
      const { activeIndexes, issues } = reviewSkeletalGrid(analyses, standardSemanticLayout, standardSemanticLayout ? [3] : []);
      setSkeletalReview({ cells, issues, activeGroupIndexes: activeIndexes, previews: cells.map((cell) => URL.createObjectURL(cell)) });
      setReviewConfirmed(false);
      if (issues.length > 0) notify(t("skeletal.split.qualityBlocked", { count: issues.length }));
    } catch (e) {
      notify(t("skeletal.split.analysisFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const updateSkeletalReviewCell = async (groupIndex: number, editedCell: Blob) => {
    const current = skeletalReview;
    if (!current) return;
    const cells = [...current.cells];
    cells[groupIndex] = editedCell;
    const analyses = await Promise.all(cells.map(analyzeImage));
    const { activeIndexes, issues } = reviewSkeletalGrid(analyses, standardSemanticLayout, standardSemanticLayout ? [3] : []);
    const previews = cells.map((cell) => URL.createObjectURL(cell));
    current.previews.forEach((url) => URL.revokeObjectURL(url));
    setSkeletalReview({ cells, issues, activeGroupIndexes: activeIndexes, previews });
    setReviewConfirmed(false);
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
      const targets = splitLine === "skeletal"
        ? activeGroupIndexes.map((groupIndex) => ({ groupIndex, group: cellGroups[groupIndex], rect: cellGroupRect(cellGroups[groupIndex])! }))
        : Array.from({ length: rows * cols }, (_, index) => ({ groupIndex: index, group: [index], rect: baseCellRect(index)! }))
          .filter(({ group }) => !(skipCenter && group[0] === 4));
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
          const { groupIndex, group, rect: cellRect } = targets[targetIndex];
          const cellIndex = group[0];
          const logicalIndex = cellIndex < rows * cols ? cellIndex : groupIndex;
          const r = Math.floor(logicalIndex / cols);
          const c = logicalIndex % cols;
          const i = targetIndex + 1;
          setProgress(t("msg.uploading_split_i_total", { i, total }));
          try {
            const { w, h } = cellRect;
            let cell = preparedCells?.[groupIndex] ?? await cropImage(blob, cellRect);
            let rawCell = m.processed_path ? await cropImage(rawBlob, cellRect) : cell;
            if (autoTrim) {
              const bounds = await findOpaqueBounds(cell);
              if (bounds && (bounds.w < w || bounds.h < h || bounds.x > 0 || bounds.y > 0)) {
                cell = await cropImage(cell, bounds);
                if (m.processed_path) rawCell = await cropImage(rawCell, bounds);
                trimmed++;
              }
            }
            if (!m.processed_path) rawCell = cell;
            const draft = splitLine === "skeletal" ? partDrafts[groupIndex] : undefined;
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
                  sourceRect: cellRect,
                  cells: cellSplits.length ? [groupIndex + 1] : group.map((index) => index + 1),
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
      if (splitLine === "skeletal" && (fail > 0 || createdMembers.length !== total)) {
        throw new Error(t("skeletal.split.partialUploadBlocked", { ok, fail }));
      }
      if (splitLine === "skeletal") {
        const lineageReferenceId = typeof m.metadata.referenceMaterialId === "string" ? m.metadata.referenceMaterialId : null;
        let target = targetPartSet;
        if (!target && hintedPartSetId) {
          try {
            target = await api.getCharacterPartSet(hintedPartSetId);
          } catch {
            target = null;
          }
        }
        if (target) {
          const preservedMembers = standardHumanoidGrid ? target.members.filter((member) => !ARTICULATED_CHARACTER_PART_ROLES.includes(member.role as typeof ARTICULATED_CHARACTER_PART_ROLES[number])) : [];
          const updated = await api.putCharacterPartSet(target.id, {
            name: target.name,
            referenceMaterialId: lineageReferenceId ?? target.referenceMaterialId,
            members: [...preservedMembers, ...createdMembers],
          });
          setTargetPartSet(updated);
        } else {
          const created = await api.createCharacterPartSet({
            name: `${m.name} · ${t("skeletal.parts.setSuffix")}`,
            source: "decomposed",
            referenceMaterialId: lineageReferenceId,
            members: createdMembers,
          });
          setTargetPartSet(created);
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
  const activeSourceRect = activeCellGroup ? cellGroupRect(activeCellGroup, false) : null;
  const contextCellGroup = cellContextMenu
    ? cellGroups.find((group) => group[0] === cellContextMenu.groupId) ?? null
    : null;
  const contextCellRect = contextCellGroup ? cellGroupRect(contextCellGroup, false) : null;
  const cellContextItems: CtxMenuItem[] = contextCellGroup ? [
    {
      label: t("skeletal.split.splitLeftRight"),
      icon: <Columns2 size={14} />,
      disabled: busy || !contextCellRect || contextCellRect.w < 2,
      onClick: () => splitCell(contextCellGroup, "vertical"),
    },
    {
      label: t("skeletal.split.splitTopBottom"),
      icon: <Rows2 size={14} />,
      disabled: busy || !contextCellRect || contextCellRect.h < 2,
      onClick: () => splitCell(contextCellGroup, "horizontal"),
    },
  ] : [];

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
                <div className={`gs-region${splitLine === "skeletal" ? ` skeletal-cells ${dragMode}-drag-mode` : ""}`} style={regionStyle}>
                  {splitLine === "skeletal" ? cellGroups.map((group) => {
                    const base = cellGroupRect(group, false)!;
                    const adjusted = cellGroupRect(group)!;
                    const selected = group.every((index) => selectedCells.includes(index));
                    const active = activeCellGroup?.[0] === group[0];
                    const manuallyMerged = manualMergedCells.some((merged) => merged.id === group[0]);
                    const canResizeLeft = active && linkedResizeSides(group, "left") != null;
                    const canResizeRight = active && linkedResizeSides(group, "right") != null;
                    const canResizeTop = active && linkedResizeSides(group, "top") != null;
                    const canResizeBottom = active && linkedResizeSides(group, "bottom") != null;
                    return <div
                      className={`gs-cell-window${selected ? " selected" : ""}${active ? " active" : ""}${group.length > 1 || manuallyMerged ? " merged" : ""}`}
                      data-cell-id={group[0]}
                      key={group.join("-")}
                      style={{
                        left: (base.x - region!.x) * scaleX,
                        top: (base.y - region!.y) * scaleY,
                        width: base.w * scaleX,
                        height: base.h * scaleY,
                      }}
                      onPointerDown={(event) => onCellPointerDown(group, event)}
                      onPointerMove={onCellPointerMove}
                      onPointerUp={onCellPointerUp}
                      onPointerCancel={onCellPointerUp}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (busy) return;
                        setActiveCellIndex(group[0]);
                        setCellContextMenu({ x: event.clientX, y: event.clientY, groupId: group[0] });
                      }}
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
                      <span>{cellGroupLabel(group)}</span>
                      {active && dragMode === "cell" && <>
                        {canResizeLeft && <div
                          className="gs-cell-resize-handle left"
                          onPointerDown={(event) => onCellResizePointerDown(group, "left", event)}
                          onPointerMove={onCellResizePointerMove}
                          onPointerUp={onCellResizePointerUp}
                          onPointerCancel={onCellResizePointerUp}
                        />}
                        {canResizeRight && <div
                          className="gs-cell-resize-handle right"
                          onPointerDown={(event) => onCellResizePointerDown(group, "right", event)}
                          onPointerMove={onCellResizePointerMove}
                          onPointerUp={onCellResizePointerUp}
                          onPointerCancel={onCellResizePointerUp}
                        />}
                        {canResizeTop && <div
                          className="gs-cell-resize-handle top"
                          onPointerDown={(event) => onCellResizePointerDown(group, "top", event)}
                          onPointerMove={onCellResizePointerMove}
                          onPointerUp={onCellResizePointerUp}
                          onPointerCancel={onCellResizePointerUp}
                        />}
                        {canResizeBottom && <div
                          className="gs-cell-resize-handle bottom"
                          onPointerDown={(event) => onCellResizePointerDown(group, "bottom", event)}
                          onPointerMove={onCellResizePointerMove}
                          onPointerUp={onCellResizePointerUp}
                          onPointerCancel={onCellResizePointerUp}
                        />}
                      </>}
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
                {splitLine === "skeletal" && <div className="gs-drag-mode" role="group" aria-label={t("skeletal.split.dragMode")}>
                  <button type="button" className={`px-btn mini${dragMode === "grid" ? " accent" : ""}`} disabled={busy} onClick={() => changeDragMode("grid")}>
                    <Move size={14} /> {t("skeletal.split.dragWholeGrid")}
                  </button>
                  <button type="button" className={`px-btn mini${dragMode === "cell" ? " accent" : ""}`} disabled={busy} onClick={() => changeDragMode("cell")}>
                    <Grid3x3 size={14} /> {t("skeletal.split.dragSingleCell")}
                  </button>
                  <button type="button" className={`px-btn mini${dragMode === "merge" ? " accent" : ""}`} disabled={busy} onClick={() => changeDragMode("merge")}>
                    {t("skeletal.split.selectToMerge")}
                  </button>
                </div>}
                {splitLine === "skeletal" && <button type="button" className={`px-btn mini${detectedGroups ? " accent" : ""}`} disabled={busy || !imgSize} title={t("skeletal.split.autoDetectHint")} onClick={() => void autoDetectComponents()}>
                  <ScanSearch size={14} /> {t("skeletal.split.autoDetect")}
                </button>}
                {splitLine === "skeletal" && detectedGroups && <button type="button" className="px-btn mini" disabled={busy} onClick={clearDetection}>
                  {t("skeletal.split.restoreGrid")}
                </button>}
                {splitLine === "skeletal" && dragMode === "merge" && <>
                  <button type="button" className="px-btn mini accent" disabled={busy || selectedCells.length < 2} onClick={mergeSelectedCells}>
                    {t("skeletal.split.mergeSelected")}
                  </button>
                  <button type="button" className="px-btn mini" disabled={busy || !selectedCells.length || !(mergedCellGroups.some((group) => group.some((index) => selectedCells.includes(index))) || manualMergedCells.some((group) => selectedCells.includes(group.id)))} onClick={unmergeSelectedCells}>
                    {t("skeletal.split.unmergeSelected")}
                  </button>
                </>}
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

              {splitLine === "skeletal" && activeCellGroup && activeSourceRect && <div className="gs-cell-source-settings">
                <strong className="gs-total">{t("skeletal.split.activeSourceCell", { cells: cellGroupLabel(activeCellGroup) })}</strong>
                <button type="button" className="px-btn mini" disabled={busy} onClick={() => resetCellAdjustment(activeCellGroup)}>
                  {t("skeletal.split.resetSourceCell")}
                </button>
                <span className="hint">{t("skeletal.split.sourceCellHint")}</span>
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
                <div className="hint">{t("skeletal.split.qualityHint")}</div>
                <div className="hint">{t("skeletal.split.dragCellsHint")}</div>
              </div>
              {(() => {
                const lineageReferenceId = typeof m.metadata.referenceMaterialId === "string" ? m.metadata.referenceMaterialId : null;
                const referenceId = lineageReferenceId ?? targetPartSet?.referenceMaterialId;
                return referenceId ? <div className="skeletal-identity-reference">
                  <img src={materialImageUrl(referenceId, v, "processed")} alt={t("skeletal.split.identityReference")} />
                  <span><strong>{t("skeletal.split.identityReference")}</strong><small>{t("skeletal.split.identityReferenceHint")}</small></span>
                </div> : null;
              })()}
              {skeletalReview && <div className={`skeletal-quality-summary ${skeletalReview.issues.length ? "error" : "ok"}`}>
                <strong>{t(skeletalReview.issues.length ? "skeletal.split.qualityFailed" : "skeletal.split.qualityPassed")}</strong>
                {skeletalReview.issues.map((issue, index) => <span key={`${issue.code}-${issue.cells.join("-")}-${index}`}>
                  {t(`skeletal.split.quality.${issue.code}`, { cells: issue.cells.map((cell) => cellGroupLabel(cellGroups[cell - 1] ?? [cell - 1])).join(", ") })}
                </span>)}
              </div>}
              <div className="skeletal-split-members">
                {partDrafts.map((draft, groupIndex) => ({ draft, groupIndex })).filter(({ groupIndex }) => activeGroupIndexes.includes(groupIndex)).map(({ draft, groupIndex }) => {
                  const group = cellGroups[groupIndex] ?? [groupIndex];
                  const groupLabel = cellGroupLabel(group);
                  return <div className={`skeletal-split-member${group.length > 1 ? " merged" : ""}${skeletalReview?.issues.some((issue) => issue.cells.includes(groupIndex + 1)) ? " error" : ""}`} key={group.join("-")}>
                    <div className="skeletal-part-preview">
                      {skeletalReview?.previews[groupIndex]
                        ? <img src={skeletalReview.previews[groupIndex]} alt={draft.name} />
                        : <span>{groupLabel}</span>}
                    </div>
                    <span>{t("skeletal.split.cell", { index: groupLabel })}</span>
                    <div className="skeletal-part-card-actions">
                      <strong>{t(`skeletal.partRole.${draft.role}`)}</strong>
                      {skeletalReview && <button
                        type="button"
                        className="px-btn mini skeletal-part-edit"
                        title={t("skeletal.split.editCell", { cells: groupLabel })}
                        disabled={busy}
                        onClick={() => openMaterialEditor({
                          image: skeletalReview.cells[groupIndex],
                          name: t("skeletal.split.editCell", { cells: groupLabel }),
                          onSave: (editedCell) => updateSkeletalReviewCell(groupIndex, editedCell),
                        })}
                      ><Eraser size={12} /> {t("skeletal.split.editCellAction")}</button>}
                    </div>
                    <input
                      className="px-input"
                      value={draft.name}
                      disabled={busy}
                      aria-label={t("skeletal.split.partName", { index: groupLabel })}
                      placeholder={t("skeletal.split.partMaterialNamePlaceholder")}
                      onChange={(event) => setPartDrafts((items) => items.map((item, itemIndex) => itemIndex === groupIndex ? { ...item, name: event.target.value } : item))}
                    />
                  </div>;
                })}
              </div>
              {skeletalReview && skeletalReview.issues.length === 0 && <label className="px-check skeletal-review-confirm">
                <input type="checkbox" checked={reviewConfirmed} disabled={busy} onChange={(event) => setReviewConfirmed(event.target.checked)} />
                <span>{t(standardSemanticLayout ? "skeletal.split.semanticConfirmation" : "skeletal.split.customConfirmation", { count: total })}</span>
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
              partDrafts.some((draft) => !draft.name.trim())
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
        {cellContextMenu && contextCellGroup && <ContextMenu
          x={cellContextMenu.x}
          y={cellContextMenu.y}
          items={cellContextItems}
          onClose={() => setCellContextMenu(null)}
        />}
      </motion.div>
    </motion.div>
  );
}
