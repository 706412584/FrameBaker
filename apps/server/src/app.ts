import { Elysia } from "elysia";
import { join } from "node:path";
import type { ServerConfig } from "@framebaker/shared";
import { db } from "./db";
import { mattingInfo } from "./jobs/matting";
import { projectsApi } from "./api/projects";
import { framesApi } from "./api/frames";
import { importApi } from "./api/import";
import { materialsApi } from "./api/materials";
import { settingsApi } from "./api/settings";

export const app = new Elysia()
  .get("/api/health", () => ({ ok: true, name: "FrameBaker" }))
  // 服务端能力探测（抠图引擎、生成 CLI 配置状态）
  .get("/api/config", (): ServerConfig => {
    return {
      matting: { engine: mattingInfo.engine, model: mattingInfo.model, hint: mattingInfo.hint },
      genCliConfigured: !!process.env.FRAMEBAKER_GEN_CLI?.trim(),
    };
  })
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
  .use(projectsApi)
  .use(framesApi)
  .use(importApi)
  .use(materialsApi)
  .use(settingsApi);

export type App = typeof app;
