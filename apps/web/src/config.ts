import { useEffect, useState } from "react";
import type { ServerConfig } from "@framebaker/shared";
import { api } from "./api";

// GET /api/config 的前端缓存（引擎探测服务端已缓存，这里会话级缓存即可）
let cache: ServerConfig | null = null;
let inflight: Promise<ServerConfig | null> | null = null;

async function fetchConfig(): Promise<ServerConfig | null> {
  try {
    const cfg = await api.getConfig();
    cache = cfg;
    return cfg;
  } catch (e) {
    console.error("获取服务端配置失败:", e);
    return null;
  }
}

/** 读取 GET /api/config（抠图引擎状态等），首次加载后缓存 */
export function useServerConfig(): ServerConfig | null {
  const [cfg, setCfg] = useState<ServerConfig | null>(cache);
  useEffect(() => {
    if (cache) return;
    inflight ??= fetchConfig();
    inflight.then((c) => {
      if (c) setCfg(c);
    });
  }, []);
  return cfg;
}
