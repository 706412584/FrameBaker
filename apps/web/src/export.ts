import { frameImageUrl, type Frame } from "./api";

function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * 导出精灵表：按 Pixi 相同语义把 offset / scale / rotation / opacity 烘焙进统一尺寸单元格，
 * 再按 idx 顺序网格排列并下载 spritesheet.png + spritesheet.json。
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
      const scale = Math.abs(frame.scale);
      const cos = Math.abs(Math.cos(frame.rotation));
      const sin = Math.abs(Math.sin(frame.rotation));
      const halfW = (bitmap.width * scale * cos + bitmap.height * scale * sin) / 2;
      const halfH = (bitmap.width * scale * sin + bitmap.height * scale * cos) / 2;
      return {
        left: frame.offset_x - halfW,
        right: frame.offset_x + halfW,
        top: frame.offset_y - halfH,
        bottom: frame.offset_y + halfH,
      };
    });
    const minX = Math.floor(Math.min(0, ...bounds.map((b) => b.left)));
    const maxX = Math.ceil(Math.max(0, ...bounds.map((b) => b.right)));
    const minY = Math.floor(Math.min(0, ...bounds.map((b) => b.top)));
    const maxY = Math.ceil(Math.max(0, ...bounds.map((b) => b.bottom)));
    const cellW = Math.max(1, maxX - minX);
    const cellH = Math.max(1, maxY - minY);
    const cols = Math.ceil(Math.sqrt(ordered.length));
    const rows = Math.ceil(ordered.length / cols);

    const canvas = document.createElement("canvas");
    canvas.width = cols * cellW;
    canvas.height = rows * cellH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("精灵表尺寸过大，无法创建导出画布");
    ctx.imageSmoothingEnabled = false;

    const meta = {
      frames: [] as Array<{ x: number; y: number; w: number; h: number; duration: number }>,
      meta: {
        cellWidth: cellW,
        cellHeight: cellH,
        originX: -minX,
        originY: -minY,
        cols,
        rows,
        count: ordered.length,
        app: "FrameBaker",
      },
    };
    bitmaps.forEach((bitmap, i) => {
      const frame = ordered[i];
      const x = (i % cols) * cellW;
      const y = Math.floor(i / cols) * cellH;
      ctx.save();
      ctx.translate(x - minX + frame.offset_x, y - minY + frame.offset_y);
      ctx.rotate(frame.rotation);
      ctx.scale(frame.scale, frame.scale);
      ctx.globalAlpha = Math.min(1, Math.max(0, frame.opacity));
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      ctx.restore();
      meta.frames.push({ x, y, w: cellW, h: cellH, duration: frame.duration });
    });

    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas 导出失败"))), "image/png")
    );
    download(png, `${name}.spritesheet.png`);
    download(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), `${name}.spritesheet.json`);
  } finally {
    bitmaps.forEach((bitmap) => bitmap?.close());
  }
}
