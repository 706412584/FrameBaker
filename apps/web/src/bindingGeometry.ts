/**
 * Region 图片先在 SVG 局部空间翻转 Y 轴，再随骨骼进入 Y-up 世界空间。
 * pivot 的 (0, 0) 是图片左下角，(1, 1) 是右上角。
 */
const cleanZero = (value: number) => Object.is(value, -0) ? 0 : value;

export function attachmentLocalBounds(size: [number, number], pivot: [number, number]) {
  const [width, height] = size;
  const [pivotX, pivotY] = pivot;
  return {
    left: cleanZero(-pivotX * width),
    right: cleanZero((1 - pivotX) * width),
    bottom: cleanZero(-pivotY * height),
    top: cleanZero((1 - pivotY) * height),
  };
}

export function attachmentLocalCorners(size: [number, number], pivot: [number, number]) {
  const { left, right, bottom, top } = attachmentLocalBounds(size, pivot);
  return [
    [left, bottom, 0],
    [right, bottom, 0],
    [right, top, 0],
    [left, top, 0],
  ] as const;
}

/** SVG image 在内部 Y 翻转前使用的 y，和 attachmentLocalBounds 必须保持同一语义。 */
export function attachmentSvgImageY(size: [number, number], pivot: [number, number]) {
  return cleanZero(-(1 - pivot[1]) * size[1]);
}

/** 保持当前世界高度，只恢复图片自身宽高比，避免换素材后被强行拉伸。 */
export function fitAttachmentSizeToImage(size: [number, number], pixelWidth: number, pixelHeight: number): [number, number] {
  if (!(pixelWidth > 0) || !(pixelHeight > 0)) throw new Error("图片尺寸无效");
  return [size[1] * pixelWidth / pixelHeight, size[1]];
}
