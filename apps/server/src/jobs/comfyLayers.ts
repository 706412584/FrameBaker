// 本地 ComfyUI Qwen-Image-Layered 图生拆层 → 落库为多素材（对齐云端 imageLayers.ts 的入库语义）。
// 核心 runComfyLayered 与 graph 节点 comfy.layered 共用（graph/nodes.ts 调用此处，遵循 graph→jobs 单向依赖）。
import { mkdirSync, copyFileSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, getMaterial, STORAGE_ROOT, uid } from "../db";
import { getComfyLocalSettings } from "../provider";
import { COMFY_SCRIPTS_ROOT } from "../paths";
import { broadcast } from "../ws";
import { JobCancelledError, runCmd } from "./run";

export interface ComfyLayersPayload {
  materialId: string;
  /** 整图描述（写整图内容含被遮挡部分，引导补全）；空串亦可，模型仍能拆。 */
  prompt: string;
  layers: number;
  size: number;
  filterSolid: boolean;
}

// comfy 脚本目录：源码在 apps/server/graph/comfy；打包后随 resources/comfy（paths.ts 统一判定）
const SCRIPT_DIR = COMFY_SCRIPTS_ROOT;

/**
 * 调本地 ComfyUI Qwen-Image-Layered 把 srcPath 拆成透明层，产物 PNG 落 outputDir，返回其绝对路径列表。
 * 逻辑与 graph comfy.layered 节点一致：waitStableFiles（等文件数稳定）+ waitForFile（等逐个落盘）
 * + Windows copy 重试 + 可选实心层过滤（丢弃 alpha≈255 的背景板）。
 */
export async function runComfyLayered(opts: {
  srcPath: string;
  prompt: string;
  layers: number;
  size: number;
  filterSolid: boolean;
  outputDir: string;
  report: (p: string) => void;
  signal: AbortSignal;
}): Promise<string[]> {
  const { srcPath, prompt, layers, size, filterSolid, outputDir, report, signal } = opts;
  const settings = getComfyLocalSettings();
  mkdirSync(outputDir, { recursive: true }); // 产物目录（漏建会让 copy 报源路径的 ENOENT 假象）
  const inputDir = join(settings.comfyRoot, "input");
  mkdirSync(inputDir, { recursive: true });
  const inputName = `job_ly_${uid().slice(0, 8)}.png`;
  copyFileSync(srcPath, join(inputDir, inputName));
  const outPrefix = `job_ly_${uid().slice(0, 8)}`;

  report(`Qwen 遮挡分层（${layers}+1 层，${size}px，约 6-10 分钟）…`);
  await runCmd(
    [
      settings.pythonBin, join(SCRIPT_DIR, "comfy_qwen_layered.py"),
      "--prompt", prompt,
      "--image", inputName,
      "--out", outPrefix,
      "--layers", String(layers),
      "--size", String(size),
    ],
    undefined,
    signal
  );
  // 产物 <prefix>_00001_.png 起。ComfyUI history 写入早于 SaveImage 全部落盘：
  // 先等文件数稳定（layers+1 张或 3s 无新增），再逐文件等真正落盘。
  const comfyOut = join(settings.comfyRoot, "output");
  const waitStableFiles = async (prefix: string, expectMin: number): Promise<string[]> => {
    let last: string[] = [];
    let stableSince = 0;
    for (let i = 0; i < 60; i++) {
      if (signal.aborted) throw new JobCancelledError();
      const now = readdirSync(comfyOut).filter((f) => f.startsWith(prefix) && f.endsWith(".png")).sort();
      if (now.length === last.length && now.length >= expectMin) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince > 3000) return now;
      } else {
        stableSince = 0;
      }
      last = now;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return last;
  };
  let outs = await waitStableFiles(outPrefix, layers + 1);
  if (outs.length === 0) throw new Error("遮挡分层未产出图层（ComfyUI 队列/显存？）");
  const waitForFile = async (p: string) => {
    for (let i = 0; i < 120; i++) {
      if (existsSync(p) && statSync(p).size > 0) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return existsSync(p);
  };
  const allReady: string[] = [];
  for (const f of outs) {
    if (await waitForFile(join(comfyOut, f))) allReady.push(f);
  }
  outs = allReady;
  if (outs.length === 0) throw new Error("遮挡分层产物未落盘（等待 2 分钟超时）");
  const kept: string[] = [];
  for (const f of outs) {
    const dst = join(outputDir, f);
    const src = join(comfyOut, f);
    // Windows 下 ComfyUI 写盘/杀软扫描瞬时占用会让 copy 诡异地报 ENOENT，带重试兜底
    let copied = false;
    for (let attempt = 0; attempt < 5 && !copied; attempt++) {
      try {
        copyFileSync(src, dst);
        copied = true;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    kept.push(dst);
  }
  // 实心层过滤：一次 python 进程判定全部层，丢弃 alpha=255 占比 >99% 的背景板
  let finalPaths = kept;
  if (filterSolid) {
    const script = `import json,sys
from PIL import Image
out=[]
for p in json.load(open(sys.argv[1])):
    im=Image.open(p).convert("RGBA")
    hist=im.getchannel("A").histogram()
    total=im.width*im.height
    out.append(None if hist[255]/total>0.99 else p)
print(json.dumps(out))`;
    const listFile = join(outputDir, "_layers.json");
    await Bun.write(listFile, JSON.stringify(kept));
    const proc = Bun.spawn([settings.pythonBin, "-c", script, listFile], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code === 0 && stdout.trim()) {
      finalPaths = (JSON.parse(stdout.trim()) as Array<string | null>).filter((p): p is string => !!p);
      if (finalPaths.length === 0) throw new Error("全部图层被判定为实心背景板（换 seed 或关闭过滤实心层）");
    }
  }
  report(`分层完成：${finalPaths.length}/${outs.length} 层可用`);
  return finalPaths;
}

/** 本地分层 job：对素材跑 runComfyLayered，产物入库为多个新素材（继承源素材文件夹）。 */
export async function splitComfyLayers(
  payload: ComfyLayersPayload,
  report: (p: string) => void,
  signal: AbortSignal
) {
  const material = getMaterial(payload.materialId);
  if (!material) throw new Error("素材不存在");
  const input = material.processed_path && existsSync(material.processed_path) ? material.processed_path : material.raw_path;
  if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) throw new Error("只支持图片素材分层");
  if (signal.aborted) throw new JobCancelledError();

  const workDir = join(STORAGE_ROOT, "staging", `comfy_layers_${uid()}`);
  try {
    const layerPaths = await runComfyLayered({
      srcPath: input,
      prompt: payload.prompt.trim(),
      layers: payload.layers,
      size: payload.size,
      filterSolid: payload.filterSolid,
      outputDir: workDir,
      report,
      signal,
    });
    if (signal.aborted) throw new JobCancelledError();
    // 落库为多素材（对齐 imageLayers.ts 语义：新目录 raw.png + 事务批量 INSERT）
    const prepared = layerPaths.map((src, i) => {
      const id = uid();
      const dir = join(STORAGE_ROOT, "materials", id);
      return { id, dir, path: join(dir, "raw.png"), src, i };
    });
    for (const item of prepared) {
      mkdirSync(item.dir, { recursive: true });
      copyFileSync(item.src, item.path);
    }
    if (signal.aborted) throw new JobCancelledError();
    const insert = db.query(
      "INSERT INTO materials (id, name, raw_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, 'raw', 'layers', ?, ?, ?)"
    );
    db.transaction(() =>
      prepared.forEach((item) =>
        insert.run(
          item.id,
          `${material.name || "素材"} 图层 ${item.i + 1}`,
          item.path,
          material.folder_id,
          JSON.stringify({
            fromMaterial: material.id,
            layerIndex: item.i,
            layerCount: prepared.length,
            provider: "comfyLayered",
            comfyLayers: { prompt: payload.prompt.trim(), layers: payload.layers, size: payload.size, filterSolid: payload.filterSolid },
          }),
          Date.now() + item.i
        )
      )
    )();
    broadcast("materials_changed", {});
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
