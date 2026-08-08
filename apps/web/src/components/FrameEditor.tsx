import { useCallback, useEffect, useRef, useState } from "react";
import type * as Pixi from "pixi.js";
import { frameImageUrl, type Frame, type FramePatch } from "../api";
import { fitScaleForBounds, transformedFrameBounds } from "../frameGeometry";
import { useT } from "../i18n";
import { canvasColors, useTheme } from "../theme";

const { Application, Assets, Container, Graphics, Sprite, Texture } = (
  window as typeof window & { PIXI: typeof Pixi }
).PIXI;

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
  /** 播放模式：隐藏洋葱皮与网格、禁用拖拽，主精灵由外部按游标换帧 */
  playing: boolean;
  onPatch: (id: string, patch: FramePatch) => void;
  /** 点击画布空白处（未命中当前帧精灵）时触发，用于清空多选 */
  onCanvasBlank: () => void;
}

interface PixiCtx {
  app: Pixi.Application;
  viewport: Pixi.Container;
  grid: Pixi.Graphics;
  main: Pixi.Sprite;
  prevS: Pixi.Sprite;
  nextS: Pixi.Sprite;
}

/** PixiJS 帧画布：拖拽改 offset、洋葱皮、网格、受控缩放（工具栏见 CanvasToolbar）；playing 时在画布内播放 */
export default function FrameEditor({ frame, prev, next, v, zoom, onion, showGrid, playing, onPatch, onCanvasBlank }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pixi = useRef<PixiCtx | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useTheme();
  const t = useT();

  // 供 Pixi 事件回调读取最新值
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;
  const onPatchRef = useRef(onPatch);
  onPatchRef.current = onPatch;
  const onionRef = useRef(onion);
  onionRef.current = onion;
  const onCanvasBlankRef = useRef(onCanvasBlank);
  onCanvasBlankRef.current = onCanvasBlank;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // 适配缩放（fit-to-view）：让帧完整收进可视画布区域——只缩小不放大
  // （小图 100% 保持 1:1 像素；大图收进画布，底部不再被裁掉）
  // 按旋转后的实际轴对齐范围计算，让带 offset 的帧也以画布中心为基准完整呈现
  const [fitScale, setFitScale] = useState(1);
  const updateFit = useCallback(() => {
    const p = pixi.current;
    if (!p) return;
    const f = frameRef.current;
    const tex = p.main.texture;
    if (!f || !tex || tex === Texture.EMPTY || tex.width === 0 || tex.height === 0) {
      setFitScale(1);
      return;
    }
    const bounds = transformedFrameBounds(tex.width, tex.height, f);
    setFitScale(fitScaleForBounds(bounds, p.app.screen.width, p.app.screen.height));
  }, []);
  const updateFitRef = useRef(updateFit);
  updateFitRef.current = updateFit;

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

      // viewport 定位到可视画布中心，并随 resize 保持（resizeTo 由 ResizeObserver 驱动，布局分隔条拖动也会触发）
      // 同步重算适配缩放
      const center = () => {
        viewport.position.set(app.screen.width / 2, app.screen.height / 2);
        app.stage.hitArea = app.screen;
        updateFitRef.current();
      };
      app.renderer.on("resize", center);
      app.stage.eventMode = "static";
      center();

      // 当前帧拖拽 → 松手 PATCH offset
      let drag: { startX: number; startY: number; baseX: number; baseY: number } | null = null;
      main.eventMode = "static";
      main.cursor = "grab";
      main.on("pointerdown", (e: Pixi.FederatedPointerEvent) => {
        if (playingRef.current) return; // 播放中禁用拖拽
        const p = viewport.toLocal(e.global);
        drag = { startX: p.x, startY: p.y, baseX: main.x, baseY: main.y };
        main.cursor = "grabbing";
      });
      // 点击画布空白（未命中当前帧精灵）→ 清空多选
      app.stage.on("pointerdown", (e: Pixi.FederatedPointerEvent) => {
        if (e.target !== main) onCanvasBlankRef.current();
      });
      app.stage.on("pointermove", (e: Pixi.FederatedPointerEvent) => {
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

    const applyTransform = (sprite: Pixi.Sprite, f: Frame, isMain: boolean) => {
      sprite.position.set(f.offset_x, f.offset_y);
      sprite.scale.set(f.scale);
      sprite.rotation = f.rotation;
      if (isMain) sprite.alpha = f.opacity;
    };

    const loadInto = async (sprite: Pixi.Sprite, f: Frame | null, isMain: boolean) => {
      if (!f) {
        sprite.visible = false;
        return;
      }
      try {
        // 图片 URL 带 .png 后缀（服务端双路由别名），Assets 按扩展名命中 texture parser
        const tex: Pixi.Texture = await Assets.load(frameImageUrl(f.id, v));
        if (dead) return;
        tex.source.scaleMode = "nearest"; // 像素风：最近邻缩放
        sprite.texture = tex;
        applyTransform(sprite, f, isMain);
        sprite.visible = isMain ? true : onionRef.current;
      } catch {
        sprite.visible = false;
      }
    };

    // 主帧加载完成后按新贴图尺寸重算适配缩放（切换帧时视图回到居中适配状态）
    (async () => {
      await loadInto(p.main, frame, true);
      if (!dead) updateFit();
    })();
    loadInto(p.prevS, prev, false);
    loadInto(p.nextS, next, false);
    return () => {
      dead = true;
    };
  }, [frame, prev, next, v, ready, updateFit]);

  // ---- 帧属性变化时同步主精灵变换（拖拽中 frame 不变，不干扰）----
  useEffect(() => {
    const p = pixi.current;
    if (!p || !frame || p.main.texture === Texture.EMPTY) return;
    p.main.position.set(frame.offset_x, frame.offset_y);
    p.main.scale.set(frame.scale);
    p.main.rotation = frame.rotation;
    p.main.alpha = frame.opacity;
  }, [frame, ready]);

  // ---- 洋葱皮开关（受控 prop；播放时强制隐藏）----
  useEffect(() => {
    const p = pixi.current;
    if (!p) return;
    const show = onion && !playing;
    p.prevS.visible = show && prev != null && p.prevS.texture !== Texture.EMPTY;
    p.nextS.visible = show && next != null && p.nextS.texture !== Texture.EMPTY;
  }, [onion, playing, prev, next, ready]);

  // ---- 缩放（受控 prop）× 适配缩放（fit）：viewport 整体缩放 = zoom * fitScale ----
  useEffect(() => {
    pixi.current?.viewport.scale.set(zoom * fitScale);
  }, [zoom, fitScale, ready]);

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
    if (!showGrid || playing) return; // 播放时隐藏网格
    const colors = canvasColors();
    const step = 32;
    const half = 640;
    for (let x = -half; x <= half; x += step) g.moveTo(x, -half).lineTo(x, half);
    for (let y = -half; y <= half; y += step) g.moveTo(-half, y).lineTo(half, y);
    g.stroke({ color: colors.grid, width: 1, alpha: 0.35 });
    // 中心十字
    g.moveTo(-half, 0).lineTo(half, 0).moveTo(0, -half).lineTo(0, half);
    g.stroke({ color: colors.cross, width: 1, alpha: 0.7 });
  }, [showGrid, playing, ready, theme]);

  return (
    <div className="pixi-wrap" ref={wrapRef}>
      {!frame && <div className="canvas-empty">{t("msg.no_frames_yet_click_import_materials_top_right")}</div>}
    </div>
  );
}
