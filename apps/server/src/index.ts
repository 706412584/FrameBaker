import { serve } from "bun";
import index from "../../web/index.html";
import { app } from "./app";
import { wsHandlers } from "./ws";

const port = Number(process.env.PORT ?? 3000);

serve({
  port,
  routes: {
    "/": index,
    "/project/:id": index, // 编辑器页复用同一 HTML，前端读 location.pathname
    "/materials": index, // 素材库页同
    "/settings": index, // 设置页同
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket 升级失败", { status: 400 });
    }
    return app.handle(req);
  },
  websocket: wsHandlers,
  // Bun 1.3 Windows 的浏览器 HMR 会打乱 PixiJS 聚合入口的循环依赖初始化顺序。
  // Windows 使用稳定的前端 bundle；bun --watch 仍会重启服务端，前端改动后手动刷新。
  development: process.env.NODE_ENV !== "production" && process.platform !== "win32",
});

console.log(`FrameBaker → http://localhost:${port}`);
