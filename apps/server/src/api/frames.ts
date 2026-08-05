import { Elysia, t } from "elysia";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, getFrame, serializeFrame, STORAGE_ROOT, uid } from "../db";
import { broadcast } from "../ws";

const patchSchema = t.Partial(
  t.Object({
    offset_x: t.Number(),
    offset_y: t.Number(),
    scale: t.Number(),
    rotation: t.Number(),
    opacity: t.Number(),
    duration: t.Integer({ minimum: 1, maximum: 600 }),
    is_keyframe: t.Integer({ minimum: 0, maximum: 1 }),
    tags: t.Array(t.String()),
  })
);

/** 帧图片流式返回，processed 缺失时回退 raw */
const frameImageHandler = ({
  params,
  query,
  status,
}: {
  params: { id: string };
  query: { type?: string };
  status: (code: number, msg: string) => unknown;
}) => {
  const frame = getFrame(params.id);
  if (!frame) return status(404, "帧不存在");
  let path: string | null = query.type === "raw" ? frame.raw_path : frame.processed_path;
  if (!path || !existsSync(path)) path = frame.raw_path;
  if (!path || !existsSync(path)) return status(404, "图片文件不存在");
  return new Response(Bun.file(path), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
};

export const framesApi = new Elysia({ prefix: "/api" })
  // 项目帧列表，按 idx 排序
  .get("/projects/:id/frames", ({ params }) => {
    const rows = db.query("SELECT * FROM frames WHERE project_id = ? ORDER BY idx").all(params.id) as any[];
    return { frames: rows.map(serializeFrame) };
  })
  // 帧图片流式返回，processed 缺失时回退 raw（.png 后缀别名：让 Pixi Assets 按扩展名命中 parser）
  .get("/frames/:id/image", frameImageHandler)
  .get("/frames/:id/image.png", frameImageHandler)
  // 更新帧属性
  .patch(
    "/frames/:id",
    ({ params, body, status }) => {
      const frame = getFrame(params.id);
      if (!frame) return status(404, "帧不存在");
      const keys = Object.keys(body) as Array<keyof typeof body>;
      if (keys.length === 0) return status(400, "没有可更新的字段");
      const setSql = keys.map((k) => `${k} = ?`).join(", ");
      const values = keys.map((k) => (k === "tags" ? JSON.stringify(body[k]) : (body[k] as number)));
      db.query(`UPDATE frames SET ${setSql} WHERE id = ?`).run(...values, params.id);
      const updated = getFrame(params.id)!;
      broadcast("frame_updated", { id: params.id, projectId: frame.project_id });
      return { frame: serializeFrame(updated) };
    },
    { body: patchSchema }
  )
  // 上传新图替换当前帧（写入 processed）
  .post(
    "/frames/:id/replace",
    async ({ params, body, status }) => {
      const frame = getFrame(params.id);
      if (!frame) return status(404, "帧不存在");
      const out = join(STORAGE_ROOT, "projects", frame.project_id, "processed", `${frame.id}_replaced.png`);
      mkdirSync(dirname(out), { recursive: true });
      await Bun.write(out, Buffer.from(await body.file.arrayBuffer()));
      db.query("UPDATE frames SET processed_path = ?, source = 'upload', status = 'ready' WHERE id = ?").run(out, frame.id);
      broadcast("frame_updated", { id: frame.id, projectId: frame.project_id });
      return { frame: serializeFrame(getFrame(frame.id)!) };
    },
    { body: t.Object({ file: t.File() }) }
  )
  // 删除帧并重排 idx
  .delete("/frames/:id", ({ params, status }) => {
    const frame = getFrame(params.id);
    if (!frame) return status(404, "帧不存在");
    for (const p of [frame.raw_path, frame.processed_path]) {
      if (p && existsSync(p)) unlinkSync(p);
    }
    db.query("DELETE FROM frames WHERE id = ?").run(params.id);
    db.query("UPDATE frames SET idx = idx - 1 WHERE project_id = ? AND idx > ?").run(frame.project_id, frame.idx);
    broadcast("frames_changed", { projectId: frame.project_id });
    return { ok: true };
  })
  // 复制 N 份插入到原帧之后
  .post(
    "/frames/:id/duplicate",
    ({ params, query, status }) => {
      const frame = getFrame(params.id);
      if (!frame) return status(404, "帧不存在");
      const count = Math.min(Math.max(parseInt(query.count ?? "1", 10) || 1, 1), 16);
      // 为副本腾出 idx 位置
      db.query("UPDATE frames SET idx = idx + ? WHERE project_id = ? AND idx > ?").run(count, frame.project_id, frame.idx);
      const rawDir = join(STORAGE_ROOT, "projects", frame.project_id, "raw");
      const procDir = join(STORAGE_ROOT, "projects", frame.project_id, "processed");
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(procDir, { recursive: true });
      for (let i = 1; i <= count; i++) {
        const nid = uid();
        let rawPath = frame.raw_path;
        if (frame.raw_path && existsSync(frame.raw_path)) {
          // dup_ 前缀：不会被拆帧扫描的 frame_\d+ 规则命中
          rawPath = `${rawDir}/dup_${nid}.png`;
          copyFileSync(frame.raw_path, rawPath);
        }
        let procPath = frame.processed_path;
        if (frame.processed_path && existsSync(frame.processed_path)) {
          procPath = `${procDir}/${nid}.png`;
          copyFileSync(frame.processed_path, procPath);
        }
        db.query(
          `INSERT INTO frames (id, project_id, idx, raw_path, processed_path, status, duration, is_keyframe,
             offset_x, offset_y, scale, rotation, opacity, tags, source, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'duplicate', ?)`
        ).run(
          nid,
          frame.project_id,
          frame.idx + i,
          rawPath,
          procPath,
          frame.status === "ready" ? "ready" : frame.status,
          frame.duration,
          frame.is_keyframe,
          frame.offset_x,
          frame.offset_y,
          frame.scale,
          frame.rotation,
          frame.opacity,
          frame.tags,
          frame.metadata
        );
      }
      broadcast("frames_changed", { projectId: frame.project_id });
      return { ok: true, count };
    },
    { query: t.Object({ count: t.Optional(t.String()) }) }
  )
  // 按给定顺序重写 idx
  .post(
    "/projects/:id/reorder",
    ({ params, body, status }) => {
      const rows = db.query("SELECT id FROM frames WHERE project_id = ?").all(params.id) as Array<{ id: string }>;
      const set = new Set(rows.map((r) => r.id));
      if (body.frameIds.length !== set.size || !body.frameIds.every((id) => set.has(id))) {
        return status(400, "frameIds 必须恰好包含项目的全部帧");
      }
      const stmt = db.query("UPDATE frames SET idx = ? WHERE id = ?");
      db.transaction((ids: string[]) => {
        ids.forEach((id, i) => stmt.run(i, id));
      })(body.frameIds);
      broadcast("frames_reordered", { projectId: params.id });
      return { ok: true };
    },
    { body: t.Object({ frameIds: t.Array(t.String()) }) }
  );
