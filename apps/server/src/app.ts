import { Elysia, t } from "elysia";
import { join } from "node:path";
import type { ServerConfig } from "@framebaker/shared";
import { db } from "./db";
import { getMattingInfo } from "./jobs/matting";
import { enhancerConfigured, getGenProviders, getPromptEnhancers, providerConfigured } from "./provider";
import { isModelCached, listApiProviderModels, runDoctor, testApiProvider } from "./doctor";
import { enhancePrompt } from "./enhance";
import { projectsApi } from "./api/projects";
import { framesApi } from "./api/frames";
import { importApi } from "./api/import";
import { materialsApi } from "./api/materials";
import { settingsApi } from "./api/settings";

// imageOps worker 打包结果：生产缓存一次，开发每次重建（跟随源码改动）
let imageOpsWorkerCode: string | null = null;

async function buildImageOpsWorker(): Promise<string> {
  if (imageOpsWorkerCode && process.env.NODE_ENV === "production") return imageOpsWorkerCode;
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "..", "web", "src", "imageops", "imageOps.worker.ts")],
    target: "browser",
    format: "esm",
  });
  if (!result.success) throw new Error(result.logs.map((l) => String(l)).join("\n"));
  imageOpsWorkerCode = await result.outputs[0].text();
  return imageOpsWorkerCode;
}

export const app = new Elysia()
  .get("/api/health", () => ({ ok: true, name: "FrameBaker" }))
  // 服务端能力探测（抠图引擎、生成 provider 列表；每次实时解析，设置页改动即时生效）
  .get("/api/config", (): ServerConfig => {
    const matting = getMattingInfo();
    return {
      matting: {
        engine: matting.engine,
        model: matting.model,
        hint: matting.hint,
        modelCached: isModelCached(matting.model),
      },
      gen: {
        providers: getGenProviders().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          models: p.apiModels,
          configured: providerConfigured(p),
        })),
      },
      promptEnhancers: getPromptEnhancers()
        .filter(enhancerConfigured)
        .map((e) => ({ id: e.id, name: e.name, model: e.apiModel })),
    };
  })
  // 提示词加强：调用设置页配置的加强模型（OpenAI 兼容 chat/completions），原提示词由前端保留
  .post(
    "/api/enhance-prompt",
    async ({ body, status }) => {
      try {
        return await enhancePrompt(body);
      } catch (e) {
        return status(400, (e as Error).message);
      }
    },
    {
      body: t.Object({
        enhancerId: t.Optional(t.String()),
        prompt: t.String(),
        style: t.Optional(t.String()),
      }),
    }
  )
  // 体检：逐项检查存储 / ffmpeg / 抠图引擎与模型 / 生成 provider（API 方式含联通测试）
  .get("/api/doctor", () => runDoctor())
  // API provider 联通测试（用表单当前值，不要求已保存）：api/dashscope/gemini 实发模型列表端点；minimax 仅校验字段
  .post(
    "/api/provider/test",
    ({ body }) => testApiProvider(body),
    {
      body: t.Object({
        type: t.Optional(t.Union([t.Literal("api"), t.Literal("dashscope"), t.Literal("gemini"), t.Literal("minimax")])),
        apiBaseUrl: t.String(),
        apiKey: t.String(),
        apiModel: t.Optional(t.String()),
      }),
    }
  )
  // API provider 模型列表（设置页「获取模型」，用表单当前值拉取，不要求已保存）
  .post(
    "/api/provider/models",
    ({ body }) => listApiProviderModels(body),
    {
      body: t.Object({
        type: t.Union([t.Literal("api"), t.Literal("dashscope"), t.Literal("gemini"), t.Literal("minimax")]),
        apiBaseUrl: t.String(),
        apiKey: t.String(),
      }),
    }
  )
  // 任务状态查询（前端轮询兜底，WS 为主）
  .get("/api/jobs/:id", ({ params, status }) => {
    const job = db.query("SELECT * FROM jobs WHERE id = ?").get(params.id);
    if (!job) return status(404, "任务不存在");
    return { job };
  })
  // 字体等静态文件（位于 apps/web/public/fonts）
  .get("/fonts/:name", ({ params, status }) => {
    const name = params.name;
    if (!/^[\w.-]+$/.test(name)) return status(400, "非法文件名");
    const file = Bun.file(join(import.meta.dir, "..", "..", "web", "public", "fonts", name));
    return new Response(file, {
      headers: {
        "Content-Type": name.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  })
  // 图像处理 worker 脚本：Bun 的 HTML 打包不处理 new Worker(URL)，这里按需 Bun.build 后同源下发
  .get("/imageops/imageOps.worker.js", async ({ status }) => {
    try {
      const code = await buildImageOpsWorker();
      return new Response(code, {
        headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
      });
    } catch (e) {
      return status(500, `worker 构建失败: ${(e as Error).message}`);
    }
  })
  .use(projectsApi)
  .use(framesApi)
  .use(importApi)
  .use(materialsApi)
  .use(settingsApi);

export type App = typeof app;
