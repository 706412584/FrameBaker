import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Crop, Grid3x3, Maximize, Minus, Plus, Scan, X } from "lucide-react";
import { cropImage, findOpaqueBounds } from "../imageops/client";
import { notify } from "../notice";
import type { CropRect } from "../imageops/ops";
import { useTheme } from "../theme";
import IconBtn from "./IconBtn";

interface Props {
  image: Blob;
  /** 标题与副标题（如「作用于：抠图后」） */
  title?: string;
  subtitle?: string;
  onConfirm: (blob: Blob) => void | Promise<void>;
  /** 逐张剪裁时提供「跳过本张」 */
  onSkip?: () => void;
  onClose: () => void;
}

type DragMode =
  | { kind: "none" }
  | { kind: "new"; ax: number; ay: number }
  | { kind: "move"; dx: number; dy: number }
  | { kind: "resize"; handle: string }
  | { kind: "pan"; px: number; py: number };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

/** 从 CSS 变量读画布配色（主题切换后重读，不硬编码色值） */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    mask: read("--mask", "rgba(0,0,0,0.6)"),
    accent: read("--accent", "#ffb86c"),
    grid: read("--border", "#3a3f45"),
    border: read("--text-muted", "#8a8f96"),
  };
}

function clampRect(r: CropRect, imgW: number, imgH: number): CropRect {
  let { x, y, w, h } = r;
  w = Math.max(1, Math.min(Math.round(w), imgW));
  h = Math.max(1, Math.min(Math.round(h), imgH));
  x = Math.max(0, Math.min(Math.round(x), imgW - w));
  y = Math.max(0, Math.min(Math.round(y), imgH - h));
  return { x, y, w, h };
}

/** 像素图剪裁工具：整数像素框选 + 缩放/网格/自动透明边，重活（扫描/编码）走 imageops worker */
export default function CropModal({ image, title = "剪裁图片", subtitle, onConfirm, onSkip, onClose }: Props) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragMode>({ kind: "none" });
  const theme = useTheme();
  const colors = useMemo(readColors, [theme]);

  const imgW = bitmap?.width ?? 0;
  const imgH = bitmap?.height ?? 0;

  // ---- 视图变换 ----
  const toImage = useCallback(
    (sx: number, sy: number) => ({ x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom }),
    [pan, zoom]
  );

  const fitView = useCallback(
    (cw: number, ch: number, w: number, h: number) => {
      if (cw === 0 || ch === 0 || w === 0 || h === 0) return;
      const z = Math.max(0.1, Math.min(cw / w, ch / h, 32) * 0.92);
      setZoom(z);
      setPan({ x: (cw - w * z) / 2, y: (ch - h * z) / 2 });
    },
    []
  );

  // ---- 解码 + 默认框选非透明区域（全透明/无通道则整图）----
  useEffect(() => {
    let alive = true;
    let bmp: ImageBitmap | null = null;
    setBitmap(null);
    setRect(null);
    (async () => {
      try {
        const b = await createImageBitmap(image);
        if (!alive) {
          b.close();
          return;
        }
        bmp = b;
        setBitmap(b);
        const wrap = wrapRef.current;
        if (wrap) fitView(wrap.clientWidth, wrap.clientHeight, b.width, b.height);
        let bounds: CropRect | null = null;
        try {
          bounds = await findOpaqueBounds(image);
        } catch {
          // 扫描失败仍可按整图剪裁
        }
        if (alive) setRect(bounds ?? { x: 0, y: 0, w: b.width, h: b.height });
      } catch (e) {
        if (alive) notify(`图片解码失败: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
      bmp?.close();
    };
  }, [image, fitView]);

  // ---- 画布尺寸跟随容器（ResizeObserver），初始适配视图 ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      setCanvasSize((prev) => {
        if (prev.w === 0 && bitmap) fitView(w, h, bitmap.width, bitmap.height);
        return { w, h };
      });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [bitmap, fitView]);

  // ---- 滚轮缩放（锚定光标；原生监听以便 preventDefault）----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rectBox = canvas.getBoundingClientRect();
      const cx = e.clientX - rectBox.left;
      const cy = e.clientY - rectBox.top;
      setZoom((z) => {
        const nz = Math.min(64, Math.max(0.1, z * (e.deltaY < 0 ? 1.25 : 0.8)));
        setPan((p) => ({ x: cx - (cx - p.x) * (nz / z), y: cy - (cy - p.y) * (nz / z) }));
        return nz;
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ---- 绘制 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.w * dpr;
    canvas.height = canvasSize.h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasSize.w, canvasSize.h);
    if (!bitmap) return;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, pan.x, pan.y, imgW * zoom, imgH * zoom);

    // 图像边界
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(pan.x - 0.5, pan.y - 0.5, imgW * zoom + 1, imgH * zoom + 1);

    // 像素网格：zoom ≥ 8 才画（可见线条数量有限）
    if (showGrid && zoom >= 8) {
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = Math.max(0, Math.floor(-pan.x / zoom));
      const x1 = Math.min(imgW, Math.ceil((canvasSize.w - pan.x) / zoom));
      const y0 = Math.max(0, Math.floor(-pan.y / zoom));
      const y1 = Math.min(imgH, Math.ceil((canvasSize.h - pan.y) / zoom));
      for (let x = x0; x <= x1; x++) {
        const sx = Math.round(pan.x + x * zoom) + 0.5;
        ctx.moveTo(sx, pan.y + y0 * zoom);
        ctx.lineTo(sx, pan.y + y1 * zoom);
      }
      for (let y = y0; y <= y1; y++) {
        const sy = Math.round(pan.y + y * zoom) + 0.5;
        ctx.moveTo(pan.x + x0 * zoom, sy);
        ctx.lineTo(pan.x + x1 * zoom, sy);
      }
      ctx.stroke();
    }

    // 剪裁框：外部遮罩 + 高亮边框 + 手柄
    if (rect) {
      const rx = pan.x + rect.x * zoom;
      const ry = pan.y + rect.y * zoom;
      const rw = rect.w * zoom;
      const rh = rect.h * zoom;
      ctx.fillStyle = colors.mask;
      ctx.fillRect(0, 0, canvasSize.w, ry);
      ctx.fillRect(0, ry + rh, canvasSize.w, canvasSize.h - ry - rh);
      ctx.fillRect(0, ry, rx, rh);
      ctx.fillRect(rx + rw, ry, canvasSize.w - rx - rw, rh);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillStyle = colors.accent;
      for (const h of HANDLES) {
        const hx = h.includes("w") ? rx : h.includes("e") ? rx + rw : rx + rw / 2;
        const hy = h.includes("n") ? ry : h.includes("s") ? ry + rh : ry + rh / 2;
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
      }
    }
  }, [bitmap, rect, zoom, pan, showGrid, canvasSize, colors, imgW, imgH]);

  // ---- 指针交互：框内移动 / 八向缩放 / 空白新框 / 中键或 Alt 平移 ----
  const hitHandle = (sx: number, sy: number): string | null => {
    if (!rect) return null;
    const rx = pan.x + rect.x * zoom;
    const ry = pan.y + rect.y * zoom;
    const rw = rect.w * zoom;
    const rh = rect.h * zoom;
    for (const h of HANDLES) {
      const hx = h.includes("w") ? rx : h.includes("e") ? rx + rw : rx + rw / 2;
      const hy = h.includes("n") ? ry : h.includes("s") ? ry + rh : ry + rh / 2;
      if (Math.abs(sx - hx) <= 7 && Math.abs(sy - hy) <= 7) return h;
    }
    return null;
  };

  const insideRect = (sx: number, sy: number): boolean => {
    if (!rect) return false;
    const rx = pan.x + rect.x * zoom;
    const ry = pan.y + rect.y * zoom;
    return sx >= rx && sx <= rx + rect.w * zoom && sy >= ry && sy <= ry + rect.h * zoom;
  };

  const resizeRect = (handle: string, ix: number, iy: number): CropRect | null => {
    if (!rect) return null;
    let { x, y } = rect;
    let x2 = rect.x + rect.w;
    let y2 = rect.y + rect.h;
    if (handle.includes("w")) x = Math.min(Math.round(ix), x2 - 1);
    if (handle.includes("e")) x2 = Math.max(Math.round(ix), x + 1);
    if (handle.includes("n")) y = Math.min(Math.round(iy), y2 - 1);
    if (handle.includes("s")) y2 = Math.max(Math.round(iy), y + 1);
    return clampRect({ x, y, w: x2 - x, h: y2 - y }, imgW, imgH);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.altKey) {
      dragRef.current = { kind: "pan", px: sx, py: sy };
      return;
    }
    if (e.button !== 0 || !bitmap) return;
    const handle = hitHandle(sx, sy);
    if (handle) {
      dragRef.current = { kind: "resize", handle };
      return;
    }
    if (insideRect(sx, sy) && rect) {
      const p = toImage(sx, sy);
      dragRef.current = { kind: "move", dx: p.x - rect.x, dy: p.y - rect.y };
      return;
    }
    const p = toImage(sx, sy);
    dragRef.current = { kind: "new", ax: p.x, ay: p.y };
    setRect(clampRect({ x: p.x, y: p.y, w: 1, h: 1 }, imgW, imgH));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const mode = dragRef.current;
    if (mode.kind === "none") return;
    const box = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;
    if (mode.kind === "pan") {
      setPan((p) => ({ x: p.x + sx - mode.px, y: p.y + sy - mode.py }));
      dragRef.current = { kind: "pan", px: sx, py: sy };
      return;
    }
    const p = toImage(sx, sy);
    if (mode.kind === "new") {
      const x = Math.min(mode.ax, p.x);
      const y = Math.min(mode.ay, p.y);
      setRect(
        clampRect(
          { x: Math.round(x), y: Math.round(y), w: Math.round(Math.abs(p.x - mode.ax)) + 1, h: Math.round(Math.abs(p.y - mode.ay)) + 1 },
          imgW,
          imgH
        )
      );
    } else if (mode.kind === "move" && rect) {
      setRect(clampRect({ ...rect, x: Math.round(p.x - mode.dx), y: Math.round(p.y - mode.dy) }, imgW, imgH));
    } else if (mode.kind === "resize") {
      const r = resizeRect(mode.handle, p.x, p.y);
      if (r) setRect(r);
    }
  };

  const onPointerUp = () => {
    dragRef.current = { kind: "none" };
  };

  // ---- 工具行 ----
  const patchRect = (patch: Partial<CropRect>) => {
    if (!rect) return;
    setRect(clampRect({ ...rect, ...patch }, imgW, imgH));
  };

  const resetBounds = async () => {
    try {
      const bounds = await findOpaqueBounds(image);
      if (bitmap) setRect(bounds ?? { x: 0, y: 0, w: bitmap.width, h: bitmap.height });
    } catch (e) {
      notify(`自动框选失败: ${(e as Error).message}`);
    }
  };

  const fullImage = () => {
    if (bitmap) setRect({ x: 0, y: 0, w: bitmap.width, h: bitmap.height });
  };

  const doConfirm = async () => {
    if (!rect || busy) return;
    setBusy(true);
    try {
      const blob = await cropImage(image, rect);
      await onConfirm(blob);
    } catch (e) {
      notify(`剪裁失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const num = (v: number, onChange: (n: number) => void, max: number) => (
    <input
      className="px-input num"
      type="number"
      min={0}
      max={max}
      value={v}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
    />
  );

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel crop-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>
            {title}
            {subtitle && <span className="crop-sub"> · {subtitle}</span>}
          </h2>
          <IconBtn onClick={onClose} title="关闭">
            <X size={16} />
          </IconBtn>
        </div>

        <div className="crop-stage" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            style={{ width: canvasSize.w, height: canvasSize.h }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </div>

        <div className="crop-toolbar">
          <span className="crop-nums">
            X {num(rect?.x ?? 0, (n) => patchRect({ x: n }), imgW - 1)}Y {num(rect?.y ?? 0, (n) => patchRect({ y: n }), imgH - 1)}宽{" "}
            {num(rect?.w ?? 0, (n) => patchRect({ w: n }), imgW)}高 {num(rect?.h ?? 0, (n) => patchRect({ h: n }), imgH)}
          </span>
          <span className="crop-size">
            图像 {imgW}×{imgH}
          </span>
        </div>

        <div className="crop-toolbar">
          <IconBtn title="缩小" onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}>
            <Minus size={14} />
          </IconBtn>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <IconBtn title="放大" onClick={() => setZoom((z) => Math.min(64, z * 1.25))}>
            <Plus size={14} />
          </IconBtn>
          <IconBtn title="适应窗口" onClick={() => bitmap && fitView(canvasSize.w, canvasSize.h, imgW, imgH)}>
            <Maximize size={14} />
          </IconBtn>
          <IconBtn className={showGrid ? "on" : ""} title="像素网格" onClick={() => setShowGrid((s) => !s)}>
            <Grid3x3 size={14} />
          </IconBtn>
          <span className="tb-sep" />
          <IconBtn title="自动框选非透明区域" onClick={resetBounds}>
            <Scan size={14} />
          </IconBtn>
          <IconBtn title="全图" onClick={fullImage}>
            <Crop size={14} />
          </IconBtn>
          <span className="crop-hint">拖动框选 · 滚轮缩放 · Alt/中键平移</span>
        </div>

        <div className="modal-actions">
          {onSkip && (
            <button type="button" className="px-btn" disabled={busy} onClick={onSkip}>
              跳过本张
            </button>
          )}
          <button type="button" className="px-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={!rect || busy}
            onClick={doConfirm}
          >
            <Crop size={14} /> {busy ? "剪裁中…" : `确认剪裁 ${rect ? `${rect.w}×${rect.h}` : ""}`}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
