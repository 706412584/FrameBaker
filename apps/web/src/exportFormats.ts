// 游戏引擎导出格式的纯函数构建器（无 DOM 依赖，可被 bun test 直接测试）。
// 两个格式：
//  1. TexturePacker JSON Hash —— Phaser 3 / PixiJS / Cocos 通用 atlas
//  2. Godot 4 SpriteFrames .tres —— AnimatedSprite2D 直接可用
import { safeFilename } from "./safeFilename";

export interface AtlasFrameInput {
  /** 帧文件名（PNG 序列里的名字） */
  filename: string;
  /** 该帧 cell 在大图的起点 */
  sheet: { x: number; y: number };
  /** 未裁切 cell 尺寸 */
  cell: { w: number; h: number };
  /** cell 内不透明范围；null = 整格透明（不裁切） */
  trimmed: { x: number; y: number; w: number; h: number } | null;
  /** 该步骤时长（fps tick 倍数，与 frames.json duration 同语义） */
  duration: number;
}

export interface TexturePackerAtlasJson {
  frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated: boolean;
      trimmed: boolean;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
      duration: number;
    }
  >;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
    fps: number;
  };
}

/**
 * TexturePacker JSON Hash：布局沿用 spritesheet 的统一网格（cell 间保留透明边，
 * 保证动画帧共享原点不抖动），但每帧额外声明 cell 内的不透明矩形（trimmed），
 * 引擎按 spriteSourceSize/sourceSize 还原对齐。duration 为自定义扩展字段，
 * Phaser/Pixi/Cocos 的 atlas 解析器会忽略未知键。
 */
export function buildTexturePackerAtlas(
  frames: AtlasFrameInput[],
  image: string,
  fps: number,
  sheetSize: { width: number; height: number }
): TexturePackerAtlasJson {
  const out: TexturePackerAtlasJson = {
    frames: {},
    meta: {
      app: "FrameBaker",
      version: "1.0",
      image,
      format: "RGBA8888",
      size: { w: sheetSize.width, h: sheetSize.height },
      scale: "1",
      fps,
    },
  };
  for (const f of frames) {
    const trim = f.trimmed;
    const w = trim?.w ?? f.cell.w;
    const h = trim?.h ?? f.cell.h;
    const trimmed = trim !== null && (trim.w * trim.h < f.cell.w * f.cell.h);
    out.frames[f.filename] = {
      frame: { x: f.sheet.x + (trim?.x ?? 0), y: f.sheet.y + (trim?.y ?? 0), w, h },
      rotated: false,
      trimmed,
      spriteSourceSize: { x: trim?.x ?? 0, y: trim?.y ?? 0, w, h },
      sourceSize: { w: f.cell.w, h: f.cell.h },
      duration: f.duration,
    };
  }
  return out;
}

export interface GodotFrameInput {
  /** res:// 路径（正斜杠） */
  resPath: string;
  duration: number;
}

function escapeTresString(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

/** Godot 数值文本：保证浮点形式（1 而非 1.0 的字段 Godot 可解析，但 1.0 更稳） */
function tresNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "1.0";
}

/**
 * Godot 4 SpriteFrames 资源文本（format=3）。
 * 帧时长换算依据 Godot 4 官方公式 absolute_duration = duration / (speed × playing_speed)：
 * speed = 项目 fps、duration = 步骤时长 tick 数，语义零失真。
 */
export function buildGodotSpriteFramesTres(
  animationName: string,
  fps: number,
  loop: boolean,
  frames: GodotFrameInput[]
): string {
  const extResources = frames.map((f, i) => {
    const id = `1_${i.toString(16)}`;
    return `[ext_resource type="Texture2D" path="${escapeTresString(f.resPath)}" id="${id}"]`;
  });
  const frameEntries = frames.map((f, i) =>
    `{"duration": ${tresNumber(f.duration)}, "texture": ExtResource("1_${i.toString(16)}")}`
  );
  const animations = `{
"frames": [${frameEntries.join(", ")}],
"loop": ${loop ? "true" : "false"},
"name": &"${escapeTresString(animationName)}",
"speed": ${tresNumber(fps)}
  }`;
  return `[gd_resource type="SpriteFrames" load_steps=${frames.length + 1} format=3]

${extResources.join("\n")}

[resource]
animations = [${animations}]
`;
}

/** Godot 导入说明（放 zip 内） */
export function buildGodotImportReadme(name: string): string {
  return `# ${safeFilename(name)} — Godot 4 导入说明

1. 把本压缩包内的全部文件解压到你的 Godot 项目目录，例如 \`res://assets/${safeFilename(name)}/\`。
2. \`${safeFilename(name)}.tres\` 是 SpriteFrames 资源：在 AnimatedSprite2D 的 Sprite Frames 属性中选择它即可播放。
3. 帧时长换算：每帧显示时长 = duration ÷ (speed × fps)。本资源 speed 已设为导出时的项目 fps，duration 为帧时长倍数，与 FrameBaker 预览一致。
4. 循环默认开启，可在 Godot 编辑器中修改。
`;
}
