import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { serve } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../apps/server/src/app";
import { STORAGE_ROOT } from "../apps/server/src/db";
import { MCP_TOOL_NAMES } from "../apps/server/src/mcp/index";

const BASE = "http://localhost:3998";
let server: ReturnType<typeof serve>;

beforeAll(() => {
  server = serve({ port: 3998, fetch: app.handle });
});

afterAll(() => {
  server.stop();
});

function parseSseJson(text: string): any {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return null;
}

async function mcp(body: unknown): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") ?? "";
  let json: any = null;
  if (ct.includes("text/event-stream")) {
    json = parseSseJson(await res.text());
  } else if (ct.includes("application/json")) {
    try {
      json = await res.json();
    } catch {
      /* empty */
    }
  }
  return { status: res.status, json, headers: res.headers };
}

describe("MCP 端点", () => {
  test("initialize 握手返回协议版本与服务端信息", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    expect(json.result.protocolVersion).toBeTruthy();
    expect(json.result.serverInfo.name).toBe("framebaker");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  test("tools/list 返回全部工具", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(json.result.tools.length).toBeGreaterThan(0);
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("create_project");
    expect(names).toContain("generate_frames");
    expect(names).toContain("get_config");
    expect(names).toContain("rename_material");
    expect(names).toContain("import_local_material");
    const tool = json.result.tools.find((t: any) => t.name === "list_projects");
    expect(tool.description).toBeTruthy();
    // MCP_TOOL_NAMES 必须与实际注册一一对应（AGENTS.md 约定）；数量与集合双向校验
    expect(json.result.tools.length).toBe(MCP_TOOL_NAMES.length);
    expect(new Set(names)).toEqual(new Set(MCP_TOOL_NAMES));
  });

  test("tools/call create_project + list_projects 端到端", async () => {
    const projectName = `MCP测试-${crypto.randomUUID()}`;
    let projectId: string | null = null;
    try {
      const { json: create } = await mcp({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "create_project", arguments: { name: projectName } },
      });
      const created = JSON.parse(create.result.content[0].text);
      projectId = created.id;
      expect(created.name).toBe(projectName);
      expect(projectId).toBeTruthy();

      const { json: list } = await mcp({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      });
      const listed = JSON.parse(list.result.content[0].text);
      expect(listed.projects.length).toBeGreaterThanOrEqual(1);
      expect(listed.projects.some((p: any) => p.id === projectId && p.name === projectName)).toBe(true);
    } finally {
      // MCP 测试连接的是开发数据库；必须清理自己的项目，避免测试卡片残留到真实项目列表。
      if (projectId) {
        await mcp({
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: { name: "delete_project", arguments: { projectId } },
        });
      }
    }
  });

  test("tools/call import_local_material 把本地文件登记为素材", async () => {
    const dir = join(STORAGE_ROOT, `test-mcp-import-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "wolf.mp4");
    writeFileSync(src, "fake-video-bytes");
    let materialId: string | null = null;
    try {
      const { json: call } = await mcp({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "import_local_material", arguments: { path: src, name: "MCP青狼" } },
      });
      const result = JSON.parse(call.result.content[0].text);
      materialId = result.materialId;
      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
      expect(result.materials[0].kind).toBe("video");
      expect(result.materials[0].source).toBe("file");
      expect(result.materials[0].name).toBe("MCP青狼");

      // 登记后能被 list_materials 看到
      const { json: list } = await mcp({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "list_materials", arguments: {} },
      });
      const listed = JSON.parse(list.result.content[0].text);
      expect(listed.materials.some((m: any) => m.id === materialId && m.kind === "video" && m.source === "file")).toBe(true);
    } finally {
      // 连接的是开发数据库：清理自己的素材行 + 磁盘文件
      if (materialId) {
        await mcp({
          jsonrpc: "2.0",
          id: 31,
          method: "tools/call",
          params: { name: "batch_delete_materials", arguments: { ids: [materialId] } },
        });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tools/call 图工作流：建节点 → 改 params → 连线 → 删边 → 删节点", async () => {
    let graphId: string | null = null;
    try {
      const { json: create } = await mcp({
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: { name: "create_graph", arguments: { name: `MCP图测试-${crypto.randomUUID()}` } },
      });
      graphId = JSON.parse(create.result.content[0].text).graphId;
      expect(graphId).toBeTruthy();

      // 建 material.video 节点（先不带 materialId）
      const { json: add } = await mcp({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: { name: "add_graph_node", arguments: { graphId, type: "material.video", params: {} } },
      });
      const nodeId = JSON.parse(add.result.content[0].text).nodeId;

      // 关键能力：建完之后改 params（此前只能用 add 一次性带 params，建完就改不了）
      const { json: upd } = await mcp({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "update_graph_node", arguments: { graphId, nodeId, params: { materialId: "wolf-1" } } },
      });
      expect(JSON.parse(upd.result.content[0].text).ok).toBe(true);

      const { json: got } = await mcp({
        jsonrpc: "2.0",
        id: 43,
        method: "tools/call",
        params: { name: "get_graph", arguments: { graphId } },
      });
      const doc = JSON.parse(got.result.content[0].text);
      const node = doc.nodes.find((n: any) => n.id === nodeId);
      expect(node.params.materialId).toBe("wolf-1");

      // 建第二个节点并连线，再删边、删节点
      const { json: add2 } = await mcp({
        jsonrpc: "2.0",
        id: 44,
        method: "tools/call",
        params: { name: "add_graph_node", arguments: { graphId, type: "extract.frames", params: { fps: 8 } } },
      });
      const node2 = JSON.parse(add2.result.content[0].text).nodeId;
      const { json: conn } = await mcp({
        jsonrpc: "2.0",
        id: 45,
        method: "tools/call",
        params: { name: "connect_graph_nodes", arguments: { graphId, fromNode: nodeId, fromPort: "video", toNode: node2, toPort: "video" } },
      });
      const edgeId = JSON.parse(conn.result.content[0].text).edgeId;
      expect(edgeId).toBeTruthy();

      const { json: delEdge } = await mcp({
        jsonrpc: "2.0",
        id: 46,
        method: "tools/call",
        params: { name: "delete_graph_edge", arguments: { graphId, edgeId } },
      });
      expect(JSON.parse(delEdge.result.content[0].text).ok).toBe(true);

      const { json: delNode } = await mcp({
        jsonrpc: "2.0",
        id: 47,
        method: "tools/call",
        params: { name: "delete_graph_node", arguments: { graphId, nodeId } },
      });
      expect(JSON.parse(delNode.result.content[0].text).ok).toBe(true);
    } finally {
      if (graphId) {
        await mcp({
          jsonrpc: "2.0",
          id: 48,
          method: "tools/call",
          params: { name: "delete_graph", arguments: { graphId } },
        });
      }
    }
  });

  test("tools/call import_graph 索引式边 + 重复输入端口容错", async () => {
    const ids: string[] = [];
    try {
      const { json } = await mcp({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: {
          name: "import_graph",
          arguments: {
            name: `MCP导入-${crypto.randomUUID()}`,
            // 3 节点：material.video → extract.frames → matte.batch
            nodes: [
              { type: "material.video", params: { materialId: "wolf" } },
              { type: "extract.frames", params: { fps: 8 } },
              { type: "matte.batch", params: {} },
            ],
            edges: [
              { from: 0, fromPort: "video", to: 1, toPort: "video" },
              { from: 1, fromPort: "images", to: 2, toPort: "images" },
              // 脏数据：又一条指向 node1 的 video 输入端口（UNIQUE 冲突）→ 应被丢弃而非整图回滚
              { from: 0, fromPort: "video", to: 1, toPort: "video" },
              // 端口类型不兼容（video → images）→ 丢弃
              { from: 0, fromPort: "video", to: 2, toPort: "images" },
            ],
          },
        },
      });
      const result = JSON.parse(json.result.content[0].text);
      expect(result.graphId).toBeTruthy();
      expect(result.nodeCount).toBe(3);
      ids.push(result.graphId);

      const { json: got } = await mcp({
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: { name: "get_graph", arguments: { graphId: result.graphId } },
      });
      const doc = JSON.parse(got.result.content[0].text);
      // 仅 2 条合法边落库（重复端口 + 不兼容边被丢弃），且导入整体成功
      expect(doc.edges.length).toBe(2);
    } finally {
      for (const graphId of ids) {
        await mcp({ jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "delete_graph", arguments: { graphId } } });
      }
    }
  });

  test("tools/call 模板实例化 + 重命名", async () => {
    let graphId: string | null = null;
    try {
      const { json: tpl } = await mcp({
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: { name: "list_graph_templates", arguments: {} },
      });
      const templates = JSON.parse(tpl.result.content[0].text).templates;
      expect(templates.some((x: any) => x.id === "sprite-pipeline")).toBe(true);

      const { json: made } = await mcp({
        jsonrpc: "2.0",
        id: 54,
        method: "tools/call",
        params: { name: "create_graph_from_template", arguments: { templateId: "sprite-pipeline" } },
      });
      const created = JSON.parse(made.result.content[0].text);
      graphId = created.graphId;
      expect(graphId).toBeTruthy();

      const { json: doc } = await mcp({
        jsonrpc: "2.0",
        id: 55,
        method: "tools/call",
        params: { name: "get_graph", arguments: { graphId } },
      });
      const g = JSON.parse(doc.result.content[0].text);
      expect(g.nodes.length).toBeGreaterThan(0);
      expect(g.edges.length).toBeGreaterThan(0);

      const newName = `改名-${crypto.randomUUID()}`;
      const { json: ren } = await mcp({
        jsonrpc: "2.0",
        id: 56,
        method: "tools/call",
        params: { name: "update_graph", arguments: { graphId, name: newName } },
      });
      expect(JSON.parse(ren.result.content[0].text).ok).toBe(true);
      const { json: doc2 } = await mcp({
        jsonrpc: "2.0",
        id: 57,
        method: "tools/call",
        params: { name: "get_graph", arguments: { graphId } },
      });
      expect(JSON.parse(doc2.result.content[0].text).graph.name).toBe(newName);
    } finally {
      if (graphId) {
        await mcp({ jsonrpc: "2.0", id: 58, method: "tools/call", params: { name: "delete_graph", arguments: { graphId } } });
      }
    }
  });

  test("未知工具返回错误", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });
    const hasError = json?.error || (json?.result && json.result.isError);
    expect(hasError).toBeTruthy();
  });

  test("ping 返回空结果", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 6, method: "ping" });
    expect(json.result).toEqual({});
  });

  test("notifications/initialized 被接受", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect([200, 202, 204]).toContain(res.status);
  });

  test("无效 JSON 返回错误状态码", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "not json",
    });
    expect([400, 406, 415]).toContain(res.status);
  });

  test("DELETE /mcp 被处理", async () => {
    const res = await fetch(`${BASE}/mcp`, { method: "DELETE" });
    expect([200, 204, 405]).toContain(res.status);
  });

  test("get_config 工具返回服务端配置", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "get_config", arguments: {} },
    });
    const config = JSON.parse(json.result.content[0].text);
    expect(config.matting).toBeDefined();
    expect(config.matting.engine).toBeDefined();
    expect(config.gen).toBeDefined();
    expect(config.gen.providers).toBeDefined();
  });

  test("get_settings 工具不泄露 API keys", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "get_settings", arguments: {} },
    });
    const settings = JSON.parse(json.result.content[0].text);
    if (Array.isArray(settings.genProviders)) {
      for (const p of settings.genProviders) {
        if (p.apiKey) expect(p.apiKey).toBe("***");
      }
    }
  });
});
