import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { GraphEdge, GraphNode } from "@framebaker/shared";
import { db, uid } from "../../db";
import { getNodeSchema, listNodeSchemas, portsCompatible } from "../../graph/registry";
import { cancelGraphRun, ensureGraphStorage, isGraphRunning, runGraph } from "../../graph/executor";
import { serializeGraph } from "../../api/graphs";
import { ok, err } from "../helpers";

function graphExists(id: string): boolean {
  return !!db.query("SELECT 1 FROM graphs WHERE id = ?").get(id);
}

function nodeRow(id: string, graphId: string) {
  const row = db.query("SELECT * FROM graph_nodes WHERE id = ? AND graph_id = ?").get(id, graphId) as
    | { id: string; type: string }
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
      if (!graphExists(graphId)) return err("工作流不存在");
      const graph = db.query("SELECT * FROM graphs WHERE id = ?").get(graphId);
      const nodes = (db.query("SELECT * FROM graph_nodes WHERE graph_id = ? ORDER BY id").all(graphId) as Array<
        { params: string } & Record<string, unknown>
      >).map((row) => {
        let params: unknown = {};
        try {
          params = JSON.parse(row.params);
        } catch {
          /* ignore */
        }
        return { ...row, params };
      });
      const edges = db.query("SELECT * FROM graph_edges WHERE graph_id = ? ORDER BY id").all(graphId);
      return ok({ graph, nodes, edges });
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
      return ok({ nodeId: id });
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
      return ok({ edgeId: id });
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
      return ok({ ok: true });
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
