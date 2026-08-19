import { buildFbanimV2Entries, type MotionClip, type SkeletalProjectDocument, type Skeleton } from "@framebaker/shared";
import { api, frameImageUrl, materialImageUrl, type Frame, type TimelineResponse } from "./api";
import type { AttackEffectCell } from "./api";
import { attackEffectBounds, drawAttackEffect } from "./attackEffect";
import { transformedFrameRectBounds } from "./frameGeometry";
import { findOpaqueBounds } from "./imageops/client";
import { transformedFrameBounds } from "./frameGeometry";
import { createZip } from "./zip";

function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 文件名安全化：去掉路径非法字符 */
function safeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").trim() || "material";
}

/** 导出可直接接入游戏运行时的骨骼包：骨架、项目角色、动作配置、MotionClip 与 PNG 纹理闭包。 */
export async function exportSkeletalProjectPackage(name: string, document: SkeletalProjectDocument, skeleton: Skeleton): Promise<void> {
  if (!document.character) throw new Error("项目尚未组装角色");
  const actions = await Promise.all(document.animations.map(async (action) => {
    const { asset } = await api.getAnimationAsset(action.motionClipId);
    if (asset.kind !== "motion-clip") throw new Error(`动作「${action.name}」引用的资产无效`);
    return { ...action, motionClip: asset as MotionClip };
  }));
  const textures = await Promise.all(document.character.binding.attachments.map(async (attachment) => {
    const response = await fetch(materialImageUrl(attachment.materialId, undefined, attachment.imageSlot, undefined, true));
    if (!response.ok) throw new Error(`附件「${attachment.name}」纹理读取失败`);
    return { attachmentId: attachment.id, bytes: new Uint8Array(await response.arrayBuffer()) };
  }));
  const entries = await buildFbanimV2Entries({
    createdBy: { name: "FrameBaker", version: "0.1.0" },
    skeleton,
    characterBinding: document.character.binding,
    actions,
    textures,
  });
  download(await createZip(entries.map((entry) => ({ name: entry.path, data: entry.bytes }))), `${safeFilename(name)}.zip`);
}

/** 导出单个素材图片：raw=原图，processed=抠图后（单张直接下载） */
export async function downloadMaterialImage(
  id: string,
  name: string,
  slot: "raw" | "processed",
  v?: number
): Promise<void> {
  const res = await fetch(materialImageUrl(id, v, slot));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const suffix = slot === "processed" ? "_matted" : "_raw";
  download(blob, `${safeFilename(name)}_${id.slice(0, 6)}${suffix}.png`);
}

/** 批量导出：打包成 ZIP 下载；返回成功/跳过/失败计数 */
export async function downloadMaterialImages(
  items: Array<{ id: string; name: string; processed?: boolean }>,
  slot: "raw" | "processed",
  v?: number
): Promise<{ ok: number; skipped: number; failed: number }> {
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const entries: { name: string; data: Uint8Array }[] = [];
  const usedNames = new Set<string>();

  for (const it of items) {
    if (slot === "processed" && !it.processed) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(materialImageUrl(it.id, v, slot));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const suffix = slot === "processed" ? "_matted" : "_raw";
      let filename = `${safeFilename(it.name)}_${it.id.slice(0, 6)}${suffix}.png`;
      // 防止 ZIP 内重名
      if (usedNames.has(filename)) {
        const dot = filename.lastIndexOf(".");
        filename = `${filename.slice(0, dot)}_${it.id.slice(0, 4)}${filename.slice(dot)}`;
      }
      usedNames.add(filename);
      entries.push({ name: filename, data: buf });
      ok++;
    } catch {
      failed++;
    }
  }

  if (entries.length > 0) {
    const zip = await createZip(entries);
    const label = slot === "processed" ? "matted" : "raw";
    download(zip, `materials_${label}.zip`);
  }

  return { ok, skipped, failed };
}

export type AnimationExportFormat = "sequence" | "spritesheet";

export const MAX_SPRITE_SHEET_DIMENSION = 16384;

export interface SpriteSheetLayout {
  columns: number;
  rows: number;
  width: number;
  height: number;
}

/** 在浏览器安全画布尺寸内按播放顺序自动换行，采用行优先布局。 */
export function spriteSheetLayout(cellWidth: number, cellHeight: number, count: number, maxDimension = MAX_SPRITE_SHEET_DIMENSION): SpriteSheetLayout {
  if (cellWidth > maxDimension || cellHeight > maxDimension) {
    throw new Error("单帧尺寸超过精灵图画布上限，请改用 PNG 序列导出");
  }
  const maxColumns = Math.min(count, Math.floor(maxDimension / cellWidth));
  const maxRows = Math.floor(maxDimension / cellHeight);
  const minColumns = Math.max(1, Math.ceil(count / maxRows));
  if (minColumns > maxColumns) {
    throw new Error("帧尺寸与数量超过精灵图画布上限，请改用 PNG 序列导出");
  }
  let columns = minColumns;
  let bestScore = Infinity;
  for (let candidate = minColumns; candidate <= maxColumns; candidate++) {
    const candidateRows = Math.ceil(count / candidate);
    const width = candidate * cellWidth;
    const height = candidateRows * cellHeight;
    const score = Math.max(width, height);
    if (score < bestScore) {
      columns = candidate;
      bestScore = score;
    }
  }
  const rows = Math.max(1, Math.ceil(count / columns));
  const width = columns * cellWidth;
  const height = rows * cellHeight;
  if (height > maxDimension) {
    throw new Error("帧尺寸与数量超过精灵图画布上限，请改用 PNG 序列导出");
  }
  return { columns, rows, width, height };
}

/** 导出 PNG 序列或自动换行的单张精灵图；两者都烘焙图片变换和攻击特效。 */
export async function exportAnimation(timeline: TimelineResponse, name: string, format: AnimationExportFormat) {
  const ordered = [...timeline.steps].sort((a,b)=>a.idx-b.idx);
  const visible = [...timeline.tracks].filter((t)=>t.visible).sort((a,b)=>a.idx-b.idx);
  const frames = timeline.frames.filter((f)=>visible.some((t)=>t.id===f.track_id));
  const effects = timeline.effects.filter((effect)=>visible.some((track)=>track.id===effect.track_id));
  if (ordered.length === 0) return;
  const bitmapMap = new Map<string,ImageBitmap>();
  const opaqueBoundsMap = new Map<string, Awaited<ReturnType<typeof findOpaqueBounds>>>();
  try {
    await Promise.all(
      frames.map(async (frame) => {
        const response = await fetch(frameImageUrl(frame.id));
        if (!response.ok) throw new Error(`帧图片加载失败: ${frame.id}`);
        const blob = await response.blob();
        const [bitmap, opaqueBounds] = await Promise.all([createImageBitmap(blob), findOpaqueBounds(blob)]);
        bitmapMap.set(frame.id, bitmap);
        opaqueBoundsMap.set(frame.id, opaqueBounds);
      })
    );

    // 所有帧共享同一个局部原点；统一包围盒保证播放时 offset 与尺寸变化不会抖动
    const imageBounds = frames.map((frame) => {
      const bitmap = bitmapMap.get(frame.id)!;
      const opaque = opaqueBoundsMap.get(frame.id);
      return opaque ? transformedFrameRectBounds(bitmap.width, bitmap.height, opaque, frame) : null;
    }).filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
    const effectBounds = effects
      .map((cell) => attackEffectBounds(cell.effect))
      .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
    const bounds = [...imageBounds, ...effectBounds];
    const minX = Math.floor(Math.min(0, ...bounds.map((b) => b.left)));
    const maxX = Math.ceil(Math.max(0, ...bounds.map((b) => b.right)));
    const minY = Math.floor(Math.min(0, ...bounds.map((b) => b.top)));
    const maxY = Math.ceil(Math.max(0, ...bounds.map((b) => b.bottom)));
    const cellW = Math.max(1, maxX - minX);
    const cellH = Math.max(1, maxY - minY);
    const padLen = String(ordered.length - 1).length + 1;
    const sheetLayout = format === "spritesheet" ? spriteSheetLayout(cellW, cellH, ordered.length) : null;

    const meta = {
      frames: [] as Array<{ file: string; x: number; y: number; w: number; h: number; duration: number; frameIds: string[]; effectIds: string[] }>,
      meta: {
        axisId: timeline.axis.id,
        axisName: timeline.axis.name,
        fps: timeline.axis.fps,
        cellWidth: cellW,
        cellHeight: cellH,
        originX: -minX,
        originY: -minY,
        count: ordered.length,
        format,
        app: "FrameBaker",
        ...(sheetLayout ? {
          columns: sheetLayout.columns,
          rows: sheetLayout.rows,
          imageWidth: sheetLayout.width,
          imageHeight: sheetLayout.height,
        } : {}),
      },
    };

    const entries: { name: string; data: Uint8Array }[] = [];
    const sheet = format === "spritesheet" ? document.createElement("canvas") : null;
    if (sheet && sheetLayout) {
      sheet.width = sheetLayout.width;
      sheet.height = sheetLayout.height;
    }
    const sheetCtx = sheet?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (sheet && !sheetCtx) throw new Error("帧尺寸过大，无法创建精灵图画布");
    if (sheetCtx) sheetCtx.imageSmoothingEnabled = false;

    for (let i = 0; i < ordered.length; i++) {
      const step = ordered[i];
      // 始终先在单格小画布完成合成，再贴到大图；避免大型 GPU 画布在编码时丢失中间纹理块。
      const canvas = document.createElement("canvas");
      canvas.width = cellW;
      canvas.height = cellH;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("帧尺寸过大，无法创建导出画布");
      ctx.imageSmoothingEnabled = false;
      const contributors = visible.map((track)=>frames.find((f)=>f.track_id===track.id&&f.step_id===step.id)).filter((f):f is Frame=>!!f);
      const effectContributors = visible.map((track)=>effects.find((cell)=>cell.track_id===track.id&&cell.step_id===step.id)).filter((cell):cell is AttackEffectCell=>!!cell);
      const cellX = sheet && sheetLayout ? (i % sheetLayout.columns) * cellW : 0;
      const cellY = sheet && sheetLayout ? Math.floor(i / sheetLayout.columns) * cellH : 0;
      for(const frame of contributors){const bitmap=bitmapMap.get(frame.id)!;ctx.save();ctx.translate(-minX+frame.offset_x,-minY+frame.offset_y);ctx.rotate(frame.rotation);ctx.scale(frame.scale,frame.scale);ctx.globalAlpha=Math.min(1,Math.max(0,frame.opacity));ctx.globalCompositeOperation="source-over";ctx.drawImage(bitmap,-bitmap.width/2,-bitmap.height/2);ctx.restore();}
      for(const cell of effectContributors){ctx.save();ctx.translate(-minX,-minY);drawAttackEffect(ctx,cell.effect);ctx.restore();}

      const filename = `${name}_${String(i).padStart(padLen, "0")}.png`;
      if (sheet && sheetCtx) {
        sheetCtx.drawImage(canvas, cellX, cellY);
      } else {
        const png = await canvasBlob(canvas);
        entries.push({ name: filename, data: new Uint8Array(await png.arrayBuffer()) });
      }
      meta.frames.push({ file: sheet ? `${name}.png` : filename, x: cellX, y: cellY, w: cellW, h: cellH, duration: step.duration, frameIds: contributors.map((f)=>f.id), effectIds: effectContributors.map((cell)=>cell.id) });
    }

    if (sheet) {
      const png = await canvasBlob(sheet);
      entries.push({ name: `${name}.png`, data: new Uint8Array(await png.arrayBuffer()) });
    }

    // JSON 元数据
    entries.push({
      name: `${name}.frames.json`,
      data: new TextEncoder().encode(JSON.stringify(meta, null, 2)),
    });

    const zip = await createZip(entries);
    download(zip, `${name}_${format}.zip`);
  } finally {
    bitmapMap.forEach((bitmap) => bitmap.close());
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("canvas 导出失败")), "image/png")
  );
}
