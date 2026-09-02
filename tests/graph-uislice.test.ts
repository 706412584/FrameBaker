import { describe, expect, test } from "bun:test";
import { analyzeUiSmartSlicesData, defaultUiSmartSliceOptions } from "../apps/web/src/graph/uiSlice";
import { connectedComponentsOnMask } from "../apps/web/src/imageops/ops";

// 去底 UI 图：两个不相连的不透明方块 + 一小块碎屑（应被 minArea 过滤）
function makeUiSheet(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4); // 全透明
  const fill = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  };
  fill(4, 4, 20, 20, 255, 60, 60);      // 左上按钮 16x16
  fill(40, 8, 70, 26, 60, 200, 255);    // 右上长条 30x18
  fill(2, 2, 3, 3, 255, 255, 255);      // 2x2 碎屑（minArea 过滤）
  return data;
}

describe("uiSlice（迁移自 sprite analyzeUiSmartSlices）", () => {
  test("检测出两个独立元素，碎屑被过滤", () => {
    const result = analyzeUiSmartSlicesData(makeUiSheet(80, 40), 80, 40);
    expect(result.width).toBe(80);
    expect(result.height).toBe(40);
    expect(result.candidates.length).toBe(2);
    // 阅读顺序排序：y 小的在前
    const [first, second] = result.candidates;
    expect(first!.x).toBeLessThan(second!.x);
    // 框应包含 padding（去底图自动收紧为 1）
    const pad = 1; // hasTransparency → effectivePadding=1
    expect(first!.x).toBe(4 - pad);
    expect(second!.x).toBe(40 - pad);
    expect(second!.w).toBe(30 + pad * 2);
  });

  test("确定性：同输入两次分析结果一致（等价性前提）", () => {
    const a = analyzeUiSmartSlicesData(makeUiSheet(80, 40), 80, 40);
    const b = analyzeUiSmartSlicesData(makeUiSheet(80, 40), 80, 40);
    expect(a.candidates).toEqual(b.candidates);
  });

  test("全透明输入：candidates 空 + 警告", () => {
    const result = analyzeUiSmartSlicesData(new Uint8ClampedArray(20 * 20 * 4), 20, 20);
    expect(result.candidates.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("connectedComponentsOnMask：4 邻域 flood 正确", () => {
    // 对角相邻不算连通（4 邻域）
    const mask = new Uint8Array(4 * 4);
    mask[0] = 1; mask[5] = 1;   // (0,0) 与 (1,1) 对角 → 两个分量
    mask[10] = 1; mask[14] = 1; // (2,2) 与 (2,3) 相邻 → 一个分量
    const comps = connectedComponentsOnMask(mask, 4, 4);
    expect(comps.length).toBe(3);
    expect(comps.find((c) => c.x === 2 && c.y === 2)).toEqual({ x: 2, y: 2, w: 1, h: 2, area: 2 });
  });
});
