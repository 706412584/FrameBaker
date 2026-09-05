// Windows 打包（两产物）：
// 1. 便携版 zip —— bun build --compile 后端单 exe（FrameBaker-server.exe）+ resources/，浏览器访问
// 2. 桌面版安装包 —— electron-builder NSIS：Electron 壳（desktop/main.cjs）拉起后端 exe，双击即窗口
//
// 内置 sprite 抠图工坊（resources/sprite/）：源码 + 轻量 venv（chroma/spriteflow/luma/PSD/UI 分析开箱即用）；
// BiRefNet / rembg 等重 AI 依赖不进包，桌面版内「AI 引擎安装器」按需装到 exe 旁 ai-engine/。
//
// 用法：
//   bun scripts/package-windows.ts            # 全流程
//   bun scripts/package-windows.ts --skip-web # 跳过前端构建（调试打包时用）
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RELEASE_DIR = join(ROOT, "release", "framebaker-win");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const SKIP_WEB = process.argv.includes("--skip-web");
/** sprite 工坊源仓库（内置资源来源）；缺省用 settings 表 spriteMatting 的 cliPath 反推 */
const SPRITE_ROOT = (() => {
  const direct = process.env.FRAMEBAKER_SPRITE_ROOT?.trim();
  if (direct) return direct;
  try {
    const db = new (require("bun:sqlite").Database)(join(ROOT, "storage", "framebaker.db"), { readonly: true });
    const row = db.query("SELECT value FROM settings WHERE key='spriteMatting'").get() as { value: string } | undefined;
    db.close();
    const cliPath = row ? (JSON.parse(row.value) as { cliPath?: string }).cliPath : undefined;
    if (cliPath) return require("node:path").dirname(cliPath);
  } catch {
    /* settings 未配置 */
  }
  return null;
})();

function log(message: string) {
  console.log(`[framebaker] ${message}`);
}

async function run(command: string, args: string[], options: { env?: Record<string, string> } = {}) {
  const proc = Bun.spawn([command, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: options.env ? { ...process.env, ...options.env } : undefined,
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} 退出码 ${code}`);
}

async function buildWeb() {
  log("构建前端（index.html + chunk + worker + pixi 复制）...");
  // 与服务端 index.ts buildFrontend 同参数，保证产物 chunk 命名一致
  const out = await Bun.build({
    entrypoints: [join(ROOT, "apps", "web", "index.html")],
    target: "browser",
    outdir: join(RELEASE_DIR, "resources", "web"),
  });
  if (!out.success) throw new Error(`前端构建失败: ${out.logs.map((l) => String(l)).join("\n")}`);

  // imageOps worker：同款参数单独构建（服务端 app.ts 在打包模式直接读该文件下发）
  const worker = await Bun.build({
    entrypoints: [join(ROOT, "apps", "web", "src", "imageops", "imageOps.worker.ts")],
    target: "browser",
    format: "esm",
    outdir: join(RELEASE_DIR, "resources", "web"),
    naming: { entry: "imageOps.worker.js" },
  });
  if (!worker.success) throw new Error(`worker 构建失败: ${worker.logs.map((l) => String(l)).join("\n")}`);
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows 打包需要在 Windows 环境执行");

  // 前置检查
  const pixiSrc = join(ROOT, "apps", "web", "node_modules", "pixi.js", "dist", "pixi.min.js");
  const comfyDir = join(ROOT, "apps", "server", "graph", "comfy");
  if (!existsSync(pixiSrc)) throw new Error(`pixi.min.js 不存在（${pixiSrc}），请先 bun install`);
  if (!existsSync(comfyDir)) throw new Error(`comfy 脚本目录不存在（${comfyDir}）`);

  // --skip-web：保留已有 resources/web 前端产物（本地调试迭代 exe 用）；
  // 完整打包则清空整个产物目录重来。
  if (SKIP_WEB) {
    if (!existsSync(join(RELEASE_DIR, "resources", "web", "index.html"))) {
      throw new Error("--skip-web 但 resources/web 无前端产物，请先完整打包一次");
    }
  } else {
    rmSync(RELEASE_DIR, { recursive: true, force: true });
  }
  mkdirSync(join(RELEASE_DIR, "resources"), { recursive: true });

  if (!SKIP_WEB) await buildWeb();

  log("复制静态资源（fonts / pixi / comfy 脚本）...");
  cpSync(join(ROOT, "apps", "web", "public", "fonts"), join(RELEASE_DIR, "resources", "fonts"), { recursive: true });
  mkdirSync(join(RELEASE_DIR, "resources", "vendor"), { recursive: true });
  cpSync(pixiSrc, join(RELEASE_DIR, "resources", "vendor", "pixi.min.js"));
  cpSync(comfyDir, join(RELEASE_DIR, "resources", "comfy"), { recursive: true });

  // 内置 sprite 抠图工坊：源码（位置无关，ROOT_DIR 由 __file__ 派生）+ 可重定位 venv。
  // venv 剔除 __pycache__ 减体积；AI 模型（2.7G huggingface）不进包。
  log("内置 sprite 抠图工坊（源码 + 轻量 venv）...");
  if (SPRITE_ROOT && existsSync(join(SPRITE_ROOT, "matte_cli.py"))) {
    const spriteDst = join(RELEASE_DIR, "resources", "sprite");
    mkdirSync(spriteDst, { recursive: true });
    cpSync(join(SPRITE_ROOT, "matte_cli.py"), join(spriteDst, "matte_cli.py"));
    cpSync(join(SPRITE_ROOT, "server.py"), join(spriteDst, "server.py"));
    cpSync(join(SPRITE_ROOT, "sprite_lab"), join(spriteDst, "sprite_lab"), {
      recursive: true,
      filter: (src) => !src.includes("__pycache__"),
    });
    const venvSrc = join(SPRITE_ROOT, "work", "models", "venv");
    if (existsSync(venvSrc)) {
      cpSync(venvSrc, join(spriteDst, "venv"), {
        recursive: true,
        filter: (src) => !src.includes("__pycache__") && !/\\Scripts\\[a-z-]+\.exe$/.test(src) || /python[^\\]*\.exe$/i.test(src),
      });
    } else {
      log("  警告：sprite venv 缺失，内置工坊只有源码（chroma 等管线需要 venv）");
    }
    log("  已内置（设置页未配置时自动启用）");
  } else {
    log("  未找到 sprite 工坊源（FRAMEBAKER_SPRITE_ROOT 或 settings.spriteMatting），跳过内置");
  }

  log("编译骨骼烘焙 runner（build_binding_and_bake.exe）...");
  await run("bun", [
    "build", join(ROOT, "apps", "server", "build_binding_and_bake.ts"),
    "--compile",
    "--outfile", join(RELEASE_DIR, "resources", "bin", "build_binding_and_bake.exe"),
  ]);

  log("编译后端服务（FrameBaker-server.exe，注入 FRAMEBAKER_PACKAGED=1）...");
  await run("bun", [
    "build", join(ROOT, "apps", "server", "src", "index.ts"),
    "--compile",
    "--define", "process.env.FRAMEBAKER_PACKAGED='1'",
    "--outfile", join(RELEASE_DIR, "FrameBaker-server.exe"),
  ]);

  // 预置初始配置：从源码版 storage/framebaker.db 只拷 settings 表（生成 provider / spriteMatting /
  // comfyLocal 等），不拷项目/素材用户数据。落位 resources/default-settings.db ——
  // 后端 db.ts 首次启动（用户数据目录无库）时 INSERT OR IGNORE 预置，升级/已有数据绝不覆盖。
  // 用户数据本体（storage/）在 userData（壳注入 FRAMEBAKER_DATA_DIR），重装/卸载不丢。
  log("继承源码版 settings 表（生成 provider / 抠图 CLI / ComfyUI 等配置）...");
  const sourceDb = join(ROOT, "storage", "framebaker.db");
  if (existsSync(sourceDb)) {
    const { Database } = await import("bun:sqlite");
    const src = new Database(sourceDb, { readonly: true });
    try {
      const rows = src.query("SELECT key, value, updated_at FROM settings").all() as Array<{
        key: string; value: string; updated_at: number;
      }>;
      const settingsDbPath = join(RELEASE_DIR, "resources", "default-settings.db");
      // --skip-web 复用产物目录时清掉上次生成的 db，避免 UNIQUE 冲突
      rmSync(settingsDbPath, { force: true });
      rmSync(settingsDbPath + "-shm", { force: true });
      rmSync(settingsDbPath + "-wal", { force: true });
      const dst = new Database(settingsDbPath, { create: true });
      try {
        dst.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        const insert = dst.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
        dst.transaction(() => rows.forEach((r) => insert.run(r.key, r.value, r.updated_at)))();
      } finally {
        dst.close();
      }
      log(`  已预置 ${rows.length} 项配置 → resources/default-settings.db`);
    } finally {
      src.close();
    }
  } else {
    log("  源码版无 storage/framebaker.db，跳过（新装机从空配置开始）");
  }

  // installer.nsh：仅声明自定义宏壳（初始配置已改由后端 db.ts 首启预置，不再在安装期释放 db，
  // 彻底杜绝安装器写用户数据位置）。
  await Bun.write(
    join(ROOT, "build", "installer.nsh"),
    `; 本文件由 package-windows.ts 生成 —— 手改会被覆盖。
; 用户数据（storage / ai-engine）均在 %APPDATA%/framebaker（壳注入 env），安装器不触碰；
; 初始 settings 由后端首启从 resources/default-settings.db 预置（INSERT OR IGNORE，不覆盖已有数据）。
!macro customInstall
!macroend
`
  );

  log("打包 zip...");
  const zipPath = join(ROOT, "release", `FrameBaker-win-${pkg.version}-portable.zip`);
  await run("powershell.exe", [
    "-NoProfile", "-Command",
    `if (Test-Path -LiteralPath '${zipPath}') { Remove-Item -LiteralPath '${zipPath}' -Force }; ` +
      `Compress-Archive -Path '${RELEASE_DIR}\\*' -DestinationPath '${zipPath}' -Force`,
  ]);

  // 桌面版安装包（electron-builder NSIS）：壳拉起 resources/FrameBaker-server.exe。
  // 便携版 zip 直接运行 FrameBaker-server.exe 仍是纯服务器模式（浏览器访问）。
  log("生成桌面版安装包（electron-builder）...");
  if (!existsSync(join(ROOT, "build", "installer-icon.ico"))) {
    await run("bun", [join(ROOT, "scripts", "make-installer-icon.ts")]);
  }
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  await run(npxCmd, [
    "electron-builder", "--win", "nsis", "--publish", "never",
    "-c.extraMetadata.version=" + pkg.version,
  ], {
    env: {
      // GitHub 下载 Electron 二进制走代理（layout-editor 同款回退）
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
    },
  });

  // 产物清单
  log("打包完成：");
  const exeSize = (statSync(join(RELEASE_DIR, "FrameBaker-server.exe")).size / 1024 / 1024).toFixed(1);
  log(`  便携版: ${zipPath}`);
  log(`    解压后运行 FrameBaker-server.exe（浏览器访问 http://localhost:5842）`);
  const setupExe = join(ROOT, "release", "desktop", `FrameBaker Setup ${pkg.version}.exe`);
  log(`  桌面版: ${existsSync(setupExe) ? setupExe : join(ROOT, "release", "desktop")}`);
  log(`    安装后双击 FrameBaker 即开窗口（Electron 壳自动拉起后端）`);
}

main().catch((error) => {
  console.error(`[framebaker] 打包失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
