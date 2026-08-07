import { existsSync } from "node:fs";
import type { GenProviderType, ProviderModelsRequest, ProviderModelsResponse } from "@framebaker/shared";
import { normalizeDashscopeBaseUrl, PROVIDER_VIDEO_SUPPORT } from "@framebaker/shared";
import { getFrame, getMaterial } from "./db";
import { generateViaApi, generateVideoViaApi } from "./jobs/generateApi";
import { runCmd } from "./jobs/run";
import { providerConfigured, resolveGenProvider } from "./provider";

export interface GenerationRequest {
  prompt: string;
  providerId?: string;
  model?: string;
  size?: string;
  referencePath?: string;
  mediaKind?: "image" | "video";
}

export interface ProviderAdapter {
  source: GenProviderType;
  providerName: string;
  model: string;
  produce(output: string, index: number): Promise<void>;
}

/** 每次任务实时读取 settings/env，完成 provider、模型与能力校验。 */
export function createProviderAdapter(
  req: GenerationRequest,
  progress: (status: string) => void,
  signal?: AbortSignal
): ProviderAdapter {
  const provider = resolveGenProvider(req.providerId);
  if (!provider) throw new Error("未配置生成方式：请到「设置」页添加生成 provider（CLI 或各厂商 API，可配多个共存）");
  if (!providerConfigured(provider)) throw new Error(`生成 provider「${provider.name}」配置不完整，请到「设置」页补齐`);
  const model = req.model?.trim() || provider.apiModels[0] || "";
  if (provider.type !== "cli" && !model)
    throw new Error(`生成 provider「${provider.name}」未指定模型：请在生成时选择模型或在设置页配置模型列表`);
  if (req.mediaKind === "video" && !PROVIDER_VIDEO_SUPPORT[provider.type])
    throw new Error(`provider「${provider.name}」不支持视频生成（支持：CLI / 百炼 / MiniMax）`);

  const buildArgv = (output: string, index: number): string[] => {
    if (provider.legacyTemplate) {
      return provider.legacyTemplate
        .trim()
        .split(/\s+/)
        .map((token) =>
          token
            .replaceAll("{prompt}", req.prompt)
            .replaceAll("{output}", output)
            .replaceAll("{index}", String(index))
            .replaceAll("{reference}", req.referencePath ?? "")
            .replaceAll("{model}", req.model ?? "")
        );
    }
    const argv = [provider.cliBin.trim()];
    if (provider.cliPromptArg.trim()) argv.push(provider.cliPromptArg.trim());
    argv.push(req.prompt);
    if (provider.cliOutputArg.trim()) argv.push(provider.cliOutputArg.trim());
    argv.push(output);
    if (req.model?.trim() && provider.cliModelArg.trim()) argv.push(provider.cliModelArg.trim(), req.model.trim());
    if (req.referencePath && provider.cliReferenceArg.trim()) argv.push(provider.cliReferenceArg.trim(), req.referencePath);
    if (provider.cliExtraArgs.trim()) argv.push(...provider.cliExtraArgs.trim().split(/\s+/));
    return argv;
  };

  return {
    source: provider.type,
    providerName: provider.name,
    model,
    produce(output, index) {
      if (provider.type === "cli") return runCmd(buildArgv(output, index), undefined, signal);
      if (req.mediaKind === "video") {
        return generateVideoViaApi(provider, req.prompt, model, output, progress, signal, req.referencePath, req.size);
      }
      return generateViaApi(provider, req.prompt, model, index, output, req.referencePath, req.size, signal);
    },
  };
}

export function resolveReferencePath(opts: { referenceMaterialId?: string; referenceFrameId?: string; providerId?: string }) {
  const { referenceMaterialId: mid, referenceFrameId: fid } = opts;
  if (mid && fid) return { error: "referenceMaterialId 与 referenceFrameId 只能二选一" };
  const provider = resolveGenProvider(opts.providerId);
  if (!provider) return { error: "生成 provider 不存在或未配置，请到设置页添加" };
  let path: string | null = null;
  if (mid) {
    const material = getMaterial(mid);
    if (!material) return { error: `素材不存在: ${mid}` };
    path = material.processed_path ?? material.raw_path;
    if (!path || !existsSync(path)) return { error: `素材文件缺失: ${mid}` };
  } else if (fid) {
    const frame = getFrame(fid);
    if (!frame) return { error: `帧不存在: ${fid}` };
    path = frame.processed_path ?? frame.raw_path;
    if (!path || !existsSync(path)) return { error: `帧文件缺失: ${fid}` };
  }
  if (provider.type === "cli" && path) {
    if (provider.legacyTemplate && !provider.legacyTemplate.includes("{reference}"))
      return { error: `已选择引用图，但 provider「${provider.name}」的模板缺少 {reference} 占位符` };
    if (!provider.legacyTemplate && !provider.cliReferenceArg.trim())
      return { error: `provider「${provider.name}」未配置引用图参数名，请改用其他 provider 或取消引用图` };
  }
  return { referencePath: path ?? undefined };
}

export function checkVideoSupport(opts: { mediaKind?: "image" | "video"; providerId?: string }): string | null {
  if (opts.mediaKind !== "video") return null;
  const provider = resolveGenProvider(opts.providerId);
  if (!provider) return "生成 provider 不存在或未配置，请到设置页添加";
  return PROVIDER_VIDEO_SUPPORT[provider.type] ? null : `provider「${provider.name}」不支持视频生成（支持：CLI / 百炼 / MiniMax）`;
}

export async function probeProviderModels(type: "api" | "dashscope" | "gemini" | "minimax", base: string, apiKey: string): Promise<
  { ok: true; status: number; latencyMs: number; models: string[] | null } |
  { ok: false; status?: number; latencyMs?: number; error: string }
> {
  const url = type === "gemini" ? `${base}/v1beta/models` : type === "dashscope" ? `${base}/compatible-mode/v1/models` : `${base}${type === "api" ? "" : "/v1"}/models`;
  const headers: Record<string, string> = type === "gemini" ? { "x-goog-api-key": apiKey.trim() } : { Authorization: `Bearer ${apiKey.trim()}` };
  const started = Date.now();
  let response: Response;
  try { response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) }); }
  catch (error) { return { ok: false, error: `连接失败: ${(error as Error).message}` }; }
  const latencyMs = Date.now() - started;
  if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, latencyMs, error: "认证失败：API Key 无效或权限不足" };
  if (!response.ok) return { ok: false, status: response.status, latencyMs, error: `接口返回 HTTP ${response.status}` };
  try {
    const json = await response.json() as { models?: Array<{ name?: string }>; data?: Array<{ id?: string }> };
    const rows = type === "gemini" ? json.models?.map((item) => (item.name ?? "").replace(/^models\//, "")) : json.data?.map((item) => item.id ?? "");
    return { ok: true, status: response.status, latencyMs, models: rows ? rows.filter(Boolean) : null };
  } catch { return { ok: true, status: response.status, latencyMs, models: null }; }
}

export async function listProviderModels(req: ProviderModelsRequest): Promise<ProviderModelsResponse> {
  const raw = req.apiBaseUrl.trim().replace(/\/+$/, "");
  if (!raw || !req.apiKey.trim()) return { ok: false, error: "Base URL 与 API Key 不能为空" };
  const result = await probeProviderModels(req.type, req.type === "dashscope" ? normalizeDashscopeBaseUrl(raw) : raw, req.apiKey);
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return result.models === null ? { ok: false, status: result.status, error: "接口连通但返回的不是标准模型列表" } : { ok: true, status: result.status, models: result.models };
}
