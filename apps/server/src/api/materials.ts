import { Elysia, t } from "elysia";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MaterialRow } from "@framebaker/shared";
import { db, getMaterial, nextFrameIdx, serializeMaterial, STORAGE_ROOT, uid } from "../db";
import { createJob } from "../queue";
import { checkVideoSupport, resolveReferencePath } from "../jobs/extract";
import { broadcast } from "../ws";

function baseName(filename: string): string {
  const n = filename.split("/").pop() ?? filename;
  return n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : n;
}

function extOf(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
}

/** 把素材的 raw / processed 槽位分别复制为项目帧追加到末尾，返回新帧 id */
function importMaterialToProject(m: MaterialRow, projectId: string): string {
  const rawSrc = m.raw_path && existsSync(m.raw_path) ? m.raw_path : m.processed_path;
  if (!rawSrc || !existsSync(rawSrc)) throw new Error(`素材文件缺失: ${m.id}`);
  const frameId = uid();
  const rawDir = join(STORAGE_ROOT, "projects", projectId, "raw");
  const procDir = join(STORAGE_ROOT, "projects", projectId, "processed");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(procDir, { recursive: true });
  // mat_ 前缀：不会被拆帧扫描的 frame_\d+ 规则命中
  const rawPath = join(rawDir, `mat_${frameId}.png`);
  copyFileSync(rawSrc, rawPath);
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
      const videoErr = checkVideoSupport(body);
      if (videoErr) return status(400, videoErr);
      const jobId = createJob("", "generate_frames", {
        generate: {
          prompt: body.prompt,
          count: body.count,
          autoMatting: body.autoMatting ?? false,
          target: { kind: "materials" },
          referencePath: ref.referencePath,
          providerId: body.providerId,
          model: body.model,
          size: body.size,
          mediaKind: body.mediaKind,
          fps: body.fps,
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
        providerId: t.Optional(t.String()),
        model: t.Optional(t.String()),
        size: t.Optional(t.String()),
        mediaKind: t.Optional(t.Union([t.Literal("image"), t.Literal("video")])),
        fps: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
      }),
    }
  )
  // 执行抠图：入队异步执行（模型首次下载可能耗时数分钟，同步会挂死请求；与批量抠图同路径）
  .post("/materials/:id/matting", ({ params, status }) => {
    const m = getMaterial(params.id);
    if (!m) return status(404, "素材不存在");
    if (!m.raw_path || !existsSync(m.raw_path)) return status(400, "素材缺少 raw 文件");
    const jobId = createJob("", "matting", { matting: { target: "material", id: params.id } });
    return { jobId };
  })
  // 批量抠图：选中的素材逐个入队（不是所有图都需要加工，按需触发）
  .post(
    "/materials/batch-matting",
    ({ body }) => {
      let count = 0;
      for (const id of body.ids) {
        const m = getMaterial(id);
        if (!m || !m.raw_path || !existsSync(m.raw_path)) continue;
        createJob("", "matting", { matting: { target: "material", id } });
        count++;
      }
      return { ok: true, count };
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  )
  // 替换图片（剪裁工具产出）：slot=raw 覆盖原图；slot=processed 覆盖/建立抠图结果
  .post(
    "/materials/:id/replace-image",
    async ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      const bytes = Buffer.from(await body.file.arrayBuffer());
      if (!isPng(bytes)) return status(400, "替换图片必须是 PNG（请通过剪裁工具提交）");
      let target: string;
      if (body.slot === "raw") {
        if (!m.raw_path) return status(400, "素材缺少 raw 文件");
        target = m.raw_path;
      } else {
        target = m.processed_path ?? join(STORAGE_ROOT, "materials", params.id, "processed.png");
      }
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, bytes);
      if (body.slot === "processed" && (m.status !== "matted" || m.processed_path !== target)) {
        db.query("UPDATE materials SET status = 'matted', processed_path = ? WHERE id = ?").run(target, params.id);
      }
      broadcast("material_updated", { id: params.id });
      return { material: serializeMaterial(getMaterial(params.id)!) };
    },
    {
      body: t.Object({
        file: t.File(),
        slot: t.Union([t.Literal("raw"), t.Literal("processed")]),
      }),
    }
  )
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
