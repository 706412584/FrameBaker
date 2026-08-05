import { useEffect, useState } from "react";
import type { ServerConfig } from "@framebaker/shared";
import { api } from "./api";

// GET /api/config 的前端缓存：会话级缓存 + 订阅通知
// 设置页保存 provider/抠图配置后调 refreshServerConfig() 让所有 useServerConfig 处即时刷新
let cache: ServerConfig | null = null;
let inflight: Promise<ServerConfig | null> | null = null;
const listeners = new Set<(c: ServerConfig) => void>();

async function fetchConfig(): Promise<ServerConfig | null> {
  try {
    const cfg = await api.getConfig();
    cache = cfg;
    listeners.forEach((l) => l(cfg));
    return cfg;
  } catch (e) {
    console.error("获取服务端配置失败:", e);
    return null;
  }
}

/** 清缓存重拉 /api/config 并通知订阅者（设置保存后调用） */
export function refreshServerConfig(): Promise<ServerConfig | null> {
  cache = null;
  inflight = fetchConfig();
  return inflight;
}

/** 读取 GET /api/config（抠图引擎状态等），首次加载后缓存，refreshServerConfig 后自动更新 */
export function useServerConfig(): ServerConfig | null {
  const [cfg, setCfg] = useState<ServerConfig | null>(cache);
  useEffect(() => {
    if (!cache) {
      inflight ??= fetchConfig();
      inflight.then((c) => {
        if (c) setCfg(c);
      });
    }
    const l = (c: ServerConfig) => setCfg(c);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return cfg;
}
