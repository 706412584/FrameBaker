// 节点执行实现。全部复用既有能力（AGENTS.md:39 依赖方向：graph/ → jobs/ 单向）。
// 每个节点：inputs（上游端口 payload）→ 执行 → outputs（端口 payload）。
// 产物文件落 executor.nodeOutputDir（由 content_hash 决定路径，重跑幂等覆盖）。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode } from "@framebaker/shared";
import JSZip from "jszip";
import { db, STORAGE_ROOT, uid } from "../db";
import { JobCancelledError, runCmd } from "../jobs/run";
import { resolveSpritePipelinePython, runMatting } from "../jobs/matting";
import { getSpriteMattingSettings, spriteMattingConfigured } from "../provider";
import { MANIFEST_GENERATORS, VALID_MANIFEST_FORMATS, type FramePosition, type FormatData, type ManifestFormat } from "./exportFormats";
import { packSheetBest } from "./rectpack";
import { splitImageLayers, type ImageLayersPayload } from "../jobs/imageLayers";
import { runComfyLayered } from "../jobs/comfyLayers";
import { generateFrames, type GeneratePayload } from "../jobs/extract";
import { getGenProviders, providerConfigured, getComfyLocalSettings } from "../provider";
import { AI_ENGINE_MODELS, BAKE_RUNNER, COMFY_SCRIPTS_ROOT } from "../paths";

/**
 * 图集合成（PIL paste 零损，对齐 sprite packed_sheet.paste / grid paste）：
 * 调 matte_cli.py --op compose，plan = [[输入路径, x, y],...]。
 * ffmpeg overlay 管线有 ±1~37 色度抖动，sprite 对齐要求逐像素 —— 必须走 PIL。
 */
async function composeSheet(
  placements: Array<{ path: string; x: number; y: number }>,
  binW: number,
  binH: number,
  ctx: NodeContext
): Promise<string> {
  const settings = getSpriteMattingSettings();
  if (!spriteMattingConfigured(settings)) {
    throw new Error("图集合成需要 PIL：设置页配置 spriteMatting（pythonBin + matte_cli.py）");
  }
  const out = join(ctx.outputDir, "sheet_raw.png");
  const plan = JSON.stringify(placements.map((p) => [p.path, p.x, p.y]));
  await runCmd(
    [
      settings.pythonBin, settings.cliPath,
      "--op", "compose",
      "--input", placements[0]!.path, // argparse required 占位
      "--output", out,
      "--compose-bin-w", String(binW),
      "--compose-bin-h", String(binH),
      "--compose-plan", plan,
    ],
    undefined,
    ctx.signal
  );
  return out;
}

export interface NodeContext {
  signal: AbortSignal;
  /** 该节点的产物目录（hash 命名，幂等覆盖） */
  outputDir: string;
  /** 进度上报（WS 广播） */
  report: (p: string) => void;
}

/** 输出端口名 → payload */
export type NodeOutput = Record<string, Record<string, unknown>>;

/** image[] 端口的标准 payload 形态 */
export interface ImageSequencePayload {
  /** 供 UI 预览的素材 id（若产物已入库） */
  materialIds?: string[];
  /** 图像文件绝对路径，按顺序 */
  paths: string[];
  /** export.frames 等终端节点的产物目录（UI 直达文件夹用） */
  outputDir?: string;
  /** frames.smart-select 选中的原始下标（按序） */
  selectedIndices?: number[];
  /** preview.frame 的采样秒与视频时长（前端时间轴拖动用） */
  sampleTime?: number;
  duration?: number;
}

export async function runNode(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  switch (node.type) {
    case "material.video":
      return materialVideo(node, ctx);
    case "material.image":
      return materialImage(node, ctx);
    case "extract.frames":
      return extractFrames(node, inputs, ctx);
    case "matte.batch":
      return matteBatch(node, inputs, ctx);
    case "export.spritesheet":
      return exportSpritesheet(node, inputs, ctx);
    case "export.package":
      return exportPackage(node, inputs, ctx);
    case "export.frames":
      return exportFrames(node, inputs, ctx);
    case "export.video":
      return exportVideo(node, inputs, ctx);
    case "frame.crop":
      return frameCrop(node, inputs, ctx);
    case "frame.canvas":
      return frameCanvas(node, inputs, ctx);
    case "frames.smart-select":
      return framesSmartSelect(node, inputs, ctx);
    case "preview.frame":
      return previewFrame(node, inputs, ctx);
    case "frames.to-material":
      return framesToMaterial(node, inputs, ctx);
    case "generate.image":
      return generateImage(node, ctx);
    case "ui.layer.analyze":
      return uiLayerAnalyze(node, inputs, ctx);
    case "ui.export":
      return uiExport(node, inputs, ctx);
    case "comfy.seethrough":
      return comfySeethrough(node, inputs, ctx);
    case "anim.map-parts":
      return animMapParts(node, inputs, ctx);
    case "anim.bake":
      return animBake(node, inputs, ctx);
    case "comfy.h3-video":
      return comfyH3Video(node, inputs, ctx);
    case "comfy.image-edit":
      return comfyImageEdit(node, inputs, ctx);
    case "comfy.image-gen":
      return comfyImageGen(node, ctx);
    case "comfy.layered":
      return comfyLayered(node, inputs, ctx);
    case "layers.to-psd":
      return layersToPsd(node, inputs, ctx);
    case "material.psd":
      return materialPsd(node, ctx);
    case "image.bg-inpaint":
      return bgInpaint(node, inputs, ctx);
    case "pose.detect":
      return poseDetect(node, inputs, ctx);
    case "human.parse":
      return humanParse(node, inputs, ctx);
    case "image.layers":
      return imageLayers(node, ctx);
    default:
      if (node.type === "frame.alpha") {
        return frameAlphaNode(node, inputs, ctx);
      }
      if (node.type.startsWith("matte.") || node.type === "image.decontaminate") {
        return spriteMatteNode(node, inputs, ctx);
      }
      throw new Error(`未实现的节点类型: ${node.type}`);
  }
}

/** material.video：读素材表 → video payload */
function materialVideo(node: GraphNode, ctx: NodeContext): NodeOutput {
  if (ctx.signal.aborted) throw new JobCancelledError();
  const materialId = String(node.params.materialId ?? "");
  const row = db.query("SELECT id, name, raw_path, status FROM materials WHERE id = ?").get(materialId) as
    | { id: string; name: string; raw_path: string | null; status: string }
    | null;
  if (!row) throw new Error(`素材不存在: ${materialId}`);
  if (!row.raw_path) throw new Error(`素材缺少文件: ${materialId}`);
  const stat = statSync(row.raw_path);
  return {
    video: {
      materialId: row.id,
      name: row.name,
      path: row.raw_path,
      size: stat.size,
    },
  };
}

/** material.image：读图片素材（有抠图用 processed，否则 raw）→ image[] payload */
function materialImage(node: GraphNode, ctx: NodeContext): NodeOutput {
  if (ctx.signal.aborted) throw new JobCancelledError();
  const materialId = String(node.params.materialId ?? "");
  const row = db.query("SELECT id, name, raw_path, processed_path FROM materials WHERE id = ?").get(materialId) as
    | { id: string; name: string; raw_path: string | null; processed_path: string | null }
    | null;
  if (!row) throw new Error(`素材不存在: ${materialId}`);
  const path = row.processed_path ?? row.raw_path;
  if (!path) throw new Error(`素材缺少文件: ${materialId}`);
  return { images: { paths: [path], materialIds: [row.id] } satisfies ImageSequencePayload };
}

/** extract.frames：ffmpeg 抽帧 → 产物目录（复用 jobs/extract 的 ffmpeg 语义） */
async function extractFrames(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const video = inputs.video as { path?: string };
  if (!video?.path) throw new Error("抽帧节点缺少视频输入");
  const fps = Number(node.params.fps ?? 12);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error(`无效帧率: ${fps}`);
  const timestamps = Array.isArray(node.params.timestamps)
    ? (node.params.timestamps as unknown[]).map(Number).filter((t) => Number.isFinite(t) && t >= 0)
    : [];
  const mode = timestamps.length > 0 ? "timestamps" : "fps";
  if (mode === "timestamps" && timestamps.length > 64) throw new Error("定点时间戳最多 64 个");
  // 区间与隔帧（对齐 sprite ProcessSettings.start_time / end_time / keep_every）
  const startTime = Math.max(0, Number(node.params.startTime ?? 0) || 0);
  const endTimeRaw = Number(node.params.endTime ?? 0) || 0;
  const endTime = endTimeRaw > startTime ? endTimeRaw : 0; // 0 = 到结尾
  const keepEvery = Math.max(1, Math.floor(Number(node.params.keepEvery ?? 1)) || 1);

  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const pattern = join(ctx.outputDir, "frame_%04d.png");
  // 区间参数（放 -i 前做快速 seek；-t 需在 -i 后）
  const seekArgs = startTime > 0 ? ["-ss", String(startTime)] : [];
  const durArgs = endTime > 0 ? ["-t", String(endTime - startTime)] : [];

  if (mode === "timestamps") {
    for (let i = 0; i < timestamps.length; i++) {
      if (ctx.signal.aborted) throw new JobCancelledError();
      ctx.report(`截帧 ${i + 1}/${timestamps.length}`);
      const out = join(ctx.outputDir, `frame_${String(i).padStart(4, "0")}.png`);
      await runCmd(
        ["ffmpeg", "-y", "-ss", String(timestamps[i]), "-i", video.path, "-frames:v", "1", out],
        undefined,
        ctx.signal
      );
    }
  } else {
    ctx.report(`按 ${fps} fps 抽帧${startTime > 0 ? `（${startTime}s 起）` : ""}${endTime > 0 ? `（至 ${endTime}s）` : ""}`);
    await runCmd(
      ["ffmpeg", "-y", ...seekArgs, "-i", video.path, ...durArgs, "-vf", `fps=${fps}`, "-start_number", "0", pattern],
      undefined,
      ctx.signal
    );
  }

  let paths = readdirSync(ctx.outputDir)
    .filter((f) => /^frame_\d+\.png$/.test(f))
    .sort()
    .map((f) => join(ctx.outputDir, f));
  if (paths.length === 0) throw new Error("未能从视频提取任何帧");
  // 隔帧抽取（keepEvery=2 → 每隔 2 帧取 1，对齐 sprite keep_every）
  if (keepEvery > 1) {
    const kept = paths.filter((_, i) => i % keepEvery === 0);
    const { rmSync } = await import("node:fs");
    for (const p of paths) if (!kept.includes(p)) rmSync(p, { force: true });
    paths = kept;
  }
  ctx.report(`抽出 ${paths.length} 帧`);
  return { images: { paths } satisfies ImageSequencePayload };
}

/** matte.batch：逐帧调 runMatting（同一抠图引擎链，无引擎时原样复制并提示） */
async function matteBatch(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("抠图节点缺少帧输入");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  let warning: string | null = null;
  const outPaths: string[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`抠图 ${i + 1}/${images.paths.length}`);
    const src = images.paths[i]!;
    const dst = join(ctx.outputDir, `matte_${String(i).padStart(4, "0")}.png`);
    const w = await runMatting(src, dst, ctx.signal);
    if (w) warning = w;
    outPaths.push(dst);
  }
  return { images: { paths: outPaths, ...(warning ? { warning } : {}) } satisfies ImageSequencePayload };
}

/** export.spritesheet：ffmpeg tile 拼合 → 单张 PNG */
async function exportSpritesheet(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("导出节点缺少帧输入");
  const count = images.paths.length;
  const columns = Math.max(1, Math.min(64, Math.floor(Number(node.params.columns ?? 4))));
  const rows = Math.ceil(count / columns);

  // ffmpeg tile 需要连续编号的输入：帧名已保证 frame_%04d / matte_%04d，
  // 但列数 > 帧数时 tile 会留空格 —— 直接用 concat demuxer 更稳。
  // 这里用最朴素可靠的方案：cat 文件列表 + -vf tile。
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const listFile = join(ctx.outputDir, "inputs.txt");
  const outFile = join(ctx.outputDir, "sheet.png");
  mkdirSync(ctx.outputDir, { recursive: true });
  const list = images.paths.map((p) => `file '${p.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n");
  writeFileSync(listFile, list);
  ctx.report(`拼合 ${count} 帧 → ${columns}x${rows}`);
  try {
    await runCmd(
      [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-vf", `tile=${columns}x${rows}`, "-frames:v", "1", outFile,
      ],
      undefined,
      ctx.signal
    );
  } finally {
    rmSync(listFile, { force: true });
  }
  const { existsSync } = await import("node:fs");
  if (!existsSync(outFile)) throw new Error("精灵表生成失败");
  return {
    sheet: { path: outFile, columns, rows, frameCount: count, framePaths: images.paths, outputDir: ctx.outputDir },
  };
}

/**
 * sprite 原子抠图节点（matte.chroma / matte.spriteflow / matte.birefnet /
 * matte.corridorkey / matte.luma / matte.additive / image.decontaminate）：
 * 逐帧调用 sprite 工坊的 matte_cli.py，pipeline 传单模式（decontaminate 传 chroma +
 * decontaminate 开关）。节点参数名与 matte_cli.py 的 CLI 参数一一对应。
 */
async function spriteMatteNode(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = getSpriteMattingSettings();
  if (!spriteMattingConfigured(settings)) {
    throw new Error("sprite 抠图未配置：设置页填 pythonBin 与 matte_cli.py 路径");
  }
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error(`${node.type} 节点缺少帧输入`);

  let mode: string;
  if (node.type === "matte.pipeline") {
    // 多选开关 → 固定顺序管线串（单次 CLI 调用 = alpha 并集 + additive 全局行为，像素等价 sprite）
    const ORDER: Array<[string, string]> = [
      ["useChroma", "chroma"],
      ["useSpriteflow", "spriteflow"],
      ["useBirefnet", "birefnet"],
      ["useCorridorkey", "corridorkey"],
      ["useLuma", "luma"],
      ["useAdditive", "additive"],
    ];
    const selected = ORDER.filter(([key]) => node.params[key] === true).map(([, m]) => m);
    if (selected.length > 0) {
      mode = selected.join(",");
    } else {
      // 旧图兼容：开关全空 → 回落 legacy pipeline 字符串；也空则默认 chroma
      mode = String(node.params.pipeline ?? "chroma").trim() || "chroma";
    }
  } else if (node.type === "image.decontaminate") {
    mode = "chroma";
  } else {
    mode = node.type.slice("matte.".length);
  }
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });

  // 节点 params → CLI 参数（camelCase → --kebab-case；布尔以 "true"/"false" 传值，
  // matte_cli.py 的 argparse bool 解析器需要显式值；pipeline 键已单独作为主参数下发，跳过）
  const PIPELINE_SWITCH_KEYS = new Set(["useChroma", "useSpriteflow", "useBirefnet", "useCorridorkey", "useLuma", "useAdditive"]);
  const extraArgs: string[] = [];
  for (const [key, value] of Object.entries(node.params)) {
    if (value === undefined || value === null || key === "pipeline" || PIPELINE_SWITCH_KEYS.has(key)) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
    extraArgs.push(flag, String(value));
  }
  // decontaminate 节点：chroma 管线 + 净化开关（chroma 是无操作感的载体，实际由净化步骤起效）
  if (node.type === "image.decontaminate") {
    extraArgs.push("--decontaminate", "true");
  }

  // birefnet/corridorkey 需要 torch：配置的外部 venv 没有时自动切 AI 引擎 venv-ai
  // （否则 RuntimeError: torch is not installed —— 外部 sprite venv 常只装 OpenCV 系轻依赖）
  const pythonBin = resolveSpritePipelinePython(settings.pythonBin, mode);
  const outPaths: string[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`抠图 ${i + 1}/${images.paths.length}（${mode}）`);
    const dst = join(ctx.outputDir, `matte_${String(i).padStart(4, "0")}.png`);
    await runCmd(
      [
        pythonBin, settings.cliPath,
        "--input", images.paths[i]!,
        "--output", dst,
        "--pipeline", mode,
        ...extraArgs,
      ],
      // AI 引擎已装时把模型缓存指向 ai-engine/models（BiRefNet 不再依赖 sprite 工坊原缓存）
      AI_ENGINE_MODELS && existsSync(AI_ENGINE_MODELS)
        ? { SPRITE_VIDEO_LAB_AI_MODEL_CACHE: AI_ENGINE_MODELS }
        : undefined,
      ctx.signal
    );
    outPaths.push(dst);
  }
  return { images: { paths: outPaths } satisfies ImageSequencePayload };
}

/**
 * frame.alpha：alpha 后处理（绿转黑 / 半透明转黑 / 半透明转不透明）。
 * 语义逐行对齐 sprite server.py 的 green_to_black_image /
 * semitransparent_to_black_image / semitransparent_to_opaque_image ——
 * 调 matte_cli.py --op alpha（Python 端直接调那三个原函数，零重复实现）。
 */
async function frameAlphaNode(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = getSpriteMattingSettings();
  if (!spriteMattingConfigured(settings)) {
    throw new Error("sprite 抠图未配置：设置页填 pythonBin 与 matte_cli.py 路径");
  }
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("frame.alpha 节点缺少帧输入");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const args: string[] = ["--op", "alpha"];
  for (const [key, value] of Object.entries(node.params)) {
    if (value === undefined || value === null || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
    args.push(flag, String(value));
  }
  const outPaths: string[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`alpha 处理 ${i + 1}/${images.paths.length}`);
    const dst = join(ctx.outputDir, `alpha_${String(i).padStart(4, "0")}.png`);
    await runCmd([settings.pythonBin, settings.cliPath, ...args, "--input", images.paths[i]!, "--output", dst], undefined, ctx.signal);
    outPaths.push(dst);
  }
  return { images: { paths: outPaths } satisfies ImageSequencePayload };
}

/** export.frames：帧序列作为最终输出落盘（frames/frame_001.png...），payload 带 outputDir */
async function exportFrames(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("导出节点缺少帧输入");
  const { mkdirSync, copyFileSync } = await import("node:fs");
  const framesDir = join(ctx.outputDir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const outPaths: string[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    const dst = join(framesDir, `frame_${String(i + 1).padStart(3, "0")}.png`);
    copyFileSync(images.paths[i]!, dst);
    outPaths.push(dst);
  }
  ctx.report(`输出 ${outPaths.length} 帧 PNG`);
  return { images: { paths: outPaths, outputDir: ctx.outputDir } satisfies ImageSequencePayload };
}

/** export.video：qtrle 保 alpha 的 .mov（对齐 sprite save_alpha_mov：帧复制为连续编号 → image2 输入 + qtrle/argb）*/
async function exportVideo(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("视频输出节点缺少帧输入");
  const durationMs = Math.max(20, Math.min(5000, Math.floor(Number(node.params.durationMs ?? 100))));
  const { mkdirSync, copyFileSync, rmSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  // 对齐 sprite：复制成连续编号（image2 demuxer 的 -framerate 才生效）
  const framesDir = join(ctx.outputDir, "video_frames_tmp");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const outFile = join(ctx.outputDir, "animation.mov");
  try {
    for (let i = 0; i < images.paths.length; i++) {
      copyFileSync(images.paths[i]!, join(framesDir, `frame_${String(i + 1).padStart(3, "0")}.png`));
    }
    ctx.report(`编码 ${images.paths.length} 帧 → qtrle mov`);
    await runCmd(
      [
        "ffmpeg", "-y",
        "-framerate", `1000/${durationMs}`,
        "-start_number", "1",
        "-i", join(framesDir, "frame_%03d.png"),
        "-frames:v", String(images.paths.length),
        "-c:v", "qtrle", "-pix_fmt", "argb",
        outFile,
      ],
      undefined,
      ctx.signal
    );
  } finally {
    rmSync(framesDir, { recursive: true, force: true });
  }
  const { existsSync } = await import("node:fs");
  if (!existsSync(outFile)) throw new Error("视频编码失败");
  return { video: { path: outFile, frameCount: images.paths.length, durationMs, framePaths: images.paths, outputDir: ctx.outputDir } };
}

/** frame.crop：ffmpeg crop 滤镜（对齐 ProcessSettings.crop_*） */
async function frameCrop(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("裁剪节点缺少帧输入");
  const x = Math.max(0, Math.floor(Number(node.params.x ?? 0)));
  const y = Math.max(0, Math.floor(Number(node.params.y ?? 0)));
  const w = Math.floor(Number(node.params.w ?? 0));
  const h = Math.floor(Number(node.params.h ?? 0));
  if (w <= 0 || h <= 0) throw new Error("裁剪需要 w/h > 0");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const outPaths: string[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`裁剪 ${i + 1}/${images.paths.length}`);
    const dst = join(ctx.outputDir, `crop_${String(i).padStart(4, "0")}.png`);
    await runCmd(
      ["ffmpeg", "-y", "-i", images.paths[i]!, "-vf", `crop=${w}:${h}:${x}:${y}`, dst],
      undefined,
      ctx.signal
    );
    outPaths.push(dst);
  }
  return { images: { paths: outPaths } satisfies ImageSequencePayload };
}

/**
 * frame.canvas：画布归一（对齐 ProcessSettings.target_size / reduce_px / canvas_mode）。
 * targetSize>0 → 缩放到目标 0 边（保持比例）；reducePx>0 → 先整体缩小；
 * canvasMode: square_bottom（方形画布贴底）/ square_center（方形居中）/ auto（不改画布）。
 * ffmpeg: scale → pad 到方形（transparent 填充）。
 */
async function frameCanvas(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("画布归一节点缺少帧输入");
  const targetSize = Math.max(0, Math.floor(Number(node.params.targetSize ?? 0)));
  const reducePx = Math.max(0, Math.floor(Number(node.params.reducePx ?? 0)));
  const canvasMode = String(node.params.canvasMode ?? "square_bottom");
  const trim = node.params.trim !== false;
  const { mkdirSync, copyFileSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });

  // 无缩放且不 trim → 原样通过（省一次进程调用）
  if (targetSize <= 0 && !trim) {
    const outPaths: string[] = [];
    for (let i = 0; i < images.paths.length; i++) {
      const dst = join(ctx.outputDir, `canvas_${String(i).padStart(4, "0")}.png`);
      copyFileSync(images.paths[i]!, dst);
      outPaths.push(dst);
    }
    return { images: { paths: outPaths } satisfies ImageSequencePayload };
  }

  // 整批一次调用 sprite stable_resize_frames（resize-batch）：stable_box = 全帧 alpha bbox 并集，
  // 全帧共用同一裁剪区/画布/贴位置。逐帧调用会导致画布宽度忽宽忽窄（auto）、内容左右跳（square）。
  // 不能用 ffmpeg scale：非预乘插值会把透明像素的黑色 RGB 混进半透明边缘 → 黑边/水墨感。
  const settings = requireSpriteCli();
  const outDir = join(ctx.outputDir, "canvas");
  ctx.report(`画布归一（批处理 ${images.paths.length} 帧）`);
  await runCmd(
    [
      settings.pythonBin, settings.cliPath,
      "--op", "resize-batch",
      "--input", images.paths[0]!, // argparse required 占位
      "--batch-list", JSON.stringify(images.paths),
      "--batch-out-dir", outDir,
      "--resize-target", String(targetSize),
      "--resize-reduce", String(reducePx),
      "--resize-canvas-mode", canvasMode,
      "--resize-trim", trim ? "true" : "false",
    ],
    undefined,
    ctx.signal
  );
  const { readdirSync } = await import("node:fs");
  const outPaths = readdirSync(outDir)
    .filter((f) => /^frame_\d+\.png$/.test(f))
    .sort()
    .map((f) => join(outDir, f));
  if (outPaths.length !== images.paths.length) {
    throw new Error(`画布归一输出帧数不符：${outPaths.length}/${images.paths.length}`);
  }
  return { images: { paths: outPaths } satisfies ImageSequencePayload };
}

/**
 * frames.smart-select：智能选帧（对齐 sprite suggest_job_frames：
 * 逐帧调 matte_cli.py --op signature 拿差异签名 → 网格分桶 + 相似度阈值 0.018 选差异最大的帧）。
 * 选帧策略照抄 server.py:2624-2680 的实现语义。
 */
async function framesSmartSelect(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("智能选帧节点缺少帧输入");
  const settings = getSpriteMattingSettings();
  if (!spriteMattingConfigured(settings)) {
    throw new Error("sprite 抠图未配置：设置页填 pythonBin 与 matte_cli.py 路径");
  }
  const frameCount = images.paths.length;
  const targetCount = Math.max(1, Math.min(Math.floor(Number(node.params.targetCount ?? 12)), frameCount));
  if (targetCount >= frameCount) {
    return { images: { paths: images.paths } satisfies ImageSequencePayload };
  }

  // 1) 逐帧签名（Python 端 frame_similarity_signature）
  const signatures: number[][] = [];
  for (let i = 0; i < frameCount; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`签名 ${i + 1}/${frameCount}`);
    const proc = Bun.spawn([settings.pythonBin, settings.cliPath, "--op", "signature", "--input", images.paths[i]!], {
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`签名失败: ${stderr.trim().slice(-300)}`);
    signatures.push(JSON.parse(stdout.trim()));
  }

  // 2) 差异分数（对齐 server.frame_difference_score：签名元素差的均值）
  const difference = (a: number[], b: number[]) => {
    let sum = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / Math.max(1, Math.min(a.length, b.length));
  };

  // 3) 分桶选帧（对齐 suggest_job_frames：均匀分桶取差异最大的未选帧，相似阈值 0.018）
  const similarityThreshold = 0.018;
  const selected: number[] = [];
  const selectedSet = new Set<number>();
  for (let slot = 0; slot < targetCount; slot++) {
    const start = targetCount === 1 ? Math.floor(frameCount / 2) : Math.round((slot * (frameCount - 1)) / targetCount);
    const end = targetCount === 1 ? start : Math.round(((slot + 1) * (frameCount - 1)) / targetCount);
    const center = Math.round((slot * (frameCount - 1)) / Math.max(1, targetCount - 1));
    const candidates: number[] = [];
    for (let p = Math.max(0, start); p <= Math.min(frameCount - 1, end); p++) candidates.push(p);
    let best = center;
    if (selected.length) {
      const last = selected[selected.length - 1]!;
      let bestScore = difference(signatures[last]!, signatures[best]!);
      if (bestScore < similarityThreshold) {
        for (const c of candidates) {
          if (selectedSet.has(c)) continue;
          const score = difference(signatures[last]!, signatures[c]!);
          if (score > bestScore) {
            bestScore = score;
            best = c;
          }
        }
      }
    }
    if (!selectedSet.has(best)) {
      selected.push(best);
      selectedSet.add(best);
    }
  }
  selected.sort((a, b) => a - b);
  ctx.report(`选中 ${selected.length}/${frameCount} 帧`);
  return { images: { paths: selected.map((i) => images.paths[i]!), selectedIndices: selected } satisfies ImageSequencePayload };
}

/**
 * export.package：完整导出包（对齐 sprite export_job 的产物集）：
 * frames/frame_001.png…、sprite_sheet.png(/webp)、frames.zip、export.json、
 * 引擎 manifest（phaser_hash/phaser_array/sparrow_xml/cocos_plist/godot_tres/sprite2d_xml）。
 * 布局对齐 sprite 的 grid 分支：列数网格 + 帧居中；frame_positions 记录真实坐标。
 */
async function exportPackage(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("完整导出节点缺少帧输入");
  const count = images.paths.length;
  const columns = Math.max(1, Math.min(64, Math.floor(Number(node.params.columns ?? 4))));
  const rows = Math.ceil(count / columns);
  const sheetFormat = String(node.params.sheetFormat ?? "png").toLowerCase();
  const webpQuality = Math.max(1, Math.min(100, Math.floor(Number(node.params.webpQuality ?? 90))));
  const includeZip = node.params.includeZip !== false;
  const includeManifest = node.params.includeManifest !== false;
  const durationMs = Math.max(20, Math.min(5000, Math.floor(Number(node.params.durationMs ?? 100))));
  // 引擎格式：六个独立开关（对齐 sprite 勾选式 UI）
  const formatSwitches: Array<[keyof typeof node.params, ManifestFormat]> = [
    ["manifestPhaserHash", "phaser_hash"],
    ["manifestPhaserArray", "phaser_array"],
    ["manifestSparrowXml", "sparrow_xml"],
    ["manifestCocosPlist", "cocos_plist"],
    ["manifestGodotTres", "godot_tres"],
    ["manifestSprite2dXml", "sprite2d_xml"],
  ];
  const manifestFormats = formatSwitches
    .filter(([key]) => node.params[key] === true)
    .map(([, fmt]) => fmt);

  const { mkdirSync, copyFileSync, readFileSync, writeFileSync } = await import("node:fs");
  const framesDir = join(ctx.outputDir, "frames");
  mkdirSync(framesDir, { recursive: true });

  // 1) 帧落盘 + 记录尺寸（对齐 sprite：frame_001.png 起）
  ctx.report(`整理 ${count} 帧`);
  const framePaths: string[] = [];
  const frameSizes: Array<{ w: number; h: number }> = [];
  for (let i = 0; i < count; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    const src = images.paths[i]!;
    const dst = join(framesDir, `frame_${String(i + 1).padStart(3, "0")}.png`);
    copyFileSync(src, dst);
    framePaths.push(dst);
    // PNG 头读尺寸（IHDR 在固定偏移）
    const buf = readFileSync(src);
    frameSizes.push({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
  }
  const cellWidth = Math.max(...frameSizes.map((s) => s.w));
  const cellHeight = Math.max(...frameSizes.map((s) => s.h));

  // 2) 图集布局（对齐 sprite export_job）：
  //    a) 不等大帧优先 rectpack 紧凑装箱（MaxRectsBssf，枚举列数取最小面积；成功 layout="packed"）
  //    b) 失败/等大 → 规则网格（等大直接 tile；不等大先逐帧 pad 到 cell 居中再拼）
  const { rmSync } = await import("node:fs");
  let sheetLayout: "grid" | "packed" = "grid";
  let positions: Array<{ x: number; y: number; w: number; h: number }> = [];
  const uniform = frameSizes.every((s) => s.w === cellWidth && s.h === cellHeight);
  let packedBin: { w: number; h: number } | null = null;

  // 放置计划（统一形态）：不等大帧优先 rectpack 紧凑装箱，失败/等大走网格；
  // 合成统一走 PIL paste（ffmpeg overlay 管线有 ±1~37 色度抖动，sprite 对齐要求逐像素）
  const padding = 2; // 对齐 sprite rectpack 分支的 padding 语义
  let placements: Array<{ path: string; x: number; y: number }> | null = null;
  if (!uniform && count > 1) {
    const packed = packSheetBest(frameSizes, cellWidth, cellHeight, padding);
    if (packed) {
      placements = packed.rects.map((r) => ({ path: framePaths[r.index]!, x: r.x, y: r.y }));
      sheetLayout = "packed";
      packedBin = { w: packed.binW, h: packed.binH };
      for (const r of packed.rects) {
        positions.push({ x: r.x, y: r.y, w: frameSizes[r.index]!.w, h: frameSizes[r.index]!.h });
      }
    }
  }
  if (!placements) {
    // 网格布局：等大直接放；不等大 cell 内居中（PIL paste 按原尺寸贴，无需物理 pad）
    for (let i = 0; i < count; i++) {
      const s = frameSizes[i]!;
      const ox = Math.floor((cellWidth - s.w) / 2);
      const oy = Math.floor((cellHeight - s.h) / 2);
      positions.push({ x: (i % columns) * cellWidth + ox, y: Math.floor(i / columns) * cellHeight + oy, w: s.w, h: s.h });
    }
    placements = positions.map((p, i) => ({ path: framePaths[i]!, x: p.x, y: p.y }));
    sheetLayout = "grid";
  }
  ctx.report(sheetLayout === "packed" ? "装箱布局合成（PIL）" : "网格布局合成（PIL）");
  const sheetPath: string = await composeSheet(placements, packedBin?.w ?? columns * cellWidth, packedBin?.h ?? rows * cellHeight, ctx);

  // 3) 图集格式：png / webp / both
  const sheetWidth = packedBin?.w ?? columns * cellWidth;
  const sheetHeight = packedBin?.h ?? rows * cellHeight;
  const files: Record<string, string> = {};
  if (sheetFormat === "png" || sheetFormat === "both") {
    const dst = join(ctx.outputDir, "sprite_sheet.png");
    copyFileSync(sheetPath, dst);
    files.sheet = dst;
  }
  if (sheetFormat === "webp" || sheetFormat === "both") {
    const dst = join(ctx.outputDir, "sprite_sheet.webp");
    await runCmd(["ffmpeg", "-y", "-i", sheetPath, "-quality:v", String(webpQuality), dst], undefined, ctx.signal);
    files.webpSheet = dst;
  }

  // 4) 帧 ZIP
  if (includeZip) {
    ctx.report("打包 ZIP");
    const zip = new JSZip();
    for (let i = 0; i < framePaths.length; i++) {
      zip.file(`frame_${String(i + 1).padStart(3, "0")}.png`, readFileSync(framePaths[i]!));
    }
    const zipPath = join(ctx.outputDir, "frames.zip");
    await Bun.write(zipPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    files.zip = zipPath;
  }

  // 5) export.json（对齐 sprite export_manifest 字段）
  const fps = 1000 / durationMs;
  const framePositions: FramePosition[] = positions.map((p, i) => ({
    name: `frame_${String(i + 1).padStart(3, "0")}`,
    x: p.x, y: p.y, w: p.w, h: p.h,
  }));
  const manifest = {
    cell_width: cellWidth,
    cell_height: cellHeight,
    sheet_layout: sheetLayout,
    sheet_width: sheetWidth,
    sheet_height: sheetHeight,
    frame_count: count,
    frames_dir: framesDir,
    zip_path: files.zip ?? null,
    sheet_path: files.sheet ?? null,
    webp_sheet_path: files.webpSheet ?? null,
    frames: framePositions,
    fps,
  };
  if (includeManifest) {
    const manifestPath = join(ctx.outputDir, "export.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    files.manifest = manifestPath;
  }

  // 6) 引擎 manifest
  const manifestUrls: Record<string, string> = {};
  if (manifestFormats.length) {
    ctx.report(`生成 ${manifestFormats.length} 种引擎 manifest`);
    const sheetImage = files.sheet ? "sprite_sheet.png" : "sprite_sheet.webp";
    const data: FormatData = { frames: framePositions, sheet_width: sheetWidth, sheet_height: sheetHeight, sheet_image: sheetImage, fps };
    for (const fmt of manifestFormats) {
      const entry = MANIFEST_GENERATORS[fmt];
      const dst = join(ctx.outputDir, entry.filename);
      writeFileSync(dst, entry.generate(data));
      files[fmt] = dst;
      manifestUrls[`${fmt}_url`] = dst;
    }
  }

  ctx.report(`导出完成：${Object.keys(files).length} 个文件`);
  return {
    sheet: {
      path: files.sheet ?? files.webpSheet ?? sheetPath,
      outputDir: ctx.outputDir,
      columns, rows, frameCount: count,
      cellWidth, cellHeight, sheetWidth, sheetHeight,
      files, manifestUrls,
    },
  };
}

/**
 * preview.frame：时间点取单帧（对齐 sprite preview_frame 的采样语义）。
 * ffmpeg -ss 精确 seek 抽 1 帧；payload 带 duration（ffprobe）供前端时间轴拖动。
 */
async function previewFrame(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const video = inputs.video as { path?: string } | undefined;
  if (!video?.path) throw new Error("单帧预览节点缺少视频输入");
  const sampleTime = Math.max(0, Number(node.params.sampleTime ?? 0) || 0);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });

  // 视频时长（时间轴量程；ffprobe 静默失败则 0 = 前端退化为数字输入）
  let duration = 0;
  const probe = Bun.spawn(["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "json", video.path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [pcode, pstdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
  if (pcode === 0 && pstdout.trim()) {
    try {
      duration = Number(JSON.parse(pstdout).format?.duration) || 0;
    } catch {
      duration = 0;
    }
  }

  const out = join(ctx.outputDir, "frame_0000.png");
  ctx.report(`取 ${sampleTime}s 帧`);
  await runCmd(
    ["ffmpeg", "-y", "-ss", String(sampleTime), "-i", video.path, "-frames:v", "1", out],
    undefined,
    ctx.signal
  );
  const { existsSync } = await import("node:fs");
  if (!existsSync(out)) throw new Error(`未能取到 ${sampleTime}s 的帧（超出时长？）`);
  return { images: { paths: [out], sampleTime, duration } satisfies ImageSequencePayload };
}

/** spriteMatting CLI 参数简写：pythonBin + cliPath 校验 */
function requireSpriteCli() {
  const settings = getSpriteMattingSettings();
  if (!spriteMattingConfigured(settings)) {
    throw new Error("需要 Python：设置页配置 spriteMatting（pythonBin + matte_cli.py）");
  }
  return settings;
}

/**
 * material.psd：PSD 分层拆解（对齐 POST /api/psd-split，复用 psd_split_parts）。
 * 图层 PNG 落 ctx.outputDir/layers/，payload 带 layerNames + bboxes。
 */
async function materialPsd(node: GraphNode, ctx: NodeContext): Promise<NodeOutput> {
  const settings = requireSpriteCli();
  const materialId = String(node.params.materialId ?? "");
  const row = db.query("SELECT raw_path FROM materials WHERE id = ?").get(materialId) as
    | { raw_path: string | null }
    | null;
  if (!row?.raw_path) throw new Error(`PSD 素材不存在: ${materialId}`);
  const { mkdirSync, readFileSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const layersDir = join(ctx.outputDir, "layers");
  const manifestPath = join(ctx.outputDir, "manifest.json");
  ctx.report("拆解 PSD 图层…");
  const args = [
    settings.pythonBin, settings.cliPath,
    "--op", "psd-split",
    "--input", row.raw_path,
    "--out-dir", layersDir,
    "--out-manifest", manifestPath,
  ];
  if (node.params.psdExclude) args.push("--psd-exclude", String(node.params.psdExclude));
  if (node.params.psdHide) args.push("--psd-hide", String(node.params.psdHide));
  if (node.params.psdOnlyVisible === true) args.push("--psd-only-visible", "true");
  await runCmd(args, undefined, ctx.signal);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    width: number;
    height: number;
    layerCount: number;
    files: Array<{ path: string; name: string; bbox: { x: number; y: number; w: number; h: number } }>;
  };
  ctx.report(`拆出 ${manifest.layerCount} 层`);
  return {
    images: {
      paths: manifest.files.map((f) => f.path),
      layerNames: manifest.files.map((f) => f.name),
      bboxes: manifest.files.map((f) => f.bbox),
      canvasWidth: manifest.width,
      canvasHeight: manifest.height,
    },
  };
}

/** image.bg-inpaint：背景修补（对齐 POST /api/bg-inpaint，复用 run_bg_inpaint：LaMa → OpenCV 回退） */
async function bgInpaint(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = requireSpriteCli();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("背景修补节点缺少帧输入");
  const rectsRaw = String(node.params.rects ?? "").trim();
  if (!rectsRaw) throw new Error("背景修补需要 rects 参数 [[x,y,w,h],...]");
  JSON.parse(rectsRaw); // 校验 JSON；格式错误给清晰报错
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const outPaths: string[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`修补 ${i + 1}/${images.paths.length}`);
    const dst = join(ctx.outputDir, `inpaint_${String(i).padStart(4, "0")}.png`);
    await runCmd(
      [
        settings.pythonBin, settings.cliPath,
        "--op", "bg-inpaint",
        "--input", images.paths[i]!,
        "--output", dst,
        "--inpaint-rects", rectsRaw,
        "--ai-device2", String(node.params.aiDevice ?? "auto"),
      ],
      undefined,
      ctx.signal
    );
    outPaths.push(dst);
  }
  return { images: { paths: outPaths } };
}

/**
 * pose.detect：姿态检测（对齐 POST /api/pose-detect，复用 detect_pose_keypoints）。
 * 输出两端口：images（原图，供下游继续）+ poses（每帧的关键点 JSON）。
 */
async function poseDetect(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = requireSpriteCli();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("姿态检测节点缺少帧输入");
  const poses: unknown[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`检测 ${i + 1}/${images.paths.length}`);
    const proc = Bun.spawn(
      [settings.pythonBin, settings.cliPath, "--op", "pose", "--input", images.paths[i]!],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`姿态检测失败: ${stderr.trim().slice(-300)}`);
    poses.push(JSON.parse(stdout.trim()));
  }
  return {
    images: { paths: images.paths },
    poses: { perFrame: poses },
  };
}

/**
 * human.parse：人体解析（对齐 POST /api/human-parse，复用 human_parse_parts：
 * ATR 语义部件 + head/torso 复合件 PNG）。部件落 ctx.outputDir/frame_XXX_parts/。
 */
async function humanParse(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = requireSpriteCli();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("人体解析节点缺少帧输入");
  const { mkdirSync, readFileSync } = await import("node:fs");
  const allPaths: string[] = [];
  const manifests: unknown[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`解析 ${i + 1}/${images.paths.length}`);
    const frameDir = join(ctx.outputDir, `frame_${String(i).padStart(3, "0")}_parts`);
    const manifestPath = join(ctx.outputDir, `frame_${String(i).padStart(3, "0")}_manifest.json`);
    await runCmd(
      [
        settings.pythonBin, settings.cliPath,
        "--op", "human-parse",
        "--input", images.paths[i]!,
        "--out-dir", frameDir,
        "--out-manifest", manifestPath,
        "--ai-device2", String(node.params.aiDevice ?? "auto"),
      ],
      undefined,
      ctx.signal
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      partCount: number;
      files: Array<{ path: string; name: string }>;
      labelsPresent: string[];
    };
    allPaths.push(...manifest.files.map((f) => f.path));
    manifests.push(manifest);
  }
  return {
    images: { paths: allPaths },
    poses: { manifests },
  };
}

/** image.layers：场景分层（复用 FrameBaker splitImageLayers：Qwen-Image-Layered /images/layers） */
async function imageLayers(node: GraphNode, ctx: NodeContext): Promise<NodeOutput> {
  const materialId = String(node.params.materialId ?? "");
  const row = db.query("SELECT id FROM materials WHERE id = ?").get(materialId) as { id: string } | null;
  if (!row) throw new Error(`素材不存在: ${materialId}`);
  const layerCount = Math.max(1, Math.min(4, Math.floor(Number(node.params.layerCount ?? 4))));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  ctx.report(`场景分层（${layerCount} 层）…`);
  const payload: ImageLayersPayload = {
    materialId,
    layers: layerCount,
    numInferenceSteps: 30,
    trueCfgScale: 4.0,
    seed: 0,
  };
  const result = (await splitImageLayers(payload, (p) => ctx.report(p), ctx.signal)) as unknown as {
    layerPaths?: string[];
    materials?: Array<{ raw_path?: string | null }>;
  };
  const paths =
    result?.layerPaths ??
    (result?.materials ?? []).map((m) => m.raw_path).filter((p): p is string => !!p);
  if (!paths?.length) throw new Error("场景分层未产出图层（检查 imageLayers 设置与 provider 连通）");
  return { images: { paths } };
}


/**
 * frames.to-material：帧序列入库素材库（打通 图→素材库→timeline 编辑器）。
 * 每帧一个素材（raw 直存），payload 带 materialIds 供下游/UI 引用。
 */
async function framesToMaterial(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("入库节点缺少帧输入");
  const name = String(node.params.name ?? "").trim();
  const { mkdirSync, copyFileSync } = await import("node:fs");
  const materialIds: string[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`入库 ${i + 1}/${images.paths.length}`);
    const id = uid();
    const dir = join(STORAGE_ROOT, "materials", id);
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, "raw.png");
    copyFileSync(images.paths[i]!, rawPath);
    db.query(
      "INSERT INTO materials (id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, NULL, 'raw', 'image', NULL, '{}', ?)"
    ).run(id, name ? `${name}_${i + 1}` : `graph_frame_${i + 1}`, rawPath, Date.now());
    materialIds.push(id);
  }
  broadcastMaterialsChanged();
  ctx.report(`已入库 ${materialIds.length} 个素材`);
  return { images: { paths: images.paths, materialIds } satisfies ImageSequencePayload };
}

/**
 * generate.image：AI 生图（复用 FrameBaker generateFrames 的 provider 适配层）。
 * 产物落在 generate 任务的素材入库语义之外（graph 语境）—— 取生成的临时产物路径输出。
 */
async function generateImage(node: GraphNode, ctx: NodeContext): Promise<NodeOutput> {
  const prompt = String(node.params.prompt ?? "").trim();
  if (!prompt) throw new Error("AI 生成需要提示词");
  const providers = getGenProviders().filter((p) => providerConfigured(p) && p.imageModels.length > 0);
  if (providers.length === 0) throw new Error("没有已配置的图片生成 provider（设置页配置）");
  const provider = providers.find((p) => p.id === node.params.providerId) ?? providers[0]!;
  const model = String(node.params.model ?? "") || provider.imageModels[0] || "";
  const count = Math.max(1, Math.min(16, Math.floor(Number(node.params.count ?? 1))));
  ctx.report(`生成 ${count} 张（${provider.name}）`);
  const payload: GeneratePayload = {
    target: { kind: "materials" },
    providerId: provider.id,
    model,
    prompt,
    count,
    autoMatting: false,
    name: `graph_${Date.now()}`,
    size: provider.imageSize || "",
  };
  const committed = await generateFrames(payload, (p: string) => ctx.report(p), () => {}, ctx.signal);
  // generateFrames target=materials 入库素材并返回提交结果；graph 输出取素材 raw 路径
  const paths: string[] = [];
  for (const a of committed) {
    if (a.kind !== "image") continue;
    const row = db.query("SELECT raw_path FROM materials WHERE id = ?").get(a.id) as
      | { raw_path: string | null }
      | null;
    if (row?.raw_path) paths.push(row.raw_path);
  }
  if (paths.length === 0) throw new Error("生成未产出图片");
  broadcastMaterialsChanged();
  return { images: { paths } satisfies ImageSequencePayload };
}

function broadcastMaterialsChanged() {
  // executor 已有 broadcast；这里经 ws 模块广播（graph/nodes.ts 不 import executor，单向依赖）
  import("../ws").then(({ broadcast }) => broadcast("materials_changed", {}));
}

/**
 * ui.layer.analyze：UI 大图 → 候选图层 PNG（sprite ui-layer-lab 完整能力）。
 * matte_cli.py --op ui-analyze：OpenCV Canny 候选框 + GrabCut 前景蒙版切图层。
 * 与 slice.ui.analyze（纯 alpha 连通域、已去底图用）互补 —— 本节点适配实底 UI 截图。
 */
async function uiLayerAnalyze(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = requireSpriteCli();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("UI 图层拆分节点缺少图片输入");
  const { mkdirSync, readFileSync } = await import("node:fs");
  const maxNodes = Math.max(1, Math.min(128, Math.floor(Number(node.params.maxNodes ?? 64))));
  const minSize = Math.max(1, Math.floor(Number(node.params.minSize ?? 8)));
  const alphaMode = String(node.params.alphaMode ?? "cutout");

  const allPaths: string[] = [];
  const manifests: unknown[] = [];
  for (let i = 0; i < images.paths.length; i++) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.report(`UI 分析 ${i + 1}/${images.paths.length}`);
    const layersDir = join(ctx.outputDir, `img_${String(i).padStart(3, "0")}_layers`);
    const manifestPath = join(ctx.outputDir, `img_${String(i).padStart(3, "0")}_manifest.json`);
    await runCmd(
      [
        settings.pythonBin, settings.cliPath,
        "--op", "ui-analyze",
        "--input", images.paths[i]!,
        "--out-dir", layersDir,
        "--out-manifest", manifestPath,
        "--ui-max-nodes", String(maxNodes),
        "--ui-min-size", String(minSize),
        "--ui-alpha-mode", alphaMode,
      ],
      undefined,
      ctx.signal
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      candidateCount: number;
      files: Array<{ path: string; name: string; bbox: { x: number; y: number; w: number; h: number } }>;
    };
    allPaths.push(...manifest.files.map((f) => f.path));
    manifests.push(manifest);
  }
  ctx.report(`拆出 ${allPaths.length} 个 UI 图层`);
  // rects 端口：候选清单（ui.export / 人在环确认面板用）
  const candidates = (manifests[0] as { files: Array<{ name: string; bbox: { x: number; y: number; w: number; h: number } }> }).files.map(
    (f) => ({ name: f.name, x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h })
  );
  return {
    images: { paths: allPaths } satisfies ImageSequencePayload,
    rects: { candidates },
  };
}

/**
 * ui.export：UI 分层导出（sprite _export_session 完整语义）。
 * 输入：原图（images 端口）+ 候选清单（rects 端口，可经人在环修正）。
 * 产物：layers/ 分层 PNG + background.png（inpaint 补全或透明）+ layout.json + 可选 PSD。
 */
async function uiExport(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = requireSpriteCli();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("UI 分层导出缺少原图输入");
  const rects = inputs.rects as { candidates?: Array<{ name: string; x: number; y: number; w: number; h: number }> } | undefined;
  const candidates = rects?.candidates;
  if (!candidates?.length) throw new Error("UI 分层导出缺少候选清单（上游接 UI 图层拆分的 rects）");
  const backgroundMode = String(node.params.backgroundMode ?? "transparent");
  const exportFormat = String(node.params.exportFormat ?? "package");

  const { mkdirSync, readdirSync, statSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const layoutJson = JSON.stringify(candidates.map((c) => [c.name, c.x, c.y, c.w, c.h]));
  ctx.report(`分层导出（${candidates.length} 图层，${backgroundMode === "inpaint" ? "补全背景" : "透明背景"}，${exportFormat}）`);
  await runCmd(
    [
      settings.pythonBin, settings.cliPath,
      "--op", "ui-export",
      "--input", images.paths[0]!,
      "--out-dir", ctx.outputDir,
      "--ui-export-layout", layoutJson,
      "--ui-export-background", backgroundMode,
      "--ui-export-format", exportFormat,
    ],
    undefined,
    ctx.signal
  );

  // 收集产物
  const files: Record<string, string> = {};
  const collect = (dir: string, prefix: string) => {
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      if (statSync(fp).isDirectory()) collect(fp, `${prefix}${f}/`);
      else files[`${prefix}${f}`] = fp;
    }
  };
  collect(ctx.outputDir, "");
  const { existsSync } = await import("node:fs");
  const psdPath = join(ctx.outputDir, "ui_layers.psd");
  ctx.report(`导出 ${Object.keys(files).length} 个文件${existsSync(psdPath) ? "（含 PSD）" : ""}`);
  return {
    sheet: {
      path: join(ctx.outputDir, "layout.json"),
      outputDir: ctx.outputDir,
      files,
      layoutPath: join(ctx.outputDir, "layout.json"),
      psdPath: existsSync(psdPath) ? psdPath : null,
      layerCount: candidates.length,
    },
  };
}
// ===== 本地生成能力（ComfyUI + 骨骼烘焙链；脚本在 apps/server/graph/comfy/，打包后在 resources/comfy/）=====

/** ComfyUI 链公共：配置 + 脚本目录 */
function comfyEnv() {
  const settings = getComfyLocalSettings();
  const scriptDir = COMFY_SCRIPTS_ROOT;
  return { settings, scriptDir };
}

/** 捕获 stdout 的 spawn（bake 脚本把 JSON 打到 stdout，runCmd 会丢） */
async function spawnCapture(argv: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/**
 * comfy.seethrough：See-through 语义部件分层（立绘 → 29 层部件）。
 * 输入图拷进 comfyRoot/input，脚本排队跑 ComfyUI（约 5-10 分钟），
 * 产物在 comfyRoot/output/<prefix 时间戳 uid>_layers.json + 各层 PNG。
 * rects 端口输出 outPrefix（下游 anim.map-parts 靠它定位产物）+ 层清单。
 */
async function comfySeethrough(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const { settings, scriptDir } = comfyEnv();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("语义分层节点缺少输入图");
  const resolution = Math.max(256, Math.min(1024, Math.floor(Number(node.params.resolution ?? 1024))));
  const depthResolution = Math.max(256, Math.min(1024, Math.floor(Number(node.params.depthResolution ?? 640))));
  const { mkdirSync, copyFileSync, readdirSync } = await import("node:fs");
  const inputDir = join(settings.comfyRoot, "input");
  mkdirSync(inputDir, { recursive: true });
  const src = images.paths[0]!;
  const ext = src.endsWith(".png") ? "png" : src.split(".").pop()?.toLowerCase() || "png";
  const inputName = `graph_${uid()}.${ext}`;
  copyFileSync(src, join(inputDir, inputName));
  const outPrefix = `graph_st_${uid().slice(0, 8)}`;

  ctx.report(`See-through 分层（${resolution}px，约 5-10 分钟，看 ComfyUI 队列）…`);
  await runCmd(
    [
      settings.pythonBin, join(scriptDir, "comfy_seethrough.py"),
      "--image", inputName,
      "--out", outPrefix,
      "--resolution", String(resolution),
      "--depth-resolution", String(depthResolution),
    ],
    undefined,
    ctx.signal
  );

  // SavePSD 写 <prefix 时间戳 uid>_layers.json —— 前缀扫描找最新
  const outputDir = join(settings.comfyRoot, "output");
  const manifest = readdirSync(outputDir).filter((f) => f.startsWith(outPrefix) && f.endsWith("layers.json")).sort().pop();
  if (!manifest) throw new Error("See-through 未产出分层清单（ComfyUI 队列是否执行成功？）");
  copyFileSync(join(outputDir, manifest), join(ctx.outputDir, manifest));
  const manifestData = JSON.parse(await Bun.file(join(ctx.outputDir, manifest)).text()) as {
    width: number;
    height: number;
    layers: Array<{ name: string; depth_median?: number }>;
  };
  ctx.report(`分层完成：${manifestData.layers.length} 层`);
  return {
    images: { paths: [join(ctx.outputDir, manifest)] },
    rects: {
      outPrefix: manifest.replace(/layers\.json$/, ""),
      manifestPath: join(ctx.outputDir, manifest),
      width: manifestData.width,
      height: manifestData.height,
      layers: manifestData.layers,
    },
  };
}

/**
 * anim.map-parts：语义部件 → FrameBaker 骨段部件（head/torso/pelvis/四肢…12 段）。
 * 输入 rects 端口 = comfy.seethrough 的分层清单（outPrefix 定位 ComfyUI output 产物）。
 */
async function animMapParts(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const { settings, scriptDir } = comfyEnv();
  const rects = inputs.rects as { outPrefix?: string } | undefined;
  const outPrefix = rects?.outPrefix;
  if (!outPrefix) throw new Error("部件映射需要上游语义分层清单（接 AI·语义分层的 rects）");
  const { mkdirSync, readdirSync, existsSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const args = [
    settings.pythonBin, join(scriptDir, "map_seethrough_to_framebaker.py"),
    outPrefix, ctx.outputDir,
    "--out-root", join(settings.comfyRoot, "output"),
  ];
  if (node.params.singleFoot === true) args.push("--single-foot");
  if (node.params.splitSleeve === true) args.push("--split-sleeve");
  ctx.report("语义部件 → 骨段部件…");
  await runCmd(args, undefined, ctx.signal);
  const layoutPath = join(ctx.outputDir, "layout.json");
  if (!existsSync(layoutPath)) throw new Error("部件映射未产出 layout.json");
  const layout = JSON.parse(await Bun.file(layoutPath).text()) as { canvas?: { width: number; height: number } };
  const partPaths = readdirSync(ctx.outputDir).filter((f) => f.endsWith(".png")).sort().map((f) => join(ctx.outputDir, f));
  ctx.report(`映射出 ${partPaths.length} 个骨段部件`);
  return {
    images: { paths: partPaths },
    sheet: { partsDir: ctx.outputDir, layoutPath, canvasWidth: layout.canvas?.width ?? 0, canvasHeight: layout.canvas?.height ?? 0 },
  };
}

/**
 * anim.bake：反解绑定 + 烘动作 + 渲染精灵表。
 * build_binding_and_bake.ts 在 apps/server/（import @framebaker/shared 只在此解析），
 * 其 stdout = poses.json → render_poses.py 渲染逐帧动画 → 输出帧序列 + 精灵表。
 */
async function animBake(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const { settings, scriptDir } = comfyEnv();
  const sheet = inputs.sheet as { partsDir?: string } | undefined;
  const partsDir = sheet?.partsDir;
  if (!partsDir) throw new Error("烘焙动作需要上游骨段布局（接 骨骼·部件映射 的 sheet）");
  const clip = String(node.params.clip ?? "motion-original-preset-idle");
  const frameCount = Math.max(2, Math.min(32, Math.floor(Number(node.params.frameCount ?? 8))));
  const { mkdirSync, existsSync, readdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });

  // 1) 反解绑定 + 烘动作（stdout 是 poses JSON）。
  // 源码运行：bun + apps/server/build_binding_and_bake.ts；打包：resources/bin 下的独立 exe。
  const bakeScript = BAKE_RUNNER;
  if (!existsSync(bakeScript)) throw new Error("烘焙脚本缺失（build_binding_and_bake，骨骼烘焙链前置）");
  ctx.report(`烘 ${clip} × ${frameCount} 帧…`);
  const bakeCommand = BAKE_RUNNER.endsWith(".ts") ? ["bun", bakeScript] : [bakeScript];
  const r = await spawnCapture([...bakeCommand, partsDir, clip, String(frameCount)], ctx.signal);
  if (r.code !== 0) throw new Error(`骨骼烘焙失败: ${r.stderr.trim().slice(-300)}`);
  const posesPath = join(ctx.outputDir, "poses.json");
  writeFileSync(posesPath, r.stdout);

  // 2) 渲染精灵表（render_poses.py poses.json out.png partsDir；逐帧 PNG 在同目录）
  ctx.report("渲染精灵表…");
  const outSheet = join(ctx.outputDir, "spritesheet.png");
  await runCmd(
    [settings.pythonBin, join(scriptDir, "render_poses.py"), posesPath, outSheet, partsDir],
    undefined,
    ctx.signal
  );
  if (!existsSync(outSheet)) throw new Error("精灵表渲染未产出");
  // render_poses 出精灵表 + 循环 gif；逐帧从 gif 拆（ffmpeg，帧率取 duration/帧数）
  const gifPath = outSheet.replace(".png", ".gif");
  let framePaths = readdirSync(ctx.outputDir).filter((f) => /^frame_\d+\.png$/.test(f)).sort().map((f) => join(ctx.outputDir, f));
  if (framePaths.length === 0 && existsSync(gifPath)) {
    ctx.report("拆分逐帧…");
    await runCmd(
      ["ffmpeg", "-y", "-i", gifPath.replaceAll("\\", "/"), join(ctx.outputDir, "frame_%03d.png").replaceAll("\\", "/")],
      undefined,
      ctx.signal
    );
    framePaths = readdirSync(ctx.outputDir).filter((f) => /^frame_\d+\.png$/.test(f)).sort().map((f) => join(ctx.outputDir, f));
  }
  ctx.report(`完成：${framePaths.length || 1} 帧`);
  return {
    images: { paths: framePaths.length ? framePaths : [outSheet] },
    sheet: { path: outSheet, outputDir: ctx.outputDir, frameCount: framePaths.length || 1, clip },
  };
}

/**
 * comfy.h3-video：H3 图生视频（立绘 → 动作循环视频，640/24fps/73 帧）。
 * first+last 帧同图（硬规则，attack 不失控），产物 mp4 → video 端口（接抽帧链）。
 */
async function comfyH3Video(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const { settings, scriptDir } = comfyEnv();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("动作视频节点缺少输入立绘");
  const action = String(node.params.action ?? "idle");
  const { mkdirSync, copyFileSync, readdirSync, statSync } = await import("node:fs");
  const inputDir = join(settings.comfyRoot, "input");
  mkdirSync(inputDir, { recursive: true });
  const src = images.paths[0]!;
  const inputName = `graph_h3_${uid().slice(0, 8)}.png`;
  copyFileSync(src, join(inputDir, inputName));
  const outPrefix = `graph_h3_${uid().slice(0, 8)}`;

  const args = [settings.pythonBin, join(scriptDir, "comfy_h3_video.py"), "--image", inputName, "--action", action, "--out", outPrefix];
  if (action === "attack" && node.params.attackPrompt) {
    args.push("--attack", String(node.params.attackPrompt));
  }
  ctx.report(`H3 生成 ${action} 动作视频（2-5 分钟）…`);
  await runCmd(args, undefined, ctx.signal);

  // 产物 F:/ai/comfui/output/<out>_00001_.mp4
  const outputDir = join(settings.comfyRoot, "output");
  const mp4 = readdirSync(outputDir).filter((f) => f.startsWith(outPrefix) && f.endsWith(".mp4")).sort().pop();
  if (!mp4) throw new Error("H3 未产出视频（ComfyUI 队列/显存？）");
  const dst = join(ctx.outputDir, mp4);
  copyFileSync(join(outputDir, mp4), dst);
  return { video: { path: dst, frameCount: 73, action } };
}

/** comfy.image-edit：Qwen-Image-Edit 2509 图片编辑（prompt 驱动） */
async function comfyImageEdit(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const { settings, scriptDir } = comfyEnv();
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("图片编辑节点缺少输入图");
  const prompt = String(node.params.prompt ?? "").trim();
  if (!prompt) throw new Error("图片编辑需要编辑指令");
  const { mkdirSync, copyFileSync, readdirSync } = await import("node:fs");
  const inputDir = join(settings.comfyRoot, "input");
  mkdirSync(inputDir, { recursive: true });
  const src = images.paths[0]!;
  const inputName = `graph_edit_${uid().slice(0, 8)}.png`;
  copyFileSync(src, join(inputDir, inputName));
  const outPrefix = `graph_edit_${uid().slice(0, 8)}`;

  ctx.report(`图片编辑（约 3 分钟）…`);
  await runCmd(
    [settings.pythonBin, join(scriptDir, "comfy_qwen_edit.py"), "--image", inputName, "--prompt", prompt, "--out", outPrefix],
    undefined,
    ctx.signal
  );
  const outputDir = join(settings.comfyRoot, "output");
  const out = readdirSync(outputDir).filter((f) => f.startsWith(outPrefix) && /\.(png|webp)$/i.test(f)).sort().pop();
  if (!out) throw new Error("图片编辑未产出");
  const dst = join(ctx.outputDir, out);
  copyFileSync(join(outputDir, out), dst);
  return { images: { paths: [dst] } };
}

/** comfy.image-gen：Z-Image Turbo 文生图 */
async function comfyImageGen(node: GraphNode, ctx: NodeContext): Promise<NodeOutput> {
  const { settings, scriptDir } = comfyEnv();
  const prompt = String(node.params.prompt ?? "").trim();
  if (!prompt) throw new Error("图片生成需要提示词");
  const size = Math.max(256, Math.min(1536, Math.floor(Number(node.params.size ?? 1024))));
  const { mkdirSync, readdirSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const outPrefix = `graph_gen_${uid().slice(0, 8)}`;

  ctx.report(`生成图片（约 2 分钟）…`);
  await runCmd(
    [settings.pythonBin, join(scriptDir, "comfy_zimage.py"), "--prompt", prompt, "--out", outPrefix, "--size", String(size)],
    undefined,
    ctx.signal
  );
  const outputDir = join(settings.comfyRoot, "output");
  const out = readdirSync(outputDir).filter((f) => f.startsWith(outPrefix) && /\.(png|webp)$/i.test(f)).sort().pop();
  if (!out) throw new Error("图片生成未产出");
  const { copyFileSync } = await import("node:fs");
  const dst = join(ctx.outputDir, out);
  copyFileSync(join(outputDir, out), dst);
  return { images: { paths: [dst] } };
}

/**
 * comfy.layered：本地 Qwen-Image-Layered 图生拆层（设置页「场景分层」的本地免费版）。
 * 图生模式实测（SKILL）：最后一层是干净主体，中间层是实心背景板 —— filterSolid 自动丢弃。
 */
async function comfyLayered(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("遮挡分层节点缺少输入图");
  const prompt = String(node.params.prompt ?? "").trim();
  if (!prompt) throw new Error("遮挡分层需要整图描述（写整图内容，含被遮挡部分）");
  const layers = Math.max(1, Math.min(4, Math.floor(Number(node.params.layers ?? 2))));
  const size = Math.max(512, Math.min(1024, Math.floor(Number(node.params.size ?? 640))));
  const filterSolid = node.params.filterSolid !== false;
  // 核心与本地分层 job 共用（jobs/comfyLayers.ts），避免等产物/copy/过滤逻辑重复。
  const paths = await runComfyLayered({
    srcPath: images.paths[0]!,
    prompt,
    layers,
    size,
    filterSolid,
    outputDir: ctx.outputDir,
    report: (p) => ctx.report(p),
    signal: ctx.signal,
  });
  return { images: { paths } satisfies ImageSequencePayload };
}

/** layers.to-psd：图层 PNG 清单 → 整幅堆叠 PSD（matte_cli --op layered-psd，复用 sprite export_layered_psd） */
async function layersToPsd(
  node: GraphNode,
  inputs: Record<string, Record<string, unknown>>,
  ctx: NodeContext
): Promise<NodeOutput> {
  const settings = getSpriteMattingSettings();
  if (!spriteMattingConfigured(settings)) {
    throw new Error("PSD 合成需要 sprite 工坊环境（设置页配置 pythonBin + matte_cli.py）");
  }
  const images = inputs.images as unknown as ImageSequencePayload | undefined;
  if (!images?.paths?.length) throw new Error("图层合成 PSD 缺少图层输入");
  const name = String(node.params.name ?? "layers").replace(/[\\/:*?"<>|]/g, "_") || "layers";
  const { mkdirSync, existsSync } = await import("node:fs");
  mkdirSync(ctx.outputDir, { recursive: true });
  const psdPath = join(ctx.outputDir, `${name}.psd`);
  ctx.report(`合成 ${images.paths.length} 层 PSD…`);
  await runCmd(
    [
      settings.pythonBin, settings.cliPath,
      "--op", "layered-psd",
      "--input", images.paths[0]!,
      "--psd-out", psdPath,
      "--psd-layers", JSON.stringify(images.paths),
    ],
    undefined,
    ctx.signal
  );
  if (!existsSync(psdPath)) throw new Error("PSD 未产出");
  ctx.report(`完成：${name}.psd（${images.paths.length} 层）`);
  return {
    sheet: { path: psdPath, outputDir: ctx.outputDir, layerCount: images.paths.length, files: { psd: psdPath } },
  };
}
