import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GenerationIntent, GenProviderType } from "@framebaker/shared";
import { db, STORAGE_ROOT, uid } from "../db";
import { broadcast } from "../ws";
import { appendFramePool } from "../timeline";
import { invalidateProjectUndo } from "../undo";

type Target = { kind: "project"; projectId: string } | { kind: "materials" };
type EnqueueMatting = (projectId: string, target: "frame" | "material", id: string) => void;
type MediaKind = "image" | "video";

interface ArtifactAllocation {
  kind: MediaKind;
  requestedKind: MediaKind;
  index: number;
  path: string;
  id?: string;
  disposableDir?: string;
}

export interface ArtifactCommitResult {
  kind: MediaKind;
  id: string;
}

function isVideoArtifact(path: string): boolean {
  const buffer = Buffer.alloc(16);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  const head = buffer.toString("latin1");
  return (
    head.slice(4, 8) === "ftyp" ||
    head.startsWith("\x1a\x45\xdf\xa3") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "AVI ")
  );
}

function nextNumber(rawDir: string): number {
  let next = 0;
  for (const file of readdirSync(rawDir)) {
    const match = /^frame_(\d+)\.png$/.exec(file);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

export function createGeneratedArtifactCommitter(options: {
  target: Target;
  count: number;
  autoMatting: boolean;
  name: string;
  folderId?: string | null;
  source: GenProviderType;
  prompt: string;
  providerName: string;
  model?: string;
  size?: string;
  enqueueMatting: EnqueueMatting;
  intent?: GenerationIntent;
  characterPartSetId?: string;
  referenceMaterialId?: string;
}) {
  const ids: string[] = [];
  let finished = false;
  let projectRaw = "";
  let projectStart = 0;
  if (options.target.kind === "project") {
    projectRaw = join(STORAGE_ROOT, "projects", options.target.projectId, "raw");
    mkdirSync(projectRaw, { recursive: true });
    mkdirSync(join(STORAGE_ROOT, "projects", options.target.projectId, "processed"), { recursive: true });
    projectStart = nextNumber(projectRaw);
  }
  const metadata = (index: number) =>
    JSON.stringify({
      prompt: options.prompt,
      index,
      provider: options.providerName,
      model: options.model || undefined,
      size: options.size || undefined,
      intent: options.intent || undefined,
      characterPartSetId: options.characterPartSetId || undefined,
      referenceMaterialId: options.referenceMaterialId || undefined,
    });

  const allocate = (kind: MediaKind, index: number, requestedKind = kind): ArtifactAllocation => {
    if (kind === "video") {
      const dir = join(STORAGE_ROOT, "staging", `genvid_${uid()}`);
      mkdirSync(dir, { recursive: true });
      return { kind, requestedKind, index, path: join(dir, "output.mp4"), disposableDir: dir };
    }
    if (options.target.kind === "project") {
      const dir = join(STORAGE_ROOT, "staging", `genimg_${uid()}`);
      mkdirSync(dir, { recursive: true });
      return {
        kind,
        requestedKind,
        index,
        path: join(dir, "output.png"),
        disposableDir: dir,
      };
    }
    const id = uid();
    const dir = join(STORAGE_ROOT, "materials", id);
    mkdirSync(dir, { recursive: true });
    return { kind, requestedKind, index, path: join(dir, "raw.png"), id, disposableDir: dir };
  };

  const discard = (allocation: ArtifactAllocation) => {
    if (allocation.disposableDir) rmSync(allocation.disposableDir, { recursive: true, force: true });
    else rmSync(allocation.path, { force: true });
  };

  const commitImage = (allocation: ArtifactAllocation): string => {
    const id = allocation.id ?? uid();
    if (options.target.kind === "project") {
      const rawPath = `${projectRaw}/frame_${String(projectStart + allocation.index).padStart(4, "0")}.png`;
      // Provider 输出先留在 staging；完成后同步提交，避免撤销读到半写文件。
      invalidateProjectUndo(options.target.projectId);
      renameSync(allocation.path, rawPath);
      if (allocation.disposableDir) rmSync(allocation.disposableDir, { recursive: true, force: true });
      try {
        appendFramePool(options.target.projectId,{id,raw_path:rawPath,status:options.autoMatting?"matting":"ready",source:options.source,metadata:metadata(allocation.index)});
      } catch (error) {
        rmSync(rawPath, { force: true });
        throw error;
      }
    } else {
      // 视频请求误返单图时只会提交一项，不追加 #1。
      const total = allocation.requestedKind === "video" ? 1 : options.count;
      db.query(
        "INSERT INTO materials (id, name, raw_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, 'raw', ?, ?, ?, ?)"
      ).run(
        id,
        total > 1 ? `${options.name} #${allocation.index + 1}` : options.name,
        allocation.path,
        options.source,
        options.folderId ?? null,
        metadata(allocation.index),
        Date.now()
      );
    }
    ids.push(id);
    return id;
  };

  const commitVideo = (allocation: ArtifactAllocation): string => {
    const id = uid();
    const dir = join(STORAGE_ROOT, "materials", id);
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, "raw.mp4");
    renameSync(allocation.path, rawPath);
    if (allocation.disposableDir) rmSync(allocation.disposableDir, { recursive: true, force: true });
    const meta = JSON.stringify({ ...JSON.parse(metadata(0)), mediaKind: "video" });
    db.query(
      "INSERT INTO materials (id, name, raw_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, 'raw', ?, ?, ?, ?)"
    ).run(id, options.name, rawPath, options.source, options.folderId ?? null, meta, Date.now());
    broadcast("materials_changed", {});
    return id;
  };

  return {
    allocate(kind: MediaKind, index: number) {
      return allocate(kind, index);
    },
    discard(allocation: ArtifactAllocation) {
      discard(allocation);
    },
    /** 校验并识别实际媒体类型；provider 误返另一类型时在 module 内转换目标 allocation。 */
    commit(allocation: ArtifactAllocation): ArtifactCommitResult {
      if (!existsSync(allocation.path)) throw new Error(`生成执行成功但未产出文件: ${allocation.path}`);
      const actual: MediaKind = isVideoArtifact(allocation.path) ? "video" : "image";
      if (actual !== allocation.kind) {
        const converted = allocate(actual, allocation.index, allocation.requestedKind);
        renameSync(allocation.path, converted.path);
        discard(allocation);
        allocation = converted;
      }
      const id = actual === "video" ? commitVideo(allocation) : commitImage(allocation);
      return { kind: actual, id };
    },
    finish() {
      if (finished) return;
      finished = true;
      if (!ids.length) return;
      if (options.target.kind === "project") {
        broadcast("frames_changed", { projectId: options.target.projectId });
        if (options.autoMatting) for (const id of ids) options.enqueueMatting(options.target.projectId, "frame", id);
      } else {
        broadcast("materials_changed", {});
        if (options.autoMatting) for (const id of ids) options.enqueueMatting("", "material", id);
      }
    },
  };
}
