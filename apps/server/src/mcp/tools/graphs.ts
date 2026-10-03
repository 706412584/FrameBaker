import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { GraphEdge, GraphNode } from "@framebaker/shared";
import { db, uid } from "../../db";
import { getNodeSchema, listNodeSchemas, portsCompatible } from "../../graph/registry";
import { cancelGraphRun, ensureGraphStorage, isGraphRunning, runGraph } from "../../graph/executor";
import { GRAPH_TEMPLATES } from "../../graph/templates";
import { serializeGraph } from "../../api/graphs";
import { broadcast } from "../../ws";
import { ok, err } from "../helpers";

function graphExists(id: string): boolean {
  return !!db.query("SELECT 1 FROM graphs WHERE id = ?").get(id);
}

function touchGraph(id: string): void {
  db.query("UPDATE graphs SET updated_at = ? WHERE id = ?").run(Date.now(), id);
}

function nodeRow(id: string, graphId: string) {
  const row = db.query("SELECT id, type, params FROM graph_nodes WHERE id = ? AND graph_id = ?").get(id, graphId) as
    | { id: string; type: string; params: string | null }
    | null;
  return row ?? null;
}

export function register(server: McpServer) {
  server.registerTool(
    "list_graph_node_schemas",
    {
      title: "List Graph Node Schemas",
      description:
        "List all available workflow node types (type, label, inputs, outputs, paramsSchema, execution site) for the infinite-canvas graph editor.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ok({ nodeSchemas: listNodeSchemas() })
  );

  server.registerTool(
    "list_graphs",
    {
      title: "List Graphs",
      description: "List all workflow graphs (id, name, created_at, updated_at), newest first.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ok({ graphs: db.query("SELECT * FROM graphs ORDER BY created_at DESC").all() })
  );

  server.registerTool(
    "create_graph",
    {
      title: "Create Graph",
      description: "Create an empty workflow graph (infinite canvas). Returns graph id.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200).describe("Graph name"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name }) => {
      const id = uid();
      db.query("INSERT INTO graphs (id, name, folder_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(
        id,
        name,
        Date.now(),
        Date.now()
      );
      broadcast("graphs_changed", { id });
      return ok({ graphId: id });
    }
  );

  server.registerTool(
    "get_graph",
    {
      title: "Get Graph",
      description:
        "Get one workflow graph document: graph meta, all nodes (with parsed params and canvas position) and all edges.",
      inputSchema: z.object({ graphId: z.string().describe("Graph UUID") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ graphId }) => {
      // 复用 serializeGraph：与 GET /graphs/:id 一致（含节点产物预览 previewUrl / frameUrls / outputDir）
      const doc = serializeGraph(graphId);
      if (!doc) return err("工作流不存在");
      return ok(doc);
    }
  );

  server.registerTool(
    "add_graph_node",
    {
      title: "Add Graph Node",
      description:
        "Add one node to a graph. Node type must exist in the node registry; params must match the node's paramsSchema.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph UUID"),
        type: z.string().describe("Node type, e.g. material.video / extract.frames / matte.batch / export.spritesheet"),
        params: z.record(z.string(), z.unknown()).optional().describe("Node params object"),
        x: z.number().optional().describe("Canvas x"),
        y: z.number().optional().describe("Canvas y"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ graphId, type, params, x, y }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      if (!getNodeSchema(type)) return err(`未知节点类型: ${type}`);
      const id = uid();
      db.query("INSERT INTO graph_nodes (id, graph_id, type, params, x, y) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        graphId,
        type,
        JSON.stringify(params ?? {}),
        x ?? 0,
        y ?? 0
      );
      touchGraph(graphId);
      broadcast("graphs_changed", { id: graphId });
      return ok({ nodeId: id });
    }
  );

  server.registerTool(
    "update_graph_node",
    {
      title: "Update Graph Node",
      description:
        "Update one node's params and/or canvas position (the key tool for wiring a node after creation — e.g. set a material.video node's materialId). params REPLACES the node's whole params object, so pass the complete params (merge client-side if you only want to change one field). Note: node type is immutable; delete + re-add to change type. Marks the graph updated and broadcasts graphs_changed.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph UUID"),
        nodeId: z.string().describe("Node UUID"),
        params: z.record(z.string(), z.unknown()).optional().describe("Full replacement params object (merged with nothing — include all fields you want kept)"),
        x: z.number().optional().describe("Canvas x (must be provided together with y)"),
        y: z.number().optional().describe("Canvas y (must be provided together with x)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ graphId, nodeId, params, x, y }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      const node = nodeRow(nodeId, graphId);
      if (!node) return err("节点不存在");
      if (params === undefined && (x === undefined || y === undefined)) {
        return err("没有可更新字段（提供 params，或同时提供 x 与 y）");
      }
      // 坐标必须成对：只给 x 或只给 y 时静默丢弃会让调用方误以为已生效
      if ((x === undefined) !== (y === undefined)) {
        return err("坐标必须同时提供 x 与 y");
      }
      if (params !== undefined) {
        db.query("UPDATE graph_nodes SET params = ? WHERE id = ?").run(JSON.stringify(params), nodeId);
      }
      if (x !== undefined && y !== undefined) {
        db.query("UPDATE graph_nodes SET x = ?, y = ? WHERE id = ?").run(x, y, nodeId);
      }
      touchGraph(graphId);
      broadcast("graphs_changed", { id: graphId });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "delete_graph_node",
    {
      title: "Delete Graph Node",
      description:
        "Delete one node and every edge connected to it (both input and output) in a single transaction. Marks the graph updated and broadcasts graphs_changed.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph UUID"),
        nodeId: z.string().describe("Node UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ graphId, nodeId }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      if (!nodeRow(nodeId, graphId)) return err("节点不存在");
      db.transaction(() => {
        db.query("DELETE FROM graph_edges WHERE from_node = ? OR to_node = ?").run(nodeId, nodeId);
        db.query("DELETE FROM graph_nodes WHERE id = ?").run(nodeId);
      })();
      touchGraph(graphId);
      broadcast("graphs_changed", { id: graphId });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "connect_graph_nodes",
    {
      title: "Connect Graph Nodes",
      description:
        "Create an edge (connection) between two nodes. Validates port type compatibility (mismatch rejected) and one-edge-per-input-port.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph UUID"),
        fromNode: z.string().describe("Source node id"),
        fromPort: z.string().describe("Source output port name"),
        toNode: z.string().describe("Target node id"),
        toPort: z.string().describe("Target input port name"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ graphId, fromNode, fromPort, toNode, toPort }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      const from = nodeRow(fromNode, graphId);
      const to = nodeRow(toNode, graphId);
      if (!from || !to) return err("节点不存在");
      if (from.id === to.id) return err("不能连接到自身");
      if (!portsCompatible({ type: from.type, port: fromPort }, { type: to.type, port: toPort })) {
        return err("端口类型不匹配");
      }
      const id = uid();
      try {
        db.query(
          "INSERT INTO graph_edges (id, graph_id, from_node, from_port, to_node, to_port) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(id, graphId, fromNode, fromPort, toNode, toPort);
      } catch {
        return err("目标端口已有连线");
      }
      touchGraph(graphId);
      broadcast("graphs_changed", { id: graphId });
      return ok({ edgeId: id });
    }
  );

  server.registerTool(
    "delete_graph_edge",
    {
      title: "Delete Graph Edge",
      description:
        "Delete one edge (connection) between two nodes by its edgeId. Use get_graph to list current edges and their ids. Marks the graph updated and broadcasts graphs_changed.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph UUID"),
        edgeId: z.string().describe("Edge UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ graphId, edgeId }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      const row = db.query("SELECT id FROM graph_edges WHERE id = ? AND graph_id = ?").get(edgeId, graphId);
      if (!row) return err("连线不存在");
      db.query("DELETE FROM graph_edges WHERE id = ?").run(edgeId);
      touchGraph(graphId);
      broadcast("graphs_changed", { id: graphId });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "delete_graph",
    {
      title: "Delete Graph",
      description: "Delete a workflow graph with all its nodes and edges. Graph outputs cache is kept (shared by content hash).",
      inputSchema: z.object({ graphId: z.string().describe("Graph UUID") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ graphId }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      db.transaction(() => {
        db.query("DELETE FROM graph_edges WHERE graph_id = ?").run(graphId);
        db.query("DELETE FROM graph_nodes WHERE graph_id = ?").run(graphId);
        db.query("DELETE FROM graphs WHERE id = ?").run(graphId);
      })();
      broadcast("graphs_changed", { id: graphId });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "update_graph",
    {
      title: "Update Graph",
      description: "Rename a workflow graph. Empty/whitespace name falls back to '未命名工作流'. Marks the graph updated and broadcasts graphs_changed.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph UUID"),
        name: z.string().describe("New graph name"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ graphId, name }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      db.query("UPDATE graphs SET name = ? WHERE id = ?").run(name.trim() || "未命名工作流", graphId);
      touchGraph(graphId);
      broadcast("graphs_changed", { id: graphId });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "list_graph_templates",
    {
      title: "List Graph Templates",
      description:
        "List built-in workflow templates (id, name, description). Use the id with create_graph_from_template to instantiate a ready-made pipeline (e.g. the sprite video-extraction pipeline).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ok({ templates: GRAPH_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })) })
  );

  server.registerTool(
    "create_graph_from_template",
    {
      title: "Create Graph From Template",
      description:
        "Instantiate a built-in workflow template into a new graph (nodes + edges + preset params created in one transaction). Get template ids from list_graph_templates. name defaults to the template name. Returns the new graphId.",
      inputSchema: z.object({
        templateId: z.string().describe("Template id from list_graph_templates"),
        name: z.string().optional().describe("New graph name (defaults to the template name)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ templateId, name }) => {
      const template = GRAPH_TEMPLATES.find((t) => t.id === templateId);
      if (!template) return err("模板不存在");
      const graphName = (name ?? template.name).trim() || template.name;
      const graphId = uid();
      const nodeIds = new Map<string, string>();
      db.transaction(() => {
        db.query("INSERT INTO graphs (id, name, folder_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(
          graphId,
          graphName,
          Date.now(),
          Date.now()
        );
        for (const n of template.nodes) {
          const id = uid();
          nodeIds.set(n.key, id);
          db.query("INSERT INTO graph_nodes (id, graph_id, type, params, x, y) VALUES (?, ?, ?, ?, ?, ?)").run(
            id,
            graphId,
            n.type,
            JSON.stringify(structuredClone(n.params)),
            n.x,
            n.y
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
      return ok({ graphId, name: graphName });
    }
  );

  server.registerTool(
    "import_graph",
    {
      title: "Import Graph",
      description:
        "Import a workflow from a JSON document (same shape as the canvas export: nodes with type/params/x/y and edges referencing node array indices via from/to). Unknown node types reject the WHOLE import; port-incompatible edges are silently dropped (import tolerance). Material ids do not survive across installs — re-select materials after import. Returns the new graphId.",
      inputSchema: z.object({
        name: z.string().optional().describe("New graph name (defaults to '导入的工作流')"),
        nodes: z.array(
          z.object({
            type: z.string().describe("Node type (must exist in the registry)"),
            params: z.record(z.string(), z.unknown()).optional(),
            x: z.number().optional(),
            y: z.number().optional(),
          })
        ).describe("Node list (index order defines edge references)"),
        edges: z.array(
          z.object({
            // 用 z.number 而非 z.number().int()：与 REST 一致，非整数索引在运行时跳过该边，而非整个调用被 schema 拒绝
            from: z.number().describe("Index into nodes (source)"),
            fromPort: z.string(),
            to: z.number().describe("Index into nodes (target)"),
            toPort: z.string(),
          })
        ).optional().describe("Edge list; index-based references into nodes"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, nodes, edges }) => {
      if (nodes.length === 0) return err("导入内容没有节点");
      for (const n of nodes) {
        if (!getNodeSchema(String(n.type))) return err(`未知节点类型: ${n.type}`);
      }
      const graphName = String(name ?? "").trim() || "导入的工作流";
      const graphId = uid();
      const newIds: string[] = [];
      db.transaction(() => {
        db.query("INSERT INTO graphs (id, name, folder_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(
          graphId,
          graphName,
          Date.now(),
          Date.now()
        );
        for (const n of nodes) {
          const id = uid();
          newIds.push(id);
          const params = n.params && typeof n.params === "object" ? n.params : {};
          db.query("INSERT INTO graph_nodes (id, graph_id, type, params, x, y) VALUES (?, ?, ?, ?, ?, ?)").run(
            id,
            graphId,
            String(n.type),
            JSON.stringify(structuredClone(params)),
            Number(n.x ?? 0) || 0,
            Number(n.y ?? 0) || 0
          );
        }
        // 去重键：单输入端口唯一（graph_edges UNIQUE(to_node,to_port)）。脏 JSON 里两条边指向
        // 同一输入端口时，若直接 INSERT 会抛错 → 整个事务回滚，与「容错导入」承诺相悖。
        const usedInputPorts = new Set<string>();
        for (const e of edges ?? []) {
          if (!Number.isInteger(e.from) || !Number.isInteger(e.to)) continue;
          if (e.from < 0 || e.from >= newIds.length || e.to < 0 || e.to >= newIds.length) continue;
          if (
            !portsCompatible(
              { type: String(nodes[e.from]!.type), port: String(e.fromPort) },
              { type: String(nodes[e.to]!.type), port: String(e.toPort) }
            )
          ) {
            continue; // 端口不兼容的边丢弃（导入容错）
          }
          const inputKey = `${newIds[e.to]!}\u0000${String(e.toPort)}`;
          if (usedInputPorts.has(inputKey)) continue; // 重复输入端口丢弃
          usedInputPorts.add(inputKey);
          db.query(
            "INSERT OR IGNORE INTO graph_edges (id, graph_id, from_node, from_port, to_node, to_port) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(uid(), graphId, newIds[e.from]!, String(e.fromPort), newIds[e.to]!, String(e.toPort));
        }
      })();
      broadcast("graphs_changed", { id: graphId });
      return ok({ graphId, name: graphName, nodeCount: newIds.length });
    }
  );

  server.registerTool(
    "run_graph",
    {
      title: "Run Graph",
      description:
        "Execute a workflow graph asynchronously (topological order, per-node caching by content hash). Progress is broadcast via WS graph_node_status; poll get_graph_run_status / list_jobs. Client-executed nodes (quantize/slice) require the web canvas connected — server nodes (extract/matte/export/generate) run headless. Returns error if graph is empty or already running.",
      inputSchema: z.object({ graphId: z.string().describe("Graph UUID") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ graphId }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      const doc = serializeGraph(graphId);
      if (!doc) return err("工作流不存在");
      if (doc.nodes.length === 0) return err("图中没有节点");
      if (isGraphRunning(graphId)) return err("该工作流已在执行中");
      ensureGraphStorage();
      const nodes: GraphNode[] = doc.nodes.map((n) => ({
        id: n.id,
        graph_id: n.graph_id,
        type: n.type,
        params: n.params,
        x: n.x,
        y: n.y,
      }));
      const edges = doc.edges as GraphEdge[];
      runGraph(graphId, { nodes, edges }).catch((e) => {
        console.error(`[graph ${graphId}] MCP 触发执行失败:`, e instanceof Error ? e.message : e);
      });
      return ok({ ok: true, running: true });
    }
  );

  server.registerTool(
    "cancel_graph_run",
    {
      title: "Cancel Graph Run",
      description: "Cancel the running execution of a workflow graph (aborts node subprocesses).",
      inputSchema: z.object({ graphId: z.string().describe("Graph UUID") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ graphId }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      if (!cancelGraphRun(graphId)) return err("没有进行中的执行");
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "get_graph_run_status",
    {
      title: "Get Graph Run Status",
      description:
        "Latest run of a graph: status (running/done/error) and per-node states (nodeId, type, status, error, elapsed). Also current running flag. Use after run_graph to poll completion.",
      inputSchema: z.object({ graphId: z.string().describe("Graph UUID") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ graphId }) => {
      if (!graphExists(graphId)) return err("工作流不存在");
      const run = db
        .query("SELECT * FROM graph_runs WHERE graph_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(graphId) as { id: string; status: string; started_at: number; finished_at: number | null; node_states: string } | undefined;
      if (!run) return ok({ running: isGraphRunning(graphId), run: null });
      let nodeStates: unknown = [];
      try {
        nodeStates = JSON.parse(run.node_states);
      } catch {
        /* ignore */
      }
      return ok({
        running: isGraphRunning(graphId),
        run: { id: run.id, status: run.status, startedAt: run.started_at, finishedAt: run.finished_at, nodeStates },
      });
    }
  );
}
