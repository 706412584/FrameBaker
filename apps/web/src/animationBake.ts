import { MAX_BAKED_RASTER_FRAMES, MAX_BAKED_RASTER_PIXELS, multiplyMatrices, sampleMotionClip, transformToMatrix, type BakedRasterDraftManifest, type CharacterBinding, type Mat4, type MotionClip, type RegionAttachment, type RenderProfile, type Skeleton } from "@framebaker/shared";
import { createZip } from "./zip";

export type BakedRasterFrame = BakedRasterDraftManifest["frames"][number] & { png: Uint8Array };
export interface BakedRasterDraft extends Omit<BakedRasterDraftManifest, "frames"> { frames: BakedRasterFrame[] }
export type AttachmentImageResolver = (attachment: RegionAttachment) => string | Promise<string>;

/** 固定半开区间采样；零时长仍产生一帧。 */
export function animationBakeTimes(duration: number, fps: number): number[] {
  if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(fps) || fps <= 0) throw new Error("烘焙时长或 FPS 无效");
  const count = duration === 0 ? 1 : Math.ceil(duration * fps);
  if (count > MAX_BAKED_RASTER_FRAMES) throw new Error(`烘焙帧数超过上限 ${MAX_BAKED_RASTER_FRAMES}`);
  return Array.from({ length: count }, (_, index) => index / fps);
}

export function sortedBindingSlots(binding: CharacterBinding) {
  return [...binding.slots].sort((a, b) => a.drawOrder - b.drawOrder);
}

export function assertBakePixelBudget(width: number, height: number, frameCount: number): void {
  if (width * height * frameCount > MAX_BAKED_RASTER_PIXELS) throw new Error(`烘焙总像素超过上限 ${MAX_BAKED_RASTER_PIXELS}`);
}

/** 把项目动作的速度与有限重复次数烘进临时 clip；项目的无限 loop 不进入兼容逐帧输出。 */
export function configuredMotionClipForRaster(clip: MotionClip, speed: number, repeat: number): MotionClip {
  const safeSpeed = Math.min(8, Math.max(0.1, speed));
  const safeRepeat = Math.min(100, Math.max(1, Math.round(repeat)));
  const cycleDuration = clip.duration / safeSpeed;
  return {
    ...clip,
    duration: cycleDuration * safeRepeat,
    loop: false,
    tracks: clip.tracks.map((track) => ({
      ...track,
      keyframes: Array.from({ length: safeRepeat }, (_, cycle) => track.keyframes.map((keyframe) => ({
        ...keyframe,
        time: cycle * cycleDuration + keyframe.time / safeSpeed,
      }))).flat(),
    })) as MotionClip["tracks"],
    events: Array.from({ length: safeRepeat }, (_, cycle) => clip.events.map((event) => ({
      ...event,
      time: cycle * cycleDuration + event.time / safeSpeed,
    }))).flat(),
  };
}

/** Canvas Y-down × 骨架 Y-up × 图片本地 Y 翻转，保证源图片保持正向。 */
export function canvasRegionTransform(world: Mat4, profile: RenderProfile): [number, number, number, number, number, number] {
  const s = profile.scale;
  return [s * world[0], -s * world[1], -s * world[4], s * world[5], profile.origin[0] + s * world[12], profile.origin[1] - s * world[13]];
}

async function sha256(data: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function bakeAnimationPngSequence(input: { skeleton: Skeleton; clip: MotionClip; binding: CharacterBinding; profile: RenderProfile; resolveImage: AttachmentImageResolver; onProgress?: (done: number, total: number) => void }): Promise<BakedRasterDraft> {
  const { skeleton, clip, binding, profile } = input;
  if (clip.skeletonId !== skeleton.id || binding.skeletonId !== skeleton.id) throw new Error("动作、角色绑定与骨架不匹配");
  const times = animationBakeTimes(clip.duration, profile.fps);
  assertBakePixelBudget(profile.width, profile.height, times.length);
  const images = new Map<string, ImageBitmap>();
  const imageResults = await Promise.allSettled(binding.attachments.map(async (attachment) => {
      const response = await fetch(await input.resolveImage(attachment));
      if (!response.ok) throw new Error(`素材图片加载失败：${attachment.name}`);
      images.set(attachment.id, await createImageBitmap(await response.blob()));
  }));
  const imageFailure = imageResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (imageFailure) {
    for (const image of images.values()) image.close();
    throw imageFailure.reason;
  }
  const canvas = document.createElement("canvas"); canvas.width = profile.width; canvas.height = profile.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    for (const image of images.values()) image.close();
    throw new Error("浏览器不支持 Canvas2D");
  }
  const frames: BakedRasterFrame[] = [];
  try {
    for (const [index, time] of times.entries()) {
      context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height);
      const pose = sampleMotionClip(clip, skeleton, time);
      for (const slot of sortedBindingSlots(binding)) {
        const attachment = binding.attachments.find((item) => item.id === slot.attachmentId), bone = pose.worldMatrices[slot.boneId];
        if (!attachment || !bone) continue;
        const image = images.get(attachment.id); if (!image) continue;
        const transform = canvasRegionTransform(multiplyMatrices(bone, transformToMatrix(attachment.rest)), profile);
        context.setTransform(...transform);
        context.drawImage(image, -attachment.pivot[0] * attachment.size[0], -(1 - attachment.pivot[1]) * attachment.size[1], attachment.size[0], attachment.size[1]);
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      const rgba = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 编码失败")), "image/png"));
      const png = new Uint8Array(await blob.arrayBuffer());
      frames.push({ index, time, pixelDigest: await sha256(rgba), pngDigest: await sha256(png), png });
      input.onProgress?.(index + 1, times.length);
    }
  } finally { for (const image of images.values()) image.close(); }
  return { bakeEngine: "framebaker-canvas2d-v1", source: { skeletonId: skeleton.id, motionClipId: clip.id, characterBindingId: binding.id, renderProfileId: profile.id }, profile: { width: profile.width, height: profile.height, fps: profile.fps, origin: [...profile.origin], scale: profile.scale, background: profile.background }, frames };
}

export async function bakedRasterZip(draft: BakedRasterDraft): Promise<Blob> {
  const digits = Math.max(4, String(draft.frames.length - 1).length);
  const manifest = { ...draft, frames: draft.frames.map(({ png: _, ...frame }) => frame) };
  return createZip([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }, ...draft.frames.map((frame) => ({ name: `frames/${String(frame.index).padStart(digits, "0")}.png`, data: frame.png }))]);
}
