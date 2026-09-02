// ===== 无限画布节点工作流（graph）=====

/** 端口数据类型：连线时校验，不匹配拒绝 */
export const PORT_TYPES = ["video", "image", "image[]", "rect[]", "sheet", "palette"] as const;
export type PortType = (typeof PORT_TYPES)[number];

/**
 * 端口类型配色（连线与端口点着色，参考 ComfyUI linkColour 语义；Dracula 调色，
 * 与 SOURCE_COLORS 同风格）。CSS 里勿重复定义，画布连线用内联 stroke 引用此处。
 */
export const PORT_COLORS: Record<PortType, string> = {
  video: "#ff5555",
  image: "#50fa7b",
  "image[]": "#50fa7b",
  "rect[]": "#8be9fd",
  sheet: "#ffb86c",
  palette: "#f1fa8c",
};

/** 节点运行状态；waiting-for-input 供人在环节点暂停用（阶段4） */
export const NODE_RUN_STATUSES = ["idle", "queued", "running", "waiting-for-input", "done", "error", "skipped-cache"] as const;
export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number];

/** 节点执行位：服务端（复用 job / Python）或客户端（imageops worker） */
export const NODE_EXECUTION_SITES = ["server", "client"] as const;
export type NodeExecutionSite = (typeof NODE_EXECUTION_SITES)[number];

/** 端口定义：入参即输入端口，出参即输出端口 */
export interface PortDef {
  /** 端口名（节点内唯一） */
  name: string;
  type: PortType;
  /** UI 展示名（中文，走 i18n 的 key） */
  label: string;
}

/** 节点 schema：注册表的单条目；由 MCP tool Zod schema 或手写生成 */
export interface NodeSchema {
  /** 节点类型标识，如 "extract.frames" */
  type: string;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  /** 参数（非端口输入）的 JSON Schema 形态描述，供参数面板渲染 */
  paramsSchema: Record<string, unknown>;
  execution: NodeExecutionSite;
}

/** graph_nodes 行形态（params 为已解析对象） */
export interface GraphNode {
  id: string;
  graph_id: string;
  type: string;
  params: Record<string, unknown>;
  x: number;
  y: number;
  /** 图文档附带：该节点缓存产物的预览首帧 URL（GET /api/graphs/:id 响应里非空） */
  previewUrl?: string;
  previewKind?: "image" | "video";
  /** 缓存产物为多帧序列时的全部帧 URL（lightbox 播放器用） */
  frameUrls?: string[];
  /** preview.frame 产物元信息（时间轴拖动用） */
  previewMeta?: { sampleTime: number; duration: number };
}

/** graph_nodes DB 行形态（params 为 JSON 字符串） */
export interface GraphNodeRow extends Omit<GraphNode, "params"> {
  params: string;
}

/** graph_edges 行形态 */
export interface GraphEdge {
  id: string;
  graph_id: string;
  from_node: string;
  from_port: string;
  to_node: string;
  to_port: string;
}

/** 图（含节点与边；API 输出形态） */
export interface GraphDocument {
  graph: { id: string; name: string; folder_id: string | null; created_at: number; updated_at: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** graph_outputs 缓存条目：以 (content_hash, port) 为主键，跨图共享 */
export interface GraphOutput {
  content_hash: string;
  port: string;
  node_type: string;
  /** JSON：帧 id 数组 / 文件路径 / rect 数组等；不存二进制 */
  payload: Record<string, unknown>;
  created_at: number;
}
