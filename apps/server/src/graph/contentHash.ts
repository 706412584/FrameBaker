// 内容寻址：node 唯一指纹 = sha256(node_type + canonical_json(params) + 上游输入 hash)
// 这是增量重跑的承重墙 —— hash 稳定，graph_outputs 缓存命中才有意义。
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

/** 键排序的稳定 JSON：参数书写顺序不影响 hash */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function computeHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** 普通节点：上游各输入端口 hash 按端口名排序拼接 */
export function nodeHash(
  nodeType: string,
  params: Record<string, unknown>,
  upstream: Record<string, string> = {}
): string {
  const sortedUpstream = Object.keys(upstream)
    .sort()
    .map((port) => `${JSON.stringify(port)}:${upstream[port]}`)
    .join(",");
  return computeHash([nodeType, canonicalJson(params), sortedUpstream]);
}

/** 源节点（素材）：用文件 size+mtime，避免整文件哈希开销 */
export function materialHash(materialId: string, path: string | null): string {
  if (!path) return computeHash([`material:${materialId}`, "missing"]);
  const stat = statSync(path);
  return computeHash([`material:${materialId}`, String(stat.size), String(stat.mtimeMs)]);
}
