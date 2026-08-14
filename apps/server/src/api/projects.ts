import { Elysia, t } from "elysia";
import { PROJECT_KINDS, type ProjectKind } from "@framebaker/shared";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, STORAGE_ROOT, uid } from "../db";
import { broadcast } from "../ws";
import { ensureDefaultTimeline } from "../timeline";
import { invalidateProjectUndo } from "../undo";

function isProjectKind(value: string): value is ProjectKind {
  return (PROJECT_KINDS as readonly string[]).includes(value);
}

export const projectsApi = new Elysia({ prefix: "/api" })
  // 项目列表（含帧数与首帧 id，供卡片缩略图用）
  .get("/projects", () => {
    const rows = db
      .query(
        `SELECT p.*,
          (SELECT COUNT(*) FROM frames f WHERE f.project_id=p.id) AS frame_count,
          COALESCE(
            (SELECT f.id FROM frames f JOIN animation_tracks t ON t.id=f.track_id JOIN animation_steps s ON s.id=f.step_id JOIN animation_axes a ON a.id=t.axis_id WHERE a.project_id=p.id AND a.idx=0 AND t.is_primary=1 ORDER BY s.idx LIMIT 1),
            (SELECT f.id FROM frames f WHERE f.project_id=p.id AND f.track_id IS NULL AND f.step_id IS NULL ORDER BY f.idx,f.id LIMIT 1)
          ) AS first_frame_id
         FROM projects p ORDER BY p.created_at DESC`
      )
      .all();
    return { projects: rows };
  })
  .post(
    "/projects",
    ({ body, status }) => {
      const id = uid();
      const name = body.name.trim() || "未命名项目";
      const kind = body.kind ?? "frame";
      if (!isProjectKind(kind)) return status(400, "项目类型无效");
      const folderId = body.folderId ?? null;
      if (folderId) {
        const f = db.query("SELECT id, kind FROM folders WHERE id = ?").get(folderId) as
          | { id: string; kind: string }
          | null;
        if (!f || f.kind !== "project") return status(400, "文件夹不存在");
      }
      db.query("INSERT INTO projects (id, name, kind, folder_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        name,
        kind,
        folderId,
        Date.now()
      );
      ensureDefaultTimeline(id);
      mkdirSync(join(STORAGE_ROOT, "projects", id, "raw"), { recursive: true });
      mkdirSync(join(STORAGE_ROOT, "projects", id, "processed"), { recursive: true });
      return { id, name, kind, folder_id: folderId };
    },
    {
      body: t.Object({
        name: t.String(),
        kind: t.Optional(t.String()),
        folderId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  .get("/projects/:id", ({ params, status }) => {
    const row = db
      .query(
        `SELECT p.*, (SELECT COUNT(*) FROM frames f WHERE f.project_id = p.id) AS frame_count
         FROM projects p WHERE p.id = ?`
      )
      .get(params.id);
    if (!row) return status(404, "项目不存在");
    return { project: row };
  })
  .patch(
    "/projects/:id",
    ({ params, body, status }) => {
      const row = db.query("SELECT id FROM projects WHERE id = ?").get(params.id);
      if (!row) return status(404, "项目不存在");
      if (body.name !== undefined) {
        db.query("UPDATE projects SET name = ? WHERE id = ?").run(body.name.trim() || "未命名项目", params.id);
      }
      if (body.folderId !== undefined) {
        const folderId = body.folderId;
        if (folderId) {
          const f = db.query("SELECT id, kind FROM folders WHERE id = ?").get(folderId) as
            | { id: string; kind: string }
            | null;
          if (!f || f.kind !== "project") return status(400, "文件夹不存在");
        }
        db.query("UPDATE projects SET folder_id = ? WHERE id = ?").run(folderId, params.id);
      }
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        folderId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  .delete("/projects/:id", ({ params, status }) => {
    const row = db.query("SELECT id FROM projects WHERE id = ?").get(params.id);
    if (!row) return status(404, "项目不存在");
    invalidateProjectUndo(params.id);
    db.transaction(()=>{db.query("DELETE FROM attack_effects WHERE project_id = ?").run(params.id);db.query("DELETE FROM frames WHERE project_id = ?").run(params.id);db.query("DELETE FROM animation_steps WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").run(params.id);db.query("DELETE FROM animation_tracks WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").run(params.id);db.query("DELETE FROM animation_axes WHERE project_id=?").run(params.id);})();
    db.query("DELETE FROM jobs WHERE project_id = ?").run(params.id);
    db.query("DELETE FROM skeletal_projects WHERE project_id = ?").run(params.id);
    db.query("DELETE FROM projects WHERE id = ?").run(params.id);
    rmSync(join(STORAGE_ROOT, "projects", params.id), { recursive: true, force: true });
    broadcast("project_deleted", { id: params.id });
    return { ok: true };
  });
