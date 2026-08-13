import { useEffect, useRef } from "react";
import type { AttackEffectBrush, AttackEffectStyle } from "@framebaker/shared";
import { drawAttackEffect } from "../attackEffect";

interface Props {
  color: string;
  size: number;
  style: AttackEffectStyle;
  brush: AttackEffectBrush;
}

/** 与画布/导出共用渲染器的紧凑笔锋预览：左上宽起势，右下窄收锋。 */
export default function AttackEffectPreview({ color, size, style, brush }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = 92;
    const height = 30;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, width / 2 * ratio, height / 2 * ratio);
    ctx.clearRect(-width / 2, -height / 2, width, height);
    const previewSize = 3 + Math.sqrt(size / 256) * 15;
    drawAttackEffect(ctx, {
      strokes: [{
        color,
        size: previewSize,
        brush,
        points: [
          { x: -37, y: -7, pressure: 1 },
          { x: -12, y: -4, pressure: 1 },
          { x: 13, y: 2, pressure: 1 },
          { x: 37, y: 7, pressure: 1 },
        ],
      }],
      offset_x: 0,
      offset_y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      style,
    });
  }, [brush, color, size, style]);

  return <canvas ref={ref} className="attack-preview" aria-hidden="true" />;
}
