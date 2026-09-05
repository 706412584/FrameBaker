import { serve, build } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "./app";
import { wsHandlers } from "./ws";
import { assertPackagedResources, PACKAGED, WEB_DIST_ROOT } from "./paths";

const port = Number(process.env.PORT ?? 5842);

interface FrontendFile {
  bytes: Uint8Array;
  type: string;
}

interface FrontendBundle {
  files: Map<string, FrontendFile>;
  htmlEntry: FrontendFile;
}

/** Response 工厂：body 只能消费一次，路由共享必须每次新建 */
const fileResponse = (f: FrontendFile) =>
  new Response(f.bytes, { headers: { "Content-Type": f.type, "Cache-Control": "no-store" } });

const contentTypeOf = (path: string) =>
  path.endsWith(".html")
    ? "text/html; charset=utf-8"
    : path.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".woff2")
          ? "font/woff2"
          : "application/octet-stream";

// Windows 下 `import index from html` 的编译期打包产物不随前端源码更新
// （bun --watch 只追踪服务端模块图，html→js 依赖链不在其中，重启进程仍返回旧 bundle —— 实测）。
// 改为启动时显式 Bun.build 全量构建前端，产物内存持有 + 静态路由：
// 任何前端改动重启 dev 服务即可生效。
async function buildFrontend(): Promise<FrontendBundle> {
  const indexHtml = [import.meta.dir, "..", "..", "web", "index.html"].join("/").replace(/\\/g, "/");
  const out = await build({
    entrypoints: [indexHtml],
    target: "browser",
  });
  const files = new Map<string, FrontendFile>();
  for (const artifact of out.outputs) {
    // 产物名（chunk-xxx.js / index.html / css / 字体）按文件名挂在根路径下
    const path = "/" + String(artifact.path).split("/").pop()!;
    const bytes = new Uint8Array(await artifact.arrayBuffer());
    files.set(path, { bytes, type: contentTypeOf(path) });
  }
  const htmlPair = [...files.entries()].find(([p]) => p.endsWith(".html"));
  const htmlEntry = htmlPair?.[1];
  if (!htmlEntry) throw new Error("前端构建产物缺少 html 入口");
  return { files, htmlEntry };
}

/** 打包模式：index.html 启动读盘；chunk/字体按请求懒读（产物目录即白名单，css 内部 url() 引用也能命中） */
function loadPackagedFrontend(): FrontendBundle {
  const htmlPath = join(WEB_DIST_ROOT, "index.html");
  if (!existsSync(htmlPath)) throw new Error(`打包资源缺失：${htmlPath}`);
  const files = new Map<string, FrontendFile>();
  files.set("/index.html", { bytes: new Uint8Array(readFileSync(htmlPath)), type: "text/html; charset=utf-8" });
  return { files, htmlEntry: files.get("/index.html")! };
}

/** 打包模式静态文件懒读：路径必须在产物目录内（防目录穿越） */
function readPackagedAsset(pathname: string): FrontendFile | null {
  const name = pathname.replace(/^\//, "");
  if (!/^[\w.-]+\.(js|css|woff2|png|svg|ico)$/.test(name)) return null;
  const p = join(WEB_DIST_ROOT, name);
  if (!p.startsWith(WEB_DIST_ROOT) || !existsSync(p)) return null;
  return { bytes: new Uint8Array(readFileSync(p)), type: contentTypeOf(name) };
}

const resourceError = assertPackagedResources();
if (resourceError) {
  console.error(resourceError);
  process.exit(1);
}

const bundlePromise: Promise<FrontendBundle> | FrontendBundle = PACKAGED
  ? loadPackagedFrontend()
  : buildFrontend();

const SPA_ROUTES = ["/", "/project/:id", "/materials", "/motions", "/graphs", "/settings"];

const serveHtmlEntry = () => Promise.resolve(bundlePromise).then((b) => fileResponse(b.htmlEntry));

serve({
  port,
  routes: Object.fromEntries(SPA_ROUTES.map((r) => [r, () => serveHtmlEntry()])),
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket 升级失败", { status: 400 });
    }
    // 前端静态产物（JS/CSS chunk）：打包模式懒读盘，源码模式内存表
    const b = await bundlePromise;
    const hit = b.files.get(url.pathname) ?? (PACKAGED ? readPackagedAsset(url.pathname) : null);
    if (hit) return fileResponse(hit);
    return app.handle(req);
  },
  websocket: wsHandlers,
  // Bun 1.3 Windows 的浏览器 HMR 会打乱 PixiJS 聚合入口的循环依赖初始化顺序。
  // Windows 使用稳定的前端 bundle；前端改动后重启 dev 服务（上方显式 build 保证拿到新代码）。
  development: process.env.NODE_ENV !== "production" && process.platform !== "win32",
});

console.log(`FrameBaker → http://localhost:${port}${PACKAGED ? "（打包模式）" : ""}`);
