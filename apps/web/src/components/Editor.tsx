import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Download, Play, Upload } from "lucide-react";
import { Assets } from "pixi.js";
import { api, frameImageUrl, wsClient, type Frame, type FramePatch, type Project } from "../api";
import FrameList from "./FrameList";
import FrameEditor from "./FrameEditor";
import Timeline from "./Timeline";
import ImportModal from "./ImportModal";
import PlaybackBar from "./PlaybackBar";
import BatchBar from "./BatchBar";
import CanvasToolbar from "./CanvasToolbar";
import SplitDivider from "./SplitDivider";
import IconBtn from "./IconBtn";
import ThemeToggle from "./ThemeToggle";
import { exportSpritesheet } from "../export";
import {
  LAYOUT_DEFAULTS,
  clampSidebarW,
  clampTimelineH,
  fetchServerLayout,
  loadLayout,
  saveLayout,
  type LayoutState,
} from "../layout";

/** 帧点击修饰键（FrameList / Timeline 统一使用） */
export interface FrameClickMods {
  ctrl: boolean;
  shift: boolean;
}

export default function Editor({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  // 播放预览：就在 Pixi 画布内播放（不换容器）。showPreview=播放模式，paused=暂停
  const [showPreview, setShowPreview] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fps, setFps] = useState(8);
  const [cursor, setCursor] = useState(0);
  const playTick = useRef(0);
  const shellRef = useRef<HTMLDivElement>(null);
  // 画布工具栏状态（上提到 Editor：编辑/预览两种模式共用一份，切换不丢）
  const [zoom, setZoom] = useState(1);
  const [onion, setOnion] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const zoomBy = useCallback(
    (factor: number) => setZoom((z) => Math.min(4, Math.max(0.25, Math.round(z * factor * 100) / 100))),
    []
  );
  // 多选：frameId 集合；范围选的锚点 = 当前编辑帧 activeId
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 布局尺寸（分隔条拖动；localStorage 即时渲染 + 服务端 settings 权威持久化）
  const [layout, setLayout] = useState<LayoutState>(loadLayout);
  useEffect(() => saveLayout(layout), [layout]);
  // 启动后拉服务端布局覆盖本地（不同浏览器看到相同布局）
  useEffect(() => {
    let dead = false;
    fetchServerLayout().then((v) => {
      if (v && !dead) {
        setLayout((cur) => (cur.sidebarW === v.sidebarW && cur.timelineH === v.timelineH ? cur : v));
      }
    });
    return () => {
      dead = true;
    };
  }, []);
  const onSidebarDelta = useCallback(
    (d: number) => setLayout((l) => ({ ...l, sidebarW: clampSidebarW(l.sidebarW + d) })),
    []
  );
  const onTimelineDelta = useCallback(
    // 分隔条在时间轴上方：向上拖（dy 为负）= 增高
    (d: number) => setLayout((l) => ({ ...l, timelineH: clampTimelineH(l.timelineH - d) })),
    []
  );
  // 图片缓存破坏版本号：任何图片内容变化后 +1
  const [v, setV] = useState(0);

  const loadFrames = useCallback(async () => {
    try {
      const list = await api.getFrames(projectId);
      setFrames(list);
      setActiveId((cur) => (cur && list.some((f) => f.id === cur) ? cur : (list[0]?.id ?? null)));
      // 选区里已不存在的帧自动剔除
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const alive = new Set(list.map((f) => f.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (e) {
      console.error(e);
    }
  }, [projectId]);

  useEffect(() => {
    api.getProject(projectId).then(setProject).catch(() => setProject(null));
    loadFrames();
    // WS：任务/帧变更时刷新帧列表
    const unsub = wsClient.subscribe((msg) => {
      if (["frame_updated", "frames_reordered", "frames_changed", "job_done"].includes(msg.type)) {
        loadFrames();
        setV((x) => x + 1);
      }
    });
    return unsub;
  }, [loadFrames, projectId]);

  const patchFrame = useCallback(async (id: string, patch: FramePatch) => {
    try {
      const { frame } = await api.patchFrame(id, patch);
      setFrames((fs) => fs.map((f) => (f.id === id ? frame : f)));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const onDuplicate = useCallback(
    async (id: string) => {
      await api.duplicateFrame(id, 1).catch((e) => alert(`复制失败: ${e.message}`));
      await loadFrames();
    },
    [loadFrames]
  );

  const onDelete = useCallback(
    async (id: string) => {
      await api.deleteFrame(id).catch((e) => alert(`删除失败: ${e.message}`));
      await loadFrames();
    },
    [loadFrames]
  );

  const onReplace = useCallback(
    async (id: string, file: File) => {
      try {
        await api.replaceFrame(id, file);
        setV((x) => x + 1);
        await loadFrames();
      } catch (e) {
        alert(`替换失败: ${(e as Error).message}`);
      }
    },
    [loadFrames]
  );

  // 时间轴拖拽换序：前端乐观更新 + 调 reorder
  const onReorder = useCallback(
    (from: number, to: number) => {
      const arr = [...frames];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      setFrames(arr);
      api.reorder(projectId, arr.map((f) => f.id)).catch((e) => {
        alert(`排序失败: ${e.message}`);
        loadFrames();
      });
    },
    [frames, projectId, loadFrames]
  );

  // ---- 多选 ----
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // FrameList / Timeline 统一的点击入口：plain / ctrl / shift
  const onFrameClick = useCallback(
    (id: string, mods: FrameClickMods) => {
      const idx = frames.findIndex((f) => f.id === id);
      if (idx < 0) return;
      if (mods.shift && activeId) {
        // 范围选：锚点（当前帧）到点击帧，支持反向
        const anchor = frames.findIndex((f) => f.id === activeId);
        if (anchor >= 0) {
          const [lo, hi] = anchor <= idx ? [anchor, idx] : [idx, anchor];
          setSelectedIds(new Set(frames.slice(lo, hi + 1).map((f) => f.id)));
          return;
        }
      }
      if (mods.ctrl) {
        // 切换单个帧的选中状态，不改变当前编辑帧
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      // 单击：设为当前编辑帧，并清空多选
      setActiveId(id);
      setSelectedIds(new Set());
    },
    [frames, activeId]
  );

  // ---- 播放预览（在 Pixi 画布内播放，不换容器）----
  const togglePlayback = useCallback(() => {
    if (!showPreview) {
      // 从当前编辑帧开始播
      const idx = frames.findIndex((f) => f.id === activeId);
      setCursor(idx >= 0 ? idx : 0);
      playTick.current = 0;
      setPaused(false);
    }
    setShowPreview((s) => !s);
  }, [showPreview, frames, activeId]);

  // 深链/测试钩子：?autoplay=1 进入项目后自动开始播放
  const autoPlayed = useRef(false);
  useEffect(() => {
    if (autoPlayed.current || frames.length === 0) return;
    if (new URLSearchParams(location.search).has("autoplay")) {
      autoPlayed.current = true;
      togglePlayback();
    }
  }, [frames, togglePlayback]);

  // 播放计时器：按 fps tick 推进，每帧停留 duration 个 tick
  useEffect(() => {
    if (!showPreview || paused || frames.length === 0) return;
    const id = setInterval(() => {
      playTick.current += 1;
      const dur = Math.max(1, frames[cursor]?.duration ?? 1);
      if (playTick.current >= dur) {
        playTick.current = 0;
        setCursor((c) => (c + 1) % frames.length);
      }
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [showPreview, paused, fps, frames, cursor]);

  // 帧数变化时防止游标越界
  useEffect(() => {
    if (cursor >= frames.length) {
      setCursor(0);
      playTick.current = 0;
    }
  }, [frames.length, cursor]);

  // 进入播放时预载全部帧贴图：切换只换 sprite.texture，零闪烁
  useEffect(() => {
    if (!showPreview) return;
    for (const f of frames) {
      Assets.load(frameImageUrl(f.id, v)).catch(() => null);
    }
  }, [showPreview, frames, v]);

  // 播放中 Cmd/Ctrl+滚轮缩放（作用于 Pixi viewport，原生监听好 preventDefault）
  useEffect(() => {
    const el = shellRef.current;
    if (!el || !showPreview) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [showPreview, zoomBy]);

  // Esc 清空多选（导入弹窗打开时不抢按键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showImport) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showImport, clearSelection]);

  // ---- 批量操作：循环调现有 API，完成后统一刷新并清空选区 ----
  const selectedInOrder = useCallback(
    () => frames.filter((f) => selectedIds.has(f.id)).map((f) => f.id),
    [frames, selectedIds]
  );

  const batchDelete = useCallback(async () => {
    const ids = selectedInOrder();
    const failed: string[] = [];
    for (const id of ids) {
      await api.deleteFrame(id).catch(() => failed.push(id));
    }
    setSelectedIds(new Set());
    await loadFrames(); // 当前帧被删时 loadFrames 会自动切到剩余第一帧
    if (failed.length) alert(`${failed.length} 帧删除失败`);
  }, [selectedInOrder, loadFrames]);

  const batchDuplicate = useCallback(async () => {
    const ids = selectedInOrder();
    const failed: string[] = [];
    for (const id of ids) {
      await api.duplicateFrame(id, 1).catch(() => failed.push(id));
    }
    setSelectedIds(new Set());
    await loadFrames();
    if (failed.length) alert(`${failed.length} 帧复制失败`);
  }, [selectedInOrder, loadFrames]);

  const batchSetDuration = useCallback(
    async (duration: number) => {
      const ids = selectedInOrder();
      const failed: string[] = [];
      for (const id of ids) {
        await api.patchFrame(id, { duration }).catch(() => failed.push(id));
      }
      setSelectedIds(new Set());
      await loadFrames();
      if (failed.length) alert(`${failed.length} 帧设置失败`);
    },
    [selectedInOrder, loadFrames]
  );

  const activeIndex = frames.findIndex((f) => f.id === activeId);
  const active = activeIndex >= 0 ? frames[activeIndex] : null;
  const prev = activeIndex > 0 ? frames[activeIndex - 1] : null;
  const next = activeIndex >= 0 && activeIndex < frames.length - 1 ? frames[activeIndex + 1] : null;
  // 播放时画布显示游标帧，停止回到当前编辑帧
  const displayFrame = showPreview ? (frames[cursor] ?? null) : active;

  return (
    <div className="editor">
      <header className="topbar pixel-bar">
        <IconBtn onClick={onBack} title="返回项目列表">
          <ArrowLeft size={16} />
        </IconBtn>
        <span className="proj-name">{project?.name ?? "…"}</span>
        <span className="frame-count">{frames.length} 帧</span>
        <div className="spacer" />
        <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" onClick={() => setShowImport(true)}>
          <Upload size={14} /> 导入素材
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          className={`px-btn ${showPreview ? "accent-cyan" : ""}`}
          onClick={togglePlayback}
        >
          <Play size={14} /> 播放预览
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          className="px-btn accent"
          disabled={frames.length === 0}
          onClick={() => exportSpritesheet(frames, project?.name ?? "spritesheet").catch((e) => alert(`导出失败: ${e.message}`))}
        >
          <Download size={14} /> 导出精灵表
        </motion.button>
        <ThemeToggle />
      </header>

      <div className="editor-main">
        <FrameList
          frames={frames}
          activeId={activeId}
          selectedIds={selectedIds}
          v={v}
          width={layout.sidebarW}
          onFrameClick={onFrameClick}
          onClearSelection={clearSelection}
          onPatch={patchFrame}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
        <SplitDivider direction="col" onDelta={onSidebarDelta} onReset={() => setLayout((l) => ({ ...l, sidebarW: LAYOUT_DEFAULTS.sidebarW }))} />
        <div className="canvas-wrap">
          <div className="canvas-area">
            {/* 工具栏恒定渲染：编辑向按钮预览模式置灰，缩放控件作用于当前模式 */}
            <CanvasToolbar
              mode={showPreview ? "preview" : "edit"}
              onion={onion}
              showGrid={showGrid}
              zoom={zoom}
              frame={active}
              onToggleOnion={() => setOnion((o) => !o)}
              onToggleGrid={() => setShowGrid((g) => !g)}
              onZoomBy={zoomBy}
              onZoomReset={() => setZoom(1)}
              onReplace={onReplace}
              onPatch={patchFrame}
            />
            {/* 播放就在 Pixi 画布内：FrameEditor 常驻不卸载，悬浮播放条覆盖在画布框内底部 */}
            <div className="stage-shell" ref={shellRef}>
              <FrameEditor
                frame={displayFrame}
                prev={prev}
                next={next}
                v={v}
                zoom={zoom}
                onion={onion}
                showGrid={showGrid}
                playing={showPreview}
                onPatch={patchFrame}
                onCanvasBlank={clearSelection}
              />
              <AnimatePresence>
                {showPreview && (
                  <PlaybackBar
                    fps={fps}
                    paused={paused}
                    cursor={cursor}
                    total={frames.length}
                    zoom={zoom}
                    onTogglePause={() => setPaused((p) => !p)}
                    onFpsChange={setFps}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      <SplitDivider direction="row" onDelta={onTimelineDelta} onReset={() => setLayout((l) => ({ ...l, timelineH: LAYOUT_DEFAULTS.timelineH }))} />
      <Timeline
        frames={frames}
        activeId={activeId}
        selectedIds={selectedIds}
        v={v}
        height={layout.timelineH}
        onFrameClick={onFrameClick}
        onReorder={onReorder}
      />

      {/* 批量操作条：多选 >=2 时浮出 */}
      <div className="batch-dock">
        <AnimatePresence>
          {selectedIds.size >= 2 && (
            <BatchBar
              count={selectedIds.size}
              onDelete={batchDelete}
              onDuplicate={batchDuplicate}
              onApplyDuration={batchSetDuration}
              onClear={clearSelection}
            />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showImport && (
          <ImportModal
            projectId={projectId}
            onClose={() => setShowImport(false)}
            onDone={() => {
              loadFrames();
              setV((x) => x + 1);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
