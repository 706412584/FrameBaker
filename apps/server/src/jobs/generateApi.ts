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
    await downloadFile(item.url, outPath);
    return;
  }
  throw new Error("生成 API 响应缺少 data[0].b64_json / data[0].url");
}

/** 通用下载（生成图/视频写盘）；视频较大，超时放宽到 300s */
async function downloadFile(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`下载生成文件失败: HTTP ${res.status}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
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
  await downloadFile(imageUrl, outPath);
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
  error?: { message?: string };
}

/**
 * Gemini 图像生成（banana / nano-banana，gemini-2.5-flash-image 等）：
 * POST {base}/v1beta/models/{model}:generateContent（x-goog-api-key 头）
 * parts = [{text}, {inlineData: base64 引用图}?]；generationConfig.responseModalities=["TEXT","IMAGE"]
 * apiSize 映射 imageConfig.aspectRatio（如 16:9）；响应取 candidates[0].content.parts 首个 inlineData.data
 */
async function generateViaGemini(
  cfg: GenProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string
): Promise<void> {
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (referencePath) {
    parts.push({
      inlineData: { mimeType: "image/png", data: readFileSync(referencePath).toString("base64") },
    });
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (cfg.apiSize.trim()) generationConfig.imageConfig = { aspectRatio: cfg.apiSize.trim() };

  let res: Response;
  try {
    res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey.trim() },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new Error(`Gemini 请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) throw await readError(res, "generateContent");

  const json = (await res.json()) as GeminiResponse;
  if (json.error?.message) throw new Error(`Gemini 错误: ${json.error.message}`);
  const b64 = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!b64) throw new Error("Gemini 响应缺少 candidates[0].content.parts[*].inlineData.data");
  writeFileSync(outPath, Buffer.from(b64, "base64"));
}

interface MinimaxResponse {
  data?: { image_base64?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * MiniMax 图像生成（image-01）：POST {base}/v1/image_generation（Bearer）
 * 引用图走 subject_reference（主体特征保持，每次限一张；base64 dataURI 上送）
 * apiSize 映射 aspect_ratio（如 16:9，默认 1:1）；response_format=base64 直接取 data.image_base64[0]
 */
async function generateViaMinimax(
  cfg: GenProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string
): Promise<void> {
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const body: Record<string, unknown> = { model, prompt, n: 1, response_format: "base64" };
  if (cfg.apiSize.trim()) body.aspect_ratio = cfg.apiSize.trim();
  if (referencePath) {
    const dataUri = `data:image/png;base64,${readFileSync(referencePath).toString("base64")}`;
    body.subject_reference = [{ type: "character", image_file: dataUri }];
  }

  let res: Response;
  try {
    res = await fetch(`${base}/v1/image_generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey.trim()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new Error(`MiniMax 请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) throw await readError(res, "image_generation");

  const json = (await res.json()) as MinimaxResponse;
  if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${json.base_resp.status_code}: ${json.base_resp.status_msg ?? ""}`);
  }
  const b64 = json.data?.image_base64?.[0];
  if (!b64) throw new Error("MiniMax 响应缺少 data.image_base64");
  writeFileSync(outPath, Buffer.from(b64, "base64"));
}

/**
 * API 生成统一入口（按 provider.type 分发 OpenAI 兼容 / DashScope 原生 / Gemini / MiniMax）。
 * 模型在生成时单独指定（生成弹窗选择/输入），provider 只存连接信息；
 * sizeOverride 非空时覆盖 provider 的 apiSize（生成弹窗的尺寸选择）
 */
export async function generateViaApi(
  cfg: GenProvider,
  prompt: string,
  model: string,
  _index: number,
  outPath: string,
  referencePath?: string,
  sizeOverride?: string
): Promise<void> {
  const eff = sizeOverride?.trim() ? { ...cfg, apiSize: sizeOverride.trim() } : cfg;
  if (eff.type === "dashscope") return generateViaDashscope(eff, prompt, model, outPath, referencePath);
  if (eff.type === "gemini") return generateViaGemini(eff, prompt, model, outPath, referencePath);
  if (eff.type === "minimax") return generateViaMinimax(eff, prompt, model, outPath, referencePath);
  return generateViaOpenAI(eff, prompt, model, outPath, referencePath);
}

// ===== 视频生成（异步任务制：创建 → 轮询 → 下载 mp4；仅 dashscope / minimax）=====

const VIDEO_POLL_INTERVAL = 5_000;
const VIDEO_POLL_TIMEOUT = 10 * 60_000;

interface VideoPollResult {
  done: boolean;
  url?: string;
  error?: string;
}

/** 视频任务轮询：5s 间隔，10 分钟超时；进度文案经 report 写入 job.progress */
async function pollVideoTask(report: (s: string) => void, query: () => Promise<VideoPollResult>): Promise<string> {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT;
  for (;;) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    const r = await query();
    if (r.error) throw new Error(r.error);
    if (r.done) {
      if (!r.url) throw new Error("视频任务成功但响应缺少下载地址");
      return r.url;
    }
    if (Date.now() >= deadline) throw new Error("视频生成超时（10 分钟），请稍后重试");
    report("视频生成中（异步任务，约需数分钟）");
  }
}

/**
 * MiniMax 视频生成（v2 协议，MiniMax-H3 等）：
 * POST {base}/v2/video_generation { model, content:[{type:"text",text}], ratio? } → task_id
 * 轮询 GET {base}/v2/query/video_generation/{task_id}（task.status: succeeded/failed/cancelled）
 * 成功直接取 task.content.url 下载
 */
async function generateVideoViaMinimax(
  cfg: GenProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void
): Promise<void> {
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  const body: Record<string, unknown> = { model, content: [{ type: "text", text: prompt }] };
  if (cfg.apiSize.trim()) body.ratio = cfg.apiSize.trim();

  const res = await fetch(`${base}/v2/video_generation`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw await readError(res, "v2/video_generation");
  const created = (await res.json()) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (created.base_resp?.status_code && created.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${created.base_resp.status_code}: ${created.base_resp.status_msg ?? ""}`);
  }
  if (!created.task_id) throw new Error("MiniMax 视频任务创建失败：响应缺少 task_id");

  const url = await pollVideoTask(report, async () => {
    const q = await fetch(`${base}/v2/query/video_generation/${created.task_id}`, {
      headers: auth,
      signal: AbortSignal.timeout(30_000),
    });
    if (!q.ok) throw await readError(q, "v2/query/video_generation");
    const j = (await q.json()) as { task?: { status?: string; content?: { url?: string }; error?: { message?: string } } };
    const st = j.task?.status;
    if (st === "succeeded") return { done: true, url: j.task?.content?.url };
    if (st === "failed" || st === "cancelled") {
      return { done: false, error: `MiniMax 视频任务 ${st}: ${j.task?.error?.message ?? ""}` };
    }
    return { done: false };
  });
  await downloadFile(url, outPath);
}

/**
 * 百炼 DashScope 视频生成（万相 wan2.x/wanx2.1 旧版异步协议）：
 * POST {base}/api/v1/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
 *   { model, input:{prompt}, parameters:{size?, watermark:false} } → output.task_id
 * 轮询 GET {base}/api/v1/tasks/{task_id}（output.task_status: PENDING/RUNNING/SUCCEEDED/FAILED）
 * 成功取 output.video_url 下载
 */
async function generateVideoViaDashscope(
  cfg: GenProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void
): Promise<void> {
  // 容忍用户填到 /api/v1 为止的 baseUrl
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  const parameters: Record<string, unknown> = { watermark: false };
  if (cfg.apiSize.trim()) parameters.size = cfg.apiSize.trim();

  const res = await fetch(`${base}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify({ model, input: { prompt }, parameters }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw await readError(res, "video-synthesis");
  const created = (await res.json()) as {
    output?: { task_id?: string };
    code?: string;
    message?: string;
  };
  if (created.code) throw new Error(`DashScope 错误 ${created.code}: ${created.message ?? ""}`);
  const taskId = created.output?.task_id;
  if (!taskId) throw new Error("DashScope 视频任务创建失败：响应缺少 output.task_id");

  const url = await pollVideoTask(report, async () => {
    const q = await fetch(`${base}/api/v1/tasks/${taskId}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (!q.ok) throw await readError(q, "tasks 查询");
    const j = (await q.json()) as { output?: { task_status?: string; video_url?: string; code?: string; message?: string } };
    const st = j.output?.task_status;
    if (st === "SUCCEEDED") return { done: true, url: j.output?.video_url };
    if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
      return { done: false, error: `DashScope 视频任务 ${st}: ${j.output?.message ?? j.output?.code ?? ""}` };
    }
    return { done: false };
  });
  await downloadFile(url, outPath);
}

/**
 * API 视频生成统一入口（仅 dashscope / minimax，其余类型在前端已被过滤，这里兜底报错）。
 * 产出 mp4 到 outPath；耗时数分钟，进度经 report 写入 job.progress
 */
export async function generateVideoViaApi(
  cfg: GenProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void
): Promise<void> {
  if (cfg.type === "dashscope") return generateVideoViaDashscope(cfg, prompt, model, outPath, report);
  if (cfg.type === "minimax") return generateVideoViaMinimax(cfg, prompt, model, outPath, report);
  throw new Error(`该 provider 类型（${cfg.type}）不支持视频生成（支持：CLI / 百炼 / MiniMax）`);
}
