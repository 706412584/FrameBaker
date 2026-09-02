// 像素量化引擎 — 迁移自 sprite 工坊 quantizeEngine.ts（算法不变，I/O 改 OffscreenCanvas 供 worker/主线程共用）
// 基于 image-q 库 + 像素化下采样
// 纯核心（quantizePixels / applyPalettePixels）不触碰 DOM —— bun test 可直接覆盖；
// 画布路径（downsample/upscale）只在 quantizeImageData 里走 OffscreenCanvas/HTMLCanvas。
import { buildPaletteSync, applyPaletteSync, utils } from "image-q";
import type { PaletteQuantization, ImageQuantization } from "image-q";

type Palette = ReturnType<typeof buildPaletteSync>;

export type DitheringMethod =
  | "nearest"
  | "floyd-steinberg"
  | "stucki"
  | "atkinson"
  | "jarvis"
  | "burkes"
  | "sierra";

export type QuantizeMethod = "wuquant" | "neuquant" | "rgbquant";

export interface QuantizeOptions {
  colors: number;            // 颜色数 2-256
  method: QuantizeMethod;    // 量化算法
  dithering: DitheringMethod;// 抖动算法
  pixelSize: number;         // 像素块大小 1-32（1=不像素化，>1=马赛克块）
}

export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  a: number;
  hex: string;
}

export interface QuantizeResult {
  imageData: ImageData;     // 输出与源图同尺寸（已放大回去）
  palette: PaletteColor[];
  pixelatedWidth: number;   // 实际量化分辨率
  pixelatedHeight: number;
}

export const defaultQuantizeOptions: QuantizeOptions = {
  colors: 16,
  method: "wuquant",
  dithering: "nearest",       // 像素艺术常用无抖动
  pixelSize: 1,
};

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

function paletteToColors(palette: Palette): PaletteColor[] {
  return palette.getPointContainer().getPointArray().map((p: { r: number; g: number; b: number; a: number }) => ({
    r: p.r, g: p.g, b: p.b, a: p.a,
    hex: rgbaToHex(p.r, p.g, p.b, p.a),
  }));
}

// ---- 纯核心（无 DOM，可单测）----

/** 从 RGBA 像素构建调色板 */
export function buildPaletteFromPixels(data: Uint8ClampedArray, width: number, height: number, options: QuantizeOptions): { palette: Palette; colors: PaletteColor[] } {
  const pointContainer = utils.PointContainer.fromUint8Array(new Uint8Array(data), width, height);
  const palette = buildPaletteSync([pointContainer], {
    colorDistanceFormula: "euclidean",
    paletteQuantization: options.method as PaletteQuantization,
    colors: options.colors,
  });
  return { palette, colors: paletteToColors(palette) };
}

/** 应用调色板到 RGBA 像素（dithering 按 options） */
export function applyPaletteToPixels(data: Uint8ClampedArray, width: number, height: number, palette: Palette, options: QuantizeOptions): Uint8ClampedArray {
  const pointContainer = utils.PointContainer.fromUint8Array(new Uint8Array(data), width, height);
  const outContainer = applyPaletteSync(pointContainer, palette, {
    colorDistanceFormula: "euclidean",
    imageQuantization: options.dithering as ImageQuantization,
  });
  return new Uint8ClampedArray(outContainer.toUint8Array());
}

/** 锁定调色板：以种子图构建所含点完全等于 lockedPalette 的 Palette */
export function buildLockedPalette(lockedPalette: PaletteColor[]): Palette {
  const seed = utils.PointContainer.fromUint8Array(
    new Uint8Array(lockedPalette.flatMap((c) => [c.r, c.g, c.b, c.a])),
    lockedPalette.length, 1,
  );
  return buildPaletteSync([seed], {
    colorDistanceFormula: "euclidean",
    paletteQuantization: "wuquant",
    colors: lockedPalette.length,
  });
}

// ---- 画布路径（worker / 主线程）----

/** 把源图按 pixelSize 缩小，得到下采样画布（OffscreenCanvas 与 HTMLCanvas 的 2d API 同形） */
function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext("2d")! };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d")! };
}

function downsample(source: ImageData, pixelSize: number): ImageData {
  if (pixelSize <= 1) return source;
  const w = Math.max(1, Math.floor(source.width / pixelSize));
  const h = Math.max(1, Math.floor(source.height / pixelSize));
  const src = makeCanvas(source.width, source.height);
  src.ctx.putImageData(source, 0, 0);

  const dst = makeCanvas(w, h);
  dst.ctx.imageSmoothingEnabled = false;     // 关插值，得到块状结果
  dst.ctx.drawImage(src.canvas as CanvasImageSource, 0, 0, w, h);
  return dst.ctx.getImageData(0, 0, w, h);
}

function applyAndUpscale(
  source: ImageData,
  small: ImageData,
  palette: Palette,
  paletteColors: PaletteColor[],
  options: QuantizeOptions,
): QuantizeResult {
  const quantized = applyPaletteToPixels(small.data, small.width, small.height, palette, options);
  // image-q 返回类型带 ArrayBufferLike；ImageData 构造器需要确切 ArrayBuffer（运行时 new Uint8ClampedArray 已复制到新 buffer）
  const quantizedSmall = new ImageData(quantized as unknown as ImageDataArray, small.width, small.height);

  let outImageData: ImageData;
  if (options.pixelSize <= 1) {
    outImageData = quantizedSmall;
  } else {
    const tmp = makeCanvas(small.width, small.height);
    tmp.ctx.putImageData(quantizedSmall, 0, 0);

    const big = makeCanvas(source.width, source.height);
    big.ctx.imageSmoothingEnabled = false;
    big.ctx.drawImage(tmp.canvas as CanvasImageSource, 0, 0, source.width, source.height);
    outImageData = big.ctx.getImageData(0, 0, source.width, source.height);
  }

  return {
    imageData: outImageData,
    palette: paletteColors,
    pixelatedWidth: small.width,
    pixelatedHeight: small.height,
  };
}

export function quantizeImageData(source: ImageData, options: QuantizeOptions): QuantizeResult {
  const small = downsample(source, options.pixelSize);
  const { palette, colors } = buildPaletteFromPixels(small.data, small.width, small.height, options);
  return applyAndUpscale(source, small, palette, colors, options);
}

// 用现成 PaletteColor[] 量化（用于"调色板锁定"模式）
export function quantizeImageDataWithPalette(
  source: ImageData,
  options: QuantizeOptions,
  lockedPalette: PaletteColor[],
): QuantizeResult {
  const small = downsample(source, options.pixelSize);
  const palette = buildLockedPalette(lockedPalette);
  return applyAndUpscale(source, small, palette, paletteToColors(palette), options);
}
