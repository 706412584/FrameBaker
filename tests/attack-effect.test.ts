import { describe, expect, test } from "bun:test";
import {
  attackEffectBounds,
  attackEffectLocalPoint,
  attackEffectPoint,
  attackBrushBodyScale,
  attackPointWidth,
  attackTextureMarks,
  brushPressure,
  shouldSamplePoint,
} from "../apps/web/src/attackEffect";
import type { AttackEffect } from "@framebaker/shared";

const effect: AttackEffect = {
  strokes: [{ color: "#ffcc33", size: 4, points: [{ x: 3, y: 0, pressure: 0.5 }] }],
  offset_x: 10,
  offset_y: -5,
  scale: 2,
  rotation: Math.PI / 2,
  opacity: 1,
};

describe("逐帧攻击特效", () => {
  test("整体变换可在世界坐标与局部坐标间往返", () => {
    const world = attackEffectPoint(effect, { x: 3, y: 0 });
    expect(world.x).toBeCloseTo(10);
    expect(world.y).toBeCloseTo(1);
    const local = attackEffectLocalPoint(effect, world);
    expect(local.x).toBeCloseTo(3);
    expect(local.y).toBeCloseTo(0);
  });

  test("包围盒包含缩放后的笔锋半径", () => {
    expect(attackEffectBounds(effect)).toEqual({ left: 4, right: 16, top: -5, bottom: 7 });
    expect(attackEffectBounds({ ...effect, strokes: [] })).toBeNull();
  });

  test("压感平滑并过滤过密采样点", () => {
    expect(brushPressure(0.8, 1, 16, 0.65)).toBeCloseTo(0.7175);
    expect(shouldSamplePoint({ x: 0, y: 0, pressure: 1 }, { x: 1, y: 1 })).toBe(false);
    expect(shouldSamplePoint({ x: 0, y: 0, pressure: 1 }, { x: 2, y: 0 })).toBe(true);
  });

  test("笔锋沿绘制方向从宽起势到窄收尾", () => {
    const point = { x: 0, y: 0, pressure: 1 };
    const widths = [0, 1, 2, 3].map((index) => attackPointWidth(20, point, index, 4));
    expect(widths[0]).toBeCloseTo(20);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
    expect(widths[2]).toBeGreaterThan(widths[3]);
    expect(widths[3]).toBeCloseTo(1.2);
  });

  test("五种笔刷纹理稳定且旧笔画缺省为利刃", () => {
    const stroke = {
      color: "#ff8a18",
      size: 18,
      points: [
        { x: -20, y: 6, pressure: 1 },
        { x: 0, y: -8, pressure: 0.8 },
        { x: 24, y: 5, pressure: 0.25 },
      ],
    };
    expect(attackTextureMarks(stroke)).toEqual({ lines: [], dots: [] });
    expect(attackBrushBodyScale(undefined)).toBe(1);
    for (const brush of ["bristle", "dry", "spark", "echo"] as const) {
      const first = attackTextureMarks({ ...stroke, brush });
      const second = attackTextureMarks({ ...stroke, brush });
      expect(first).toEqual(second);
      expect(first.lines.length + first.dots.length).toBeGreaterThan(0);
      expect(attackBrushBodyScale(brush)).toBeLessThan(1);
    }
    expect(attackTextureMarks({ ...stroke, brush: "spark" }).dots.length).toBeGreaterThan(0);
    expect(attackTextureMarks({ ...stroke, brush: "bristle" }).lines).toHaveLength(4);
  });
});
