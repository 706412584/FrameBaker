import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { GenProvider } from "@framebaker/shared";

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/** 从 OpenAI 兼容响应取图写盘：b64_json 直接解码，url 再下载 */
async function saveFirstImage(json: ImagesResponse, outPath: string): Promise<void> {
  const item = json.data?.[0];
  if (item?.b64_json) {
    writeFileSync(outPath, Buffer.from(item.b64_json, "base64"));
    return;
  }
  if (item?.url) {
    await downloadImage(item.url, outPath);
    return;
  }
  throw new Error("生成 API 响应缺少 data[0].b64_json / data[0].url");
}

async function downloadImage(url: string, outPath: string): Promise<void> {
  const img = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!img.ok) throw new Error(`下载生成图失败: HTTP ${img.status}`);
  writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}

async function readError(res: Response, which: string): Promise<Error> {
  const text = (await res.text()).slice(0, 500);
  return new Error(`生成 API ${which} 返回 ${res.status}: ${text}`);
}

/**
 * OpenAI 兼容图片生成：
 * - 无引用图：POST {base}/images/generations（JSON：{ model, prompt, size?, n: 1 }）
 * - 有引用图：POST {base}/images/edits（multipart：image + prompt + model + size?）
 *   edits 需模型支持（gpt-image 系列、dall-e-2 支持；dall-e-3 不支持，此时 API 报错会写入 job error）
 */
async function generateViaOpenAI(
  cfg: GenProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string
): Promise<void> {
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };

  let res: Response;
  if (referencePath) {
    const form = new FormData();
    form.append("image", new File([readFileSync(referencePath)], basename(referencePath), { type: "image/png" }));
    form.append("prompt", prompt);
    form.append("model", model);
    if (cfg.apiSize.trim()) form.append("size", cfg.apiSize.trim());
    res = await fetch(`${base}/images/edits`, {
      method: "POST",
      headers: auth,
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw await readError(res, "images/edits（引用图）");
  } else {
    const body: Record<string, unknown> = { model, prompt, n: 1 };
    if (cfg.apiSize.trim()) body.size = cfg.apiSize.trim();
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw await readError(res, "images/generations");
  }
  await saveFirstImage((await res.json()) as ImagesResponse, outPath);
}

interface DashscopeResponse {
  output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
  code?: string;
  message?: string;
}

/**
 * 百炼 DashScope 原生图片生成/编辑（qwen-image 系列官方接口，不在 OpenAI 兼容模式内）：
 * POST {base}/api/v1/services/aigc/multimodal-generation/generation
 * - 无引用图：messages content 仅 [{text}]（文生图）
 * - 有引用图：content 前置 {image: dataURI}（图像编辑/多图融合）
 * 同步返回 output.choices[0].message.content[*].image（URL，24h 有效，需及时下载）
 * 注意 size 为星号格式（如 2048*2048），由 provider 配置原样透传
 */
async function generateViaDashscope(
  cfg: GenProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string
): Promise<void> {
  // 容忍用户填到 /api/v1 为止的 baseUrl
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const content: Array<Record<string, string>> = [];
  if (referencePath) {
    const b64 = readFileSync(referencePath).toString("base64");
    content.push({ image: `data:image/png;base64,${b64}` });
  }
  content.push({ text: prompt });
  const parameters: Record<string, unknown> = { n: 1, watermark: false };
  if (cfg.apiSize.trim()) parameters.size = cfg.apiSize.trim();

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify({ model, input: { messages: [{ role: "user", content }] }, parameters }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new Error(`DashScope 请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) throw await readError(res, "multimodal-generation");

  const json = (await res.json()) as DashscopeResponse;
  if (json.code) throw new Error(`DashScope 错误 ${json.code}: ${json.message ?? ""}`);
  const imageUrl = json.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
  if (!imageUrl) throw new Error("DashScope 响应缺少 output.choices[0].message.content[*].image");
  await downloadImage(imageUrl, outPath);
}

/**
 * API 生成统一入口（按 provider.type 分发 OpenAI 兼容 / DashScope 原生）。
 * 模型在生成时单独指定（生成弹窗选择/输入），provider 只存连接信息
 */
export async function generateViaApi(
  cfg: GenProvider,
  prompt: string,
  model: string,
  _index: number,
  outPath: string,
  referencePath?: string
): Promise<void> {
  if (cfg.type === "dashscope") return generateViaDashscope(cfg, prompt, model, outPath, referencePath);
  return generateViaOpenAI(cfg, prompt, model, outPath, referencePath);
}
