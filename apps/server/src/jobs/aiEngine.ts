// AI 抠图引擎按需安装（桌面版）：BiRefNet（torch+transformers+模型）+ rembg（独立 venv）。
// 落位 exe 旁 ai-engine/（与 resources 平级，升级安装不覆盖）：
//   ai-engine/venv-ai/           torch 等 AI 推理 venv（sprite birefnet 用）
//   ai-engine/models/hub/...     BiRefNet HF 标准缓存布局（SPRITE_VIDEO_LAB_AI_MODEL_CACHE 指向 ai-engine/models）
//   ai-engine/venv-rembg/        rembg venv（素材库一键抠图用，探测路径加入候选）
// 安装源策略：本机已有（源码版 sprite 缓存 / FrameBaker .venv-matting）直接拷贝零下载；
// 没有则 pip 装包（清华镜像）+ huggingface_hub 下载模型（HF_ENDPOINT 镜像）。
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_ROOT, AI_ENGINE_MODELS, AI_ENGINE_PYTHON, AI_ENGINE_ROOT } from "../paths";
import { getSpriteMattingSettings } from "../provider";
import { runCmd } from "./run";

const PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple";
const HF_ENDPOINT = "https://hf-mirror.com";
/** BiRefNet 各仓库：HR-matting 为默认（424MB）；all=三个全装 */
const BIREFNET_REPOS = ["ZhengPeng7/BiRefNet_HR-matting", "ZhengPeng7/BiRefNet", "ZhengPeng7/BiRefNet_lite-2K"];

/** job 载荷（POST /api/ai-engine/install） */
export interface AiEnginePayload {
  /** GPU（NVIDIA cu128）或 CPU torch；默认按 nvidia-smi 探测 */
  device: "auto" | "cuda" | "cpu";
  /** 安装哪些 BiRefNet（默认只装 HR-matting） */
  allModels: boolean;
  /** 同时装 rembg（素材库一键抠图） */
  rembg: boolean;
}

export interface AiEngineStatus {
  installed: boolean;
  birefnetPython: boolean;
  rembgVenv: boolean;
  models: string[];
}

/** 状态查询（设置页显示 + getMattingInfo 探测用） */
export function getAiEngineStatus(): AiEngineStatus {
  const modelsDir = AI_ENGINE_MODELS;
  // from_pretrained 实际命中的布局是 <models>/models--X（无 hub 层，对齐 sprite 错位布局）
  const models = modelsDir && existsSync(modelsDir)
    ? readdirSync(modelsDir).filter((d) => d.startsWith("models--")).map((d) => d.replace(/^models--/, "").replace(/--/g, "/"))
    : [];
  return {
    installed: !!(AI_ENGINE_PYTHON && existsSync(AI_ENGINE_PYTHON) && models.length > 0),
    birefnetPython: !!(AI_ENGINE_PYTHON && existsSync(AI_ENGINE_PYTHON)),
    rembgVenv: !!(AI_ENGINE_ROOT && existsSync(join(AI_ENGINE_ROOT, "venv-rembg", "Scripts", "rembg.exe"))),
    models,
  };
}

/** 从本机已有缓存找 HF 仓库（兼容规范 hub/ 与历史错位两种布局，对齐 sprite hf_repo_cached）。
 *  注意：hub/ 下可能存在「仅裸权重文件」的空壳目录（无 snapshots），必须校验 snapshots 真实存在。 */
function findLocalHfRepo(repoId: string): { blobs: string } | null {
  const sources = [
    // 1. 源码版 sprite 工坊的模型缓存（settings 指向的 cliPath 反推）
    spriteHuggingfaceRoot(),
  ].filter((s): s is string => !!s);
  const name = `models--${repoId.replace("/", "--")}`;
  for (const root of sources) {
    for (const candidate of [join(root, "hub", name), join(root, name)]) {
      if (!existsSync(join(candidate, "snapshots"))) continue; // 空壳（仅裸权重）跳过
      return { blobs: candidate };
    }
  }
  return null;
}

/** 源码版 sprite 工坊的 huggingface 缓存根（work/models/huggingface） */
function spriteHuggingfaceRoot(): string | null {
  const settings = getSpriteMattingSettings();
  if (!settings.cliPath || !existsSync(settings.cliPath)) return null;
  // cliPath = <sprite>/matte_cli.py → dirname 即 sprite 根 → <sprite>/work/models/huggingface
  const root = join(dirname(settings.cliPath), "work", "models", "huggingface");
  return existsSync(root) ? root : null;
}

/** 主流程：装 venv-ai + 拷/下模型 + 可选 rembg */
export async function installAiEngine(
  payload: AiEnginePayload,
  report: (p: string) => void,
  signal: AbortSignal
) {
  if (!AI_ENGINE_ROOT || !AI_ENGINE_MODELS || !AI_ENGINE_PYTHON) throw new Error("AI 引擎仅打包版支持（源码版请直接配置 spriteMatting）");
  mkdirSync(AI_ENGINE_ROOT, { recursive: true });

  // ── 1. venv-ai：torch + transformers ──
  if (!existsSync(AI_ENGINE_PYTHON)) {
    report("创建 AI 推理环境（venv-ai）…");
    const hasNvidia = payload.device === "cuda" || (payload.device === "auto" && Bun.which("nvidia-smi") != null);
    const venvDir = join(AI_ENGINE_ROOT, "venv-ai");
    await runCmd([await resolveBasePython(), "-m", "venv", venvDir], undefined, signal);
    const pip = join(venvDir, "Scripts", "pip.exe");
    report(`安装 torch/transformers（${hasNvidia ? "CUDA" : "CPU"} 版，约 0.2-3GB，需数分钟）…`);
    if (hasNvidia) {
      await runCmd(
        [pip, "install", "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu128"],
        undefined,
        signal
      ).catch(async () => {
        report("CUDA 索引失败，回退 CPU 版…");
        await runCmd([pip, "install", "torch", "torchvision", "-i", PIP_INDEX], undefined, signal);
      });
    } else {
      await runCmd([pip, "install", "torch", "torchvision", "-i", PIP_INDEX], undefined, signal);
    }
    report("安装 transformers / safetensors…");
    // 版本对齐 sprite 工坊实测环境（transformers 5.x / hub 1.x 改了缓存协议，本地缓存布局不兼容）
    // einops/kornia：BiRefNet modeling 文件（trust_remote_code）硬依赖
    await runCmd(
      [pip, "install", "transformers==4.57.3", "huggingface_hub==0.36.0", "safetensors", "timm", "einops", "kornia", "-i", PIP_INDEX],
      undefined,
      signal
    );
  } else {
    report("venv-ai 已存在，跳过");
  }

  // ── 2. BiRefNet 模型：本机拷贝优先，否则 HF 镜像下载 ──
  // 布局对齐 sprite 实测：<models>/models--X/snapshots/...（无 hub 层）——
  // transformers from_pretrained(cache_dir=models) 直接在 models/ 下找 models--X，
  // server.py 的 HF_HOME=setdefault 也是这套（其 hf_repo_cached 兼容两种位置）。
  const repos = payload.allModels ? BIREFNET_REPOS : [BIREFNET_REPOS[0]!];
  for (const repo of repos) {
    if (signal.aborted) throw new Error("已取消");
    const local = findLocalHfRepo(repo);
    if (local) {
      report(`复制本机已有模型 ${repo}（约 200-450MB）…`);
      mkdirSync(AI_ENGINE_MODELS, { recursive: true });
      cpSync(local.blobs, join(AI_ENGINE_MODELS, `models--${repo.replace("/", "--")}`), { recursive: true });
    } else {
      report(`下载模型 ${repo}（HF 镜像，约 200-450MB）…`);
      await runCmd(
        [
          AI_ENGINE_PYTHON, "-c",
          `from huggingface_hub import snapshot_download; snapshot_download(repo_id=${JSON.stringify(repo)}, cache_dir=${JSON.stringify(AI_ENGINE_MODELS)})`,
        ],
        { HF_ENDPOINT, HF_HUB_DISABLE_SYMLINKS_WARNING: "1" },
        signal
      );
    }
  }

  // ── 3. rembg（可选）：独立 venv + u2net 模型 ──
  if (payload.rembg) {
    const rembgExe = join(AI_ENGINE_ROOT, "venv-rembg", "Scripts", "rembg.exe");
    if (!existsSync(rembgExe)) {
      report("安装 rembg（素材库一键抠图引擎）…");
      const venvDir = join(AI_ENGINE_ROOT, "venv-rembg");
      await runCmd([await resolveBasePython(), "-m", "venv", venvDir], undefined, signal);
      await runCmd([join(venvDir, "Scripts", "pip.exe"), "install", "rembg[cli,cpu]", "-i", PIP_INDEX], undefined, signal);
    }
    // u2net 权重：本机源码版已有则拷（storage/models/u2net.onnx → AI 引擎侧经 U2NET_HOME 由
    // matting.ts 探测，这里落到 ai-engine/models，matting 候选路径已含此位置）
    const u2netSrc = join(APP_ROOT, "storage", "models", "u2net.onnx");
    const u2netDst = join(AI_ENGINE_MODELS, "u2net.onnx");
    if (existsSync(u2netSrc) && !existsSync(u2netDst)) {
      report("复制 u2net 权重…");
      copyFileSync(u2netSrc, u2netDst);
    }
  }

  report("AI 引擎安装完成（BiRefNet 管线与设置页状态将立即生效）");
}

/** 找可用的基础 Python（venv 创建用）：PATH python / py launcher */
async function resolveBasePython(): Promise<string> {
  const direct = Bun.which("python");
  if (direct) return direct;
  const py = Bun.which("py");
  if (py) return py;
  // 内置 sprite venv 的 python 也能建 venv（venv 模块随标准库）
  const bundled = join(AI_ENGINE_ROOT!, "..", "resources", "sprite", "venv", "Scripts", "python.exe");
  if (existsSync(bundled)) return bundled;
  throw new Error("未找到 Python：请安装 Python 3.10+ 或 uv 后重试");
}

/** 卸载 AI 引擎（设置页「移除」） */
export function uninstallAiEngine(): boolean {
  if (!AI_ENGINE_ROOT || !existsSync(AI_ENGINE_ROOT)) return false;
  rmSync(AI_ENGINE_ROOT, { recursive: true, force: true });
  return true;
}
