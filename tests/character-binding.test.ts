import { describe, expect, test } from "bun:test";
import { ARTICULATED_CHARACTER_PART_ROLES, validateCharacterBinding, validateFbanimEntryPath, validateFbanimManifest, validateMotionClip, validateSkeleton, type CharacterBinding, type CharacterPartSet, type Skeleton } from "../packages/shared/src";
import { BUILTIN_MOTION_IDS, buildArticulatedAttackAssets, buildRetargetedBuiltinMotionClip, getArticulatedPartSetStatus, type ArticulatedPartImageMetrics } from "../apps/web/src/articulatedCharacter";
import { attachmentLocalBounds, attachmentSvgImageY, fitAttachmentSizeToImage } from "../apps/web/src/bindingGeometry";

const skeleton: Skeleton = { schemaVersion: 1, kind: "skeleton", id: "skel", name: "Skeleton", coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "pixel" }, bones: [{ id: "root", name: "Root", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] };
const valid: CharacterBinding = { schemaVersion: 1, kind: "character-binding", id: "binding", name: "Binding", skeletonId: skeleton.id, attachments: [{ id: "region", name: "Region", type: "region", materialId: "material", imageSlot: "raw", size: [32, 64], pivot: [.5, 1], rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }], slots: [{ id: "slot", name: "Slot", boneId: "root", attachmentId: "region", drawOrder: 0 }] };

describe("CharacterBinding v1", () => {
  test("accepts a valid Region binding", () => expect(validateCharacterBinding(valid, skeleton).ok).toBeTrue());
  test.each([
    ["duplicate attachment", (v: CharacterBinding) => v.attachments.push({ ...v.attachments[0]! })],
    ["duplicate slot", (v: CharacterBinding) => v.slots.push({ ...v.slots[0]!, drawOrder: 1 })],
    ["duplicate order", (v: CharacterBinding) => v.slots.push({ ...v.slots[0]!, id: "slot2" })],
    ["missing bone", (v: CharacterBinding) => { v.slots[0]!.boneId = "missing"; }],
    ["missing attachment", (v: CharacterBinding) => { v.slots[0]!.attachmentId = "missing"; }],
    ["invalid pivot", (v: CharacterBinding) => { v.attachments[0]!.pivot = [2, 0]; }],
    ["invalid size", (v: CharacterBinding) => { v.attachments[0]!.size = [0, 1]; }],
    ["invalid quaternion", (v: CharacterBinding) => { v.attachments[0]!.rest.rotation = [0, 0, 0, 2]; }],
  ])("rejects %s", (_, mutate) => { const value = structuredClone(valid); mutate(value); expect(validateCharacterBinding(value, skeleton).ok).toBeFalse(); });
  test("fbanim v1 rejects character-binding manifest and path", () => {
    const manifest = { format: "framebaker-animation-package", packageVersion: 1, createdBy: { name: "test", version: "1" }, assets: [{ kind: "character-binding", id: "binding", schemaVersion: 1, path: `bindings/${"a".repeat(64)}.json`, byteLength: 0, digest: `sha256:${"a".repeat(64)}`, dependencies: [] }] };
    expect(validateFbanimManifest(manifest).ok).toBeFalse();
    expect(validateFbanimEntryPath(`bindings/${"a".repeat(64)}.json`).length).toBeGreaterThan(0);
  });

  test("Region 的图片、选框和轴心共享同一套 Y-up 几何", () => {
    expect(attachmentLocalBounds([32, 64], [.5, 1])).toEqual({ left: -16, right: 16, bottom: -64, top: 0 });
    expect(attachmentSvgImageY([32, 64], [.5, 1])).toBe(0);
    expect(attachmentLocalBounds([32, 64], [.5, 0])).toEqual({ left: -16, right: 16, bottom: 0, top: 64 });
    expect(attachmentSvgImageY([32, 64], [.5, 0])).toBe(-64);
    expect(fitAttachmentSizeToImage([1, 2], 300, 200)).toEqual([3, 2]);
  });
});

describe("标准 12 分件自动组装", () => {
  const partSet: CharacterPartSet = {
    id: "parts",
    name: "Articulated hero",
    source: "generated",
    referenceMaterialId: null,
    members: ARTICULATED_CHARACTER_PART_ROLES.map((role) => ({ materialId: `material-${role}`, role, name: role })),
    created_at: 1,
    updated_at: 1,
  };

  test("建立真实肩肘腕、髋膝踝骨架与 12 个独立附件", () => {
    expect(getArticulatedPartSetStatus(partSet)).toEqual({ complete: true, missing: [], duplicate: [] });
    const { skeleton: builtSkeleton, binding, clip } = buildArticulatedAttackAssets(partSet, { skeleton: "Skeleton", binding: "Binding", clip: "Attack" });
    expect(builtSkeleton.bones).toHaveLength(17);
    expect(binding.attachments).toHaveLength(12);
    expect(binding.slots).toHaveLength(12);
    expect(new Set(binding.attachments.map((item) => item.materialId)).size).toBe(12);
    expect(validateSkeleton(builtSkeleton).ok).toBeTrue();
    expect(validateCharacterBinding(binding, builtSkeleton).ok).toBeTrue();
    expect(validateMotionClip(clip, builtSkeleton).ok).toBeTrue();
    const semantics = new Set(builtSkeleton.bones.map((bone) => bone.semantic));
    for (const semantic of ["leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftKnee", "rightKnee", "weapon"]) expect(semantics.has(semantic)).toBeTrue();
    for (const semantic of ["leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftKnee", "rightKnee"]) {
      const id = builtSkeleton.bones.find((bone) => bone.semantic === semantic)!.id;
      expect(clip.tracks.some((track) => track.targetId === id && track.property === "rotation" && track.keyframes.length === 41)).toBeTrue();
    }
  });

  test("缺少前臂时不会冒充完整关节角色", () => {
    const incomplete = { ...partSet, members: partSet.members.filter((member) => member.role !== "forearm-left") };
    expect(getArticulatedPartSetStatus(incomplete)).toMatchObject({ complete: false, missing: ["forearm-left"] });
    expect(() => buildArticulatedAttackAssets(incomplete, { skeleton: "S", binding: "B", clip: "C" })).toThrow("12 分件不完整");
  });

  test("按真实 PNG 比例生成附件，并让骨长跟随对应分件", () => {
    const metrics = Object.fromEntries(ARTICULATED_CHARACTER_PART_ROLES.map((role, index) => [role, {
      width: 60 + index * 3,
      height: 120 + index * 5,
      imageSlot: "processed" as const,
    }])) as ArticulatedPartImageMetrics;
    const { skeleton: fittedSkeleton, binding } = buildArticulatedAttackAssets(partSet, { skeleton: "Fitted", binding: "Fitted", clip: "Attack" }, metrics);
    for (const attachment of binding.attachments) {
      const role = attachment.id.match(/^region-(.+)-[0-9a-f-]{36}$/)?.[1] as keyof typeof metrics;
      const metric = metrics[role]!;
      expect(attachment.size[0] / attachment.size[1]).toBeCloseTo(metric.width / metric.height, 10);
      expect(attachment.imageSlot).toBe("processed");
    }
    const upperArm = fittedSkeleton.bones.find((bone) => bone.semantic === "leftShoulder")!;
    const elbow = fittedSkeleton.bones.find((bone) => bone.semantic === "leftElbow")!;
    const upperAttachment = binding.attachments.find((attachment) => binding.slots.find((slot) => slot.attachmentId === attachment.id)?.boneId === upperArm.id)!;
    const weaponAttachment = binding.attachments.find((attachment) => attachment.name === "weapon")!;
    expect(upperAttachment.size[1]).not.toBe(.73);
    expect(elbow.rest.translation[1]).toBeCloseTo(-upperAttachment.size[1] * .88, 10);
    expect(weaponAttachment.pivot).toEqual([.5, .82]);
    expect(validateSkeleton(fittedSkeleton).ok).toBeTrue();
    expect(validateCharacterBinding(binding, fittedSkeleton).ok).toBeTrue();
  });

  test("早期 6 个预制动作可按语义重定向到任意实例 ID", () => {
    const { skeleton: target } = buildArticulatedAttackAssets(partSet, { skeleton: "Skeleton", binding: "Binding", clip: "Attack" });
    expect(BUILTIN_MOTION_IDS).toEqual(["idle", "walk", "run", "attack", "hurt", "death"]);
    const targetIds = new Set(target.bones.map((bone) => bone.id));
    for (const presetId of BUILTIN_MOTION_IDS) {
      const clip = buildRetargetedBuiltinMotionClip(target, presetId, presetId);
      expect(validateMotionClip(clip, target).ok).toBeTrue();
      expect(clip.skeletonId).toBe(target.id);
      expect(clip.tracks.every((track) => targetIds.has(track.targetId))).toBeTrue();
      expect(clip.loop).toBe(["idle", "walk", "run"].includes(presetId));
      expect(clip.tracks.find((track) => track.property === "rotation" && track.targetId === target.semanticProfile!.bones.leftElbow)?.targetId).toBe(target.semanticProfile!.bones.leftElbow);
    }
  });

});
