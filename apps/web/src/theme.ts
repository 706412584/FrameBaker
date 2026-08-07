import { useEffect, useState } from "react";
import { api } from "./api";

// ---- 主题管理：data-theme 挂在 <html> 上 ----
// 三种模式：跟随系统（localStorage 无记录）/ 浅色 / 深色（手动选择）
// 持久化双写：localStorage（首屏防闪烁即时缓存）+ 服务端 settings 表（权威，换浏览器/重启不丢）
// 加载顺序：index.html 内联脚本读 localStorage 定首屏 → initThemeSync() 拉服务端值覆盖
// 服务端不可达时静默降级为纯 localStorage 行为

export type Theme = "dark" | "light";
/** system = 跟随系统（prefers-color-scheme），此时 localStorage 无记录 */
export type ThemeMode = "system" | Theme;

export const THEME_KEY = "framebaker-theme";

const listeners = new Set<(t: Theme) => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function systemTheme(): Theme {
  return media.matches ? "dark" : "light";
}

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* 隐私模式等场景按跟随系统处理 */
  }
  return "system";
}

export function getTheme(): Theme {
  // 以 <html data-theme> 为准（首屏内联脚本已设置好）
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** 应用主题；persist=true 时写入 localStorage（= 用户手动选择，此后不再跟随系统） */
function applyTheme(t: Theme, persist: boolean) {
  document.documentElement.dataset.theme = t;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((l) => l(t));
}

/** 切换模式；sync=true 时同时 PUT 服务端（用户主动切换），sync=false 用于应用服务端值（避免回写循环） */
function applyMode(mode: ThemeMode, sync: boolean) {
  if (mode === "system") {
    try {
      localStorage.removeItem(THEME_KEY);
    } catch {
      /* ignore */
    }
    applyTheme(systemTheme(), false);
  } else {
    applyTheme(mode, true);
  }
  if (sync) {
    api.putSetting("theme", mode).catch(() => {
      /* 静默降级：服务端不可达时仅本地 */
    });
  }
}

export function setThemeMode(mode: ThemeMode) {
  applyMode(mode, true);
}

/** 三态循环：跟随系统 → 浅色 → 深色 → 跟随系统 */
export function cycleThemeMode() {
  const order: ThemeMode[] = ["system", "light", "dark"];
  const cur = getThemeMode();
  setThemeMode(order[(order.indexOf(cur) + 1) % order.length]);
}

// 系统主题变化：仅「跟随系统」模式（localStorage 无记录）下实时跟随
media.addEventListener("change", (e) => {
  if (getThemeMode() === "system") {
    applyTheme(e.matches ? "dark" : "light", false);
  }
});

let serverThemeLoaded = false;

/** 启动后拉服务端主题（权威值），与本地不同则覆盖并同步 localStorage 缓存；失败静默 */
export function initThemeSync() {
  if (serverThemeLoaded) return;
  serverThemeLoaded = true;
  api
    .getSettings()
    .then((s) => {
      const v = s["theme"];
      if (v === "system" || v === "light" || v === "dark") {
        if (v !== getThemeMode()) applyMode(v, false);
      }
    })
    .catch(() => {
      /* 静默降级 */
    });
}

export function onThemeChange(l: (t: Theme) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React hook：订阅当前解析后的主题 */
export function useTheme(): Theme {
  const [t, setT] = useState<Theme>(getTheme);
  useEffect(() => onThemeChange(setT), []);
  return t;
}

/** 从 CSS 变量读取画布相关颜色（data-theme 切换后同步生效） */
export function canvasColors(): { bg: string; grid: string; cross: string } {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--canvas-bg", "#25292e"),
    grid: read("--border", "#3a3f45"),
    cross: read("--purple", "#bd93f9"),
  };
}

/** 帧来源边框色：浅色主题下用 color-mix 加深以保持辨识度 */
export function themedSourceColor(color: string, theme: Theme): string {
  return theme === "light" ? `color-mix(in srgb, ${color} 62%, black)` : color;
}
