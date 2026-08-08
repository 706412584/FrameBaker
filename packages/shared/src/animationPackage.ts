import {
  MOTION_CLIP_SCHEMA_VERSION,
  SKELETON_SCHEMA_VERSION,
  validateMotionClip,
  validateSkeleton,
  type AnimationAssetKind,
  type MotionClip,
  type Skeleton,
  type ValidationIssue,
  type ValidationResult,
} from "./animation";
import { canonicalizeJson, parseCanonicalJson, sha256Digest, type JsonObject, type JsonValue } from "./json";

export const FBANIM_FORMAT = "framebaker-animation-package";
export const FBANIM_PACKAGE_VERSION = 1;
export const FBANIM_V1_LIMITS = {
  maxManifestBytes: 1_048_576,
  maxAssetBytes: 33_554_432,
  maxTotalBytes: 134_217_728,
  maxEntries: 1_024,
  maxPathBytes: 160,
} as const;

export type Sha256Digest = `sha256:${string}`;

export interface FbanimToolIdentity { name: string; version: string }
export interface FbanimAssetRef { kind: AnimationAssetKind; id: string }
export interface FbanimAssetDescriptor {
  kind: AnimationAssetKind;
  id: string;
  schemaVersion: number;
  path: string;
  byteLength: number;
  digest: Sha256Digest;
  dependencies: FbanimAssetRef[];
}
export interface FbanimManifestV1 {
  format: typeof FBANIM_FORMAT;
  packageVersion: typeof FBANIM_PACKAGE_VERSION;
  createdBy: FbanimToolIdentity;
  assets: FbanimAssetDescriptor[];
  extensions?: Record<string, JsonValue>;
}
export interface FbanimEntry { path: string; bytes: Uint8Array }
export interface FbanimPackageSource { createdBy: FbanimToolIdentity; skeletons: Skeleton[]; motionClips: MotionClip[] }
export interface VerifiedFbanimPackage {
  manifest: FbanimManifestV1;
  manifestDigest: Sha256Digest;
  skeletons: Skeleton[];
  motionClips: MotionClip[];
}
export interface FbanimLimits {
  maxManifestBytes: number;
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  maxPathBytes: number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXTENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const PATH_PATTERN = /^(skeletons|motions)\/[a-f0-9]{64}\.json$/;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) issues.push({ path: `${path}.${key}`, message: "不支持的核心字段；扩展必须放入 extensions" });
}

export function validateFbanimEntryPath(path: string, descriptor?: FbanimAssetDescriptor, maxPathBytes: number = FBANIM_V1_LIMITS.maxPathBytes): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (path === "manifest.json") return descriptor ? [{ path: "path", message: "资产路径不能是 manifest.json" }] : [];
  if (encoder.encode(path).length > maxPathBytes) issues.push({ path: "path", message: `路径不能超过 ${maxPathBytes} 字节` });
  if (!PATH_PATTERN.test(path)) issues.push({ path: "path", message: "包路径必须是固定目录下以内容摘要命名的 ASCII JSON 文件" });
  if (descriptor) {
    const root = descriptor.kind === "skeleton" ? "skeletons" : "motions";
    const expected = `${root}/${descriptor.digest.slice(7)}.json`;
    if (path !== expected) issues.push({ path: "path", message: "路径必须与资产种类和内容摘要一致" });
  }
  return issues;
}

export function validateFbanimManifest(value: unknown): ValidationResult<FbanimManifestV1> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "manifest 必须是对象" }] };
  rejectUnknown(value, ["format", "packageVersion", "createdBy", "assets", "extensions"], "$", issues);
  if (value.format !== FBANIM_FORMAT) issues.push({ path: "format", message: `必须是 ${FBANIM_FORMAT}` });
  if (value.packageVersion !== FBANIM_PACKAGE_VERSION) issues.push({ path: "packageVersion", message: `仅支持包版本 ${FBANIM_PACKAGE_VERSION}` });
  if (!isRecord(value.createdBy)) issues.push({ path: "createdBy", message: "必须标识导出工具" });
  else {
    rejectUnknown(value.createdBy, ["name", "version"], "createdBy", issues);
    if (typeof value.createdBy.name !== "string" || value.createdBy.name.length === 0) issues.push({ path: "createdBy.name", message: "不能为空" });
    if (typeof value.createdBy.version !== "string" || value.createdBy.version.length === 0) issues.push({ path: "createdBy.version", message: "不能为空" });
  }
  if (!Array.isArray(value.assets) || value.assets.length > FBANIM_V1_LIMITS.maxEntries - 1) issues.push({ path: "assets", message: `资产索引不能超过 ${FBANIM_V1_LIMITS.maxEntries - 1} 项` });
  else {
    const ids = new Set<string>(), paths = new Set<string>();
    let previousPath = "";
    for (const [index, descriptor] of value.assets.entries()) {
      const path = `assets[${index}]`;
      if (!isRecord(descriptor)) { issues.push({ path, message: "必须是资产描述对象" }); continue; }
      rejectUnknown(descriptor, ["kind", "id", "schemaVersion", "path", "byteLength", "digest", "dependencies"], path, issues);
      if (descriptor.kind !== "skeleton" && descriptor.kind !== "motion-clip") issues.push({ path: `${path}.kind`, message: "资产种类无效" });
      if (typeof descriptor.id !== "string" || !ID_PATTERN.test(descriptor.id)) issues.push({ path: `${path}.id`, message: "资产 ID 无效" });
      else if (ids.has(descriptor.id)) issues.push({ path: `${path}.id`, message: "包内资产 ID 重复" }); else ids.add(descriptor.id);
      const expectedVersion = descriptor.kind === "skeleton" ? SKELETON_SCHEMA_VERSION : MOTION_CLIP_SCHEMA_VERSION;
      if (descriptor.schemaVersion !== expectedVersion) issues.push({ path: `${path}.schemaVersion`, message: "资产格式版本不受支持" });
      if (typeof descriptor.byteLength !== "number" || !Number.isInteger(descriptor.byteLength) || descriptor.byteLength < 0 || descriptor.byteLength > FBANIM_V1_LIMITS.maxAssetBytes) issues.push({ path: `${path}.byteLength`, message: "资产字节数无效或超限" });
      if (typeof descriptor.digest !== "string" || !DIGEST_PATTERN.test(descriptor.digest)) issues.push({ path: `${path}.digest`, message: "必须是小写 SHA-256 摘要" });
      if (typeof descriptor.path !== "string") issues.push({ path: `${path}.path`, message: "必须是路径字符串" });
      else {
        if (paths.has(descriptor.path)) issues.push({ path: `${path}.path`, message: "资产路径重复" }); else paths.add(descriptor.path);
        if (previousPath && descriptor.path <= previousPath) issues.push({ path: `${path}.path`, message: "资产必须按规范路径严格排序" });
        previousPath = descriptor.path;
        if (typeof descriptor.digest === "string" && (descriptor.kind === "skeleton" || descriptor.kind === "motion-clip")) issues.push(...validateFbanimEntryPath(descriptor.path, descriptor as unknown as FbanimAssetDescriptor).map((issue) => ({ ...issue, path: `${path}.${issue.path}` })));
      }
      if (!Array.isArray(descriptor.dependencies)) issues.push({ path: `${path}.dependencies`, message: "必须是依赖数组" });
      else {
        let previous = "";
        for (const [dependencyIndex, dependency] of descriptor.dependencies.entries()) {
          const dependencyPath = `${path}.dependencies[${dependencyIndex}]`;
          if (!isRecord(dependency)) { issues.push({ path: dependencyPath, message: "必须是资产引用" }); continue; }
          rejectUnknown(dependency, ["kind", "id"], dependencyPath, issues);
          if (dependency.kind !== "skeleton" && dependency.kind !== "motion-clip") issues.push({ path: `${dependencyPath}.kind`, message: "依赖种类无效" });
          if (typeof dependency.id !== "string" || !ID_PATTERN.test(dependency.id)) issues.push({ path: `${dependencyPath}.id`, message: "依赖 ID 无效" });
          const key = `${dependency.kind}\0${dependency.id}`;
          if (previous && key <= previous) issues.push({ path: dependencyPath, message: "依赖必须排序且不能重复" });
          previous = key;
        }
        if (descriptor.kind === "skeleton" && descriptor.dependencies.length !== 0) issues.push({ path: `${path}.dependencies`, message: "骨架不能声明依赖" });
        if (descriptor.kind === "motion-clip" && descriptor.dependencies.length !== 1) issues.push({ path: `${path}.dependencies`, message: "动作必须且只能依赖一个骨架" });
      }
    }
  }
  if (value.extensions !== undefined) {
    if (!isRecord(value.extensions)) issues.push({ path: "extensions", message: "必须是扩展对象" });
    else for (const key of Object.keys(value.extensions)) if (!EXTENSION_PATTERN.test(key)) issues.push({ path: `extensions.${key}`, message: "扩展键必须使用反向域名命名空间" });
  }
  return issues.length === 0 ? { ok: true, value: value as unknown as FbanimManifestV1, issues: [] } : { ok: false, issues };
}

function effectiveLimits(overrides: Partial<FbanimLimits>): FbanimLimits {
  return Object.fromEntries(Object.entries(FBANIM_V1_LIMITS).map(([key, hard]) => {
    const requested = overrides[key as keyof FbanimLimits];
    return [key, typeof requested === "number" && Number.isFinite(requested) && requested >= 0 ? Math.min(hard, Math.floor(requested)) : hard];
  })) as unknown as FbanimLimits;
}

export async function buildFbanimEntries(source: FbanimPackageSource): Promise<FbanimEntry[]> {
  if (!Array.isArray(source.skeletons) || !Array.isArray(source.motionClips)) throw new Error("包资产必须是数组");
  if (source.skeletons.length + source.motionClips.length + 1 > FBANIM_V1_LIMITS.maxEntries) throw new Error("包文件数量超限");
  const descriptors: FbanimAssetDescriptor[] = [];
  const entries: FbanimEntry[] = [];
  const ids = new Set<string>();
  let assetBytes = 0;
  const append = async (asset: Skeleton | MotionClip) => {
    if (ids.has(asset.id)) throw new Error(`包内资产 ID 重复：${asset.id}`);
    ids.add(asset.id);
    const validation = asset.kind === "skeleton"
      ? validateSkeleton(asset)
      : validateMotionClip(asset, source.skeletons.find((skeleton) => skeleton.id === asset.skeletonId));
    if (!validation.ok) throw new Error(`资产 ${asset.id} 无效：${validation.issues[0]!.path} ${validation.issues[0]!.message}`);
    const bytes = canonicalizeJson(asset as unknown as JsonObject);
    if (bytes.length > FBANIM_V1_LIMITS.maxAssetBytes) throw new Error(`资产 ${asset.id} 超过大小限制`);
    assetBytes += bytes.length;
    if (assetBytes > FBANIM_V1_LIMITS.maxTotalBytes) throw new Error("包解压后总体积超限");
    const digest = await sha256Digest(bytes);
    const path = `${asset.kind === "skeleton" ? "skeletons" : "motions"}/${digest.slice(7)}.json`;
    const dependencies = asset.kind === "motion-clip" ? [{ kind: "skeleton" as const, id: asset.skeletonId }] : [];
    descriptors.push({ kind: asset.kind, id: asset.id, schemaVersion: asset.schemaVersion, path, byteLength: bytes.length, digest, dependencies });
    entries.push({ path, bytes });
  };
  for (const skeleton of source.skeletons) await append(skeleton);
  for (const motion of source.motionClips) await append(motion);
  const skeletonIds = new Set(source.skeletons.map((skeleton) => skeleton.id));
  for (const motion of source.motionClips) if (!skeletonIds.has(motion.skeletonId)) throw new Error(`动作 ${motion.id} 引用的骨架不在包内`);
  descriptors.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest: FbanimManifestV1 = { format: FBANIM_FORMAT, packageVersion: FBANIM_PACKAGE_VERSION, createdBy: source.createdBy, assets: descriptors };
  const manifestValidation = validateFbanimManifest(manifest);
  if (!manifestValidation.ok) throw new Error(`manifest 无效：${manifestValidation.issues[0]!.path} ${manifestValidation.issues[0]!.message}`);
  const manifestBytes = canonicalizeJson(manifest as unknown as JsonObject);
  if (manifestBytes.length > FBANIM_V1_LIMITS.maxManifestBytes) throw new Error("manifest 超过大小限制");
  const total = manifestBytes.length + entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (entries.length + 1 > FBANIM_V1_LIMITS.maxEntries || total > FBANIM_V1_LIMITS.maxTotalBytes) throw new Error("包超过数量或总体积限制");
  return [{ path: "manifest.json", bytes: manifestBytes }, ...entries];
}

export async function verifyFbanimEntries(entries: Iterable<FbanimEntry>, overrides: Partial<FbanimLimits> = {}): Promise<ValidationResult<VerifiedFbanimPackage>> {
  const limits = effectiveLimits(overrides), issues: ValidationIssue[] = [];
  const byPath = new Map<string, Uint8Array>();
  let total = 0, index = 0;
  for (const entry of entries) {
    if (index >= limits.maxEntries) return { ok: false, issues: [{ path: "$", message: `包文件不能超过 ${limits.maxEntries} 个` }] };
    const entryIndex = index;
    index += 1;
    if (!entry || typeof entry.path !== "string" || !(entry.bytes instanceof Uint8Array)) { issues.push({ path: `entries[${entryIndex}]`, message: "包文件必须包含路径和字节" }); continue; }
    const entryLimit = entry.path === "manifest.json" ? limits.maxManifestBytes : limits.maxAssetBytes;
    if (entry.bytes.length > entryLimit) return { ok: false, issues: [{ path: entry.path, message: "包文件体积超限" }] };
    if (byPath.has(entry.path)) issues.push({ path: `entries[${entryIndex}].path`, message: "包文件路径重复" });
    byPath.set(entry.path, entry.bytes);
    total += entry.bytes.length;
    if (total > limits.maxTotalBytes) return { ok: false, issues: [{ path: "$", message: "包解压后总体积超限" }] };
    if (entry.path !== "manifest.json") issues.push(...validateFbanimEntryPath(entry.path, undefined, limits.maxPathBytes).map((issue) => ({ ...issue, path: `entries[${entryIndex}].${issue.path}` })));
  }
  const manifestBytes = byPath.get("manifest.json");
  if (!manifestBytes) issues.push({ path: "manifest.json", message: "缺少 manifest.json" });
  else if (manifestBytes.length > limits.maxManifestBytes) issues.push({ path: "manifest.json", message: "manifest 超过大小限制" });
  if (issues.length > 0 || !manifestBytes) return { ok: false, issues };
  const parsedManifest = parseCanonicalJson(manifestBytes);
  if (!parsedManifest.ok) return parsedManifest;
  const manifestValidation = validateFbanimManifest(parsedManifest.value);
  if (!manifestValidation.ok) return manifestValidation;
  const manifest = manifestValidation.value;
  const listed = new Set(["manifest.json", ...manifest.assets.map((asset) => asset.path)]);
  for (const path of byPath.keys()) if (!listed.has(path)) issues.push({ path, message: "manifest 未列出该文件" });
  for (const path of listed) if (!byPath.has(path)) issues.push({ path, message: "manifest 列出的文件不存在" });
  const skeletons = new Map<string, Skeleton>(), motions: Array<{ clip: MotionClip; descriptor: FbanimAssetDescriptor }> = [];
  for (const descriptor of manifest.assets) {
    const bytes = byPath.get(descriptor.path);
    if (!bytes) continue;
    if (bytes.length > limits.maxAssetBytes || bytes.length !== descriptor.byteLength) { issues.push({ path: descriptor.path, message: "实际字节数与 manifest 不一致或超限" }); continue; }
    const digest = await sha256Digest(bytes);
    if (digest !== descriptor.digest) { issues.push({ path: descriptor.path, message: "内容摘要与 manifest 不一致" }); continue; }
    const parsed = parseCanonicalJson(bytes);
    if (!parsed.ok) { issues.push(...parsed.issues.map((issue) => ({ ...issue, path: `${descriptor.path}:${issue.path}` }))); continue; }
    if (descriptor.kind === "skeleton") {
      const validation = validateSkeleton(parsed.value);
      if (!validation.ok) { issues.push(...validation.issues.map((issue) => ({ ...issue, path: `${descriptor.path}:${issue.path}` }))); continue; }
      if (validation.value.id !== descriptor.id || validation.value.schemaVersion !== descriptor.schemaVersion) issues.push({ path: descriptor.path, message: "资产身份与 manifest 不一致" });
      skeletons.set(validation.value.id, validation.value);
    } else {
      const validation = validateMotionClip(parsed.value);
      if (!validation.ok) { issues.push(...validation.issues.map((issue) => ({ ...issue, path: `${descriptor.path}:${issue.path}` }))); continue; }
      if (validation.value.id !== descriptor.id || validation.value.schemaVersion !== descriptor.schemaVersion) issues.push({ path: descriptor.path, message: "资产身份与 manifest 不一致" });
      motions.push({ clip: validation.value, descriptor });
    }
  }
  for (const { clip, descriptor } of motions) {
    const dependency = descriptor.dependencies[0], skeleton = dependency?.kind === "skeleton" ? skeletons.get(dependency.id) : undefined;
    if (!skeleton || clip.skeletonId !== dependency?.id) issues.push({ path: descriptor.path, message: "动作骨架依赖缺失或与 skeletonId 不一致" });
    else {
      const validation = validateMotionClip(clip, skeleton);
      if (!validation.ok) issues.push(...validation.issues.map((issue) => ({ ...issue, path: `${descriptor.path}:${issue.path}` })));
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { manifest, manifestDigest: await sha256Digest(manifestBytes), skeletons: [...skeletons.values()], motionClips: motions.map(({ clip }) => clip) }, issues: [] };
}
