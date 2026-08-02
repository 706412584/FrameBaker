import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Frame, FrameRow, Material, MaterialRow } from "@framebaker/shared";

// 仓库根目录（apps/server/src → 根）：storage 固定放在根级，与启动时的 cwd 无关
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
export const STORAGE_ROOT = join(REPO_ROOT, "storage");

// 确保运行时目录存在
mkdirSync(join(STORAGE_ROOT, "projects"), { recursive: true });
mkdirSync(join(STORAGE_ROOT, "staging"), { recursive: true });
mkdirSync(join(STORAGE_ROOT, "materials"), { recursive: true });

export const db = new Database(join(STORAGE_ROOT, "framebaker.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS frames (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  raw_path TEXT,
  processed_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  duration INTEGER NOT NULL DEFAULT 1,
  is_keyframe INTEGER NOT NULL DEFAULT 0,
  offset_x REAL NOT NULL DEFAULT 0,
  offset_y REAL NOT NULL DEFAULT 0,
  scale REAL NOT NULL DEFAULT 1,
  rotation REAL NOT NULL DEFAULT 0,
  opacity REAL NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'upload',
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_frames_project ON frames(project_id, idx);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT,
  raw_path TEXT,
  processed_path TEXT,
  status TEXT NOT NULL DEFAULT 'raw',
  source TEXT NOT NULL DEFAULT 'upload',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

export const uid = () => crypto.randomUUID();

export type { FrameRow, MaterialRow };

export function getFrame(id: string): FrameRow | null {
  return (db.query("SELECT * FROM frames WHERE id = ?").get(id) as FrameRow | null) ?? null;
}

/** 项目内下一个帧序号 */
export function nextFrameIdx(projectId: string): number {
  const row = db.query("SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM frames WHERE project_id = ?").get(projectId) as {
    next: number;
  };
  return row.next;
}

export function getMaterial(id: string): MaterialRow | null {
  return (db.query("SELECT * FROM materials WHERE id = ?").get(id) as MaterialRow | null) ?? null;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(text ?? "") as T;
  } catch {
    return fallback;
  }
}

/** DB 行 → API 输出（解析 JSON 字段；status/source 受 DB 约束，直接收窄） */
export function serializeFrame(f: FrameRow): Frame {
  return {
    ...f,
    tags: parseJson<string[]>(f.tags, []),
    metadata: parseJson<Record<string, unknown>>(f.metadata, {}),
  } as Frame;
}

export function serializeMaterial(m: MaterialRow): Material {
  return { ...m, metadata: parseJson<Record<string, unknown>>(m.metadata, {}) } as Material;
}
