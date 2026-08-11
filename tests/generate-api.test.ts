import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateViaApi } from "../apps/server/src/jobs/generateApi";

const originalFetch = globalThis.fetch;
const tempDir = mkdtempSync(join(tmpdir(), "framebaker-generate-test-"));

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function provider(type: "api" | "dashscope" | "gemini" | "minimax", apiSize = ""): any {
  return {
    id: type,
    name: type,
    type,
    cliBin: "", cliPromptArg: "", cliOutputArg: "", cliModelArg: "", cliReferenceArg: "", cliExtraArgs: "",
    apiBaseUrl: `https://${type}.example/`, apiKey: " test-key ", imageModels: [], videoModels: [], textModels: [], imageSize: apiSize, videoSize: "", apiSize,
  };
}

describe("图像 API 生成编排", () => {
  test("OpenAI 兼容接口传递尺寸并写入 base64 图片", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("openai-image").toString("base64") }] }), { status: 200 });
    }) as typeof fetch;
    const output = join(tempDir, "openai.png");

    await generateViaApi(provider("api", "1024x1024"), "pixel hero", "gpt-image", 0, output);

    expect(request?.url).toBe("https://api.example/images/generations");
    expect(request?.headers.get("authorization")).toBe("Bearer test-key");
    await expect(request?.json()).resolves.toEqual({ model: "gpt-image", prompt: "pixel hero", n: 1, size: "1024x1024" });
    expect(readFileSync(output).toString()).toBe("openai-image");
  });

  test("DashScope 下载返回图片 URL，并规范化兼容模式地址", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (urls.length === 1) {
        return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://cdn.example/image.png" }] } }] } }), { status: 200 });
      }
      return new Response("dashscope-image", { status: 200 });
    }) as typeof fetch;
    const cfg = provider("dashscope", "2K");
    cfg.apiBaseUrl = "https://dash.example/compatible-mode/v1/";
    const output = join(tempDir, "dashscope.png");

    await generateViaApi(cfg, "cat", "qwen-image", 0, output);

    expect(urls).toEqual(["https://dash.example/api/v1/services/aigc/multimodal-generation/generation", "https://cdn.example/image.png"]);
    expect(bodies[0]).toMatchObject({ model: "qwen-image", input: { messages: [{ role: "user", content: [{ text: "cat" }] }] }, parameters: { n: 1, watermark: false, size: "2K" } });
    expect(readFileSync(output).toString()).toBe("dashscope-image");
  });

  test("Gemini 使用模型转义、API key 头并写入 inlineData", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("gemini-image").toString("base64") } }] } }] }), { status: 200 });
    }) as typeof fetch;
    const output = join(tempDir, "gemini.png");

    await generateViaApi(provider("gemini", "16:9"), "dragon", "gemini/image", 0, output);

    expect(request?.url).toBe("https://gemini.example/v1beta/models/gemini%2Fimage:generateContent");
    expect(request?.headers.get("x-goog-api-key")).toBe("test-key");
    expect(readFileSync(output).toString()).toBe("gemini-image");
  });

  test("Gemini 遍历全部候选并兼容代理的 snake_case 图片 part", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      candidates: [
        { content: { parts: [{ text: "先说明" }] }, finishReason: "STOP" },
        { content: { parts: [{ inline_data: { mime_type: "image/png", data: Buffer.from("second-image").toString("base64") } }] }, finishReason: "STOP" },
      ],
    }), { status: 200 })) as typeof fetch;
    const output = join(tempDir, "gemini-second.png");

    await generateViaApi(provider("gemini"), "dragon", "gemini-image", 0, output);

    expect(readFileSync(output).toString()).toBe("second-image");
  });

  test("Gemini NO_IMAGE 自动重试一次后可恢复", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ candidates: [{ finishReason: "NO_IMAGE" }], responseId: "first" }), { status: 200 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("retried-image").toString("base64") } }] } }] }), { status: 200 });
    }) as typeof fetch;
    const output = join(tempDir, "gemini-retry.png");

    await generateViaApi(provider("gemini"), "dragon", "gemini-image", 0, output);

    expect(calls).toBe(2);
    expect(readFileSync(output).toString()).toBe("retried-image");
  });

  test("Gemini 安全拦截和文本拒绝返回明确原因且不重试", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "I cannot create that image." }] }, finishReason: "IMAGE_SAFETY" }],
        responseId: "blocked-response",
      }), { status: 200 });
    }) as typeof fetch;

    await expect(generateViaApi(provider("gemini"), "dragon", "gemini-image", 0, join(tempDir, "gemini-blocked.png"))).rejects.toThrow(
      "finishReason=IMAGE_SAFETY；模型返回文本：I cannot create that image.；responseId=blocked-response"
    );
    expect(calls).toBe(1);
  });

  test("Gemini 提示词拦截优先显示 promptFeedback", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "request rejected" },
    }), { status: 200 })) as typeof fetch;

    await expect(generateViaApi(provider("gemini"), "dragon", "gemini-image", 0, join(tempDir, "gemini-prompt-blocked.png"))).rejects.toThrow(
      "Gemini 提示词被拦截（blockReason=PROHIBITED_CONTENT）: request rejected"
    );
  });

  test("MiniMax 限制 prompt 长度、覆盖尺寸并写入 base64", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: { image_base64: [Buffer.from("minimax-image").toString("base64")] } }), { status: 200 });
    }) as typeof fetch;
    const output = join(tempDir, "minimax.png");

    await generateViaApi(provider("minimax"), "x".repeat(2_000), "image-01", 0, output, undefined, "9:16");

    expect(body).toMatchObject({ model: "image-01", n: 1, response_format: "base64", aspect_ratio: "9:16" });
    expect(String(body?.prompt)).toHaveLength(1499);
    expect(readFileSync(output).toString()).toBe("minimax-image");
  });

  test("取消状态会在发请求前失败", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (() => { throw new Error("不应发起请求"); }) as typeof fetch;
    await expect(generateViaApi(provider("api"), "x", "model", 0, join(tempDir, "cancelled.png"), undefined, undefined, controller.signal)).rejects.toThrow("任务已取消");
  });
});

process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
