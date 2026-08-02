import { frameImageUrl, type Frame } from "./api";

function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * 导出精灵表：按 idx 顺序拉取全部帧图，canvas 网格排列，
 * 下载 spritesheet.png + spritesheet.json
 */
export async function exportSpritesheet(frames: Frame[], name: string) {
  if (frames.length === 0) return;
  const ordered = [...frames].sort((a, b) => a.idx - b.idx);
  const bitmaps = await Promise.all(
    ordered.map((f) =>
      fetch(frameImageUrl(f.id))
        .then((r) => {
          if (!r.ok) throw new Error(`帧图片加载失败: ${f.id}`);
          return r.blob();
        })
        .then((b) => createImageBitmap(b))
    )
  );

  const cellW = Math.max(1, ...bitmaps.map((b) => b.width));
  const cellH = Math.max(1, ...bitmaps.map((b) => b.height));
  const cols = Math.ceil(Math.sqrt(ordered.length));
  const rows = Math.ceil(ordered.length / cols);

  const canvas = document.createElement("canvas");
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const meta = {
    frames: [] as Array<{ x: number; y: number; w: number; h: number; duration: number }>,
    meta: { cellWidth: cellW, cellHeight: cellH, cols, rows, count: ordered.length, app: "FrameBaker" },
  };
  bitmaps.forEach((bmp, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    ctx.drawImage(bmp, x, y);
    meta.frames.push({ x, y, w: bmp.width, h: bmp.height, duration: ordered[i].duration });
    bmp.close();
  });

  const png = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas 导出失败"))), "image/png")
  );
  download(png, `${name}.spritesheet.png`);
  download(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), `${name}.spritesheet.json`);
}
