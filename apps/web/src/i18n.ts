import { useEffect, useState } from "react";
import { api } from "./api";
import { EN } from "./i18n/en";

// ---- 界面语言管理：zh（默认）/ en ----
// 中文即字典 key：t("新建项目")，zh 直接返回 key，en 查 i18n/en.ts，缺失回退 key（可增量翻译）
// 插值用 {name} 占位符：t("删除失败: {msg}", { msg })；未提供的占位符原样保留
// 持久化双写：localStorage（首屏防闪烁即时缓存）+ 服务端 settings 表（权威），加载顺序同 theme.ts
// 组件用法：const t = useT(); 之后 JSX / notify / askConfirm 里全部走 t(...)

export type Lang = "zh" | "en";

export const LANG_KEY = "framebaker-lang";

const TITLES: Record<Lang, string> = {
  zh: "FrameBaker · 像素逐帧动画编辑器",
  en: "FrameBaker · Pixel Frame-by-Frame Editor",
};

const listeners = new Set<(l: Lang) => void>();

// 当前语言以 <html lang> 为准（首屏内联脚本已按 localStorage 设置好）
export function getLang(): Lang {
  return document.documentElement.lang === "en" ? "en" : "zh";
}

/** toLocaleString 用的 locale 串 */
export function getLocale(): string {
  return getLang() === "en" ? "en-US" : "zh-CN";
}

function applyLang(l: Lang, persist: boolean) {
  document.documentElement.lang = l === "en" ? "en" : "zh-CN";
  document.title = TITLES[l];
  if (persist) {
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((fn) => fn(l));
}

/** 切换语言；sync=true 时同时 PUT 服务端（用户主动切换），sync=false 用于应用服务端值（避免回写循环） */
function applyMode(l: Lang, sync: boolean) {
  applyLang(l, true);
  if (sync) {
    api.putSetting("lang", l).catch(() => {
      /* 静默降级：服务端不可达时仅本地 */
    });
  }
}

export function setLang(l: Lang) {
  if (l === getLang()) return;
  applyMode(l, true);
}

let serverLangLoaded = false;

/** 启动后拉服务端语言（权威值），与本地不同则覆盖并同步 localStorage 缓存；失败静默 */
export function initLangSync() {
  if (serverLangLoaded) return;
  serverLangLoaded = true;
  document.title = TITLES[getLang()]; // index.html 的静态 title 先按首屏语言纠正
  api
    .getSettings()
    .then((s) => {
      const v = s["lang"];
      if (v === "zh" || v === "en") {
        if (v !== getLang()) applyMode(v, false);
      }
    })
    .catch(() => {
      /* 静默降级 */
    });
}

export function onLangChange(l: (lang: Lang) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React hook：订阅当前语言 */
export function useLang(): Lang {
  const [l, setL] = useState<Lang>(getLang);
  useEffect(() => onLangChange(setL), []);
  return l;
}

function interp(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** 翻译：zh 返回 key 本身，en 查字典（缺失回退 key），再做 {param} 插值 */
export function t(key: string, params?: Record<string, string | number>): string {
  const s = getLang() === "en" ? (EN[key] ?? key) : key;
  return interp(s, params);
}

/** React hook：订阅语言变化并返回 t（语言切换时组件自动重渲染） */
export function useT() {
  useLang(); // 仅为订阅重渲染
  return t;
}
