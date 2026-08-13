import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, STORAGE_ROOT, uid } from "./db";

const undoRoot = join(STORAGE_ROOT, "undo");
const pendingRoot = join(undoRoot, ".pending");
const restoreRoot = join(undoRoot, ".restore");

db.exec(`CREATE TABLE IF NOT EXISTS project_undo (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  files_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
); CREATE INDEX IF NOT EXISTS idx_project_undo ON project_undo(project_id, created_at);`);

// 请求中断或进程退出后，未写入 project_undo 的临时副本没有恢复价值。
rmSync(pendingRoot, { recursive: true, force: true });
mkdirSync(pendingRoot, { recursive: true });
mkdirSync(restoreRoot, { recursive: true });

type SnapshotTable = "animation_axes" | "animation_tracks" | "animation_steps" | "frames" | "attack_effects";
type SnapshotTables = Record<SnapshotTable, Array<Record<string, unknown>>>;
type ReleaseLock = () => void;

interface PendingUndo {
  id: string;
  projectId: string;
  snapshot: string;
  filesPath: string;
  generation: number;
  release: ReleaseLock;
}

const pendingRequests = new WeakMap<Request, PendingUndo>();
const projectLocks = new Map<string, Promise<void>>();
const projectGenerations = new Map<string, number>();

function generation(projectId: string): number {
  return projectGenerations.get(projectId) ?? 0;
}

function bumpGeneration(projectId: string) {
  projectGenerations.set(projectId, generation(projectId) + 1);
}

async function acquireProjectLock(projectId: string): Promise<ReleaseLock> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => current);
  projectLocks.set(projectId, tail);
  await previous;
  return () => {
    unlock();
    if (projectLocks.get(projectId) === tail) projectLocks.delete(projectId);
  };
}

function projectIdForEntity(id: string): string | null {
  const frame = db.query("SELECT project_id FROM frames WHERE id=?").get(id) as { project_id: string } | null;
  if (frame) return frame.project_id;
  const row = db.query(`SELECT a.project_id FROM animation_axes a WHERE a.id=?
    UNION ALL SELECT a.project_id FROM animation_tracks t JOIN animation_axes a ON a.id=t.axis_id WHERE t.id=?
    UNION ALL SELECT a.project_id FROM animation_steps s JOIN animation_axes a ON a.id=s.axis_id WHERE s.id=? LIMIT 1`).get(id, id, id) as { project_id: string } | null;
  return row?.project_id ?? null;
}

function bodyProjectId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const projectId = (body as { projectId?: unknown }).projectId;
  return typeof projectId === "string" ? projectId : null;
}

function mutationForRequest(request: Request, body: unknown): { projectId: string; files: boolean } | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/undo")) return null;

  const projectRoute = pathname.match(/^\/api\/projects\/([^/]+)\/(?:reorder|axes)$/);
  if (projectRoute) return { projectId: projectRoute[1]!, files: false };

  if (/^\/api\/materials\/(?:[^/]+\/import|batch-import)$/.test(pathname)) {
    const projectId = bodyProjectId(body);
    return projectId ? { projectId, files: true } : null;
  }

  const entity = pathname.match(/^\/api\/(?:frames|axes|tracks|steps)\/([^/]+)/);
  if (!entity) return null;
  const projectId = projectIdForEntity(entity[1]!);
  if (!projectId) return null;
  const files =
    (request.method === "DELETE" && /^\/api\/frames\/[^/]+$/.test(pathname)) ||
    (request.method === "POST" && /^\/api\/frames\/[^/]+\/(?:replace|duplicate)$/.test(pathname));
  return { projectId, files };
}

function captureTables(projectId: string): SnapshotTables {
  return {
    animation_axes: db.query("SELECT * FROM animation_axes WHERE project_id=?").all(projectId) as Array<Record<string, unknown>>,
    animation_tracks: db.query("SELECT * FROM animation_tracks WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").all(projectId) as Array<Record<string, unknown>>,
    animation_steps: db.query("SELECT * FROM animation_steps WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").all(projectId) as Array<Record<string, unknown>>,
    frames: db.query("SELECT * FROM frames WHERE project_id=?").all(projectId) as Array<Record<string, unknown>>,
    attack_effects: db.query("SELECT * FROM attack_effects WHERE project_id=?").all(projectId) as Array<Record<string, unknown>>,
  };
}

function parseSnapshot(value: string): SnapshotTables {
  const parsed = JSON.parse(value) as SnapshotTables | { tables: SnapshotTables };
  return "tables" in parsed ? parsed.tables : parsed;
}

function restoreTables(projectId: string, snapshot: SnapshotTables) {
  db.query("DELETE FROM attack_effects WHERE project_id=?").run(projectId);
  db.query("DELETE FROM frames WHERE project_id=?").run(projectId);
  db.query("DELETE FROM animation_steps WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").run(projectId);
  db.query("DELETE FROM animation_tracks WHERE axis_id IN (SELECT id FROM animation_axes WHERE project_id=?)").run(projectId);
  db.query("DELETE FROM animation_axes WHERE project_id=?").run(projectId);
  for (const table of ["animation_axes", "animation_tracks", "animation_steps", "frames", "attack_effects"] as const) {
    for (const row of snapshot[table] ?? []) {
      const keys = Object.keys(row);
      db.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(
        ...keys.map((key) => row[key]) as any[]
      );
    }
  }
}

function cleanupHistoryFiles(rows: Array<{ files_path: string }>) {
  for (const row of rows) {
    if (row.files_path) rmSync(row.files_path, { recursive: true, force: true });
  }
}

/** 在可撤销 REST mutation 进入 handler 前暂存 pre-state，并串行化同项目请求。 */
export async function beginProjectUndo(request: Request, body: unknown) {
  const mutation = mutationForRequest(request, body);
  if (!mutation || !db.query("SELECT 1 FROM projects WHERE id=?").get(mutation.projectId)) return;
  const release = await acquireProjectLock(mutation.projectId);
  const id = uid();
  let filesPath = "";
  try {
    // 等待锁期间项目可能已被另一个请求删除。
    if (!db.query("SELECT 1 FROM projects WHERE id=?").get(mutation.projectId)) {
      release();
      return;
    }
    if (mutation.files) {
      const projectPath = join(STORAGE_ROOT, "projects", mutation.projectId);
      if (existsSync(projectPath)) {
        filesPath = join(pendingRoot, id);
        cpSync(projectPath, filesPath, { recursive: true });
      }
    }
    pendingRequests.set(request, {
      id,
      projectId: mutation.projectId,
      snapshot: JSON.stringify({ tables: captureTables(mutation.projectId) }),
      filesPath,
      generation: generation(mutation.projectId),
      release,
    });
  } catch (error) {
    if (filesPath) rmSync(filesPath, { recursive: true, force: true });
    release();
    throw error;
  }
}

/** handler 结束后仅为成功请求提交历史；错误请求和被外部 mutation 失效的快照会被清理。 */
export function finishProjectUndo(request: Request, successful: boolean) {
  const pending = pendingRequests.get(request);
  if (!pending) return;
  pendingRequests.delete(request);
  try {
    if (!successful || pending.generation !== generation(pending.projectId)) {
      if (pending.filesPath) rmSync(pending.filesPath, { recursive: true, force: true });
      return;
    }

    let filesPath = "";
    if (pending.filesPath) {
      filesPath = join(undoRoot, pending.projectId, pending.id);
      mkdirSync(join(undoRoot, pending.projectId), { recursive: true });
      renameSync(pending.filesPath, filesPath);
    }
    const removed: Array<{ files_path: string }> = [];
    try {
      db.transaction(() => {
        const latest = db.query("SELECT COALESCE(MAX(created_at), 0) latest FROM project_undo WHERE project_id=?").get(pending.projectId) as { latest: number };
        const createdAt = Math.max(Date.now(), latest.latest + 1);
        db.query("INSERT INTO project_undo VALUES (?,?,?,?,?)").run(
          pending.id,
          pending.projectId,
          pending.snapshot,
          filesPath,
          createdAt
        );
        const old = db.query("SELECT id,files_path FROM project_undo WHERE project_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 50").all(pending.projectId) as Array<{ id: string; files_path: string }>;
        removed.push(...old);
        for (const item of old) db.query("DELETE FROM project_undo WHERE id=?").run(item.id);
      })();
    } catch (error) {
      if (filesPath) rmSync(filesPath, { recursive: true, force: true });
      throw error;
    }
    cleanupHistoryFiles(removed);
  } finally {
    pending.release();
  }
}

/** 异步任务、MCP 或系统写入项目后清空旧链，防止旧快照覆盖新产物。 */
export function invalidateProjectUndo(projectId: string) {
  bumpGeneration(projectId);
  const rows = db.query("SELECT files_path FROM project_undo WHERE project_id=?").all(projectId) as Array<{ files_path: string }>;
  db.query("DELETE FROM project_undo WHERE project_id=?").run(projectId);
  cleanupHistoryFiles(rows);
}

function restoreProjectFiles(projectId: string, snapshotPath: string, restoreId: string): () => void {
  if (!existsSync(snapshotPath)) throw new Error("撤销文件快照不存在");
  const projectPath = join(STORAGE_ROOT, "projects", projectId);
  const candidatePath = join(restoreRoot, `${restoreId}-candidate`);
  const backupPath = join(restoreRoot, `${restoreId}-backup`);
  cpSync(snapshotPath, candidatePath, { recursive: true });
  const hadCurrent = existsSync(projectPath);
  let currentMoved = false;
  try {
    if (hadCurrent) {
      renameSync(projectPath, backupPath);
      currentMoved = true;
    }
    renameSync(candidatePath, projectPath);
  } catch (error) {
    rmSync(candidatePath, { recursive: true, force: true });
    if (currentMoved && existsSync(backupPath)) renameSync(backupPath, projectPath);
    throw error;
  }
  return () => {
    rmSync(projectPath, { recursive: true, force: true });
    if (hadCurrent && existsSync(backupPath)) renameSync(backupPath, projectPath);
    rmSync(candidatePath, { recursive: true, force: true });
  };
}

/** 恢复最新快照；文件切换失败或 DB transaction 失败时回滚文件且不消费历史。 */
export async function undoProject(projectId: string): Promise<boolean> {
  const release = await acquireProjectLock(projectId);
  try {
    const item = db.query("SELECT * FROM project_undo WHERE project_id=? ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string; snapshot: string; files_path: string } | null;
    if (!item) return false;
    const snapshot = parseSnapshot(item.snapshot);
    const rollbackFiles = item.files_path ? restoreProjectFiles(projectId, item.files_path, item.id) : null;
    try {
      db.transaction(() => {
        restoreTables(projectId, snapshot);
        db.query("DELETE FROM project_undo WHERE id=?").run(item.id);
      })();
    } catch (error) {
      rollbackFiles?.();
      throw error;
    }
    bumpGeneration(projectId);
    if (item.files_path) rmSync(item.files_path, { recursive: true, force: true });
    // 成功后 restoreProjectFiles 留下的 backup 仅用于失败补偿，可以安全清理。
    rmSync(join(restoreRoot, `${item.id}-backup`), { recursive: true, force: true });
    return true;
  } finally {
    release();
  }
}
