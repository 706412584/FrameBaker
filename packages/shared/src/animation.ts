import { validateBoundedJsonValue, type JsonNodeBudget, type JsonValue } from "./json";

export const SKELETON_SCHEMA_VERSION = 1;
export const MOTION_CLIP_SCHEMA_VERSION = 1;
export const CHARACTER_BINDING_SCHEMA_VERSION = 1;
export const RENDER_PROFILE_SCHEMA_VERSION = 1;
export const MAX_BAKED_RASTER_FRAMES = 10_000;
export const MAX_BAKED_RASTER_PIXELS = 67_108_864;
export const ANIMATION_V1_LIMITS = {
  maxIdLength: 128,
  maxNameLength: 1_024,
  maxBones: 4_096,
  maxCharacterSlots: 4_096,
  maxRegionAttachments: 4_096,
  maxTracks: 16_384,
  maxKeyframesPerTrack: 100_000,
  maxTotalKeyframes: 1_000_000,
  maxEvents: 100_000,
  maxContactTracks: 4_096,
  maxContactIntervals: 1_000_000,
  maxArbitraryJsonNodes: 100_000,
} as const;

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];
/** 列优先 4×4 仿射矩阵，使用列向量，局部变换顺序为 T * R * S。 */
export type Mat4 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

export interface Transform {
  translation: Vec3;
  /** 四元数顺序固定为 x, y, z, w。 */
  rotation: Quaternion;
  scale: Vec3;
}

export interface CoordinateSystem {
  handedness: "right" | "left";
  upAxis: "x" | "y" | "z";
  forwardAxis: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
  unit: "meter" | "pixel" | "normalized";
}

export const DEFAULT_ANIMATION_COORDINATE_SYSTEM: CoordinateSystem = {
  handedness: "right",
  upAxis: "y",
  forwardAxis: "+z",
  unit: "normalized",
};

export type AnimationAssetKind = "skeleton" | "motion-clip" | "character-binding" | "render-profile";

export interface AnimationAssetBase<K extends AnimationAssetKind> {
  schemaVersion: number;
  kind: K;
  id: string;
  name: string;
  extensions?: Record<string, JsonValue>;
}

export interface AnimationBone {
  id: string;
  name: string;
  parentId: string | null;
  rest: Transform;
  /** 可选显示骨端，相对骨骼原点、位于骨骼本地坐标；不参与拓扑。 */
  tipOffset?: Vec3;
  semantic?: string;
}

export interface SkeletonSemanticProfile {
  id: string;
  bones: Record<string, string>;
}

export interface Skeleton extends AnimationAssetBase<"skeleton"> {
  schemaVersion: typeof SKELETON_SCHEMA_VERSION;
  coordinateSystem: CoordinateSystem;
  bones: AnimationBone[];
  semanticProfile?: SkeletonSemanticProfile;
}

export type MotionInterpolation = "step" | "linear";

export interface MotionKey<T> {
  time: number;
  value: T;
}

interface MotionTrackBase {
  targetId: string;
  interpolation: MotionInterpolation;
}

export interface TranslationTrack extends MotionTrackBase {
  property: "translation";
  keyframes: Array<MotionKey<Vec3>>;
}

export interface RotationTrack extends MotionTrackBase {
  property: "rotation";
  keyframes: Array<MotionKey<Quaternion>>;
}

export interface ScaleTrack extends MotionTrackBase {
  property: "scale";
  keyframes: Array<MotionKey<Vec3>>;
}

export type MotionTrack = TranslationTrack | RotationTrack | ScaleTrack;

export interface MotionEvent {
  time: number;
  type: string;
  name: string;
  payload?: Record<string, JsonValue>;
}

export interface ContactTrack {
  targetId: string;
  intervals: Array<{ start: number; end: number }>;
}

export type RootMotionPolicy = "preserve" | "in-place" | "extracted";

export interface AssetProvenance {
  source: "manual" | "import" | "provider";
  adapter?: string;
  adapterVersion?: string;
  model?: string;
  seed?: number;
  inputHashes?: string[];
  parameters?: Record<string, JsonValue>;
}

export interface MotionClip extends AnimationAssetBase<"motion-clip"> {
  schemaVersion: typeof MOTION_CLIP_SCHEMA_VERSION;
  skeletonId: string;
  /** 连续时间长度，单位为秒。 */
  duration: number;
  loop: boolean;
  tracks: MotionTrack[];
  events: MotionEvent[];
  contacts?: ContactTrack[];
  rootMotion?: RootMotionPolicy;
  provenance?: AssetProvenance;
}

export interface CharacterSlot {
  id: string;
  name: string;
  boneId: string;
  attachmentId: string;
  drawOrder: number;
}

export interface RegionAttachment {
  id: string;
  name: string;
  type: "region";
  materialId: string;
  imageSlot: "raw" | "processed";
  size: [number, number];
  pivot: [number, number];
  rest: Transform;
}

export interface CharacterBinding extends AnimationAssetBase<"character-binding"> {
  schemaVersion: typeof CHARACTER_BINDING_SCHEMA_VERSION;
  skeletonId: string;
  slots: CharacterSlot[];
  attachments: RegionAttachment[];
}

export interface RenderProfile extends AnimationAssetBase<"render-profile"> {
  schemaVersion: typeof RENDER_PROFILE_SCHEMA_VERSION;
  width: number;
  height: number;
  fps: number;
  /** 骨架世界原点在输出画布中的像素坐标。 */
  origin: [number, number];
  scale: number;
  background: "transparent";
}

/** 不包含浏览器 Blob 的烘焙草稿清单，可供后续服务端协议复用。 */
export interface BakedRasterDraftManifest {
  bakeEngine: "framebaker-canvas2d-v1";
  source: { skeletonId: string; motionClipId: string; characterBindingId: string; renderProfileId: string };
  profile: { width: number; height: number; fps: number; origin: [number, number]; scale: number; background: "transparent" };
  frames: Array<{ index: number; time: number; pixelDigest: `sha256:${string}` }>;
}

export type EditableAnimationAsset = Skeleton | MotionClip | CharacterBinding | RenderProfile;
export type AnimationAsset = EditableAnimationAsset;

/** 动画资产在本地库中的组织信息；资产正文仍由各自 schema 负责。 */
export interface StoredAnimationAsset<T extends AnimationAsset = AnimationAsset> {
  asset: T;
  folder_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AnimationAssetSummary {
  id: string;
  kind: AnimationAssetKind;
  name: string;
  skeleton_id: string | null;
  folder_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AnimationAssetsResponse {
  assets: AnimationAssetSummary[];
}

export interface AnimationAssetResponse {
  animationAsset: StoredAnimationAsset;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export interface EvaluatedPose {
  time: number;
  local: Record<string, Transform>;
  /** 权威世界变换；完整矩阵可正确保留层级非均匀缩放产生的剪切。 */
  worldMatrices: Record<string, Mat4>;
}

const EPSILON = 1e-8;
const QUATERNION_NORM_EPSILON = 1e-4;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) issues.push({ path: path === "$" ? key : `${path}.${key}`, message: "不支持的核心字段；扩展必须放入 extensions" });
}

function validateJsonValue(value: unknown, path: string, issues: ValidationIssue[], budget: JsonNodeBudget): void {
  issues.push(...validateBoundedJsonValue(value, { maxNodes: ANIMATION_V1_LIMITS.maxArbitraryJsonNodes }, budget).map((issue) => ({ ...issue, path: issue.path === "$" ? path : `${path}${issue.path.slice(1)}` })));
}

function validateIdentity(value: Record<string, unknown>, kind: AnimationAssetKind, version: number, issues: ValidationIssue[], jsonBudget: JsonNodeBudget) {
  if (value.schemaVersion !== version) {
    issues.push({ path: "schemaVersion", message: `仅支持 ${kind} 格式版本 ${version}` });
  }
  if (value.kind !== kind) {
    issues.push({ path: "kind", message: `必须是 ${kind}` });
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    issues.push({ path: "id", message: "必须是稳定且不含空白的标识符" });
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    issues.push({ path: "name", message: "不能为空" });
  } else if ([...value.name].length > ANIMATION_V1_LIMITS.maxNameLength) {
    issues.push({ path: "name", message: `不能超过 ${ANIMATION_V1_LIMITS.maxNameLength} 个字符` });
  }
  if (value.extensions !== undefined) {
    if (!isRecord(value.extensions)) issues.push({ path: "extensions", message: "必须是扩展对象" });
    else for (const [key, extension] of Object.entries(value.extensions)) {
      if (!EXTENSION_PATTERN.test(key)) issues.push({ path: `extensions.${key}`, message: "扩展键必须使用反向域名命名空间" });
      validateJsonValue(extension, `extensions.${key}`, issues, jsonBudget);
    }
  }
}

function validateTransform(value: unknown, path: string, issues: ValidationIssue[]) {
  if (!isRecord(value)) {
    issues.push({ path, message: "必须是 Transform 对象" });
    return;
  }
  rejectUnknown(value, ["translation", "rotation", "scale"], path, issues);
  if (!isTuple(value.translation, 3)) issues.push({ path: `${path}.translation`, message: "必须包含 3 个有限数值" });
  if (!isTuple(value.rotation, 4)) {
    issues.push({ path: `${path}.rotation`, message: "必须包含 4 个有限数值" });
  } else if (Math.abs(Math.hypot(...value.rotation) - 1) > QUATERNION_NORM_EPSILON) {
    issues.push({ path: `${path}.rotation`, message: "四元数必须归一化" });
  }
  if (!isTuple(value.scale, 3)) issues.push({ path: `${path}.scale`, message: "必须包含 3 个有限数值" });
}

function validateCoordinateSystem(value: unknown, path: string, issues: ValidationIssue[]) {
  if (!isRecord(value)) {
    issues.push({ path, message: "必须声明坐标系" });
    return;
  }
  rejectUnknown(value, ["handedness", "upAxis", "forwardAxis", "unit"], path, issues);
  if (value.handedness !== "right" && value.handedness !== "left") issues.push({ path: `${path}.handedness`, message: "必须是 right 或 left" });
  if (value.upAxis !== "x" && value.upAxis !== "y" && value.upAxis !== "z") issues.push({ path: `${path}.upAxis`, message: "必须是 x、y 或 z" });
  if (!["+x", "-x", "+y", "-y", "+z", "-z"].includes(String(value.forwardAxis))) issues.push({ path: `${path}.forwardAxis`, message: "方向无效" });
  else if (typeof value.upAxis === "string" && String(value.forwardAxis).slice(1) === value.upAxis) issues.push({ path: `${path}.forwardAxis`, message: "前向轴不能与上轴共线" });
  if (value.unit !== "meter" && value.unit !== "pixel" && value.unit !== "normalized") issues.push({ path: `${path}.unit`, message: "单位无效" });
}

export function validateSkeleton(value: unknown): ValidationResult<Skeleton> {
  const issues: ValidationIssue[] = [];
  const jsonBudget: JsonNodeBudget = { remaining: ANIMATION_V1_LIMITS.maxArbitraryJsonNodes };
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "骨架必须是对象" }] };
  rejectUnknown(value, ["schemaVersion", "kind", "id", "name", "extensions", "coordinateSystem", "bones", "semanticProfile"], "$", issues);
  validateIdentity(value, "skeleton", SKELETON_SCHEMA_VERSION, issues, jsonBudget);
  validateCoordinateSystem(value.coordinateSystem, "coordinateSystem", issues);
  if (!Array.isArray(value.bones) || value.bones.length === 0 || value.bones.length > ANIMATION_V1_LIMITS.maxBones) {
    issues.push({ path: "bones", message: "至少需要一根骨骼" });
  } else {
    const ids = new Set<string>();
    for (const [index, bone] of value.bones.entries()) {
      const path = `bones[${index}]`;
      if (!isRecord(bone)) {
        issues.push({ path, message: "必须是骨骼对象" });
        continue;
      }
      rejectUnknown(bone, ["id", "name", "parentId", "rest", "tipOffset", "semantic"], path, issues);
      if (typeof bone.id !== "string" || !ID_PATTERN.test(bone.id)) issues.push({ path: `${path}.id`, message: "骨骼 ID 无效" });
      else if (ids.has(bone.id)) issues.push({ path: `${path}.id`, message: "骨骼 ID 重复" });
      else ids.add(bone.id);
      if (typeof bone.name !== "string" || bone.name.trim().length === 0) issues.push({ path: `${path}.name`, message: "骨骼名称不能为空" });
      else if ([...bone.name].length > ANIMATION_V1_LIMITS.maxNameLength) issues.push({ path: `${path}.name`, message: `不能超过 ${ANIMATION_V1_LIMITS.maxNameLength} 个字符` });
      if (bone.parentId !== null && typeof bone.parentId !== "string") issues.push({ path: `${path}.parentId`, message: "必须是骨骼 ID 或 null" });
      if (bone.tipOffset !== undefined && !isTuple(bone.tipOffset, 3)) issues.push({ path: `${path}.tipOffset`, message: "必须包含 3 个有限数值" });
      if (bone.semantic !== undefined && (typeof bone.semantic !== "string" || bone.semantic.length === 0)) issues.push({ path: `${path}.semantic`, message: "语义标签不能为空" });
      validateTransform(bone.rest, `${path}.rest`, issues);
    }
    const bones = value.bones.filter(isRecord);
    const parents = new Map(bones.flatMap((bone) => typeof bone.id === "string" ? [[bone.id, bone.parentId]] : []));
    let rootCount = 0;
    for (const [id, parent] of parents) {
      if (parent === null) rootCount += 1;
      else if (typeof parent === "string" && !parents.has(parent)) issues.push({ path: `bones.${id}.parentId`, message: `父骨骼 ${parent} 不存在` });
      const visited = new Set<string>([id]);
      let cursor = parent;
      while (typeof cursor === "string" && parents.has(cursor)) {
        if (visited.has(cursor)) {
          issues.push({ path: `bones.${id}.parentId`, message: "骨架不能包含父子环" });
          break;
        }
        visited.add(cursor);
        cursor = parents.get(cursor);
      }
    }
    if (rootCount === 0) issues.push({ path: "bones", message: "至少需要一个根骨骼" });
    if (value.semanticProfile !== undefined) {
      if (!isRecord(value.semanticProfile)) issues.push({ path: "semanticProfile", message: "必须是语义映射对象" });
      else {
        rejectUnknown(value.semanticProfile, ["id", "bones"], "semanticProfile", issues);
        if (typeof value.semanticProfile.id !== "string" || !ID_PATTERN.test(value.semanticProfile.id)) issues.push({ path: "semanticProfile.id", message: "语义配置 ID 无效" });
        if (!isRecord(value.semanticProfile.bones)) issues.push({ path: "semanticProfile.bones", message: "必须是语义到骨骼 ID 的映射" });
        else for (const [semantic, boneId] of Object.entries(value.semanticProfile.bones)) {
          if (!semantic) issues.push({ path: "semanticProfile.bones", message: "语义名称不能为空" });
          if (typeof boneId !== "string" || !ids.has(boneId)) issues.push({ path: `semanticProfile.bones.${semantic}`, message: "映射的骨骼不存在" });
        }
      }
    }
  }
  return issues.length === 0 ? { ok: true, value: value as unknown as Skeleton, issues: [] } : { ok: false, issues };
}

function validateTrack(track: unknown, index: number, duration: number, skeletonIds: Set<string> | undefined, issues: ValidationIssue[]) {
  const path = `tracks[${index}]`;
  if (!isRecord(track)) {
    issues.push({ path, message: "必须是轨道对象" });
    return;
  }
  rejectUnknown(track, ["targetId", "property", "interpolation", "keyframes"], path, issues);
  if (typeof track.targetId !== "string" || !ID_PATTERN.test(track.targetId)) issues.push({ path: `${path}.targetId`, message: "目标 ID 无效" });
  else if (skeletonIds && !skeletonIds.has(track.targetId)) issues.push({ path: `${path}.targetId`, message: "目标骨骼不存在" });
  if (track.property !== "translation" && track.property !== "rotation" && track.property !== "scale") issues.push({ path: `${path}.property`, message: "轨道属性无效" });
  if (track.interpolation !== "step" && track.interpolation !== "linear") issues.push({ path: `${path}.interpolation`, message: "插值方式无效" });
  if (!Array.isArray(track.keyframes) || track.keyframes.length === 0 || track.keyframes.length > ANIMATION_V1_LIMITS.maxKeyframesPerTrack) {
    issues.push({ path: `${path}.keyframes`, message: "轨道至少需要一个关键帧" });
    return;
  }
  let previous = -Infinity;
  for (const [keyIndex, key] of track.keyframes.entries()) {
    const keyPath = `${path}.keyframes[${keyIndex}]`;
    if (!isRecord(key)) {
      issues.push({ path: keyPath, message: "必须是关键帧对象" });
      continue;
    }
    rejectUnknown(key, ["time", "value"], keyPath, issues);
    if (!isFiniteNumber(key.time) || key.time < 0 || key.time > duration) issues.push({ path: `${keyPath}.time`, message: "时间必须位于动作时长内" });
    else if (key.time <= previous) issues.push({ path: `${keyPath}.time`, message: "关键帧时间必须严格递增" });
    else previous = key.time;
    const expected = track.property === "rotation" ? 4 : 3;
    if (!isTuple(key.value, expected)) issues.push({ path: `${keyPath}.value`, message: `必须包含 ${expected} 个有限数值` });
    else if (track.property === "rotation" && Math.abs(Math.hypot(...key.value) - 1) > QUATERNION_NORM_EPSILON) issues.push({ path: `${keyPath}.value`, message: "四元数必须归一化" });
  }
}

function validateProvenance(value: unknown, path: string, issues: ValidationIssue[], jsonBudget: JsonNodeBudget) {
  if (!isRecord(value)) {
    issues.push({ path, message: "必须是来源对象" });
    return;
  }
  rejectUnknown(value, ["source", "adapter", "adapterVersion", "model", "seed", "inputHashes", "parameters"], path, issues);
  if (value.source !== "manual" && value.source !== "import" && value.source !== "provider") issues.push({ path: `${path}.source`, message: "来源类型无效" });
  for (const key of ["adapter", "adapterVersion", "model"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") issues.push({ path: `${path}.${key}`, message: "必须是字符串" });
  }
  if (value.seed !== undefined && !isFiniteNumber(value.seed)) issues.push({ path: `${path}.seed`, message: "必须是有限数值" });
  if (value.inputHashes !== undefined && (!Array.isArray(value.inputHashes) || value.inputHashes.some((item) => typeof item !== "string"))) issues.push({ path: `${path}.inputHashes`, message: "必须是字符串数组" });
  if (value.parameters !== undefined) {
    if (!isRecord(value.parameters)) issues.push({ path: `${path}.parameters`, message: "必须是参数对象" });
    else validateJsonValue(value.parameters, `${path}.parameters`, issues, jsonBudget);
  }
}

export function validateMotionClip(value: unknown, skeleton?: Skeleton): ValidationResult<MotionClip> {
  const issues: ValidationIssue[] = [];
  const jsonBudget: JsonNodeBudget = { remaining: ANIMATION_V1_LIMITS.maxArbitraryJsonNodes };
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "动作必须是对象" }] };
  rejectUnknown(value, ["schemaVersion", "kind", "id", "name", "extensions", "skeletonId", "duration", "loop", "tracks", "events", "contacts", "rootMotion", "provenance"], "$", issues);
  validateIdentity(value, "motion-clip", MOTION_CLIP_SCHEMA_VERSION, issues, jsonBudget);
  if (typeof value.skeletonId !== "string" || !ID_PATTERN.test(value.skeletonId)) issues.push({ path: "skeletonId", message: "骨架 ID 无效" });
  else if (skeleton && value.skeletonId !== skeleton.id) issues.push({ path: "skeletonId", message: "动作与骨架不匹配" });
  const duration = isFiniteNumber(value.duration) && value.duration >= 0 ? value.duration : 0;
  if (!isFiniteNumber(value.duration) || value.duration < 0) issues.push({ path: "duration", message: "时长必须是非负有限数值" });
  if (typeof value.loop !== "boolean") issues.push({ path: "loop", message: "必须是布尔值" });
  const skeletonIds = skeleton ? new Set(skeleton.bones.map((bone) => bone.id)) : undefined;
  if (!Array.isArray(value.tracks) || value.tracks.length > ANIMATION_V1_LIMITS.maxTracks) issues.push({ path: "tracks", message: "必须是未超限的轨道数组" });
  else {
    const trackKeys = new Set<string>();
    let totalKeyframes = 0;
    value.tracks.forEach((track, index) => {
      if (isRecord(track) && Array.isArray(track.keyframes)) totalKeyframes += track.keyframes.length;
      validateTrack(track, index, duration, skeletonIds, issues);
      if (isRecord(track) && typeof track.targetId === "string" && typeof track.property === "string") {
        const key = `${track.targetId}:${track.property}`;
        if (trackKeys.has(key)) issues.push({ path: `tracks[${index}]`, message: "同一目标属性不能有重复轨道" });
        trackKeys.add(key);
      }
    });
    if (totalKeyframes > ANIMATION_V1_LIMITS.maxTotalKeyframes) issues.push({ path: "tracks", message: "动作关键帧总数超限" });
  }
  if (!Array.isArray(value.events) || value.events.length > ANIMATION_V1_LIMITS.maxEvents) issues.push({ path: "events", message: "必须是未超限的事件数组" });
  else for (const [index, event] of value.events.entries()) {
    const path = `events[${index}]`;
    if (!isRecord(event)) issues.push({ path, message: "必须是事件对象" });
    else {
      rejectUnknown(event, ["time", "type", "name", "payload"], path, issues);
      if (!isFiniteNumber(event.time) || event.time < 0 || event.time > duration) issues.push({ path: `${path}.time`, message: "事件时间必须位于动作时长内" });
      else if (value.loop === true && event.time === duration) issues.push({ path: `${path}.time`, message: "循环动作的事件必须位于半开区间 [0, duration)" });
      if (typeof event.type !== "string" || event.type.length === 0) issues.push({ path: `${path}.type`, message: "事件类型不能为空" });
      if (typeof event.name !== "string" || event.name.length === 0) issues.push({ path: `${path}.name`, message: "事件名称不能为空" });
      if (event.payload !== undefined) {
        if (!isRecord(event.payload)) issues.push({ path: `${path}.payload`, message: "必须是事件数据对象" });
        else validateJsonValue(event.payload, `${path}.payload`, issues, jsonBudget);
      }
    }
  }
  if (value.contacts !== undefined) {
    if (!Array.isArray(value.contacts) || value.contacts.length > ANIMATION_V1_LIMITS.maxContactTracks) issues.push({ path: "contacts", message: "必须是未超限的接触轨道数组" });
    else {
      let totalIntervals = 0;
      for (const [index, contact] of value.contacts.entries()) {
        const path = `contacts[${index}]`;
        if (!isRecord(contact)) {
          issues.push({ path, message: "必须是接触轨道对象" });
          continue;
        }
        rejectUnknown(contact, ["targetId", "intervals"], path, issues);
        if (typeof contact.targetId !== "string" || !ID_PATTERN.test(contact.targetId)) issues.push({ path: `${path}.targetId`, message: "目标 ID 无效" });
        else if (skeletonIds && !skeletonIds.has(contact.targetId)) issues.push({ path: `${path}.targetId`, message: "目标骨骼不存在" });
        if (!Array.isArray(contact.intervals)) issues.push({ path: `${path}.intervals`, message: "必须是区间数组" });
        else {
          totalIntervals += contact.intervals.length;
          let previousStart = -Infinity;
          for (const [intervalIndex, interval] of contact.intervals.entries()) {
            const intervalPath = `${path}.intervals[${intervalIndex}]`;
            if (!isRecord(interval) || !isFiniteNumber(interval.start) || !isFiniteNumber(interval.end)) issues.push({ path: intervalPath, message: "区间必须包含有限的 start/end" });
            else {
              rejectUnknown(interval, ["start", "end"], intervalPath, issues);
              if (interval.start < 0 || interval.end < interval.start || interval.end > duration) issues.push({ path: intervalPath, message: "接触区间必须满足 0 <= start <= end <= duration" });
              if (interval.start < previousStart) issues.push({ path: `${intervalPath}.start`, message: "接触区间必须按开始时间排序" });
              previousStart = interval.start;
            }
          }
        }
      }
      if (totalIntervals > ANIMATION_V1_LIMITS.maxContactIntervals) issues.push({ path: "contacts", message: "接触区间总数超限" });
    }
  }
  if (value.rootMotion !== undefined && value.rootMotion !== "preserve" && value.rootMotion !== "in-place" && value.rootMotion !== "extracted") issues.push({ path: "rootMotion", message: "根运动策略无效" });
  if (value.provenance !== undefined) validateProvenance(value.provenance, "provenance", issues, jsonBudget);
  return issues.length === 0 ? { ok: true, value: value as unknown as MotionClip, issues: [] } : { ok: false, issues };
}

export function validateCharacterBinding(value: unknown, skeleton?: Skeleton): ValidationResult<CharacterBinding> {
  const issues: ValidationIssue[] = [];
  const jsonBudget: JsonNodeBudget = { remaining: ANIMATION_V1_LIMITS.maxArbitraryJsonNodes };
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "角色绑定必须是对象" }] };
  rejectUnknown(value, ["schemaVersion", "kind", "id", "name", "extensions", "skeletonId", "slots", "attachments"], "$", issues);
  validateIdentity(value, "character-binding", CHARACTER_BINDING_SCHEMA_VERSION, issues, jsonBudget);
  if (typeof value.skeletonId !== "string" || !ID_PATTERN.test(value.skeletonId)) issues.push({ path: "skeletonId", message: "骨架 ID 无效" });
  else if (skeleton && value.skeletonId !== skeleton.id) issues.push({ path: "skeletonId", message: "绑定与骨架不匹配" });
  const boneIds = skeleton ? new Set(skeleton.bones.map((bone) => bone.id)) : undefined;
  const attachmentIds = new Set<string>();
  if (!Array.isArray(value.attachments) || value.attachments.length > ANIMATION_V1_LIMITS.maxRegionAttachments) issues.push({ path: "attachments", message: "必须是未超限的附件数组" });
  else for (const [index, attachment] of value.attachments.entries()) {
    const path = `attachments[${index}]`;
    if (!isRecord(attachment)) { issues.push({ path, message: "必须是 Region 附件对象" }); continue; }
    rejectUnknown(attachment, ["id", "name", "type", "materialId", "imageSlot", "size", "pivot", "rest"], path, issues);
    if (typeof attachment.id !== "string" || !ID_PATTERN.test(attachment.id)) issues.push({ path: `${path}.id`, message: "附件 ID 无效" });
    else if (attachmentIds.has(attachment.id)) issues.push({ path: `${path}.id`, message: "附件 ID 重复" });
    else attachmentIds.add(attachment.id);
    if (typeof attachment.name !== "string" || !attachment.name.trim()) issues.push({ path: `${path}.name`, message: "附件名称不能为空" });
    else if ([...attachment.name].length > ANIMATION_V1_LIMITS.maxNameLength) issues.push({ path: `${path}.name`, message: `不能超过 ${ANIMATION_V1_LIMITS.maxNameLength} 个字符` });
    if (attachment.type !== "region") issues.push({ path: `${path}.type`, message: "v1 仅支持 region" });
    if (typeof attachment.materialId !== "string" || !ID_PATTERN.test(attachment.materialId)) issues.push({ path: `${path}.materialId`, message: "素材 ID 无效" });
    if (attachment.imageSlot !== "raw" && attachment.imageSlot !== "processed") issues.push({ path: `${path}.imageSlot`, message: "图片槽位必须是 raw 或 processed" });
    if (!isTuple(attachment.size, 2) || attachment.size.some((number) => number <= 0)) issues.push({ path: `${path}.size`, message: "尺寸必须包含 2 个正有限数值" });
    if (!isTuple(attachment.pivot, 2) || attachment.pivot.some((number) => number < 0 || number > 1)) issues.push({ path: `${path}.pivot`, message: "轴心必须包含 2 个 [0, 1] 有限数值" });
    validateTransform(attachment.rest, `${path}.rest`, issues);
  }
  const slotIds = new Set<string>(), drawOrders = new Set<number>();
  if (!Array.isArray(value.slots) || value.slots.length > ANIMATION_V1_LIMITS.maxCharacterSlots) issues.push({ path: "slots", message: "必须是未超限的插槽数组" });
  else for (const [index, slot] of value.slots.entries()) {
    const path = `slots[${index}]`;
    if (!isRecord(slot)) { issues.push({ path, message: "必须是插槽对象" }); continue; }
    rejectUnknown(slot, ["id", "name", "boneId", "attachmentId", "drawOrder"], path, issues);
    if (typeof slot.id !== "string" || !ID_PATTERN.test(slot.id)) issues.push({ path: `${path}.id`, message: "插槽 ID 无效" });
    else if (slotIds.has(slot.id)) issues.push({ path: `${path}.id`, message: "插槽 ID 重复" }); else slotIds.add(slot.id);
    if (typeof slot.name !== "string" || !slot.name.trim()) issues.push({ path: `${path}.name`, message: "插槽名称不能为空" });
    else if ([...slot.name].length > ANIMATION_V1_LIMITS.maxNameLength) issues.push({ path: `${path}.name`, message: `不能超过 ${ANIMATION_V1_LIMITS.maxNameLength} 个字符` });
    if (typeof slot.boneId !== "string" || !ID_PATTERN.test(slot.boneId)) issues.push({ path: `${path}.boneId`, message: "骨骼 ID 无效" });
    else if (boneIds && !boneIds.has(slot.boneId)) issues.push({ path: `${path}.boneId`, message: "骨骼不存在" });
    if (typeof slot.attachmentId !== "string" || !ID_PATTERN.test(slot.attachmentId)) issues.push({ path: `${path}.attachmentId`, message: "附件 ID 无效" });
    else if (!attachmentIds.has(slot.attachmentId)) issues.push({ path: `${path}.attachmentId`, message: "附件不存在" });
    if (!isFiniteNumber(slot.drawOrder) || !Number.isInteger(slot.drawOrder)) issues.push({ path: `${path}.drawOrder`, message: "绘制顺序必须是有限整数" });
    else if (drawOrders.has(slot.drawOrder)) issues.push({ path: `${path}.drawOrder`, message: "绘制顺序重复" }); else drawOrders.add(slot.drawOrder);
  }
  return issues.length === 0 ? { ok: true, value: value as unknown as CharacterBinding, issues: [] } : { ok: false, issues };
}

export function validateRenderProfile(value: unknown): ValidationResult<RenderProfile> {
  const issues: ValidationIssue[] = [];
  const jsonBudget: JsonNodeBudget = { remaining: ANIMATION_V1_LIMITS.maxArbitraryJsonNodes };
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "渲染配置必须是对象" }] };
  rejectUnknown(value, ["schemaVersion", "kind", "id", "name", "extensions", "width", "height", "fps", "origin", "scale", "background"], "$", issues);
  validateIdentity(value, "render-profile", RENDER_PROFILE_SCHEMA_VERSION, issues, jsonBudget);
  for (const key of ["width", "height"] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > 4096) issues.push({ path: key, message: "必须是 1..4096 的整数" });
  }
  if (!isFiniteNumber(value.fps) || value.fps < 1 || value.fps > 120) issues.push({ path: "fps", message: "必须是 1..120 的有限正数" });
  if (!isTuple(value.origin, 2)) issues.push({ path: "origin", message: "必须包含 2 个有限数值" });
  if (!isFiniteNumber(value.scale) || value.scale <= 0) issues.push({ path: "scale", message: "必须是有限正数" });
  if (value.background !== "transparent") issues.push({ path: "background", message: "v1 仅支持 transparent" });
  return issues.length === 0 ? { ok: true, value: value as unknown as RenderProfile, issues: [] } : { ok: false, issues };
}

export function normalizeQuaternion(value: Quaternion): Quaternion {
  const length = Math.hypot(...value);
  if (length < EPSILON) return [0, 0, 0, 1];
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length];
}

export function quaternionFromZRotation(angle: number): Quaternion {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

/** 返回规范四元数表示的 Z 轴旋转角（弧度，范围为 [-π, π]）。 */
export function zRotationFromQuaternion(value: Quaternion): number {
  const [x, y, z, w] = normalizeQuaternion(value);
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export const MOTION_KEY_TIME_EPSILON = 1e-4;

/** 不可变地添加并按时间排序事件；同一时刻事件保持原有先后顺序。 */
export function addMotionEvent(clip: MotionClip, event: MotionEvent): MotionClip {
  const normalized = { ...event, type: event.type.trim(), name: event.name.trim() };
  if (!normalized.type || !normalized.name) throw new Error("事件类型和名称不能为空");
  if (!Number.isFinite(normalized.time) || normalized.time < 0 || normalized.time > clip.duration || (clip.loop && normalized.time >= clip.duration)) {
    throw new Error("事件时间超出动作范围");
  }
  return { ...clip, events: [...clip.events, normalized].sort((a, b) => a.time - b.time) };
}

/** 按当前有序事件数组的明确索引不可变删除。 */
export function deleteMotionEvent(clip: MotionClip, index: number): MotionClip {
  if (!Number.isInteger(index) || index < 0 || index >= clip.events.length) return clip;
  return { ...clip, events: clip.events.filter((_, eventIndex) => eventIndex !== index) };
}

/** 不可变地插入或覆盖单条连续时间轨道关键帧。 */
export function upsertMotionKeyframe(
  clip: MotionClip,
  targetId: string,
  property: MotionTrack["property"],
  time: number,
  value: Vec3 | Quaternion,
  epsilon = MOTION_KEY_TIME_EPSILON,
): MotionClip {
  const index = clip.tracks.findIndex((track) => track.targetId === targetId && track.property === property);
  const normalizedValue = property === "rotation" ? normalizeQuaternion(value as Quaternion) : [...value] as Vec3;
  const old = index >= 0 ? clip.tracks[index]! : undefined;
  const keyframes = [...(old?.keyframes ?? [])]
    .filter((key) => Math.abs(key.time - time) > epsilon)
    .concat({ time, value: normalizedValue } as never)
    .sort((a, b) => a.time - b.time);
  const track = { targetId, property, interpolation: old?.interpolation ?? "linear", keyframes } as MotionTrack;
  const tracks = [...clip.tracks];
  if (index >= 0) tracks[index] = track;
  else tracks.push(track);
  return { ...clip, tracks };
}

/** 不可变地删除目标骨骼指定通道在该时刻的 key；空轨道同时移除。 */
export function deleteMotionKeyframe(
  clip: MotionClip,
  targetId: string,
  properties: MotionTrack["property"] | MotionTrack["property"][],
  time: number,
  epsilon = MOTION_KEY_TIME_EPSILON,
): MotionClip {
  const wanted = new Set(Array.isArray(properties) ? properties : [properties]);
  const tracks = clip.tracks.flatMap((track) => {
    if (track.targetId !== targetId || !wanted.has(track.property)) return [track];
    const keyframes = track.keyframes.filter((key) => Math.abs(key.time - time) > epsilon);
    return keyframes.length ? [{ ...track, keyframes } as MotionTrack] : [];
  });
  return tracks.length === clip.tracks.length && tracks.every((track, index) => track === clip.tracks[index]) ? clip : { ...clip, tracks };
}

/** 把每条现有轨道在 t=0 的通道值复制到 duration，形成基础循环接缝。 */
export function closeMotionLoopSeam(clip: MotionClip, skeleton: Skeleton): MotionClip {
  if (!clip.loop || clip.duration <= 0 || clip.tracks.length === 0) return clip;
  const pose = sampleMotionClip(clip, skeleton, 0);
  let result = clip;
  for (const track of clip.tracks) {
    const transform = pose.local[track.targetId];
    if (!transform) continue;
    const value = track.property === "translation" ? transform.translation : track.property === "rotation" ? transform.rotation : transform.scale;
    result = upsertMotionKeyframe(result, track.targetId, track.property, clip.duration, value);
  }
  return result;
}

export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return normalizeQuaternion([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]);
}

export function rotateVector(vector: Vec3, rotation: Quaternion): Vec3 {
  const [x, y, z, w] = normalizeQuaternion(rotation);
  const tx = 2 * (y * vector[2] - z * vector[1]);
  const ty = 2 * (z * vector[0] - x * vector[2]);
  const tz = 2 * (x * vector[1] - y * vector[0]);
  return [
    vector[0] + w * tx + (y * tz - z * ty),
    vector[1] + w * ty + (z * tx - x * tz),
    vector[2] + w * tz + (x * ty - y * tx),
  ];
}

export function slerpQuaternions(a: Quaternion, b: Quaternion, amount: number): Quaternion {
  let end = normalizeQuaternion(b);
  const start = normalizeQuaternion(a);
  let dot = start[0] * end[0] + start[1] * end[1] + start[2] * end[2] + start[3] * end[3];
  if (dot < 0) {
    dot = -dot;
    end = [-end[0], -end[1], -end[2], -end[3]];
  }
  if (dot > 0.9995) return normalizeQuaternion(start.map((value, index) => value + (end[index]! - value) * amount) as Quaternion);
  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const from = Math.sin((1 - amount) * theta) / sinTheta;
  const to = Math.sin(amount * theta) / sinTheta;
  return normalizeQuaternion([start[0] * from + end[0] * to, start[1] * from + end[1] * to, start[2] * from + end[2] * to, start[3] * from + end[3] * to]);
}

function lerpVec3(a: Vec3, b: Vec3, amount: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];
}

function sampleTrack(track: MotionTrack, time: number): Vec3 | Quaternion {
  const keys = track.keyframes;
  if (keys.length === 1 || time <= keys[0]!.time) return [...keys[0]!.value] as Vec3 | Quaternion;
  const last = keys[keys.length - 1]!;
  if (time >= last.time) return [...last.value] as Vec3 | Quaternion;
  let endIndex = 1;
  while (keys[endIndex]!.time <= time) endIndex += 1;
  const start = keys[endIndex - 1]!, end = keys[endIndex]!;
  if (track.interpolation === "step") return [...start.value] as Vec3 | Quaternion;
  const amount = (time - start.time) / (end.time - start.time);
  return track.property === "rotation"
    ? slerpQuaternions(start.value as Quaternion, end.value as Quaternion, amount)
    : lerpVec3(start.value as Vec3, end.value as Vec3, amount);
}

function cloneTransform(transform: Transform): Transform {
  return { translation: [...transform.translation], rotation: normalizeQuaternion(transform.rotation), scale: [...transform.scale] };
}

export function transformToMatrix(transform: Transform): Mat4 {
  const [x, y, z, w] = normalizeQuaternion(transform.rotation);
  const [sx, sy, sz] = transform.scale;
  const xx = x * x, xy = x * y, xz = x * z, xw = x * w;
  const yy = y * y, yz = y * z, yw = y * w, zz = z * z, zw = z * w;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + zw) * sx, 2 * (xz - yw) * sx, 0,
    2 * (xy - zw) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + xw) * sy, 0,
    2 * (xz + yw) * sz, 2 * (yz - xw) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    transform.translation[0], transform.translation[1], transform.translation[2], 1,
  ];
}

export function multiplyMatrices(a: Mat4, b: Mat4): Mat4 {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        a[row]! * b[column * 4]!
        + a[4 + row]! * b[column * 4 + 1]!
        + a[8 + row]! * b[column * 4 + 2]!
        + a[12 + row]! * b[column * 4 + 3]!;
    }
  }
  return result as Mat4;
}

export function transformPoint(matrix: Mat4, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

export function sampleMotionClip(clip: MotionClip, skeleton: Skeleton, requestedTime: number): EvaluatedPose {
  if (!Number.isFinite(requestedTime)) throw new Error("动作采样时间必须是有限数值");
  const time = clip.loop && clip.duration > 0
    ? ((requestedTime % clip.duration) + clip.duration) % clip.duration
    : Math.max(0, Math.min(requestedTime, clip.duration));
  const local = Object.fromEntries(skeleton.bones.map((bone) => [bone.id, cloneTransform(bone.rest)]));
  for (const track of clip.tracks) {
    const transform = local[track.targetId];
    if (!transform) continue;
    const value = sampleTrack(track, time);
    if (track.property === "rotation") transform.rotation = normalizeQuaternion(value as Quaternion);
    else if (track.property === "translation") transform.translation = value as Vec3;
    else transform.scale = value as Vec3;
  }
  const worldMatrices: Record<string, Mat4> = {};
  const pending = new Set(skeleton.bones.map((bone) => bone.id));
  while (pending.size > 0) {
    let progressed = false;
    for (const bone of skeleton.bones) {
      if (!pending.has(bone.id) || (bone.parentId && !worldMatrices[bone.parentId])) continue;
      const localMatrix = transformToMatrix(local[bone.id]!);
      worldMatrices[bone.id] = bone.parentId ? multiplyMatrices(worldMatrices[bone.parentId]!, localMatrix) : localMatrix;
      pending.delete(bone.id);
      progressed = true;
    }
    if (!progressed) throw new Error("骨架层级无效，无法完成 FK 求值");
  }
  return { time, local, worldMatrices };
}

export function getBoneEndpoint(pose: EvaluatedPose, skeleton: Skeleton, boneId: string): Vec3 | null {
  const bone = skeleton.bones.find((item) => item.id === boneId);
  const matrix = pose.worldMatrices[boneId];
  if (!bone || !matrix) return null;
  return transformPoint(matrix, bone.tipOffset ?? [0, 0, 0]);
}
