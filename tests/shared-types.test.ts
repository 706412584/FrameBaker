import { describe, expect, test } from "bun:test";
import {
  ARTICULATED_CHARACTER_PART_ROLES,
  buildArticulatedCharacterPrompt,
  buildArticulatedPartsPrompt,
  ACTION_PRESETS,
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
  test("动作预设默认根据当前角色形象决定具体表现", () => {
    expect(Object.fromEntries(ACTION_PRESETS.map((action) => [action.id, action.prompt]))).toEqual({
      idle: "idle fitting the character",
      walk: "walk fitting the character",
      run: "run fitting the character",
      jump: "jump fitting the character",
      attack: "attack fitting the character and equipment",
      cast: "cast fitting the character and abilities",
      hurt: "hit reaction fitting the character",
      death: "defeat fitting the character",
    });
  });

  test("帧数推荐网格会限制输入范围", () => {
    expect(suggestActionSheetGrid(-2)).toEqual({ cols: 1, rows: 1 });
    expect(suggestActionSheetGrid(4)).toEqual({ cols: 4, rows: 1 });
    expect(suggestActionSheetGrid(5)).toEqual({ cols: 3, rows: 2 });
    expect(suggestActionSheetGrid(99)).toEqual({ cols: 4, rows: 4 });
  });

  test("同动作拼图保留循环语义、截断多余帧并说明空格", () => {
    const prompt = buildActionSheetPrompt({
      frames: [
        { id: "idle", label: "待机", prompt: "idle fitting the character" },
        { id: "idle", label: "待机", prompt: "idle fitting the character" },
        { id: "idle", label: "待机", prompt: "idle fitting the character" },
      ],
      cols: 2,
      rows: 2,
      characterPrompt: "hero",
    });

    expect(prompt).toContain("2×2 sprite sheet: 3-frame continuous idle fitting the character cycle");
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
    expect(sheet).toContain("x".repeat(500));
    expect(sheet.length).toBeLessThanOrEqual(1400);

    expect(buildActionVideoPrompt({ actions: [] })).toBe("Pixel art game character idle loop. Plain bg, no text.");
    const video = buildActionVideoPrompt({
      actions: [{ id: "run", label: "跑", prompt: "run cycle" }],
      characterPrompt: "runner",
      extra: "fast",
    });
    expect(video).toContain("continuous run cycle loop");
    expect(video).toContain("about 15% empty safe margin on every edge");
    expect(video).toContain("never crop any body part");
    expect(video).toContain("Char: runner");
    expect(video).toContain("fast");
    expect(buildActionVideoPrompt({
      actions: [{ id: "run", label: "跑", prompt: "run cycle" }],
      extra: "x".repeat(1_000),
    })).toContain("x".repeat(500));
  });
});

describe("完整人物到 12 分件的两阶段 prompt", () => {
  test("第一阶段只生成比例可信且无遮挡的完整人物", () => {
    const prompt = buildArticulatedCharacterPrompt({ description: "red cape ranger" });
    expect(prompt).toContain("one complete full-body");
    expect(prompt).toContain("front-facing T-pose");
    expect(prompt).toContain("head-to-body");
    expect(prompt).toContain("all elbow and knee joints");
    expect(prompt).toContain("both hands empty");
    expect(prompt).toContain("separate isolated prop");
    expect(prompt).toContain("one head-width of clear space");
    expect(prompt).toContain("No parts sheet");
    expect(prompt).toContain("Character description: red cape ranger");
  });

  test("第二阶段固定为 4×3 顺序并严格继承完整人物比例", () => {
    expect(ARTICULATED_CHARACTER_PART_ROLES).toHaveLength(12);
    expect(ARTICULATED_CHARACTER_PART_ROLES.slice(0, 4)).toEqual(["head", "torso", "pelvis", "weapon"]);
    const prompt = buildArticulatedPartsPrompt({ reference: true, extra: "red cape" });
    expect(prompt).toContain("single source of truth");
    expect(prompt).toContain("exact head-to-body ratio");
    expect(prompt).toContain("never redesign or independently rescale");
    expect(prompt).toContain("Use up to 12 slots");
    expect(prompt).toContain("4 columns by 3 rows");
    expect(prompt).toContain("left upper arm, left forearm");
    expect(prompt).toContain("left thigh, left shin");
    expect(prompt).toContain("the reference weapon or an empty slot");
    expect(prompt).toContain("Never invent a weapon");
    expect(prompt).toContain("hip-sockets only");
    expect(prompt).toContain("Weapon must not touch an arm");
    expect(prompt).toContain("regular 4 × 3 lattice of identical cells");
    expect(prompt).toContain("one global scale factor");
    expect(prompt).toContain("opaque bounds centered");
    expect(prompt).toContain("at least 10% clear padding");
    expect(prompt).toContain("Transparent background only; never black, dark, checked, or textured");
    expect(prompt).toContain("no variable gaps, packed/staggered layout");
    expect(prompt).toContain("shrink all parts uniformly");
    expect(prompt).toContain("contiguous rectangular 2+ cell block");
    expect(prompt).toContain("keep covered cells empty");
    expect(prompt).toContain("Extra requirements: red cape");
    expect(prompt.length).toBeLessThanOrEqual(1490);
  });

  test("传入骨架部件描述时改为骨骼驱动：按语义逐格生成且不套用人形固定槽位", () => {
    const descriptors = ["head with helmet", "torso", "left upper arm", "left forearm with hand"];
    const prompt = buildArticulatedPartsPrompt({ reference: true, rows: 3, cols: 4, partDescriptors: descriptors });
    expect(prompt).toContain("Generate exactly 4 distinct parts matching the target skeleton bone segments");
    expect(prompt).toContain("1. head with helmet");
    expect(prompt).toContain("4. left forearm with hand");
    expect(prompt).toContain("leave every remaining cell fully transparent");
    expect(prompt).toContain("Split at real joints");
    expect(prompt).not.toContain("Use up to 12 slots");
    expect(prompt).not.toContain("row 1 head, torso, pelvis");
    expect(prompt.length).toBeLessThanOrEqual(1490);
  });

  test("空的骨架部件描述退回原有网格驱动行为", () => {
    const prompt = buildArticulatedPartsPrompt({ reference: true, partDescriptors: [] });
    expect(prompt).toContain("Use up to 12 slots");
    expect(prompt).toContain("4 columns by 3 rows");
  });

  test("自定义行列数只决定容量，多余格允许留空且不套用固定人形槽位", () => {
    const prompt = buildArticulatedPartsPrompt({ reference: true, rows: 3, cols: 5, extra: "include a tail and two shoulder plates" });
    expect(prompt).toContain("Use up to 15 slots");
    expect(prompt).toContain("5 columns by 3 rows");
    expect(prompt).toContain("Split at real joints");
    expect(prompt).toContain("leave every surplus cell fully transparent");
    expect(prompt).toContain("Never invent filler parts");
    expect(prompt).toContain("every unused cell must be fully empty");
    expect(prompt).toContain("regular 5 × 3 lattice of identical cells");
    expect(prompt).toContain("Identical center spacing and row/column pitch");
    expect(prompt).toContain("rectangular 2+ cell block");
    expect(prompt).not.toContain("row 1 = head, torso, pelvis");
    expect(prompt).toContain("Extra requirements: include a tail and two shoulder plates");
    expect(prompt.length).toBeLessThanOrEqual(1490);
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
    expect(prompt).toContain("all eight distinct 45-degree body headings exactly once");
    expect(prompt).toContain("center EMPTY");
    expect(prompt).toContain("Rotate the entire character around the vertical axis—not only the head or eyes");
    expect(prompt).toContain("bottom-center FRONT (face/chest toward viewer)");
    expect(prompt).toContain("Do not fill all cells with the reference orientation");
    expect(prompt).toContain("Appearance only (ignore pose, view and composition in this description): red knight");
    expect(prompt).toContain("pixel art");
    expect(prompt.length).toBeLessThanOrEqual(1400);
  });
});
