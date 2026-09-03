// 图执行器：拓扑排序 → 逐节点执行 → graph_outputs 缓存命中跳过 → 结果写回。
//
// 与 queue.ts 的关系（AGENTS.md:39 单向依赖）：
// - 本模块不 import queue.ts；服务端节点直接调用 jobs/* 的底层函数（不走全局队列），
//   避免内存 payload 不落库的问题 —— 节点执行的 payload 全部在 graph_outputs 表。
// - 执行状态本身持久化在 graph_outputs（每节点完成即落库），重启后已完成节点缓存命中，
//   未完成节点重新执行（幂等：输出文件路径由 content_hash 决定，重跑覆盖写）。
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GraphEdge, GraphNode, GraphOutput } from "@framebaker/shared";
import { db, STORAGE_ROOT, uid } from "../db";
import { broadcast } from "../ws";
import { materialHash, nodeHash } from "./contentHash";
import { getNodeSchema } from "./registry";
import { runNode, type NodeContext, type NodeOutput } from "./nodes";

/** 节点执行状态（内存 + WS 广播；持久层在 graph_outputs，存在即 done） */
export interface NodeRunState {
  nodeId: string;
  status: "queued" | "running" | "done" | "skipped-cache" | "error" | "cancelled";
  progress?: string;
  error?: string;
  /** 输出端口 -> content_hash */
  hashes?: Record<string, string>;
}

export interface GraphRunResult {
  states: NodeRunState[];
  cancelled: boolean;
}

// ---- 客户端节点执行通道 ----
// 客户端节点（imageops worker，如 quantize.pixel）由打开画布的浏览器执行：
// executor 广播 graph_client_task → 前端算完 POST /api/graphs/:id/client-result/:taskId
// → 这里挂起的 promise 解除。超时（默认 120s）视为失败。
interface ClientTask {
  resolve: (paths: string[]) => void;
  /** 分析型节点（rect[] 输出）不走文件，直接回端口 payload */
  resolveOutputs?: (outputs: Record<string, Record<string, unknown>>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  outputDir: string;
}
const clientTasks = new Map<string, ClientTask>();
const CLIENT_TASK_TIMEOUT_MS = 120_000;

export function pendingClientTaskCount(): number {
  return clientTasks.size;
}

/** 查询客户端任务的产物目录（不存在返回 null；API 层上传产物用） */
export function clientTaskOutputDir(taskId: string): string | null {
  return clientTasks.get(taskId)?.outputDir ?? null;
}

/** 客户端回传结果：文件型（fileNames）或分析型（outputs）；error 非空表示客户端失败 */
export function resolveClientTask(
  taskId: string,
  fileNames: string[],
  error?: string,
  outputs?: Record<string, Record<string, unknown>>
): boolean {
  const task = clientTasks.get(taskId);
  if (!task) return false;
  clientTasks.delete(taskId);
  clearTimeout(task.timer);
  if (error) {
    task.reject(new Error(error));
  } else if (outputs && task.resolveOutputs) {
    task.resolveOutputs(outputs);
  } else {
    task.resolve(fileNames.map((n) => join(task.outputDir, n)));
  }
  return true;
}

/**
 * 人在环挂起（server 节点 ui.layer.analyze interactive）：
 * 复用 client-task 的回传通道（graph_client_task WS + client-result complete API）——
 * 前端确认面板把修正后的候选清单作为 outputs.rects 回传，替换分析结果继续下游。
 */
async function waitUserRects(
  graphId: string,
  nodeId: string,
  candidates: Array<{ name: string; x: number; y: number; w: number; h: number }>,
  previewUrl: string | undefined,
  onStatus: (status: string, payload: Record<string, unknown>) => void
): Promise<NodeOutput> {
  const taskId = uid();
  const outputDir = join(STORAGE_ROOT, "staging", "ui_confirm", taskId);
  mkdirSync(outputDir, { recursive: true });
  return new Promise<NodeOutput>((resolve, reject) => {
    const timer = setTimeout(() => {
      clientTasks.delete(taskId);
      reject(new Error("等待候选框确认超时（画布页未打开？）"));
    }, 30 * 60 * 1000); // 人在环给足 30 分钟
    clientTasks.set(taskId, {
      outputDir,
      timer,
      resolve: () => reject(new Error("人在环节点不能回传文件")),
      reject,
      resolveOutputs: (outputs) => {
        const confirmed = outputs.rects as { candidates?: Array<{ name: string; x: number; y: number; w: number; h: number }> } | undefined;
        resolve({ images: { paths: [] }, rects: { candidates: confirmed?.candidates ?? candidates } });
      },
    });
    onStatus("waiting-for-input", {});
    broadcast("graph_client_task", {
      graphId,
      nodeId,
      taskId,
      nodeType: "ui.layer.confirm",
      params: { interactive: true },
      inputUrls: previewUrl ? { images: [previewUrl] } : {},
      inputPassthrough: { rects: { candidates } },
    });
  });
}

/**
 * 客户端节点统一入口：把节点参数与输入图片 URL 广播给浏览器（画布页），
 * 浏览器用 imageops worker 计算后把产物 PNG 逐个上传到
 * POST /api/graphs/:id/client-result/:taskId（API 层落盘到 ctx.outputDir），
 * 全部上传完再 POST 完成标记。
 */
async function runClientNodeTask(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext,
  graphId: string,
  nodeId: string
): Promise<NodeOutput> {
  if (ctx.signal.aborted) throw new Error("任务已取消");
  ctx.report("等待浏览器执行…");
  // 输入端口 payload 里的服务端绝对路径 → 受限媒体 URL；非路径型输入（rects 等）原样透传
  const urls: Record<string, string[]> = {};
  const passthrough: Record<string, Record<string, unknown>> = {};
  for (const [port, payload] of Object.entries(inputs)) {
    const paths = Array.isArray(payload.paths) ? (payload.paths as string[]) : [];
    if (paths.length) urls[port] = paths.map((p) => `/api/graph/media?path=${encodeURIComponent(p)}`);
    else passthrough[port] = payload;
  }
  const taskId = uid();
  const schema = getNodeSchema(node.type)!;
  const isAnalyze = schema.outputs.every((o) => o.type === "rect[]" || o.type === "palette");
  const result = await new Promise<{ files: string[]; outputs: Record<string, Record<string, unknown>> }>((resolve, reject) => {
    const timer = setTimeout(() => {
      clientTasks.delete(taskId);
      reject(new Error("客户端节点执行超时（画布页未打开？）"));
    }, CLIENT_TASK_TIMEOUT_MS);
    clientTasks.set(taskId, {
      outputDir: ctx.outputDir,
      timer,
      resolve: (files) => resolve({ files, outputs: {} }),
      resolveOutputs: (outputs) => resolve({ files: [], outputs }),
      reject,
    });
    broadcast("graph_client_task", { graphId, nodeId, taskId, nodeType: node.type, params: node.params, inputUrls: urls, inputPassthrough: passthrough });
  });
  if (ctx.signal.aborted) throw new Error("任务已取消");
  if (isAnalyze) return result.outputs;
  return { images: { paths: result.files } };
}

/** 图文档的内存形态 */
export interface ExecutableGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const runningGraphs = new Map<string, AbortController>();

export function cancelGraphRun(graphId: string): boolean {
  const ac = runningGraphs.get(graphId);
  if (!ac || ac.signal.aborted) return false;
  ac.abort();
  return true;
}

export function isGraphRunning(graphId: string): boolean {
  const ac = runningGraphs.get(graphId);
  return !!ac && !ac.signal.aborted;
}

/** 拓扑排序（Kahn）；有环抛错 */
export function topoSort(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!indegree.has(e.from_node) || !indegree.has(e.to_node)) continue;
    indegree.set(e.to_node, (indegree.get(e.to_node) ?? 0) + 1);
    const list = adjacency.get(e.from_node) ?? [];
    list.push(e.to_node);
    adjacency.set(e.from_node, list);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const sorted: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (sorted.length !== nodes.length) throw new Error("图中存在环，无法执行");
  return sorted;
}

/** 查缓存：命中返回该节点全部输出端口 payload */
function readCachedOutputs(nodeId: string, hashes: Record<string, string>): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {};
  const ports = Object.keys(hashes);
  if (ports.length === 0) return null;
  for (const port of ports) {
    const row = db
      .query("SELECT payload FROM graph_outputs WHERE content_hash = ? AND port = ?")
      .get(hashes[port], port) as { payload: string } | null;
    if (!row) return null; // 任一端口缺失 → 整节点重跑
    try {
      out[port] = JSON.parse(row.payload);
    } catch {
      return null;
    }
  }
  return out;
}

function writeOutput(hash: string, port: string, nodeType: string, payload: Record<string, unknown>) {
  db.query(
    `INSERT INTO graph_outputs (content_hash, port, node_type, payload, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (content_hash, port) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`
  ).run(hash, port, nodeType, JSON.stringify(payload), Date.now());
}

/** 节点产物目录：由 hash 决定路径，重跑幂等覆盖 */
export function nodeOutputDir(hash: string): string {
  return join(STORAGE_ROOT, "graph", "outputs", hash);
}

/** 计算图中每个节点的 content hash（含上游传递） */
export function computeNodeHashes(graph: ExecutableGraph): Map<string, Record<string, string>> {
  const order = topoSort(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // nodeId -> { port -> hash }；源节点输出端口的 hash = 节点自身 hash
  const nodeHashes = new Map<string, Record<string, string>>();
  for (const id of order) {
    const node = byId.get(id)!;
    const schema = getNodeSchema(node.type);
    if (!schema) throw new Error(`未知节点类型: ${node.type}`);
    const upstream: Record<string, string> = {};
    for (const e of graph.edges) {
      if (e.to_node !== id) continue;
      const fromOutputs = nodeHashes.get(e.from_node);
      if (!fromOutputs?.[e.from_port]) throw new Error(`上游节点 ${e.from_node} 尚无输出（执行序异常）`);
      upstream[e.to_port] = fromOutputs[e.from_port];
    }
    let hash: string;
    if (node.type === "material.video" || node.type === "material.image") {
      // 源节点：素材文件 size+mtime（image 优先 processed）
      const row = db
        .query("SELECT raw_path, processed_path FROM materials WHERE id = ?")
        .get(String(node.params.materialId ?? "")) as
        | { raw_path: string | null; processed_path: string | null }
        | null;
      const src = node.type === "material.image" ? (row?.processed_path ?? row?.raw_path ?? null) : (row?.raw_path ?? null);
      hash = materialHash(String(node.params.materialId ?? ""), src);
    } else {
      hash = nodeHash(node.type, node.params, upstream);
    }
    const portHashes: Record<string, string> = {};
    for (const out of schema.outputs) portHashes[out.name] = hash;
    nodeHashes.set(id, portHashes);
  }
  return nodeHashes;
}

/** 执行整张图。逐节点：缓存命中跳过，否则执行并写 graph_outputs。 */
export async function runGraph(graphId: string, graph: ExecutableGraph): Promise<GraphRunResult> {
  if (isGraphRunning(graphId)) throw new Error("该工作流已在执行中");
  const ac = new AbortController();
  runningGraphs.set(graphId, ac);
  const states: NodeRunState[] = [];
  let cancelled = false;
  // 执行记录（任务面板可回溯；uid 作为 run id）
  const runId = uid();
  const graphName =
    (db.query("SELECT name FROM graphs WHERE id = ?").get(graphId) as { name: string } | null)?.name ?? graphId;
  db.query(
    "INSERT INTO graph_runs (id, graph_id, graph_name, started_at, status) VALUES (?, ?, ?, ?, 'running')"
  ).run(runId, graphId, graphName, Date.now());
  broadcast("graph_runs_changed", {});
  try {
    const order = topoSort(graph.nodes, graph.edges);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const nodeHashes = computeNodeHashes(graph);
    // 各节点已完成的输出 payload（缓存命中或刚执行）
    const outputsByNode = new Map<string, Record<string, Record<string, unknown>>>();

    for (const nodeId of order) {
      if (ac.signal.aborted) {
        cancelled = true;
        break;
      }
      const node = byId.get(nodeId)!;
      const hashes = nodeHashes.get(nodeId)!;

      // 缓存命中 → 跳过（仍带预览线索，前端重跑清态后可恢复缩略图）
      const cached = readCachedOutputs(nodeId, hashes);
      if (cached) {
        outputsByNode.set(nodeId, cached);
        states.push({ nodeId, status: "skipped-cache" });
        let cachedPreviewUrl: string | undefined;
        let cachedPreviewKind: "image" | "video" | undefined;
        let cachedFrameUrls: string[] | undefined;
        for (const payload of Object.values(cached)) {
          if (Array.isArray(payload.paths) && payload.paths.length) {
            cachedPreviewUrl = `/api/graph/media?path=${encodeURIComponent(payload.paths[0] as string)}`;
            cachedPreviewKind = "image";
            if (payload.paths.length > 1) {
              cachedFrameUrls = (payload.paths as string[]).map((p) => `/api/graph/media?path=${encodeURIComponent(p)}`);
            }
            break;
          }
          if (typeof payload.path === "string" && /\.(mov|mp4)$/i.test(payload.path)) {
            cachedPreviewUrl = `/api/graph/media?path=${encodeURIComponent(payload.path)}`;
            cachedPreviewKind = "video";
            break;
          }
        }
        broadcast("graph_node_status", { graphId, nodeId, status: "skipped-cache", previewUrl: cachedPreviewUrl, previewKind: cachedPreviewKind, frameUrls: cachedFrameUrls });
        continue;
      }

      // 组装输入：上游端口 payload
      const inputs: Record<string, Record<string, unknown>> = {};
      for (const e of graph.edges) {
        if (e.to_node !== nodeId) continue;
        const fromOutputs = outputsByNode.get(e.from_node);
        if (!fromOutputs?.[e.from_port]) throw new Error(`上游节点输出缺失: ${e.from_node}.${e.from_port}`);
        inputs[e.to_port] = fromOutputs[e.from_port];
      }

      states.push({ nodeId, status: "running" });
      broadcast("graph_node_status", { graphId, nodeId, status: "running" });
      try {
        const schema = getNodeSchema(node.type)!;
        const firstPort = Object.keys(hashes)[0]!;
        const ctx: NodeContext = {
          signal: ac.signal,
          outputDir: nodeOutputDir(hashes[firstPort]!),
          report: (p: string) => {
            if (ac.signal.aborted) return;
            broadcast("graph_node_status", { graphId, nodeId, status: "running", progress: p });
          },
        };
        let result: NodeOutput =
          schema.execution === "client"
            ? await runClientNodeTask(node, inputs, ctx, graphId, nodeId)
            : await runNode(node, inputs, ctx);
        // 人在环（server 节点）：ui.layer.analyze + interactive=true → 分析完成后暂停，
        // 广播候选清单给画布确认面板，用户增删改候选框后回传修正 rects，覆盖输出再继续下游。
        if (node.type === "ui.layer.analyze" && node.params.interactive === true) {
          const rawRects = result.rects as { candidates?: Array<{ name: string; x: number; y: number; w: number; h: number }> } | undefined;
          const candidates = rawRects?.candidates ?? [];
          const inputPayload = inputs.images as { paths?: string[] } | undefined;
          const firstUrl = inputPayload?.paths?.[0]
            ? `/api/graph/media?path=${encodeURIComponent(inputPayload.paths[0])}`
            : undefined;
          result = await waitUserRects(graphId, nodeId, candidates, firstUrl, (status, payload) =>
            broadcast("graph_node_status", { graphId, nodeId, status, ...payload })
          );
        }
        const outputs: Record<string, Record<string, unknown>> = {};
        for (const [port, payload] of Object.entries(result)) {
          writeOutput(hashes[port], port, node.type, payload);
          outputs[port] = payload;
        }
        outputsByNode.set(nodeId, outputs);
        states.push({ nodeId, status: "done", hashes });
        // 预览线索：首个有 paths/path 的端口 → 前端拉缩略图（media URL 走受限路由）
        let previewUrl: string | undefined;
        let previewKind: "image" | "video" | undefined;
        // 多帧序列 → 全部帧 URL（lightbox 播放器用）
        let frameUrls: string[] | undefined;
        let previewMeta: { sampleTime: number; duration: number } | undefined;
        let outputDir: string | undefined;
        for (const payload of Object.values(outputs)) {
          if (typeof payload.outputDir === "string") outputDir = payload.outputDir;
          if (Array.isArray(payload.paths) && payload.paths.length) {
            previewUrl = `/api/graph/media?path=${encodeURIComponent(payload.paths[0] as string)}`;
            previewKind = "image";
            if (payload.paths.length > 1) {
              frameUrls = (payload.paths as string[]).map((p) => `/api/graph/media?path=${encodeURIComponent(p)}`);
            }
            if (typeof payload.duration === "number") {
              previewMeta = { sampleTime: Number(payload.sampleTime ?? 0), duration: payload.duration };
            }
            break;
          }
          if (typeof payload.path === "string" && /\.(png|webp)$/i.test(payload.path)) {
            previewUrl = `/api/graph/media?path=${encodeURIComponent(payload.path)}`;
            previewKind = "image";
            break;
          }
          if (typeof payload.path === "string" && /\.(mov|mp4)$/i.test(payload.path)) {
            previewUrl = `/api/graph/media?path=${encodeURIComponent(payload.path)}`;
            previewKind = "video";
            break;
          }
        }
        broadcast("graph_node_status", { graphId, nodeId, status: "done", previewUrl, previewKind, frameUrls, previewMeta, outputDir });
      } catch (err) {
        if (ac.signal.aborted) {
          states.push({ nodeId, status: "cancelled" });
          broadcast("graph_node_status", { graphId, nodeId, status: "cancelled" });
          cancelled = true;
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[graph ${graphId}] 节点 ${node.type}(${nodeId}) 失败:`, msg);
        states.push({ nodeId, status: "error", error: msg });
        broadcast("graph_node_status", { graphId, nodeId, status: "error", error: msg });
        break; // 下游无从执行
      }
    }
    return { states, cancelled };
  } finally {
    runningGraphs.delete(graphId);
    // 终态落库：error / cancelled / done（states 里任一 error/cancelled 即整体失败）
    const finalStatus = states.some((s) => s.status === "error")
      ? "error"
      : cancelled
        ? "cancelled"
        : "done";
    db.query("UPDATE graph_runs SET finished_at = ?, status = ?, node_states = ? WHERE id = ?").run(
      Date.now(),
      finalStatus,
      JSON.stringify(states),
      runId
    );
    broadcast("graph_runs_changed", {});
  }
}

/** 读单个节点当前缓存（画布节点状态恢复用） */
export function getNodeOutput(graph: ExecutableGraph, nodeId: string): GraphOutput | null {
  const hashes = computeNodeHashes(graph).get(nodeId);
  if (!hashes) return null;
  const ports = Object.keys(hashes);
  const first = ports[0];
  if (!first) return null;
  const row = db
    .query("SELECT * FROM graph_outputs WHERE content_hash = ? AND port = ?")
    .get(hashes[first], first) as (GraphOutput & { payload: string }) | null;
  if (!row) return null;
  try {
    return { ...row, payload: JSON.parse(row.payload) };
  } catch {
    return null;
  }
}

/** 清理执行暂存目录（节点产物目录保留：缓存命中还要用） */
export function cleanupGraphStaging(stageDir: string) {
  rmSync(stageDir, { recursive: true, force: true });
}

export function ensureGraphStorage() {
  mkdirSync(join(STORAGE_ROOT, "graph", "outputs"), { recursive: true });
}
