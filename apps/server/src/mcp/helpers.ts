import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync, copyFileSync } from "node:fs";
import type { FolderKind } from "@framebaker/shared";
import { db, uid, STORAGE_ROOT, nextFrameIdx } from "../db";
import type { MaterialRow } from "@framebaker/shared";

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ===== 文件夹辅助 =====

export type FolderRow = {
  id: string;
  kind: string;
  parent_id: string | null;
  name: string;
  sort: number;
  created_at: number;
};

export function getFolderRow(id: string): FolderRow | null {
  return (db.query("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | null) ?? null;
}

export function collectDescendants(rootId: string): Set<string> {
  const all = db.query("SELECT id, parent_id FROM folders").all() as Array<{
    id: string;
    parent_id: string | null;
  }>;
  const children = new Map<string | null, string[]>();
  for (const r of all) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r.id);
    children.set(r.parent_id, list);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

export function validateFolderParent(
  kind: FolderKind,
  parentId: string | null,
  selfId?: string
): string | null {
  if (!parentId) return null;
  const parent = getFolderRow(parentId);
  if (!parent) return "父文件夹不存在";
  if (parent.kind !== kind) return "父文件夹类型不匹配";
  if (selfId && collectDescendants(selfId).has(parentId)) return "不能把文件夹移到自身或子孙下";
  return null;
}

export function nextFolderSort(kind: FolderKind, parentId: string | null): number {
  const row = db
    .query("SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM folders WHERE kind = ? AND parent_id IS ?")
    .get(kind, parentId) as { next: number };
  return row.next;
}

// ===== 素材导入辅助 =====

const materialNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortMaterialsByFrameNumber(materials: MaterialRow[]): MaterialRow[] {
  return [...materials].sort(
    (a, b) =>
      materialNameCollator.compare(a.name || "", b.name || "") ||
      a.created_at - b.created_at ||
      a.id.localeCompare(b.id)
  );
}

export function importMaterialToProject(m: MaterialRow, projectId: string): string {
  const rawSrc = m.raw_path && existsSync(m.raw_path) ? m.raw_path : m.processed_path;
  if (!rawSrc || !existsSync(rawSrc)) throw new Error(`素材文件缺失: ${m.id}`);
  if (/\.(mp4|mov|webm|avi)$/i.test(rawSrc)) {
    throw new Error(`「${m.name}」是视频素材，请先抽帧再导入项目`);
  }
  const frameId = uid();
  const rawDir = join(STORAGE_ROOT, "projects", projectId, "raw");
  const procDir = join(STORAGE_ROOT, "projects", projectId, "processed");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(procDir, { recursive: true });
  const rawPath = join(rawDir, `mat_${frameId}.png`);
  copyFileSync(rawSrc, rawPath);
  let procPath: string | null = null;
  if (m.processed_path && existsSync(m.processed_path)) {
    procPath = join(procDir, `${frameId}.png`);
    copyFileSync(m.processed_path, procPath);
  }
  let metadata: Record<string, unknown> = { fromMaterial: m.id };
  try {
    metadata = { ...metadata, ...JSON.parse(m.metadata ?? "{}") };
  } catch {
    /* ignore */
  }
  db.query(
    "INSERT INTO frames (id, project_id, idx, raw_path, processed_path, status, source, metadata) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)"
  ).run(frameId, projectId, nextFrameIdx(projectId), rawPath, procPath, m.source, JSON.stringify(metadata));
  return frameId;
}
