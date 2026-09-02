// 引擎 manifest 生成器 — 移植自 sprite sprite_lab/export_formats.py（输出逐字对齐）。
// 全部为纯字符串生成，无外部依赖。
export interface FramePosition {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FormatData {
  frames: FramePosition[];
  sheet_width: number;
  sheet_height: number;
  sheet_image: string;
  fps: number;
}

export const VALID_MANIFEST_FORMATS = [
  "phaser_hash",
  "phaser_array",
  "sparrow_xml",
  "cocos_plist",
  "godot_tres",
  "sprite2d_xml",
] as const;
export type ManifestFormat = (typeof VALID_MANIFEST_FORMATS)[number];

// ---- Phaser ----

function phaserMeta(data: FormatData) {
  return {
    app: "Sprite Video Lab",
    version: "1.0",
    image: data.sheet_image,
    format: "RGBA8888",
    size: { w: data.sheet_width, h: data.sheet_height },
    scale: "1",
  };
}

export function generatePhaserHash(data: FormatData): string {
  const frames: Record<string, unknown> = {};
  for (const f of data.frames) {
    frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
      sourceSize: { w: f.w, h: f.h },
    };
  }
  return JSON.stringify({ frames, meta: phaserMeta(data) }, null, 2);
}

export function generatePhaserArray(data: FormatData): string {
  const frames = data.frames.map((f) => ({
    filename: f.name,
    frame: { x: f.x, y: f.y, w: f.w, h: f.h },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
    sourceSize: { w: f.w, h: f.h },
  }));
  return JSON.stringify({ frames, meta: phaserMeta(data) }, null, 2);
}

// ---- Sparrow XML（TexturePacker / Starling / Godot 4）----

export function generateSparrowXml(data: FormatData): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<TextureAtlas imagePath="${data.sheet_image}">`,
  ];
  for (const f of data.frames) {
    lines.push(`  <SubTexture name="${f.name}" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}"/>`);
  }
  lines.push("</TextureAtlas>");
  return lines.join("\n");
}

// ---- Cocos Creator plist ----

export function generateCocosPlist(data: FormatData): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
  lines.push('<plist version="1.0">');
  lines.push("<dict>");
  lines.push("\t<key>frames</key>");
  lines.push("\t<dict>");
  for (const f of data.frames) {
    lines.push(`\t\t<key>${f.name}</key>`);
    lines.push("\t\t<dict>");
    lines.push("\t\t\t<key>frame</key>");
    lines.push(`\t\t\t<string>{{${f.x},${f.y}},{${f.w},${f.h}}}</string>`);
    lines.push("\t\t\t<key>offset</key>");
    lines.push("\t\t\t<string>{0,0}</string>");
    lines.push("\t\t\t<key>rotated</key>");
    lines.push("\t\t\t<false/>");
    lines.push("\t\t\t<key>sourceColorRect</key>");
    lines.push(`\t\t\t<string>{{0,0},{${f.w},${f.h}}}</string>`);
    lines.push("\t\t\t<key>sourceSize</key>");
    lines.push(`\t\t\t<string>{${f.w},${f.h}}</string>`);
    lines.push("\t\t</dict>");
  }
  lines.push("\t</dict>");
  lines.push("\t<key>metadata</key>");
  lines.push("\t<dict>");
  lines.push("\t\t<key>format</key>");
  lines.push("\t\t<integer>2</integer>");
  lines.push("\t\t<key>realTextureFileName</key>");
  lines.push(`\t\t<string>${data.sheet_image}</string>`);
  lines.push("\t\t<key>size</key>");
  lines.push(`\t\t<string>{${data.sheet_width},${data.sheet_height}}</string>`);
  lines.push("\t\t<key>textureFileName</key>");
  lines.push(`\t\t<string>${data.sheet_image}</string>`);
  lines.push("\t</dict>");
  lines.push("</dict>");
  lines.push("</plist>");
  return lines.join("\n") + "\n";
}

// ---- Godot 4 SpriteFrames (.tres) ----

export function generateGodotTres(data: FormatData): string {
  const frames = data.frames;
  const fps = data.fps ?? 10.0;
  const loadSteps = 1 + frames.length;
  const lines: string[] = [];
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${loadSteps} format=3]`);
  lines.push("");
  lines.push(`[ext_resource type="Texture2D" uid="uid://placeholder" path="res://${data.sheet_image}" id="1"]`);
  lines.push("");
  for (let i = 0; i < frames.length; i++) {
    const rid = i + 2;
    lines.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${rid}"]`);
    lines.push(`atlas = ExtResource("1")`);
    // sprite 原版即为 "regect"（拼写如此）—— 对齐原则：逐字保持一致
    lines.push(`regect = Rect2(${frames[i]!.x}, ${frames[i]!.y}, ${frames[i]!.w}, ${frames[i]!.h})`);
    lines.push("");
  }
  lines.push("[resource]");
  lines.push("animations = [{");
  lines.push('"duration": 1.0,');
  lines.push('"frames": [');
  for (let i = 0; i < frames.length; i++) {
    const rid = i + 2;
    const comma = i < frames.length - 1 ? "," : "";
    lines.push(`{"duration": 1.0, "texture": SubResource("AtlasTexture_${rid}")}${comma}`);
  }
  lines.push("],");
  lines.push('"loop": true,');
  lines.push('"name": &"default",');
  lines.push(`"speed": ${fps.toFixed(1)}`);
  lines.push("}]");
  return lines.join("\n") + "\n";
}

// ---- Urho3D Sprite2D XML ----

export function generateSprite2dXml(data: FormatData): string {
  const lines = [
    '<?xml version="1.0"?>',
    "<sprite2d>",
    `  <texture name="${data.sheet_image}"/>`,
  ];
  for (const f of data.frames) {
    lines.push(`  <sprite name="${f.name}" rectangle="${f.x} ${f.y} ${f.w} ${f.h}" hotspot="0.5 0.5"/>`);
  }
  lines.push("</sprite2d>");
  return lines.join("\n");
}

// ---- Registry ----

export const MANIFEST_GENERATORS: Record<ManifestFormat, { filename: string; generate: (data: FormatData) => string }> = {
  phaser_hash: { filename: "phaser_hash.json", generate: generatePhaserHash },
  phaser_array: { filename: "phaser_array.json", generate: generatePhaserArray },
  sparrow_xml: { filename: "sparrow.xml", generate: generateSparrowXml },
  cocos_plist: { filename: "cocos.plist", generate: generateCocosPlist },
  godot_tres: { filename: "sprite_frames.tres", generate: generateGodotTres },
  sprite2d_xml: { filename: "sprite2d.xml", generate: generateSprite2dXml },
};
