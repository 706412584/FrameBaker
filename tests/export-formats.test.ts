import { describe, expect, test } from "bun:test";
import {
  buildGodotImportReadme,
  buildGodotSpriteFramesTres,
  buildTexturePackerAtlas,
} from "../apps/web/src/exportFormats";

describe("buildTexturePackerAtlas", () => {
  test("已知输入：trim 字段正确映射到 atlas frame", () => {
    const atlas = buildTexturePackerAtlas(
      [
        {
          filename: "hero_000.png",
          sheet: { x: 64, y: 128 },
          cell: { w: 32, h: 32 },
          trimmed: { x: 2, y: 4, w: 10, h: 8 },
          duration: 2,
        },
      ],
      "hero.png",
      8,
      { width: 256, height: 256 }
    );
    const frame = atlas.frames["hero_000.png"];
    expect(frame.frame).toEqual({ x: 66, y: 132, w: 10, h: 8 });
    expect(frame.spriteSourceSize).toEqual({ x: 2, y: 4, w: 10, h: 8 });
    expect(frame.sourceSize).toEqual({ w: 32, h: 32 });
    expect(frame.trimmed).toBe(true);
    expect(frame.rotated).toBe(false);
    expect(frame.duration).toBe(2);
    expect(atlas.meta).toEqual({
      app: "FrameBaker",
      version: "1.0",
      image: "hero.png",
      format: "RGBA8888",
      size: { w: 256, h: 256 },
      scale: "1",
      fps: 8,
    });
  });

  test("整格透明（trim=null）：frame 覆盖整 cell，trimmed=false", () => {
    const atlas = buildTexturePackerAtlas(
      [{ filename: "empty_001.png", sheet: { x: 0, y: 32 }, cell: { w: 32, h: 32 }, trimmed: null, duration: 1 }],
      "hero.png",
      8,
      { width: 128, height: 128 }
    );
    const frame = atlas.frames["empty_001.png"];
    expect(frame.frame).toEqual({ x: 0, y: 32, w: 32, h: 32 });
    expect(frame.spriteSourceSize).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(frame.trimmed).toBe(false);
  });

  test("trim 与 cell 同大：trimmed=false", () => {
    const atlas = buildTexturePackerAtlas(
      [{ filename: "full_000.png", sheet: { x: 0, y: 0 }, cell: { w: 16, h: 16 }, trimmed: { x: 0, y: 0, w: 16, h: 16 }, duration: 1 }],
      "hero.png",
      8,
      { width: 64, height: 64 }
    );
    expect(atlas.frames["full_000.png"].trimmed).toBe(false);
  });

  test("多帧各得唯一 key", () => {
    const atlas = buildTexturePackerAtlas(
      [0, 1].map((i) => ({
        filename: `f_${String(i).padStart(3, "0")}.png`,
        sheet: { x: i * 32, y: 0 },
        cell: { w: 32, h: 32 },
        trimmed: null,
        duration: 1,
      })),
      "hero.png",
      12,
      { width: 64, height: 32 }
    );
    expect(Object.keys(atlas.frames)).toEqual(["f_000.png", "f_001.png"]);
  });
});

describe("buildGodotSpriteFramesTres", () => {
  test("format=3 头 + ext_resource 数 + speed/duration", () => {
    const tres = buildGodotSpriteFramesTres("run", 8, true, [
      { resPath: "res://hero/hero_000.png", duration: 1 },
      { resPath: "res://hero/hero_001.png", duration: 2 },
    ]);
    expect(tres.startsWith('[gd_resource type="SpriteFrames" load_steps=3 format=3]')).toBe(true);
    expect(tres).toContain('[ext_resource type="Texture2D" path="res://hero/hero_000.png" id="1_0"]');
    expect(tres).toContain('[ext_resource type="Texture2D" path="res://hero/hero_001.png" id="1_1"]');
    expect(tres).toContain('"speed": 8');
    expect(tres).toContain('"duration": 1, "texture": ExtResource("1_0")');
    expect(tres).toContain('"duration": 2, "texture": ExtResource("1_1")');
    expect(tres).toContain('"loop": true');
    expect(tres).toContain('"name": &"run"');
  });

  test("loop=false 与名称转义", () => {
    const tres = buildGodotSpriteFramesTres('we"ird\\name', 6, false, [
      { resPath: "res://a/b.png", duration: 1.5 },
    ]);
    expect(tres).toContain('"loop": false');
    expect(tres).toContain('"name": &"we\\"ird\\\\name"');
    expect(tres).toContain('"duration": 1.5');
  });

  test("fps 保留浮点形式（小数 fps）", () => {
    const tres = buildGodotSpriteFramesTres("run", 7.5, true, [{ resPath: "res://a.png", duration: 1 }]);
    expect(tres).toContain('"speed": 7.5');
  });
});

describe("buildGodotImportReadme", () => {
  test("包含解压与 .tres 说明", () => {
    const md = buildGodotImportReadme("my-hero");
    expect(md).toContain("my-hero");
    expect(md).toContain("SpriteFrames");
    expect(md).toContain("res://assets/my-hero/");
  });
});
