import { MAX_BAKED_RASTER_FRAMES, MAX_BAKED_RASTER_PIXELS, canonicalizeJson, sha256Digest, type BakedRasterDraftManifest } from "@framebaker/shared";

const HASH = /^sha256:[0-9a-f]{64}$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function fixedBakeTimes(duration: number, fps: number): number[] {
  if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(fps) || fps <= 0) throw new Error("烘焙时长或 FPS 无效");
  const count = duration === 0 ? 1 : Math.ceil(duration * fps);
  if (count > MAX_BAKED_RASTER_FRAMES) throw new Error("烘焙帧数超过上限");
  return Array.from({ length: count }, (_, i) => i / fps);
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || !PNG.every((v, i) => bytes[i] === v) || new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR") throw new Error("帧不是有效 PNG/IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height) throw new Error("PNG 尺寸无效");
  return { width, height };
}

export function validateRasterDraft(manifest: BakedRasterDraftManifest, duration: number): void {
  if (!manifest || manifest.bakeEngine !== "framebaker-canvas2d-v1") throw new Error("不支持的烘焙引擎");
  const p = manifest.profile;
  if (!p || !Array.isArray(p.origin) || p.origin.length !== 2 || ![p.width, p.height, p.fps, p.origin[0], p.origin[1], p.scale].every(Number.isFinite) || !Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 1 || p.width > 4096 || p.height < 1 || p.height > 4096 || p.fps < 1 || p.fps > 120 || p.scale <= 0 || p.background !== "transparent") throw new Error("profile 快照无效");
  if (!Array.isArray(manifest.frames)) throw new Error("帧清单无效");
  const expected = fixedBakeTimes(duration, p.fps);
  if (manifest.frames.length !== expected.length || p.width * p.height * expected.length > MAX_BAKED_RASTER_PIXELS) throw new Error("帧数或像素预算无效");
  manifest.frames.forEach((frame, i) => {
    if (frame.index !== i || frame.time !== expected[i] || !HASH.test(frame.pixelDigest) || !HASH.test(frame.pngDigest)) throw new Error(`第 ${i} 帧清单无效`);
  });
}

export async function assetDigest(value: unknown) {
  return sha256Digest(canonicalizeJson(value as never));
}
