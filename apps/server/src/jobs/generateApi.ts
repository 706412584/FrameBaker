import { writeFileSync } from "node:fs";
import type { GenProvider } from "@framebaker/shared";

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/**
 * OpenAI 兼容图片生成：POST {apiBaseUrl}/images/generations
 * 请求 { model, prompt, size?, n: 1 }，响应取 data[0].b64_json 或 data[0].url（再下载）
 * 模型在生成时单独指定（生成弹窗选择/输入），provider 只存连接信息
 * 注意：该接口无引用图能力，引用图在 API 层已 400 拦截
 */
export async function generateViaApi(
  cfg: GenProvider,
  prompt: string,
  model: string,
  _index: number,
  outPath: string
): Promise<void> {
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const body: Record<string, unknown> = { model, prompt, n: 1 };
  if (cfg.apiSize.trim()) body.size = cfg.apiSize.trim();

  let res: Response;
  try {
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new Error(`生成 API 请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`生成 API 返回 ${res.status}: ${text}`);
  }

  const json = (await res.json()) as ImagesResponse;
  const item = json.data?.[0];
  if (item?.b64_json) {
    writeFileSync(outPath, Buffer.from(item.b64_json, "base64"));
    return;
  }
  if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
    if (!img.ok) throw new Error(`下载生成图失败: HTTP ${img.status}`);
    writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
    return;
  }
  throw new Error("生成 API 响应缺少 data[0].b64_json / data[0].url");
}
