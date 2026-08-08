import { describe, expect, test } from "bun:test";
import { validateFbanimEntryPath, validateFbanimManifest, validateRenderProfile, type CharacterBinding, type Mat4, type RenderProfile } from "../packages/shared/src";
import { animationBakeTimes, assertBakePixelBudget, canvasRegionTransform, sortedBindingSlots } from "../apps/web/src/animationBake";

const profile: RenderProfile = { schemaVersion: 1, kind: "render-profile", id: "profile", name: "Profile", width: 64, height: 64, fps: 4, origin: [10, 20], scale: 2, background: "transparent" };
describe("RenderProfile 与烘焙纯逻辑", () => {
  test("严格校验配置", () => { expect(validateRenderProfile(profile).ok).toBeTrue(); expect(validateRenderProfile({ ...profile, extra: true }).ok).toBeFalse(); expect(validateRenderProfile({ ...profile, width: 0 }).ok).toBeFalse(); });
  test("半开采样不重复终点且零时长一帧", () => { expect(animationBakeTimes(1, 4)).toEqual([0, .25, .5, .75]); expect(animationBakeTimes(0, 4)).toEqual([0]); });
  test("拦截总帧超限", () => expect(() => animationBakeTimes(100, 120)).toThrow());
  test("拦截内存危险的总像素量", () => expect(() => assertBakePixelBudget(4096, 4096, 5)).toThrow());
  test("按 drawOrder 排序", () => { const binding = { slots: [{ drawOrder: 2 }, { drawOrder: -1 }] } as CharacterBinding; expect(sortedBindingSlots(binding).map((slot) => slot.drawOrder)).toEqual([-1, 2]); });
  test("映射原点、Y 翻转且抵消图片倒置", () => { const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 0, 1] as Mat4; expect(canvasRegionTransform(matrix, profile)).toEqual([2, -0, -0, 2, 16, 12]); });
  test("fbanim v1 明确拒绝 profile", () => { const hash = "a".repeat(64); expect(validateFbanimEntryPath(`profiles/${hash}.json`).length).toBeGreaterThan(0); expect(validateFbanimManifest({ format: "framebaker-animation-package", packageVersion: 1, createdBy: { name: "t", version: "1" }, assets: [{ kind: "render-profile", id: "profile", schemaVersion: 1, path: `profiles/${hash}.json`, byteLength: 0, digest: `sha256:${hash}`, dependencies: [] }] }).ok).toBeFalse(); });
});
