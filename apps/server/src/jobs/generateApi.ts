import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { GenProvider } from "@framebaker/shared";
type RuntimeProvider = GenProvider & { apiSize: string };
import { normalizeDashscopeBaseUrl } from "@framebaker/shared";
import { JobCancelledError } from "./run";

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/** MiniMax 图像 prompt 上限（官方 invalid params: length must be less than 1500） */
const MINIMAX_PROMPT_MAX = 1499;

function clampMinimaxPrompt(prompt: string): string {
  if (prompt.length <= MINIMAX_PROMPT_MAX) return prompt;
  return `${prompt.slice(0, MINIMAX_PROMPT_MAX - 1)}…`;
}

/** 合并用户取消信号与超时（二者任一触发即 abort） */
function fetchSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (timeoutMs) parts.push(AbortSignal.timeout(timeoutMs));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

/** 从 OpenAI 兼容响应取图写盘：b64_json 直接解码，url 再下载 */
async function saveFirstImage(json: ImagesResponse, outPath: string, signal?: AbortSignal): Promise<void> {
  const item = json.data?.[0];
  if (item?.b64_json) {
    writeFileSync(outPath, Buffer.from(item.b64_json, "base64"));
    return;
  }
  if (item?.url) {
    await downloadFile(item.url, outPath, signal);
    return;
  }
  throw new Error("生成 API 响应缺少 data[0].b64_json / data[0].url");
}

/** 通用下载（生成图/视频写盘）；视频较大，超时放宽到 300s */
async function downloadFile(url: string, outPath: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal: fetchSignal(signal, 300_000) });
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
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string,
  poseReferencePath?: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };

  let res: Response;
  if (referencePath) {
    const form = new FormData();
    const appearance = new File([readFileSync(referencePath)], basename(referencePath), { type: "image/png" });
    if (poseReferencePath) {
      form.append("image[]", appearance);
      form.append("image[]", new File([readFileSync(poseReferencePath)], basename(poseReferencePath), { type: "image/png" }));
    } else {
      form.append("image", appearance);
    }
    form.append("prompt", prompt);
    form.append("model", model);
    if (cfg.apiSize.trim()) form.append("size", cfg.apiSize.trim());
    res = await fetch(`${base}/images/edits`, {
      method: "POST",
      headers: auth,
      body: form,
      signal: fetchSignal(signal, 180_000),
    });
    if (!res.ok) throw await readError(res, "images/edits（引用图）");
  } else {
    const body: Record<string, unknown> = { model, prompt, n: 1 };
    if (cfg.apiSize.trim()) body.size = cfg.apiSize.trim();
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: fetchSignal(signal, 120_000),
    });
    if (!res.ok) throw await readError(res, "images/generations");
  }
  await saveFirstImage((await res.json()) as ImagesResponse, outPath, signal);
}

interface DashscopeResponse {
  output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
  code?: string;
  message?: string;
}

/**
 * 百炼 DashScope 原生图片生成/编辑（wan2.7-image / qwen-image 等官方接口，不在 OpenAI 兼容模式内）：
 * POST {base}/api/v1/services/aigc/multimodal-generation/generation
 * - 无引用图：messages content 仅 [{text}]（文生图）
 * - 有引用图：content 前置 {image: dataURI}（图像编辑/多图融合）
 * 同步返回 output.choices[0].message.content[*].image（URL，24h 有效，需及时下载）
 * size 可为 1K/2K/4K 或星号格式（如 2048*2048），由 provider 配置原样透传
 */
async function generateViaDashscope(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string,
  poseReferencePath?: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  // Token Plan 可粘贴 …/compatible-mode/v1；归一到 host 根再拼原生路径
  const base = normalizeDashscopeBaseUrl(cfg.apiBaseUrl);
  const content: Array<Record<string, string>> = [];
  if (referencePath) {
    const b64 = readFileSync(referencePath).toString("base64");
    content.push({ image: `data:image/png;base64,${b64}` });
  }
  if (poseReferencePath) {
    const b64 = readFileSync(poseReferencePath).toString("base64");
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
      signal: fetchSignal(signal, 180_000),
    });
  } catch (e) {
    throw new Error(`DashScope 请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) throw await readError(res, "multimodal-generation");

  const json = (await res.json()) as DashscopeResponse;
  if (json.code) throw new Error(`DashScope 错误 ${json.code}: ${json.message ?? ""}`);
  const imageUrl = json.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
  if (!imageUrl) throw new Error("DashScope 响应缺少 output.choices[0].message.content[*].image");
  await downloadFile(imageUrl, outPath, signal);
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
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string,
  poseReferencePath?: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  // 有引用图时图在前、文在后，利于图像编辑/角色一致性（无引用则仅 text）
  const parts: Array<Record<string, unknown>> = [];
  if (referencePath) {
    parts.push({
      inlineData: { mimeType: "image/png", data: readFileSync(referencePath).toString("base64") },
    });
  }
  if (poseReferencePath) {
    parts.push({
      inlineData: { mimeType: "image/png", data: readFileSync(poseReferencePath).toString("base64") },
    });
  }
  parts.push({ text: prompt });
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (cfg.apiSize.trim()) generationConfig.imageConfig = { aspectRatio: cfg.apiSize.trim() };

  let res: Response;
  try {
    res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey.trim() },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      signal: fetchSignal(signal, 180_000),
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
 * prompt 官方限制小于 1500 字符，超长截断
 */
async function generateViaMinimax(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePath?: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model,
    prompt: clampMinimaxPrompt(prompt),
    n: 1,
    response_format: "base64",
  };
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
      signal: fetchSignal(signal, 180_000),
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
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  _index: number,
  outPath: string,
  referencePath?: string,
  sizeOverride?: string,
  signal?: AbortSignal,
  poseReferencePath?: string
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const eff = sizeOverride?.trim() ? { ...cfg, apiSize: sizeOverride.trim() } : cfg;
  if (eff.type === "dashscope") return generateViaDashscope(eff, prompt, model, outPath, referencePath, poseReferencePath, signal);
  if (eff.type === "gemini") return generateViaGemini(eff, prompt, model, outPath, referencePath, poseReferencePath, signal);
  if (eff.type === "minimax") {
    if (poseReferencePath) throw new Error("MiniMax 图片生成暂不支持独立动作参考图");
    return generateViaMinimax(eff, prompt, model, outPath, referencePath, signal);
  }
  return generateViaOpenAI(eff, prompt, model, outPath, referencePath, poseReferencePath, signal);
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
async function pollVideoTask(
  report: (s: string) => void,
  query: () => Promise<VideoPollResult>,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT;
  for (;;) {
    if (signal?.aborted) throw new JobCancelledError();
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    if (signal?.aborted) throw new JobCancelledError();
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

/** MiniMax-H3 等走 v2；Hailuo / T2V-01 等走 v1（多数套餐仍是后者） */
function usesMinimaxVideoV2(model: string): boolean {
  // MiniMax-H3（H 后跟数字）；Hailuo 为 MiniMax-Hailuo-*，不会命中
  return /^MiniMax-H\d/i.test(model.trim());
}

/** v1 成功后经 file_id 换下载地址 */
async function retrieveMinimaxFileUrl(
  base: string,
  auth: Record<string, string>,
  fileId: string,
  signal?: AbortSignal
): Promise<string> {
  const q = await fetch(`${base}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    headers: auth,
    signal: fetchSignal(signal, 30_000),
  });
  if (!q.ok) throw await readError(q, "v1/files/retrieve");
  const j = (await q.json()) as {
    file?: { download_url?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (j.base_resp?.status_code && j.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${j.base_resp.status_code}: ${j.base_resp.status_msg ?? ""}`);
  }
  const url = j.file?.download_url?.trim();
  if (!url) throw new Error("MiniMax 文件检索响应缺少 download_url");
  return url.startsWith("http") ? url : `https://${url}`;
}

/**
 * MiniMax 视频（Hailuo / T2V 等 v1）：
 * POST {base}/v1/video_generation { model, prompt, duration? } → task_id
 * 轮询 GET {base}/v1/query/video_generation?task_id=…（Success/Fail）→ file_id
 * 再 GET {base}/v1/files/retrieve?file_id=… 取 download_url
 */
async function generateVideoViaMinimaxV1(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  const body: Record<string, unknown> = {
    model,
    prompt: clampMinimaxPrompt(prompt),
    duration: 6,
  };
  // apiSize 若写成 768P/1080P/720P 则当作 resolution；宽高比留给 v2
  const size = cfg.apiSize.trim().toUpperCase();
  if (/^(720|768|1080)P$/.test(size)) body.resolution = size;

  const res = await fetch(`${base}/v1/video_generation`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: fetchSignal(signal, 60_000),
  });
  if (!res.ok) throw await readError(res, "v1/video_generation");
  const created = (await res.json()) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (created.base_resp?.status_code && created.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${created.base_resp.status_code}: ${created.base_resp.status_msg ?? ""}`);
  }
  if (!created.task_id) throw new Error("MiniMax 视频任务创建失败：响应缺少 task_id");

  const fileId = await pollVideoTask(
    report,
    async () => {
      const q = await fetch(`${base}/v1/query/video_generation?task_id=${encodeURIComponent(created.task_id!)}`, {
        headers: auth,
        signal: fetchSignal(signal, 30_000),
      });
      if (!q.ok) throw await readError(q, "v1/query/video_generation");
      const j = (await q.json()) as {
        status?: string;
        file_id?: string | number;
        base_resp?: { status_code?: number; status_msg?: string };
      };
      if (j.base_resp?.status_code && j.base_resp.status_code !== 0) {
        return { done: false, error: `MiniMax 错误 ${j.base_resp.status_code}: ${j.base_resp.status_msg ?? ""}` };
      }
      const st = (j.status ?? "").toLowerCase();
      if (st === "success") {
        if (j.file_id == null) return { done: false, error: "MiniMax 视频成功但缺少 file_id" };
        return { done: true, url: String(j.file_id) }; // 暂存 file_id，下面再换下载 URL
      }
      if (st === "fail" || st === "failed") {
        return { done: false, error: `MiniMax 视频任务失败: ${j.base_resp?.status_msg ?? ""}` };
      }
      return { done: false };
    },
    signal
  );
  const url = await retrieveMinimaxFileUrl(base, auth, fileId, signal);
  await downloadFile(url, outPath, signal);
}

/**
 * MiniMax 视频（H3 等 v2）：
 * POST {base}/v2/video_generation { model, content:[{type:"text",text}], duration, ratio? } → task_id
 * 轮询 GET {base}/v2/query/video_generation/{task_id}（task.status: succeeded/failed/cancelled）
 * 成功直接取 task.content.url 下载
 */
async function generateVideoViaMinimaxV2(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  // 文生视频 ratio 必填且不可 adaptive；缺省 16:9
  const ratio = cfg.apiSize.trim() || "16:9";
  const body: Record<string, unknown> = {
    model,
    content: [{ type: "text", text: clampMinimaxPrompt(prompt) }],
    duration: 6,
    ratio: /^(720|768|1080)P$/i.test(ratio) ? "16:9" : ratio,
  };

  const res = await fetch(`${base}/v2/video_generation`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: fetchSignal(signal, 60_000),
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

  const url = await pollVideoTask(
    report,
    async () => {
      const q = await fetch(`${base}/v2/query/video_generation/${created.task_id}`, {
        headers: auth,
        signal: fetchSignal(signal, 30_000),
      });
      if (!q.ok) throw await readError(q, "v2/query/video_generation");
      const j = (await q.json()) as { task?: { status?: string; content?: { url?: string }; error?: { message?: string } } };
      const st = j.task?.status;
      if (st === "succeeded") return { done: true, url: j.task?.content?.url };
      if (st === "failed" || st === "cancelled") {
        return { done: false, error: `MiniMax 视频任务 ${st}: ${j.task?.error?.message ?? ""}` };
      }
      return { done: false };
    },
    signal
  );
  await downloadFile(url, outPath, signal);
}

/** MiniMax 视频入口：按模型名分发 v1（Hailuo/T2V）或 v2（H3） */
async function generateVideoViaMinimax(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (usesMinimaxVideoV2(model)) {
    return generateVideoViaMinimaxV2(cfg, prompt, model, outPath, report, signal);
  }
  return generateVideoViaMinimaxV1(cfg, prompt, model, outPath, report, signal);
}

/**
 * 百炼 DashScope 视频生成（万相 / HappyHorse 异步协议）：
 * POST {base}/api/v1/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
 * - t2v：input:{prompt}；parameters:{resolution,ratio,duration,watermark:false}
 * - i2v：input.media[{type:first_frame,url}]（引用图 base64 dataURI）
 * - r2v：input.media[{type:reference_image,url}]，prompt 可指 [Image 1]
 * 旧 wanx 仍可把 apiSize 当 size（宽*高）透传
 * 轮询 GET {base}/api/v1/tasks/{task_id} → output.video_url
 */
async function generateVideoViaDashscope(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal,
  referencePath?: string
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  // Token Plan 可粘贴 …/compatible-mode/v1；归一到 host 根再拼原生路径
  const base = normalizeDashscopeBaseUrl(cfg.apiBaseUrl);
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  const isI2v = /i2v/i.test(model);
  const isR2v = /r2v/i.test(model);
  const isHappyOrWanVideo = /happyhorse|wan\d/i.test(model) && /(t2v|i2v|r2v)/i.test(model);

  if ((isI2v || isR2v) && !referencePath) {
    throw new Error(`模型「${model}」需要引用图（${isI2v ? "首帧" : "参考图"}），请在生成时选择素材/帧作为引用`);
  }

  let text = prompt;
  const input: Record<string, unknown> = {};
  if (referencePath && (isI2v || isR2v)) {
    const dataUri = `data:image/png;base64,${readFileSync(referencePath).toString("base64")}`;
    if (isI2v) {
      input.media = [{ type: "first_frame", url: dataUri }];
      if (text.trim()) input.prompt = text;
    } else {
      input.media = [{ type: "reference_image", url: dataUri }];
      if (!/\[Image\s*1\]/i.test(text)) text = `Based on [Image 1], ${text}`;
      input.prompt = text;
    }
  } else {
    input.prompt = text;
  }

  const parameters: Record<string, unknown> = { watermark: false };
  const size = cfg.apiSize.trim();
  if (isHappyOrWanVideo || /happyhorse/i.test(model)) {
    parameters.duration = 5;
    if (/^(480|720|1080)P$/i.test(size)) {
      parameters.resolution = size.toUpperCase();
      if (!isI2v) parameters.ratio = "16:9";
    } else if (/^\d+:\d+$/.test(size)) {
      if (!isI2v) parameters.ratio = size;
      parameters.resolution = "720P";
    } else {
      parameters.resolution = "720P";
      if (!isI2v) parameters.ratio = "16:9";
    }
  } else if (size) {
    // 旧 wanx2.1 等：size 如 1280*720
    parameters.size = size;
  }

  const res = await fetch(`${base}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify({ model, input, parameters }),
    signal: fetchSignal(signal, 60_000),
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

  const url = await pollVideoTask(
    report,
    async () => {
      const q = await fetch(`${base}/api/v1/tasks/${taskId}`, {
        headers: auth,
        signal: fetchSignal(signal, 30_000),
      });
      if (!q.ok) throw await readError(q, "tasks 查询");
      const j = (await q.json()) as { output?: { task_status?: string; video_url?: string; code?: string; message?: string } };
      const st = j.output?.task_status;
      if (st === "SUCCEEDED") return { done: true, url: j.output?.video_url };
      if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
        return { done: false, error: `DashScope 视频任务 ${st}: ${j.output?.message ?? j.output?.code ?? ""}` };
      }
      return { done: false };
    },
    signal
  );
  await downloadFile(url, outPath, signal);
}

/**
 * API 视频生成统一入口（仅 dashscope / minimax，其余类型在前端已被过滤，这里兜底报错）。
 * 产出 mp4 到 outPath；耗时数分钟，进度经 report 写入 job.progress
 * referencePath：百炼 i2v/r2v 作首帧/参考图；其余忽略
 * sizeOverride：生成弹窗选择的比例/分辨率，非空时覆盖 provider.apiSize
 */
export async function generateVideoViaApi(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal,
  referencePath?: string,
  sizeOverride?: string
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const eff = sizeOverride?.trim() ? { ...cfg, apiSize: sizeOverride.trim() } : cfg;
  if (eff.type === "dashscope") {
    return generateVideoViaDashscope(eff, prompt, model, outPath, report, signal, referencePath);
  }
  if (eff.type === "minimax") return generateVideoViaMinimax(eff, prompt, model, outPath, report, signal);
  throw new Error(`该 provider 类型（${eff.type}）不支持视频生成（支持：CLI / 百炼 / MiniMax）`);
}
