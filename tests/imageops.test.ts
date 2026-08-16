import { describe, expect, test } from "bun:test";
import {
  computeImageAnalysis,
  findSkeletalPartQualityIssues,
  imageAnalysisSimilarity,
  reviewSkeletalGrid,
} from "../apps/web/src/imageops/ops";

function image(width: number, height: number, paint: (set: (x: number, y: number, rgba?: [number, number, number, number]) => void) => void) {
  const data = new Uint8ClampedArray(width * height * 4);
  paint((x, y, rgba = [120, 80, 40, 255]) => {
    const index = (y * width + x) * 4;
    data.set(rgba, index);
  });
  return computeImageAnalysis(data, width, height);
}

const block = (x0: number, y0: number, w: number, h: number) => image(16, 16, (set) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y);
});

describe("骨骼分件图像质量检查", () => {
  test("自定义网格跳过透明余格，标准人形网格仍把空格视为缺件", () => {
    const valid = block(4, 4, 5, 5);
    const empty = image(16, 16, () => {});
    expect(reviewSkeletalGrid([valid, empty], false)).toEqual({ activeIndexes: [0], issues: [] });
    expect(reviewSkeletalGrid([valid, empty], true)).toEqual({
      activeIndexes: [0, 1],
      issues: [{ code: "empty", cells: [2] }],
    });
    expect(reviewSkeletalGrid([valid, empty], true, [1])).toEqual({ activeIndexes: [0], issues: [] });
    expect(reviewSkeletalGrid([empty, empty], false)).toEqual({
      activeIndexes: [],
      issues: [{ code: "empty", cells: [1] }],
    });
  });

  test("提取透明边和显著连通主体", () => {
    const analysis = image(12, 10, (set) => {
      for (let y = 2; y <= 6; y++) for (let x = 3; x <= 7; x++) set(x, y);
      set(10, 8);
    });
    expect(analysis.bounds).toEqual({ x: 3, y: 2, w: 8, h: 7 });
    expect(analysis.significantComponents).toBe(1);
    expect(analysis.opaqueRatio).toBeCloseTo(26 / 120);
  });

  test("质量检查忽略擦除后几乎不可见的低透明度边缘", () => {
    const analysis = image(16, 16, (set) => {
      for (let y = 3; y < 13; y++) for (let x = 4; x < 10; x++) set(x, y);
      set(0, 8, [120, 80, 40, 4]);
    });
    expect(analysis.bounds).toEqual({ x: 4, y: 3, w: 6, h: 10 });
    expect(findSkeletalPartQualityIssues([analysis])).not.toContainEqual({ code: "touches-edge", cells: [1] });
  });

  test("识别完全重复和镜像复制的部件", () => {
    const original = image(16, 16, (set) => {
      for (let y = 3; y < 13; y++) for (let x = 4; x < 8; x++) set(x, y);
      set(7, 3, [220, 20, 20, 255]);
    });
    const duplicate = image(24, 24, (set) => {
      for (let y = 4; y < 19; y++) for (let x = 6; x < 12; x++) set(x, y);
      set(11, 4, [220, 20, 20, 255]);
    });
    const mirrored = image(16, 16, (set) => {
      for (let y = 3; y < 13; y++) for (let x = 8; x < 12; x++) set(x, y);
      set(8, 3, [220, 20, 20, 255]);
    });
    expect(imageAnalysisSimilarity(original, duplicate)).toBeGreaterThan(.97);
    expect(imageAnalysisSimilarity(original, mirrored, true)).toBeGreaterThan(.99);
  });

  test("硬性拒绝空格、贴边、多主体和重复分件", () => {
    const valid = block(4, 3, 5, 9);
    const empty = image(16, 16, () => undefined);
    const touching = block(0, 3, 5, 8);
    const fragmented = image(16, 16, (set) => {
      for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) set(x, y);
      for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) set(x, y);
    });
    const issues = findSkeletalPartQualityIssues([valid, empty, touching, fragmented, valid]);
    expect(issues).toContainEqual({ code: "empty", cells: [2] });
    expect(issues).toContainEqual({ code: "touches-edge", cells: [3] });
    expect(issues).toContainEqual({ code: "fragmented", cells: [4] });
    expect(issues).toContainEqual({ code: "duplicate", cells: [1, 5] });
  });

  test("左右对应肢体使用更敏感的重复阈值", () => {
    const cells = Array.from({ length: 12 }, (_, index) => block(3 + index % 3, 2, 5, 10));
    const leftUpperArm = image(16, 16, (set) => {
      for (let y = 2; y < 13; y++) for (let x = 4; x < 9; x++) set(x, y);
    });
    const reusedRightUpperArm = image(16, 16, (set) => {
      for (let y = 2; y < 13; y++) for (let x = 4; x < 9; x++) set(x, y, [124, 84, 44, 255]);
    });
    cells[4] = leftUpperArm;
    cells[6] = reusedRightUpperArm;
    expect(findSkeletalPartQualityIssues(cells)).toContainEqual({ code: "duplicate", cells: [5, 7] });
    expect(findSkeletalPartQualityIssues(cells, false)).not.toContainEqual({ code: "duplicate", cells: [5, 7] });
  });
});
