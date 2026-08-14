import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureBuiltinAnimationAssets } from "./builtinAnimationAssets";
import type { AttackEffectCell, AttackEffectCellRow, Frame, FrameRow, Material, MaterialRow } from "@framebaker/shared";

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

CREATE TABLE IF NOT EXISTS animation_axes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  idx INTEGER NOT NULL, fps INTEGER NOT NULL DEFAULT 8, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS animation_tracks (
  id TEXT PRIMARY KEY, axis_id TEXT NOT NULL, name TEXT NOT NULL, idx INTEGER NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 0, is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS animation_steps (
  id TEXT PRIMARY KEY, axis_id TEXT NOT NULL, idx INTEGER NOT NULL, duration INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS attack_effects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

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

CREATE TABLE IF NOT EXISTS character_part_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'generated', 'decomposed')),
  reference_material_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS character_part_set_members (
  set_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('head','torso','pelvis','weapon','upper-arm-left','forearm-left','upper-arm-right','forearm-right','thigh-left','shin-left','thigh-right','shin-right','arm-left','arm-right','leg-left','leg-right','accessory','custom')),
  name TEXT NOT NULL,
  UNIQUE(set_id, material_id)
);
CREATE INDEX IF NOT EXISTS idx_character_part_set_members_set ON character_part_set_members(set_id);
CREATE INDEX IF NOT EXISTS idx_character_part_set_members_material ON character_part_set_members(material_id);

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
  kind TEXT NOT NULL CHECK (kind IN ('skeleton', 'motion-clip', 'character-binding')),
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
`);

// SQLite 无法原地修改 CHECK；扩充为 12 分件角色时保留旧六分件集合。
const characterPartMembersSql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'character_part_set_members'").get() as { sql: string } | null)?.sql ?? "";
if (!characterPartMembersSql.includes("forearm-left") || !characterPartMembersSql.includes("shin-right")) {
  db.transaction(() => {
    db.exec("DROP INDEX IF EXISTS idx_character_part_set_members_set; DROP INDEX IF EXISTS idx_character_part_set_members_material;");
    db.exec("ALTER TABLE character_part_set_members RENAME TO character_part_set_members_legacy");
    db.exec(`CREATE TABLE character_part_set_members (
      set_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('head','torso','pelvis','weapon','upper-arm-left','forearm-left','upper-arm-right','forearm-right','thigh-left','shin-left','thigh-right','shin-right','arm-left','arm-right','leg-left','leg-right','accessory','custom')),
      name TEXT NOT NULL,
      UNIQUE(set_id, material_id)
    )`);
    db.exec("INSERT INTO character_part_set_members SELECT set_id, material_id, role, name FROM character_part_set_members_legacy");
    db.exec("DROP TABLE character_part_set_members_legacy");
    db.exec("CREATE INDEX idx_character_part_set_members_set ON character_part_set_members(set_id); CREATE INDEX idx_character_part_set_members_material ON character_part_set_members(material_id);");
  })();
}

// SQLite 无法原地修改 CHECK；迁移旧约束并丢弃已经取消的渲染配置资产。
const animationAssetsSql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'animation_assets'").get() as { sql: string } | null)?.sql ?? "";
if (!animationAssetsSql.includes("character-binding") || animationAssetsSql.includes("render-profile")) {
  db.transaction(() => {
    db.exec("DROP INDEX IF EXISTS idx_animation_assets_kind_folder; DROP INDEX IF EXISTS idx_animation_assets_skeleton;");
    db.exec("ALTER TABLE animation_assets RENAME TO animation_assets_legacy");
    db.exec(`CREATE TABLE animation_assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('skeleton', 'motion-clip', 'character-binding')),
      name TEXT NOT NULL, skeleton_id TEXT, folder_id TEXT, data TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO animation_assets SELECT id, kind, name, skeleton_id, folder_id, data, created_at, updated_at FROM animation_assets_legacy WHERE kind != 'render-profile'");
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
ensureColumn("frames", "track_id", "TEXT");
ensureColumn("frames", "step_id", "TEXT");
ensureColumn("frames", "is_asset", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("frames", "attack_effect", "TEXT");

// v1：把旧项目无损投影到“默认轴 / 主轨 / 共享步骤”。确定性顺序为 idx,id。
db.transaction(() => {
  const projects = db.query("SELECT id, created_at FROM projects ORDER BY id").all() as Array<{ id: string; created_at: number }>;
  for (const project of projects) {
    let axis = db.query("SELECT id FROM animation_axes WHERE project_id = ? ORDER BY idx, id LIMIT 1").get(project.id) as { id: string } | null;
    if (!axis) {
      axis = { id: crypto.randomUUID() };
      db.query("INSERT INTO animation_axes (id, project_id, name, idx, fps, created_at) VALUES (?, ?, 'Default', 0, 8, ?)").run(axis.id, project.id, project.created_at);
    }
    let track = db.query("SELECT id FROM animation_tracks WHERE axis_id = ? ORDER BY is_primary DESC, idx, id LIMIT 1").get(axis.id) as { id: string } | null;
    if (!track) {
      track = { id: crypto.randomUUID() };
      db.query("INSERT INTO animation_tracks (id, axis_id, name, idx, visible, locked, is_primary) VALUES (?, ?, 'Main', 0, 1, 0, 1)").run(track.id, axis.id);
    }
    db.query("UPDATE animation_tracks SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE axis_id = ?").run(track.id, axis.id);
    const legacyPending = !db.query("SELECT 1 FROM schema_migrations WHERE version=1").get();
    const frames = legacyPending
      ? db.query("SELECT id, duration FROM frames WHERE project_id = ? AND (track_id IS NULL OR step_id IS NULL) ORDER BY idx, id").all(project.id) as Array<{ id: string; duration: number }>
      : [];
    let next = (db.query("SELECT COALESCE(MAX(idx), -1) + 1 next FROM animation_steps WHERE axis_id = ?").get(axis.id) as { next: number }).next;
    for (const frame of frames) {
      const stepId = crypto.randomUUID();
      db.query("INSERT INTO animation_steps (id, axis_id, idx, duration) VALUES (?, ?, ?, ?)").run(stepId, axis.id, next++, frame.duration);
      db.query("UPDATE frames SET track_id = ?, step_id = ?, idx = ? WHERE id = ?").run(track.id, stepId, next - 1, frame.id);
    }
  }
  db.query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(Date.now());
})();
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS uq_axes_coord ON animation_axes(project_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracks_coord ON animation_tracks(axis_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS uq_steps_coord ON animation_steps(axis_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS uq_frame_cell ON frames(track_id, step_id) WHERE track_id IS NOT NULL AND step_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attack_effect_cell ON attack_effects(track_id, step_id);
CREATE INDEX IF NOT EXISTS idx_attack_effects_project ON attack_effects(project_id);
CREATE INDEX IF NOT EXISTS idx_frames_track_step ON frames(track_id, step_id);
CREATE INDEX IF NOT EXISTS idx_axes_project ON animation_axes(project_id, idx);
`);

// 固定安装并升级最早六组动作；先完成全部表/列迁移，保证依赖资产和骨骼项目可事务化重映射。
ensureBuiltinAnimationAssets(db);
// 旧版曾把攻击特效寄存在图片帧上；迁移为可独立占据空单元格的特效记录。
db.transaction(() => {
  const rows = db.query(`SELECT id,project_id,track_id,step_id,attack_effect FROM frames
    WHERE attack_effect IS NOT NULL AND attack_effect <> 'null' AND track_id IS NOT NULL AND step_id IS NOT NULL`).all() as Array<{
      id: string; project_id: string; track_id: string; step_id: string; attack_effect: string;
    }>;
  for (const row of rows) {
    db.query(`INSERT OR IGNORE INTO attack_effects (id,project_id,track_id,step_id,effect,created_at)
      VALUES (?,?,?,?,?,?)`).run(crypto.randomUUID(), row.project_id, row.track_id, row.step_id, row.attack_effect, Date.now());
  }
  if (rows.length) db.query("UPDATE frames SET attack_effect=NULL WHERE attack_effect IS NOT NULL").run();
})();

// 视频/GIF 抽帧入库曾误标 source=mp4|gif；PNG 产物改为 extract
db.query(
  "UPDATE materials SET source = 'extract' WHERE source IN ('mp4', 'gif') AND (raw_path LIKE '%.png' OR raw_path LIKE '%.PNG')"
).run();
db.query(
  "UPDATE frames SET source = 'extract' WHERE source IN ('mp4', 'gif') AND (raw_path LIKE '%.png' OR raw_path LIKE '%.PNG')"
).run();
// 早期图片分层产物误标为 api；按元数据迁移为独立来源，避免素材卡片显示成普通 API 生成。
db.query(
  "UPDATE materials SET source = 'layers' WHERE source = 'api' AND json_valid(metadata) AND json_extract(metadata, '$.provider') = 'imageLayers'"
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
    attack_effect: parseJson<Frame["attack_effect"]>(f.attack_effect, null),
  } as Frame;
}

export function serializeMaterial(m: MaterialRow): Material {
  const path = m.raw_path ?? m.processed_path ?? "";
  const kind: Material["kind"] = /\.(mp4|mov|webm|avi)$/i.test(path) ? "video" : "image";
  return { ...m, metadata: parseJson<Record<string, unknown>>(m.metadata, {}), kind } as Material;
}

export function serializeAttackEffect(row: AttackEffectCellRow): AttackEffectCell {
  return { ...row, effect: parseJson(row.effect, { strokes: [], offset_x: 0, offset_y: 0, scale: 1, rotation: 0, opacity: 1 }) };
}
