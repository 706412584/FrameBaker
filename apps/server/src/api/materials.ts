import { Elysia, t } from "elysia";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MaterialRow } from "@framebaker/shared";
import { db, getMaterial, nextFrameIdx, serializeMaterial, STORAGE_ROOT, uid } from "../db";
import { createJob } from "../queue";
import { matteMaterial } from "../jobs/matting";
import { resolveReferencePath } from "../jobs/extract";
import { broadcast } from "../ws";

function baseName(filename: string): string {
  const n = filename.split("/").pop() ?? filename;
  return n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : n;
}

function extOf(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

/** 把素材（优先 processed）复制为项目帧追加到末尾，返回新帧 id */
function importMaterialToProject(m: MaterialRow, projectId: string): string {
  const src = m.processed_path ?? m.raw_path;
  if (!src || !existsSync(src)) throw new Error(`素材文件缺失: ${m.id}`);
  const frameId = uid();
  const rawDir = join(STORAGE_ROOT, "projects", projectId, "raw");
  const procDir = join(STORAGE_ROOT, "projects", projectId, "processed");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(procDir, { recursive: true });
  // mat_ 前缀：不会被拆帧扫描的 frame_\d+ 规则命中
  const rawPath = join(rawDir, `mat_${frameId}.png`);
  copyFileSync(src, rawPath);
  let procPath: string | null = null;
  if (m.processed_path && existsSync(m.processed_path)) {
    procPath = join(procDir, `${frameId}.png`);
    copyFileSync(m.processed_path, procPath);
  }
  let metadata: Record<string, unknown> = { fromMaterial: m.id };
  try {
    metadata = { ...metadata, ...JSON.parse(m.metadata ?? "{}") };
  } catch {
    /* ignore */
  }
  db.query(
    "INSERT INTO frames (id, project_id, idx, raw_path, processed_path, status, source, metadata) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)"
  ).run(frameId, projectId, nextFrameIdx(projectId), rawPath, procPath, m.source, JSON.stringify(metadata));
  return frameId;
}

/** 素材图片流式返回，processed 缺失回退 raw */
const materialImageHandler = ({
  params,
  query,
  status,
}: {
  params: { id: string };
  query: { type?: string };
  status: (code: number, msg: string) => unknown;
}) => {
  const m = getMaterial(params.id);
  if (!m) return status(404, "素材不存在");
  let path: string | null = query.type === "raw" ? m.raw_path : m.processed_path;
  if (!path || !existsSync(path)) path = m.raw_path;
  if (!path || !existsSync(path)) return status(404, "图片文件不存在");
  return new Response(Bun.file(path), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
};

export const materialsApi = new Elysia({ prefix: "/api" })
  // 素材列表（按创建时间倒序）
  .get("/materials", () => {
    const rows = db.query("SELECT * FROM materials ORDER BY created_at DESC").all() as MaterialRow[];
    return { materials: rows.map(serializeMaterial) };
  })
  // 素材图片，processed 缺失回退 raw（.png 后缀别名：让 Pixi Assets 按扩展名命中 parser）
  .get("/materials/:id/image", materialImageHandler)
  .get("/materials/:id/image.png", materialImageHandler)
  // 上传素材：单图 → 直接入库；GIF/MP4 → 队列拆帧，每帧一个素材
  .post(
    "/materials/upload",
    async ({ body }) => {
      const origName = body.file.name ?? "素材";
      const ext = extOf(origName);
      const autoMatting = body.autoMatting === "true";

      if (ext === "gif" || ext === "mp4" || ext === "mov" || ext === "webm") {
        const stagingId = uid();
        const dir = join(STORAGE_ROOT, "staging", stagingId);
        mkdirSync(dir, { recursive: true });
        const stagingFile = join(dir, `input.${ext}`);
        await Bun.write(stagingFile, Buffer.from(await body.file.arrayBuffer()));
        const fps = Math.min(Math.max(parseInt(body.fps ?? "8", 10) || 8, 1), 60);
        const jobId = createJob("", "extract_frames", {
          extract: {
            stagingFile,
            mediaType: ext === "gif" ? "gif" : "mp4",
            fps,
            autoMatting,
            target: { kind: "materials" },
            originName: baseName(origName),
          },
        });
        return { jobId };
      }

      // PNG/JPG 等单图 → 1 个素材
      const id = uid();
      const dir = join(STORAGE_ROOT, "materials", id);
      mkdirSync(dir, { recursive: true });
      const rawPath = join(dir, "raw.png");
      await Bun.write(rawPath, Buffer.from(await body.file.arrayBuffer()));
      db.query("INSERT INTO materials (id, name, raw_path, status, source, created_at) VALUES (?, ?, ?, 'raw', 'image', ?)").run(
        id,
        baseName(origName) || "素材",
        rawPath,
        Date.now()
      );
      if (autoMatting) createJob("", "matting", { matting: { target: "material", id } });
      broadcast("materials_changed", {});
      return { materialId: id };
    },
    {
      body: t.Object({
        file: t.File(),
        autoMatting: t.Optional(t.String()),
        fps: t.Optional(t.String()),
      }),
    }
  )
  // CLI 生成素材（可选引用图）
  .post(
    "/materials/generate",
    ({ body, status }) => {
      // 引用图 id 解析 + 模板一致性前置校验（在创建 job 前就 400）
      const ref = resolveReferencePath(body);
      if (ref.error) return status(400, ref.error);
      const jobId = createJob("", "generate_frames", {
        generate: {
          prompt: body.prompt,
          count: body.count,
          autoMatting: body.autoMatting ?? false,
          target: { kind: "materials" },
          referencePath: ref.referencePath,
        },
      });
      return { jobId };
    },
    {
      body: t.Object({
        prompt: t.String(),
        count: t.Integer({ minimum: 1, maximum: 16 }),
        autoMatting: t.Optional(t.Boolean()),
        referenceMaterialId: t.Optional(t.String()),
        referenceFrameId: t.Optional(t.String()),
      }),
    }
  )
  // 执行抠图（同步；引擎解析见 jobs/matting.ts，无引擎时 passthrough 并返回 warning）
  .post("/materials/:id/matting", async ({ params, status }) => {
    const m = getMaterial(params.id);
    if (!m) return status(404, "素材不存在");
    try {
      const warning = await matteMaterial(params.id);
      return { material: serializeMaterial(getMaterial(params.id)!), warning };
    } catch (e) {
      return status(500, (e as Error).message);
    }
  })
  // 还原原图：删除 processed
  .post("/materials/:id/unmatting", ({ params, status }) => {
    const m = getMaterial(params.id);
    if (!m) return status(404, "素材不存在");
    if (m.processed_path && existsSync(m.processed_path)) rmSync(m.processed_path);
    db.query("UPDATE materials SET status = 'raw', processed_path = NULL WHERE id = ?").run(params.id);
    broadcast("material_updated", { id: params.id });
    return { material: serializeMaterial(getMaterial(params.id)!) };
  })
  // 导入到项目：追加 count 份帧
  .post(
    "/materials/:id/import",
    ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(body.projectId);
      if (!project) return status(404, "项目不存在");
      const count = Math.min(Math.max(body.count ?? 1, 1), 16);
      try {
        const frameIds: string[] = [];
        for (let i = 0; i < count; i++) frameIds.push(importMaterialToProject(m, body.projectId));
        broadcast("frames_changed", { projectId: body.projectId });
        return { ok: true, count, frameIds };
      } catch (e) {
        return status(500, (e as Error).message);
      }
    },
    { body: t.Object({ projectId: t.String(), count: t.Optional(t.Integer()) }) }
  )
  // 批量删除
  .post(
    "/materials/batch-delete",
    ({ body }) => {
      const stmt = db.query("DELETE FROM materials WHERE id = ?");
      let deleted = 0;
      for (const id of body.ids) {
        const m = getMaterial(id);
        if (!m) continue;
        stmt.run(id);
        deleted++;
        rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
      }
      broadcast("materials_changed", {});
      return { ok: true, deleted };
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  )
  // 批量导入到项目（保持给定顺序，各 1 份）
  .post(
    "/materials/batch-import",
    ({ body, status }) => {
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(body.projectId);
      if (!project) return status(404, "项目不存在");
      let count = 0;
      try {
        for (const id of body.ids) {
          const m = getMaterial(id);
          if (!m) continue;
          importMaterialToProject(m, body.projectId);
          count++;
        }
      } catch (e) {
        return status(500, (e as Error).message);
      }
      broadcast("frames_changed", { projectId: body.projectId });
      return { ok: true, count };
    },
    { body: t.Object({ ids: t.Array(t.String()), projectId: t.String() }) }
  );
