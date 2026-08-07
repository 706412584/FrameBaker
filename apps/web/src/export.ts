import { frameImageUrl, materialImageUrl, type Frame } from "./api";
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

/**
 * 导出精灵帧：按 Pixi 相同语义把 offset / scale / rotation / opacity 烘焙进统一尺寸单元格，
 * 每帧单独导出一张 PNG（文件名按 idx 零填充编号），连同 JSON 元数据一起打包成 ZIP 下载。
 * 不会合成成一张精灵图，每帧保持独立。
 */
export async function exportSpritesheet(frames: Frame[], name: string) {
  if (frames.length === 0) return;
  const ordered = [...frames].sort((a, b) => a.idx - b.idx);
  const bitmaps = new Array<ImageBitmap>(ordered.length);
  try {
    await Promise.all(
      ordered.map(async (frame, i) => {
        const response = await fetch(frameImageUrl(frame.id));
        if (!response.ok) throw new Error(`帧图片加载失败: ${frame.id}`);
        bitmaps[i] = await createImageBitmap(await response.blob());
      })
    );

    // 所有帧共享同一个局部原点；统一包围盒保证播放时 offset 与尺寸变化不会抖动
    const bounds = ordered.map((frame, i) => {
      const bitmap = bitmaps[i];
      return transformedFrameBounds(bitmap.width, bitmap.height, frame);
    });
    const minX = Math.floor(Math.min(0, ...bounds.map((b) => b.left)));
    const maxX = Math.ceil(Math.max(0, ...bounds.map((b) => b.right)));
    const minY = Math.floor(Math.min(0, ...bounds.map((b) => b.top)));
    const maxY = Math.ceil(Math.max(0, ...bounds.map((b) => b.bottom)));
    const cellW = Math.max(1, maxX - minX);
    const cellH = Math.max(1, maxY - minY);
    const padLen = String(ordered.length - 1).length + 1;

    const meta = {
      frames: [] as Array<{ file: string; w: number; h: number; duration: number }>,
      meta: {
        cellWidth: cellW,
        cellHeight: cellH,
        originX: -minX,
        originY: -minY,
        count: ordered.length,
        app: "FrameBaker",
      },
    };

    const entries: { name: string; data: Uint8Array }[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const frame = ordered[i];
      const bitmap = bitmaps[i];
      const canvas = document.createElement("canvas");
      canvas.width = cellW;
      canvas.height = cellH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("帧尺寸过大，无法创建导出画布");
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.translate(-minX + frame.offset_x, -minY + frame.offset_y);
      ctx.rotate(frame.rotation);
      ctx.scale(frame.scale, frame.scale);
      ctx.globalAlpha = Math.min(1, Math.max(0, frame.opacity));
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      ctx.restore();

      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas 导出失败"))), "image/png")
      );
      const filename = `${name}_${String(i).padStart(padLen, "0")}.png`;
      entries.push({ name: filename, data: new Uint8Array(await png.arrayBuffer()) });
      meta.frames.push({ file: filename, w: cellW, h: cellH, duration: frame.duration });
    }

    // JSON 元数据
    entries.push({
      name: `${name}.frames.json`,
      data: new TextEncoder().encode(JSON.stringify(meta, null, 2)),
    });

    const zip = await createZip(entries);
    download(zip, `${name}_spritesheet.zip`);
  } finally {
    bitmaps.forEach((bitmap) => bitmap?.close());
  }
}
