// 精简 MaxRects 装箱（Best-Short-Side-Fit）— 对齐 sprite export_job 的 rectpack 用法
// （Python rectpack newPacker(MaxRectsBssf, rotation=False)；此处自实现免依赖，语义一致）。
// 用途：不等大帧的紧凑图集布局（枚举列数取最小面积，失败回退规则网格）。

export interface PackedRect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 把 rects（含 index 标识）装进一个 binW×binH 的箱子。
 * 成功返回全部位置；装不下返回 null。
 */
export function packMaxRects(
  sizes: Array<{ w: number; h: number }>,
  binW: number,
  binH: number
): PackedRect[] | null {
  let free: FreeRect[] = [{ x: 0, y: 0, w: binW, h: binH }];
  const placed: PackedRect[] = [];
  const remaining = sizes.map((s, index) => ({ ...s, index }));

  // 大块优先（面积降序，稳定：index 升序 tie-break）—— 与 rectpack 默认排序一致
  remaining.sort((a, b) => b.w * b.h - a.w * a.h || a.index - b.index);

  for (const rect of remaining) {
    // BSSF：在所有自由矩形里找放得下的位置，取短边剩余最小
    let best: { free: FreeRect; short: number; long: number } | null = null;
    for (const f of free) {
      if (f.w < rect.w || f.h < rect.h) continue;
      const leftoverH = f.w - rect.w;
      const leftoverV = f.h - rect.h;
      const short = Math.min(leftoverH, leftoverV);
      const long = Math.max(leftoverH, leftoverV);
      if (!best || short < best.short || (short === best.short && long < best.long)) {
        best = { free: f, short, long };
      }
    }
    if (!best) return null; // 该矩形放不下 → 整体失败
    const { x, y } = best.free;
    placed.push({ index: rect.index, x, y, w: rect.w, h: rect.h });

    // MaxRects 核心：放下的矩形与所有相交的自由矩形分裂成至多 4 个新自由矩形
    const used = { x, y, w: rect.w, h: rect.h };
    const next: FreeRect[] = [];
    for (const f of free) {
      splitFree(f, used, next);
    }
    // 去重（被完全包含的自由矩形丢弃）
    free = next.filter((f, i) => f.w > 0 && f.h > 0 && !next.some((g, j) => j !== i && contains(g, f)));
    free = pruneContained(free);
  }
  return placed;
}

function contains(outer: FreeRect, inner: FreeRect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;
}

function pruneContained(free: FreeRect[]): FreeRect[] {
  // 保留不被其他自由矩形包含的
  return free.filter((f, i) => !free.some((g, j) => j !== i && contains(g, f)));
}

function splitFree(free: FreeRect, used: FreeRect, out: FreeRect[]): void {
  // 不相交：保留
  if (used.x >= free.x + free.w || used.x + used.w <= free.x || used.y >= free.y + free.h || used.y + used.h <= free.y) {
    out.push(free);
    return;
  }
  // 上侧
  if (used.y > free.y) out.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y });
  // 下侧
  if (used.y + used.h < free.y + free.h) out.push({ x: free.x, y: used.y + used.h, w: free.w, h: free.y + free.h - (used.y + used.h) });
  // 左侧
  if (used.x > free.x) out.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h });
  // 右侧
  if (used.x + used.w < free.x + free.w) out.push({ x: used.x + used.w, y: free.y, w: free.x + free.w - (used.x + used.w), h: free.h });
}

/**
 * 对齐 sprite 的装箱策略：枚举列数 1..n，箱子 = cols*cellW+pad × rows*cellH+pad（不小于最大帧），
 * 全部装下且面积最小的胜出；返回 null 表示全部失败（调用方回退规则网格）。
 */
export function packSheetBest(
  frameSizes: Array<{ w: number; h: number }>,
  cellW: number,
  cellH: number,
  padding: number
): { rects: PackedRect[]; binW: number; binH: number } | null {
  const n = frameSizes.length;
  if (n <= 1) return null; // 单帧无装箱收益，走 grid
  const maxW = Math.max(...frameSizes.map((s) => s.w)) + padding;
  const maxH = Math.max(...frameSizes.map((s) => s.h)) + padding;
  let best: { rects: PackedRect[]; binW: number; binH: number } | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const binW = Math.max(cols * cellW + padding * cols, maxW);
    const binH = Math.max(rows * cellH + padding * rows, maxH);
    const sizes = frameSizes.map((s) => ({ w: s.w + padding, h: s.h + padding }));
    const rects = packMaxRects(sizes, binW, binH);
    if (rects && (!best || binW * binH < best.binW * best.binH)) {
      best = { rects, binW, binH };
    }
  }
  return best;
}
