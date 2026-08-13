import { useCallback, useEffect, useRef, useState } from "react";
import type * as Pixi from "pixi.js";
import type { AttackEffect, AttackEffectBrush } from "@framebaker/shared";
import { frameImageUrl, type AttackEffectCell, type Frame, type FramePatch } from "../api";
import { attackBrushBodyScale, attackEffectBounds, attackEffectLocalPoint, attackRenderLayers, attackRibbon, attackTextureMarks, brushPressure, createAttackEffect, shouldSamplePoint, smoothStrokePoints } from "../attackEffect";
import { fitScaleForBounds, transformedFrameBounds } from "../frameGeometry";
import { useT } from "../i18n";
import { canvasColors, useTheme } from "../theme";

const { Application, Assets, Container, Graphics, Sprite, Texture } = (
  window as typeof window & { PIXI: typeof Pixi }
).PIXI;

interface Props {
  frame: Frame | null;
  composite: Frame[];
  effect: AttackEffect | null;
  effects: AttackEffectCell[];
  editable: boolean;
  effectEditable: boolean;
  prev: Frame | null;
  next: Frame | null;
  v: number;
  /** 受控缩放（工具栏在 Editor 层，25%–400%） */
  zoom: number;
  /** 点击“适应窗口”时递增，强制按当前合成内容和最新画布尺寸重新居中缩放。 */
  fitRequest: number;
  /** 受控洋葱皮开关 */
  onion: boolean;
  /** 受控网格开关 */
  showGrid: boolean;
  /** 播放模式：隐藏洋葱皮与网格、禁用拖拽，主精灵由外部按游标换帧 */
  playing: boolean;
  brushMode: boolean;
  brushColor: string;
  brushSize: number;
  attackBrush: AttackEffectBrush;
  onPatch: (id: string, patch: FramePatch) => void;
  onEffectChange: (effect: AttackEffect | null) => void;
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
  compositeLayer: Pixi.Container;
  effectLayer: Pixi.Container;
  mainEffect: Pixi.Graphics;
  spriteFrames: Map<Pixi.Sprite, Frame>;
}

/** PixiJS 帧画布：拖拽改 offset、洋葱皮、网格、受控缩放（工具栏见 CanvasToolbar）；playing 时在画布内播放 */
export default function FrameEditor({ frame, composite, effect, effects, editable, effectEditable, prev, next, v, zoom, fitRequest, onion, showGrid, playing, brushMode, brushColor, brushSize, attackBrush, onPatch, onEffectChange, onCanvasBlank }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pixi = useRef<PixiCtx | null>(null);
  const [ready, setReady] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const theme = useTheme();
  const t = useT();

  // 供 Pixi 事件回调读取最新值
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;
  const effectRef = useRef<AttackEffect | null>(null);
  effectRef.current = effect;
  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const onPatchRef = useRef(onPatch);
  onPatchRef.current = onPatch;
  const onionRef = useRef(onion);
  onionRef.current = onion;
  const onCanvasBlankRef = useRef(onCanvasBlank);
  onCanvasBlankRef.current = onCanvasBlank;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const effectEditableRef = useRef(effectEditable);
  effectEditableRef.current = effectEditable;
  const onEffectChangeRef = useRef(onEffectChange);
  onEffectChangeRef.current = onEffectChange;
  const brushModeRef = useRef(brushMode);
  brushModeRef.current = brushMode;
  const brushColorRef = useRef(brushColor);
  brushColorRef.current = brushColor;
  const brushSizeRef = useRef(brushSize);
  brushSizeRef.current = brushSize;
  const attackBrushRef = useRef(attackBrush);
  attackBrushRef.current = attackBrush;
  const spaceHeldRef = useRef(false);
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const initialFitDoneRef = useRef(false);

  // 适配缩放（fit-to-view）：让帧完整收进可视画布区域——只缩小不放大
  // （小图 100% 保持 1:1 像素；大图收进画布，底部不再被裁掉）
  // 按旋转后的实际轴对齐范围计算，让带 offset 的帧也以画布中心为基准完整呈现
  const [fitScale, setFitScale] = useState(1);
  const updateFit = useCallback(() => {
    const p = pixi.current;
    if (!p) return false;
    const availableHeight = Math.max(1, p.app.screen.height);
    p.viewport.position.set(p.app.screen.width / 2 + panOffsetRef.current.x, availableHeight / 2 + panOffsetRef.current.y);
    const imageBounds = [...p.spriteFrames.entries()]
      .filter(([sprite]) => sprite.visible && sprite.parent === p.compositeLayer && sprite.texture !== Texture.EMPTY)
      .map(([sprite, currentFrame]) => transformedFrameBounds(sprite.texture.width, sprite.texture.height, currentFrame));
    const effectBounds = effectsRef.current
      .map((cell) => attackEffectBounds(cell.effect))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const bounds = [...imageBounds, ...effectBounds];
    if (bounds.length === 0) {
      setFitScale(1);
      return false;
    }
    setFitScale(fitScaleForBounds({
      left: Math.min(...bounds.map((item) => item.left)),
      right: Math.max(...bounds.map((item) => item.right)),
      top: Math.min(...bounds.map((item) => item.top)),
      bottom: Math.max(...bounds.map((item) => item.bottom)),
    }, p.app.screen.width, availableHeight, 0.75));
    return true;
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
      const compositeLayer = new Container();
      const effectLayer = new Container();
      const mainEffect = new Graphics();
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
      compositeLayer.addChild(main);
      effectLayer.addChild(mainEffect);
      viewport.addChild(grid, prevS, nextS, compositeLayer, effectLayer);

      // viewport 定位到可视画布中心，并随 resize 保持（resizeTo 由 ResizeObserver 驱动，布局分隔条拖动也会触发）
      // 同步重算适配缩放
      const center = () => {
        app.stage.hitArea = app.screen;
        updateFitRef.current();
      };
      app.renderer.on("resize", center);
      app.stage.eventMode = "static";
      center();

      // 当前帧拖拽 → 松手 PATCH offset
      let drag: { startX: number; startY: number; baseX: number; baseY: number } | null = null;
      let effectDrag: { startX: number; startY: number; baseX: number; baseY: number } | null = null;
      let drawing: { effect: AttackEffect; lastTime: number } | null = null;
      let panDrag: { startX: number; startY: number; baseX: number; baseY: number } | null = null;
      main.eventMode = "static";
      main.cursor = "grab";
      main.on("pointerdown", (e: Pixi.FederatedPointerEvent) => {
        if (spaceHeldRef.current || brushModeRef.current || playingRef.current || !editableRef.current) return; // 绘制/平移/播放中或锁定轨禁用帧拖拽
        const p = viewport.toLocal(e.global);
        drag = { startX: p.x, startY: p.y, baseX: main.x, baseY: main.y };
        main.cursor = "grabbing";
      });
      mainEffect.eventMode = "static";
      mainEffect.cursor = "move";
      mainEffect.on("pointerdown", (e: Pixi.FederatedPointerEvent) => {
        if (spaceHeldRef.current || brushModeRef.current || playingRef.current || !effectEditableRef.current || !effectRef.current) return;
        const point = viewport.toLocal(e.global);
        effectDrag = {
          startX: point.x,
          startY: point.y,
          baseX: mainEffect.x,
          baseY: mainEffect.y,
        };
      });
      // 点击画布空白（未命中当前帧精灵）→ 清空多选
      app.stage.on("pointerdown", (e: Pixi.FederatedPointerEvent) => {
        if (spaceHeldRef.current) {
          panDrag = { startX: e.global.x, startY: e.global.y, baseX: panOffsetRef.current.x, baseY: panOffsetRef.current.y };
          setPanning(true);
          return;
        }
        if (brushModeRef.current && effectEditableRef.current && !playingRef.current) {
          const nextEffect = structuredClone(effectRef.current ?? createAttackEffect());
          if (nextEffect.strokes.length >= 128) return;
          const world = viewport.toLocal(e.global);
          const local = attackEffectLocalPoint(nextEffect, world);
          const pressure = brushPressure(e.pressure, 0, 16);
          nextEffect.strokes.push({ color: brushColorRef.current, size: brushSizeRef.current, brush: attackBrushRef.current, points: [{ ...local, pressure }] });
          drawing = { effect: nextEffect, lastTime: performance.now() };
          if (mainEffect.parent !== effectLayer) effectLayer.addChild(mainEffect);
          drawEffectGraphic(mainEffect, nextEffect);
          return;
        }
        if (e.target !== main && e.target !== mainEffect) onCanvasBlankRef.current();
      });
      app.stage.on("pointermove", (e: Pixi.FederatedPointerEvent) => {
        if (panDrag && !spaceHeldRef.current) {
          panDrag = null;
          setPanning(false);
          return;
        }
        if (panDrag) {
          panOffsetRef.current = { x: panDrag.baseX + e.global.x - panDrag.startX, y: panDrag.baseY + e.global.y - panDrag.startY };
          viewport.position.set(app.screen.width / 2 + panOffsetRef.current.x, app.screen.height / 2 + panOffsetRef.current.y);
          return;
        }
        if (!drag && !effectDrag) return;
        const p = viewport.toLocal(e.global);
        if (drag) main.position.set(drag.baseX + (p.x - drag.startX), drag.baseY + (p.y - drag.startY));
        if (effectDrag) mainEffect.position.set(effectDrag.baseX + (p.x - effectDrag.startX), effectDrag.baseY + (p.y - effectDrag.startY));
      });
      app.stage.on("pointermove", (e: Pixi.FederatedPointerEvent) => {
        if (!drawing) return;
        const stroke = drawing.effect.strokes.at(-1)!;
        if (stroke.points.length >= 4096) return;
        const world = viewport.toLocal(e.global);
        const local = attackEffectLocalPoint(drawing.effect, world);
        const previous = stroke.points.at(-1);
        if (!shouldSamplePoint(previous, local)) return;
        const now = performance.now();
        const distance = previous ? Math.hypot(local.x - previous.x, local.y - previous.y) : 0;
        const pressure = brushPressure(e.pressure, distance, now - drawing.lastTime, previous?.pressure);
        stroke.points.push({ ...local, pressure });
        drawing.lastTime = now;
        drawEffectGraphic(mainEffect, drawing.effect);
      });
      const endDrag = () => {
        if (panDrag) {
          panDrag = null;
          setPanning(false);
        }
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
      const endInteraction = () => {
        if (drawing) {
          onEffectChangeRef.current(drawing.effect);
          drawing = null;
        }
        if (effectDrag) {
          const currentEffect = effectRef.current;
          if (currentEffect) {
            onEffectChangeRef.current({ ...currentEffect, offset_x: mainEffect.x, offset_y: mainEffect.y });
          }
          effectDrag = null;
        }
        endDrag();
      };
      app.stage.on("pointerup", endInteraction);
      app.stage.on("pointerupoutside", endInteraction);

      pixi.current = { app, viewport, grid, main, prevS, nextS, compositeLayer, effectLayer, mainEffect, spriteFrames: new Map() };
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

  // 空格临时切换抓手工具；输入框内保留正常输入空格的行为。
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const release = () => { spaceHeldRef.current = false; setSpaceHeld(false); setPanning(false); };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      spaceHeldRef.current = true;
      setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === "Space") release(); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); window.removeEventListener("blur", release); };
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
        if (isMain) p.spriteFrames.delete(sprite);
        return;
      }
      try {
        // 图片 URL 带 .png 后缀（服务端双路由别名），Assets 按扩展名命中 texture parser
        const tex: Pixi.Texture = await Assets.load(frameImageUrl(f.id, v));
        if (dead) return;
        tex.source.scaleMode = "nearest"; // 像素风：最近邻缩放
        sprite.texture = tex;
        applyTransform(sprite, f, isMain);
        if (isMain) p.spriteFrames.set(sprite, f);
        sprite.visible = isMain ? true : onionRef.current;
      } catch {
        sprite.visible = false;
      }
    };

    // 首次进入编辑器时自动适配一次；普通步骤切换保留用户当前视角。
    (async () => {
      await loadInto(p.main, frame, true);
      if (!dead && !initialFitDoneRef.current && updateFit()) initialFitDoneRef.current = true;
    })();
    loadInto(p.prevS, prev, false);
    loadInto(p.nextS, next, false);
    return () => {
      dead = true;
    };
  }, [frame, prev, next, v, ready, updateFit]);

  // 当前步骤的其余可见轨道按 z 顺序合成；选中帧仍由 main 承担交互。
  useEffect(() => {
    const p = pixi.current; if (!p || !ready) return;
    let dead = false;
    p.compositeLayer.children.filter((child) => child !== p.main).forEach((child) => {
      p.compositeLayer.removeChild(child);
      p.spriteFrames.delete(child as Pixi.Sprite);
      child.destroy();
    });
    const others = composite.filter((f) => f.id !== frame?.id);
    Promise.all(others.map(async (f) => {
      try {
        const tex: Pixi.Texture = await Assets.load(frameImageUrl(f.id, v));
        if (dead) return null;
        tex.source.scaleMode = "nearest";
        const s = new Sprite(tex); s.anchor.set(0.5); s.position.set(f.offset_x,f.offset_y); s.scale.set(f.scale); s.rotation=f.rotation; s.alpha=f.opacity; s.eventMode="none";
        p.spriteFrames.set(s, f);
        return s;
      } catch {
        // 删除/替换帧时旧合成请求可能晚到 404；该帧直接跳过，等待最新 timeline 重绘。
        return null;
      }
    })).then((sprites) => {
      if (dead) return;
      let oi=0;
      for(const f of composite){if(f.id===frame?.id)p.compositeLayer.addChild(p.main);else {const s=sprites[oi++];if(s)p.compositeLayer.addChild(s);}}
      if (!initialFitDoneRef.current && updateFit()) initialFitDoneRef.current = true;
    });
    return () => { dead = true; };
  }, [composite, frame?.id, ready, updateFit, v]);

  // 攻击特效始终在图片合成层上方；编辑帧可命中拖动，其余轨道/播放帧只展示。
  useEffect(() => {
    const p = pixi.current;
    if (!p || !ready) return;
    p.effectLayer.removeChildren().forEach((child) => {
      if (child !== p.mainEffect) child.destroy();
    });
    for (const cell of effects) {
      if (!cell.effect.strokes.length) continue;
      if (cell.effect === effect) {
        drawEffectGraphic(p.mainEffect, cell.effect);
        p.mainEffect.eventMode = effectEditable && !playing ? "static" : "none";
        p.effectLayer.addChild(p.mainEffect);
      } else {
        const graphic = new Graphics();
        drawEffectGraphic(graphic, cell.effect);
        graphic.eventMode = "none";
        p.effectLayer.addChild(graphic);
      }
    }
    if (effect?.strokes.length && !effects.some((cell) => cell.effect === effect)) {
      drawEffectGraphic(p.mainEffect, effect);
      p.effectLayer.addChild(p.mainEffect);
    }
    if (!initialFitDoneRef.current && updateFit()) initialFitDoneRef.current = true;
  }, [effect, effectEditable, effects, playing, ready, updateFit]);

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

  // 手动“适应窗口”：分隔条改变可视区域后，重新居中并按合成包围盒留出安全边距。
  useEffect(() => {
    const p = pixi.current;
    if (!p) return;
    panOffsetRef.current = { x: 0, y: 0 };
    updateFit();
  }, [fitRequest, ready, updateFit]);

  // 进入/退出播放只在模式边界适配一次；播放和手动切换步骤期间视角保持稳定。
  useEffect(() => {
    if (!ready) return;
    updateFit();
  }, [playing, ready, updateFit]);

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
    <div className={`pixi-wrap ${spaceHeld ? "space-pan" : ""} ${panning ? "panning" : ""} ${brushMode ? "drawing-effect" : ""}`} ref={wrapRef}>
      {!frame && composite.length === 0 && effects.length === 0 && !effectEditable && <div className="canvas-empty">{t("msg.no_frames_yet_click_import_materials_top_right")}</div>}
      <div className="canvas-pan-hint"><kbd>Space</kbd><span>{t("canvas.panHint")}</span></div>
    </div>
  );
}

function drawEffectGraphic(graphic: Pixi.Graphics, effect: AttackEffect) {
  graphic.clear();
  graphic.position.set(effect.offset_x, effect.offset_y);
  graphic.scale.set(effect.scale);
  graphic.rotation = effect.rotation;
  graphic.alpha = effect.opacity;
  for (const stroke of effect.strokes) {
    const points = smoothStrokePoints(stroke);
    const bodyScale = attackBrushBodyScale(stroke.brush);
    for (const layer of attackRenderLayers(effect.style, stroke.color)) {
      if (points.length === 1) {
        const point = points[0]!;
        graphic.circle(point.x, point.y, Math.max(0.5, stroke.size * point.pressure * layer.width * bodyScale / 2)).fill({
          color: layer.color,
          alpha: layer.alpha,
        });
      } else {
        graphic.poly(attackRibbon(stroke, layer.width * bodyScale)).fill({
          color: layer.color,
          alpha: layer.alpha,
        });
      }
    }
    const marks = attackTextureMarks(stroke);
    const textureColor = attackRenderLayers(effect.style, stroke.color).at(-1)!.color;
    for (const line of marks.lines) {
      if (line.points.length < 2) continue;
      graphic.moveTo(line.points[0]!.x, line.points[0]!.y);
      for (let index = 1; index < line.points.length; index++) graphic.lineTo(line.points[index]!.x, line.points[index]!.y);
      graphic.stroke({ color: textureColor, width: line.width, alpha: line.alpha, cap: "round", join: "round" });
    }
    for (const dot of marks.dots) {
      graphic.circle(dot.x, dot.y, dot.radius).fill({ color: textureColor, alpha: dot.alpha });
    }
  }
}
