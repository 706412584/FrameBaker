// 环境无关的图像纯计算：worker 与主线程降级路径共用

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditPoint {
  x: number;
  y: number;
}

export interface EraseStroke {
  size: number;
  points: EditPoint[];
}

/** worker 消息协议（Blob 走 structured clone，无需手动 transfer） */
export interface ImageOpRequest {
  id: number;
  op: "bounds" | "crop" | "edit";
  blob: Blob;
  rect?: CropRect;
  strokes?: EraseStroke[];
  quarterTurns?: number;
}

export interface ImageOpResponse {
  id: number;
  ok: boolean;
  rect?: CropRect | null;
  blob?: Blob;
  error?: string;
}

/** 扫描 alpha>0 像素的最小包围盒（像素图「裁透明边」）；全透明返回 null */
export function computeOpaqueBounds(data: Uint8ClampedArray, width: number, height: number): CropRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
