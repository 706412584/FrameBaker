import { describe, expect, test } from "bun:test";
import { validateCharacterBinding, validateFbanimEntryPath, validateFbanimManifest, type CharacterBinding, type Skeleton } from "../packages/shared/src";

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
});
