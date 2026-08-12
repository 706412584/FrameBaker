import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../apps/server/src/db";
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
import { checkVideoSupport, createProviderAdapter, listProviderModels, probeProviderModels } from "../apps/server/src/providerAdapter";
import { enhancePrompt } from "../apps/server/src/enhance";

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

  test("按图片/视频模式使用结构化且保留原意的优化指令", async () => {
    saveSetting("genProviders", [{
      id: "text", type: "api", apiBaseUrl: "https://api.example", apiKey: "key", textModels: ["text-model"],
    }]);
    saveSetting("promptEnhancers", [{ id: "enh", name: "增强", providerId: "text", model: "text-model" }]);
    const bodies: any[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "a pixel hero" } }] }), { status: 200 });
    }) as typeof fetch;

    await enhancePrompt({ enhancerId: "enh", prompt: "red fox running right", style: "pixel", mediaKind: "image" });
    await enhancePrompt({ enhancerId: "enh", prompt: "red fox running right", style: "pixel", mediaKind: "video" });

    expect(bodies[0].messages[0].content).toContain("subject; action/pose; composition/camera");
    expect(bodies[0].messages[0].content).toContain("readable silhouette");
    expect(bodies[0].messages[2].content).toContain("crisp pixel art");
    expect(bodies[1].messages[0].content).toContain("action order and timing");
    expect(bodies[1].messages[0].content).toContain("stable subject identity");
    expect(bodies[1].messages[2].content).toContain("continuous jump");
    expect(bodies[0].messages.at(-1)).toEqual({ role: "user", content: 'Optimization request (JSON wrapper, not output format): {"originalPrompt":"red fox running right","referenceImageCount":0}' });
  });

  test("few-shot 严格跟随所选风格，不用像素示例污染写实结果", async () => {
    saveSetting("genProviders", [{
      id: "text", type: "api", apiBaseUrl: "https://api.example", apiKey: "key", textModels: ["text-model"],
    }]);
    saveSetting("promptEnhancers", [{ id: "enh", name: "增强", providerId: "text", model: "text-model" }]);
    let body: any;
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "A black knight in realistic dark plate armor" } }] }), { status: 200 });
    }) as typeof fetch;

    await enhancePrompt({ enhancerId: "enh", prompt: "黑骑士", style: "realistic", mediaKind: "image", referenceImageCount: 3 });

    expect(body.messages[0].content).toContain("photorealistic 风格");
    expect(body.messages[0].content).not.toContain("pixel clusters");
    expect(body.messages[0].content).toContain("3 images will be attached");
    expect(body.messages[2].content).toContain("photorealistic rendering");
    expect(body.messages[2].content).toContain("Image 1 through Image 3");
    expect(body.messages[2].content).not.toContain("pixel art");
  });

  test("短名词被误答时自动纠正重试，不把聊天回答当提示词", async () => {
    saveSetting("genProviders", [{
      id: "text", type: "api", apiBaseUrl: "https://api.example", apiKey: "key", textModels: ["text-model"],
    }]);
    saveSetting("promptEnhancers", [{ id: "enh", name: "增强", providerId: "text", model: "text-model" }]);
    const bodies: any[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const content = bodies.length === 1
        ? "你好！黑骑士可以指很多不同的东西。请提供更多上下文。"
        : "A solitary black knight in dark plate armor; full-body heroic stance; centered composition; crisp pixel-art silhouette; limited charcoal and steel palette";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;

    await expect(enhancePrompt({ enhancerId: "enh", prompt: "黑骑士", style: "pixel" })).resolves.toMatchObject({
      enhanced: "A solitary black knight in dark plate armor; full-body heroic stance; centered composition; crisp pixel-art silhouette; limited charcoal and steel palette",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.at(-1).content).toContain("answered or questioned the source");
    expect(bodies[1].messages[3]).toEqual({ role: "user", content: 'Optimization request (JSON wrapper, not output format): {"originalPrompt":"黑骑士","referenceImageCount":0}' });
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
