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

/** GET /api/config 响应 */
export interface ServerConfig {
  matting: {
    engine: MattingEngine;
    model: string;
    /** engine=none 时给用户的安装提示 */
    hint: string | null;
  };
  genCliConfigured: boolean;
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
export const SETTING_KEYS = ["layout", "theme"] as const;
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
