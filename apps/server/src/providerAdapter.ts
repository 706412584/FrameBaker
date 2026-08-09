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
  poseReferencePath?: string;
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
  const capabilityModels = req.mediaKind === "video" ? provider.videoModels : provider.imageModels;
  const model = req.model?.trim() || capabilityModels[0] || "";
  if (req.mediaKind === "video" && !PROVIDER_VIDEO_SUPPORT[provider.type])
    throw new Error(`provider「${provider.name}」不支持视频生成（支持：CLI / 百炼 / MiniMax）`);
  if (req.mediaKind === "video" && provider.type !== "cli" && provider.videoModels.length === 0)
    throw new Error(`provider「${provider.name}」未配置视频模型`);
  if (req.poseReferencePath && req.mediaKind === "video") throw new Error("视频生成暂不支持动作参考图");
  if (req.poseReferencePath && provider.type === "cli") throw new Error("CLI 图片生成暂不支持独立动作参考图");
  if (req.poseReferencePath && provider.type === "minimax") throw new Error("MiniMax 图片生成暂不支持独立动作参考图");
  if (provider.type !== "cli" && !model)
    throw new Error(`生成 provider「${provider.name}」未指定模型：请在生成时选择模型或在设置页配置模型列表`);
  if (provider.type !== "cli" && req.model?.trim() && capabilityModels.length > 0 && !capabilityModels.includes(req.model.trim()))
    throw new Error(`模型「${req.model.trim()}」不属于 provider「${provider.name}」的当前${req.mediaKind === "video" ? "视频" : "图片"}能力列表`);
  const referenceError = req.referencePath ? checkImageReferenceSupport(req.providerId) : null;
  if (referenceError) throw new Error(referenceError);

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
        return generateVideoViaApi({ ...provider, apiSize: provider.videoSize }, req.prompt, model, output, progress, signal, req.referencePath, req.size);
      }
      return generateViaApi({ ...provider, apiSize: provider.imageSize }, req.prompt, model, index, output, req.referencePath, req.size, signal, req.poseReferencePath);
    },
  };
}

/** 自动生成链在引用图尚未产出时也能预检 provider 的图片引用能力。 */
export function checkImageReferenceSupport(providerId?: string): string | null {
  const provider = resolveGenProvider(providerId);
  if (!provider) return "生成 provider 不存在或未配置，请到设置页添加";
  if (provider.type !== "cli") return null;
  if (provider.legacyTemplate && !provider.legacyTemplate.includes("{reference}"))
    return `provider「${provider.name}」的模板缺少 {reference} 占位符，无法自动拆分完整角色`;
  if (!provider.legacyTemplate && !provider.cliReferenceArg.trim())
    return `provider「${provider.name}」未配置引用图参数名，无法自动拆分完整角色`;
  return null;
}

export function resolveReferencePath(opts: {
  referenceMaterialId?: string;
  referenceFrameId?: string;
  poseReferenceMaterialId?: string;
  poseReferenceFrameId?: string;
  providerId?: string;
  mediaKind?: "image" | "video";
}) {
  const { referenceMaterialId: mid, referenceFrameId: fid } = opts;
  if (mid && fid) return { error: "referenceMaterialId 与 referenceFrameId 只能二选一" };
  const poseMid = opts.poseReferenceMaterialId;
  const poseFid = opts.poseReferenceFrameId;
  if (poseMid && poseFid) return { error: "poseReferenceMaterialId 与 poseReferenceFrameId 只能二选一" };
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
  let posePath: string | null = null;
  if (poseMid) {
    const material = getMaterial(poseMid);
    if (!material) return { error: `动作参考素材不存在: ${poseMid}` };
    posePath = material.processed_path ?? material.raw_path;
    if (!posePath || !existsSync(posePath)) return { error: `动作参考素材文件缺失: ${poseMid}` };
  } else if (poseFid) {
    const frame = getFrame(poseFid);
    if (!frame) return { error: `动作参考帧不存在: ${poseFid}` };
    posePath = frame.processed_path ?? frame.raw_path;
    if (!posePath || !existsSync(posePath)) return { error: `动作参考帧文件缺失: ${poseFid}` };
  }
  if (posePath && !path) return { error: "动作参考图必须与角色/外观引用图一起使用" };
  if (posePath && opts.mediaKind === "video") return { error: "视频生成暂不支持动作参考图" };
  if (posePath && provider.type === "cli") return { error: "CLI 图片生成暂不支持独立动作参考图，请改用支持多图输入的 API provider" };
  if (posePath && provider.type === "minimax") return { error: "MiniMax 图片生成暂不支持独立动作参考图，请改用其他 API provider" };
  return { referencePath: path ?? undefined, poseReferencePath: posePath ?? undefined };
}

export function checkVideoSupport(opts: { mediaKind?: "image" | "video"; providerId?: string }): string | null {
  if (opts.mediaKind !== "video") return null;
  const provider = resolveGenProvider(opts.providerId);
  if (!provider) return "生成 provider 不存在或未配置，请到设置页添加";
  if (!PROVIDER_VIDEO_SUPPORT[provider.type]) return `provider「${provider.name}」不支持视频生成（支持：CLI / 百炼 / MiniMax）`;
  return provider.type !== "cli" && provider.videoModels.length === 0 ? `provider「${provider.name}」未配置视频模型` : null;
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
