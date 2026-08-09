// ===== 枚举常量（前后端唯一事实源）=====

export const FRAME_STATUSES = ["pending", "extracting", "matting", "ready", "error"] as const;
export type FrameStatus = (typeof FRAME_STATUSES)[number];

export const FRAME_SOURCES = [
  "cli",
  "api",
  "dashscope",
  "gemini",
  "minimax",
  "upload",
  "gif",
  "mp4",
  "image",
  "extract",
  "duplicate",
  "raster",
] as const;
export type FrameSource = (typeof FRAME_SOURCES)[number];

export const JOB_TYPES = ["extract_frames", "generate_frames", "matting"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "done", "error", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const MATERIAL_STATUSES = ["raw", "matted"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

export const FOLDER_KINDS = ["material", "project", "animation"] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

export const PROJECT_KINDS = ["frame", "skeletal"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/** 新建可动角色的标准 4×3 分件顺序（从左到右、从上到下）。 */
export const ARTICULATED_CHARACTER_PART_ROLES = [
  "head",
  "torso",
  "pelvis",
  "weapon",
  "upper-arm-left",
  "forearm-left",
  "upper-arm-right",
  "forearm-right",
  "thigh-left",
  "shin-left",
  "thigh-right",
  "shin-right",
] as const;
export type ArticulatedCharacterPartRole = (typeof ARTICULATED_CHARACTER_PART_ROLES)[number];

/** 整臂/整腿角色仅用于读取已有项目；新流程必须使用上面的真实关节分件。 */
export const LEGACY_CHARACTER_PART_ROLES = ["arm-left", "arm-right", "leg-left", "leg-right"] as const;
export const CHARACTER_PART_ROLES = [
  ...ARTICULATED_CHARACTER_PART_ROLES,
  ...LEGACY_CHARACTER_PART_ROLES,
  "accessory",
  "custom",
] as const;
export type CharacterPartRole = (typeof CHARACTER_PART_ROLES)[number];
export const CHARACTER_PART_SET_SOURCES = ["manual", "generated", "decomposed"] as const;
export type CharacterPartSetSource = (typeof CHARACTER_PART_SET_SOURCES)[number];
export interface CharacterPartSetMember { materialId: string; role: CharacterPartRole; name: string }
export interface CharacterPartSet {
  id: string;
  name: string;
  source: CharacterPartSetSource;
  referenceMaterialId: string | null;
  members: CharacterPartSetMember[];
  created_at: number;
  updated_at: number;
}
export interface CharacterPartSetsResponse { characterPartSets: CharacterPartSet[] }
export interface CharacterPartSetResponse { characterPartSet: CharacterPartSet }

/** 先生成一张比例可信、无遮挡的完整角色设计图，作为后续分件唯一事实源。 */
export function buildArticulatedCharacterPrompt(options: { description?: string; extra?: string }): string {
  const description = options.description?.trim() ? ` Character description: ${options.description.trim()}.` : "";
  const extra = options.extra?.trim() ? ` Extra requirements: ${options.extra.trim()}.` : "";
  return `Create one complete full-body pixel-art game character as the canonical design reference for skeletal animation. Show exactly one assembled character from head to feet in a neutral front-facing T-pose, centered and fully visible, with natural anatomy and deliberate head-to-body, torso-to-leg, and arm-to-leg proportions. Keep both hands empty. If the design includes a weapon, show it as one separate isolated prop beside the character with at least one head-width of clear space. Keep both arms, both legs, all elbow and knee joints clearly visible and separated; do not cross limbs or let the torso, cape, skirt, long hair, or weapon cover any joint. Preserve a coherent outfit, lighting, pixel density, facing direction, and silhouette across the whole body. Use a transparent or plain high-contrast background with generous empty margin. No parts sheet, no separated body pieces, no alternate poses, no text, no labels, and no extra characters.${description}${extra}`;
}

/** 用完整角色参考图构造真实可动的 12 分件表提示词；无引用模式仅保留旧调用兼容。 */
export function buildArticulatedPartsPrompt(options: { description?: string; reference?: boolean; extra?: string }): string {
  const introduction = options.reference
    ? "Use the complete assembled character in the reference image as the single source of truth and decompose that exact character into a modular pixel-art skeletal animation parts sheet. Preserve character identity, outfit, colors, pixel density, lighting, facing direction, and especially the reference character's exact head-to-body ratio, limb lengths, torso width, and overall proportions. Do not redesign, shorten, stretch, or independently rescale any body part."
    : "Create a modular pixel-art skeletal animation parts sheet for the described character, with consistent style, proportions, lighting, and facing direction across every part.";
  const layout = "Output exactly 12 isolated pieces in a strict 4 columns by 3 rows layout, ordered left-to-right and top-to-bottom: row 1 = head, torso, pelvis, separate weapon; row 2 = left upper arm, left forearm, right upper arm, right forearm; row 3 = left thigh, left shin, right thigh, right shin.";
  const separation = "Every piece must be complete, centered inside its own cell, fully separated, and must not touch or cross any cell boundary. The weapon must not touch either arm. Use a transparent background, generous empty spacing, no labels, and no assembled character.";
  const joints = "The pelvis cell must contain only the waist-and-hip piece: it stops at the hip sockets and contains no upper-leg or thigh segment, and it is never a shoulder pad. Each upper-arm cell ends at the elbow and contains no forearm or hand. Each forearm cell runs from elbow to wrist and contains exactly one hand, so the entire sheet shows exactly two hands total and no hand appears in any other cell. Each thigh ends at the knee with no shin or foot; each shin runs from knee to foot. Keep every limb segment oriented top-to-bottom with its proximal joint at the top and a small matching overlap at each joint.";
  const uniqueness = "Do not duplicate, mirror-copy, or reuse one arm or leg as its opposite-side part. Left and right pieces must each be derived once from the corresponding side of the reference character. Before output, verify all 12 cell meanings, exactly two hands, one pelvis, one weapon, no repeated limb, and no whole arm or whole leg.";
  const description = options.description?.trim() ? ` Character description: ${options.description.trim()}.` : "";
  const extra = options.extra?.trim() ? ` Extra requirements: ${options.extra.trim()}.` : "";
  return `${introduction} ${layout} ${separation} ${joints} ${uniqueness}${description}${extra}`;
}

export const GENERATION_INTENTS = ["frame-image", "frame-sheet", "frame-video", "skeletal-character", "skeletal-parts", "skeletal-decompose", "skeletal-repair-part", "motion-clip"] as const;
export type GenerationIntent = (typeof GENERATION_INTENTS)[number];

/** 抠图引擎（服务端启动时探测一次，解析顺序 a→d） */
export const MATTING_ENGINES = ["custom-cli", "rembg-bundled", "rembg-path", "none"] as const;
export type MattingEngine = (typeof MATTING_ENGINES)[number];

/** rembg 常用模型（设置页 datalist 建议项，仍可自由输入任意模型名） */
export const REMBG_MODELS = [
  "u2net",
  "u2netp",
  "u2net_human_seg",
  "isnet-general-use",
  "isnet-anime",
  "birefnet-general",
  "birefnet-portrait",
] as const;

/** 生成 provider 类型：CLI 模板 / OpenAI 兼容 API / 百炼 DashScope 原生 / Gemini（banana）/ MiniMax */
export const GEN_PROVIDER_TYPES = ["cli", "api", "dashscope", "gemini", "minimax"] as const;
export type GenProviderType = (typeof GEN_PROVIDER_TYPES)[number];

/**
 * 一个生成 provider（存 settings 表 key=genProviders 的数组元素）。
 * CLI / OpenAI 兼容 / DashScope 原生 / Gemini / MiniMax 可配置多个共存；生成时按 id 选择，模型在生成时单独指定。
 * CLI 为结构化字段（免手写 {占位符} 模板）：参数名留空表示对应值作位置参数传入
 */
export interface GenProvider {
  id: string;
  name: string;
  type: GenProviderType;
  /** type=cli：可执行命令（PATH 名或绝对路径） */
  cliBin: string;
  /** type=cli：prompt 参数名（如 --prompt；留空 = 位置参数） */
  cliPromptArg: string;
  /** type=cli：输出文件参数名（如 -o / --output；留空 = 位置参数，跟在 prompt 后） */
  cliOutputArg: string;
  /** type=cli：模型参数名（如 --model；留空则不下发模型） */
  cliModelArg: string;
  /** type=cli：引用图参数名（如 --ref；留空则该 CLI 不支持引用图，选了引用图创建任务时 400） */
  cliReferenceArg: string;
  /** type=cli：追加的固定参数（按空白切分原样拼接，可空） */
  cliExtraArgs: string;
  /** type=cli：遗留命令模板（env FRAMEBAKER_GEN_CLI 兜底及旧数据兼容；设置页不再暴露） */
  legacyTemplate?: string;
  /** type=api：OpenAI 兼容 baseUrl；type=dashscope：DashScope 原生 baseUrl（可含工作区子域） */
  apiBaseUrl: string;
  apiKey: string;
  /** 按能力分类的模型列表（新配置唯一写入字段） */
  imageModels: string[];
  videoModels: string[];
  textModels: string[];
  imageSize: string;
  videoSize: string;
  /** @deprecated 仅用于读取旧配置 */
  apiModels?: string[];
  /** @deprecated 仅用于读取旧配置 */
  apiSize?: string;
}

/** 提示词加强模型（存 settings 表 key=promptEnhancers 的数组元素；OpenAI 兼容 chat/completions） */
export interface PromptEnhancer {
  id: string;
  name: string;
  providerId: string;
  model: string;
  /** @deprecated 旧配置独立凭证兼容 */
  apiBaseUrl?: string;
  /** @deprecated 旧配置独立凭证兼容 */
  apiKey?: string;
  /** @deprecated 旧配置独立模型兼容 */
  apiModel?: string;
}

/**
 * 生成尺寸预设（生成弹窗下拉；空串 = 用 provider 设置页配的 apiSize 默认）。
 * 各厂商尺寸格式不同，按 provider 类型分档；CLI 无尺寸概念不下发
 */
export const GEN_SIZE_PRESETS: Record<Exclude<GenProviderType, "cli">, Array<{ value: string; label: string }>> = {
  api: [
    { value: "", label: "size.default" },
    { value: "1024x1024", label: "size.1024x1024" },
    { value: "1536x1024", label: "size.1536x1024" },
    { value: "1024x1536", label: "size.1024x1536" },
  ],
  dashscope: [
    { value: "", label: "size.default" },
    { value: "2K", label: "size.2k_wan" },
    { value: "1K", label: "size.1k" },
    { value: "4K", label: "size.4k_pro" },
    { value: "1328*1328", label: "size.1328x1328" },
    { value: "1664*928", label: "size.1664x928" },
    { value: "928*1664", label: "size.928x1664" },
  ],
  gemini: [
    { value: "", label: "size.default" },
    { value: "1:1", label: "size.1_1" },
    { value: "3:2", label: "size.3_2" },
    { value: "2:3", label: "size.2_3" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
  ],
  minimax: [
    { value: "", label: "size.default" },
    { value: "1:1", label: "size.1_1" },
    { value: "3:2", label: "size.3_2" },
    { value: "2:3", label: "size.2_3" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
  ],
};

/** 视频生成尺寸/比例预设（与图片档位分开；透传给各家 video API） */
export const GEN_VIDEO_SIZE_PRESETS: Record<Exclude<GenProviderType, "cli">, Array<{ value: string; label: string }>> = {
  api: [
    { value: "", label: "size.default" },
    { value: "1280*720", label: "size.1280x720" },
    { value: "1920*1080", label: "size.1920x1080" },
  ],
  dashscope: [
    { value: "", label: "size.default" },
    { value: "720P", label: "size.720p" },
    { value: "1080P", label: "size.1080p" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
    { value: "1:1", label: "size.1_1" },
  ],
  gemini: [
    { value: "", label: "size.default" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
    { value: "1:1", label: "size.1_1" },
  ],
  minimax: [
    { value: "", label: "size.default" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
    { value: "1:1", label: "size.1_1" },
    { value: "1080P", label: "size.1080p" },
    { value: "768P", label: "size.768p" },
  ],
};

/**
 * 把 size / 比例字符串解析成预览用宽高（逻辑像素），供 UI 比例框示意。
 * 无法识别时回退 1:1。
 */
export function parseSizePreview(size: string): { w: number; h: number; label: string } {
  const s = size.trim();
  if (!s) return { w: 1, h: 1, label: "default" };
  const ratio = /^(\d+)\s*:\s*(\d+)$/.exec(s);
  if (ratio) return { w: Number(ratio[1]), h: Number(ratio[2]), label: s };
  const wh = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(s);
  if (wh) return { w: Number(wh[1]), h: Number(wh[2]), label: `${wh[1]}×${wh[2]}` };
  const up = s.toUpperCase();
  if (up === "1K") return { w: 1024, h: 1024, label: "1K ≈1024²" };
  if (up === "2K") return { w: 2048, h: 2048, label: "2K ≈2048²" };
  if (up === "4K") return { w: 4096, h: 4096, label: "4K ≈4096²" };
  if (up === "480P") return { w: 854, h: 480, label: "480P" };
  if (up === "720P") return { w: 1280, h: 720, label: "720P" };
  if (up === "768P") return { w: 1366, h: 768, label: "768P" };
  if (up === "1080P") return { w: 1920, h: 1080, label: "1080P" };
  return { w: 1, h: 1, label: s };
}

/** GET /api/config 下发的 provider 摘要（不含 apiKey） */
export interface GenProviderInfo {
  id: string;
  name: string;
  type: GenProviderType;
  imageModels: string[];
  videoModels: string[];
  textModels: string[];
  /** 关键字段是否齐备（cli=命令非空；api 系=baseUrl/key 齐全） */
  configured: boolean;
  /** 是否支持视频生成（文生视频 → 逐帧切割）：cli/dashscope/minimax 支持 */
  video: boolean;
  /** 设置页默认尺寸（弹窗空选时预览用；不下发 key） */
  imageSize?: string;
  videoSize?: string;
}

/** 各 provider 类型是否支持视频生成（服务端 /api/config 摘要与前端弹窗过滤共用） */
export const PROVIDER_VIDEO_SUPPORT: Record<GenProviderType, boolean> = {
  cli: true, // 产物按魔数检测：是视频自动逐帧拆帧
  api: false,
  dashscope: true,
  gemini: false,
  minimax: true,
};

/**
 * 百炼 / Token Plan Base URL 归一：
 * 用户常粘贴 OpenAI 兼容地址 `…/compatible-mode/v1`，而生图/视频走原生 `…/api/v1/services/…`。
 * 剥掉尾斜杠、`/compatible-mode/v1`、`/api/v1`，得到 host 根（如 `https://token-plan.cn-beijing.maas.aliyuncs.com`）。
 */
export function normalizeDashscopeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/compatible-mode\/v1$/i, "")
    .replace(/\/api\/v1$/i, "");
}

/** MiniMax image-* / 百炼 wan*-image、qwen-image：明显是文生图，视频模式下应避开 */
export function isLikelyImageOnlyModel(model: string): boolean {
  const m = model.trim();
  if (/^image[-_]?\d/i.test(m)) return true;
  // wan2.7-image / wan2.7-image-pro / qwen-image-*（排除 *-i2v/-t2v/-r2v）
  if (/(^|[-_])image(-|$)/i.test(m) || /qwen-image/i.test(m)) return true;
  return false;
}

/** 视频模式下从模型列表挑首选（跳过图模；优先 t2v，有引用图时优先 i2v） */
export function pickPreferredVideoModel(models: string[], opts?: { preferI2v?: boolean }): string {
  const nonImage = models.filter((m) => !isLikelyImageOnlyModel(m));
  if (opts?.preferI2v) {
    const i2v = nonImage.find((m) => /i2v/i.test(m));
    if (i2v) return i2v;
  }
  const t2v = nonImage.find((m) => /t2v/i.test(m));
  if (t2v) return t2v;
  const preferred = nonImage.find((m) => /hailuo|happyhorse|minimax-h\d|r2v|video/i.test(m));
  return preferred ?? nonImage[0] ?? models[0] ?? "";
}

/** 设置页「抠图」配置（存 settings 表 key=matting，逐字段优先于环境变量）；CLI 为结构化字段（免模板） */
export interface MattingSettings {
  /** 抠图命令（PATH 名或绝对路径；留空走自动探测 rembg） */
  cliBin: string;
  /** 输入图参数名（留空 = 位置参数） */
  cliInputArg: string;
  /** 输出图参数名（留空 = 位置参数，跟在输入后） */
  cliOutputArg: string;
  /** 模型参数名（留空则不下发模型） */
  cliModelArg: string;
  /** rembg 模型名，留空用 env / 默认 u2net */
  model: string;
}

/** GET /api/config 响应 */
export interface ServerConfig {
  matting: {
    engine: MattingEngine;
    model: string;
    /** engine=none 时给用户的安装提示 */
    hint: string | null;
    /** 当前模型是否已缓存到 storage/models（未缓存则首次抠图会自动下载） */
    modelCached: boolean;
  };
  gen: {
    /** 全部已配置 provider（不含 apiKey）；生成时按 id 选择 */
    providers: GenProviderInfo[];
  };
  /** 提示词加强模型摘要（不含 apiKey）；为空表示未配置 */
  promptEnhancers: Array<{ id: string; name: string; model: string }>;
}

/**
 * 提示词加强的候选风格（前后端唯一事实源）。
 * id 传给服务端；directive 由服务端拼进系统提示词（前端只用 id/label 做下拉）
 */
export const ENHANCE_STYLES = [
  { id: "pixel", label: "enhance.pixel", directive: "pixel art 风格，retro game sprite，limited color palette，crisp clusters" },
  { id: "anime", label: "enhance.anime", directive: "anime / cel-shaded 风格，clean lineart，vibrant colors" },
  { id: "illustration", label: "enhance.illustration", directive: "hand-drawn illustration 风格，painterly texture，soft brush strokes" },
  { id: "3d", label: "enhance.3d", directive: "3D render 风格，Pixar-like，soft studio lighting，octane render" },
  { id: "realistic", label: "enhance.realistic", directive: "photorealistic 风格，detailed texture，natural lighting" },
  { id: "general", label: "enhance.general", directive: "不限定风格，重点丰富主体外观、姿态、视角与氛围" },
] as const;
export type EnhanceStyleId = (typeof ENHANCE_STYLES)[number]["id"];

/**
 * 多动作 / 连续帧生成预设（素材详情「多动作生成」用）。
 * - 图片：按顺序追加帧（可重复）→ 一次生成连续动作拼图表 → 网格切分
 * - 视频：点选一个动作注入提示词 → 文生视频素材 → 素材库单独抽帧（无需拼图/切分）
 * prompt 为英文动作基调；完整文案由 buildActionSheetPrompt / buildActionVideoPrompt 组装。
 */
export const ACTION_PRESETS = [
  { id: "idle", label: "action.idle", prompt: "idle breathing" },
  { id: "walk", label: "action.walk", prompt: "walk cycle" },
  { id: "run", label: "action.run", prompt: "run cycle" },
  { id: "jump", label: "action.jump", prompt: "jump arc" },
  { id: "attack", label: "action.attack", prompt: "attack swing" },
  { id: "cast", label: "action.cast", prompt: "spell cast" },
  { id: "hurt", label: "action.hurt", prompt: "hit recoil" },
  { id: "death", label: "action.death", prompt: "collapse / defeat" },
] as const;
export type ActionPresetId = (typeof ACTION_PRESETS)[number]["id"];

/** 视频定点抽帧最多时间点数（前后端一致） */
export const EXTRACT_TIMESTAMPS_MAX = 64;

/** 拼图表最多格数（与网格切分上限对齐） */
export const ACTION_SHEET_MAX_FRAMES = 16;

/** 视频模式：点选注入单个动作（不做拼图表那套 n 帧槽位） */
export const ACTION_VIDEO_MAX_ACTIONS = 1;

/** 按帧数推荐拼图行列（尽量铺满、少空白格） */
export function suggestActionSheetGrid(frameCount: number): { cols: number; rows: number } {
  const n = Math.max(1, Math.min(ACTION_SHEET_MAX_FRAMES, Math.floor(frameCount) || 1));
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 4, rows: 1 }; // 连续帧优先单行，读序更直观
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: Math.ceil(n / 4) };
}

/**
 * 组装「连续动作拼图表」prompt：短文案优先（MiniMax 等厂商限 ~1500 字符）。
 * 引用图锁角色 + 行列 + 有序帧；强调帧间连续。角色描述/附加描述会被截断。
 */
export function buildActionSheetPrompt(opts: {
  /** 有序帧序列（可含重复动作 id） */
  frames: Array<{ id: string; label: string; prompt: string }>;
  cols: number;
  rows: number;
  characterPrompt?: string | null;
  extra?: string | null;
}): string {
  const cols = Math.max(1, Math.min(8, Math.floor(opts.cols) || 1));
  const rows = Math.max(1, Math.min(8, Math.floor(opts.rows) || 1));
  const frames = opts.frames.slice(0, cols * rows);
  const n = frames.length;
  const sameAction = n > 0 && frames.every((f) => f.id === frames[0]!.id);
  const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

  const a0 = frames[0];
  const head = sameAction && a0
    ? `Same character as reference. One ${rows}×${cols} sprite sheet: ${n}-frame continuous ${a0.prompt} cycle, L→R then T→B. Identical look each panel; smooth motion; last loops to first. Plain/transparent bg, no text.`
    : `Same character as reference. One ${rows}×${cols} sprite sheet: ${n}-frame continuous sequence, L→R then T→B. Identical look; smooth panel-to-panel motion. Plain/transparent bg, no text.`;

  const parts = [head];
  const character = opts.characterPrompt?.trim();
  if (character) parts.push(`Char: ${clip(character, 160)}`);
  if (n > 0) {
    parts.push(`Frames: ${frames.map((f, i) => `${i + 1}:${f.id}/${f.prompt}`).join("; ")}`);
  }
  const empty = cols * rows - n;
  if (empty > 0) parts.push(`Blank last ${empty} panel(s).`);
  const extra = opts.extra?.trim();
  if (extra) parts.push(clip(extra, 600));
  // 再保险：整体压到 1400，给 MiniMax 1500 限留余量
  return clip(parts.join(" "), 1400);
}

/**
 * 组装「动作视频」prompt：点选一个动作注入，生成一段连续短片（抽帧在素材库单独做）。
 * 不做拼图格点；强调该动作循环与角色一致。
 */
export function buildActionVideoPrompt(opts: {
  actions: Array<{ id: string; label: string; prompt: string }>;
  characterPrompt?: string | null;
  extra?: string | null;
}): string {
  const a0 = opts.actions[0];
  const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
  if (!a0) return clip("Pixel art game character idle loop. Plain bg, no text.", 1400);

  const parts = [
    `Pixel art game character performing continuous ${a0.prompt} loop. Keep identity consistent; smooth motion; clear silhouette; plain or simple bg; no text, no UI, no watermark.`,
  ];
  const character = opts.characterPrompt?.trim();
  if (character) parts.push(`Char: ${clip(character, 200)}`);
  const extra = opts.extra?.trim();
  if (extra) parts.push(clip(extra, 600));
  return clip(parts.join(" "), 1400);
}

/** 提示词优化可识别的生成阶段；缺省表示普通图片/视频生成。 */
export const ENHANCE_PROMPT_INTENTS = ["skeletal-character", "skeletal-parts", "skeletal-decompose", "skeletal-repair-part", "motion-clip"] as const;
export type EnhancePromptIntent = (typeof ENHANCE_PROMPT_INTENTS)[number];

/** POST /api/enhance-prompt 请求/响应 */
export interface EnhancePromptRequest {
  /** 缺省用第一个已配置的加强模型 */
  enhancerId?: string;
  prompt: string;
  /** 目标风格（ENHANCE_STYLES 的 id）；缺省/未知值按 pixel 处理 */
  style?: string;
  mediaKind?: "image" | "video";
  /** 骨骼生成阶段；服务端据此注入对应的失败经验，普通生成不传。 */
  intent?: EnhancePromptIntent;
}

export interface EnhancePromptResponse {
  enhanced: string;
  enhancerName: string;
}

/** GET /api/doctor 单项检查 */
export interface DoctorCheck {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

export interface DoctorResponse {
  checks: DoctorCheck[];
}

/** POST /api/provider/test 请求（用表单当前值测试，不要求已保存） */
export interface ProviderTestRequest {
  /** api/gemini/dashscope 实发探测（dashscope 走 compatible-mode/v1/models）；minimax 无轻量探测端点，仅校验字段 */
  type?: "api" | "dashscope" | "gemini" | "minimax";
  apiBaseUrl: string;
  apiKey: string;
  apiModel?: string;
}

/** POST /api/provider/test 响应：连通性 + 延迟 + 模型是否在列表中 */
export interface ProviderTestResponse {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  /** true=模型在 /models 列表中；false=不在；undefined=响应非标准模型列表 */
  modelsFound?: boolean;
  error?: string;
  /** 附加说明（如 minimax 未实发请求） */
  note?: string;
}

/** POST /api/provider/models 请求（用表单当前值拉模型列表，不要求已保存） */
export interface ProviderModelsRequest {
  type: "api" | "dashscope" | "gemini" | "minimax";
  apiBaseUrl: string;
  apiKey: string;
}

/** POST /api/provider/models 响应：模型 id 列表（失败带 error） */
export interface ProviderModelsResponse {
  ok: boolean;
  models?: string[];
  status?: number;
  error?: string;
}

/** WS 广播消息类型 */
export const WS_EVENTS = [
  "frame_updated",
  "frames_reordered",
  "frames_changed",
  "job_queued",
  "job_running",
  "job_progress",
  "job_done",
  "job_error",
  "job_cancelled",
  "project_deleted",
  "material_updated",
  "materials_changed",
  "animation_assets_changed",
  "folders_changed",
  "settings_changed",
] as const;
export type WSEventType = (typeof WS_EVENTS)[number];

/** 服务端 settings 表白名单 key（PUT /api/settings/:key 校验用） */
export const SETTING_KEYS = ["layout", "theme", "lang", "genProviders", "matting", "promptEnhancers"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface WSMessage<T = unknown> {
  type: WSEventType;
  payload?: T;
}

/** 帧来源对应的主题色（帧列表左边框等；浅色主题下组件内可用 color-mix 加深） */
export const SOURCE_COLORS: Record<FrameSource, string> = {
  cli: "#8be9fd",
  api: "#50fa7b",
  dashscope: "#ffb86c",
  gemini: "#f1fa8c",
  minimax: "#ff79c6",
  upload: "#6272a4",
  gif: "#bd93f9",
  mp4: "#ff5555",
  image: "#a4ffff",
  extract: "#8be9fd",
  duplicate: "#caa9fa",
  raster: "#caa9fa",
};

// ===== 实体（API 输出形态：tags/metadata 已解析为 JSON）=====

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  folder_id: string | null;
  created_at: number;
  frame_count?: number;
  first_frame_id?: string | null;
}

export interface Folder {
  id: string;
  kind: FolderKind;
  parent_id: string | null;
  name: string;
  sort: number;
  created_at: number;
}

export interface Frame {
  id: string;
  project_id: string;
  idx: number;
  raw_path: string | null;
  processed_path: string | null;
  status: FrameStatus;
  duration: number;
  is_keyframe: number;
  offset_x: number;
  offset_y: number;
  scale: number;
  rotation: number;
  opacity: number;
  tags: string[];
  source: FrameSource;
  metadata: Record<string, unknown>;
}

export interface Job {
  id: string;
  project_id: string;
  type: JobType;
  status: JobStatus;
  progress: string | null;
  error: string | null;
  created_at: number;
}

/** DB 行形态：tags/metadata 为未解析的 JSON 字符串，status/source 为宽松 string */
export interface FrameRow extends Omit<Frame, "status" | "source" | "tags" | "metadata"> {
  status: string;
  source: string;
  tags: string;
  metadata: string;
}

// ===== 素材库 =====

export interface Material {
  id: string;
  name: string;
  raw_path: string | null;
  processed_path: string | null;
  status: MaterialStatus;
  source: FrameSource;
  folder_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  /** 由路径推断：视频素材不可抠图/剪裁，需先抽帧 */
  kind: "image" | "video";
}

/** DB 行形态 */
export interface MaterialRow extends Omit<Material, "status" | "source" | "metadata"> {
  status: string;
  source: string;
  metadata: string;
}

// ===== 固定人形动作（humanoid-v1） =====

export type MotionView = "front" | "back" | "left" | "right";
export type HumanoidBoneId =
  | "pelvis" | "chest" | "neck" | "head"
  | "leftShoulder" | "leftElbow" | "leftWrist"
  | "rightShoulder" | "rightElbow" | "rightWrist"
  | "leftHip" | "leftKnee" | "leftAnkle"
  | "rightHip" | "rightKnee" | "rightAnkle";

/** 根节点平移 + 各骨骼相对父骨骼的局部弧度旋转。 */
export interface MotionKeyframe {
  id: string;
  root: { x: number; y: number };
  rotations: Record<HumanoidBoneId, number>;
}

// ===== 请求 / 响应 =====

/** PATCH /api/frames/:id 可更新字段 */
export interface FramePatch {
  offset_x?: number;
  offset_y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  duration?: number;
  is_keyframe?: number;
  tags?: string[];
}

export interface ProjectsResponse {
  projects: Project[];
}
export interface ProjectResponse {
  project: Project;
}
export interface FramesResponse {
  frames: Frame[];
}
export interface FrameResponse {
  frame: Frame;
}
export interface JobResponse {
  job: Job;
}
export interface JobsResponse {
  jobs: Job[];
}
export interface JobCreatedResponse {
  jobId: string;
}
export interface OkResponse {
  ok: boolean;
}
export interface MaterialsResponse {
  materials: Material[];
}
export interface MaterialResponse {
  material: Material;
}
export interface MaterialCreatedResponse {
  materialId: string;
}
export interface FoldersResponse {
  folders: Folder[];
}
export interface FolderResponse {
  folder: Folder;
}
