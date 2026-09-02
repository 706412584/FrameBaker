import { describe, expect, test } from "bun:test";
import {
  buildPaletteFromPixels,
  applyPaletteToPixels,
  buildLockedPalette,
  defaultQuantizeOptions,
  type PaletteColor,
} from "../apps/web/src/imageops/quantize";

// 纯核心测试（不触碰 DOM；画布路径由 worker 冒烟覆盖）
function makeTestPixels(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    const q = (x < w / 2 ? 0 : 1) + (y < h / 2 ? 0 : 2);
    data[i * 4] = [220, 60, 130, 20][q]! + (x % 8);
    data[i * 4 + 1] = [40, 180, 90, 200][q]!;
    data[i * 4 + 2] = [60, 90, 230, 160][q]! + (y % 6);
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe("quantize 纯核心（迁移自 sprite quantizeEngine）", () => {
  test("buildPalette：调色板 ≤ colors 且 hex 合法", () => {
    const { colors } = buildPaletteFromPixels(makeTestPixels(32, 32), 32, 32, defaultQuantizeOptions);
    expect(colors.length).toBeLessThanOrEqual(defaultQuantizeOptions.colors);
    expect(colors.length).toBeGreaterThan(1);
    expect(colors.every((c) => /^#[0-9a-f]{6,8}$/i.test(c.hex))).toBe(true);
  });

  test("apply：nearest 无抖动时输出像素全部落在调色板颜色上", () => {
    const pixels = makeTestPixels(16, 16);
    const { palette, colors } = buildPaletteFromPixels(pixels, 16, 16, { ...defaultQuantizeOptions, colors: 8, dithering: "nearest" });
    const out = applyPaletteToPixels(pixels, 16, 16, palette, { ...defaultQuantizeOptions, colors: 8, dithering: "nearest" });
    const allowed = new Set(colors.map((c) => `${c.r},${c.g},${c.b},${c.a}`));
    let matched = 0;
    for (let i = 0; i < out.length; i += 4) {
      if (allowed.has(`${out[i]},${out[i + 1]},${out[i + 2]},${out[i + 3]}`)) matched++;
    }
    expect(matched).toBe(out.length / 4);
  });

  test("同参确定性：两次构建+应用结果一致（等价性前提）", () => {
    const pixels = makeTestPixels(24, 24);
    const opts = { ...defaultQuantizeOptions, colors: 8 };
    const a = buildPaletteFromPixels(pixels, 24, 24, opts);
    const b = buildPaletteFromPixels(pixels, 24, 24, opts);
    expect(a.colors).toEqual(b.colors);
    const outA = applyPaletteToPixels(pixels, 24, 24, a.palette, opts);
    const outB = applyPaletteToPixels(pixels, 24, 24, b.palette, opts);
    expect(Array.from(outA)).toEqual(Array.from(outB));
  });

  test("锁定调色板：输出颜色全部来自锁定调色板", () => {
    const pixels = makeTestPixels(16, 16);
    const locked: PaletteColor[] = [
      { r: 255, g: 0, b: 0, a: 255, hex: "#ff0000" },
      { r: 0, g: 255, b: 0, a: 255, hex: "#00ff00" },
      { r: 0, g: 0, b: 255, a: 255, hex: "#0000ff" },
    ];
    const palette = buildLockedPalette(locked);
    const out = applyPaletteToPixels(pixels, 16, 16, palette, { ...defaultQuantizeOptions, dithering: "nearest" });
    const allowed = new Set(locked.map((c) => `${c.r},${c.g},${c.b}`));
    let matched = 0;
    for (let i = 0; i < out.length; i += 4) {
      if (allowed.has(`${out[i]},${out[i + 1]},${out[i + 2]}`)) matched++;
    }
    expect(matched).toBe(out.length / 4);
  });

  test("colors=2：调色板不超过 2 色", () => {
    const { colors } = buildPaletteFromPixels(makeTestPixels(16, 16), 16, 16, { ...defaultQuantizeOptions, colors: 2 });
    expect(colors.length).toBeLessThanOrEqual(2);
  });
});
