import { Elysia, t } from "elysia";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, getFrame, nextFrameIdx, serializeFrame, STORAGE_ROOT, uid } from "../db";
import { broadcast } from "../ws";
import { deleteFrameCell, ensureDefaultTimeline, reorderSteps, setStepDuration, syncAxis } from "../timeline";

const patchSchema = t.Partial(
  t.Object({
    offset_x: t.Number({ minimum: -100_000, maximum: 100_000 }),
    offset_y: t.Number({ minimum: -100_000, maximum: 100_000 }),
    scale: t.Number({ minimum: 0.1, maximum: 8 }),
    rotation: t.Number({ minimum: -Math.PI, maximum: Math.PI }),
    opacity: t.Number({ minimum: 0, maximum: 1 }),
    duration: t.Integer({ minimum: 1, maximum: 600 }),
    is_keyframe: t.Integer({ minimum: 0, maximum: 1 }),
    tags: t.Array(t.String()),
  })
);

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
}

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
    const { axis, track } = ensureDefaultTimeline(params.id);
    const rows = db.query(`SELECT f.* FROM frames f JOIN animation_steps s ON s.id=f.step_id
      WHERE f.project_id=? AND f.track_id=? AND s.axis_id=? ORDER BY s.idx,s.id`).all(params.id,track.id,axis.id) as any[];
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
      if (body.duration !== undefined && frame.step_id) setStepDuration(frame.step_id, body.duration);
      const ownKeys = keys.filter((k) => k !== "duration" || !frame.step_id);
      if (ownKeys.length) {
        const setSql = ownKeys.map((k) => `${k} = ?`).join(", ");
        const values = ownKeys.map((k) => (k === "tags" ? JSON.stringify(body[k]) : (body[k] as number)));
        db.query(`UPDATE frames SET ${setSql} WHERE id = ?`).run(...values, params.id);
      }
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
      const bytes = Buffer.from(await body.file.arrayBuffer());
      if (!isPng(bytes)) return status(400, "替换图片必须是 PNG（请通过编辑器剪裁后提交）");
      const out = join(STORAGE_ROOT, "projects", frame.project_id, "processed", `${frame.id}_replaced.png`);
      mkdirSync(dirname(out), { recursive: true });
      await Bun.write(out, bytes);
      db.query("UPDATE frames SET processed_path = ?, source = 'upload', status = 'ready' WHERE id = ?").run(out, frame.id);
      if (
        frame.processed_path &&
        frame.processed_path !== out &&
        frame.processed_path !== frame.raw_path &&
        existsSync(frame.processed_path)
      ) {
        unlinkSync(frame.processed_path);
      }
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
      const shared = p ? db.query("SELECT 1 FROM frames WHERE id<>? AND (raw_path=? OR processed_path=?) LIMIT 1").get(frame.id, p, p) : null;
      if (p && !shared && existsSync(p)) unlinkSync(p);
    }
    deleteFrameCell(params.id);
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
      const rawDir = join(STORAGE_ROOT, "projects", frame.project_id, "raw");
      const procDir = join(STORAGE_ROOT, "projects", frame.project_id, "processed");
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(procDir, { recursive: true });
      // 待编排帧的副本继续留在左侧帧池。
      if (!frame.step_id || !frame.track_id) {
        for (let i = 0; i < count; i++) {
          const nid = uid();
          const rawPath = frame.raw_path && existsSync(frame.raw_path) ? `${rawDir}/dup_${nid}.png` : frame.raw_path;
          if (rawPath && frame.raw_path && rawPath !== frame.raw_path) copyFileSync(frame.raw_path, rawPath);
          const procPath = frame.processed_path && existsSync(frame.processed_path) ? `${procDir}/${nid}.png` : frame.processed_path;
          if (procPath && frame.processed_path && procPath !== frame.processed_path) copyFileSync(frame.processed_path, procPath);
          db.query(`INSERT INTO frames (id,project_id,idx,raw_path,processed_path,status,duration,is_keyframe,offset_x,offset_y,scale,rotation,opacity,tags,source,metadata)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nid,frame.project_id,nextFrameIdx(frame.project_id),rawPath,procPath,frame.status,frame.duration,frame.is_keyframe,frame.offset_x,frame.offset_y,frame.scale,frame.rotation,frame.opacity,frame.tags,"duplicate",frame.metadata);
        }
        broadcast("frames_changed", { projectId: frame.project_id });
        return { ok: true, count };
      }
      // 为时间轴副本腾出共享步骤位置。
      const sourceStep = db.query("SELECT * FROM animation_steps WHERE id=?").get(frame.step_id) as any;
      const tail=db.query("SELECT id,idx FROM animation_steps WHERE axis_id=? AND idx>? ORDER BY idx DESC").all(sourceStep.axis_id,sourceStep.idx) as Array<{id:string;idx:number}>;
      db.transaction(() => { tail.forEach(s=>db.query("UPDATE animation_steps SET idx=? WHERE id=?").run(-s.idx-1,s.id)); tail.forEach(s=>db.query("UPDATE animation_steps SET idx=? WHERE id=?").run(s.idx+count,s.id)); })();
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
        const stepId=uid();
        db.query("INSERT INTO animation_steps (id,axis_id,idx,duration) VALUES (?,?,?,?)").run(stepId,sourceStep.axis_id,sourceStep.idx+i,sourceStep.duration);
        db.query(
          `INSERT INTO frames (id, project_id, track_id, step_id, idx, raw_path, processed_path, status, duration, is_keyframe,
             offset_x, offset_y, scale, rotation, opacity, tags, source, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'duplicate', ?)`
        ).run(
          nid,
          frame.project_id,
          frame.track_id,
          stepId,
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
      syncAxis(sourceStep.axis_id);
      broadcast("frames_changed", { projectId: frame.project_id });
      return { ok: true, count };
    },
    { query: t.Object({ count: t.Optional(t.String()) }) }
  )
  // 按给定顺序重写 idx
  .post(
    "/projects/:id/reorder",
    ({ params, body, status }) => {
      const { axis, track }=ensureDefaultTimeline(params.id);
      const rows = db.query(`SELECT f.id,f.step_id FROM frames f JOIN animation_steps s ON s.id=f.step_id
        WHERE f.project_id=? AND f.track_id=? AND s.axis_id=? ORDER BY s.idx`).all(params.id,track.id,axis.id) as Array<{ id: string;step_id:string }>;
      const set = new Set(rows.map((r) => r.id));
      const stepCount=(db.query("SELECT COUNT(*) n FROM animation_steps WHERE axis_id=?").get(axis.id) as any).n;
      if (rows.length!==stepCount || body.frameIds.length !== set.size || new Set(body.frameIds).size!==body.frameIds.length || !body.frameIds.every((id) => set.has(id))) {
        return status(409, "仅支持主轨每步骤恰好一个单元格的旧式时间轴换序");
      }
      const byId=new Map(rows.map(r=>[r.id,r.step_id])); reorderSteps(axis.id,body.frameIds.map(id=>byId.get(id)!));
      broadcast("frames_reordered", { projectId: params.id });
      return { ok: true };
    },
    { body: t.Object({ frameIds: t.Array(t.String()) }) }
  );
