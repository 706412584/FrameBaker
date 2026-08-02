import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MattingEngine } from "@framebaker/shared";
import { db, getFrame, getMaterial, REPO_ROOT, STORAGE_ROOT } from "../db";
import { broadcast } from "../ws";
import { runCmd } from "./run";

// ===== 抠图引擎探测（启动时探测一次；解析顺序见下）=====

export interface MattingInfo {
  engine: MattingEngine;
  model: string;
  /** engine=none 时给用户的提示 */
  hint: string | null;
}

const BUNDLED_REMBG = join(REPO_ROOT, ".venv-matting", "bin", "rembg");
const NO_ENGINE_HINT = "未安装抠图引擎，已原样复制：请先执行 scripts/setup_matting.sh";

export function detectMatting(): MattingInfo {
  const model = process.env.FRAMEBAKER_MATTING_MODEL?.trim() || "u2net";
  if (process.env.FRAMEBAKER_MATTING_CLI?.trim()) return { engine: "custom-cli", model, hint: null };
  if (existsSync(BUNDLED_REMBG)) return { engine: "rembg-bundled", model, hint: null };
  if (Bun.which("rembg")) return { engine: "rembg-path", model, hint: null };
  return { engine: "none", model, hint: NO_ENGINE_HINT };
}

/** 启动时探测一次（GET /api/config 与抠图执行共用） */
export const mattingInfo: MattingInfo = detectMatting();

/**
 * 抠图执行，解析顺序：
 * a. FRAMEBAKER_MATTING_CLI 模板（占位符 {input} {output}，可选 {model}）
 * b. <repo>/.venv-matting/bin/rembg（scripts/setup_matting.sh 安装）
 * c. PATH 中的 rembg
 * d. passthrough 复制（返回警告提示安装）
 * 返回警告文案（无警告为 null）；b/c 会注入 U2NET_HOME=<repo>/storage/models
 */
async function runMatting(input: string, output: string): Promise<string | null> {
  const tpl = process.env.FRAMEBAKER_MATTING_CLI;
  const model = mattingInfo.model;

  if (tpl && tpl.trim()) {
    const argv = tpl
      .trim()
      .split(/\s+/)
      .map((tok) =>
        tok.replaceAll("{input}", input).replaceAll("{output}", output).replaceAll("{model}", model)
      );
    await runCmd(argv);
    return null;
  }

  const rembgBin = existsSync(BUNDLED_REMBG) ? BUNDLED_REMBG : Bun.which("rembg");
  if (rembgBin) {
    const u2netHome = join(STORAGE_ROOT, "models");
    mkdirSync(u2netHome, { recursive: true });
    await runCmd([rembgBin, "i", "-m", model, input, output], { U2NET_HOME: u2netHome });
    return null;
  }

  copyFileSync(input, output);
  return NO_ENGINE_HINT;
}

/** 抠图：项目帧。返回警告文案（null = 真抠图） */
export async function matteFrame(frameId: string): Promise<string | null> {
  const frame = getFrame(frameId);
  if (!frame) throw new Error(`帧不存在: ${frameId}`);
  if (!frame.raw_path) throw new Error(`帧缺少 raw 文件: ${frameId}`);

  const outPath = join(STORAGE_ROOT, "projects", frame.project_id, "processed", `${frameId}.png`);
  mkdirSync(dirname(outPath), { recursive: true });
  const warning = await runMatting(frame.raw_path, outPath);

  db.query("UPDATE frames SET status = 'ready', processed_path = ? WHERE id = ?").run(outPath, frameId);
  broadcast("frame_updated", { id: frameId, projectId: frame.project_id });
  return warning;
}

/** 抠图：素材。返回警告文案（null = 真抠图） */
export async function matteMaterial(materialId: string): Promise<string | null> {
  const m = getMaterial(materialId);
  if (!m) throw new Error(`素材不存在: ${materialId}`);
  if (!m.raw_path) throw new Error(`素材缺少 raw 文件: ${materialId}`);

  const outPath = join(STORAGE_ROOT, "materials", materialId, "processed.png");
  mkdirSync(dirname(outPath), { recursive: true });
  const warning = await runMatting(m.raw_path, outPath);

  db.query("UPDATE materials SET status = 'matted', processed_path = ? WHERE id = ?").run(outPath, materialId);
  broadcast("material_updated", { id: materialId });
  return warning;
}

/** 队列入口：按目标分发 */
export async function matte(target: "frame" | "material", id: string): Promise<string | null> {
  return target === "frame" ? matteFrame(id) : matteMaterial(id);
}
