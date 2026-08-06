// ===== 枚举常量（前后端唯一事实源）=====

export const FRAME_STATUSES = ["pending", "extracting", "matting", "ready", "error"] as const;
export type FrameStatus = (typeof FRAME_STATUSES)[number];

export const FRAME_SOURCES = ["cli", "upload", "gif", "mp4", "image", "duplicate"] as const;
export type FrameSource = (typeof FRAME_SOURCES)[number];

export const JOB_TYPES = ["extract_frames", "generate_frames", "matting"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "done", "error"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const MATERIAL_STATUSES = ["raw", "matted"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

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
  /** type=api 系：可用模型列表（生成弹窗下拉选项） */
  apiModels: string[];
  /** 尺寸：api 如 1024x1024，dashscope 如 2048*2048（星号），gemini/minimax 如 16:9；留空则不传 */
  apiSize: string;
}

/** 提示词加强模型（存 settings 表 key=promptEnhancers 的数组元素；OpenAI 兼容 chat/completions） */
export interface PromptEnhancer {
  id: string;
  name: string;
  /** OpenAI 兼容 baseUrl（POST {apiBaseUrl}/chat/completions） */
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
}

/** GET /api/config 下发的 provider 摘要（不含 apiKey） */
export interface GenProviderInfo {
  id: string;
  name: string;
  type: GenProviderType;
  /** api 可用模型；cli 恒为空数组 */
  models: string[];
  /** 关键字段是否齐备（cli=命令非空；api 系=baseUrl/key 齐全） */
  configured: boolean;
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

/** POST /api/enhance-prompt 请求/响应 */
export interface EnhancePromptRequest {
  /** 缺省用第一个已配置的加强模型 */
  enhancerId?: string;
  prompt: string;
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
  /** api/gemini 实发探测；dashscope/minimax 无轻量探测端点，仅校验字段 */
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
  /** 附加说明（如 dashscope 未实发请求） */
  note?: string;
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
  "project_deleted",
  "material_updated",
  "materials_changed",
  "settings_changed",
] as const;
export type WSEventType = (typeof WS_EVENTS)[number];

/** 服务端 settings 表白名单 key（PUT /api/settings/:key 校验用） */
export const SETTING_KEYS = ["layout", "theme", "genProviders", "matting", "promptEnhancers"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface WSMessage<T = unknown> {
  type: WSEventType;
  payload?: T;
}

/** 帧来源对应的主题色（帧列表左边框等；浅色主题下组件内可用 color-mix 加深） */
export const SOURCE_COLORS: Record<FrameSource, string> = {
  cli: "#8be9fd",
  upload: "#50fa7b",
  gif: "#ffb86c",
  mp4: "#ff79c6",
  image: "#f1fa8c",
  duplicate: "#bd93f9",
};

// ===== 实体（API 输出形态：tags/metadata 已解析为 JSON）=====

export interface Project {
  id: string;
  name: string;
  created_at: number;
  frame_count?: number;
  first_frame_id?: string | null;
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
  metadata: Record<string, unknown>;
  created_at: number;
}

/** DB 行形态 */
export interface MaterialRow extends Omit<Material, "status" | "source" | "metadata"> {
  status: string;
  source: string;
  metadata: string;
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
