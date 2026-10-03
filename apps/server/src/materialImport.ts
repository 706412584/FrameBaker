/**
 * 本地文件登记进素材库（磁盘路径 → materials 表 + storage 拷贝）。
 *
 * 与 UI 上传（POST /api/materials/upload，multipart 文件流）互补：这里接受服务器
 * 本地绝对路径，供 MCP 工具把外部生成的产物（ffmpeg 抽帧、外部 AI 输出）直接喂进
 * 素材库，无需浏览器中转。
 *
 * 语义对齐画布上传的 graphRaw 分支：一个文件 = 一个素材，不拆帧。视频/GIF 想拆帧
 * 请随后调 extract_material_frames（或 extract.frames 节点）。
 *
 * 安全/健壮性约定：
 * - 拒绝符号链接（symlink 会绕过扩展名检查读到白名单外的文件内容）；
 * - 拷贝 + 写库视为一个单元：写库失败清理已落盘的素材目录，不留孤儿；
 * - 目录批量逐文件容错：单个失败不影响其余，失败项经 failed[] 返回给调用方。
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from "node:fs";
import { basename, extname, join } from "node:path";
import { db, STORAGE_ROOT, uid } from "./db";

/** 允许登记的图片扩展名（含 psd/gif：前者给 material.psd 节点，后者可再抽帧） */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "tga", "gif", "psd"] as const;
/** 允许登记的视频扩展名 —— 与 db.serializeMaterial 的 kind 推断保持一致 */
const VIDEO_EXTS = ["mp4", "mov", "webm", "avi"] as const;

const ALLOWED_EXTS = new Set<string>([...IMAGE_EXTS, ...VIDEO_EXTS]);

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function extOfLocalPath(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

export function isSupportedLocalAsset(path: string): boolean {
  return ALLOWED_EXTS.has(extOfLocalPath(path));
}

/** 素材 kind：与 db.serializeMaterial 同规则（视频靠扩展名） */
export function localAssetKind(path: string): "image" | "video" {
  return (VIDEO_EXTS as readonly string[]).includes(extOfLocalPath(path)) ? "video" : "image";
}

export interface ImportedLocalMaterial {
  id: string;
  name: string;
  kind: "image" | "video";
  source: "file";
  raw_path: string;
  originalPath: string;
}

export interface ImportLocalOptions {
  /** 覆盖素材名（缺省用文件名去扩展名） */
  name?: string;
  /** 目标文件夹（kind=material）；调用方负责校验存在性 */
  folderId?: string | null;
}

/**
 * 读取路径元信息并拒绝符号链接。
 * symlink 会让扩展名白名单失效（`x.png -> ~/.ssh/id_rsa`），故一律拒绝。
 */
function lstatOrThrow(target: string): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch {
    throw new Error(`路径不存在或无法访问: ${target}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`不支持符号链接（可能绕过类型检查）: ${target}`);
  return stat;
}

/** 把单个本地文件拷进素材库并写入 materials 行。失败抛错（中文信息，供工具层透传）。 */
export function importLocalFileToLibrary(filePath: string, opts: ImportLocalOptions = {}): ImportedLocalMaterial {
  const stat = lstatOrThrow(filePath);
  if (!stat.isFile()) throw new Error(`不是文件（目录请传目录路径）: ${filePath}`);

  const ext = extOfLocalPath(filePath);
  if (!ALLOWED_EXTS.has(ext)) {
    const shown = ext ? `.${ext}` : "（无扩展名）";
    throw new Error(`不支持的素材类型 ${shown}（支持图片：${IMAGE_EXTS.join("/")}；视频：${VIDEO_EXTS.join("/")}）`);
  }

  const originalName = basename(filePath);
  const name = opts.name?.trim() || originalName.replace(/\.[^.]+$/, "") || "素材";
  const id = uid();
  const dir = join(STORAGE_ROOT, "materials", id);
  const rawPath = join(dir, `raw.${ext}`);

  // 拷贝 + 写库视为一个单元：任一步失败都清理已建目录，避免孤儿素材目录。
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(filePath, rawPath);
    const metadata = { localFile: originalName };
    db.query(
      "INSERT INTO materials (id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, NULL, 'raw', 'file', ?, ?, ?)"
    ).run(id, name, rawPath, opts.folderId ?? null, JSON.stringify(metadata), Date.now());
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`导入失败（已回滚）: ${(e as Error).message}`);
  }

  return { id, name, kind: localAssetKind(filePath), source: "file", raw_path: rawPath, originalPath: filePath };
}

export interface ImportFailure {
  /** 源文件绝对路径 */
  path: string;
  error: string;
}

export interface ImportLocalPathResult {
  materials: ImportedLocalMaterial[];
  /** 目录批量时被跳过的条目：扩展名不受支持的文件、以及子目录（当前不递归） */
  skipped: string[];
  /** 目录批量时逐个导入失败的项（单文件模式为空） */
  failed: ImportFailure[];
}

/**
 * 路径入口：文件 → 导入 1 个素材；目录 → 导入其中全部受支持文件（各 1 个素材）。
 * 目录内没有任何受支持文件时抛错，避免调用方误以为导入成功。
 * 目录批量逐个容错：单个文件失败只记入 failed[]，其余照常导入。
 */
export function importLocalPathToLibrary(inputPath: string, opts: ImportLocalOptions = {}): ImportLocalPathResult {
  const stat = lstatOrThrow(inputPath);

  if (stat.isFile()) {
    return { materials: [importLocalFileToLibrary(inputPath, opts)], skipped: [], failed: [] };
  }
  if (!stat.isDirectory()) throw new Error(`不支持的路径类型（既非文件也非目录）: ${inputPath}`);

  const entries = readdirSync(inputPath, { withFileTypes: true });
  // 只处理「普通文件 + 受支持扩展名」；其余（不支持的文件、子目录、符号链接、特殊项）
  // 全部进 skipped —— 不能静默丢弃，否则用户以为已全部导入。
  const supported = entries
    .filter((entry) => entry.isFile() && isSupportedLocalAsset(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => nameCollator.compare(a, b));
  if (supported.length === 0) {
    throw new Error(`目录内没有可导入的图片/视频文件: ${inputPath}`);
  }
  const skipped = entries
    .filter((entry) => !(entry.isFile() && isSupportedLocalAsset(entry.name)))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

  // 显式命名只对单文件有意义；目录批量一律用各自文件名
  const materials: ImportedLocalMaterial[] = [];
  const failed: ImportFailure[] = [];
  for (const name of supported) {
    const file = join(inputPath, name);
    try {
      materials.push(importLocalFileToLibrary(file, { folderId: opts.folderId }));
    } catch (e) {
      failed.push({ path: file, error: (e as Error).message });
    }
  }
  return { materials, skipped, failed };
}
