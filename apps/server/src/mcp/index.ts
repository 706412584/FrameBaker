/**
 * MCP（Model Context Protocol）服务端模块。
 *
 * 基于 @modelcontextprotocol/server SDK v2，自动兼容 2025-era 和 2026-07-28 协议。
 * 传输：Streamable HTTP —— 客户端请求 /mcp，SDK 自动处理 JSON-RPC / SSE / 会话。
 * 工具直接读写 db / 内部模块，不走 HTTP 自调用，零额外开销。
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import serverPackage from "../../package.json" with { type: "json" };
import { register as registerProjectTools } from "./tools/projects";
import { register as registerFrameTools } from "./tools/frames";
import { register as registerGenerationTools } from "./tools/generation";
import { register as registerMaterialTools, registerDiagTools } from "./tools/materials";
import { register as registerFolderTools } from "./tools/folders";
import { register as registerJobTools } from "./tools/jobs";
import { register as registerGraphTools } from "./tools/graphs";
import { register as registerSystemTools } from "./tools/system";
import { register as registerTimelineTools } from "./tools/timeline";

export const mcpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: "framebaker", version: serverPackage.version });
  registerProjectTools(server);
  registerFrameTools(server);
  registerTimelineTools(server);
  registerGenerationTools(server);
  registerMaterialTools(server);
  registerDiagTools(server);
  registerFolderTools(server);
  registerJobTools(server);
  registerGraphTools(server);
  registerSystemTools(server);
  return server;
});

/** MCP 工具总数（设置页连接信息显示用）——各 tools 模块的注册名清单 */
export const MCP_TOOL_NAMES = [
  "list_projects", "get_project", "create_project", "update_project", "delete_project",
  "list_frames", "update_frame", "delete_frame", "clear_frame_cell", "duplicate_frame", "reorder_frames",
  "get_timeline", "create_track", "update_track", "delete_track", "reorder_tracks",
  "create_step", "update_step", "delete_step", "reorder_steps", "move_frame_cell", "place_frames_batch", "upsert_attack_effect",
  "generate_frames", "generate_materials",
  "list_materials", "rename_material", "matting_material", "split_material_layers", "batch_matting",
  "extract_material_frames", "import_material_to_project", "batch_import_materials", "batch_delete_materials",
  "unmatting_material", "split_material_layers_local", "get_ai_engine_status", "diagnose_material_grid",
  "list_folders", "create_folder", "update_folder", "delete_folder", "move_items_to_folder",
  "list_jobs", "get_job", "cancel_job",
  "list_graph_node_schemas", "list_graphs", "create_graph", "get_graph", "add_graph_node",
  "connect_graph_nodes", "delete_graph", "run_graph", "cancel_graph_run", "get_graph_run_status",
  "get_config", "run_doctor", "get_settings", "update_setting", "enhance_prompt",
] as const;
