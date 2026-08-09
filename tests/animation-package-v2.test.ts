import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import manifestSchema from "../packages/shared/schemas/fbanim/v2/manifest.schema.json";
import { buildFbanimV2Entries, canonicalizeJson, sha256Digest, verifyFbanimV2Entries, type CharacterBinding, type MotionClip, type Skeleton } from "../packages/shared/src";

const skeleton: Skeleton = {
  schemaVersion: 1,
  kind: "skeleton",
  id: "runtime-skeleton",
  name: "Runtime Skeleton",
  coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "pixel" },
  bones: [{ id: "root", name: "Root", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }],
};
const binding: CharacterBinding = {
  schemaVersion: 1,
  kind: "character-binding",
  id: "runtime-binding",
  name: "Runtime Binding",
  skeletonId: skeleton.id,
  attachments: [{ id: "body-region", name: "Body", type: "region", materialId: "local-material", imageSlot: "raw", size: [16, 16], pivot: [.5, .5], rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }],
  slots: [{ id: "body-slot", name: "Body", boneId: "root", attachmentId: "body-region", drawOrder: 0 }],
};
const clip: MotionClip = { schemaVersion: 1, kind: "motion-clip", id: "runtime-idle", name: "Idle", skeletonId: skeleton.id, duration: 1, loop: true, tracks: [], events: [] };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

const source = () => ({
  createdBy: { name: "FrameBaker", version: "test" },
  skeleton,
  characterBinding: binding,
  actions: [{ id: "idle", name: "Idle", motionClip: clip, speed: 1, repeat: 1, loop: true }],
  textures: [{ attachmentId: "body-region", bytes: png }],
});

describe("fbanim v2 运行时包", () => {
  test("构建并验证角色、动作和纹理闭包", async () => {
    const entries = await buildFbanimV2Entries(source());
    expect(entries[0]?.path).toBe("manifest.json");
    expect(entries.some((entry) => entry.path.startsWith("textures/"))).toBeTrue();
    const verified = await verifyFbanimV2Entries(entries);
    expect(verified.ok).toBeTrue();
    if (verified.ok) {
      expect(verified.value.actions[0]?.name).toBe("Idle");
      expect(verified.value.textures[0]?.bytes).toEqual(png);
    }
    const validateSchema = new Ajv2020({ strict: true }).compile(manifestSchema);
    expect(validateSchema(JSON.parse(new TextDecoder().decode(entries[0]!.bytes)))).toBeTrue();
  });

  test("相同输入生成完全确定的条目", async () => {
    const a = await buildFbanimV2Entries(source());
    const b = await buildFbanimV2Entries(source());
    expect(a.map((entry) => [entry.path, [...entry.bytes]])).toEqual(b.map((entry) => [entry.path, [...entry.bytes]]));
  });

  test("拒绝篡改摘要、路径穿越和缺失纹理", async () => {
    const entries = await buildFbanimV2Entries(source());
    const altered = entries.map((entry) => ({ path: entry.path, bytes: entry.bytes.slice() }));
    altered[1]!.bytes[0] ^= 1;
    expect((await verifyFbanimV2Entries(altered)).ok).toBeFalse();
    expect((await verifyFbanimV2Entries([...entries, { path: "../escape.png", bytes: png }])).ok).toBeFalse();
    await expect(buildFbanimV2Entries({ ...source(), textures: [] })).rejects.toThrow();
  });

  test("拒绝改名的内容寻址路径和非规范资产 JSON", async () => {
    const entries = await buildFbanimV2Entries(source());
    const manifest = JSON.parse(new TextDecoder().decode(entries[0]!.bytes));
    const skeletonEntry = entries.find((entry) => entry.path === manifest.entry.skeleton.path)!;
    const renamed = `skeletons/${"0".repeat(64)}.json`;
    manifest.entry.skeleton.path = renamed;
    const renamedEntries = entries.map((entry) => entry === skeletonEntry ? { ...entry, path: renamed } : entry.path === "manifest.json" ? { ...entry, bytes: canonicalizeJson(manifest) } : entry);
    expect((await verifyFbanimV2Entries(renamedEntries)).ok).toBeFalse();

    const pretty = new TextEncoder().encode(JSON.stringify(skeleton, null, 2));
    const digest = await sha256Digest(pretty), path = `skeletons/${digest.slice(7)}.json`;
    manifest.entry.skeleton = { ...manifest.entry.skeleton, path, digest, byteLength: pretty.length };
    const prettyEntries = entries.filter((entry) => entry !== skeletonEntry).map((entry) => entry.path === "manifest.json" ? { ...entry, bytes: canonicalizeJson(manifest) } : entry).concat({ path, bytes: pretty });
    expect((await verifyFbanimV2Entries(prettyEntries)).ok).toBeFalse();
  });
});
