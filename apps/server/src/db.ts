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
mkdirSync(join(STORAGE_ROOT, "raster-sequences"), { recursive: true });

export const db = new Database(join(STORAGE_ROOT, "framebaker.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'frame',
  folder_id TEXT,
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
  folder_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_kind_parent ON folders(kind, parent_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS animation_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('skeleton', 'motion-clip', 'character-binding', 'render-profile')),
  name TEXT NOT NULL,
  skeleton_id TEXT,
  folder_id TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_animation_assets_kind_folder ON animation_assets(kind, folder_id);
CREATE INDEX IF NOT EXISTS idx_animation_assets_skeleton ON animation_assets(skeleton_id);

CREATE TABLE IF NOT EXISTS skeletal_projects (
  project_id TEXT PRIMARY KEY,
  document TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS raster_sequences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raster_sequences_created ON raster_sequences(created_at);
`);

// SQLite 无法原地修改 CHECK；安全重建旧版动画资产表并保留全部行。
const animationAssetsSql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'animation_assets'").get() as { sql: string } | null)?.sql ?? "";
if (!animationAssetsSql.includes("character-binding") || !animationAssetsSql.includes("render-profile")) {
  db.transaction(() => {
    db.exec("DROP INDEX IF EXISTS idx_animation_assets_kind_folder; DROP INDEX IF EXISTS idx_animation_assets_skeleton;");
    db.exec("ALTER TABLE animation_assets RENAME TO animation_assets_legacy");
    db.exec(`CREATE TABLE animation_assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('skeleton', 'motion-clip', 'character-binding', 'render-profile')),
      name TEXT NOT NULL, skeleton_id TEXT, folder_id TEXT, data TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO animation_assets SELECT id, kind, name, skeleton_id, folder_id, data, created_at, updated_at FROM animation_assets_legacy");
    db.exec("DROP TABLE animation_assets_legacy");
    db.exec("CREATE INDEX idx_animation_assets_kind_folder ON animation_assets(kind, folder_id); CREATE INDEX idx_animation_assets_skeleton ON animation_assets(skeleton_id);");
  })();
}

// 存量库补列（CREATE IF NOT EXISTS 不会改已有表）
function ensureColumn(table: string, column: string, decl: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
ensureColumn("projects", "folder_id", "TEXT");
ensureColumn("projects", "kind", "TEXT NOT NULL DEFAULT 'frame'");
ensureColumn("materials", "folder_id", "TEXT");

// 视频/GIF 抽帧入库曾误标 source=mp4|gif；PNG 产物改为 extract
db.query(
  "UPDATE materials SET source = 'extract' WHERE source IN ('mp4', 'gif') AND (raw_path LIKE '%.png' OR raw_path LIKE '%.PNG')"
).run();
db.query(
  "UPDATE frames SET source = 'extract' WHERE source IN ('mp4', 'gif') AND (raw_path LIKE '%.png' OR raw_path LIKE '%.PNG')"
).run();

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
  const path = m.raw_path ?? m.processed_path ?? "";
  const kind: Material["kind"] = /\.(mp4|mov|webm|avi)$/i.test(path) ? "video" : "image";
  return { ...m, metadata: parseJson<Record<string, unknown>>(m.metadata, {}), kind } as Material;
}
