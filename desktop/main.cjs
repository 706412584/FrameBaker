// FrameBaker Electron 桌面壳：拉起后端（打包产物 FrameBaker-server.exe / 开发模式 bun dev）
// → 等端口就绪 → BrowserWindow 加载 localhost → 退出时杀后端。
// 参照 layout-editor main.cjs 的关键实践：单例锁、GUI 进程 PATH 修复、后台进程日志。
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Windows GUI 应用可能不继承完整用户 PATH（影响后端 spawn python 等），补 System32
if (process.platform === "win32") {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "Path";
  const currentPath = process.env[pathKey] || "";
  if (!currentPath.toLowerCase().includes("system32")) {
    process.env[pathKey] = [system32, systemRoot, currentPath].filter(Boolean).join(";");
  }
}

const PORT = Number(process.env.FRAMEBAKER_PORT ?? 5842);
const URL = `http://localhost:${PORT}`;
const IS_PACKAGED_APP = app.isPackaged; // electron-builder 产物（resources/app.asar）
const IS_COMPILED = !!process.env.FRAMEBAKER_COMPILED; // 壳内直接编译运行（开发调试）

// 后端可执行文件：electron-builder 产物布局 resources/FrameBaker-server.exe
function backendCommand() {
  if (IS_PACKAGED_APP) {
    const exe = path.join(process.resourcesPath, "FrameBaker-server.exe");
    if (!fs.existsSync(exe)) throw new Error(`后端缺失：${exe}`);
    return { cmd: exe, args: [] };
  }
  // 开发模式：仓库根 bun 跑服务端（NODE_ENV=production 关掉 HMR）
  const root = path.resolve(__dirname, "..");
  return { cmd: "bun", args: [path.join(root, "apps", "server", "src", "index.ts")] };
}

// 单实例锁：二次启动聚焦已有窗口（同时避免两个后端抢端口）
const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

let backend = null;
let mainWindow = null;

function startBackend() {
  const { cmd, args } = backendCommand();
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, "server.log"), { flags: "a" });
  // 用户数据（项目/素材/settings 库）落 userData/data：安装目录会被 NSIS 升级/卸载清理（实测），
  // 用户数据放安装器不碰的位置 —— 重装只更新代码不动数据。AI 引擎同理在 userData/ai-engine。
  const dataDir = path.join(app.getPath("userData"), "data");
  const aiEngineDir = path.join(app.getPath("userData"), "ai-engine");
  backend = spawn(cmd, args, {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      FRAMEBAKER_DATA_DIR: dataDir,
      FRAMEBAKER_AI_ENGINE_DIR: aiEngineDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  backend.stdout.on("data", (c) => logStream.write(c));
  backend.stderr.on("data", (c) => logStream.write(c));
  backend.on("exit", () => {
    backend = null;
    // 后端意外退出（非用户关窗）时退出壳，避免白窗口挂着
    if (!app.isQuitting) app.quit();
  });
}

function stopBackend() {
  if (!backend) return;
  app.isQuitting = true;
  // Windows 上杀进程树（后端还会 spawn python/ffmpeg 子进程）
  try {
    spawn("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { windowsHide: true });
  } catch {
    backend.kill();
  }
  backend = null;
}

/** 端口就绪轮询（后端启动含 Bun.build 前端，需数秒） */
function waitForServer(timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (Date.now() - started > timeoutMs) return reject(new Error("后端启动超时"));
      try {
        const res = await fetch(`${URL}/api/config`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return resolve();
      } catch {
        /* not ready yet */
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false, // 等加载完成再 show，避免白屏闪烁
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "installer-icon.ico"),
    title: "FrameBaker",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 外部链接（文档等）走系统浏览器，不在应用窗口内导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) shell.openExternal(url);
    return { action: "deny" };
  });

  try {
    await waitForServer();
    await mainWindow.loadURL(URL);
  } catch (error) {
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<body style="font-family:system-ui;padding:40px;background:#1a1623;color:#ffcd4a">
       <h2>FrameBaker 后端启动失败</h2><pre>${String(error?.message ?? error)}</pre>
       <p>日志位于 ${path.join(app.getPath("userData"), "logs", "server.log")}</p></body>`
    )}`);
  }
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", stopBackend);
app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});
