// 图像处理客户端：优先 Web Worker（OffscreenCanvas），不可用/出错时降级主线程 canvas
import { computeImageAnalysis, computeOpaqueBounds, type CropRect, type ImageAnalysis, type ImageOpRequest, type ImageOpResponse } from "./ops";

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: ImageOpResponse) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    // 同源绝对路径：服务端按需 Bun.build 下发（Bun HTML 打包不处理 new Worker(new URL(...))）
    const w = new Worker("/imageops/imageOps.worker.js", { type: "module" });
    const markBroken = () => {
      // 脚本/运行/消息解码错误：拒掉全部待处理请求，后续走主线程降级
      workerBroken = true;
      worker = null;
      w.terminate();
      for (const p of pending.values()) p.reject(new Error("图像 worker 不可用"));
      pending.clear();
    };
    w.onmessage = (e: MessageEvent<ImageOpResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      p.resolve(e.data);
    };
    w.onerror = markBroken;
    w.onmessageerror = markBroken;
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

function runInWorker(req: Omit<ImageOpRequest, "id">): Promise<ImageOpResponse> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("图像 worker 不可用"));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ ...req, id });
  });
}

// ---- 主线程降级实现（同一套纯函数，canvas 元素代替 OffscreenCanvas）----

async function mainBounds(blob: Blob): Promise<CropRect | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return computeOpaqueBounds(imageData.data, imageData.width, imageData.height);
  } finally {
    bitmap.close();
  }
}

async function mainCrop(blob: Blob, rect: CropRect): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = rect.w;
    canvas.height = rect.h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))), "image/png")
    );
  } finally {
    bitmap.close();
  }
}

async function mainAnalyze(blob: Blob): Promise<ImageAnalysis> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return computeImageAnalysis(imageData.data, imageData.width, imageData.height);
  } finally {
    bitmap.close();
  }
}

/** 透明像素包围盒；全透明返回 null。worker 失败自动降级主线程 */
export async function findOpaqueBounds(blob: Blob): Promise<CropRect | null> {
  try {
    const r = await runInWorker({ op: "bounds", blob });
    if (!r.ok) throw new Error(r.error ?? "bounds 失败");
    return r.rect ?? null;
  } catch {
    return mainBounds(blob);
  }
}

/** 按整数像素矩形剪裁并编码 PNG；worker 失败自动降级主线程 */
export async function cropImage(blob: Blob, rect: CropRect): Promise<Blob> {
  try {
    const r = await runInWorker({ op: "crop", blob, rect });
    if (!r.ok || !r.blob) throw new Error(r.error ?? "crop 失败");
    return r.blob;
  } catch {
    return mainCrop(blob, rect);
  }
}

/** 提取分件质量特征；worker 失败自动降级主线程。 */
export async function analyzeImage(blob: Blob): Promise<ImageAnalysis> {
  try {
    const r = await runInWorker({ op: "analyze", blob });
    if (!r.ok || !r.analysis) throw new Error(r.error ?? "analyze 失败");
    return r.analysis;
  } catch {
    return mainAnalyze(blob);
  }
}
