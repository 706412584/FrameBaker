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
  referencePaths?: string[];
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
  if (provider.type !== "cli" && !model)
    throw new Error(`生成 provider「${provider.name}」未指定模型：请在生成时选择模型或在设置页配置模型列表`);
  if (provider.type !== "cli" && req.model?.trim() && capabilityModels.length > 0 && !capabilityModels.includes(req.model.trim()))
    throw new Error(`模型「${req.model.trim()}」不属于 provider「${provider.name}」的当前${req.mediaKind === "video" ? "视频" : "图片"}能力列表`);
  const referencePaths = req.referencePaths ?? [];
  if (referencePaths.length && provider.type === "cli") {
    const referenceError = checkImageReferenceSupport(req.providerId);
    if (referenceError) throw new Error(referenceError);
  }
  if (provider.type === "minimax" && referencePaths.length > 1)
    throw new Error(`provider「${provider.name}」的 MiniMax 协议最多支持 1 张引用图`);
  if (req.mediaKind === "video" && provider.type === "minimax" && referencePaths.length > 0)
    throw new Error(`provider「${provider.name}」的 MiniMax 视频协议暂不支持引用图`);
  if (req.mediaKind === "video" && provider.type === "dashscope" && /i2v/i.test(model) && referencePaths.length > 1)
    throw new Error(`首帧视频模型「${model}」只能使用 1 张引用图；多图请改用 r2v 模型`);

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
            .replaceAll("{reference}", referencePaths[0] ?? "")
            .replaceAll("{model}", req.model ?? "")
        );
    }
    const argv = [provider.cliBin.trim()];
    if (provider.cliPromptArg.trim()) argv.push(provider.cliPromptArg.trim());
    argv.push(req.prompt);
    if (provider.cliOutputArg.trim()) argv.push(provider.cliOutputArg.trim());
    argv.push(output);
    if (req.model?.trim() && provider.cliModelArg.trim()) argv.push(provider.cliModelArg.trim(), req.model.trim());
    if (provider.cliReferenceArg.trim()) {
      for (const referencePath of referencePaths) argv.push(provider.cliReferenceArg.trim(), referencePath);
    }
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
        return generateVideoViaApi({ ...provider, apiSize: provider.videoSize }, req.prompt, model, output, progress, signal, referencePaths, req.size);
      }
      return generateViaApi({ ...provider, apiSize: provider.imageSize }, req.prompt, model, index, output, referencePaths, req.size, signal);
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

export function resolveReferencePaths(opts: {
  references?: Array<{ kind: "material" | "frame"; id: string }>;
  referenceMaterialId?: string;
  referenceFrameId?: string;
  poseReferenceMaterialId?: string;
  poseReferenceFrameId?: string;
  providerId?: string;
  mediaKind?: "image" | "video";
}) {
  const { referenceMaterialId: mid, referenceFrameId: fid } = opts;
  if (mid && fid) return { error: "referenceMaterialId 与 referenceFrameId 只能二选一" };
  if (opts.poseReferenceMaterialId && opts.poseReferenceFrameId) return { error: "poseReferenceMaterialId 与 poseReferenceFrameId 只能二选一" };
  if (opts.references?.length && (mid || fid)) return { error: "references 不能与旧版单引用字段同时使用" };
  if (opts.references?.length && (opts.poseReferenceMaterialId || opts.poseReferenceFrameId)) return { error: "references 不能与旧版动作引用字段同时使用" };
  const pose = opts.poseReferenceMaterialId
    ? { kind: "material" as const, id: opts.poseReferenceMaterialId }
    : opts.poseReferenceFrameId ? { kind: "frame" as const, id: opts.poseReferenceFrameId } : null;
  if ((opts.references?.length ?? 0) + (pose ? 1 : 0) > 10) return { error: "引用图最多 10 张" };
  const provider = resolveGenProvider(opts.providerId);
  if (!provider) return { error: "生成 provider 不存在或未配置，请到设置页添加" };
  const references = opts.references?.length
    ? opts.references
    : mid ? [{ kind: "material" as const, id: mid }] : fid ? [{ kind: "frame" as const, id: fid }] : [];
  if (pose) {
    if (!references.length) return { error: "动作参考图必须与角色/外观引用图一起使用" };
    if (opts.mediaKind === "video") return { error: "视频生成暂不支持动作参考图" };
    references.push(pose);
  }
  const referencePaths: string[] = [];
  for (const reference of references) {
    const row = reference.kind === "material" ? getMaterial(reference.id) : getFrame(reference.id);
    if (!row) return { error: `${reference.kind === "material" ? "素材" : "帧"}不存在: ${reference.id}` };
    const path = row.processed_path && existsSync(row.processed_path)
      ? row.processed_path
      : row.raw_path && existsSync(row.raw_path) ? row.raw_path : null;
    if (!path) return { error: `${reference.kind === "material" ? "素材" : "帧"}文件缺失: ${reference.id}` };
    referencePaths.push(path);
  }
  if (provider.type === "minimax" && referencePaths.length > 1)
    return { error: `provider「${provider.name}」的 MiniMax 协议最多支持 1 张引用图` };
  if (provider.type === "cli" && referencePaths.length) {
    if (provider.legacyTemplate && !provider.legacyTemplate.includes("{reference}"))
      return { error: `已选择引用图，但 provider「${provider.name}」的模板缺少 {reference} 占位符` };
    if (provider.legacyTemplate && referencePaths.length > 1)
      return { error: `provider「${provider.name}」使用旧版 {reference} 模板，只能接收 1 张引用图；请改用结构化 CLI 配置` };
    if (!provider.legacyTemplate && !provider.cliReferenceArg.trim())
      return { error: `provider「${provider.name}」未配置引用图参数名，请改用其他 provider 或取消引用图` };
  }
  return { referencePaths: referencePaths.length ? referencePaths : undefined };
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
