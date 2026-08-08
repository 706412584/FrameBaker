import Ajv2020 from "ajv/dist/2020.js";
import {
  MOTION_CLIP_SCHEMA_VERSION,
  SKELETON_SCHEMA_VERSION,
  sampleMotionClip,
  validateMotionClip,
  type MotionClip,
  type Skeleton,
} from "../packages/shared/src/animation";
import { buildFbanimEntries, verifyFbanimEntries } from "../packages/shared/src/animationPackage";
import { canonicalizeJson, parseCanonicalJson, sha256Digest, validateBoundedJsonValue, type JsonObject } from "../packages/shared/src/json";

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const skeleton: Skeleton = {
  schemaVersion: SKELETON_SCHEMA_VERSION,
  kind: "skeleton",
  id: "check:package-rig",
  name: "Package rig",
  coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" },
  bones: [
    { id: "root", name: "Root", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { id: "tip", name: "Tip", parentId: "root", rest: { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, tipOffset: [0, 1, 0] },
  ],
};
const clip: MotionClip = {
  schemaVersion: MOTION_CLIP_SCHEMA_VERSION,
  kind: "motion-clip",
  id: "check:package-motion",
  name: "Package motion",
  skeletonId: skeleton.id,
  duration: 1,
  loop: true,
  tracks: [{ targetId: "root", property: "translation", interpolation: "linear", keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [2, 0, 0] }] }],
  events: [{ time: 0.5, type: "marker", name: "middle" }],
};

const canonical = canonicalizeJson({ b: 2, a: 1 });
ensure(new TextDecoder().decode(canonical) === '{"a":1,"b":2}', "RFC 8785 属性排序错误");
ensure(await sha256Digest(canonical) === "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777", "规范 JSON 摘要不稳定");
ensure(!parseCanonicalJson(new TextEncoder().encode('{ "a": 1 }')).ok, "导入器接受了非规范 JSON");
ensure(new TextDecoder().decode(canonicalizeJson([333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001])) === "[333333333.3333333,1e+30,4.5,0.002,1e-27]", "RFC 8785 数值编码错误");
const unicodeCanonical = new TextDecoder().decode(canonicalizeJson({ "€": 1, [String.fromCharCode(13)]: 2, "דּ": 3, "1": 4, "😀": 5, [String.fromCharCode(128)]: 6, "ö": 7 }));
const expectedUnicode = `{${JSON.stringify(String.fromCharCode(13))}:2,"1":4,${JSON.stringify(String.fromCharCode(128))}:6,"ö":7,"€":1,"😀":5,"דּ":3}`;
ensure(unicodeCanonical === expectedUnicode, "RFC 8785 UTF-16 键排序错误");
ensure(new TextDecoder().decode(canonicalizeJson(-0)) === "0", "RFC 8785 未把负零编码为零");
for (const invalid of [new Date(), "\ud800", (() => { const value: unknown[] = []; value.length = 1; return value; })()]) {
  let rejected = false;
  try { canonicalizeJson(invalid as never); } catch { rejected = true; }
  ensure(rejected, "规范化器接受了非 I-JSON 值");
}
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
let rejectedCycle = false;
try { canonicalizeJson(cyclic as never); } catch { rejectedCycle = true; }
ensure(rejectedCycle, "规范化器接受了循环引用");
ensure(validateBoundedJsonValue(Array.from({ length: 10_000 }, () => 0), { maxNodes: 10 }).length === 1, "JSON 节点预算耗尽后仍继续放大错误");
ensure(canonicalizeJson({ keys: Array.from({ length: 13_000 }, (_, time) => ({ time, value: [0, 0, 0] })) }).length > 0, "整份文档预算错误拒绝了合法核心关键帧规模");

const entries = await buildFbanimEntries({ createdBy: { name: "FrameBaker", version: "0.1.0" }, skeletons: [skeleton], motionClips: [clip] });
const verified = await verifyFbanimEntries(entries);
ensure(verified.ok, `逻辑包验证失败：${JSON.stringify(verified.issues)}`);
ensure(verified.value.skeletons.length === 1 && verified.value.motionClips.length === 1, "逻辑包往返丢失资产");

const rebuilt = await buildFbanimEntries({
  createdBy: verified.value.manifest.createdBy,
  skeletons: verified.value.skeletons,
  motionClips: verified.value.motionClips,
});
ensure(entries.length === rebuilt.length && entries.every((entry, index) => entry.path === rebuilt[index]!.path && entry.bytes.length === rebuilt[index]!.bytes.length && entry.bytes.every((byte, offset) => byte === rebuilt[index]!.bytes[offset])), "逻辑包往返结果不确定");

const originalPose = sampleMotionClip(clip, skeleton, 0.375);
const roundtripPose = sampleMotionClip(verified.value.motionClips[0]!, verified.value.skeletons[0]!, 0.375);
ensure(originalPose.worldMatrices.root!.every((value, index) => Math.abs(value - roundtripPose.worldMatrices.root![index]!) < 1e-10), "逻辑包往返改变 FK 采样结果");

const tampered = entries.map((entry) => ({ path: entry.path, bytes: entry.bytes.slice() }));
const asset = tampered.find((entry) => entry.path !== "manifest.json")!;
asset.bytes[asset.bytes.length - 1] ^= 1;
ensure(!(await verifyFbanimEntries(tampered)).ok, "逻辑包验证器未拒绝摘要不匹配");
ensure(!(await verifyFbanimEntries([...entries, entries[1]!])).ok, "逻辑包验证器未拒绝重复路径");
ensure(!(await verifyFbanimEntries([{ path: "manifest.json", bytes: entries[0]!.bytes }, { path: "../escape.json", bytes: new Uint8Array() }])).ok, "逻辑包验证器未拒绝路径穿越");
let pulls = 0;
function* oversizedEntries() {
  for (;;) {
    pulls += 1;
    if (pulls > 3) throw new Error("验证器在数量超限后仍读取输入");
    yield entries[0]!;
  }
}
ensure(!(await verifyFbanimEntries(oversizedEntries(), { maxEntries: 2 })).ok && pulls === 3, "逻辑包验证器未在文件数量超限时停止读取");

const unknownField = { ...skeleton, legacy: true } as unknown as JsonObject;
let rejectedUnknown = false;
try { await buildFbanimEntries({ createdBy: { name: "FrameBaker", version: "0.1.0" }, skeletons: [unknownField as unknown as Skeleton], motionClips: [] }); } catch { rejectedUnknown = true; }
ensure(rejectedUnknown, "导出器未拒绝未知核心字段");

const schemas = [];
for (const path of [
  "packages/shared/schemas/animation/v1/common.schema.json",
  "packages/shared/schemas/animation/v1/skeleton.schema.json",
  "packages/shared/schemas/animation/v1/motion-clip.schema.json",
  "packages/shared/schemas/fbanim/v1/manifest.schema.json",
]) {
  const schema = await Bun.file(path).json();
  ensure(schema.$schema === "https://json-schema.org/draft/2020-12/schema" && typeof schema.$id === "string", `Schema 元信息缺失：${path}`);
  schemas.push(schema);
}
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const schema of schemas) ajv.addSchema(schema);
const validateSkeletonSchema = ajv.getSchema("urn:framebaker:schema:animation:skeleton:1");
const validateMotionSchema = ajv.getSchema("urn:framebaker:schema:animation:motion-clip:1");
const validateManifestSchema = ajv.getSchema("urn:framebaker:schema:fbanim:manifest:1");
ensure(validateSkeletonSchema?.(skeleton), `Skeleton JSON Schema 拒绝有效样本：${JSON.stringify(validateSkeletonSchema?.errors)}`);
ensure(validateMotionSchema?.(clip), `MotionClip JSON Schema 拒绝有效样本：${JSON.stringify(validateMotionSchema?.errors)}`);
ensure(validateManifestSchema?.(verified.value.manifest), `manifest JSON Schema 拒绝有效样本：${JSON.stringify(validateManifestSchema?.errors)}`);
ensure(!validateSkeletonSchema?.({ ...skeleton, legacy: true }), "Skeleton JSON Schema 接受了未知核心字段");
ensure(!validateSkeletonSchema?.({ ...skeleton, name: "   " }) && !validateMotionClip({ ...clip, name: "   " }, skeleton).ok, "Schema 与运行时对白空名称的判断不一致");

const payloadHeavy = {
  ...clip,
  events: Array.from({ length: 4 }, (_, index) => ({ time: index / 5, type: "marker", name: String(index), payload: { values: Array.from({ length: 30_000 }, () => 0) } })),
};
ensure(!validateMotionClip(payloadHeavy, skeleton).ok, "任意 JSON 节点预算未跨 payload 聚合");

console.log("动画包检查通过：RFC 8785、SHA-256、路径安全、往返与 FK 一致性正常");
