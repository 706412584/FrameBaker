import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, uid, STORAGE_ROOT } from "../../db";
import { broadcast } from "../../ws";
import { ok, err } from "../helpers";
import { ensureDefaultTimeline } from "../../timeline";
import { invalidateProjectUndo } from "../../undo";

export function register(server: McpServer) {
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List all FrameBaker projects sorted by creation time (newest first). Returns id, name, folder_id, created_at, frame_count, and first_frame_id for each project.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const rows = db
        .query(
          `SELECT p.*,
            (SELECT COUNT(*) FROM frames f WHERE f.project_id = p.id) AS frame_count,
            (SELECT f.id FROM frames f WHERE f.project_id = p.id ORDER BY f.idx LIMIT 1) AS first_frame_id
           FROM projects p ORDER BY p.created_at DESC`
        )
        .all();
      return ok({ projects: rows });
    }
  );

  server.registerTool(
    "get_project",
    {
      title: "Get Project",
      description: "Get details of a single project including its frame count.",
      inputSchema: z.object({
        projectId: z.string().describe("Project UUID"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ projectId }) => {
      const row = db
        .query(
          `SELECT p.*, (SELECT COUNT(*) FROM frames f WHERE f.project_id = p.id) AS frame_count
           FROM projects p WHERE p.id = ?`
        )
        .get(projectId);
      if (!row) return err("项目不存在");
      return ok({ project: row });
    }
  );

  server.registerTool(
    "create_project",
    {
      title: "Create Project",
      description: "Create a new FrameBaker project. Returns the new project id and name.",
      inputSchema: z.object({
        name: z.string().describe("Project name (defaults to 未命名项目 if empty)").optional(),
        folderId: z.string().describe("Optional parent folder UUID (must be kind=project)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, folderId }) => {
      const id = uid();
      const finalName = name?.trim() || "未命名项目";
      const finalFolderId = folderId ?? null;
      if (finalFolderId) {
        const f = db.query("SELECT id, kind FROM folders WHERE id = ?").get(finalFolderId) as
          | { id: string; kind: string }
          | null;
        if (!f || f.kind !== "project") return err("文件夹不存在");
      }
      db.query("INSERT INTO projects (id, name, folder_id, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        finalName,
        finalFolderId,
        Date.now()
      );
      ensureDefaultTimeline(id);
      mkdirSync(join(STORAGE_ROOT, "projects", id, "raw"), { recursive: true });
      mkdirSync(join(STORAGE_ROOT, "projects", id, "processed"), { recursive: true });
      return ok({ id, name: finalName, folder_id: finalFolderId });
    }
  );

  server.registerTool(
    "update_project",
    {
      title: "Update Project",
      description: "Update a project's name and/or folder.",
      inputSchema: z.object({
        projectId: z.string().describe("Project UUID"),
        name: z.string().describe("New project name").optional(),
        folderId: z.string().describe("New parent folder UUID or null to ungroup").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ projectId, name, folderId }) => {
      const row = db.query("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!row) return err("项目不存在");
      if (name !== undefined) {
        db.query("UPDATE projects SET name = ? WHERE id = ?").run(name.trim() || "未命名项目", projectId);
      }
      if (folderId !== undefined) {
        const targetFolderId = folderId ?? null;
        if (targetFolderId) {
          const f = db.query("SELECT id, kind FROM folders WHERE id = ?").get(targetFolderId) as
            | { id: string; kind: string }
            | null;
          if (!f || f.kind !== "project") return err("文件夹不存在");
        }
        db.query("UPDATE projects SET folder_id = ? WHERE id = ?").run(targetFolderId, projectId);
      }
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete Project",
      description:
        "Delete a project and all its frames, jobs, and disk files. This is irreversible. Broadcasts project_deleted.",
      inputSchema: z.object({
        projectId: z.string().describe("Project UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ projectId }) => {
      const row = db.query("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!row) return err("项目不存在");
      invalidateProjectUndo(projectId);
      db.transaction(()=>{db.query("DELETE FROM frames WHERE project_id=?").run(projectId);db.query("DELETE FROM animation_steps WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").run(projectId);db.query("DELETE FROM animation_tracks WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").run(projectId);db.query("DELETE FROM animation_axes WHERE project_id=?").run(projectId);})();
      db.query("DELETE FROM jobs WHERE project_id = ?").run(projectId);
      db.query("DELETE FROM projects WHERE id = ?").run(projectId);
      rmSync(join(STORAGE_ROOT, "projects", projectId), { recursive: true, force: true });
      broadcast("project_deleted", { id: projectId });
      return ok({ ok: true });
    }
  );
}
