import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DoctorCheck,
  DoctorResponse,
  ProviderTestRequest,
  ProviderTestResponse,
} from "@framebaker/shared";
import { STORAGE_ROOT } from "./db";
import { bundledRembg, getMattingInfo } from "./jobs/matting";
import { enhancerConfigured, getGenProviders, getMattingSettings, getPromptEnhancers, providerConfigured } from "./provider";

/** provider 类型展示名（doctor 标签用） */
export const PROVIDER_TYPE_LABEL: Record<string, string> = {
  cli: "CLI",
  api: "API",
  dashscope: "百炼",
  gemini: "banana",
  minimax: "MiniMax",
};

/** rembg 模型是否已缓存（storage/models 下文件名包含模型名，大小写不敏感；覆盖 birefnet 等非统一命名） */
export function isModelCached(model: string): boolean {
  try {
    const needle = model.trim().toLowerCase();
    if (!needle) return false;
    return readdirSync(join(STORAGE_ROOT, "models")).some((f) => f.toLowerCase().includes(needle));
  } catch {
    return false;
  }
}

/**
 * API provider 联通测试：
 * - api（OpenAI 兼容）：实发 GET {baseUrl}/models + Bearer，校验状态/认证并核对模型是否在列
 * - gemini（banana）：实发 GET {baseUrl}/v1beta/models（x-goog-api-key），核对模型是否在列
 * - dashscope / minimax：官方接口无轻量探测端点，仅校验字段齐备，不实发请求
 */
export async function testApiProvider(req: ProviderTestRequest): Promise<ProviderTestResponse> {
  const base = req.apiBaseUrl.trim().replace(/\/+$/, "");
  if (!base || !req.apiKey.trim()) return { ok: false, error: "Base URL 与 API Key 不能为空" };
  if (req.type === "dashscope" || req.type === "minimax") {
    return {
      ok: true,
      note: "字段齐备（该厂商接口无轻量探测端点，未实发请求；生成失败会以任务错误形式暴露）",
    };
  }

  if (req.type === "gemini") {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${base}/v1beta/models`, {
        headers: { "x-goog-api-key": req.apiKey.trim() },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      return { ok: false, error: `连接失败: ${(e as Error).message}` };
    }
    const latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, latencyMs, error: "认证失败：API Key 无效或权限不足" };
    }
    if (!res.ok) return { ok: false, status: res.status, latencyMs, error: `接口返回 HTTP ${res.status}` };
    let modelsFound: boolean | undefined;
    try {
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const target = req.apiModel?.trim();
      if (Array.isArray(json.models) && target) {
        // Gemini 模型名为 models/gemini-xxx 形式
        modelsFound = json.models.some((m) => m.name === target || m.name === `models/${target}`);
      }
    } catch {
      /* 非标准列表也视为连通 */
    }
    return { ok: true, status: res.status, latencyMs, modelsFound };
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${req.apiKey.trim()}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { ok: false, error: `连接失败: ${(e as Error).message}` };
  }
  const latencyMs = Date.now() - started;
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, latencyMs, error: "认证失败：API Key 无效或权限不足" };
  }
  if (!res.ok) return { ok: false, status: res.status, latencyMs, error: `接口返回 HTTP ${res.status}` };

  let modelsFound: boolean | undefined;
  try {
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const target = req.apiModel?.trim();
    if (Array.isArray(json.data) && target) {
      modelsFound = json.data.some((m) => m.id === target);
    }
  } catch {
    /* 非标准列表也视为连通 */
  }
  return { ok: true, status: res.status, latencyMs, modelsFound };
}

/** 体检：逐项检查运行所需条件（存储 / ffmpeg / 抠图引擎与模型 / 生成 provider） */
export async function runDoctor(): Promise<DoctorResponse> {
  const checks: DoctorCheck[] = [];

  // 存储目录可写
  try {
    const probe = join(STORAGE_ROOT, `.doctor_${Date.now()}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    checks.push({ id: "storage", ok: true, label: "存储目录", detail: `${STORAGE_ROOT} 可写` });
  } catch (e) {
    checks.push({ id: "storage", ok: false, label: "存储目录", detail: `不可写: ${(e as Error).message}` });
  }

  // ffmpeg（GIF/MP4 拆帧）
  const ffmpeg = Bun.which("ffmpeg");
  checks.push({
    id: "ffmpeg",
    ok: !!ffmpeg,
    label: "ffmpeg（GIF/MP4 拆帧）",
    detail:
      ffmpeg ??
      (process.platform === "win32"
        ? "未找到：winget install ffmpeg（或 https://ffmpeg.org/download.html）"
        : process.platform === "darwin"
          ? "未找到：brew install ffmpeg"
          : "未找到：用系统包管理器安装 ffmpeg（如 apt install ffmpeg）"),
  });

  // 抠图引擎
  const matting = getMattingInfo();
  if (matting.engine === "custom-cli") {
    const ms = getMattingSettings();
    const bin = ms.cliBin.trim() || (ms.envTemplate.split(/\s+/)[0] ?? "");
    const found = !!bin && (existsSync(bin) || !!Bun.which(bin));
    checks.push({
      id: "matting-engine",
      ok: found,
      label: "抠图引擎（自定义 CLI）",
      detail: found ? `命令 ${bin} 可用` : `命令 ${bin || "?"} 不在 PATH 也不是有效路径`,
    });
  } else {
    checks.push({
      id: "matting-engine",
      ok: matting.engine !== "none",
      label: "抠图引擎",
      detail:
        matting.engine === "rembg-bundled"
          ? `内置 ${bundledRembg() ?? ".venv-matting"}`
          : matting.engine === "rembg-path"
            ? `PATH 中的 rembg（${Bun.which("rembg")}）`
            : (matting.hint ?? "未安装"),
    });
  }

  // 抠图模型缓存（未缓存不算失败，首次抠图自动下载，仅提示）
  if (matting.engine !== "none") {
    const cached = isModelCached(matting.model);
    checks.push({
      id: "matting-model",
      ok: true,
      label: `抠图模型 ${matting.model}`,
      detail: cached ? "已缓存（storage/models）" : "未缓存，首次抠图会自动下载（约百 MB，耗时较长）",
    });
  }

  // 生成 provider（逐个检查，CLI 校验命令存在，API 做联通测试）
  const providers = getGenProviders();
  if (providers.length === 0) {
    checks.push({ id: "gen", ok: false, label: "生成 provider", detail: "未配置：请到设置页添加（CLI / API 可配多个共存）" });
  }
  for (const p of providers) {
    if (p.type === "cli") {
      if (!providerConfigured(p)) {
        checks.push({ id: `gen-${p.id}`, ok: false, label: `生成 provider「${p.name}」（CLI）`, detail: "未配置命令" });
      } else {
        const bin = p.cliBin.trim() || (p.legacyTemplate?.trim().split(/\s+/)[0] ?? "");
        const found = !!bin && (existsSync(bin) || !!Bun.which(bin));
        checks.push({
          id: `gen-${p.id}`,
          ok: found,
          label: `生成 provider「${p.name}」（CLI）`,
          detail: found ? `命令 ${bin} 可用` : `命令 ${bin} 不在 PATH 也不是有效路径`,
        });
      }
    } else if (!providerConfigured(p)) {
      checks.push({
        id: `gen-${p.id}`,
        ok: false,
        label: `生成 provider「${p.name}」（${PROVIDER_TYPE_LABEL[p.type]}）`,
        detail: "Base URL / API Key 未填齐",
      });
    } else if (p.type === "dashscope" || p.type === "minimax") {
      checks.push({
        id: `gen-${p.id}`,
        ok: true,
        label: `生成 provider「${p.name}」（${PROVIDER_TYPE_LABEL[p.type]}）`,
        detail: "字段齐备（该厂商接口无轻量探测端点，未实发请求）",
      });
    } else {
      const r = await testApiProvider({ type: p.type, apiBaseUrl: p.apiBaseUrl, apiKey: p.apiKey, apiModel: p.apiModels[0] });
      checks.push({
        id: `gen-${p.id}`,
        ok: r.ok,
        label: `生成 provider「${p.name}」（${PROVIDER_TYPE_LABEL[p.type]}）`,
        detail: r.ok
          ? `${p.apiBaseUrl} 连通（${r.latencyMs}ms）${r.modelsFound === false ? `，但模型列表中没有 ${p.apiModels[0]}` : ""}`
          : (r.error ?? "连接失败"),
      });
    }
  }

  // 提示词加强模型（OpenAI 兼容 chat，逐个探测 /models）
  const enhancers = getPromptEnhancers();
  for (const e of enhancers) {
    if (!enhancerConfigured(e)) {
      checks.push({
        id: `enh-${e.id}`,
        ok: false,
        label: `加强模型「${e.name}」`,
        detail: "Base URL / API Key / 模型 未填齐",
      });
      continue;
    }
    const r = await testApiProvider({ type: "api", apiBaseUrl: e.apiBaseUrl, apiKey: e.apiKey, apiModel: e.apiModel });
    checks.push({
      id: `enh-${e.id}`,
      ok: r.ok,
      label: `加强模型「${e.name}」`,
      detail: r.ok
        ? `${e.apiBaseUrl} 连通（${r.latencyMs}ms）${r.modelsFound === false ? `，但模型列表中没有 ${e.apiModel}` : ""}`
        : (r.error ?? "连接失败"),
    });
  }

  return { checks };
}
