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
  ServerConfig,
  WSMessage,
} from "@framebaker/shared";

export type { Frame, FramePatch, Job, Material, Project, WSMessage } from "@framebaker/shared";

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

/** CLI 生成请求体（引用图二选一，服务端按 id 解析路径防注入；providerId/model 生成时选择） */
interface GenerateBody {
  prompt: string;
  count: number;
  autoMatting?: boolean;
  referenceMaterialId?: string;
  referenceFrameId?: string;
  providerId?: string;
  model?: string;
}

export const api = {
  listProjects: () => req<ProjectsResponse>("/api/projects").then((r) => r.projects),
  createProject: (name: string) =>
    req<{ id: string; name: string }>("/api/projects", { method: "POST", ...json({ name }) }),
  getProject: (id: string) => req<ProjectResponse>(`/api/projects/${id}`).then((r) => r.project),
  deleteProject: (id: string) => req<OkResponse>(`/api/projects/${id}`, { method: "DELETE" }),

  getFrames: (projectId: string) => req<FramesResponse>(`/api/projects/${projectId}/frames`).then((r) => r.frames),
  patchFrame: (id: string, patch: FramePatch) =>
    req<FrameResponse>(`/api/frames/${id}`, { method: "PATCH", ...json(patch) }),
  replaceFrame: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
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
  getConfig: () => req<ServerConfig>("/api/config"),
  getDoctor: () => req<DoctorResponse>("/api/doctor"),
  testProvider: (body: ProviderTestRequest) =>
    req<ProviderTestResponse>("/api/provider/test", { method: "POST", ...json(body) }),
  enhancePrompt: (enhancerId: string | undefined, prompt: string) =>
    req<EnhancePromptResponse>("/api/enhance-prompt", { method: "POST", ...json({ enhancerId, prompt }) }),

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
  matteMaterial: (id: string) =>
    req<MaterialResponse & { warning: string | null }>(`/api/materials/${id}/matting`, { method: "POST" }),
  unmatteMaterial: (id: string) => req<MaterialResponse>(`/api/materials/${id}/unmatting`, { method: "POST" }),
  batchMatteMaterials: (ids: string[]) =>
    req<OkResponse & { count: number }>("/api/materials/batch-matting", { method: "POST", ...json({ ids }) }),
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
  batchImportMaterials: (ids: string[], projectId: string) =>
    req<OkResponse & { count: number }>("/api/materials/batch-import", { method: "POST", ...json({ ids, projectId }) }),
};

/** 帧图片 URL（.png 后缀：Pixi Assets 按扩展名命中 texture parser；v 变化可破缓存） */
export const frameImageUrl = (id: string, v?: number) =>
  `/api/frames/${id}/image.png?type=processed${v ? `&v=${v}` : ""}`;

/** 素材图片 URL；type=raw 强制原图，默认 processed（缺失时服务端回退 raw） */
export const materialImageUrl = (id: string, v?: number, type: "raw" | "processed" = "processed") =>
  `/api/materials/${id}/image.png?type=${type}${v ? `&v=${v}` : ""}`;

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
