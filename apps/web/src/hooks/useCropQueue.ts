import { useState } from "react";

export interface CroppableItem {
  file: File;
  cropped?: boolean;
}

/** 视频/动图不参与剪裁（仅静态图） */
export function isVideoFile(f: File): boolean {
  const ext = f.name.split(".").pop()?.toLowerCase();
  return ext === "gif" || ext === "mp4" || ext === "mov" || ext === "webm";
}

/**
 * 导入弹窗共用的「逐张剪裁」队列：
 * startAll 把所有静态图排入队列依次弹 CropModal；startOne 单张重裁；
 * confirm 用剪裁产物（PNG blob）替换原文件并标记 cropped
 */
export function useCropQueue<T extends CroppableItem>(
  items: T[],
  replaceItem: (index: number, file: File) => void
) {
  const [queue, setQueue] = useState<number[]>([]);

  const cropIndex = queue.length > 0 ? queue[0] : null;
  /** 队列进度（逐张模式提示用）：total=0 表示单张重裁 */
  const total = queue.length;

  const imageIndices = () => items.map((it, i) => (isVideoFile(it.file) ? -1 : i)).filter((i) => i >= 0);

  const startAll = () => setQueue(imageIndices());
  const startOne = (i: number) => setQueue([i]);
  const cancel = () => setQueue([]);
  /** 跳过当前张，继续下一张 */
  const skip = () => setQueue((q) => q.slice(1));

  /** 剪裁确认：替换文件 → 下一张 */
  const confirm = (blob: Blob) => {
    if (cropIndex == null) return;
    const orig = items[cropIndex].file;
    const pngName = orig.name.replace(/\.\w+$/, "") + ".png";
    replaceItem(cropIndex, new File([blob], pngName, { type: "image/png" }));
    setQueue((q) => q.slice(1));
  };

  return { cropIndex, total, startAll, startOne, confirm, skip, cancel };
}
