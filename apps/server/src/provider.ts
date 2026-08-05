import type { GenProvider, MattingSettings } from "@framebaker/shared";
import { db } from "./db";

// 生成 / 抠图的运行配置：设置页（settings 表）优先，环境变量兜底
// 生成 provider 为列表模型：CLI 与 API 可配置多个共存，生成时按 id 选择、模型单独指定

/** 读 settings 表单个 key 并 JSON.parse；缺失/非法返回 null */
export function getSettingJson<T>(key: string): T | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

const ENV_GEN_CLI = () => process.env.FRAMEBAKER_GEN_CLI?.trim() ?? "";

/** 归一化一个 provider 条目（settings 里可能缺字段/类型不对） */
function normalizeProvider(raw: unknown): GenProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<GenProvider>;
  if (typeof p.id !== "string" || !p.id) return null;
  return {
    id: p.id,
    name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id,
    type: p.type === "api" ? "api" : "cli",
    cliTemplate: typeof p.cliTemplate === "string" ? p.cliTemplate : "",
    apiBaseUrl: typeof p.apiBaseUrl === "string" ? p.apiBaseUrl : "",
    apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
    apiModels: Array.isArray(p.apiModels) ? p.apiModels.filter((m): m is string => typeof m === "string") : [],
    apiSize: typeof p.apiSize === "string" ? p.apiSize : "",
  };
}

/**
 * 全部生成 provider：settings 表 genProviders 列表；
 * 列表为空且 env FRAMEBAKER_GEN_CLI 有值时，合成一个 id="env" 的 CLI provider 兜底
 */
export function getGenProviders(): GenProvider[] {
  const saved = getSettingJson<unknown[]>("genProviders");
  const list = Array.isArray(saved) ? saved.map(normalizeProvider).filter((p): p is GenProvider => p !== null) : [];
  if (list.length === 0 && ENV_GEN_CLI()) {
    return [
      {
        id: "env",
        name: "环境变量 CLI",
        type: "cli",
        cliTemplate: ENV_GEN_CLI(),
        apiBaseUrl: "",
        apiKey: "",
        apiModels: [],
        apiSize: "",
      },
    ];
  }
  return list;
}

/** provider 关键字段是否齐备（模型在生成时单独指定，不在此要求） */
export function providerConfigured(p: GenProvider): boolean {
  if (p.type === "cli") return p.cliTemplate.trim().length > 0;
  return !!(p.apiBaseUrl.trim() && p.apiKey.trim());
}

/**
 * 解析本次生成使用的 provider：
 * - 传了 providerId → 按 id 找（找不到返回 null，API 层 400）
 * - 没传 → 第一个 configured 的 provider，都没有则第一个
 */
export function resolveGenProvider(providerId?: string): GenProvider | null {
  const list = getGenProviders();
  if (providerId) return list.find((p) => p.id === providerId) ?? null;
  return list.find(providerConfigured) ?? list[0] ?? null;
}

/** 解析抠图配置：settings 表 matting 逐字段优先于 env / 默认值 */
export function getMattingSettings(): MattingSettings {
  const saved = getSettingJson<Partial<MattingSettings>>("matting");
  return {
    cliTemplate:
      typeof saved?.cliTemplate === "string" && saved.cliTemplate.trim()
        ? saved.cliTemplate.trim()
        : (process.env.FRAMEBAKER_MATTING_CLI?.trim() ?? ""),
    model:
      typeof saved?.model === "string" && saved.model.trim()
        ? saved.model.trim()
        : process.env.FRAMEBAKER_MATTING_MODEL?.trim() || "u2net",
  };
}
