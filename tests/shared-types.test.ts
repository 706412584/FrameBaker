import { describe, expect, test } from "bun:test";
import {
  buildActionSheetPrompt,
  buildActionVideoPrompt,
  buildCharacterDirectionSheetPrompt,
  CHARACTER_DIRECTION_PRESETS,
  isLikelyImageOnlyModel,
  normalizeDashscopeBaseUrl,
  parseSizePreview,
  pickPreferredVideoModel,
  suggestActionSheetGrid,
} from "../packages/shared/src";

describe("生成尺寸与 provider 规则", () => {
  test("解析比例、像素尺寸、清晰度档位与未知值", () => {
    expect(parseSizePreview(" 16 : 9 ")).toEqual({ w: 16, h: 9, label: "16 : 9" });
    expect(parseSizePreview("1328*1328")).toEqual({ w: 1328, h: 1328, label: "1328×1328" });
    expect(parseSizePreview("2k")).toEqual({ w: 2048, h: 2048, label: "2K ≈2048²" });
    expect(parseSizePreview("720P")).toEqual({ w: 1280, h: 720, label: "720P" });
    expect(parseSizePreview("")).toEqual({ w: 1, h: 1, label: "default" });
    expect(parseSizePreview("custom")).toEqual({ w: 1, h: 1, label: "custom" });
  });

  test("标准化 DashScope 根地址，不影响普通地址", () => {
    expect(normalizeDashscopeBaseUrl(" https://example.com/compatible-mode/v1/ ")).toBe("https://example.com");
    expect(normalizeDashscopeBaseUrl("https://example.com/api/v1")).toBe("https://example.com");
    expect(normalizeDashscopeBaseUrl("https://example.com/custom/")).toBe("https://example.com/custom");
  });

  test("视频模型选择排除图像模型，并按引用图与 t2v 优先级选择", () => {
    expect(isLikelyImageOnlyModel("wan2.7-image-pro")).toBe(true);
    expect(isLikelyImageOnlyModel("qwen-image-edit")).toBe(true);
    expect(isLikelyImageOnlyModel("wan2.7-i2v")).toBe(false);
    expect(pickPreferredVideoModel(["image-01", "model-t2v", "model-i2v"], { preferI2v: true })).toBe("model-i2v");
    expect(pickPreferredVideoModel(["image-01", "model-t2v", "model-i2v"])).toBe("model-t2v");
    expect(pickPreferredVideoModel(["qwen-image", "hailuo-2.3"])).toBe("hailuo-2.3");
    expect(pickPreferredVideoModel(["image-01"])).toBe("image-01");
    expect(pickPreferredVideoModel([])).toBe("");
  });
});

describe("动作生成 prompt", () => {
  test("帧数推荐网格会限制输入范围", () => {
    expect(suggestActionSheetGrid(-2)).toEqual({ cols: 1, rows: 1 });
    expect(suggestActionSheetGrid(4)).toEqual({ cols: 4, rows: 1 });
    expect(suggestActionSheetGrid(5)).toEqual({ cols: 3, rows: 2 });
    expect(suggestActionSheetGrid(99)).toEqual({ cols: 4, rows: 2 });
  });

  test("同动作拼图保留循环语义、截断多余帧并说明空格", () => {
    const prompt = buildActionSheetPrompt({
      frames: [
        { id: "idle", label: "待机", prompt: "idle breathing" },
        { id: "idle", label: "待机", prompt: "idle breathing" },
        { id: "idle", label: "待机", prompt: "idle breathing" },
      ],
      cols: 2,
      rows: 2,
      characterPrompt: "hero",
    });

    expect(prompt).toContain("2×2 sprite sheet: 3-frame continuous idle breathing cycle");
    expect(prompt).toContain("last loops to first");
    expect(prompt).toContain("Blank last 1 panel(s).");
    expect(prompt).toContain("Char: hero");
  });

  test("多动作与视频 prompt 的兜底和长度限制正确", () => {
    const sheet = buildActionSheetPrompt({
      frames: [{ id: "walk", label: "走", prompt: "walk cycle" }],
      cols: 1,
      rows: 1,
      extra: "x".repeat(2_000),
    });
    expect(sheet).toContain("1:walk/walk cycle");
    expect(sheet.length).toBeLessThanOrEqual(1400);

    expect(buildActionVideoPrompt({ actions: [] })).toBe("Pixel art game character idle loop. Plain bg, no text.");
    const video = buildActionVideoPrompt({
      actions: [{ id: "run", label: "跑", prompt: "run cycle" }],
      characterPrompt: "runner",
      extra: "fast",
    });
    expect(video).toContain("continuous run cycle loop");
    expect(video).toContain("Char: runner");
    expect(video).toContain("fast");
  });

  test("角色 8 向图使用中心留空的 3×3 环形布局并锁定角色一致性", () => {
    const prompt = buildCharacterDirectionSheetPrompt({ characterPrompt: "red knight", extra: "pixel art" });
    expect(CHARACTER_DIRECTION_PRESETS.map((direction) => direction.id)).toEqual([
      "back-left",
      "back",
      "back-right",
      "left",
      "right",
      "front-left",
      "front",
      "front-right",
    ]);
    expect(prompt).toContain("arranged as 3 columns × 3 rows");
    expect(prompt).toContain("middle row left, EMPTY, right");
    expect(prompt).toContain("Rotate only the character around the vertical axis");
    expect(prompt).toContain("bottom row front-left, front, front-right");
    expect(prompt).toContain("Appearance only (ignore pose, view and composition in this description): red knight");
    expect(prompt).toContain("pixel art");
    expect(prompt.length).toBeLessThanOrEqual(1400);
  });
});
