import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "../../db";
import { createJob } from "../../queue";
import { checkVideoSupport, resolveReferencePath } from "../../providerAdapter";
import { ok, err } from "../helpers";

export function register(server: McpServer) {
  server.registerTool(
    "generate_frames",
    {
      title: "Generate Frames",
      description:
        "Generate frames for a project using an AI generation provider (CLI/API/DashScope/Gemini/MiniMax). Creates a job and returns jobId. Poll with get_job or listen for completion. Supports optional reference image (referenceMaterialId or referenceFrameId), provider selection, model, size, and video mode (mediaKind=video generates a video then auto-extracts frames).",
      inputSchema: z.object({
        projectId: z.string().describe("Target project UUID"),
        prompt: z.string().describe("Generation prompt (English recommended)"),
        count: z.number().int().min(1).max(16).describe("Number of frames to generate (default 1)").optional(),
        autoMatting: z.boolean().describe("Auto-run background removal after generation").optional(),
        providerId: z.string().describe("Provider UUID (omit to use first configured provider)").optional(),
        model: z.string().describe("Model name (omit to use provider's first model)").optional(),
        size: z.string().describe("Output size (format varies by provider type)").optional(),
        mediaKind: z.enum(["image", "video"]).describe("image (default) or video mode").optional(),
        fps: z.number().int().min(1).max(60).describe("Video extraction fps (video mode)").optional(),
        referenceMaterialId: z.string().describe("Reference material UUID for image-to-image").optional(),
        referenceFrameId: z.string().describe("Reference frame UUID for image-to-image").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const { projectId, prompt, count, autoMatting, providerId, model, size, mediaKind, fps, referenceMaterialId, referenceFrameId } = args;
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!project) return err("项目不存在");
      const body = {
        projectId,
        prompt,
        count: count ?? 1,
        autoMatting: autoMatting ?? false,
        providerId,
        model,
        size,
        mediaKind,
        fps,
        referenceMaterialId,
        referenceFrameId,
      };
      const ref = resolveReferencePath(body);
      if (ref.error) return err(ref.error);
      const videoErr = checkVideoSupport(body);
      if (videoErr) return err(videoErr);
      const jobId = createJob(projectId, "generate_frames", {
        generate: {
          prompt,
          count: body.count,
          autoMatting: body.autoMatting,
          target: { kind: "project", projectId },
          referencePath: ref.referencePath,
          providerId,
          model,
          size,
          mediaKind,
          fps,
        },
      });
      return ok({ jobId });
    }
  );

  server.registerTool(
    "generate_materials",
    {
      title: "Generate Materials",
      description:
        "Generate materials (not project frames) using an AI generation provider. Materials go to the material library for later matting/cropping/import to projects. Creates a job and returns jobId. Same provider/reference options as generate_frames. Optional name sets the material name base (defaults to prompt prefix).",
      inputSchema: z.object({
        prompt: z.string().describe("Generation prompt (English recommended)"),
        count: z.number().int().min(1).max(16).describe("Number of materials to generate (default 1)").optional(),
        autoMatting: z.boolean().describe("Auto-run background removal after generation").optional(),
        name: z.string().describe("Material name base (defaults to prompt prefix)").optional(),
        providerId: z.string().describe("Provider UUID").optional(),
        model: z.string().describe("Model name").optional(),
        size: z.string().describe("Output size").optional(),
        mediaKind: z.enum(["image", "video"]).describe("image or video mode").optional(),
        fps: z.number().int().min(1).max(60).describe("Video extraction fps").optional(),
        referenceMaterialId: z.string().describe("Reference material UUID").optional(),
        referenceFrameId: z.string().describe("Reference frame UUID").optional(),
        folderId: z.string().describe("Target folder UUID for generated materials").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const { prompt, count, autoMatting, name, providerId, model, size, mediaKind, fps, referenceMaterialId, referenceFrameId, folderId } = args;
      const body = {
        prompt,
        count: count ?? 1,
        autoMatting: autoMatting ?? false,
        name,
        providerId,
        model,
        size,
        mediaKind,
        fps,
        referenceMaterialId,
        referenceFrameId,
        folderId: folderId ?? null,
      };
      const ref = resolveReferencePath(body);
      if (ref.error) return err(ref.error);
      const videoErr = checkVideoSupport(body);
      if (videoErr) return err(videoErr);
      const jobId = createJob("", "generate_frames", {
        generate: {
          prompt,
          count: body.count,
          autoMatting: body.autoMatting,
          target: { kind: "materials" },
          name,
          referencePath: ref.referencePath,
          providerId,
          model,
          size,
          mediaKind,
          fps,
          folderId: body.folderId,
        },
      });
      return ok({ jobId });
    }
  );
}
