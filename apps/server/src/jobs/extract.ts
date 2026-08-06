import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, getFrame, getMaterial, nextFrameIdx, STORAGE_ROOT, uid } from "../db";
import { providerConfigured, resolveGenProvider } from "../provider";
import { broadcast } from "../ws";
import { generateViaApi } from "./generateApi";
import { runCmd } from "./run";

/** 任务产出目标：项目帧 or 素材库 */
type JobTarget = { kind: "project"; projectId: string } | { kind: "materials" };

export interface ExtractPayload {
  stagingFile: string;
  mediaType: "gif" | "mp4" | "image";
  fps: number;
  autoMatting: boolean;
  target: JobTarget;
  /** 原始文件名（去扩展名），仅 materials 目标用于素材命名 */
  originName?: string;
}

export interface GeneratePayload {
  prompt: string;
  count: number;
  autoMatting: boolean;
  target: JobTarget;
  /** 引用图绝对路径（服务端按 id 解析，防注入） */
  referencePath?: string;
  /** 生成时选择的 provider id（缺省用第一个已配置 provider） */
  providerId?: string;
  /** 生成时单独指定的模型（api 必填其一；cli 填 {model} 占位符） */
  model?: string;
  /** 生成时选择的尺寸（api 系覆盖 provider 的 apiSize；cli 无尺寸概念忽略） */
  size?: string;
}

type EnqueueMatting = (projectId: string, target: "frame" | "material", id: string) => void;

/**
 * 解析引用图并做 provider 一致性前置校验（API 层调用，error 非空时返回 400）：
 * - referenceMaterialId / referenceFrameId 二选一，服务端查文件路径（优先 processed 否则 raw），查不到报错
 * - provider=api 系（dashscope/gemini/minimax/openai 兼容）：原生支持引用图，无需校验
 * - provider=cli：结构化字段未配引用图参数名 / 遗留模板缺 {reference} → 选了引用图时报错
 */
export function resolveReferencePath(opts: {
  referenceMaterialId?: string;
  referenceFrameId?: string;
  providerId?: string;
}): { referencePath?: string; error?: string } {
  const { referenceMaterialId: mid, referenceFrameId: fid } = opts;
  if (mid && fid) return { error: "referenceMaterialId 与 referenceFrameId 只能二选一" };

  const provider = resolveGenProvider(opts.providerId);
  if (!provider) return { error: "生成 provider 不存在或未配置，请到设置页添加" };

  let p: string | null = null;
  if (mid) {
    const m = getMaterial(mid);
    if (!m) return { error: `素材不存在: ${mid}` };
    p = m.processed_path ?? m.raw_path;
    if (!p || !existsSync(p)) return { error: `素材文件缺失: ${mid}` };
  } else if (fid) {
    const f = getFrame(fid);
    if (!f) return { error: `帧不存在: ${fid}` };
    p = f.processed_path ?? f.raw_path;
    if (!p || !existsSync(p)) return { error: `帧文件缺失: ${fid}` };
  }

  if (provider.type === "cli") {
    if (!p) return { referencePath: undefined };
    // 结构化 CLI：未配置引用图参数名 → 不支持引用图；遗留模板：需含 {reference}
    if (provider.legacyTemplate) {
      if (!provider.legacyTemplate.includes("{reference}"))
        return { error: `已选择引用图，但 provider「${provider.name}」的模板缺少 {reference} 占位符` };
    } else if (!provider.cliReferenceArg.trim()) {
      return { error: `provider「${provider.name}」未配置引用图参数名，请改用其他 provider 或取消引用图` };
    }
  }
  return { referencePath: p ?? undefined };
}

/** 计算 raw 目录下一个可用的 frame_XXXX 起始编号，避免覆盖已有帧 */
function nextFrameNumber(rawDir: string): number {
  let start = 0;
  for (const f of readdirSync(rawDir)) {
    const m = /^frame_(\d+)\.png$/.exec(f);
    if (m) start = Math.max(start, parseInt(m[1], 10) + 1);
  }
  return start;
}

function afterImportFrames(
  projectId: string,
  frameIds: string[],
  autoMatting: boolean,
  enqueueMatting: EnqueueMatting
) {
  broadcast("frames_changed", { projectId });
  if (autoMatting) {
    for (const frameId of frameIds) {
      enqueueMatting(projectId, "frame", frameId);
    }
  }
}

function afterImportMaterials(materialIds: string[], autoMatting: boolean, enqueueMatting: EnqueueMatting) {
  broadcast("materials_changed", {});
  if (autoMatting) {
    for (const id of materialIds) {
      enqueueMatting("", "material", id);
    }
  }
}

/** 拆帧到独立暂存目录（两种目标共用），返回排序后的文件名列表 */
async function extractToStaging(p: ExtractPayload, progress: (s: string) => void): Promise<{ stageDir: string; files: string[] }> {
  // 先拆到独立暂存目录，再按目标统一处理
  const stageDir = join(STORAGE_ROOT, "staging", `extract_${uid()}`);
  mkdirSync(stageDir, { recursive: true });
  const outPattern = `${stageDir}/frame_%04d.png`;

  progress("拆帧中");
  if (p.mediaType === "image") {
    copyFileSync(p.stagingFile, `${stageDir}/frame_0000.png`);
  } else if (p.mediaType === "gif") {
    await runCmd(["ffmpeg", "-y", "-i", p.stagingFile, "-start_number", "0", outPattern]);
  } else {
    await runCmd(["ffmpeg", "-y", "-i", p.stagingFile, "-vf", `fps=${p.fps}`, "-start_number", "0", outPattern]);
  }

  const files = readdirSync(stageDir)
    .filter((f) => /^frame_\d+\.png$/.test(f))
    .sort();
  if (files.length === 0) throw new Error("未能从素材中提取任何帧");
  return { stageDir, files };
}

function cleanupStaging(stageDir: string, stagingFile: string) {
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(dirname(stagingFile), { recursive: true, force: true });
}

/** 暂存帧序列 → 素材入库 */
function saveMaterials(stageDir: string, files: string[], p: ExtractPayload): string[] {
  const base = (p.originName ?? "素材").trim() || "素材";
  const ids: string[] = [];
  files.forEach((file, i) => {
    const id = uid();
    const dir = join(STORAGE_ROOT, "materials", id);
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, "raw.png");
    renameSync(`${stageDir}/${file}`, rawPath);
    const name = files.length > 1 ? `${base} #${i + 1}` : base;
    db.query("INSERT INTO materials (id, name, raw_path, status, source, created_at) VALUES (?, ?, ?, 'raw', ?, ?)").run(
      id,
      name,
      rawPath,
      p.mediaType,
      Date.now()
    );
    ids.push(id);
  });
  return ids;
}

/** 拆帧任务：image 直接落盘；gif/mp4 走 ffmpeg；按 target 落到项目帧或素材库 */
export async function extractFrames(p: ExtractPayload, progress: (s: string) => void, enqueueMatting: EnqueueMatting) {
  const { stageDir, files } = await extractToStaging(p, progress);
  progress(`入库 ${files.length} 项`);

  if (p.target.kind === "project") {
    const rawDir = join(STORAGE_ROOT, "projects", p.target.projectId, "raw");
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(join(STORAGE_ROOT, "projects", p.target.projectId, "processed"), { recursive: true });
    const start = nextFrameNumber(rawDir);
    const baseIdx = nextFrameIdx(p.target.projectId);
    const frameIds: string[] = [];
    files.forEach((file, i) => {
      const id = uid();
      const rawPath = `${rawDir}/frame_${String(start + i).padStart(4, "0")}.png`;
      renameSync(`${stageDir}/${file}`, rawPath);
      db.query("INSERT INTO frames (id, project_id, idx, raw_path, status, source) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        p.target.kind === "project" ? p.target.projectId : "",
        baseIdx + i,
        rawPath,
        p.autoMatting ? "matting" : "ready",
        p.mediaType
      );
      frameIds.push(id);
    });
    cleanupStaging(stageDir, p.stagingFile);
    afterImportFrames(p.target.projectId, frameIds, p.autoMatting, enqueueMatting);
  } else {
    const ids = saveMaterials(stageDir, files, p);
    cleanupStaging(stageDir, p.stagingFile);
    afterImportMaterials(ids, p.autoMatting, enqueueMatting);
  }
}

/**
 * 生成任务：按 payload.providerId 解析 provider（缺省第一个已配置的），支持多 provider 共存：
 * - cli：结构化字段组装 argv（命令 + 参数名映射；遗留模板走占位符替换）
 * - api 系（OpenAI 兼容 / dashscope / gemini / minimax）：HTTP 调用，模型取 payload.model（缺省列表第一项）
 */
export async function generateFrames(p: GeneratePayload, progress: (s: string) => void, enqueueMatting: EnqueueMatting) {
  const provider = resolveGenProvider(p.providerId);
  if (!provider) {
    throw new Error("未配置生成方式：请到「设置」页添加生成 provider（CLI 或各厂商 API，可配多个共存）");
  }
  if (!providerConfigured(provider)) {
    throw new Error(`生成 provider「${provider.name}」配置不完整，请到「设置」页补齐`);
  }

  // API 模型：生成时单独指定优先，缺省取 provider 模型列表第一项
  const apiModel = p.model?.trim() || provider.apiModels[0] || "";
  if (provider.type !== "cli" && !apiModel) {
    throw new Error(`生成 provider「${provider.name}」未指定模型：请在生成时选择模型或在设置页配置模型列表`);
  }

  /**
   * CLI argv 组装（不经 shell）：
   * - 遗留模板（env / 旧数据）：按空白切分后替换 {prompt} {output} {index} {reference} {model}
   * - 结构化字段：[bin, promptArg?, prompt, outputArg?, output, modelArg?+model, refArg?+ref, ...extra]
   *   参数名留空 = 对应值作位置参数；未选模型/引用图或未配对应参数名时不传
   */
  const buildArgv = (output: string, index: number): string[] => {
    if (provider.legacyTemplate) {
      return provider.legacyTemplate
        .trim()
        .split(/\s+/)
        .map((tok) =>
          tok
            .replaceAll("{prompt}", p.prompt)
            .replaceAll("{output}", output)
            .replaceAll("{index}", String(index))
            .replaceAll("{reference}", p.referencePath ?? "")
            .replaceAll("{model}", p.model ?? "")
        );
    }
    const argv = [provider.cliBin.trim()];
    if (provider.cliPromptArg.trim()) argv.push(provider.cliPromptArg.trim());
    argv.push(p.prompt);
    if (provider.cliOutputArg.trim()) argv.push(provider.cliOutputArg.trim());
    argv.push(output);
    if (p.model?.trim() && provider.cliModelArg.trim()) argv.push(provider.cliModelArg.trim(), p.model.trim());
    if (p.referencePath && provider.cliReferenceArg.trim()) argv.push(provider.cliReferenceArg.trim(), p.referencePath);
    if (provider.cliExtraArgs.trim()) argv.push(...provider.cliExtraArgs.trim().split(/\s+/));
    return argv;
  };

  /** 生成单张图到 outPath（按 provider 分发；API 系透传引用图） */
  const produce = (outPath: string, index: number) =>
    provider.type === "cli"
      ? runCmd(buildArgv(outPath, index))
      : generateViaApi(provider, p.prompt, apiModel, index, outPath, p.referencePath, p.size);

  if (p.target.kind === "project") {
    const projectId = p.target.projectId;
    const rawDir = join(STORAGE_ROOT, "projects", projectId, "raw");
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(join(STORAGE_ROOT, "projects", projectId, "processed"), { recursive: true });
    const start = nextFrameNumber(rawDir);
    const baseIdx = nextFrameIdx(projectId);
    const frameIds: string[] = [];
    for (let i = 0; i < p.count; i++) {
      progress(`生成第 ${i + 1}/${p.count} 帧`);
      const rawPath = `${rawDir}/frame_${String(start + i).padStart(4, "0")}.png`;
      await produce(rawPath, i);
      if (!existsSync(rawPath)) throw new Error(`生成执行成功但未产出文件: ${rawPath}`);
      const id = uid();
      db.query(
        "INSERT INTO frames (id, project_id, idx, raw_path, status, source, metadata) VALUES (?, ?, ?, ?, ?, 'cli', ?)"
      ).run(
        id,
        projectId,
        baseIdx + i,
        rawPath,
        p.autoMatting ? "matting" : "ready",
        JSON.stringify({ prompt: p.prompt, index: i, provider: provider.name, model: p.model ?? (apiModel || undefined), size: p.size || undefined })
      );
      frameIds.push(id);
    }
    afterImportFrames(projectId, frameIds, p.autoMatting, enqueueMatting);
  } else {
    const ids: string[] = [];
    const base = p.prompt.trim().slice(0, 24) || "生成素材";
    for (let i = 0; i < p.count; i++) {
      progress(`生成第 ${i + 1}/${p.count} 个素材`);
      const id = uid();
      const dir = join(STORAGE_ROOT, "materials", id);
      mkdirSync(dir, { recursive: true });
      const rawPath = join(dir, "raw.png");
      await produce(rawPath, i);
      if (!existsSync(rawPath)) throw new Error(`生成执行成功但未产出文件: ${rawPath}`);
      db.query(
        "INSERT INTO materials (id, name, raw_path, status, source, metadata, created_at) VALUES (?, ?, ?, 'raw', 'cli', ?, ?)"
      ).run(
        id,
        p.count > 1 ? `${base} #${i + 1}` : base,
        rawPath,
        JSON.stringify({ prompt: p.prompt, index: i, provider: provider.name, model: p.model ?? (apiModel || undefined), size: p.size || undefined }),
        Date.now()
      );
      ids.push(id);
    }
    afterImportMaterials(ids, p.autoMatting, enqueueMatting);
  }
}
