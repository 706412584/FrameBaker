import { Elysia, t } from "elysia";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { db, STORAGE_ROOT, uid } from "../db";
import { createJob } from "../queue";
import { resolveReferencePath } from "../jobs/extract";

export const importApi = new Elysia({ prefix: "/api" })
  // 上传素材拆帧：gif / mp4 / 单图
  .post(
    "/import/upload",
    async ({ body, status }) => {
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(body.projectId);
      if (!project) return status(404, "项目不存在");

      const stagingId = uid();
      const dir = join(STORAGE_ROOT, "staging", stagingId);
      mkdirSync(dir, { recursive: true });
      const origName = body.file.name ?? "input";
      const ext = origName.includes(".")
        ? origName.split(".").pop()!.toLowerCase()
        : body.type === "mp4"
          ? "mp4"
          : body.type === "gif"
            ? "gif"
            : "png";
      const stagingFile = `${dir}/input.${ext}`;
      await Bun.write(stagingFile, Buffer.from(await body.file.arrayBuffer()));

      const fps = Math.min(Math.max(parseInt(body.fps ?? "8", 10) || 8, 1), 60);
      const autoMatting = body.autoMatting === "true";
      // createJob 会生成真正的任务 id 并入队；此处必须返回它
      const jobId = createJob(body.projectId, "extract_frames", {
        extract: {
          stagingFile,
          mediaType: body.type,
          fps,
          autoMatting,
          target: { kind: "project", projectId: body.projectId },
        },
      });
      return { jobId };
    },
    {
      body: t.Object({
        file: t.File(),
        projectId: t.String(),
        type: t.Union([t.Literal("gif"), t.Literal("mp4"), t.Literal("image")]),
        fps: t.Optional(t.String()),
        autoMatting: t.Optional(t.String()),
      }),
    }
  )
  // 外部 CLI 逐帧生成（可选引用图）
  .post(
    "/import/generate",
    ({ body, status }) => {
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(body.projectId);
      if (!project) return status(404, "项目不存在");
      // 引用图 id 解析 + 模板一致性前置校验（在创建 job 前就 400）
      const ref = resolveReferencePath(body);
      if (ref.error) return status(400, ref.error);
      const jobId = createJob(body.projectId, "generate_frames", {
        generate: {
          prompt: body.prompt,
          count: body.count,
          autoMatting: body.autoMatting ?? false,
          target: { kind: "project", projectId: body.projectId },
          referencePath: ref.referencePath,
          providerId: body.providerId,
          model: body.model,
          size: body.size,
        },
      });
      return { jobId };
    },
    {
      body: t.Object({
        projectId: t.String(),
        prompt: t.String(),
        count: t.Integer({ minimum: 1, maximum: 16 }),
        autoMatting: t.Optional(t.Boolean()),
        referenceMaterialId: t.Optional(t.String()),
        referenceFrameId: t.Optional(t.String()),
        providerId: t.Optional(t.String()),
        model: t.Optional(t.String()),
        size: t.Optional(t.String()),
      }),
    }
  );
