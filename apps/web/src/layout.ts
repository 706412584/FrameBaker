import { api } from "./api";

// 编辑器布局尺寸（帧列表宽度 / 时间轴高度）：
// 服务端 settings 表持久化（换浏览器/重启不丢）；localStorage 仅作首屏即时缓存避免跳动
// 加载顺序：localStorage 立即渲染 → 拿到服务端值后覆盖；写入时双写（服务端防抖 ~500ms）
// 服务端不可达时静默降级为纯 localStorage 行为

export interface LayoutState {
  sidebarW: number;
  timelineH: number;
}

export const LAYOUT_DEFAULTS: LayoutState = { sidebarW: 240, timelineH: 140 };
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const TIMELINE_MIN = 80;
export const TIMELINE_MAX = 320;

const KEY = "framebaker-layout";

export const clampSidebarW = (v: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(v)));
export const clampTimelineH = (v: number) => Math.min(TIMELINE_MAX, Math.max(TIMELINE_MIN, Math.round(v)));

function clampLayout(j: Partial<LayoutState>): LayoutState {
  return {
    sidebarW: clampSidebarW(typeof j.sidebarW === "number" ? j.sidebarW : LAYOUT_DEFAULTS.sidebarW),
    timelineH: clampTimelineH(typeof j.timelineH === "number" ? j.timelineH : LAYOUT_DEFAULTS.timelineH),
  };
}

/** 首屏同步读取（仅 localStorage，保证立即渲染不跳动） */
export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return clampLayout(JSON.parse(raw) as Partial<LayoutState>);
  } catch {
    /* 损坏数据回落默认 */
  }
  return { ...LAYOUT_DEFAULTS };
}

let syncTimer: number | null = null;

/** 双写：localStorage 立即 + 防抖 PUT 服务端 */
export function saveLayout(l: LayoutState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
  if (syncTimer !== null) clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    api.putSetting("layout", l).catch(() => {
      /* 静默降级：服务端不可达时仅本地 */
    });
  }, 500);
}

/** 启动后拉服务端布局（权威值）；成功则同时刷新 localStorage 缓存。失败静默返回 null */
export async function fetchServerLayout(): Promise<LayoutState | null> {
  try {
    const s = await api.getSettings();
    const j = s["layout"];
    if (j && typeof j === "object") {
      const v = clampLayout(j as Partial<LayoutState>);
      try {
        localStorage.setItem(KEY, JSON.stringify(v));
      } catch {
        /* ignore */
      }
      return v;
    }
  } catch {
    /* 静默降级 */
  }
  return null;
}
