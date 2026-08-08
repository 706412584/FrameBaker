import { describe, expect, test } from "bun:test";
import { assetDigest, fixedBakeTimes, pngDimensions, validateRasterDraft } from "../apps/server/src/rasterSequence";

const hash = `sha256:${"0".repeat(64)}` as const;
describe("RasterSequence validator", () => {
  test("固定半开采样", () => expect(fixedBakeTimes(0.21, 10)).toEqual([0, .1, .2]));
  test("读取 PNG IHDR", () => { const p = new Uint8Array(24); p.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]); p.set(new TextEncoder().encode("IHDR"), 12); new DataView(p.buffer).setUint32(16, 32); new DataView(p.buffer).setUint32(20, 48); expect(pngDimensions(p)).toEqual({ width: 32, height: 48 }); });
  test("拒绝不连续帧", () => expect(() => validateRasterDraft({ bakeEngine: "framebaker-canvas2d-v1", source: { skeletonId: "s", motionClipId: "m", characterBindingId: "b", renderProfileId: "p" }, profile: { width: 1, height: 1, fps: 10, origin: [0,0], scale: 1, background: "transparent" }, frames: [{ index: 1, time: 0, pixelDigest: hash, pngDigest: hash }] }, 0)).toThrow());
  test("规范摘要不受对象键顺序影响", async () => expect(await assetDigest({ b: 1, a: 2 })).toBe(await assetDigest({ a: 2, b: 1 })));
});
