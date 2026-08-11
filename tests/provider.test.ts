import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../apps/server/src/db";
import { app } from "../apps/server/src/app";
import { buildEnhanceSystem } from "../apps/server/src/enhance";
import {
  enhancerConfigured,
  getGenProviders,
  getImageLayerSettings,
  getMattingSettings,
  getPromptEnhancers,
  providerConfigured,
  resolveEnhancerRuntime,
  resolveGenProvider,
} from "../apps/server/src/provider";
import { checkImageReferenceSupport, checkVideoSupport, createProviderAdapter, listProviderModels, probeProviderModels } from "../apps/server/src/providerAdapter";

const originalFetch = globalThis.fetch;
const originalGenCli = process.env.FRAMEBAKER_GEN_CLI;
const originalMattingModel = process.env.FRAMEBAKER_MATTING_MODEL;
const testSettingKeys = ["genProviders", "matting", "imageLayers", "promptEnhancers"];
let savedSettings: Array<{ key: string; value: string; updated_at: number }> = [];

function saveSetting(key: string, value: unknown) {
  db.query("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), Date.now());
}

beforeEach(() => {
  savedSettings = db.query("SELECT key, value, updated_at FROM settings WHERE key IN ('genProviders', 'matting', 'imageLayers', 'promptEnhancers')").all() as Array<{
    key: string;
    value: string;
    updated_at: number;
  }>;
  db.query(`DELETE FROM settings WHERE key IN (${testSettingKeys.map(() => "?").join(", ")})`).run(...testSettingKeys);
  delete process.env.FRAMEBAKER_GEN_CLI;
  delete process.env.FRAMEBAKER_MATTING_MODEL;
});

afterEach(() => {
  db.query(`DELETE FROM settings WHERE key IN (${testSettingKeys.map(() => "?").join(", ")})`).run(...testSettingKeys);
  const restore = db.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  for (const setting of savedSettings) restore.run(setting.key, setting.value, setting.updated_at);
  globalThis.fetch = originalFetch;
  if (originalGenCli === undefined) delete process.env.FRAMEBAKER_GEN_CLI;
  else process.env.FRAMEBAKER_GEN_CLI = originalGenCli;
  if (originalMattingModel === undefined) delete process.env.FRAMEBAKER_MATTING_MODEL;
  else process.env.FRAMEBAKER_MATTING_MODEL = originalMattingModel;
});

describe("生成 provider 配置解析", () => {
  test("空设置时从环境变量创建遗留 CLI provider", () => {
    process.env.FRAMEBAKER_GEN_CLI = "generator --prompt {prompt} -o {output}";

    const [provider] = getGenProviders();
    expect(provider).toMatchObject({ id: "env", type: "cli", legacyTemplate: process.env.FRAMEBAKER_GEN_CLI });
    expect(providerConfigured(provider!)).toBe(true);
    expect(resolveGenProvider()).toMatchObject({ id: "env" });
  });

  test("旧模型列表按能力归类，新字段存在时优先新字段并过滤无效值", () => {
    saveSetting("genProviders", [
      { id: "legacy", type: "dashscope", apiModels: ["qwen-image", "wan-t2v", 42], apiSize: "1024x1024" },
      { id: "modern", name: " Modern ", type: "api", imageModels: ["image-a", null], videoModels: ["video-a"], textModels: "bad", layerModels: ["layer-a", 42] },
      { id: "invalid" },
    ]);

    const providers = getGenProviders();
    expect(providers).toHaveLength(3);
    expect(providers[0]).toMatchObject({ imageModels: ["qwen-image"], videoModels: ["wan-t2v"], imageSize: "1024x1024", videoSize: "1024x1024" });
    expect(providers[1]).toMatchObject({ name: "Modern", imageModels: ["image-a"], videoModels: ["video-a"], textModels: [] });
    expect(providers[1]).not.toHaveProperty("layerModels");
    expect(providers[2]).toMatchObject({ id: "invalid", type: "cli", name: "invalid" });
    expect(resolveGenProvider()).toMatchObject({ id: "legacy" });
    expect(resolveGenProvider("missing")).toBeNull();
  });

  test("优先选择配置完整的 provider，并解析抠图设置的环境回退", () => {
    saveSetting("genProviders", [
      { id: "empty", type: "api" },
      { id: "configured", type: "api", apiBaseUrl: " https://api.example.com/ ", apiKey: " key " },
    ]);
    process.env.FRAMEBAKER_MATTING_MODEL = "env-model";

    expect(resolveGenProvider()).toMatchObject({ id: "configured" });
    expect(getMattingSettings()).toMatchObject({ model: "env-model", cliBin: "" });
    saveSetting("matting", { cliBin: "rembg", model: " saved-model " });
    expect(getMattingSettings()).toMatchObject({ cliBin: "rembg", model: "saved-model" });
  });

  test("图片分层优先读取独立设置，并兼容旧 Provider 配置", () => {
    saveSetting("genProviders", [{
      id: "legacy-layers", type: "api", apiBaseUrl: "https://legacy.example/v1", apiKey: "legacy-key", layerModels: ["legacy-model"],
    }]);
    expect(getImageLayerSettings()).toEqual({
      apiBaseUrl: "https://legacy.example/v1", apiKey: "legacy-key", model: "legacy-model",
    });

    saveSetting("imageLayers", { apiBaseUrl: "https://layers.example/v1", apiKey: "layer-key", model: " layer-model " });
    expect(getImageLayerSettings()).toEqual({
      apiBaseUrl: "https://layers.example/v1", apiKey: "layer-key", model: "layer-model",
    });
  });
});

describe("提示词加强器关联", () => {
  test("普通优化不注入骨骼约束，骨骼各阶段注入对应的失败经验", () => {
    const ordinary = buildEnhanceSystem("pixel", "image");
    expect(ordinary).not.toContain("neutral T-pose");
    expect(ordinary).not.toContain("strict 4x3");
    expect(ordinary).not.toContain("bone lengths");

    const character = buildEnhanceSystem("pixel", "image", "skeletal-character");
    expect(character).toContain("exactly one full-body character");
    expect(character).toContain("neutral T-pose");
    expect(character).toContain("双手空置");
    expect(character).toContain("肘和膝");
    expect(character).toContain("披风、裙摆、长发");
    expect(character).toContain("parts sheet");

    const parts = buildEnhanceSystem("pixel", "image", "skeletal-decompose");
    expect(parts).toContain("strict 4x3 character parts sheet");
    expect(parts).toContain("head, torso, pelvis, weapon");
    expect(parts).toContain("upper-arm-left, forearm-left, upper-arm-right, forearm-right");
    expect(parts).toContain("thigh-left, shin-left, thigh-right, shin-right");
    expect(parts).toContain("不得跨 cell boundary");
    expect(parts).toContain("禁止 whole arm 或 whole leg");
    expect(parts).toContain("upper arm 必须在肘部结束且绝不能带手");
    expect(parts).toContain("整张图只能有两只手");
    expect(parts).toContain("pelvis 必须是腰胯");
    expect(parts).toContain("mirror-copy");
    expect(parts).toContain("recursive parts sheet");

    const repair = buildEnhanceSystem("pixel", "image", "skeletal-repair-part");
    expect(repair).toContain("one missing or incorrect body part");
    expect(repair).toContain("禁止完整人物、完整分件表或任何其他部件");

    const motion = buildEnhanceSystem("pixel", "video", "motion-clip");
    expect(motion).toContain("bone lengths");
    expect(motion).toContain("preparation/wind-up, contact/hit, recovery");
    expect(motion).toContain("root drift");
    expect(motion).toContain("hand/socket attachment");
    expect(motion).toContain("seamless first/last-frame continuity");
  });

  test("提示词加强 API 接受合法骨骼 intent 并拒绝未知值", async () => {
    saveSetting("genProviders", [{
      id: "api", type: "api", apiBaseUrl: "https://api.example/v1", apiKey: "key", textModels: ["text-1"],
    }]);
    saveSetting("promptEnhancers", [{ id: "enh", name: "骨骼优化", providerId: "api", model: "text-1" }]);
    let systemPrompt = "";
    let requestCount = 0;
    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      systemPrompt = payload.messages[0]?.content ?? "";
      requestCount += 1;
      if (requestCount === 1) return new Response("upstream stream closed", { status: 408 });
      return Response.json({ choices: [{ message: { content: `<think>private reasoning</think>\n\`\`\`text\nPrompt: enhanced attack\nwith no drift ${"detail ".repeat(150)}\n\`\`\`` } }] });
    }) as typeof fetch;

    const valid = await app.handle(new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "sword attack", mediaKind: "video", intent: "motion-clip" }),
    }));
    expect(valid.status).toBe(200);
    const validBody = await valid.json() as { enhanced: string; enhancerName: string };
    expect(validBody.enhancerName).toBe("骨骼优化");
    expect(validBody.enhanced).toStartWith("enhanced attack with no drift");
    expect(validBody.enhanced.length).toBeLessThanOrEqual(700);
    expect(validBody.enhanced).not.toContain("\n");
    expect(validBody.enhanced).not.toContain("private reasoning");
    expect(requestCount).toBe(2);
    expect(systemPrompt).toContain("preparation/wind-up, contact/hit, recovery");

    const invalid = await app.handle(new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "sword attack", intent: "unknown-skeletal-stage" }),
    }));
    expect(invalid.status).toBe(422);
  });

  test("通过 providerId 复用 DashScope 凭证并标准化端点", () => {
    saveSetting("genProviders", [{
      id: "dash", type: "dashscope", apiBaseUrl: "https://dash.example.com/compatible-mode/v1/", apiKey: " secret ", textModels: ["qwen-plus"],
    }]);
    saveSetting("promptEnhancers", [{ id: "enh", name: "增强", providerId: "dash", model: " qwen-plus " }]);

    const [enhancer] = getPromptEnhancers();
    expect(enhancerConfigured(enhancer!)).toBe(true);
    expect(resolveEnhancerRuntime(enhancer!)).toEqual({
      baseUrl: "https://dash.example.com/compatible-mode/v1",
      apiKey: "secret",
      model: "qwen-plus",
      providerType: "dashscope",
    });
  });

  test("旧凭证配置可回退，模型名重复时不猜测 provider", () => {
    saveSetting("genProviders", [
      { id: "one", type: "api", apiBaseUrl: "https://one", apiKey: "key", textModels: ["shared"] },
      { id: "two", type: "api", apiBaseUrl: "https://two", apiKey: "key", textModels: ["shared"] },
    ]);
    saveSetting("promptEnhancers", [
      { id: "legacy", apiBaseUrl: "https://legacy/", apiKey: " old-key ", apiModel: " old-model " },
      { id: "ambiguous", model: "shared" },
    ]);

    const [legacy, ambiguous] = getPromptEnhancers();
    expect(resolveEnhancerRuntime(legacy!)).toEqual({ baseUrl: "https://legacy", apiKey: "old-key", model: "old-model", providerType: "api" });
    expect(enhancerConfigured(ambiguous!)).toBe(false);
  });
});

describe("Provider 模型探测", () => {
  test("按厂商构建请求、提取模型列表，并识别认证与网络异常", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-2" }] }), { status: 200 });
    }) as typeof fetch;

    await expect(probeProviderModels("gemini", "https://gemini.example", "key")).resolves.toMatchObject({ ok: true, models: ["gemini-2"] });
    expect(requests[0]).toEqual({ url: "https://gemini.example/v1beta/models", headers: new Headers({ "x-goog-api-key": "key" }) });

    globalThis.fetch = (async () => new Response("denied", { status: 401 })) as typeof fetch;
    await expect(probeProviderModels("api", "https://api.example", "key")).resolves.toMatchObject({ ok: false, status: 401, error: "认证失败：API Key 无效或权限不足" });

    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    await expect(probeProviderModels("api", "https://api.example", "key")).resolves.toMatchObject({ ok: false, error: "连接失败: offline" });
  });

  test("模型列表接口校验必填字段、DashScope 地址和非标准响应", async () => {
    await expect(listProviderModels({ type: "api", apiBaseUrl: "", apiKey: "" })).resolves.toEqual({ ok: false, error: "Base URL 与 API Key 不能为空" });

    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: "wan-t2v" }] }), { status: 200 });
    }) as typeof fetch;
    await expect(listProviderModels({ type: "dashscope", apiBaseUrl: "https://dash.example/api/v1/", apiKey: "key" })).resolves.toEqual({ ok: true, status: 200, models: ["wan-t2v"] });
    expect(requestedUrl).toBe("https://dash.example/compatible-mode/v1/models");

    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    await expect(listProviderModels({ type: "api", apiBaseUrl: "https://api.example", apiKey: "key" })).resolves.toEqual({ ok: false, status: 200, error: "接口连通但返回的不是标准模型列表" });
  });
});

describe("生成适配器校验", () => {
  test("结构化 CLI 参数可执行，并保留 provider 元信息", async () => {
    saveSetting("genProviders", [{
      id: "cli", name: "本地命令", type: "cli", cliBin: "/usr/bin/true", cliPromptArg: "--prompt", cliOutputArg: "--output", cliModelArg: "--model", cliExtraArgs: "--fast mode",
    }]);

    const adapter = createProviderAdapter({ prompt: "hero", providerId: "cli", model: "v1" }, () => {});
    expect(adapter).toMatchObject({ source: "cli", providerName: "本地命令", model: "v1" });
    await expect(adapter.produce("/tmp/unused.png", 3)).resolves.toBeUndefined();
  });

  test("两阶段角色生成会预检 CLI 引用图能力", () => {
    saveSetting("genProviders", [{
      id: "cli", name: "无引用命令", type: "cli", cliBin: "/usr/bin/true", cliPromptArg: "--prompt", cliOutputArg: "--output",
    }]);
    expect(checkImageReferenceSupport("cli")).toContain("未配置引用图参数名");
    expect(() => createProviderAdapter({ prompt: "split", providerId: "cli", referencePath: "/tmp/reference.png" }, () => {})).toThrow("无法自动拆分完整角色");

    saveSetting("genProviders", [{
      id: "cli", name: "支持引用命令", type: "cli", cliBin: "/usr/bin/true", cliPromptArg: "--prompt", cliOutputArg: "--output", cliReferenceArg: "--reference",
    }]);
    expect(checkImageReferenceSupport("cli")).toBeNull();
  });

  test("拒绝未配置、能力不匹配与不支持的视频请求", () => {
    saveSetting("genProviders", [
      { id: "api", name: "图片 API", type: "api", apiBaseUrl: "https://api.example", apiKey: "key", imageModels: ["image-1"], videoModels: [] },
      { id: "gemini", name: "Gemini", type: "gemini", apiBaseUrl: "https://gemini.example", apiKey: "key", imageModels: ["image-1"], videoModels: ["video-1"] },
    ]);

    expect(() => createProviderAdapter({ prompt: "x", providerId: "api", model: "other" }, () => {})).toThrow("不属于 provider");
    expect(() => createProviderAdapter({ prompt: "x", providerId: "api", mediaKind: "video" }, () => {})).toThrow("不支持视频生成");
    expect(() => createProviderAdapter({ prompt: "x", providerId: "gemini", mediaKind: "video" }, () => {})).toThrow("不支持视频生成");
    expect(checkVideoSupport({ providerId: "api", mediaKind: "video" })).toContain("不支持视频生成");
    expect(checkVideoSupport({ providerId: "missing", mediaKind: "video" })).toContain("不存在或未配置");
    expect(checkVideoSupport({ providerId: "api", mediaKind: "image" })).toBeNull();
  });

  test("视频支持 provider 必须配置视频模型", () => {
    saveSetting("genProviders", [{
      id: "dash", name: "百炼", type: "dashscope", apiBaseUrl: "https://dash.example", apiKey: "key", imageModels: ["qwen-image"], videoModels: [],
    }]);

    expect(() => createProviderAdapter({ prompt: "x", providerId: "dash", mediaKind: "video" }, () => {})).toThrow("未配置视频模型");
    expect(checkVideoSupport({ providerId: "dash", mediaKind: "video" })).toContain("未配置视频模型");
  });
});
