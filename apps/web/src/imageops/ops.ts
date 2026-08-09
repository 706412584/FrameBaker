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
  /** 16×16 的 RGBA 量化采样（每通道 0..15），用于识别缩放前后的重复部件。 */
  sample: number[];
}

export type SkeletalPartQualityIssueCode =
  | "empty"
  | "touches-edge"
  | "fragmented"
  | "duplicate"
  | "mirrored-duplicate";

export interface SkeletalPartQualityIssue {
  code: SkeletalPartQualityIssueCode;
  cells: number[];
}

/** worker 消息协议（Blob 走 structured clone，无需手动 transfer） */
export interface ImageOpRequest {
  id: number;
  op: "bounds" | "crop" | "analyze";
  blob: Blob;
  rect?: CropRect;
}

export interface ImageOpResponse {
  id: number;
  ok: boolean;
  rect?: CropRect | null;
  blob?: Blob;
  analysis?: ImageAnalysis;
  error?: string;
}

/** 扫描 alpha>0 像素的最小包围盒（像素图「裁透明边」）；全透明返回 null */
export function computeOpaqueBounds(data: Uint8ClampedArray, width: number, height: number): CropRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 0) {
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
  const bounds = computeOpaqueBounds(data, width, height);
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
 * 4×3 骨骼分件硬性质量闸门。这里只拦截可由像素证实的错误；
 * 头/骨盆/手等语义仍需在提交前由逐格人工复核。
 */
export function findSkeletalPartQualityIssues(analyses: ImageAnalysis[]): SkeletalPartQualityIssue[] {
  const issues: SkeletalPartQualityIssue[] = [];
  const oppositeSidePairs = new Set(["4:6", "5:7", "8:10", "9:11"]);
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
