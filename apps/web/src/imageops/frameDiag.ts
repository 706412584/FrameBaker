// 帧切分诊断 —— 移植自 sprite 工坊 spriteflow/slicer.ts 的 diagnose（行为一致）。
// 给「按网格切出的帧」逐帧算内容占比 / 中心偏移 / 宽高漂移 / 同格评分，
// 让切分（GridSplitModal / 场景拆分 / AI 编排）在落库前就知道哪帧被切坏。
// 纯像素输入，worker / 主线程 / 单测共用。
export interface DiagRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameDiagnostic {
  index: number;
  cell: DiagRect;
  /** 格内实际内容包围盒；全空为 null */
  content: DiagRect | null;
  /** 内容 bbox 占格子面积比（0-1） */
  occupancy: number;
  centerOffsetX: number;
  centerOffsetY: number;
  /** 与全表均值的一致性评分（0-1，越高越规整） */
  sameCellScore: number;
  warnings: string[];
}

export interface SheetDiagnostic {
  sheetWidth: number;
  sheetHeight: number;
  rows: number;
  cols: number;
  frames: FrameDiagnostic[];
  warnings: string[];
}

function colorDistanceSq(px: Uint8ClampedArray, index: number, r: number, g: number, b: number): number {
  const dr = px[index] - r;
  const dg = px[index + 1] - g;
  const db = px[index + 2] - b;
  return dr * dr + dg * dg + db * db;
}

function sampleBackground(px: Uint8ClampedArray, w: number, h: number): { r: number; g: number; b: number } {
  const samples: Array<[number, number]> = [
    [0, 0],
    [Math.max(0, w - 1), 0],
    [0, Math.max(0, h - 1)],
    [Math.max(0, w - 1), Math.max(0, h - 1)],
    [Math.floor(w / 2), 0],
    [Math.floor(w / 2), Math.max(0, h - 1)],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [x, y] of samples) {
    const i = (y * w + x) * 4;
    r += px[i]!;
    g += px[i + 1]!;
    b += px[i + 2]!;
  }
  return { r: Math.round(r / samples.length), g: Math.round(g / samples.length), b: Math.round(b / samples.length) };
}

function isContentPixel(px: Uint8ClampedArray, index: number, bg: { r: number; g: number; b: number }, toleranceSq = 30 * 30 * 3): boolean {
  const alpha = px[index + 3]!;
  if (alpha < 24) return false;
  if (alpha < 245) return true;
  return colorDistanceSq(px, index, bg.r, bg.g, bg.b) > toleranceSq;
}

/** 格内内容包围盒（对齐 spriteflow detectBounds：背景采样 + 最少像素阈值） */
export function detectCellContent(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rect: DiagRect,
  options: { minPixels?: number } = {},
): DiagRect | null {
  const minPixels = options.minPixels ?? 4;
  const bg = sampleBackground(data, width, height);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      if (!isContentPixel(data, i, bg)) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (count < minPixels || maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 全表诊断：rows×cols 均分网格，逐帧内容检测 + 漂移/偏移/占位警告（阈值与 spriteflow 一致） */
export function diagnoseSheetCells(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rows: number,
  cols: number,
): SheetDiagnostic {
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);
  const cells: DiagRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({
        x: col * cellW,
        y: row * cellH,
        w: col === cols - 1 ? width - col * cellW : cellW,
        h: row === rows - 1 ? height - row * cellH : cellH,
      });
    }
  }

  const bounds = cells.map((rect) => detectCellContent(data, width, height, rect, { minPixels: Math.max(4, Math.floor((rect.w * rect.h) / 5000)) }));
  const valid = bounds.filter((item): item is DiagRect => Boolean(item));
  const avgW = valid.length ? valid.reduce((sum, rect) => sum + rect.w, 0) / valid.length : 0;
  const avgH = valid.length ? valid.reduce((sum, rect) => sum + rect.h, 0) / valid.length : 0;
  const normalizedCenters = bounds
    .map((content, index) => {
      if (!content) return null;
      const cell = cells[index]!;
      return {
        x: (content.x + content.w / 2 - cell.x) / Math.max(1, cell.w),
        y: (content.y + content.h / 2 - cell.y) / Math.max(1, cell.h),
      };
    })
    .filter((item): item is { x: number; y: number } => Boolean(item));
  const avgCenterX = normalizedCenters.length ? normalizedCenters.reduce((sum, item) => sum + item.x, 0) / normalizedCenters.length : 0.5;
  const avgCenterY = normalizedCenters.length ? normalizedCenters.reduce((sum, item) => sum + item.y, 0) / normalizedCenters.length : 0.5;

  const frames = cells.map((cell, index) => {
    const content = bounds[index];
    const warnings: string[] = [];
    if (!content) warnings.push("empty-or-background-only");
    const occupancy = content ? (content.w * content.h) / Math.max(1, cell.w * cell.h) : 0;
    const centerX = content ? content.x + content.w / 2 : cell.x + cell.w / 2;
    const centerY = content ? content.y + content.h / 2 : cell.y + cell.h / 2;
    const centerOffsetX = content ? (centerX - (cell.x + cell.w / 2)) / Math.max(1, cell.w) : 0;
    const centerOffsetY = content ? (centerY - (cell.y + cell.h / 2)) / Math.max(1, cell.h) : 0;
    const relativeW = content && avgW ? Math.abs(content.w - avgW) / avgW : 1;
    const relativeH = content && avgH ? Math.abs(content.h - avgH) / avgH : 1;
    const normalizedCenterX = content ? (content.x + content.w / 2 - cell.x) / Math.max(1, cell.w) : 0.5;
    const normalizedCenterY = content ? (content.y + content.h / 2 - cell.y) / Math.max(1, cell.h) : 0.5;
    const globalCenterDelta = content ? Math.hypot(normalizedCenterX - avgCenterX, normalizedCenterY - avgCenterY) : 1;
    const sameCellScore = Math.max(0, 1 - (relativeW + relativeH + Math.abs(centerOffsetX) + Math.abs(centerOffsetY) + globalCenterDelta) / 2.5);
    if (content && relativeW > 0.22) warnings.push("width-drift");
    if (content && relativeH > 0.22) warnings.push("height-drift");
    if (Math.abs(centerOffsetX) > 0.14) warnings.push("horizontal-offset");
    if (Math.abs(centerOffsetY) > 0.14) warnings.push("vertical-offset");
    if (occupancy < 0.04) warnings.push("tiny-content");
    return { index, cell, content, occupancy, centerOffsetX, centerOffsetY, sameCellScore, warnings };
  });

  const warnings: string[] = [];
  if (frames.some((frame) => frame.warnings.length > 0)) warnings.push("frame-occupancy-varies");
  return { sheetWidth: width, sheetHeight: height, rows, cols, frames, warnings };
}
