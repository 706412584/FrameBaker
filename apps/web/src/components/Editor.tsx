import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Copy, Crop, Download, Minus, Play, Plus, Scan, Star, Trash2, Upload } from "lucide-react";
import type * as Pixi from "pixi.js";
import { api, frameImageUrl, wsClient, type AnimationTrack, type Frame, type FramePatch, type Project, type TimelineResponse } from "../api";
import { askConfirm, notify } from "../notice";
import { cropImage, findOpaqueBounds } from "../imageops/client";
import FrameList from "./FrameList";
import FrameEditor from "./FrameEditor";
import Timeline from "./Timeline";
import ImportModal from "./ImportModal";
import PlaybackBar from "./PlaybackBar";
import BatchBar from "./BatchBar";
import CanvasToolbar from "./CanvasToolbar";
import ContextMenu, { type CtxMenuItem } from "./ContextMenu";
import CropModal from "./CropModal";
import SplitDivider from "./SplitDivider";
import IconBtn from "./IconBtn";
import { exportSpritesheet } from "../export";
import { useT } from "../i18n";
import {
  LAYOUT_DEFAULTS,
  clampSidebarW,
  clampTimelineH,
  fetchServerLayout,
  loadLayout,
  saveLayout,
  type LayoutState,
} from "../layout";

const { Assets } = (window as typeof window & { PIXI: typeof Pixi }).PIXI;

/** 帧点击修饰键（FrameList / Timeline 统一使用） */
export interface FrameClickMods {
  ctrl: boolean;
  shift: boolean;
}

export default function Editor({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const t = useT();
  const [project, setProject] = useState<Project | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [axisId, setAxisId] = useState<string | null>(null);
  const axisIdRef = useRef<string | null>(null);
  axisIdRef.current = axisId;
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const activeTrackIdRef = useRef<string | null>(null);
  activeTrackIdRef.current = activeTrackId;
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const undoingRef = useRef(false);
  const [showImport, setShowImport] = useState(false);
  const [replaceCrop, setReplaceCrop] = useState<{ frameId: string; image: Blob; title: string } | null>(null);
  // 播放预览：就在 Pixi 画布内播放（不换容器）。showPreview=播放模式，paused=暂停
  const [showPreview, setShowPreview] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fps, setFps] = useState(8);
  const [cursor, setCursor] = useState(0);
  const [fitRequest, setFitRequest] = useState(0);
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
  // 同一帧的 PATCH 串行提交：UI 先乐观更新，避免快速连续步进丢操作或响应乱序
  const patchChains = useRef(new Map<string, Promise<void>>());
  const patchRevisions = useRef(new Map<string, number>());
  const steps = timeline?.steps ?? [];
  const tracks = timeline?.tracks ?? [];
  const allFrames = timeline?.frames ?? [];

  const loadFrames = useCallback(async (preferredTrackId?: string) => {
    try {
      const requestedAxisId = axisId;
      const data = await api.getTimeline(projectId, requestedAxisId ?? undefined);
      // 新轴选择期间可能仍有旧 WS 刷新在途；过期响应不得切回旧轴。
      if (axisIdRef.current !== null && requestedAxisId !== axisIdRef.current) return;
      setTimeline(data);
      setAxisId(data.axis.id);
      setFps(data.axis.fps);
      const requestedTrackId = preferredTrackId ?? activeTrackIdRef.current;
      const preserveAssetSelection = preferredTrackId === undefined && requestedTrackId === null && activeIdRef.current !== null;
      const trackId = preserveAssetSelection
        ? null
        : data.tracks.some((x) => x.id === requestedTrackId) ? requestedTrackId : data.tracks[0]?.id ?? null;
      setActiveTrackId(trackId);
      const list = data.frames.filter((f) => f.track_id === trackId);
      const assets = data.assetFrames ?? data.poolFrames ?? [];
      const pool = data.poolFrames ?? [];
      setFrames([...assets, ...list.filter((frame) => !assets.some((asset) => asset.id === frame.id))]);
      setActiveStepId((currentStepId) => {
        if (trackId === null) {
          setActiveId((currentId) => assets.some((frame) => frame.id === currentId) ? currentId : null);
          return null;
        }
        const stepId = currentStepId && data.steps.some((step) => step.id === currentStepId)
          ? currentStepId
          : data.steps[0]?.id ?? null;
        const cell = data.frames.find((frame) => frame.track_id === trackId && frame.step_id === stepId) ?? null;
        setActiveId((currentId) => pool.some((frame) => frame.id === currentId) ? currentId : cell?.id ?? null);
        return stepId;
      });
      // 选区里已不存在的帧自动剔除
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const alive = new Set(list.map((f) => f.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
      return data;
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }, [projectId, axisId]);

  // 合并密集 WS 事件：批量导入/抠图时只拉一次时间轴，并把图片破缓存也合并到同一轮。
  const frameRefreshTimer = useRef<number | null>(null);
  const imageRefreshPending = useRef(false);
  const scheduleFramesRefresh = useCallback((imageChanged = false) => {
    imageRefreshPending.current ||= imageChanged;
    if (frameRefreshTimer.current !== null) return;
    frameRefreshTimer.current = window.setTimeout(() => {
      frameRefreshTimer.current = null;
      const shouldBustImages = imageRefreshPending.current;
      imageRefreshPending.current = false;
      if (shouldBustImages) setV((x) => x + 1);
      void loadFrames();
    }, 150);
  }, [loadFrames]);

  useEffect(() => {
    api.getProject(projectId).then(setProject).catch(() => setProject(null));
    void loadFrames();
    // WS：任务/帧变更时刷新帧列表
    const unsub = wsClient.subscribe((msg) => {
      const payload = msg.payload as { projectId?: string; imageChanged?: boolean };
      if (["frame_updated", "frames_reordered", "frames_changed", "job_done", "timeline_changed"].includes(msg.type) && (!payload?.projectId || payload.projectId === projectId)) {
        scheduleFramesRefresh(msg.type === "frames_changed" || (msg.type === "frame_updated" && payload.imageChanged === true));
      }
    });
    return () => {
      unsub();
      if (frameRefreshTimer.current !== null) window.clearTimeout(frameRefreshTimer.current);
      frameRefreshTimer.current = null;
      imageRefreshPending.current = false;
    };
  }, [loadFrames, projectId, scheduleFramesRefresh]);

  const patchFrame = useCallback(
    (id: string, patch: FramePatch) => {
      const revision = (patchRevisions.current.get(id) ?? 0) + 1;
      patchRevisions.current.set(id, revision);
      setFrames((fs) => fs.map((frame) => (frame.id === id ? { ...frame, ...patch } : frame)));
      setTimeline((current) => current ? {
        ...current,
        frames: current.frames.map((frame) => (frame.id === id ? { ...frame, ...patch } : frame)),
      } : current);

      const previous = patchChains.current.get(id) ?? Promise.resolve();
      const request = previous
        .then(() => api.patchFrame(id, patch))
        .then(({ frame }) => {
          if (patchRevisions.current.get(id) === revision) {
            setFrames((fs) => fs.map((current) => (current.id === id ? frame : current)));
            setTimeline((current) => current ? {
              ...current,
              frames: current.frames.map((item) => (item.id === id ? frame : item)),
            } : current);
          }
        })
        .catch((e) => {
          notify(t("msg.frame_update_failed_msg", { msg: (e as Error).message }));
          if (patchRevisions.current.get(id) === revision) void loadFrames();
        })
        .finally(() => {
          if (patchChains.current.get(id) === request) patchChains.current.delete(id);
        });
      patchChains.current.set(id, request);
    },
    [loadFrames, t]
  );

  const onDuplicate = useCallback(
    async (id: string) => {
      await api.duplicateFrame(id, 1).catch((e) => notify(t("msg.duplicate_failed_msg", { msg: (e as Error).message })));
      await loadFrames();
    },
    [loadFrames]
  );

  const onDelete = useCallback(
    async (id: string) => {
      await api.deleteFrame(id).catch((e) => notify(t("msg.delete_failed_msg", { msg: (e as Error).message })));
      await loadFrames();
    },
    [loadFrames]
  );

  const onReplace = useCallback((id: string, file: File) => {
    setReplaceCrop({ frameId: id, image: file, title: t("msg.replace_crop_frame_image") });
  }, []);

  // 剪裁当前帧：取当前显示图（processed 优先，服务端缺失回退 raw），确认后覆盖写回
  const onCropFrame = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(frameImageUrl(id, v));
        if (!res.ok) throw new Error(t("msg.failed_to_read_frame_image"));
        setReplaceCrop({ frameId: id, image: await res.blob(), title: t("msg.crop_frame_image") });
      } catch (e) {
        notify(t("msg.crop_failed_msg", { msg: (e as Error).message }));
      }
    },
    [v]
  );

  const confirmReplace = useCallback(
    async (blob: Blob) => {
      if (!replaceCrop) return;
      try {
        await api.replaceFrame(replaceCrop.frameId, blob);
        setReplaceCrop(null);
        setV((x) => x + 1);
        await loadFrames();
      } catch (e) {
        notify(t("msg.crop_write_back_failed_msg", { msg: (e as Error).message }));
      }
    },
    [loadFrames, replaceCrop]
  );

  // 时间轴拖拽换序：前端乐观更新 + 调 reorder
  const onReorder = useCallback(
    (from: number, to: number) => {
      if (from < 0 || to < 0 || from >= frames.length || to >= frames.length) return;
      const arr = [...frames];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      setFrames(arr);
      api.reorder(projectId, arr.map((f) => f.id)).catch((e) => {
        notify(t("msg.reorder_failed_msg", { msg: (e as Error).message }));
        loadFrames();
      });
    },
    [frames, projectId, loadFrames, t]
  );

  // ---- 多选 ----
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // 右键菜单（帧列表 / 时间轴共用）：右键未选中帧 → 设为当前帧出单帧菜单；右键多选内帧 → 保留选区出批量菜单
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; frameId: string } | null>(null);

  const onFrameContextMenu = useCallback(
    (id: string, pos: { x: number; y: number }, source: "asset" | "timeline") => {
      if (!(selectedIds.size >= 2 && selectedIds.has(id))) {
        const timelineFrame = source === "timeline" ? allFrames.find((frame) => frame.id === id) : null;
        setActiveId(id);
        setActiveTrackId(timelineFrame?.track_id ?? null);
        setActiveStepId(timelineFrame?.step_id ?? null);
        setSelectedIds(new Set());
      }
      setCtxMenu({ x: pos.x, y: pos.y, frameId: id });
    },
    [allFrames, selectedIds]
  );

  // FrameList / Timeline 统一的点击入口：plain / ctrl / shift
  const onFrameClick = useCallback(
    (id: string, mods: FrameClickMods) => {
      const idx = frames.findIndex((f) => f.id === id);
      if (idx < 0) return;
      // 左侧资产与轨道单元格互斥选择；选资产时不保留轨道/步骤高亮。
      setActiveTrackId(null);
      setActiveStepId(null);
      setActiveId(id);
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
        // 切换单个帧的选中状态；资产同时成为当前范围选择锚点。
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
      const idx = steps.findIndex((step) => step.id === activeStepId);
      setCursor(idx >= 0 ? idx : 0);
      playTick.current = 0;
      setPaused(false);
      // 播放预览始终从自动适应倍率开始，不继承编辑时的手动放大，避免被控制条遮挡。
      setZoom(1);
      setFitRequest((request) => request + 1);
    }
    setShowPreview((s) => !s);
  }, [showPreview, steps, activeStepId]);

  // 深链/测试钩子：?autoplay=1 进入项目后自动开始播放
  const autoPlayed = useRef(false);
  useEffect(() => {
    if (autoPlayed.current || allFrames.length === 0) return;
    if (new URLSearchParams(location.search).has("autoplay")) {
      autoPlayed.current = true;
      togglePlayback();
    }
  }, [allFrames, togglePlayback]);

  // 播放计时器：按 fps tick 推进，每帧停留 duration 个 tick
  useEffect(() => {
    if (!showPreview || paused || steps.length === 0) return;
    const id = setInterval(() => {
      playTick.current += 1;
      const dur = Math.max(1, steps[cursor]?.duration ?? 1);
      if (playTick.current >= dur) {
        playTick.current = 0;
        setCursor((c) => (c + 1) % steps.length);
      }
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [showPreview, paused, fps, steps, cursor]);

  // 帧数变化时防止游标越界
  useEffect(() => {
    if (cursor >= steps.length) {
      setCursor(0);
      playTick.current = 0;
    }
  }, [steps.length, cursor]);

  // 进入播放时预载全部帧贴图：切换只换 sprite.texture，零闪烁
  useEffect(() => {
    if (!showPreview) return;
    for (const f of allFrames) {
      Assets.load(frameImageUrl(f.id, v)).catch(() => null);
    }
  }, [showPreview, allFrames, v]);

  // 画布内 Cmd/Ctrl+滚轮缩放：编辑与播放共用 Pixi viewport，普通滚轮不拦截。
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // 同时适配鼠标滚轮与触控板：按 delta 平滑缩放，并限制单次跳变。
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY * 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? e.deltaY * 100
          : e.deltaY;
      zoomBy(Math.exp(Math.max(-0.35, Math.min(0.35, -delta * 0.002))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // Esc 清空多选；Delete/Backspace 删除当前轨道单元格内容。弹窗和输入控件不抢按键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showImport && !ctxMenu) clearSelection();
      if (e.repeat || showPreview || ctxMenu) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.closest("input, textarea, select, [contenteditable='true']") ||
        document.querySelector(".modal-mask")
      ) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (undoingRef.current) return;
        undoingRef.current = true;
        void api.undoProject(projectId)
          .then(() => loadFrames())
          .catch((error) => notify(t("msg.undo_failed_msg", { msg: (error as Error).message })))
          .finally(() => { undoingRef.current = false; });
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const frame = allFrames.find(
        (item) => item.id === activeId && item.track_id === activeTrackId && item.step_id === activeStepId
      );
      if (!frame) return;
      e.preventDefault();
      setActiveId(null);
      void api.clearFrameCell(frame.id)
        .then(() => loadFrames(activeTrackId ?? undefined))
        .catch((error) => notify(t("timeline.moveFailed", { msg: (error as Error).message })));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId, showImport, showPreview, ctxMenu, clearSelection, allFrames, activeId, activeTrackId, activeStepId, loadFrames, t]);

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
    if (failed.length) notify(t("msg.n_frames_failed_to_delete", { n: failed.length }));
  }, [selectedInOrder, loadFrames]);

  const batchDuplicate = useCallback(async () => {
    const ids = selectedInOrder();
    const failed: string[] = [];
    for (const id of ids) {
      await api.duplicateFrame(id, 1).catch(() => failed.push(id));
    }
    setSelectedIds(new Set());
    await loadFrames();
    if (failed.length) notify(t("msg.n_frames_failed_to_duplicate", { n: failed.length }));
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
      if (failed.length) notify(t("msg.n_frames_failed_to_update", { n: failed.length }));
    },
    [selectedInOrder, loadFrames]
  );

  // 批量裁透明边：逐帧取当前显示图，扫透明包围盒，无需剪裁的跳过，单帧失败不阻塞其余
  const batchTrim = useCallback(async () => {
    const ids = selectedInOrder();
    if (ids.length === 0) return;
    if (!(await askConfirm(t("msg.trim_transparent_edges_on_n_frames_overwrites_images_con", { n: ids.length })))) return;
    let trimmed = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await fetch(frameImageUrl(id, v));
        if (!res.ok) throw new Error(t("msg.failed_to_read_frame_image"));
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        bitmap.close();
        const bounds = await findOpaqueBounds(blob);
        // 全透明或包围盒已是整图：无需剪裁
        if (!bounds || (bounds.x === 0 && bounds.y === 0 && bounds.w === width && bounds.h === height)) {
          skipped += 1;
          continue;
        }
        const cropped = await cropImage(blob, bounds);
        await api.replaceFrame(id, cropped);
        trimmed += 1;
      } catch (e) {
        console.error(e);
        failed += 1;
      }
    }
    setSelectedIds(new Set());
    setV((x) => x + 1);
    await loadFrames();
    notify(t("msg.trimmed_trimmed_skipped_skipped_failed_failed", { trimmed, skipped, failed }), failed > 0 ? "error" : "info");
  }, [selectedInOrder, loadFrames, v]);

  const activeIndex = frames.findIndex((f) => f.id === activeId);
  const active = activeIndex >= 0 ? frames[activeIndex] : null;
  const prev = activeIndex > 0 ? frames[activeIndex - 1] : null;
  const next = activeIndex >= 0 && activeIndex < frames.length - 1 ? frames[activeIndex + 1] : null;
  // 播放时画布显示游标帧，停止回到当前编辑帧
  const displayStep = showPreview ? steps[cursor] : steps.find((s) => s.id === activeStepId);
  const trackOrder = useMemo(() => new Map(tracks.map((track) => [track.id, track] as const)), [tracks]);
  const composite = useMemo(
    () => displayStep
      ? allFrames
          .filter((f) => f.step_id === displayStep.id && f.track_id !== null && trackOrder.get(f.track_id)?.visible)
          .sort((a, b) => {
            const aIndex = a.track_id === null ? 0 : (trackOrder.get(a.track_id)?.idx ?? 0);
            const bIndex = b.track_id === null ? 0 : (trackOrder.get(b.track_id)?.idx ?? 0);
            return aIndex - bIndex;
          })
      : [],
    [allFrames, displayStep, trackOrder]
  );
  const activeFrameId = active?.id;
  // 选择来源由 activeTrack/activeStep 表达；历史资产即使仍绑定轨道，从左侧选中时也按资产预览。
  const poolActive = !!active && activeTrackId === null && activeStepId === null;
  const displayFrame = !showPreview && (poolActive || (active?.step_id === displayStep?.id && composite.some((frame) => frame.id === activeFrameId)))
    ? active
    : null;
  const displayComposite = poolActive && active ? [active] : composite;

  // ---- 右键菜单项：右键落在多选内 = 批量操作（同 BatchBar），否则单帧操作 ----
  const ctxFrame = ctxMenu ? (frames.find((f) => f.id === ctxMenu.frameId) ?? null) : null;
  const ctxBatch = ctxMenu != null && selectedIds.size >= 2 && selectedIds.has(ctxMenu.frameId);
  const ctxItems: CtxMenuItem[] = !ctxMenu
    ? []
    : ctxBatch
      ? [
          {
            label: t("msg.duplicate_n_frames", { n: selectedIds.size }),
            icon: <Copy size={13} />,
            onClick: async () => {
              if (await askConfirm(t("msg.duplicate_n_selected_frames_1_each", { n: selectedIds.size }))) await batchDuplicate();
            },
          },
          { label: t("msg.trim_edges"), icon: <Scan size={13} />, onClick: batchTrim },
          {
            label: t("msg.delete_n_frames", { n: selectedIds.size }),
            icon: <Trash2 size={13} />,
            danger: true,
            onClick: async () => {
              if (await askConfirm(t("msg.delete_n_selected_frames", { n: selectedIds.size }))) await batchDelete();
            },
          },
        ]
      : ctxFrame
        ? [
            {
              label: ctxFrame.is_keyframe ? t("msg.unmark_keyframe") : t("msg.mark_keyframe"),
              icon: <Star size={13} />,
              onClick: () => patchFrame(ctxFrame.id, { is_keyframe: ctxFrame.is_keyframe ? 0 : 1 }),
            },
            {
              label: t("msg.duration_1_now_n", { n: ctxFrame.duration }),
              icon: <Plus size={13} />,
              onClick: () => patchFrame(ctxFrame.id, { duration: Math.min(600, ctxFrame.duration + 1) }),
            },
            {
              label: t("msg.duration_1_now_n_1aa6de", { n: ctxFrame.duration }),
              icon: <Minus size={13} />,
              disabled: ctxFrame.duration <= 1,
              onClick: () => patchFrame(ctxFrame.id, { duration: Math.max(1, ctxFrame.duration - 1) }),
            },
            { label: t("msg.cropping"), icon: <Crop size={13} />, onClick: () => onCropFrame(ctxFrame.id) },
            { label: t("msg.duplicate"), icon: <Copy size={13} />, onClick: () => onDuplicate(ctxFrame.id) },
            {
              label: t("common.delete"),
              icon: <Trash2 size={13} />,
              danger: true,
              onClick: async () => {
                if (await askConfirm(t("msg.delete_this_frame"))) await onDelete(ctxFrame.id);
              },
            },
          ]
        : [];

  return (
    <div className="editor">
      <header className="topbar pixel-bar">
        <IconBtn onClick={onBack} title={t("msg.back_to_projects")}>
          <ArrowLeft size={16} />
        </IconBtn>
        <span className="proj-name">{project?.name ?? "…"}</span>
        <span className="frame-count">{t("msg.n_frames", { n: allFrames.length + (timeline?.poolFrames.length ?? 0) })}</span>
        <div className="spacer" />
        <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" onClick={() => setShowImport(true)}>
          <Upload size={14} /> {t("msg.import_materials")}
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          className={`px-btn ${showPreview ? "accent-cyan" : ""}`}
          onClick={togglePlayback}
        >
          <Play size={14} /> {t("msg.playback_preview")}
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          className="px-btn accent"
          disabled={allFrames.length === 0}
          onClick={() => timeline && exportSpritesheet(timeline, project?.name ?? "spritesheet").catch((e) => notify(t("msg.export_failed_msg", { msg: (e as Error).message })))}
        >
          <Download size={14} /> {t("msg.export_spritesheet")}
        </motion.button>
      </header>

      <div className="editor-main">
        <FrameList
          frames={timeline?.assetFrames ?? timeline?.poolFrames ?? []}
          activeId={activeId}
          selectedIds={selectedIds}
          v={v}
          width={layout.sidebarW}
          onFrameClick={onFrameClick}
          onClearSelection={clearSelection}
          onPatch={patchFrame}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onContextMenu={(id, pos) => onFrameContextMenu(id, pos, "asset")}
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
              onFit={() => {
                setZoom(1);
                setFitRequest((request) => request + 1);
              }}
              onReplace={onReplace}
              onCrop={onCropFrame}
              onPatch={patchFrame}
            />
            {/* FrameEditor 常驻不卸载；播放条悬浮在画布上，不参与布局。 */}
            <div className={`stage-shell ${showPreview ? "playing" : ""}`} ref={shellRef}>
              <FrameEditor
                frame={displayFrame}
                composite={displayComposite}
                editable={!showPreview && !!active && !tracks.find((tr) => tr.id === active.track_id)?.locked}
                prev={prev}
                next={next}
                v={v}
                zoom={zoom}
                fitRequest={fitRequest}
                onion={onion}
                showGrid={showGrid}
                playing={showPreview}
                onPatch={patchFrame}
                onCanvasBlank={clearSelection}
              />
              <AnimatePresence>
                {showPreview && (
                  <PlaybackBar
                    dragConstraints={shellRef}
                    fps={fps}
                    paused={paused}
                    cursor={cursor}
                    total={steps.length}
                    zoom={zoom}
                    onTogglePause={() => setPaused((p) => !p)}
                    onFpsChange={(nextFps) => {
                      setFps(nextFps);
                      if (timeline) {
                        api.patchAxis(timeline.axis.id, { fps: nextFps }).catch((e) =>
                          notify(t("msg.frame_update_failed_msg", { msg: (e as Error).message }))
                        );
                      }
                    }}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      <SplitDivider direction="row" onDelta={onTimelineDelta} onReset={() => setLayout((l) => ({ ...l, timelineH: LAYOUT_DEFAULTS.timelineH }))} />
      {timeline && <Timeline axes={timeline.axes} axis={timeline.axis} tracks={tracks} steps={steps} frames={allFrames}
        activeTrackId={activeTrackId} activeStepId={activeStepId} activeId={activeId} v={v} height={layout.timelineH}
        onAxis={(id)=>{axisIdRef.current=id;setAxisId(id);setActiveId(null);setActiveStepId(null)}}
        onAddAxis={async()=>{const {axis}=await api.createAxis(projectId,{name:t("timeline.defaultAxisName"),fps});axisIdRef.current=axis.id;setAxisId(axis.id)}}
        onDeleteAxis={async()=>{if(await askConfirm(t("timeline.confirmDeleteAxis"))){await api.deleteAxis(timeline.axis.id);axisIdRef.current=null;setAxisId(null);void loadFrames()}}}
        onCell={(trackId,stepId,frameId)=>{setActiveTrackId(trackId);setActiveStepId(stepId);setActiveId(frameId);setSelectedIds(new Set())}}
        onMoveCell={async(frameId,trackId,stepId,copy)=>{try{const {frame}=await api.moveFrameCell(frameId,trackId,stepId,true,copy);await loadFrames(trackId);setActiveTrackId(trackId);setActiveStepId(stepId);setActiveId(frame.id);setSelectedIds(new Set())}catch(e){notify(t("timeline.moveFailed",{msg:(e as Error).message}))}}}
        onPlaceBatch={async(frameIds,trackId,stepId)=>{try{const placed=await api.placeFramesBatch(trackId,{startStepId:stepId,frameIds});const refreshed=await loadFrames(trackId);const first=refreshed?.frames.find(frame=>frame.id===placed.frameIds[0]);setActiveTrackId(trackId);setActiveStepId(stepId??first?.step_id??null);setActiveId(placed.frameIds[0]??null);setSelectedIds(new Set())}catch(e){notify(t("timeline.moveFailed",{msg:(e as Error).message}))}}}
        onAddTrack={async()=>{await api.createTrack(timeline.axis.id,{name:t("timeline.defaultTrackName",{n:tracks.length+1})});void loadFrames()}}
        onPatchTrack={async(track,patch)=>{await api.patchTrack(track.id,patch);void loadFrames()}}
        onDeleteTrack={async(track)=>{if(await askConfirm(t("timeline.confirmDeleteTrack"))){await api.deleteTrack(track.id);void loadFrames()}}}
        onMoveTrack={async(track,delta)=>{const ordered=[...tracks].sort((a,b)=>a.idx-b.idx);const from=ordered.findIndex(x=>x.id===track.id),to=Math.max(0,Math.min(ordered.length-1,from+delta));if(from===to)return;const [x]=ordered.splice(from,1);ordered.splice(to,0,x);await api.reorderTracks(timeline.axis.id,ordered.map(x=>x.id));void loadFrames()}}
        onAddStep={async()=>{const {step}=await api.createStep(timeline.axis.id);setActiveStepId(step.id);void loadFrames()}}
        onDeleteStep={async()=>{if(activeStepId&&await askConfirm(t("timeline.confirmDeleteStep"))){await api.deleteStep(activeStepId);setActiveStepId(null);setActiveId(null);void loadFrames()}}}
        onStepDuration={async(duration)=>{if(activeStepId){await api.patchStep(activeStepId,{duration});void loadFrames()}}}
        onReorderSteps={async(from,to)=>{const ordered=[...steps];const [x]=ordered.splice(from,1);ordered.splice(to,0,x);await api.reorderSteps(timeline.axis.id,ordered.map(x=>x.id));void loadFrames()}}
        onContextMenu={(id,pos)=>onFrameContextMenu(id,pos,"timeline")}/>
      }

      {/* 批量操作条：多选 >=2 时浮出 */}
      <div className="batch-dock">
        <AnimatePresence>
          {selectedIds.size >= 2 && (
            <BatchBar
              count={selectedIds.size}
              onDelete={batchDelete}
              onDuplicate={batchDuplicate}
              onApplyDuration={batchSetDuration}
              onTrim={batchTrim}
              onClear={clearSelection}
            />
          )}
        </AnimatePresence>
      </div>

      {/* 帧右键菜单（帧列表/时间轴共用，单帧 or 多选批量） */}
      <AnimatePresence>
        {ctxMenu && (ctxBatch || ctxFrame) && (
          <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
        )}
      </AnimatePresence>

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

      <AnimatePresence>
        {replaceCrop && (
          <CropModal
            image={replaceCrop.image}
            title={replaceCrop.title}
            subtitle={t("msg.save_as_png")}
            onConfirm={confirmReplace}
            onClose={() => setReplaceCrop(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
