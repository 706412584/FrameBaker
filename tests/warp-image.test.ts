import { describe, expect, test } from "bun:test";
import { warpImagePixels } from "../apps/web/src/imageops/ops";

// 读取输出像素 (x,y) 的 RGBA
function px(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

describe("warpImagePixels", () => {
  test("identity warp (all-zero points) reproduces the input pixels", () => {
    // 9×9 图案像素，3×3 网格全零位移 → 输出应与输入完全一致
    const width = 9;
    const height = 9;
    const src = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      src[i * 4] = (i * 37) % 256;
      src[i * 4 + 1] = (i * 91) % 256;
      src[i * 4 + 2] = (i * 53) % 256;
      src[i * 4 + 3] = 128 + (i % 2) * 127;
    }
    const points = new Array(2 * 3 * 3).fill(0);
    const out = warpImagePixels(src, width, height, [3, 3], points);
    expect(out.length).toBe(src.length);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  test("moving a corner node shifts the pixels near that corner", () => {
    // 8×8 白底，(0,0) 红色标记；2×2 网格左上角右移 0.25 宽（=2px）
    const width = 8;
    const height = 8;
    const src = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      src[i * 4] = 255;
      src[i * 4 + 1] = 255;
      src[i * 4 + 2] = 255;
      src[i * 4 + 3] = 255;
    }
    src[0] = 255; src[1] = 0; src[2] = 0; src[3] = 255; // (0,0) 红色
    const points = [0.25, 0, 0, 0, 0, 0, 0, 0]; // 仅左上角节点 dx=0.25
    const out = warpImagePixels(src, width, height, [2, 2], points);
    // 角点移走后，(0,0) 不再被任何三角形覆盖 → 保持透明
    expect(px(out, width, 0, 0)).toEqual([0, 0, 0, 0]);
    // 红色标记跟随角点右移 2px 到 (2,0)
    expect(px(out, width, 2, 0)).toEqual([255, 0, 0, 255]);
  });

  test("out-of-range displacement does not throw and keeps the output size", () => {
    const width = 6;
    const height = 4;
    const src = new Uint8ClampedArray(width * height * 4).fill(255);
    // 位移远超边界：所有节点推出画面外
    const points = new Array(2 * 2 * 2).fill(5);
    const out = warpImagePixels(src, width, height, [2, 2], points);
    expect(out.length).toBe(src.length);
    // 全部越界裁剪 → 输出保持全透明
    expect(Array.from(out)).toEqual(new Array(out.length).fill(0));
  });

  test("rejects malformed grid/points without throwing", () => {
    const src = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    expect(warpImagePixels(src, 4, 4, [1, 1], []).length).toBe(src.length);
    expect(warpImagePixels(src, 4, 4, [3, 3], [0, 0]).length).toBe(src.length);
  });
});
