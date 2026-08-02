import { useEffect, useRef, useState } from "react";
import { Application, Assets, Container, Graphics, Sprite, Texture, type FederatedPointerEvent } from "pixi.js";
import { frameImageUrl, type Frame, type FramePatch } from "../api";
import { canvasColors, useTheme } from "../theme";

interface Props {
  frame: Frame | null;
  prev: Frame | null;
  next: Frame | null;
  v: number;
  /** 受控缩放（工具栏在 Editor 层，25%–400%） */
  zoom: number;
  /** 受控洋葱皮开关 */
  onion: boolean;
  /** 受控网格开关 */
  showGrid: boolean;
  onPatch: (id: string, patch: FramePatch) => void;
  /** 点击画布空白处（未命中当前帧精灵）时触发，用于清空多选 */
  onCanvasBlank: () => void;
}

interface PixiCtx {
  app: Application;
  viewport: Container;
  grid: Graphics;
  main: Sprite;
  prevS: Sprite;
  nextS: Sprite;
}

/** PixiJS 帧画布：拖拽改 offset、洋葱皮、网格、受控缩放（工具栏见 CanvasToolbar） */
export default function FrameEditor({ frame, prev, next, v, zoom, onion, showGrid, onPatch, onCanvasBlank }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pixi = useRef<PixiCtx | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useTheme();

  // 供 Pixi 事件回调读取最新值
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;
  const onPatchRef = useRef(onPatch);
  onPatchRef.current = onPatch;
  const onionRef = useRef(onion);
  onionRef.current = onion;
  const onCanvasBlankRef = useRef(onCanvasBlank);
  onCanvasBlankRef.current = onCanvasBlank;

  // ---- 初始化 Pixi（处理卸载竞态）----
  useEffect(() => {
    let cancelled = false;
    const wrap = wrapRef.current!;
    const app = new Application();

    (async () => {
      await app.init({ background: canvasColors().bg, resizeTo: wrap, antialias: false });
      if (cancelled) {
        app.destroy(true);
        return;
      }
      wrap.appendChild(app.canvas);

      const viewport = new Container();
      app.stage.addChild(viewport);
      const grid = new Graphics();
      const prevS = new Sprite();
      const nextS = new Sprite();
      const main = new Sprite();
      for (const s of [prevS, nextS, main]) {
        s.anchor.set(0.5);
        s.visible = false;
      }
      prevS.tint = 0xff4444;
      prevS.alpha = 0.3; // 洋葱皮：前一帧红色
      nextS.tint = 0x4488ff;
      nextS.alpha = 0.2; // 洋葱皮：后一帧蓝色
      prevS.eventMode = "none";
      nextS.eventMode = "none";
      viewport.addChild(grid, prevS, nextS, main);

      // viewport 居中，并随 resize 保持（resizeTo 由 ResizeObserver 驱动，布局分隔条拖动也会触发）
      const center = () => {
        viewport.position.set(app.screen.width / 2, app.screen.height / 2);
        app.stage.hitArea = app.screen;
      };
      app.renderer.on("resize", center);
      app.stage.eventMode = "static";
      center();

      // 当前帧拖拽 → 松手 PATCH offset
      let drag: { startX: number; startY: number; baseX: number; baseY: number } | null = null;
      main.eventMode = "static";
      main.cursor = "grab";
      main.on("pointerdown", (e: FederatedPointerEvent) => {
        const p = viewport.toLocal(e.global);
        drag = { startX: p.x, startY: p.y, baseX: main.x, baseY: main.y };
        main.cursor = "grabbing";
      });
      // 点击画布空白（未命中当前帧精灵）→ 清空多选
      app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
        if (e.target !== main) onCanvasBlankRef.current();
      });
      app.stage.on("pointermove", (e: FederatedPointerEvent) => {
        if (!drag) return;
        const p = viewport.toLocal(e.global);
        main.position.set(drag.baseX + (p.x - drag.startX), drag.baseY + (p.y - drag.startY));
      });
      const endDrag = () => {
        if (!drag) return;
        drag = null;
        main.cursor = "grab";
        const f = frameRef.current;
        if (f) {
          onPatchRef.current(f.id, {
            offset_x: Math.round(main.x * 100) / 100,
            offset_y: Math.round(main.y * 100) / 100,
          });
        }
      };
      app.stage.on("pointerup", endDrag);
      app.stage.on("pointerupoutside", endDrag);

      pixi.current = { app, viewport, grid, main, prevS, nextS };
      setReady(true);
    })().catch((e) => console.error("Pixi 初始化失败:", e));

    return () => {
      cancelled = true;
      if (pixi.current) {
        pixi.current.app.destroy(true, { children: true });
        pixi.current = null;
      }
      setReady(false);
    };
  }, []);

  // ---- 加载/切换帧贴图 ----
  useEffect(() => {
    const p = pixi.current;
    if (!p || !ready) return;
    let dead = false;

    const applyTransform = (sprite: Sprite, f: Frame, isMain: boolean) => {
      sprite.position.set(f.offset_x, f.offset_y);
      sprite.scale.set(f.scale);
      sprite.rotation = f.rotation;
      if (isMain) sprite.alpha = f.opacity;
    };

    const loadInto = async (sprite: Sprite, f: Frame | null, isMain: boolean) => {
      if (!f) {
        sprite.visible = false;
        return;
      }
      try {
        const tex: Texture = await Assets.load(frameImageUrl(f.id, v));
        if (dead) return;
        tex.source.scaleMode = "nearest"; // 像素风：最近邻缩放
        sprite.texture = tex;
        applyTransform(sprite, f, isMain);
        sprite.visible = isMain ? true : onionRef.current;
      } catch {
        sprite.visible = false;
      }
    };

    loadInto(p.main, frame, true);
    loadInto(p.prevS, prev, false);
    loadInto(p.nextS, next, false);
    return () => {
      dead = true;
    };
  }, [frame, prev, next, v, ready]);

  // ---- 帧属性变化时同步主精灵变换（拖拽中 frame 不变，不干扰）----
  useEffect(() => {
    const p = pixi.current;
    if (!p || !frame || p.main.texture === Texture.EMPTY) return;
    p.main.position.set(frame.offset_x, frame.offset_y);
    p.main.scale.set(frame.scale);
    p.main.rotation = frame.rotation;
    p.main.alpha = frame.opacity;
  }, [frame, ready]);

  // ---- 洋葱皮开关（受控 prop）----
  useEffect(() => {
    const p = pixi.current;
    if (!p) return;
    p.prevS.visible = onion && prev != null && p.prevS.texture !== Texture.EMPTY;
    p.nextS.visible = onion && next != null && p.nextS.texture !== Texture.EMPTY;
  }, [onion, prev, next, ready]);

  // ---- 缩放（受控 prop）----
  useEffect(() => {
    pixi.current?.viewport.scale.set(zoom);
  }, [zoom, ready]);

  // ---- 主题切换：画布背景跟随 CSS 变量 ----
  useEffect(() => {
    const p = pixi.current;
    if (!p) return;
    p.app.renderer.background.color = canvasColors().bg;
  }, [theme, ready]);

  // ---- 网格（颜色同样随主题；受控 prop）----
  useEffect(() => {
    const p = pixi.current;
    if (!p) return;
    const g = p.grid;
    g.clear();
    if (!showGrid) return;
    const colors = canvasColors();
    const step = 32;
    const half = 640;
    for (let x = -half; x <= half; x += step) g.moveTo(x, -half).lineTo(x, half);
    for (let y = -half; y <= half; y += step) g.moveTo(-half, y).lineTo(half, y);
    g.stroke({ color: colors.grid, width: 1, alpha: 0.35 });
    // 中心十字
    g.moveTo(-half, 0).lineTo(half, 0).moveTo(0, -half).lineTo(0, half);
    g.stroke({ color: colors.cross, width: 1, alpha: 0.7 });
  }, [showGrid, ready, theme]);

  return (
    <div className="pixi-wrap" ref={wrapRef}>
      {!frame && <div className="canvas-empty">暂无帧，点击右上角「导入素材」开始</div>}
    </div>
  );
}
