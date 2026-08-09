import { validateCharacterBinding, validateMotionClip, validateSkeleton, type CharacterBinding, type MotionClip, type Skeleton, type ValidationIssue, type ValidationResult } from "./animation";
import type { FbanimEntry, FbanimLimits, FbanimToolIdentity, Sha256Digest } from "./animationPackage";
import { canonicalizeJson, parseCanonicalJson, sha256Digest, type JsonObject } from "./json";

export const FBANIM_V2_FORMAT = "fbanim" as const;
export const FBANIM_V2_VERSION = 2 as const;
export const FBANIM_V2_LIMITS: FbanimLimits = { maxManifestBytes: 1_048_576, maxAssetBytes: 33_554_432, maxTotalBytes: 134_217_728, maxEntries: 1_024, maxPathBytes: 160 };

export interface FbanimV2FileDescriptor { path: string; digest: Sha256Digest; byteLength: number }
export interface FbanimV2Action extends FbanimV2FileDescriptor { id: string; name: string; motionClipId: string; speed: number; repeat: number; loop: boolean; dependencies: { skeletonId: string } }
export interface FbanimV2Texture extends FbanimV2FileDescriptor { attachmentId: string }
export interface FbanimManifestV2 {
  format: typeof FBANIM_V2_FORMAT;
  version: typeof FBANIM_V2_VERSION;
  createdBy: FbanimToolIdentity;
  entry: {
    skeleton: FbanimV2FileDescriptor & { id: string };
    characterBinding: FbanimV2FileDescriptor & { id: string; dependencies: { skeletonId: string } };
    actions: FbanimV2Action[];
    textures: FbanimV2Texture[];
  };
}
export interface FbanimV2ActionSource { id: string; name: string; motionClip: MotionClip; speed: number; repeat: number; loop: boolean }
export interface FbanimV2TextureSource { attachmentId: string; bytes: Uint8Array }
export interface FbanimV2PackageSource { createdBy: FbanimToolIdentity; skeleton: Skeleton; characterBinding: CharacterBinding; actions: FbanimV2ActionSource[]; textures: FbanimV2TextureSource[] }
export interface VerifiedFbanimV2Package { manifest: FbanimManifestV2; manifestDigest: Sha256Digest; skeleton: Skeleton; characterBinding: CharacterBinding; actions: Array<Omit<FbanimV2ActionSource, "motionClip"> & { motionClip: MotionClip }>; textures: FbanimV2TextureSource[] }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, DIGEST = /^sha256:[a-f0-9]{64}$/;
const JSON_PATH = /^(skeletons|bindings|motions)\/[a-f0-9]{64}\.json$/, PNG_PATH = /^textures\/[a-f0-9]{64}\.png$/;
const pngSignature = new Uint8Array([137,80,78,71,13,10,26,10]);
const enc = new TextEncoder();
const compareCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isFbanimV2Id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
function unknown(v: Record<string, unknown>, keys: string[], path: string, out: ValidationIssue[]) { const allowed = new Set(keys); for (const k of Object.keys(v)) if (!allowed.has(k)) out.push({ path: `${path}.${k}`, message: "未知字段" }); }
function validFile(v: unknown, path: string, pattern: RegExp, limits: FbanimLimits, out: ValidationIssue[]): v is Record<string, unknown> {
  if (!record(v)) { out.push({ path, message: "必须是文件描述对象" }); return false; }
  if (typeof v.path !== "string" || !pattern.test(v.path) || enc.encode(v.path).length > limits.maxPathBytes) out.push({ path: `${path}.path`, message: "路径无效" });
  if (typeof v.digest !== "string" || !DIGEST.test(v.digest)) out.push({ path: `${path}.digest`, message: "摘要无效" });
  if (!Number.isInteger(v.byteLength) || (v.byteLength as number) < 0 || (v.byteLength as number) > limits.maxAssetBytes) out.push({ path: `${path}.byteLength`, message: "字节数无效或超限" });
  return true;
}
function limits(overrides: Partial<FbanimLimits>): FbanimLimits { const out = { ...FBANIM_V2_LIMITS }; for (const k of Object.keys(out) as (keyof FbanimLimits)[]) { const n = overrides[k]; if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = Math.min(out[k], Math.floor(n)); } return out; }

export function validateFbanimV2Manifest(value: unknown, limitOverrides: Partial<FbanimLimits> = {}): ValidationResult<FbanimManifestV2> {
  const issues: ValidationIssue[] = [], lim = limits(limitOverrides);
  if (!record(value)) return { ok: false, issues: [{ path: "$", message: "manifest 必须是对象" }] };
  unknown(value, ["format","version","createdBy","entry"], "$", issues);
  if (value.format !== FBANIM_V2_FORMAT) issues.push({ path: "format", message: "必须是 fbanim" });
  if (value.version !== 2) issues.push({ path: "version", message: "仅支持版本 2" });
  if (!record(value.createdBy)) issues.push({ path: "createdBy", message: "工具标识无效" }); else { unknown(value.createdBy,["name","version"],"createdBy",issues); if (typeof value.createdBy.name !== "string" || !value.createdBy.name || typeof value.createdBy.version !== "string" || !value.createdBy.version) issues.push({ path: "createdBy", message: "工具名称和版本不能为空" }); }
  if (!record(value.entry)) issues.push({ path: "entry", message: "入口无效" }); else {
    const e=value.entry; unknown(e,["skeleton","characterBinding","actions","textures"],"entry",issues);
    if (validFile(e.skeleton,"entry.skeleton",JSON_PATH,lim,issues)) { unknown(e.skeleton,["id","path","digest","byteLength"],"entry.skeleton",issues); if (typeof e.skeleton.id !== "string" || !ID.test(e.skeleton.id)) issues.push({path:"entry.skeleton.id",message:"ID 无效"}); if (typeof e.skeleton.path === "string" && !e.skeleton.path.startsWith("skeletons/")) issues.push({path:"entry.skeleton.path",message:"目录不匹配"}); }
    if (validFile(e.characterBinding,"entry.characterBinding",JSON_PATH,lim,issues)) { unknown(e.characterBinding,["id","path","digest","byteLength","dependencies"],"entry.characterBinding",issues); if (typeof e.characterBinding.id !== "string" || !ID.test(e.characterBinding.id)) issues.push({path:"entry.characterBinding.id",message:"ID 无效"}); if (typeof e.characterBinding.path === "string" && !e.characterBinding.path.startsWith("bindings/")) issues.push({path:"entry.characterBinding.path",message:"目录不匹配"}); if (!record(e.characterBinding.dependencies)) issues.push({path:"entry.characterBinding.dependencies",message:"依赖无效"}); else { unknown(e.characterBinding.dependencies,["skeletonId"],"entry.characterBinding.dependencies",issues); if (typeof e.characterBinding.dependencies.skeletonId !== "string") issues.push({path:"entry.characterBinding.dependencies.skeletonId",message:"依赖无效"}); } }
    for (const key of ["actions","textures"] as const) if (!Array.isArray(e[key]) || e[key].length > lim.maxEntries-3) issues.push({path:`entry.${key}`,message:"必须是有界数组"});
    if (Array.isArray(e.actions)) e.actions.forEach((a,i) => { const p=`entry.actions[${i}]`; if (!validFile(a,p,JSON_PATH,lim,issues)) return; unknown(a,["id","name","motionClipId","path","digest","byteLength","speed","repeat","loop","dependencies"],p,issues); if (typeof a.id!=="string"||!ID.test(a.id)||typeof a.name!=="string"||!a.name||typeof a.motionClipId!=="string"||!ID.test(a.motionClipId)) issues.push({path:p,message:"动作身份无效"}); if (typeof a.path==="string"&&!a.path.startsWith("motions/")) issues.push({path:`${p}.path`,message:"目录不匹配"}); if (typeof a.speed!=="number"||!Number.isFinite(a.speed)||a.speed<=0||a.speed>8||typeof a.repeat!=="number"||!Number.isInteger(a.repeat)||a.repeat<1||a.repeat>100||typeof a.loop!=="boolean") issues.push({path:p,message:"动作播放参数无效"}); if (!record(a.dependencies)||typeof a.dependencies.skeletonId!=="string") issues.push({path:`${p}.dependencies`,message:"依赖无效"}); else unknown(a.dependencies,["skeletonId"],`${p}.dependencies`,issues); });
    if (Array.isArray(e.textures)) e.textures.forEach((t,i)=>{const p=`entry.textures[${i}]`;if(!validFile(t,p,PNG_PATH,lim,issues))return;unknown(t,["attachmentId","path","digest","byteLength"],p,issues);if(typeof t.attachmentId!=="string"||!ID.test(t.attachmentId))issues.push({path:`${p}.attachmentId`,message:"附件 ID 无效"});});
    const actionIds=new Set<string>(), attachmentIds=new Set<string>(); let previous=""; if(Array.isArray(e.actions))for(const [i,a]of e.actions.entries())if(record(a)&&typeof a.id==="string"){if(actionIds.has(a.id))issues.push({path:`entry.actions[${i}].id`,message:"动作 ID 重复"});if(previous&&a.id<=previous)issues.push({path:`entry.actions[${i}].id`,message:"动作必须按 ID 严格排序"});actionIds.add(a.id);previous=a.id;} previous=""; if(Array.isArray(e.textures))for(const [i,t]of e.textures.entries())if(record(t)&&typeof t.attachmentId==="string"){if(attachmentIds.has(t.attachmentId))issues.push({path:`entry.textures[${i}].attachmentId`,message:"附件 ID 重复"});if(previous&&t.attachmentId<=previous)issues.push({path:`entry.textures[${i}].attachmentId`,message:"纹理必须按附件 ID 严格排序"});attachmentIds.add(t.attachmentId);previous=t.attachmentId;}
  }
  return issues.length ? { ok:false, issues } : { ok:true, value:value as unknown as FbanimManifestV2, issues:[] };
}

export async function buildFbanimV2Entries(source: FbanimV2PackageSource): Promise<FbanimEntry[]> {
  const sv=validateSkeleton(source.skeleton), bv=validateCharacterBinding(source.characterBinding,source.skeleton); if(!sv.ok)throw new Error(`骨架无效：${sv.issues[0]!.path}`); if(!bv.ok)throw new Error(`绑定无效：${bv.issues[0]!.path}`); if(source.characterBinding.skeletonId!==source.skeleton.id)throw new Error("绑定与骨架不匹配");
  const entries:FbanimEntry[]=[], add=async(root:string,value:JsonObject)=>{const bytes=canonicalizeJson(value),digest=await sha256Digest(bytes),path=`${root}/${digest.slice(7)}.json`;if(!entries.some(entry=>entry.path===path))entries.push({path,bytes});return{path,digest,byteLength:bytes.length};};
  const skeleton={id:source.skeleton.id,...await add("skeletons",source.skeleton as unknown as JsonObject)}; const characterBinding={id:source.characterBinding.id,...await add("bindings",source.characterBinding as unknown as JsonObject),dependencies:{skeletonId:source.skeleton.id}};
  const actionIds=new Set<string>(), actions:FbanimV2Action[]=[]; for(const a of source.actions){if(actionIds.has(a.id))throw new Error(`动作 ID 重复：${a.id}`);actionIds.add(a.id);const v=validateMotionClip(a.motionClip,source.skeleton);if(!v.ok||a.motionClip.skeletonId!==source.skeleton.id)throw new Error(`动作 ${a.id} 与骨架不匹配或无效`);actions.push({id:a.id,name:a.name,motionClipId:a.motionClip.id,speed:a.speed,repeat:a.repeat,loop:a.loop,...await add("motions",a.motionClip as unknown as JsonObject),dependencies:{skeletonId:source.skeleton.id}});}
  const attachmentIds=new Set(source.characterBinding.attachments.map(a=>a.id)), seen=new Set<string>(), textures:FbanimV2Texture[]=[]; for(const t of source.textures){if(seen.has(t.attachmentId)||!attachmentIds.has(t.attachmentId))throw new Error(`纹理附件重复或不存在：${t.attachmentId}`);seen.add(t.attachmentId);if(t.bytes.length<8||pngSignature.some((b,i)=>t.bytes[i]!==b))throw new Error(`纹理不是 PNG：${t.attachmentId}`);const digest=await sha256Digest(t.bytes),path=`textures/${digest.slice(7)}.png`;if(!entries.some(entry=>entry.path===path))entries.push({path,bytes:t.bytes});textures.push({attachmentId:t.attachmentId,path,digest,byteLength:t.bytes.length});} for(const id of attachmentIds)if(!seen.has(id))throw new Error(`附件缺少纹理：${id}`);
  actions.sort((a,b)=>compareCodeUnits(a.id,b.id));textures.sort((a,b)=>compareCodeUnits(a.attachmentId,b.attachmentId));entries.sort((a,b)=>compareCodeUnits(a.path,b.path)); const manifest:FbanimManifestV2={format:"fbanim",version:2,createdBy:source.createdBy,entry:{skeleton,characterBinding,actions,textures}};const mv=validateFbanimV2Manifest(manifest);if(!mv.ok)throw new Error(`manifest 无效：${mv.issues[0]!.path} ${mv.issues[0]!.message}`);const bytes=canonicalizeJson(manifest as unknown as JsonObject);if(entries.length+1>FBANIM_V2_LIMITS.maxEntries||bytes.length>FBANIM_V2_LIMITS.maxManifestBytes||entries.reduce((n,e)=>n+e.bytes.length,bytes.length)>FBANIM_V2_LIMITS.maxTotalBytes)throw new Error("包体积或文件数超限");return[{path:"manifest.json",bytes},...entries];
}

export async function verifyFbanimV2Entries(input: Iterable<FbanimEntry>, overrides: Partial<FbanimLimits> = {}): Promise<ValidationResult<VerifiedFbanimV2Package>> {
  const lim = limits(overrides), issues: ValidationIssue[] = [], byPath = new Map<string, Uint8Array>();
  let total = 0, count = 0;
  for (const entry of input) {
    if (++count > lim.maxEntries) return { ok: false, issues: [{ path: "$", message: "文件数超限" }] };
    if (!entry || typeof entry.path !== "string" || !(entry.bytes instanceof Uint8Array)) {
      issues.push({ path: `entries[${count - 1}]`, message: "条目无效" });
      continue;
    }
    if (entry.path !== "manifest.json" && !JSON_PATH.test(entry.path) && !PNG_PATH.test(entry.path)) issues.push({ path: entry.path, message: "路径无效或存在穿越" });
    if (enc.encode(entry.path).length > lim.maxPathBytes || byPath.has(entry.path)) issues.push({ path: entry.path, message: "路径过长或重复" });
    if (entry.bytes.length > (entry.path === "manifest.json" ? lim.maxManifestBytes : lim.maxAssetBytes)) issues.push({ path: entry.path, message: "文件体积超限" });
    byPath.set(entry.path, entry.bytes);
    total += entry.bytes.length;
    if (total > lim.maxTotalBytes) return { ok: false, issues: [{ path: "$", message: "总字节预算超限" }] };
  }
  const manifestBytes = byPath.get("manifest.json");
  if (!manifestBytes) return { ok: false, issues: [...issues, { path: "manifest.json", message: "缺少 manifest" }] };
  const parsedManifest = parseCanonicalJson(manifestBytes);
  if (!parsedManifest.ok) return parsedManifest;
  const manifestValidation = validateFbanimV2Manifest(parsedManifest.value, lim);
  if (!manifestValidation.ok) return { ok: false, issues: [...issues, ...manifestValidation.issues] };
  const manifest = manifestValidation.value;
  const descriptors = [manifest.entry.skeleton, manifest.entry.characterBinding, ...manifest.entry.actions, ...manifest.entry.textures];
  const expectedPath = (descriptor: FbanimV2FileDescriptor) => {
    const root = descriptor === manifest.entry.skeleton ? "skeletons" : descriptor === manifest.entry.characterBinding ? "bindings" : manifest.entry.textures.includes(descriptor as FbanimV2Texture) ? "textures" : "motions";
    return `${root}/${descriptor.digest.slice(7)}.${root === "textures" ? "png" : "json"}`;
  };
  const listed = new Set(["manifest.json", ...descriptors.map((descriptor) => descriptor.path)]);
  for (const path of byPath.keys()) if (!listed.has(path)) issues.push({ path, message: "未在 manifest 中列出" });
  for (const descriptor of descriptors) {
    if (descriptor.path !== expectedPath(descriptor)) issues.push({ path: descriptor.path, message: "路径与内容摘要不匹配" });
    const bytes = byPath.get(descriptor.path);
    if (!bytes) { issues.push({ path: descriptor.path, message: "文件缺失" }); continue; }
    if (bytes.length !== descriptor.byteLength || await sha256Digest(bytes) !== descriptor.digest) issues.push({ path: descriptor.path, message: "字节数或摘要不匹配" });
  }
  if (issues.length) return { ok: false, issues };

  const parsedAssets = new Map<string, unknown>();
  for (const descriptor of [manifest.entry.skeleton, manifest.entry.characterBinding, ...manifest.entry.actions]) {
    if (parsedAssets.has(descriptor.path)) continue;
    const parsed = parseCanonicalJson(byPath.get(descriptor.path)!);
    if (!parsed.ok) issues.push(...parsed.issues.map((issue) => ({ path: `${descriptor.path}:${issue.path}`, message: issue.message })));
    else parsedAssets.set(descriptor.path, parsed.value);
  }
  if (issues.length) return { ok: false, issues };
  const asset = <T>(descriptor: FbanimV2FileDescriptor) => parsedAssets.get(descriptor.path) as T;
  const skeleton = asset<Skeleton>(manifest.entry.skeleton), binding = asset<CharacterBinding>(manifest.entry.characterBinding);
  const skeletonValidation = validateSkeleton(skeleton), bindingValidation = validateCharacterBinding(binding, skeleton);
  if (!skeletonValidation.ok || !bindingValidation.ok || skeleton.id !== manifest.entry.skeleton.id || binding.id !== manifest.entry.characterBinding.id || binding.skeletonId !== skeleton.id || manifest.entry.characterBinding.dependencies.skeletonId !== skeleton.id) issues.push({ path: "entry", message: "骨架或绑定身份/引用不匹配" });
  const actions = [] as VerifiedFbanimV2Package["actions"];
  for (const descriptor of manifest.entry.actions) {
    const clip = asset<MotionClip>(descriptor), validation = validateMotionClip(clip, skeleton);
    if (!validation.ok || clip.id !== descriptor.motionClipId || clip.skeletonId !== skeleton.id || descriptor.dependencies.skeletonId !== skeleton.id) issues.push({ path: descriptor.path, message: "动作身份、骨架或内容不匹配" });
    actions.push({ id: descriptor.id, name: descriptor.name, motionClip: clip, speed: descriptor.speed, repeat: descriptor.repeat, loop: descriptor.loop });
  }
  const attachmentIds = new Set(binding.attachments.map((attachment) => attachment.id)), textures: FbanimV2TextureSource[] = [];
  for (const descriptor of manifest.entry.textures) {
    const bytes = byPath.get(descriptor.path)!;
    if (!attachmentIds.has(descriptor.attachmentId) || bytes.length < 8 || pngSignature.some((value, index) => bytes[index] !== value)) issues.push({ path: descriptor.path, message: "纹理引用无效或不是 PNG" });
    textures.push({ attachmentId: descriptor.attachmentId, bytes });
  }
  if (new Set(manifest.entry.textures.map((texture) => texture.attachmentId)).size !== attachmentIds.size || [...attachmentIds].some((id) => !manifest.entry.textures.some((texture) => texture.attachmentId === id))) issues.push({ path: "entry.textures", message: "纹理必须与附件一一对应" });
  return issues.length ? { ok: false, issues } : { ok: true, value: { manifest, manifestDigest: await sha256Digest(manifestBytes), skeleton, characterBinding: binding, actions, textures }, issues: [] };
}
