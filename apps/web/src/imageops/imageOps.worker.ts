// 图像处理 worker：解码 / 透明边扫描 / 剪裁编码都在 worker 线程，避免阻塞 UI
// 注：工程 lib 只有 DOM（无 webworker），这里用模块级 declare 收窄 postMessage 签名
import { computeOpaqueBounds, type ImageOpRequest, type ImageOpResponse } from "./ops";

declare function postMessage(message: ImageOpResponse): void;

function boundsFromBitmap(bitmap: ImageBitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return computeOpaqueBounds(imageData.data, imageData.width, imageData.height);
}

async function cropFromBitmap(bitmap: ImageBitmap, rect: { x: number; y: number; w: number; h: number }) {
  const canvas = new OffscreenCanvas(rect.w, rect.h);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return canvas.convertToBlob({ type: "image/png" });
}

self.onmessage = async (e: MessageEvent<ImageOpRequest>) => {
  const { id, op, blob, rect } = e.data;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    if (op === "bounds") {
      const bounds = boundsFromBitmap(bitmap);
      postMessage({ id, ok: true, rect: bounds });
    } else {
      if (!rect) throw new Error("crop 缺少 rect");
      const out = await cropFromBitmap(bitmap, rect);
      postMessage({ id, ok: true, blob: out });
    }
  } catch (err) {
    postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    bitmap?.close();
  }
};
