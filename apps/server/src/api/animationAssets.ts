import { Elysia, t } from "elysia";
import {
  validateMotionClip,
  validateSkeleton,
  type AnimationAsset,
  type AnimationAssetKind,
  type AnimationAssetSummary,
  type MotionClip,
  type Skeleton,
  type StoredAnimationAsset,
  type ValidationIssue,
} from "@framebaker/shared";
import { db } from "../db";
import { broadcast } from "../ws";

type AnimationAssetRow = {
  id: string;
  kind: AnimationAssetKind;
  name: string;
  skeleton_id: string | null;
  folder_id: string | null;
  data: string;
  created_at: number;
  updated_at: number;
};

function rowById(id: string): AnimationAssetRow | null {
  return (db.query("SELECT * FROM animation_assets WHERE id = ?").get(id) as AnimationAssetRow | null) ?? null;
}

function parseRow(row: AnimationAssetRow): StoredAnimationAsset {
  return {
    asset: JSON.parse(row.data) as AnimationAsset,
    folder_id: row.folder_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function summary(row: AnimationAssetRow): AnimationAssetSummary {
  const { id, kind, name, skeleton_id, folder_id, created_at, updated_at } = row;
  return { id, kind, name, skeleton_id, folder_id, created_at, updated_at };
}

function issueText(issues: ValidationIssue[]): string {
  const issue = issues[0];
  return issue ? `资产无效：${issue.path} ${issue.message}` : "资产无效";
}

function getSkeleton(id: string): Skeleton | null {
  const row = rowById(id);
  if (!row || row.kind !== "skeleton") return null;
  return JSON.parse(row.data) as Skeleton;
}

function validateFolder(folderId: string | null): string | null {
  if (!folderId) return null;
  const folder = db.query("SELECT kind FROM folders WHERE id = ?").get(folderId) as { kind: string } | null;
  if (!folder) return "动画文件夹不存在";
  return folder.kind === "animation" ? null : "文件夹类型不匹配";
}

function validateAsset(value: unknown): { asset: AnimationAsset } | { error: string } {
  if (!value || typeof value !== "object") return { error: "资产必须是对象" };
  if ((value as { kind?: unknown }).kind === "skeleton") {
    const result = validateSkeleton(value);
    return result.ok ? { asset: result.value } : { error: issueText(result.issues) };
  }
  if ((value as { kind?: unknown }).kind === "motion-clip") {
    const skeletonId = (value as { skeletonId?: unknown }).skeletonId;
    const skeleton = typeof skeletonId === "string" ? getSkeleton(skeletonId) : null;
    if (!skeleton) return { error: "动作引用的骨架不存在" };
    const result = validateMotionClip(value, skeleton);
    return result.ok ? { asset: result.value } : { error: issueText(result.issues) };
  }
  return { error: "kind 须为 skeleton 或 motion-clip" };
}

/** 骨架替换不能让已保存动作失效。 */
function validateDependents(skeleton: Skeleton): string | null {
  const rows = db.query("SELECT data FROM animation_assets WHERE kind = 'motion-clip' AND skeleton_id = ?").all(skeleton.id) as Array<{ data: string }>;
  for (const row of rows) {
    const clip = JSON.parse(row.data) as MotionClip;
    const result = validateMotionClip(clip, skeleton);
    if (!result.ok) return `骨架更新会使动作「${clip.name}」失效：${issueText(result.issues)}`;
  }
  return null;
}

export const animationAssetsApi = new Elysia({ prefix: "/api" })
  .get("/animation-assets", ({ query, status }) => {
    const kind = query.kind;
    if (kind !== undefined && kind !== "skeleton" && kind !== "motion-clip") {
      return status(400, "kind 须为 skeleton 或 motion-clip");
    }
    const rows = (kind
      ? db.query("SELECT * FROM animation_assets WHERE kind = ? ORDER BY updated_at DESC").all(kind)
      : db.query("SELECT * FROM animation_assets ORDER BY updated_at DESC").all()) as AnimationAssetRow[];
    return { assets: rows.map(summary) };
  })
  .post(
    "/animation-assets",
    ({ body, status }) => {
      const validation = validateAsset(body.asset);
      if ("error" in validation) return status(400, validation.error);
      const asset = validation.asset;
      if (rowById(asset.id)) return status(409, "资产 ID 已存在");
      const folderId = body.folderId ?? null;
      const folderError = validateFolder(folderId);
      if (folderError) return status(400, folderError);
      const now = Date.now();
      db.query("INSERT INTO animation_assets (id, kind, name, skeleton_id, folder_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(asset.id, asset.kind, asset.name, asset.kind === "motion-clip" ? asset.skeletonId : null, folderId, JSON.stringify(asset), now, now);
      broadcast("animation_assets_changed", { id: asset.id, kind: asset.kind });
      return { animationAsset: { asset, folder_id: folderId, created_at: now, updated_at: now } };
    },
    { body: t.Object({ asset: t.Any(), folderId: t.Optional(t.Union([t.String(), t.Null()])) }) },
  )
  .get("/animation-assets/:id", ({ params, status }) => {
    const row = rowById(params.id);
    if (!row) return status(404, "动画资产不存在");
    return { animationAsset: parseRow(row) };
  })
  .put(
    "/animation-assets/:id",
    ({ params, body, status }) => {
      const current = rowById(params.id);
      if (!current) return status(404, "动画资产不存在");
      const validation = validateAsset(body.asset);
      if ("error" in validation) return status(400, validation.error);
      const asset = validation.asset;
      if (asset.id !== params.id) return status(400, "不能修改资产 ID");
      if (asset.kind !== current.kind) return status(400, "不能修改资产种类");
      if (asset.kind === "skeleton") {
        const dependentError = validateDependents(asset);
        if (dependentError) return status(409, dependentError);
      }
      const folderId = body.folderId === undefined ? current.folder_id : body.folderId;
      const folderError = validateFolder(folderId);
      if (folderError) return status(400, folderError);
      const updatedAt = Date.now();
      db.query("UPDATE animation_assets SET name = ?, skeleton_id = ?, folder_id = ?, data = ?, updated_at = ? WHERE id = ?")
        .run(asset.name, asset.kind === "motion-clip" ? asset.skeletonId : null, folderId, JSON.stringify(asset), updatedAt, asset.id);
      broadcast("animation_assets_changed", { id: asset.id, kind: asset.kind });
      return { animationAsset: { asset, folder_id: folderId, created_at: current.created_at, updated_at: updatedAt } };
    },
    { body: t.Object({ asset: t.Any(), folderId: t.Optional(t.Union([t.String(), t.Null()])) }) },
  )
  .delete("/animation-assets/:id", ({ params, status }) => {
    const row = rowById(params.id);
    if (!row) return status(404, "动画资产不存在");
    if (row.kind === "skeleton") {
      const dependent = db.query("SELECT name FROM animation_assets WHERE skeleton_id = ? LIMIT 1").get(params.id) as { name: string } | null;
      if (dependent) return status(409, `骨架仍被动作「${dependent.name}」引用`);
    }
    db.query("DELETE FROM animation_assets WHERE id = ?").run(params.id);
    broadcast("animation_assets_changed", { id: params.id, kind: row.kind });
    return { ok: true };
  });
