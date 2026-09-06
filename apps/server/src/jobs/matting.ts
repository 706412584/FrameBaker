import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MattingEngine } from "@framebaker/shared";
import { db, getFrame, getMaterial, REPO_ROOT, STORAGE_ROOT, uid } from "../db";
import { getMattingSettings, getSpriteMattingSettings, spriteMattingConfigured } from "../provider";
import { AI_ENGINE_MODELS, AI_ENGINE_PYTHON, AI_ENGINE_ROOT } from "../paths";
import { broadcast } from "../ws";
import { JobCancelledError, runCmd } from "./run";
import { invalidateProjectUndo } from "../undo";

// ===== 抠图引擎探测（每次调用重新解析，设置页改动即时生效；解析顺序见下）=====

export interface MattingInfo {
  engine: MattingEngine;
  model: string;
  /** engine=none 时给用户的提示 */
  hint: string | null;
}

/** 内置 rembg 候选路径：POSIX 为 bin/rembg，Windows venv 布局为 Scripts/rembg.exe；
 *  打包版再追加 ai-engine/venv-rembg（设置页「AI 引擎安装器」的落位） */
const BUNDLED_REMBG_CANDIDATES = [
  join(REPO_ROOT, ".venv-matting", "bin", "rembg"),
  join(REPO_ROOT, ".venv-matting", "Scripts", "rembg.exe"),
  ...(AI_ENGINE_ROOT ? [join(AI_ENGINE_ROOT, "venv-rembg", "Scripts", "rembg.exe")] : []),
];
/** 找到的第一个内置 rembg（每次调用重新探测，装上引擎不用重启） */
export function bundledRembg(): string | null {
  return BUNDLED_REMBG_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const IS_WIN = process.platform === "win32";
const SETUP_SCRIPT = IS_WIN ? "scripts/setup_matting.ps1" : "scripts/setup_matting.sh";
const NO_ENGINE_HINT = IS_WIN
  ? "未安装抠图引擎，已原样复制：设置页「AI 抠图引擎」一键安装，或执行 " + SETUP_SCRIPT
  : `未安装抠图引擎，已原样复制：请先执行 ${SETUP_SCRIPT}`;

export function getMattingInfo(): MattingInfo {
  const { cliBin, envTemplate, model } = getMattingSettings();
  if (cliBin.trim() || envTemplate) return { engine: "custom-cli", model, hint: null };
  if (bundledRembg()) return { engine: "rembg-bundled", model, hint: null };
  if (Bun.which("rembg")) return { engine: "rembg-path", model, hint: null };
  return { engine: "none", model, hint: NO_ENGINE_HINT };
}

/** sprite 管线模式（matte_cli.py --pipeline）：chroma/spriteflow/birefnet/corridorkey/luma/additive 或逗号组合 */
const SPRITE_PIPELINES = new Set(["chroma", "spriteflow", "birefnet", "corridorkey", "luma", "additive"]);

export function isValidSpritePipeline(pipeline: string): boolean {
  return pipeline.split(",").map((s) => s.trim()).filter(Boolean).every((m) => SPRITE_PIPELINES.has(m));
}

/** python 是否装了 torch（结果缓存；探测一次 import，约 100-500ms）。graph 节点与素材库共用。 */
const torchProbeCache = new Map<string, boolean>();
export function pythonHasTorch(pythonBin: string): boolean {
  const cached = torchProbeCache.get(pythonBin);
  if (cached !== undefined) return cached;
  let has = false;
  try {
    const proc = Bun.spawnSync([pythonBin, "-c", "import torch"], { stdout: "ignore", stderr: "ignore" });
    has = proc.exitCode === 0;
  } catch {
    has = false;
  }
  torchProbeCache.set(pythonBin, has);
  return has;
}

/**
 * 解析跑 sprite 管线用的 python：birefnet/corridorkey 需要 torch，
 * 配置的 python（常为外部 sprite venv，只装 OpenCV 系轻依赖）没有时自动切 AI 引擎 venv-ai。
 * 素材库抠图与 graph matte.* 节点共用此逻辑。
 */
export function resolveSpritePipelinePython(pythonBin: string, mode: string): string {
  if (/birefnet|corridorkey/.test(mode) && AI_ENGINE_PYTHON && existsSync(AI_ENGINE_PYTHON) && !pythonHasTorch(pythonBin)) {
    return AI_ENGINE_PYTHON;
  }
  return pythonBin;
}

/**
 * 抠图执行，解析顺序：
 * a. pipeline 参数（sprite 管线：chroma/birefnet 等，走 matte_cli.py）——素材库/帧抠图的显式选择
 * b. 设置页结构化 CLI（命令 + 参数名映射，免模板）或 env FRAMEBAKER_MATTING_CLI 遗留模板（占位符 {input} {output}，可选 {model}）
 * c. <repo>/.venv-matting 内置 rembg（scripts/setup_matting.sh / .ps1 安装，POSIX 为 bin/rembg，Windows 为 Scripts/rembg.exe）
 * d. PATH 中的 rembg
 * e. passthrough 复制（返回警告提示安装）
 * 返回警告文案（无警告为 null）；b/c 会注入 U2NET_HOME=<repo>/storage/models
 * modelOverride：本次调用覆盖 rembg 模型（素材库「抠图模式选择弹窗」用；空=用设置页模型）
 * graph 节点（matte.batch）也直接复用此函数。
 */
/**
 * sprite 管线可调参数（matte_cli.py CLI 键 → 值）；弹窗「参数设置」透传。
 * 默认值对齐用户实测：chroma threshold=20 / spriteflow sfTolerance=25
 * （CLI 原默认 80/120 对纯色背景过激，直接把主体扣透明）。
 */
export type SpriteMattingParams = Record<string, number | string | boolean>;

const SPRITE_PARAM_KEYS = new Set([
  "threshold", "softness", "despillStrength", "haloPixels", "keyMode", "manualKeyHex",
  "aiModel", "aiDevice", "aiResolution",
  "lumaBlack", "lumaWhite", "lumaGamma", "lumaStrength",
  "corridorkeyScreen", "sfTolerance", "sfEdgeBlend", "sfBlendZoneRatio", "sfAlphaCutoff",
  "sfSpillRemoval", "sfSpillStrength", "decontaminate", "decontaminateRadius", "decontaminateStrength",
  "effectProtectionEnabled", "effectProtectionThreshold",
]);

/** camelCase 参数 → matte_cli 的 --kebab-case CLI；布尔转 "true"/"false"（argparse 显式值）。 */
export function spriteParamsToArgs(params: SpriteMattingParams): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!SPRITE_PARAM_KEYS.has(key) || value === undefined || value === null) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
    args.push(flag, typeof value === "boolean" ? String(value) : String(value));
  }
  return args;
}

export async function runMatting(
  input: string,
  output: string,
  signal?: AbortSignal,
  pipeline?: string,
  modelOverride?: string,
  mattingParams?: SpriteMattingParams,
): Promise<string | null> {
  // a. sprite 管线（显式选择，最高优先）：与图工作流 matte.pipeline 节点同一 CLI 同一语义。
  // birefnet 等 AI 模式需要 torch：配置的 python 没有时自动切 AI 引擎的 venv-ai
  // （外部 sprite venv 常只装 OpenCV 系轻依赖）。
  if (pipeline && pipeline.trim()) {
    const settings = getSpriteMattingSettings();
    if (!spriteMattingConfigured(settings)) {
      throw new Error("sprite 抠图未配置：设置页填 pythonBin 与 matte_cli.py 路径");
    }
    const pythonBin = resolveSpritePipelinePython(settings.pythonBin, pipeline);
    // 弹窗参数透传（camelCase → CLI）；未传时补保守默认：chroma 阈值 20 / spriteflow 容差 25
    const params: SpriteMattingParams = { ...mattingParams };
    if (params.threshold === undefined && /chroma/.test(pipeline) && !/spriteflow/.test(pipeline)) params.threshold = 20;
    if (params.sfTolerance === undefined && /spriteflow/.test(pipeline)) params.sfTolerance = 25;
    await runCmd(
      [pythonBin, settings.cliPath, "--input", input, "--output", output, "--pipeline", pipeline.trim(), ...spriteParamsToArgs(params)],
      AI_ENGINE_MODELS && existsSync(AI_ENGINE_MODELS)
        ? { SPRITE_VIDEO_LAB_AI_MODEL_CACHE: AI_ENGINE_MODELS }
        : undefined,
      signal
    );
    return null;
  }

  const { cliBin, cliInputArg, cliOutputArg, cliModelArg, envTemplate, model: settingModel } = getMattingSettings();
  const model = modelOverride?.trim() || settingModel;

  if (cliBin.trim()) {
    const argv = [cliBin.trim()];
    if (cliInputArg.trim()) argv.push(cliInputArg.trim());
    argv.push(input);
    if (cliOutputArg.trim()) argv.push(cliOutputArg.trim());
    argv.push(output);
    if (cliModelArg.trim()) argv.push(cliModelArg.trim(), model);
    await runCmd(argv, undefined, signal);
    return null;
  }

  if (envTemplate) {
    const argv = envTemplate
      .split(/\s+/)
      .map((tok) =>
        tok.replaceAll("{input}", input).replaceAll("{output}", output).replaceAll("{model}", model)
      );
    await runCmd(argv, undefined, signal);
    return null;
  }

  const rembgBin = bundledRembg() ?? Bun.which("rembg");
  if (rembgBin) {
    const u2netHome = join(STORAGE_ROOT, "models");
    mkdirSync(u2netHome, { recursive: true });
    await runCmd([rembgBin, "i", "-m", model, input, output], { U2NET_HOME: u2netHome }, signal);
    return null;
  }

  copyFileSync(input, output);
  return NO_ENGINE_HINT;
}

/** 抠图：项目帧。返回警告文案（null = 真抠图） */
export async function matteFrame(frameId: string, signal?: AbortSignal, pipeline?: string, model?: string, mattingParams?: SpriteMattingParams): Promise<string | null> {
  const frame = getFrame(frameId);
  if (!frame) throw new Error(`帧不存在: ${frameId}`);
  if (!frame.raw_path) throw new Error(`帧缺少 raw 文件: ${frameId}`);

  const outPath = join(STORAGE_ROOT, "projects", frame.project_id, "processed", `${frameId}.png`);
  const stageDir = join(STORAGE_ROOT, "staging", `matte_${uid()}`);
  const stagedPath = join(stageDir, "output.png");
  const backupPath = join(stageDir, "previous.png");
  mkdirSync(stageDir, { recursive: true });
  try {
    const warning = await runMatting(frame.raw_path, stagedPath, signal, pipeline, model, mattingParams);
    const current = getFrame(frameId);
    if (!current) throw new Error(`帧已在抠图期间删除: ${frameId}`);
    mkdirSync(dirname(outPath), { recursive: true });
    invalidateProjectUndo(current.project_id);
    const hadPrevious = existsSync(outPath);
    if (hadPrevious) renameSync(outPath, backupPath);
    try {
      renameSync(stagedPath, outPath);
      db.query("UPDATE frames SET status = 'ready', processed_path = ? WHERE id = ?").run(outPath, frameId);
    } catch (error) {
      rmSync(outPath, { force: true });
      if (hadPrevious && existsSync(backupPath)) renameSync(backupPath, outPath);
      throw error;
    }
    broadcast("frame_updated", { id: frameId, projectId: current.project_id, imageChanged: true });
    return warning;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/** 抠图：素材。返回警告文案（null = 真抠图） */
export async function matteMaterial(materialId: string, signal?: AbortSignal, pipeline?: string, model?: string, mattingParams?: SpriteMattingParams): Promise<string | null> {
  const m = getMaterial(materialId);
  if (!m) throw new Error(`素材不存在: ${materialId}`);
  if (!m.raw_path) throw new Error(`素材缺少 raw 文件: ${materialId}`);

  const outPath = join(STORAGE_ROOT, "materials", materialId, "processed.png");
  mkdirSync(dirname(outPath), { recursive: true });
  const warning = await runMatting(m.raw_path, outPath, signal, pipeline, model, mattingParams);

  db.query("UPDATE materials SET status = 'matted', processed_path = ? WHERE id = ?").run(outPath, materialId);
  broadcast("material_updated", { id: materialId });
  return warning;
}

/** 队列入口：按目标分发 */
export async function matte(
  target: "frame" | "material",
  id: string,
  signal?: AbortSignal,
  pipeline?: string,
  model?: string,
  mattingParams?: SpriteMattingParams
): Promise<string | null> {
  if (signal?.aborted) throw new JobCancelledError();
  return target === "frame"
    ? matteFrame(id, signal, pipeline, model, mattingParams)
    : matteMaterial(id, signal, pipeline, model, mattingParams);
}
