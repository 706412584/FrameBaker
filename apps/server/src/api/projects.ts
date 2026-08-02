import { Elysia, t } from "elysia";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, STORAGE_ROOT, uid } from "../db";
import { broadcast } from "../ws";

export const projectsApi = new Elysia({ prefix: "/api" })
  // 项目列表（含帧数与首帧 id，供卡片缩略图用）
  .get("/projects", () => {
    const rows = db
      .query(
        `SELECT p.*,
          (SELECT COUNT(*) FROM frames f WHERE f.project_id = p.id) AS frame_count,
          (SELECT f.id FROM frames f WHERE f.project_id = p.id ORDER BY f.idx LIMIT 1) AS first_frame_id
         FROM projects p ORDER BY p.created_at DESC`
      )
      .all();
    return { projects: rows };
  })
  .post(
    "/projects",
    ({ body }) => {
      const id = uid();
      const name = body.name.trim() || "未命名项目";
      db.query("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, name, Date.now());
      mkdirSync(join(STORAGE_ROOT, "projects", id, "raw"), { recursive: true });
      mkdirSync(join(STORAGE_ROOT, "projects", id, "processed"), { recursive: true });
      return { id, name };
    },
    { body: t.Object({ name: t.String() }) }
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
      db.query("UPDATE projects SET name = ? WHERE id = ?").run(body.name.trim() || "未命名项目", params.id);
      return { ok: true };
    },
    { body: t.Object({ name: t.String() }) }
  )
  .delete("/projects/:id", ({ params, status }) => {
    const row = db.query("SELECT id FROM projects WHERE id = ?").get(params.id);
    if (!row) return status(404, "项目不存在");
    db.query("DELETE FROM frames WHERE project_id = ?").run(params.id);
    db.query("DELETE FROM jobs WHERE project_id = ?").run(params.id);
    db.query("DELETE FROM projects WHERE id = ?").run(params.id);
    rmSync(join(STORAGE_ROOT, "projects", params.id), { recursive: true, force: true });
    broadcast("project_deleted", { id: params.id });
    return { ok: true };
  });
