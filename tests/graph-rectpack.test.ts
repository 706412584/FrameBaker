import { describe, expect, test } from "bun:test";
import { packMaxRects, packSheetBest } from "../apps/server/src/graph/rectpack";

describe("rectpack（对齐 sprite MaxRectsBssf 语义）", () => {
  test("等大同尺寸帧：全部装入且无重叠", () => {
    const sizes = Array.from({ length: 4 }, () => ({ w: 32, h: 32 }));
    const rects = packMaxRects(sizes, 64, 64);
    expect(rects).not.toBeNull();
    expect(rects!.length).toBe(4);
    // 无重叠
    for (let i = 0; i < rects!.length; i++) {
      for (let j = i + 1; j < rects!.length; j++) {
        const a = rects![i]!, b = rects![j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    // 全部在箱内
    for (const r of rects!) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(64);
      expect(r.y + r.h).toBeLessThanOrEqual(64);
    }
  });

  test("装不下：返回 null", () => {
    const sizes = [{ w: 40, h: 40 }, { w: 40, h: 40 }];
    expect(packMaxRects(sizes, 50, 50)).toBeNull(); // 两个 40x40 塞不进 50x50
  });

  test("index 保持原帧对应（拆完能映射回源帧）", () => {
    const sizes = [
      { w: 10, h: 60 },
      { w: 60, h: 10 },
      { w: 30, h: 30 },
    ];
    const rects = packMaxRects(sizes, 70, 70);
    expect(rects).not.toBeNull();
    const byIndex = new Map(rects!.map((r) => [r.index, r]));
    expect(byIndex.size).toBe(3);
    for (let i = 0; i < 3; i++) {
      const r = byIndex.get(i)!;
      expect(r.w).toBe(sizes[i]!.w);
      expect(r.h).toBe(sizes[i]!.h);
    }
  });

  test("packSheetBest：不等大帧返回可行布局（sprite 语义：装箱成功即用 packed）", () => {
    // 2 个 64x64 + 2 个 16x16：装箱能找到可行布局且全部帧装下
    // 注意：packed 含 padding 开销，面积不一定小于无 padding 的规则网格 —— sprite 同语义
    const sizes = [
      { w: 64, h: 64 }, { w: 64, h: 64 }, { w: 16, h: 16 }, { w: 16, h: 16 },
    ];
    const best = packSheetBest(sizes, 64, 64, 2);
    expect(best).not.toBeNull();
    expect(best!.rects.length).toBe(4);
    // 无重叠 + 在箱内
    for (let i = 0; i < best!.rects.length; i++) {
      for (let j = i + 1; j < best!.rects.length; j++) {
        const a = best!.rects[i]!, b = best!.rects[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
      const r = best!.rects[i]!;
      expect(r.x + r.w).toBeLessThanOrEqual(best!.binW);
      expect(r.y + r.h).toBeLessThanOrEqual(best!.binH);
    }
  });

  test("packSheetBest：单帧返回 null（走 grid）", () => {
    expect(packSheetBest([{ w: 32, h: 32 }], 32, 32, 2)).toBeNull();
  });
});
