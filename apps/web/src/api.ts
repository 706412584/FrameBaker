// 类型统一来自 @framebaker/shared，这里再导出方便组件单点引入
import type {
  Frame,
  FramePatch,
  FrameResponse,
  FramesResponse,
  DoctorResponse,
  EnhancePromptResponse,
  Job,
  JobCreatedResponse,
  JobResponse,
  JobsResponse,
  Folder,
  FolderKind,
  FoldersResponse,
  FolderResponse,
  Material,
  MaterialCreatedResponse,
  MaterialResponse,
  MaterialsResponse,
  OkResponse,
  Project,
  ProjectResponse,
  ProjectsResponse,
  ProviderTestRequest,
  ProviderTestResponse,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ServerConfig,
  WSMessage,
  AnimationAxis,
  AnimationTrack,
  TimelineStep,
  TimelineResponse,
} from "@framebaker/shared";

export type { Frame, FramePatch, Job, Material, Project, Folder, FolderKind, WSMessage, AnimationAxis, AnimationTrack, TimelineStep, TimelineResponse } from "@framebaker/shared";

// ---- fetch 封装 ----
async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** 生成请求体（引用图二选一，服务端按 id 解析路径防注入；providerId/model 生成时选择） */
interface GenerateBody {
  prompt: string;
  count: number;
  autoMatting?: boolean;
  /** 素材命名基准（仅 /api/materials/generate；缺省服务端取 prompt 前 24 字符） */
  name?: string;
  referenceMaterialId?: string;
  referenceFrameId?: string;
  providerId?: string;
  model?: string;
  /** 生成尺寸（api 系覆盖 provider 默认；空 = 用 provider 配置） */
  size?: string;
  /** 视频模式：只生成视频素材，不抽帧（抽帧走素材详情） */
  mediaKind?: "image" | "video";
  /** @deprecated 视频生成不再抽帧 */
  fps?: number;
  /** 落入的素材文件夹（null/缺省 = 未分组） */
  folderId?: string | null;
}

export interface LayerMaterialBody {
  layers: number;
  numInferenceSteps: number;
  trueCfgScale: number;
  negativePrompt?: string;
  seed: number;
  autoMatting?: boolean;
}

export const api = {
  listProjects: () => req<ProjectsResponse>("/api/projects").then((r) => r.projects),
  createProject: (name: string, folderId?: string | null) =>
    req<{ id: string; name: string }>("/api/projects", {
      method: "POST",
      ...json({ name, folderId: folderId ?? null }),
    }),
  getProject: (id: string) => req<ProjectResponse>(`/api/projects/${id}`).then((r) => r.project),
  deleteProject: (id: string) => req<OkResponse>(`/api/projects/${id}`, { method: "DELETE" }),
  patchProject: (id: string, body: { name?: string; folderId?: string | null }) =>
    req<OkResponse>(`/api/projects/${id}`, { method: "PATCH", ...json(body) }),

  getFrames: (projectId: string) => req<FramesResponse>(`/api/projects/${projectId}/frames`).then((r) => r.frames),
  getTimeline: (projectId: string, axisId?: string) => req<TimelineResponse>(`/api/projects/${projectId}/timeline${axisId ? `?axisId=${encodeURIComponent(axisId)}` : ""}`),
  createAxis: (projectId: string, body: { name: string; fps?: number }) => req<{ axis: AnimationAxis }>(`/api/projects/${projectId}/axes`, { method: "POST", ...json(body) }),
  patchAxis: (id: string, body: { name?: string; fps?: number }) => req<{ axis: AnimationAxis }>(`/api/axes/${id}`, { method: "PATCH", ...json(body) }),
  deleteAxis: (id: string) => req<OkResponse>(`/api/axes/${id}`, { method: "DELETE" }),
  createTrack: (axisId: string, body: { name: string; visible?: number; locked?: number }) => req<{ track: AnimationTrack }>(`/api/axes/${axisId}/tracks`, { method: "POST", ...json(body) }),
  patchTrack: (id: string, body: { name?: string; visible?: number; locked?: number }) => req<{ track: AnimationTrack }>(`/api/tracks/${id}`, { method: "PATCH", ...json(body) }),
  deleteTrack: (id: string) => req<OkResponse>(`/api/tracks/${id}`, { method: "DELETE" }),
  reorderTracks: (axisId: string, trackIds: string[]) => req<OkResponse>(`/api/axes/${axisId}/tracks/reorder`, { method: "POST", ...json({ trackIds }) }),
  createStep: (axisId: string, duration = 1) => req<{ step: TimelineStep }>(`/api/axes/${axisId}/steps`, { method: "POST", ...json({ duration }) }),
  patchStep: (id: string, body: { duration: number }) => req<{ step: TimelineStep }>(`/api/steps/${id}`, { method: "PATCH", ...json(body) }),
  deleteStep: (id: string) => req<OkResponse>(`/api/steps/${id}`, { method: "DELETE" }),
  reorderSteps: (axisId: string, stepIds: string[]) => req<OkResponse>(`/api/axes/${axisId}/steps/reorder`, { method: "POST", ...json({ stepIds }) }),
  moveFrameCell: (id: string, trackId: string, stepId: string, swap = false, copy = false) => req<FrameResponse>(`/api/frames/${id}/placement`, { method: "PATCH", ...json({ trackId, stepId, swap, copy }) }),
  /** 批量把资产帧 copy 到目标轨道（从 startStepId 起连续放置，占用帧推回池，不足新建 step） */
  placeFramesBatch: (trackId: string, body: { startStepId?: string; frameIds: string[] }) =>
    req<{ frameIds: string[] }>(`/api/tracks/${trackId}/place-frames`, { method: "POST", ...json(body) }),
  patchFrame: (id: string, patch: FramePatch) =>
    req<FrameResponse>(`/api/frames/${id}`, { method: "PATCH", ...json(patch) }),
  replaceFrame: (id: string, file: Blob) => {
    const fd = new FormData();
    fd.append("file", file, "replacement.png");
    return req<FrameResponse>(`/api/frames/${id}/replace`, { method: "POST", body: fd });
  },
  deleteFrame: (id: string) => req<OkResponse>(`/api/frames/${id}`, { method: "DELETE" }),
  duplicateFrame: (id: string, count = 1) =>
    req<OkResponse & { count: number }>(`/api/frames/${id}/duplicate?count=${count}`, { method: "POST" }),
  reorder: (projectId: string, frameIds: string[]) =>
    req<OkResponse>(`/api/projects/${projectId}/reorder`, { method: "POST", ...json({ frameIds }) }),

  upload: (fd: FormData) => req<JobCreatedResponse>("/api/import/upload", { method: "POST", body: fd }),
  generate: (body: GenerateBody & { projectId: string }) =>
    req<JobCreatedResponse>("/api/import/generate", { method: "POST", ...json(body) }),
  getJob: (id: string) => req<JobResponse>(`/api/jobs/${id}`).then((r) => r.job),
  listJobs: () => req<JobsResponse>("/api/jobs").then((r) => r.jobs),
  cancelJob: (id: string) => req<OkResponse>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  getConfig: () => req<ServerConfig>("/api/config"),
  getDoctor: () => req<DoctorResponse>("/api/doctor"),
  testProvider: (body: ProviderTestRequest) =>
    req<ProviderTestResponse>("/api/provider/test", { method: "POST", ...json(body) }),
  listProviderModels: (body: ProviderModelsRequest) =>
    req<ProviderModelsResponse>("/api/provider/models", { method: "POST", ...json(body) }),
  enhancePrompt: (enhancerId: string | undefined, prompt: string, style: string, mediaKind?: "image" | "video") =>
    req<EnhancePromptResponse>("/api/enhance-prompt", { method: "POST", ...json({ enhancerId, prompt, style, mediaKind }) }),

  // ---- 界面偏好设置（服务端持久化） ----
  getSettings: () => req<Record<string, unknown>>("/api/settings"),
  putSetting: (key: string, value: unknown) =>
    req<OkResponse>(`/api/settings/${key}`, { method: "PUT", ...json({ value }) }),

  // ---- 素材库 ----
  listMaterials: () => req<MaterialsResponse>("/api/materials").then((r) => r.materials),
  uploadMaterial: (fd: FormData) =>
    req<JobCreatedResponse | MaterialCreatedResponse>("/api/materials/upload", { method: "POST", body: fd }),
  generateMaterial: (body: GenerateBody) =>
    req<JobCreatedResponse>("/api/materials/generate", { method: "POST", ...json(body) }),
  matteMaterial: (id: string) => req<JobCreatedResponse>(`/api/materials/${id}/matting`, { method: "POST" }),
  layerMaterial: (id: string, body: LayerMaterialBody) =>
    req<JobCreatedResponse>(`/api/materials/${id}/layers`, { method: "POST", ...json(body) }),
  /** 视频/GIF 素材抽帧 → 每帧一个新素材；timestamps 定点（仅视频），否则 fps 整段 */
  extractMaterial: (
    id: string,
    body?: { fps?: number; timestamps?: number[]; autoMatting?: boolean; folderId?: string | null }
  ) => req<JobCreatedResponse>(`/api/materials/${id}/extract`, { method: "POST", ...json(body ?? {}) }),
  unmatteMaterial: (id: string) => req<MaterialResponse>(`/api/materials/${id}/unmatting`, { method: "POST" }),
  batchMatteMaterials: (ids: string[]) =>
    req<OkResponse & { count: number; skipped: number }>("/api/materials/batch-matting", {
      method: "POST",
      ...json({ ids }),
    }),
  replaceMaterialImage: (id: string, file: Blob, slot: "raw" | "processed") => {
    const fd = new FormData();
    fd.append("file", file, "crop.png");
    fd.append("slot", slot);
    return req<MaterialResponse>(`/api/materials/${id}/replace-image`, { method: "POST", body: fd });
  },
  importMaterial: (id: string, projectId: string, count = 1) =>
    req<OkResponse & { count: number }>(`/api/materials/${id}/import`, {
      method: "POST",
      ...json({ projectId, count }),
    }),
  batchDeleteMaterials: (ids: string[]) =>
    req<OkResponse & { deleted: number }>("/api/materials/batch-delete", { method: "POST", ...json({ ids }) }),
  batchImportMaterials: (ids: string[], projectId: string, target?: { axisId: string; trackId: string; startStepId?: string }) =>
    req<OkResponse & { count: number; frameIds?: string[] }>("/api/materials/batch-import", { method: "POST", ...json({ ids, projectId, target }) }),

  // ---- 文件夹（素材 / 项目多级目录） ----
  listFolders: (kind: FolderKind) =>
    req<FoldersResponse>(`/api/folders?kind=${kind}`).then((r) => r.folders),
  createFolder: (kind: FolderKind, name: string, parentId?: string | null) =>
    req<FolderResponse>("/api/folders", { method: "POST", ...json({ kind, name, parentId: parentId ?? null }) }),
  patchFolder: (id: string, body: { name?: string; parentId?: string | null }) =>
    req<OkResponse>(`/api/folders/${id}`, { method: "PATCH", ...json(body) }),
  deleteFolder: (id: string) => req<OkResponse>(`/api/folders/${id}`, { method: "DELETE" }),
  moveItems: (kind: FolderKind, ids: string[], folderId: string | null) =>
    req<OkResponse & { moved: number }>("/api/folders/move-items", {
      method: "POST",
      ...json({ kind, ids, folderId }),
    }),
};

/** 帧图片 URL（.png 后缀：Pixi Assets 按扩展名命中 texture parser；v 变化可破缓存） */
export const frameImageUrl = (id: string, v?: number) =>
  `/api/frames/${id}/image.png?type=processed${v ? `&v=${v}` : ""}`;

/** 素材图片 URL；type=raw 强制原图，默认 processed（缺失时服务端回退 raw） */
export const materialImageUrl = (id: string, v?: number, type: "raw" | "processed" = "processed") =>
  `/api/materials/${id}/image.png?type=${type}${v ? `&v=${v}` : ""}`;

/** 素材文件 URL（视频勿用 .png 后缀，避免部分浏览器误判） */
export const materialFileUrl = (id: string, v?: number, type: "raw" | "processed" = "raw") =>
  `/api/materials/${id}/image?type=${type}${v ? `&v=${v}` : ""}`;

// ---- WS 客户端：断线 3s 重连 ----
type Listener = (msg: WSMessage) => void;

class WSClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as WSMessage;
        this.listeners.forEach((l) => l(msg));
      } catch {
        /* 忽略非法消息 */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.started) setTimeout(() => this.connect(), 3000);
    };
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}

export const wsClient = new WSClient();
