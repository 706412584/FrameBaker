// 运行时路径解析：源码运行（bun dev/start）与单文件打包（bun build --compile）两种模式共用。
// 打包模式下 import.meta.dir 指向临时解包目录（Bun 单文件 exe 运行时自解压），不能再用相对路径
// 定位仓库资源 —— 必须用 process.execPath（exe 实际所在）找 exe 旁的 resources/ 目录。
import { cpSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 打包模式判定：单文件 exe 内 Bun 会注入环境变量 BUN_RUNTIME_INSTALL_PATH，
 * 且 app.ts 的 import.meta.dir 位于临时解包目录（含 bun-vfs 标记）。
 * 用编译期常量判断最稳 —— 打包脚本会注入 FRAMEBAKER_PACKAGED=1。
 */
export const PACKAGED = process.env.FRAMEBAKER_PACKAGED === "1";

/** exe 或源码入口所在目录 */
const BINARY_DIR = PACKAGED ? dirname(process.execPath) : undefined;

/** 数据根：源码运行=仓库根；打包=exe 旁（数据随 exe 走，拷目录即迁移） */
export const APP_ROOT = PACKAGED ? BINARY_DIR! : join(import.meta.dir, "..", "..", "..");

/**
 * 用户数据根（storage/ 落位处）。
 * 桌面版：Electron 壳注入 FRAMEBAKER_DATA_DIR = userData/data（%APPDATA%/framebaker/data）
 *   —— 安装目录会被 NSIS 升级/卸载清理（实测），用户数据必须放安装器不碰的位置。
 * 便携版（无壳，env 未注入）：exe 旁 data/（无安装器，无清理问题）。
 * 源码运行：仓库根（storage/ 在仓库内，行为不变）。
 */
export const DATA_ROOT = process.env.FRAMEBAKER_DATA_DIR?.trim()
  || (PACKAGED ? join(BINARY_DIR!, "data") : APP_ROOT);

/**
 * 打包版一次性迁移：旧版数据曾落 $INSTDIR/resources/storage（安装目录内，重装即丢）。
 * 首次以新布局启动时若 data/ 无库且旧位置有 → 整目录搬迁，用户无感。
 */
export function migrateLegacyStorage(): void {
  if (!PACKAGED) return;
  const newDb = join(DATA_ROOT, "storage", "framebaker.db");
  if (existsSync(newDb)) return;
  const legacyDir = join(BINARY_DIR!, "storage");
  const legacyDb = join(legacyDir, "framebaker.db");
  const nestedLegacy = join(BINARY_DIR!, "resources", "storage");
  const source = existsSync(legacyDb) ? legacyDir : existsSync(join(nestedLegacy, "framebaker.db")) ? nestedLegacy : null;
  if (!source) return;
  try {
    renameSync(source, join(DATA_ROOT, "storage"));
  } catch {
    // 跨盘 rename 失败 → 递归复制
    cpSync(source, join(DATA_ROOT, "storage"), { recursive: true });
  }
}

/** 静态资源根：源码运行=仓库根；打包=exe 旁 resources/ */
export const RESOURCES_ROOT = PACKAGED ? join(BINARY_DIR!, "resources") : APP_ROOT;

/** Web 前端静态产物目录（index.html 入口与 JS/CSS chunk） */
export const WEB_DIST_ROOT = PACKAGED
  ? join(RESOURCES_ROOT, "web")
  : join(import.meta.dir, "..", "..", "web");

/** apps/web/public/fonts（源码结构 apps/server/src → ../../web/public/fonts） */
export const FONTS_ROOT = PACKAGED
  ? join(RESOURCES_ROOT, "fonts")
  : join(import.meta.dir, "..", "..", "web", "public", "fonts");

/** pixi.min.js（源码运行时从 web/node_modules 取；打包时复制到 resources/vendor） */
export const PIXI_BUNDLE_PATH = PACKAGED
  ? join(RESOURCES_ROOT, "vendor", "pixi.min.js")
  : join(import.meta.dir, "..", "..", "web", "node_modules", "pixi.js", "dist", "pixi.min.js");

/** imageOps worker 预构建产物（打包时复制到 resources/web；源码运行时按需 Bun.build） */
export const WORKER_PREBUILT_PATH = PACKAGED
  ? join(RESOURCES_ROOT, "web", "imageOps.worker.js")
  : null;

/** comfy/python 脚本目录（comfy_qwen_layered.py 等；源码在 apps/server/graph/comfy） */
export const COMFY_SCRIPTS_ROOT = PACKAGED
  ? join(RESOURCES_ROOT, "comfy")
  : join(import.meta.dir, "..", "..", "graph", "comfy");

/**
 * 内置 sprite 抠图工坊（打包版自带：resources/sprite/ 下 matte_cli.py + server.py + sprite_lab/ + venv/）。
 * 源码运行不内置（走设置页 spriteMatting 指向外部 sprite 仓库）。
 * venv 可重定位（Windows venv 为复制型，已实测 chroma 管线在任意目录跑通）。
 */
export const BUNDLED_SPRITE_ROOT = PACKAGED ? join(RESOURCES_ROOT, "sprite") : null;
export const BUNDLED_SPRITE_PYTHON = BUNDLED_SPRITE_ROOT ? join(BUNDLED_SPRITE_ROOT, "venv", "Scripts", "python.exe") : null;
export const BUNDLED_SPRITE_CLI = BUNDLED_SPRITE_ROOT ? join(BUNDLED_SPRITE_ROOT, "matte_cli.py") : null;

/**
 * 按需安装的 AI 抠图引擎（BiRefNet + rembg）根目录。
 * 桌面版：Electron 壳注入 FRAMEBAKER_AI_ENGINE_DIR = userData/ai-engine ——
 *   NSIS 升级会清 $INSTDIR（实测），userData（%APPDATA%/framebaker）是安装器不碰的唯一位置。
 * 便携版（无壳，env 未注入）：exe 旁 ai-engine/（无安装器，无清理问题）。
 * 源码运行：仓库 .ai-engine/（「AI 引擎安装器」在 dev 模式的落位）。
 */
export const AI_ENGINE_ROOT = process.env.FRAMEBAKER_AI_ENGINE_DIR?.trim()
  || (PACKAGED ? join(BINARY_DIR!, "..", "ai-engine") : join(APP_ROOT, ".ai-engine"));
export const AI_ENGINE_PYTHON = AI_ENGINE_ROOT ? join(AI_ENGINE_ROOT, "venv-ai", "Scripts", "python.exe") : null;
export const AI_ENGINE_MODELS = AI_ENGINE_ROOT ? join(AI_ENGINE_ROOT, "models") : null;

/** 骨骼烘焙 TS 脚本（源码 apps/server/build_binding_and_bake.ts；打包为独立 exe 放 resources/bin） */
export const BAKE_RUNNER = PACKAGED
  ? join(RESOURCES_ROOT, "bin", "build_binding_and_bake.exe")
  : join(import.meta.dir, "..", "..", "build_binding_and_bake.ts");

/** 供健康自检：打包完整性（缺 resources 时启动即报可读错误，而不是莫名 ENOENT） */
export function assertPackagedResources(): string | null {
  if (!PACKAGED) return null;
  const missing = [WEB_DIST_ROOT, FONTS_ROOT, PIXI_BUNDLE_PATH, COMFY_SCRIPTS_ROOT, BAKE_RUNNER].filter((p) => !existsSync(p));
  return missing.length ? `打包资源缺失：${missing.join("；")}（resources 目录须与 FrameBaker.exe 同目录）` : null;
}
