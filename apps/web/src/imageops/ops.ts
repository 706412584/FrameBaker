// 环境无关的图像纯计算：worker 与主线程降级路径共用

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageAnalysis {
  width: number;
  height: number;
  bounds: CropRect | null;
  opaqueRatio: number;
  significantComponents: number;
  sample: number[];
}

export type SkeletalPartQualityIssueCode = "empty" | "touches-edge" | "fragmented" | "duplicate" | "mirrored-duplicate";

export interface SkeletalPartQualityIssue {
  code: SkeletalPartQualityIssueCode;
  cells: number[];
}

export interface EditPoint {
  x: number;
  y: number;
}

export interface EraseStroke {
  size: number;
  points: EditPoint[];

}

/** worker 消息协议（Blob 走 structured clone，无需手动 transfer） */
/** 连通域自动检测参数（阅读顺序返回不透明部件包围盒）。 */
export interface DetectComponentsOptions {
  alphaThreshold?: number;
  /** 面积下限占总不透明像素比例（滤除碎屑）。 */
  minAreaRatio?: number;
  /** 面积绝对下限像素。 */
  minAreaPixels?: number;
  /** 保留最大的前 N 个部件。 */
  maxComponents?: number;
}

export interface ImageOpRequest {
  id: number;

  op: "bounds" | "crop" | "analyze" | "edit" | "components";

  blob: Blob;
  rect?: CropRect;
  strokes?: EraseStroke[];
  quarterTurns?: number;
  flipHorizontal?: boolean;
  componentOptions?: DetectComponentsOptions;
}

export interface ImageOpResponse {
  id: number;
  ok: boolean;
  rect?: CropRect | null;
  rects?: CropRect[];
  blob?: Blob;
  analysis?: ImageAnalysis;
  error?: string;
}

/** 扫描 alpha>0 像素的最小包围盒（像素图「裁透明边」）；全透明返回 null */
export function computeOpaqueBounds(data: Uint8ClampedArray, width: number, height: number, alphaThreshold = 0): CropRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const ANALYSIS_ALPHA_THRESHOLD = 8;
const SAMPLE_SIZE = 16;

/**
 * 连通域自动检测：4 连通洪泛扫描 alpha>阈值 的不透明块，返回按阅读顺序
 * （上到下分行带、行内左到右）排列的显著部件包围盒。用于精灵图按部件而非
 * 均匀网格切分，避免切穿部件。碎屑按面积阈值滤除。
 */
export function detectOpaqueComponents(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: DetectComponentsOptions = {},
): CropRect[] {
  const alphaThreshold = options.alphaThreshold ?? ANALYSIS_ALPHA_THRESHOLD;
  const total = width * height;
  if (total <= 0) return [];
  const foreground = (index: number) => data[index * 4 + 3] > alphaThreshold;
  let opaquePixels = 0;
  for (let i = 0; i < total; i++) if (foreground(i)) opaquePixels++;
  if (opaquePixels === 0) return [];

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const components: Array<{ rect: CropRect; area: number }> = [];
  for (let start = 0; start < total; start++) {
    if (visited[start] || !foreground(start)) continue;
    let read = 0;
    let write = 0;
    let area = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    visited[start] = 1;
    queue[write++] = start;
    while (read < write) {
      const index = queue[read++];
      area++;
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const visit = (next: number) => {
        if (!visited[next] && foreground(next)) {
          visited[next] = 1;
          queue[write++] = next;
        }
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    components.push({ area, rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
  }

  const minArea = Math.max(options.minAreaPixels ?? 16, Math.ceil(opaquePixels * (options.minAreaRatio ?? 0.005)));
  let significant = components.filter((component) => component.area >= minArea);
  if (!significant.length) significant = [components.reduce((largest, current) => (current.area > largest.area ? current : largest))];
  if (options.maxComponents && significant.length > options.maxComponents) {
    significant = [...significant].sort((a, b) => b.area - a.area).slice(0, options.maxComponents);
  }

  // 阅读顺序：中位高度的行带聚合，行带内按中心 x 排序。
  const sortedHeights = significant.map((component) => component.rect.h).sort((a, b) => a - b);
  const medianHeight = sortedHeights.length ? sortedHeights[Math.floor(sortedHeights.length / 2)] : 1;
  const band = Math.max(1, medianHeight * 0.6);
  return significant
    .map((component) => ({ rect: component.rect, cx: component.rect.x + component.rect.w / 2, cy: component.rect.y + component.rect.h / 2 }))
    .sort((a, b) => (Math.floor(a.cy / band) - Math.floor(b.cy / band)) || (a.cx - b.cx))
    .map((entry) => entry.rect);
}

function countSignificantComponents(data: Uint8ClampedArray, width: number, height: number, opaquePixels: number): number {
  if (opaquePixels === 0) return 0;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const areas: number[] = [];
  const foreground = (index: number) => data[index * 4 + 3] > ANALYSIS_ALPHA_THRESHOLD;

  for (let start = 0; start < width * height; start++) {
    if (visited[start] || !foreground(start)) continue;
    let read = 0;
    let write = 0;
    let area = 0;
    visited[start] = 1;
    queue[write++] = start;
    while (read < write) {
      const index = queue[read++];
      area++;
      const x = index % width;
      const y = Math.floor(index / width);
      const visit = (next: number) => {
        if (visited[next] || !foreground(next)) return;
        visited[next] = 1;
        queue[write++] = next;
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    areas.push(area);
  }

  const minimumArea = Math.max(4, Math.ceil(opaquePixels * .02));
  return areas.filter((area) => area >= minimumArea).length;
}

function sampleOpaqueBounds(data: Uint8ClampedArray, width: number, bounds: CropRect | null): number[] {
  const sample = new Array<number>(SAMPLE_SIZE * SAMPLE_SIZE * 4).fill(0);
  if (!bounds) return sample;
  for (let sy = 0; sy < SAMPLE_SIZE; sy++) {
    const y0 = bounds.y + Math.floor(sy * bounds.h / SAMPLE_SIZE);
    const y1 = bounds.y + Math.max(Math.floor((sy + 1) * bounds.h / SAMPLE_SIZE), Math.floor(sy * bounds.h / SAMPLE_SIZE) + 1);
    for (let sx = 0; sx < SAMPLE_SIZE; sx++) {
      const x0 = bounds.x + Math.floor(sx * bounds.w / SAMPLE_SIZE);
      const x1 = bounds.x + Math.max(Math.floor((sx + 1) * bounds.w / SAMPLE_SIZE), Math.floor(sx * bounds.w / SAMPLE_SIZE) + 1);
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let opaque = 0;
      let pixels = 0;
      for (let y = y0; y < Math.min(y1, bounds.y + bounds.h); y++) {
        for (let x = x0; x < Math.min(x1, bounds.x + bounds.w); x++) {
          const index = (y * width + x) * 4;
          pixels++;
          alpha += data[index + 3];
          if (data[index + 3] <= ANALYSIS_ALPHA_THRESHOLD) continue;
          red += data[index];
          green += data[index + 1];
          blue += data[index + 2];
          opaque++;
        }
      }
      const out = (sy * SAMPLE_SIZE + sx) * 4;
      sample[out] = opaque ? Math.round(red / opaque / 17) : 0;
      sample[out + 1] = opaque ? Math.round(green / opaque / 17) : 0;
      sample[out + 2] = opaque ? Math.round(blue / opaque / 17) : 0;
      sample[out + 3] = pixels ? Math.round(alpha / pixels / 17) : 0;
    }
  }
  return sample;
}

/** 为质量检查提取透明边、连通主体和归一化视觉采样。 */
export function computeImageAnalysis(data: Uint8ClampedArray, width: number, height: number): ImageAnalysis {
  const bounds = computeOpaqueBounds(data, width, height, ANALYSIS_ALPHA_THRESHOLD);
  let opaquePixels = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > ANALYSIS_ALPHA_THRESHOLD) opaquePixels++;
  }
  return {
    width,
    height,
    bounds,
    opaqueRatio: width && height ? opaquePixels / (width * height) : 0,
    significantComponents: countSignificantComponents(data, width, height, opaquePixels),
    sample: sampleOpaqueBounds(data, width, bounds),
  };
}

/** 归一化采样相似度；mirror=true 时水平翻转第二个部件。 */
export function imageAnalysisSimilarity(a: ImageAnalysis, b: ImageAnalysis, mirror = false): number {
  if (!a.bounds || !b.bounds || a.sample.length !== b.sample.length) return 0;
  let difference = 0;
  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let x = 0; x < SAMPLE_SIZE; x++) {
      const ai = (y * SAMPLE_SIZE + x) * 4;
      const bx = mirror ? SAMPLE_SIZE - 1 - x : x;
      const bi = (y * SAMPLE_SIZE + bx) * 4;
      const aa = a.sample[ai + 3];
      const ba = b.sample[bi + 3];
      if (aa === 0 && ba === 0) continue;
      if (aa === 0 || ba === 0) {
        difference += 1;
        continue;
      }
      const alphaDifference = Math.abs(aa - ba) / 15;
      const colorDifference = (
        Math.abs(a.sample[ai] - b.sample[bi])
        + Math.abs(a.sample[ai + 1] - b.sample[bi + 1])
        + Math.abs(a.sample[ai + 2] - b.sample[bi + 2])
      ) / 45;
      difference += alphaDifference * .35 + colorDifference * .65;
    }
  }
  return Math.max(0, 1 - difference / (SAMPLE_SIZE * SAMPLE_SIZE));
}

/**
 * 骨骼分件硬性质量闸门。这里只拦截可由像素证实的错误；
 * 头/骨盆/手等语义仍需在提交前由逐格人工复核。
 */
export function findSkeletalPartQualityIssues(analyses: ImageAnalysis[], standardHumanoidLayout = true): SkeletalPartQualityIssue[] {
  const issues: SkeletalPartQualityIssue[] = [];
  const oppositeSidePairs = standardHumanoidLayout ? new Set(["4:6", "5:7", "8:10", "9:11"]) : new Set<string>();
  analyses.forEach((analysis, index) => {
    const cell = index + 1;
    if (!analysis.bounds) {
      issues.push({ code: "empty", cells: [cell] });
      return;
    }
    const { bounds } = analysis;
    if (bounds.x === 0 || bounds.y === 0 || bounds.x + bounds.w === analysis.width || bounds.y + bounds.h === analysis.height) {
      issues.push({ code: "touches-edge", cells: [cell] });
    }
    if (analysis.significantComponents > 1) issues.push({ code: "fragmented", cells: [cell] });
  });

  for (let left = 0; left < analyses.length; left++) {
    const a = analyses[left];
    if (!a.bounds) continue;
    for (let right = left + 1; right < analyses.length; right++) {
      const b = analyses[right];
      if (!b.bounds) continue;
      const aspectA = a.bounds.w / a.bounds.h;
      const aspectB = b.bounds.w / b.bounds.h;
      const oppositeSides = oppositeSidePairs.has(`${left}:${right}`);
      const sameShape = Math.abs(aspectA - aspectB) / Math.max(aspectA, aspectB) < (oppositeSides ? .08 : .04)
        && Math.abs(a.opaqueRatio - b.opaqueRatio) < (oppositeSides ? .03 : .015);
      if (!sameShape) continue;
      const direct = imageAnalysisSimilarity(a, b);
      if (direct >= (oppositeSides ? .84 : .995)) {
        issues.push({ code: "duplicate", cells: [left + 1, right + 1] });
      } else if (imageAnalysisSimilarity(a, b, true) >= (oppositeSides ? .9 : .997)) {
        issues.push({ code: "mirrored-duplicate", cells: [left + 1, right + 1] });
      }
    }
  }
  return issues;
}

/** 自定义网格跳过透明余格；标准人形网格只允许明确标记的可选格留空。 */
export function reviewSkeletalGrid(analyses: ImageAnalysis[], requireEveryCell: boolean, optionalEmptyIndexes: number[] = []): { activeIndexes: number[]; issues: SkeletalPartQualityIssue[] } {
  if (requireEveryCell) {
    const optional = new Set(optionalEmptyIndexes);
    const activeIndexes = analyses.flatMap((analysis, index) => analysis.bounds || !optional.has(index) ? [index] : []);
    const issues = findSkeletalPartQualityIssues(analyses, true).filter((issue) => !(issue.code === "empty" && optional.has(issue.cells[0] - 1)));
    return { activeIndexes, issues };
  }
  const activeIndexes = analyses.flatMap((analysis, index) => analysis.bounds ? [index] : []);
  if (!activeIndexes.length) return { activeIndexes, issues: [{ code: "empty", cells: [1] }] };
  const issues = findSkeletalPartQualityIssues(activeIndexes.map((index) => analyses[index]), false).map((issue) => ({
    ...issue,
    cells: issue.cells.map((cell) => activeIndexes[cell - 1] + 1),
  }));
  return { activeIndexes, issues };
}
