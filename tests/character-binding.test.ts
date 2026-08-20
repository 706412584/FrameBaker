import { describe, expect, test } from "bun:test";
import { quaternionFromZRotation, sampleMotionClip, transformPoint, validateCharacterBinding, validateFbanimEntryPath, validateFbanimManifest, zRotationFromQuaternion, type CharacterBinding, type MotionClip, type Skeleton } from "../packages/shared/src";
import { attachmentLocalBounds, attachmentSvgImageY, fitAttachmentSizeToImage } from "../apps/web/src/bindingGeometry";

const skeleton: Skeleton = { schemaVersion: 1, kind: "skeleton", id: "skel", name: "Skeleton", coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "pixel" }, bones: [
  { id: "root", name: "Root", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { id: "child", name: "Child", parentId: "root", rest: { translation: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
] };
const valid: CharacterBinding = { schemaVersion: 1, kind: "character-binding", id: "binding", name: "Binding", skeletonId: skeleton.id, attachments: [{ id: "region", name: "Region", type: "region", materialId: "material", imageSlot: "raw", size: [32, 64], pivot: [.5, 1], rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }], slots: [{ id: "slot", name: "Slot", boneId: "root", attachmentId: "region", drawOrder: 0 }] };

describe("CharacterBinding v1", () => {
  test("accepts a valid Region binding", () => expect(validateCharacterBinding(valid, skeleton).ok).toBeTrue());
  test("accepts finite project joint adjustments for existing bones", () => {
    expect(validateCharacterBinding({ ...valid, boneRotationOffsets: { root: .25, child: -.5 } }, skeleton).ok).toBeTrue();
  });
  test.each([
    ["missing bone", { missing: .25 }],
    ["NaN", { root: Number.NaN }],
    ["infinity", { root: Number.POSITIVE_INFINITY }],
    ["angle beyond π", { root: Math.PI + .01 }],
  ])("rejects invalid project joint adjustment: %s", (_, boneRotationOffsets) => {
    expect(validateCharacterBinding({ ...valid, boneRotationOffsets }, skeleton).ok).toBeFalse();
  });
  test("adds project joint adjustments after motion sampling and before FK", () => {
    const clip: MotionClip = {
      schemaVersion: 1, kind: "motion-clip", id: "clip", name: "Clip", skeletonId: skeleton.id, duration: 1, loop: true, events: [],
      tracks: [{ targetId: "root", property: "rotation", interpolation: "linear", keyframes: [{ time: 0, value: quaternionFromZRotation(.2) }] }],
    };
    const rest = sampleMotionClip({ ...clip, tracks: [] }, skeleton, 0, { root: .3 });
    const animated = sampleMotionClip(clip, skeleton, 0, { root: .3 });
    expect(zRotationFromQuaternion(rest.local.root!.rotation)).toBeCloseTo(.3, 8);
    expect(zRotationFromQuaternion(animated.local.root!.rotation)).toBeCloseTo(.5, 8);
    const childOrigin = transformPoint(rest.worldMatrices.child!, [0, 0, 0]);
    expect(childOrigin[0]).toBeCloseTo(10 * Math.cos(.3), 8);
    expect(childOrigin[1]).toBeCloseTo(10 * Math.sin(.3), 8);
  });
  test("accepts bounded deterministic attachment deformation", () => {
    const value = structuredClone(valid);
    value.attachments[0]!.deform = { axis: "vertical", bend: .2, sway: .15, frequency: 2, phase: 0 };
    expect(validateCharacterBinding(value, skeleton).ok).toBeTrue();
  });
  test("rejects out-of-range attachment deformation", () => {
    const value = structuredClone(valid);
    value.attachments[0]!.deform = { axis: "vertical", bend: 1.2, sway: 0, frequency: 2, phase: 0 };
    expect(validateCharacterBinding(value, skeleton).ok).toBeFalse();
  });
  test("accepts a valid static attachment warp", () => {
    const value = structuredClone(valid);
    // 3×3 网格共 18 个位移分量，全零与范围内非零位移都应通过
    value.attachments[0]!.warp = { grid: [3, 3], points: new Array<number>(18).fill(0) };
    expect(validateCharacterBinding(value, skeleton).ok).toBeTrue();
    value.attachments[0]!.warp = { grid: [2, 4], points: new Array<number>(16).fill(-2) };
    expect(validateCharacterBinding(value, skeleton).ok).toBeTrue();
  });
  test.each([
    ["grid 列数越界", { grid: [9, 3] as [number, number], points: new Array<number>(54).fill(0) }],
    ["grid 行数越界", { grid: [3, 1] as [number, number], points: new Array<number>(6).fill(0) }],
    ["points 长度不符", { grid: [3, 3] as [number, number], points: new Array<number>(17).fill(0) }],
    ["位移超出 [-2, 2]", { grid: [2, 2] as [number, number], points: [2.01, 0, 0, 0, 0, 0, 0, 0] }],
    ["points 含非有限值", { grid: [2, 2] as [number, number], points: [0, Number.NaN, 0, 0, 0, 0, 0, 0] }],
  ])("rejects invalid static attachment warp: %s", (_, warp) => {
    const value = structuredClone(valid);
    value.attachments[0]!.warp = warp;
    expect(validateCharacterBinding(value, skeleton).ok).toBeFalse();
  });
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
