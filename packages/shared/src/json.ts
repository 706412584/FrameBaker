import canonicalize from "canonicalize";
import type { ValidationIssue, ValidationResult } from "./animation";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface JsonLimits {
  maxDepth: number;
  maxNodes: number;
}

export interface JsonNodeBudget {
  remaining: number;
  exhausted?: boolean;
}

const DEFAULT_JSON_LIMITS: JsonLimits = { maxDepth: 32, maxNodes: 16_000_000 };
const encoder = new TextEncoder();

function finiteLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function validateBoundedJsonValue(value: unknown, limits: Partial<JsonLimits> = {}, sharedBudget?: JsonNodeBudget): ValidationIssue[] {
  const effective = {
    maxDepth: finiteLimit(limits.maxDepth, DEFAULT_JSON_LIMITS.maxDepth),
    maxNodes: finiteLimit(limits.maxNodes, DEFAULT_JSON_LIMITS.maxNodes),
  };
  const issues: ValidationIssue[] = [];
  const active = new Set<object>();
  const budget = sharedBudget ?? { remaining: effective.maxNodes };
  const visit = (item: unknown, path: string, depth: number) => {
    if (budget.exhausted) return;
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      issues.push({ path, message: `JSON 节点不能超过 ${effective.maxNodes}` });
      return;
    }
    budget.remaining -= 1;
    if (depth > effective.maxDepth) {
      issues.push({ path, message: `JSON 深度不能超过 ${effective.maxDepth}` });
      return;
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) issues.push({ path, message: "JSON 数值必须有限" });
      return;
    }
    if (typeof item === "string") {
      for (let index = 0; index < item.length; index += 1) {
        const code = item.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = item.charCodeAt(index + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) issues.push({ path, message: "字符串不能包含孤立 UTF-16 代理项" });
          else index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) issues.push({ path, message: "字符串不能包含孤立 UTF-16 代理项" });
      }
      return;
    }
    if (typeof item !== "object" || item === undefined) {
      issues.push({ path, message: "必须是可序列化的 JSON 值" });
      return;
    }
    if (active.has(item)) {
      issues.push({ path, message: "JSON 不能包含循环引用" });
      return;
    }
    if (Array.isArray(item)) {
      active.add(item);
      for (let index = 0; index < item.length; index += 1) {
        if (budget.exhausted) break;
        if (!(index in item)) issues.push({ path: `${path}[${index}]`, message: "JSON 数组不能包含空槽" });
        else visit(item[index], `${path}[${index}]`, depth + 1);
      }
      active.delete(item);
      return;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push({ path, message: "JSON 对象必须是普通对象" });
      return;
    }
    active.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (budget.exhausted) break;
      visit(key, `${path}.{key}`, depth + 1);
      visit(child, `${path}.${key}`, depth + 1);
    }
    active.delete(item);
  };
  visit(value, "$", 0);
  return issues;
}

export function canonicalizeJson(value: JsonValue, limits: Partial<JsonLimits> = {}): Uint8Array {
  const effective = { ...DEFAULT_JSON_LIMITS, ...limits };
  const issues = validateBoundedJsonValue(value, effective);
  if (issues.length > 0) throw new Error(`无法规范化 JSON：${issues[0]!.path} ${issues[0]!.message}`);
  const result = canonicalize(value);
  if (result === undefined) throw new Error("无法规范化 JSON");
  return encoder.encode(result);
}

export function parseCanonicalJson(bytes: Uint8Array, limits: Partial<JsonLimits> = {}): ValidationResult<JsonValue> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, issues: [{ path: "$", message: "必须是有效 UTF-8 JSON" }] };
  }
  const effective = { ...DEFAULT_JSON_LIMITS, ...limits };
  const issues = validateBoundedJsonValue(value, effective);
  if (issues.length > 0) return { ok: false, issues };
  const canonical = canonicalizeJson(value as JsonValue, effective);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    return { ok: false, issues: [{ path: "$", message: "JSON 必须使用 RFC 8785 规范编码" }] };
  }
  return { ok: true, value: value as JsonValue, issues: [] };
}

export async function sha256Digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
