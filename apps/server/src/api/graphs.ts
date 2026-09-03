import { Elysia, t } from "elysia";
import type { GraphEdge, GraphNode, GraphNodeRow } from "@framebaker/shared";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, STORAGE_ROOT, uid } from "../db";
import { runCmd } from "../jobs/run";
import { runNode } from "../graph/nodes";
import { broadcast } from "../ws";
import { serveMediaFile } from "../media";
import { getNodeSchema, listNodeSchemas, portsCompatible } from "../graph/registry";
import { GRAPH_TEMPLATES } from "../graph/templates";
import { cancelGraphRun, clientTaskOutputDir, computeNodeHashes, ensureGraphStorage, isGraphRunning, resolveClientTask, runGraph } from "../graph/executor";

function getGraphRow(id: string): { id: string } | null {
  return (db.query("SELECT id FROM graphs WHERE id = ?").get(id) as { id: string } | null) ?? null;
}

function getGraphNode(id: string, graphId?: string): GraphNodeRow | null {
  const row = db.query("SELECT * FROM graph_nodes WHERE id = ?").get(id) as GraphNodeRow | null;
  if (!row) return null;
  if (graphId && row.graph_id !== graphId) return null;
  return row;
}

function touchGraph(id: string) {
  db.query("UPDATE graphs SET updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function serializeGraph(id: string) {
  const graph = db.query("SELECT * FROM graphs WHERE id = ?").get(id) as
    | { id: string; name: string; folder_id: string | null; created_at: number; updated_at: number }
    | null;
  if (!graph) return null;
  const nodes = (db.query("SELECT * FROM graph_nodes WHERE graph_id = ? ORDER BY id").all(id) as GraphNodeRow[]).map(
    (row) => ({ ...row, params: safeParse(row.params) })
  );
  const edges = db.query("SELECT * FROM graph_edges WHERE graph_id = ? ORDER BY id").all(id) as GraphEdge[];
  // 缓存产物预览摘要（画布后开/重启后也有缩略图；失败静默忽略 —— 预览非关键路径）
  let nodesWithPreview = nodes;
  try {
    const hashes = computeNodeHashes({ nodes, edges });
    nodesWithPreview = nodes.map((n) => {
      const portHashes = hashes.get(n.id);
      if (!portHashes) return n;
      const port = Object.keys(portHashes)[0]!;
      const row = db.query("SELECT payload FROM graph_outputs WHERE content_hash = ? AND port = ?").get(portHashes[port], port) as
        | { payload: string }
        | null;
      if (!row) return n;
      const payload = safeParse(row.payload);
      const paths = Array.isArray(payload.paths) ? (payload.paths as string[]) : [];
      const nodeOutputDir = typeof payload.outputDir === "string" ? payload.outputDir : undefined;
      if (paths.length) {
        return {
          ...n,
          previewUrl: `/api/graph/media?path=${encodeURIComponent(paths[0]!)}`,
          previewKind: "image" as const,
          ...(nodeOutputDir ? { outputDir: nodeOutputDir } : {}),
          ...(paths.length > 1
            ? { frameUrls: paths.map((p) => `/api/graph/media?path=${encodeURIComponent(p)}`) }
            : {}),
          ...(typeof payload.duration === "number"
            ? { previewMeta: { sampleTime: Number(payload.sampleTime ?? 0), duration: payload.duration } }
            : {}),
        };
      }
      if (typeof payload.path === "string" && /\.(png|webp)$/i.test(payload.path)) {
        return { ...n, previewUrl: `/api/graph/media?path=${encodeURIComponent(payload.path)}`, previewKind: "image" as const, ...(nodeOutputDir ? { outputDir: nodeOutputDir } : {}) };
      }
      if (typeof payload.path === "string" && /\.(mov|mp4)$/i.test(payload.path)) {
        return { ...n, previewUrl: `/api/graph/media?path=${encodeURIComponent(payload.path)}`, previewKind: "video" as const, ...(nodeOutputDir ? { outputDir: nodeOutputDir } : {}) };
      }
      // 无预览但有产物目录（export.package 的 sheet payload 等）→ 仍带 outputDir 供产物面板
      if (nodeOutputDir) return { ...n, outputDir: nodeOutputDir };
      return n;
    });
  } catch {
    /* 预览摘要失败不影响图文档 */
  }
  return { graph, nodes: nodesWithPreview, edges };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const graphsApi = new Elysia({ prefix: "/api" })
  // 节点类型清单（画布左侧节点面板用）
  .get("/graph/node-schemas", () => ({ nodeSchemas: listNodeSchemas() }))
  // 即时取帧（preview.frame 专用）：不执行全图、不落缓存 —— 点一下立即看到该秒的帧
  .post(
    "/graphs/:id/preview-frame",
    async ({ params, body, status }) => {
      const doc = serializeGraph(params.id);
      if (!doc) return status(404, "工作流不存在");
      const node = doc.nodes.find((n) => n.id === body.nodeId);
      if (!node || node.type !== "preview.frame") return status(400, "仅 preview.frame 节点支持即时取帧");
      // 上游视频：material.video 的素材 raw 文件
      const inEdge = doc.edges.find((e) => e.to_node === node.id && e.to_port === "video");
      const srcNode = inEdge ? doc.nodes.find((n) => n.id === inEdge.from_node) : null;
      if (!srcNode || srcNode.type !== "material.video") return status(400, "上游必须是视频素材节点");
      const row = db.query("SELECT raw_path FROM materials WHERE id = ?").get(String(srcNode.params.materialId ?? "")) as
        | { raw_path: string | null }
        | null;
      if (!row?.raw_path) return status(400, "视频素材不存在或未绑定");
      // 视频时长（量程）
      const probe = Bun.spawn(["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "json", row.raw_path], {
        stdout: "pipe", stderr: "pipe",
      });
      const [, pstdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
      let duration = 0;
      try {
        duration = Number(JSON.parse(pstdout).format?.duration) || 0;
      } catch {
        duration = 0;
      }
      const sampleTime = Math.max(0, Number(body.sampleTime ?? node.params.sampleTime ?? 0) || 0);
      const stagingId = uid();
      const outDir = join(STORAGE_ROOT, "staging", "preview_frame", stagingId);
      mkdirSync(outDir, { recursive: true });
      const out = join(outDir, "frame.png");
      try {
        await runCmd(["ffmpeg", "-y", "-ss", String(sampleTime), "-i", row.raw_path, "-frames:v", "1", out], undefined, undefined);
        if (!existsSync(out)) return status(400, `未能取到 ${sampleTime}s 的帧`);

        // ---- 沿下游链计算（立即预览 = 该帧过完整处理链，如抠图管线）----
        // 收集链：从 preview.frame 出发的下游；若无下游，用同源视频素材其他分支的最长 server 链
        const byId = new Map(doc.nodes.map((n) => [n.id, n]));
        const outgoing = (id: string) => doc.edges.filter((e) => e.from_node === id);
        const incoming = (id: string) => doc.edges.filter((e) => e.to_node === id);

        function downstreamChain(startId: string): string[] {
          // BFS 收集下游 server 节点（拓扑序自然由 BFS 层级保证：全部入边已处理的先算）
          const visited = new Set<string>();
          const order: string[] = [];
          const queue = [startId];
          while (queue.length) {
            const cur = queue.shift()!;
            for (const e of outgoing(cur)) {
              const nxt = e.to_node;
              if (visited.has(nxt)) continue;
              const node2 = byId.get(nxt);
              if (!node2) continue;
              const schema2 = getNodeSchema(node2.type);
              if (!schema2 || schema2.execution !== "server") continue; // 客户端节点跳过（需浏览器执行）
              if (node2.type.startsWith("export.")) continue; // 终端输出节点不跑
              if (node2.type === "frames.smart-select") continue; // 选帧改变数量，单帧预览无意义
              // 多输入节点（另一输入来自别处）跳过 —— 无法从单帧构造完整输入
              const otherInputs = incoming(nxt).filter((ie) => ie.from_node !== cur && ie.from_node !== startId);
              const schemaInputs = schema2.inputs.length;
              if (schemaInputs > 1 && otherInputs.length > 0) continue;
              visited.add(nxt);
              order.push(nxt);
              queue.push(nxt);
            }
          }
          return order;
        }

        let chain = downstreamChain(node.id);
        if (chain.length === 0) {
          // preview.frame 无下游：取视频素材的其他下游分支里最长的一条主链
          const siblingHeads = outgoing(srcNode.id)
            .map((e) => e.to_node)
            .filter((id) => id !== node.id && byId.get(id)?.type === "extract.frames");
          let best: string[] = [];
          for (const head of siblingHeads) {
            const c = downstreamChain(head);
            if (c.length > best.length) best = c;
          }
          chain = best;
        }

        // 逐节点执行（单帧、真实参数、临时目录、不落缓存）
        let currentPaths: string[] = [out];
        let appliedNodes: string[] = [];
        for (const stepId of chain) {
          const stepNode = byId.get(stepId)!;
          const stepDir = join(outDir, stepId);
          mkdirSync(stepDir, { recursive: true });
          try {
            const result = await runNode(
              stepNode,
              { images: { paths: currentPaths } },
              { signal: new AbortController().signal, outputDir: stepDir, report: () => {} }
            );
            const images = (result.images ?? {}) as { paths?: string[] };
            if (!images.paths?.length) break; // 该节点不产出帧（如仅分析）→ 链终止
            currentPaths = [images.paths[0]!];
            appliedNodes.push(stepNode.type);
          } catch {
            break; // 某步失败 → 预览停留在上一步结果
          }
        }

        const previewPath = currentPaths[0]!;
        return {
          previewUrl: `/api/graph/media?path=${encodeURIComponent(previewPath)}`,
          sampleTime,
          duration,
          appliedNodes, // 前端可显示"已过 N 个节点"
        };
      } finally {
        // 产物保留在 staging 供预览拉取；目录由 staging 清理策略统一处理
      }
    },
    { body: t.Object({ nodeId: t.String(), sampleTime: t.Optional(t.Number()) }) }
  )
  // 导入工作流：JSON（导出格式）→ 新图（节点按数组序重建，边按索引映射新 id）
  .post(
    "/graphs/import",
    ({ body, status }) => {
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      const edges = Array.isArray(body.edges) ? body.edges : [];
      if (nodes.length === 0) return status(400, "导入内容没有节点");
      // 类型与参数校验：未知类型整体拒绝（避免半成品图）
      for (const n of nodes) {
        if (!getNodeSchema(String(n.type))) return status(400, `未知节点类型: ${n.type}`);
      }
      const name = String(body.name ?? "").trim() || "导入的工作流";
      const graphId = uid();
      const newIds: string[] = [];
      db.transaction(() => {
        db.query("INSERT INTO graphs (id, name, folder_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(
          graphId, name, Date.now(), Date.now()
        );
        for (const n of nodes) {
          const id = uid();
          newIds.push(id);
          const params = n.params && typeof n.params === "object" ? n.params : {};
          db.query("INSERT INTO graph_nodes (id, graph_id, type, params, x, y) VALUES (?, ?, ?, ?, ?, ?)").run(
            id, graphId, String(n.type), JSON.stringify(structuredClone(params)),
            Number(n.x ?? 0) || 0, Number(n.y ?? 0) || 0
          );
        }
        for (const e of edges) {
          const fromIdx = Number(e.from);
          const toIdx = Number(e.to);
          if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) continue;
          if (fromIdx < 0 || fromIdx >= newIds.length || toIdx < 0 || toIdx >= newIds.length) continue;
          if (!portsCompatible(
            { type: String(nodes[fromIdx]!.type), port: String(e.fromPort) },
            { type: String(nodes[toIdx]!.type), port: String(e.toPort) }
          )) continue; // 端口不兼容的边丢弃（导入容错）
          db.query(
            "INSERT INTO graph_edges (id, graph_id, from_node, from_port, to_node, to_port) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(uid(), graphId, newIds[fromIdx]!, String(e.fromPort), newIds[toIdx]!, String(e.toPort));
        }
      })();
      broadcast("graphs_changed", { id: graphId });
      return { id: graphId };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        nodes: t.Array(
          t.Object({
            type: t.String(),
            params: t.Optional(t.Record(t.String(), t.Unknown())),
            x: t.Optional(t.Number()),
            y: t.Optional(t.Number()),
          })
        ),
        edges: t.Optional(
          t.Array(
            t.Object({
              from: t.Number(), // 源节点在 nodes 数组中的索引
              fromPort: t.String(),
              to: t.Number(), // 目标节点索引
              toPort: t.String(),
            })
          )
        ),
      }),
    }
  )
  // 执行记录（任务面板）：最近 20 条 + 当前运行中标记
  .get("/graph/runs", () => {
    const rows = db
      .query(
        `SELECT r.id, r.graph_id AS graphId, r.graph_name AS graphName, r.started_at AS startedAt,
                r.finished_at AS finishedAt, r.status
         FROM graph_runs r ORDER BY r.started_at DESC LIMIT 20`
      )
      .all() as Array<{ id: string; graphId: string; graphName: string; startedAt: number; finishedAt: number | null; status: string }>;
    // 每条记录的节点统计（done/cached/error 数）
    const withStats = rows.map((r) => {
      const row = db.query("SELECT node_states FROM graph_runs WHERE id = ?").get(r.id) as { node_states: string } | null;
      let done = 0, cached = 0, error = 0, total = 0;
      try {
        const states = JSON.parse(row?.node_states ?? "[]") as Array<{ status: string }>;
        total = states.length;
        done = states.filter((s) => s.status === "done").length;
        cached = states.filter((s) => s.status === "skipped-cache").length;
        error = states.filter((s) => s.status === "error").length;
      } catch {
        /* 运行中无 node_states */
      }
      return { ...r, nodeStats: { total, done, cached, error } };
    });
    return { runs: withStats };
  })
  // 工作流模板清单
  .get("/graph/templates", () => ({
    templates: GRAPH_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })),
  })
  )
  // 从模板建图：节点 + 连线一次成型
  .post(
    "/graph/templates/:templateId/graphs",
    ({ params, body, status }) => {
      const template = GRAPH_TEMPLATES.find((t) => t.id === params.templateId);
      if (!template) return status(404, "模板不存在");
      const name = (body.name ?? template.name).trim() || template.name;
      const graphId = uid();
      const nodeIds = new Map<string, string>();
      db.transaction(() => {
        db.query("INSERT INTO graphs (id, name, folder_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(
          graphId, name, Date.now(), Date.now()
        );
        for (const n of template.nodes) {
          const id = uid();
          nodeIds.set(n.key, id);
          // 模板 params 深拷贝，避免共享引用
          db.query("INSERT INTO graph_nodes (id, graph_id, type, params, x, y) VALUES (?, ?, ?, ?, ?, ?)").run(
            id, graphId, n.type, JSON.stringify(structuredClone(n.params)), n.x, n.y
          );
        }
        for (const e of template.edges) {
          const fromNode = nodeIds.get(e.from);
          const toNode = nodeIds.get(e.to);
          if (!fromNode || !toNode) continue;
          db.query(
            "INSERT INTO graph_edges (id, graph_id, from_node, from_port, to_node, to_port) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(uid(), graphId, fromNode, e.fromPort, toNode, e.toPort);
        }
      })();
      broadcast("graphs_changed", { id: graphId });
      return { id: graphId };
    },
    { body: t.Object({ name: t.Optional(t.String()) }) }
  )
  .get("/graphs", () => {
    const rows = db.query("SELECT * FROM graphs ORDER BY created_at DESC").all();
    return { graphs: rows };
  })
  .post(
    "/graphs",
    ({ body, status }) => {
      const id = uid();
      db.query("INSERT INTO graphs (id, name, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        body.name.trim() || "未命名工作流",
        null,
        Date.now(),
        Date.now()
      );
      broadcast("graphs_changed", { id });
      return { id };
    },
    { body: t.Object({ name: t.String() }) }
  )
  .get("/graphs/:id", ({ params, status }) => {
    const doc = serializeGraph(params.id);
    if (!doc) return status(404, "工作流不存在");
    return doc;
  })
  .patch(
    "/graphs/:id",
    ({ params, body, status }) => {
      if (!getGraphRow(params.id)) return status(404, "工作流不存在");
      if (body.name !== undefined) {
        db.query("UPDATE graphs SET name = ? WHERE id = ?").run(body.name.trim() || "未命名工作流", params.id);
      }
      touchGraph(params.id);
      broadcast("graphs_changed", { id: params.id });
      return { ok: true };
    },
    { body: t.Object({ name: t.Optional(t.String()) }) }
  )
  .delete("/graphs/:id", ({ params, status }) => {
    if (!getGraphRow(params.id)) return status(404, "工作流不存在");
    db.transaction(() => {
      db.query("DELETE FROM graph_edges WHERE graph_id = ?").run(params.id);
      db.query("DELETE FROM graph_nodes WHERE graph_id = ?").run(params.id);
      db.query("DELETE FROM graphs WHERE id = ?").run(params.id);
    })();
    broadcast("graphs_changed", { id: params.id });
    return { ok: true };
  })
  // ===== 节点 =====
  .post(
    "/graphs/:id/nodes",
    ({ params, body, status }) => {
      if (!getGraphRow(params.id)) return status(404, "工作流不存在");
      if (!getNodeSchema(body.type)) return status(400, `未知节点类型: ${body.type}`);
      const id = uid();
      db.query("INSERT INTO graph_nodes (id, graph_id, type, params, x, y) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        params.id,
        body.type,
        JSON.stringify(body.params ?? {}),
        body.x ?? 0,
        body.y ?? 0
      );
      touchGraph(params.id);
      broadcast("graphs_changed", { id: params.id });
      return { nodeId: id };
    },
    {
      body: t.Object({
        type: t.String(),
        params: t.Optional(t.Record(t.String(), t.Unknown())),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
      }),
    }
  )
  .patch(
    "/graphs/:id/nodes/:nodeId",
    ({ params, body, status }) => {
      const node = getGraphNode(params.nodeId, params.id);
      if (!node) return status(404, "节点不存在");
      if (body.params !== undefined) {
        db.query("UPDATE graph_nodes SET params = ? WHERE id = ?").run(JSON.stringify(body.params), params.nodeId);
      }
      if (body.x !== undefined && body.y !== undefined) {
        db.query("UPDATE graph_nodes SET x = ?, y = ? WHERE id = ?").run(body.x, body.y, params.nodeId);
      }
      touchGraph(params.id);
      broadcast("graphs_changed", { id: params.id });
      return { ok: true };
    },
    {
      body: t.Object({
        params: t.Optional(t.Record(t.String(), t.Unknown())),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
      }),
    }
  )
  .delete("/graphs/:id/nodes/:nodeId", ({ params, status }) => {
    const node = getGraphNode(params.nodeId, params.id);
    if (!node) return status(404, "节点不存在");
    db.transaction(() => {
      db.query("DELETE FROM graph_edges WHERE from_node = ? OR to_node = ?").run(params.nodeId, params.nodeId);
      db.query("DELETE FROM graph_nodes WHERE id = ?").run(params.nodeId);
    })();
    touchGraph(params.id);
    broadcast("graphs_changed", { id: params.id });
    return { ok: true };
  })
  // ===== 边（连线）=====
  .post(
    "/graphs/:id/edges",
    ({ params, body, status }) => {
      if (!getGraphRow(params.id)) return status(404, "工作流不存在");
      const from = getGraphNode(body.fromNode, params.id);
      const to = getGraphNode(body.toNode, params.id);
      if (!from || !to) return status(404, "节点不存在");
      if (from.id === to.id) return status(400, "不能连接到自身");
      // 端口类型校验：不匹配拒绝连线
      if (!portsCompatible({ type: from.type, port: body.fromPort }, { type: to.type, port: body.toPort })) {
        return status(400, "端口类型不匹配");
      }
      // 单输入端口重复连线由 UNIQUE(to_node, to_port) 兜底
      const id = uid();
      try {
        db.query(
          "INSERT INTO graph_edges (id, graph_id, from_node, from_port, to_node, to_port) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(id, params.id, body.fromNode, body.fromPort, body.toNode, body.toPort);
      } catch {
        return status(409, "目标端口已有连线");
      }
      touchGraph(params.id);
      broadcast("graphs_changed", { id: params.id });
      return { edgeId: id };
    },
    {
      body: t.Object({
        fromNode: t.String(),
        fromPort: t.String(),
        toNode: t.String(),
        toPort: t.String(),
      }),
    }
  )
  .delete("/graphs/:id/edges/:edgeId", ({ params, status }) => {
    const row = db.query("SELECT id FROM graph_edges WHERE id = ? AND graph_id = ?").get(params.edgeId, params.id);
    if (!row) return status(404, "连线不存在");
    db.query("DELETE FROM graph_edges WHERE id = ?").run(params.edgeId);
    touchGraph(params.id);
    broadcast("graphs_changed", { id: params.id });
    return { ok: true };
  })
  // ===== 执行 =====
  .post(
    "/graphs/:id/run",
    async ({ params, status }) => {
      const doc = serializeGraph(params.id);
      if (!doc) return status(404, "工作流不存在");
      if (doc.nodes.length === 0) return status(400, "图中没有节点");
      if (isGraphRunning(params.id)) return status(409, "该工作流已在执行中");
      ensureGraphStorage();
      // 异步执行；进度走 WS graph_node_status，结果轮询 /graphs/:id/status
      const nodes: GraphNode[] = doc.nodes.map((n) => ({
        id: n.id,
        graph_id: n.graph_id,
        type: n.type,
        params: n.params,
        x: n.x,
        y: n.y,
      }));
      const edges = doc.edges as GraphEdge[];
      runGraph(params.id, { nodes, edges }).catch((err) => {
        console.error(`[graph ${params.id}] 执行失败:`, err instanceof Error ? err.message : err);
      });
      return { ok: true };
    }
  )
  .post("/graphs/:id/cancel", ({ params, status }) => {
    if (!getGraphRow(params.id)) return status(404, "工作流不存在");
    if (!cancelGraphRun(params.id)) return status(409, "没有进行中的执行");
    return { ok: true };
  })
  .get("/graphs/:id/running", ({ params, status }) => {
    if (!getGraphRow(params.id)) return status(404, "工作流不存在");
    return { running: isGraphRunning(params.id) };
  })
  // ===== 客户端节点执行通道 =====
  // 受限媒体：仅允许 storage/graph 与 storage/materials 下的文件（路径穿越防护）
  .get("/graph/media", ({ request, status, query }) => {
    const path = String(query.path ?? "");
    const normalized = path.replaceAll("\\", "/");
    if (!(normalized.startsWith("D:/") || /^[A-Za-z]:\//.test(normalized))) return status(400, "非法路径");
    const allowed = [
      join(STORAGE_ROOT, "graph").replaceAll("\\", "/"),
      join(STORAGE_ROOT, "materials").replaceAll("\\", "/"),
      join(STORAGE_ROOT, "staging", "preview_frame").replaceAll("\\", "/"), // 即时取帧产物
    ];
    if (!allowed.some((root) => normalized.startsWith(root))) return status(403, "路径不在允许范围内");
    if (!existsSync(path)) return status(404, "文件不存在");
    const contentType = /\.(mov|mp4)$/i.test(path)
      ? "video/quicktime"
      : /\.webp$/i.test(path)
        ? "image/webp"
        : /\.(zip|json|xml|plist|tres)$/i.test(path)
          ? "application/octet-stream"
          : "image/png";
    if (query.download) {
      // 下载：attachment + 文件名（导出产物的「另存为」）
      const name = path.split(/[\/]/).pop() ?? "download";
      const file = Bun.file(path);
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
        },
      });
    }
    return serveMediaFile(path, request, contentType);
  })
  // 列出产物目录内容（导出节点的产物清单 UI）
  .get("/graph/list-dir", ({ query, status }) => {
    const dir = String(query.path ?? "").replaceAll("\\", "/");
    const allowedRoot = join(STORAGE_ROOT, "graph", "outputs").replaceAll("\\", "/");
    if (!dir.startsWith(allowedRoot)) return status(403, "只能列导出产物目录");
    if (!existsSync(dir)) return status(404, "目录不存在");
    const entries = readdirSync(dir)
      .filter((f) => f !== "inputs.txt")
      .map((f) => {
        const full = join(dir, f);
        const isDir = statSync(full).isDirectory();
        return { name: f, isDir, size: isDir ? 0 : statSync(full).size };
      })
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { entries };
  })
  // 保存产物到自定义目录（复制整个产物目录）
  .post(
    "/graph/save-artifacts",
    async ({ body, status }) => {
      const src = String(body.path ?? "").replaceAll("\\", "/");
      const target = String(body.targetDir ?? "").replaceAll("\\", "/");
      if (!src.startsWith(join(STORAGE_ROOT, "graph", "outputs").replaceAll("\\", "/"))) {
        return status(403, "只能保存导出产物目录");
      }
      if (!target || !/^[A-Za-z]:\//.test(target)) return status(400, "目标目录无效（需要绝对路径）");
      if (!existsSync(src)) return status(404, "产物目录不存在");
      // 目标：<targetDir>/<产物目录名>（已存在则覆盖合并）
      const srcName = src.split("/").pop() || "artifacts";
      const dst = join(target, srcName);
      const { cpSync, mkdirSync } = await import("node:fs");
      mkdirSync(target, { recursive: true });
      cpSync(src, dst, { recursive: true, force: true });
      return { ok: true, savedTo: dst };
    },
    { body: t.Object({ path: t.String(), targetDir: t.String() }) }
  )
  // 打开产物文件夹（资源管理器直达；对齐 sprite open_path_in_file_browser）
  .post(
    "/graph/open-folder",
    async ({ body, status }) => {
      const dir = String(body.path ?? "").replaceAll("\\", "/");
      const allowedRoot = join(STORAGE_ROOT, "graph", "outputs").replaceAll("\\", "/");
      if (!dir.startsWith(allowedRoot)) return status(403, "只能打开导出产物目录");
      if (!existsSync(dir)) return status(404, "目录不存在");
      // Windows 打开目录（对齐 sprite open_path_in_file_browser 的 os.startfile 语义）：
      // explorer 直接吃正斜杠会失败回落到"文档"，必须反斜杠原生路径
      const native = dir.replaceAll("/", "\\");
      const proc = Bun.spawn({
        cmd: ["explorer", native],
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
      return { ok: true };
    },
    { body: t.Object({ path: t.String() }) }
  )
  // 客户端节点产物上传（PNG 二进制 body）；文件名由 query 指定（quant_0000.png 等）
  .post(
    "/graphs/:id/client-result/:taskId",
    async ({ params, request, status, query }) => {
      const fileName = String(query.name ?? "");
      if (!/^[\w.-]+\.png$/i.test(fileName)) return status(400, "非法文件名");
      // 任务是否存在与落盘目录由 executor 的 clientTasks 管理；产物目录需可寻址 —— 通过 taskId 查表
      const dir = clientTaskOutputDir(params.taskId);
      if (!dir) return status(404, "任务不存在或已完成");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length || bytes.length > 32 * 1024 * 1024) return status(400, "文件大小需在 32MB 以内");
      mkdirSync(dir, { recursive: true });
      await Bun.write(join(dir, fileName), bytes);
      return { ok: true };
    }
  )
  // 客户端节点完成标记（文件型 fileNames / 分析型 outputs；error 非空表示客户端失败）
  .post(
    "/graphs/:id/client-result/:taskId/complete",
    ({ params, body, status }) => {
      if (!resolveClientTask(params.taskId, body.fileNames ?? [], body.error, body.outputs)) {
        return status(404, "任务不存在或已完成");
      }
      return { ok: true };
    },
    {
      body: t.Object({
        fileNames: t.Optional(t.Array(t.String())),
        error: t.Optional(t.String()),
        outputs: t.Optional(t.Record(t.String(), t.Record(t.String(), t.Unknown()))),
      }),
    }
  );
