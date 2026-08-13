import type { AttackEffect, AttackEffectBrush, AttackEffectPoint, AttackEffectStroke, AttackEffectStyle } from "@framebaker/shared";

export const DEFAULT_ATTACK_COLOR = "#ff8a18";

export function createAttackEffect(): AttackEffect {
  return { strokes: [], offset_x: 0, offset_y: 0, scale: 1, rotation: 0, opacity: 1, style: "flame" };
}

/** 局部特效坐标 → 画布世界坐标。 */
export function attackEffectPoint(effect: AttackEffect, point: Pick<AttackEffectPoint, "x" | "y">) {
  const cos = Math.cos(effect.rotation);
  const sin = Math.sin(effect.rotation);
  const x = point.x * effect.scale;
  const y = point.y * effect.scale;
  return {
    x: effect.offset_x + x * cos - y * sin,
    y: effect.offset_y + x * sin + y * cos,
  };
}

/** 画布世界坐标 → 局部特效坐标，供变换后的图层继续落笔。 */
export function attackEffectLocalPoint(effect: AttackEffect, point: Pick<AttackEffectPoint, "x" | "y">) {
  const x = point.x - effect.offset_x;
  const y = point.y - effect.offset_y;
  const cos = Math.cos(-effect.rotation);
  const sin = Math.sin(-effect.rotation);
  return {
    x: (x * cos - y * sin) / effect.scale,
    y: (x * sin + y * cos) / effect.scale,
  };
}

export interface EffectBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function attackEffectBounds(effect: AttackEffect | null): EffectBounds | null {
  if (!effect || effect.strokes.length === 0) return null;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const stroke of effect.strokes) {
    for (const point of stroke.points) {
      const transformed = attackEffectPoint(effect, point);
      const radius = stroke.size * point.pressure * effect.scale * (effect.style === "ink" ? 0.65 : 1.5);
      left = Math.min(left, transformed.x - radius);
      right = Math.max(right, transformed.x + radius);
      top = Math.min(top, transformed.y - radius);
      bottom = Math.max(bottom, transformed.y + radius);
    }
    const marks = attackTextureMarks(stroke);
    for (const line of marks.lines) {
      for (const point of line.points) {
        const transformed = attackEffectPoint(effect, point);
        const radius = line.width * effect.scale / 2;
        left = Math.min(left, transformed.x - radius);
        right = Math.max(right, transformed.x + radius);
        top = Math.min(top, transformed.y - radius);
        bottom = Math.max(bottom, transformed.y + radius);
      }
    }
    for (const dot of marks.dots) {
      const transformed = attackEffectPoint(effect, dot);
      const radius = dot.radius * effect.scale;
      left = Math.min(left, transformed.x - radius);
      right = Math.max(right, transformed.x + radius);
      top = Math.min(top, transformed.y - radius);
      bottom = Math.max(bottom, transformed.y + radius);
    }
  }
  return Number.isFinite(left) ? { left, right, top, bottom } : null;
}

/**
 * 独立的轻量笔锋：触控笔优先使用硬件压力，鼠标则按移动速度生成稳定的粗细变化。
 * 不保存时间，只把最终压力写入矢量点，保证回放和导出完全一致。
 */
export function brushPressure(
  pointerPressure: number,
  distance: number,
  elapsedMs: number,
  previous = 0.65
): number {
  const target = pointerPressure > 0 && pointerPressure !== 0.5
    ? pointerPressure
    : 1 - Math.min(0.8, distance / Math.max(1, elapsedMs) / 2);
  return Math.min(1, Math.max(0.1, previous * 0.55 + target * 0.45));
}

/** 相邻点太密时不采样，控制每帧 JSON 体积并减少绘制卡顿。 */
export function shouldSamplePoint(previous: AttackEffectPoint | undefined, next: Pick<AttackEffectPoint, "x" | "y">) {
  if (!previous) return true;
  return Math.hypot(next.x - previous.x, next.y - previous.y) >= 1.5;
}

export function drawAttackEffect(ctx: CanvasRenderingContext2D, effect: AttackEffect) {
  ctx.save();
  ctx.translate(effect.offset_x, effect.offset_y);
  ctx.rotate(effect.rotation);
  ctx.scale(effect.scale, effect.scale);
  ctx.globalAlpha *= effect.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const style = effect.style ?? "flame";
  ctx.globalCompositeOperation = style === "ink" ? "source-over" : "lighter";
  for (const stroke of effect.strokes) {
    drawStroke(ctx, stroke, style);
    drawStrokeTexture(ctx, stroke, style);
  }
  ctx.restore();
}

export interface AttackRenderLayer {
  color: string;
  width: number;
  alpha: number;
}

export function attackRenderLayers(style: AttackEffectStyle | undefined, base: string): AttackRenderLayer[] {
  if (style === "ink") return [
    { color: mixColor(base, "#1a1208", 0.45), width: 1.25, alpha: 0.42 },
    { color: base, width: 1, alpha: 0.96 },
  ];
  if (style === "energy") return [
    { color: base, width: 2.8, alpha: 0.12 },
    { color: mixColor(base, "#ffffff", 0.22), width: 1.5, alpha: 0.48 },
    { color: mixColor(base, "#ffffff", 0.72), width: 0.42, alpha: 0.96 },
  ];
  return [
    { color: mixColor(base, "#ff2400", 0.72), width: 3, alpha: 0.14 },
    { color: mixColor(base, "#ff3d00", 0.4), width: 1.75, alpha: 0.38 },
    { color: base, width: 1, alpha: 0.94 },
    { color: mixColor(base, "#fff7c2", 0.78), width: 0.3, alpha: 0.98 },
  ];
}

/** 不同笔刷为纹理留出主体空间；旧数据仍保持标准利刃宽度。 */
export function attackBrushBodyScale(brush: AttackEffectBrush | undefined): number {
  if (brush === "bristle") return 0.76;
  if (brush === "dry") return 0.62;
  if (brush === "spark") return 0.56;
  if (brush === "echo") return 0.74;
  return 1;
}

/** Catmull-Rom 插值把稀疏指针点变成稳定的攻击弧线。 */
export function smoothStrokePoints(stroke: AttackEffectStroke, subdivisions = 8): AttackEffectPoint[] {
  const source = stroke.points;
  if (source.length < 3) return source;
  const result: AttackEffectPoint[] = [];
  for (let i = 0; i < source.length - 1; i++) {
    const p0 = source[Math.max(0, i - 1)]!;
    const p1 = source[i]!;
    const p2 = source[i + 1]!;
    const p3 = source[Math.min(source.length - 1, i + 2)]!;
    for (let j = 0; j < subdivisions; j++) {
      const t = j / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const interpolate = (a: number, b: number, c: number, d: number) =>
        0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      result.push({
        x: interpolate(p0.x, p1.x, p2.x, p3.x),
        y: interpolate(p0.y, p1.y, p2.y, p3.y),
        pressure: interpolate(p0.pressure, p1.pressure, p2.pressure, p3.pressure),
      });
    }
  }
  result.push(source.at(-1)!);
  return result;
}

/** 按落笔方向从宽到窄收锋；用户压感仍会参与每一点的实际粗细。 */
export function attackPointWidth(size: number, point: AttackEffectPoint, index: number, count: number): number {
  if (count <= 1) return size * point.pressure;
  const progress = index / (count - 1);
  const taper = 0.06 + 0.94 * (1 - Math.pow(progress, 1.35));
  return size * Math.max(0.1, point.pressure) * taper;
}

/** 沿平滑中心线生成连续带状多边形，避免变宽线段逐节盖章的锯齿感。 */
export function attackRibbon(stroke: AttackEffectStroke, widthMultiplier: number): AttackEffectPoint[] {
  const points = smoothStrokePoints(stroke, stroke.points.length <= 8 ? 24 : 8);
  if (points.length < 2) return points;
  const left: AttackEffectPoint[] = [];
  const right: AttackEffectPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const before = points[Math.max(0, i - 1)]!;
    const after = points[Math.min(points.length - 1, i + 1)]!;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.max(0.0001, Math.hypot(dx, dy));
    const radius = attackPointWidth(stroke.size, point, i, points.length) * widthMultiplier / 2;
    const ox = -dy / length * radius;
    const oy = dx / length * radius;
    left.push({ x: point.x + ox, y: point.y + oy, pressure: point.pressure });
    right.push({ x: point.x - ox, y: point.y - oy, pressure: point.pressure });
  }
  return [...left, ...right.reverse()];
}

export interface AttackTextureLine {
  points: AttackEffectPoint[];
  width: number;
  alpha: number;
}

export interface AttackTextureDot {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

export interface AttackTextureMarks {
  lines: AttackTextureLine[];
  dots: AttackTextureDot[];
}

function offsetStrokePoints(points: AttackEffectPoint[], amount: number): AttackEffectPoint[] {
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)]!;
    const after = points[Math.min(points.length - 1, index + 1)]!;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.max(0.0001, Math.hypot(dx, dy));
    return { ...point, x: point.x - dy / length * amount, y: point.y + dx / length * amount };
  });
}

/** 确定性纹理标记，保证 Pixi 预览与 Canvas 导出不会随机跳动。 */
export function attackTextureMarks(stroke: AttackEffectStroke): AttackTextureMarks {
  const brush: AttackEffectBrush = stroke.brush ?? "slash";
  const points = smoothStrokePoints(stroke, stroke.points.length <= 8 ? 16 : 6);
  const lines: AttackTextureLine[] = [];
  const dots: AttackTextureDot[] = [];
  if (points.length < 2 || brush === "slash") return { lines, dots };

  if (brush === "bristle") {
    [-0.3, -0.1, 0.14, 0.34].forEach((offset, index) => lines.push({
      points: offsetStrokePoints(points, stroke.size * offset),
      width: Math.max(0.65, stroke.size * (0.035 + index * 0.008)),
      alpha: 0.28 + index * 0.08,
    }));
  } else if (brush === "dry") {
    const span = Math.max(3, Math.floor(points.length / 10));
    for (let start = span; start < points.length - span; start += span * 2) {
      const segment = points.slice(start, Math.min(points.length, start + span));
      lines.push({
        points: offsetStrokePoints(segment, stroke.size * (((start / span) % 4) - 1.5) * 0.13),
        width: Math.max(0.7, stroke.size * 0.075),
        alpha: 0.48,
      });
    }
  } else if (brush === "echo") {
    [-0.72, -1.05].forEach((offset, index) => lines.push({
      points: offsetStrokePoints(points, stroke.size * offset),
      width: Math.max(1, stroke.size * (0.2 - index * 0.045)),
      alpha: 0.24 - index * 0.07,
    }));
  } else if (brush === "spark") {
    const stride = Math.max(4, Math.floor(points.length / 12));
    for (let index = stride; index < points.length; index += stride) {
      const point = points[index]!;
      const before = points[index - 1]!;
      const dx = point.x - before.x;
      const dy = point.y - before.y;
      const length = Math.max(0.0001, Math.hypot(dx, dy));
      const side = index % (stride * 2) === 0 ? 1 : -1;
      const distance = stroke.size * (0.65 + (index % 3) * 0.18);
      dots.push({
        x: point.x - dy / length * distance * side,
        y: point.y + dx / length * distance * side,
        radius: Math.max(0.8, stroke.size * (0.055 + (index % 4) * 0.018)),
        alpha: 0.5 + (index % 3) * 0.13,
      });
    }
  }
  return { lines, dots };
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: AttackEffectStroke, style: AttackEffectStyle) {
  const points = smoothStrokePoints(stroke);
  if (points.length === 0) return;
  const bodyScale = attackBrushBodyScale(stroke.brush);
  for (const layer of attackRenderLayers(style, stroke.color)) {
    ctx.fillStyle = layer.color;
    ctx.globalAlpha *= layer.alpha;
    ctx.shadowColor = layer.color;
    ctx.shadowBlur = style === "ink" ? 0 : stroke.size * layer.width * 0.55;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0]!.x, points[0]!.y, Math.max(0.5, stroke.size * points[0]!.pressure * layer.width * bodyScale / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const ribbon = attackRibbon(stroke, layer.width * bodyScale);
      ctx.beginPath();
      ctx.moveTo(ribbon[0]!.x, ribbon[0]!.y);
      for (let i = 1; i < ribbon.length; i++) ctx.lineTo(ribbon[i]!.x, ribbon[i]!.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha /= layer.alpha;
  }
}

function drawStrokeTexture(ctx: CanvasRenderingContext2D, stroke: AttackEffectStroke, style: AttackEffectStyle) {
  const marks = attackTextureMarks(stroke);
  if (!marks.lines.length && !marks.dots.length) return;
  const color = attackRenderLayers(style, stroke.color).at(-1)!.color;
  for (const line of marks.lines) {
    if (line.points.length < 2) continue;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha *= line.alpha;
    ctx.lineWidth = line.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(line.points[0]!.x, line.points[0]!.y);
    for (let index = 1; index < line.points.length; index++) ctx.lineTo(line.points[index]!.x, line.points[index]!.y);
    ctx.stroke();
    ctx.restore();
  }
  for (const dot of marks.dots) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha *= dot.alpha;
    ctx.shadowColor = color;
    ctx.shadowBlur = style === "ink" ? 0 : dot.radius * 2;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function mixColor(a: string, b: string, amount: number): string {
  const parse = (value: string) => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
  const av = parse(a);
  const bv = parse(b);
  return `#${av.map((value, index) => Math.round(value + (bv[index]! - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}
