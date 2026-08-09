import { Elysia, t } from "elysia";
import {
  BUILTIN_ANIMATION_EXTENSION,
  isBuiltinAnimationAssetId,
  stripBuiltinAnimationMarker,
  validateCharacterBinding,
  validateMotionClip,
  validateSkeleton,
  validateRenderProfile,
  type AnimationAsset,
  type AnimationAssetKind,
  type AnimationAssetSummary,
  type CharacterBinding,
  type MotionClip,
  type Skeleton,
  type StoredAnimationAsset,
  type ValidationIssue,
} from "@framebaker/shared";
import { existsSync } from "node:fs";
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

async function validateBindingMaterials(binding: CharacterBinding): Promise<string | null> {
  for (const attachment of binding.attachments) {
    const row = db.query("SELECT raw_path, processed_path FROM materials WHERE id = ?").get(attachment.materialId) as { raw_path: string | null; processed_path: string | null } | null;
    if (!row) return `附件「${attachment.name}」引用的素材不存在`;
    const path = attachment.imageSlot === "raw" ? row.raw_path : row.processed_path;
    if (!path || !existsSync(path)) return `附件「${attachment.name}」的 ${attachment.imageSlot} 图片不存在`;
    const signature = new Uint8Array(await Bun.file(path).slice(0, 8).arrayBuffer());
    if (![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => signature[index] === byte)) return `附件「${attachment.name}」的图片不是 PNG`;
  }
  return null;
}

async function validateAsset(value: unknown): Promise<{ asset: AnimationAsset } | { error: string }> {
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
  if ((value as { kind?: unknown }).kind === "character-binding") {
    const skeletonId = (value as { skeletonId?: unknown }).skeletonId;
    const skeleton = typeof skeletonId === "string" ? getSkeleton(skeletonId) : null;
    if (!skeleton) return { error: "角色绑定引用的骨架不存在" };
    const result = validateCharacterBinding(value, skeleton);
    if (!result.ok) return { error: issueText(result.issues) };
    const materialError = await validateBindingMaterials(result.value);
    return materialError ? { error: materialError } : { asset: result.value };
  }
  if ((value as { kind?: unknown }).kind === "render-profile") {
    const result = validateRenderProfile(value);
    return result.ok ? { asset: result.value } : { error: issueText(result.issues) };
  }
  return { error: "kind 须为 skeleton、motion-clip、character-binding 或 render-profile" };
}

function assetSkeletonId(asset: AnimationAsset): string | null {
  return asset.kind === "motion-clip" || asset.kind === "character-binding" ? asset.skeletonId : null;
}

function carriesBuiltinMarker(asset: AnimationAsset): boolean {
  return !!asset.extensions && Object.prototype.hasOwnProperty.call(asset.extensions, BUILTIN_ANIMATION_EXTENSION);
}

function referencedBySkeletalProject(id: string): string | null {
  const rows = db.query("SELECT document FROM skeletal_projects").all() as Array<{ document: string }>;
  for (const row of rows) {
    const document = JSON.parse(row.document) as { animations?: Array<{ name?: string; motionClipId?: string }> };
    const action = document.animations?.find((item) => item.motionClipId === id);
    if (action) return action.name || id;
  }
  return null;
}

/** 骨架替换不能让已保存动作失效。 */
function validateDependents(skeleton: Skeleton): string | null {
  const rows = db.query("SELECT data FROM animation_assets WHERE kind = 'motion-clip' AND skeleton_id = ?").all(skeleton.id) as Array<{ data: string }>;
  for (const row of rows) {
    const clip = JSON.parse(row.data) as MotionClip;
    const result = validateMotionClip(clip, skeleton);
    if (!result.ok) return `骨架更新会使动作「${clip.name}」失效：${issueText(result.issues)}`;
  }
  const bindings = db.query("SELECT data FROM animation_assets WHERE kind = 'character-binding' AND skeleton_id = ?").all(skeleton.id) as Array<{ data: string }>;
  for (const row of bindings) {
    const binding = JSON.parse(row.data) as CharacterBinding;
    const result = validateCharacterBinding(binding, skeleton);
    if (!result.ok) return `骨架更新会使角色绑定「${binding.name}」失效：${issueText(result.issues)}`;
  }
  return null;
}

export const animationAssetsApi = new Elysia({ prefix: "/api" })
  .get("/animation-assets", ({ query, status }) => {
    const kind = query.kind;
    if (kind !== undefined && kind !== "skeleton" && kind !== "motion-clip" && kind !== "character-binding" && kind !== "render-profile") {
      return status(400, "kind 无效");
    }
    const rows = (kind
      ? db.query("SELECT * FROM animation_assets WHERE kind = ? ORDER BY updated_at DESC").all(kind)
      : db.query("SELECT * FROM animation_assets ORDER BY updated_at DESC").all()) as AnimationAssetRow[];
    return { assets: rows.map(summary) };
  })
  .post(
    "/animation-assets",
    async ({ body, status }) => {
      const validation = await validateAsset(body.asset);
      if ("error" in validation) return status(400, validation.error);
      const asset = validation.asset;
      if (isBuiltinAnimationAssetId(asset.id) || carriesBuiltinMarker(asset)) return status(403, "内置动画资产只能由 FrameBaker 安装");
      if (rowById(asset.id)) return status(409, "资产 ID 已存在");
      const folderId = body.folderId ?? null;
      const folderError = validateFolder(folderId);
      if (folderError) return status(400, folderError);
      const now = Date.now();
      db.query("INSERT INTO animation_assets (id, kind, name, skeleton_id, folder_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(asset.id, asset.kind, asset.name, assetSkeletonId(asset), folderId, JSON.stringify(asset), now, now);
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
  .post(
    "/animation-assets/:id/copy",
    async ({ params, body, status }) => {
      const current = rowById(params.id);
      if (!current) return status(404, "动画资产不存在");
      if (current.kind !== "motion-clip") return status(409, "仅动作片段可以复制编辑");
      const source = JSON.parse(current.data) as MotionClip;
      const asset: MotionClip = {
        ...stripBuiltinAnimationMarker(source),
        id: `motion-copy-${crypto.randomUUID()}`,
        name: body.name?.trim() || `${source.name} · 副本`,
      };
      const validation = await validateAsset(asset);
      if ("error" in validation) return status(400, validation.error);
      const folderId = body.folderId ?? current.folder_id;
      const folderError = validateFolder(folderId);
      if (folderError) return status(400, folderError);
      const now = Date.now();
      db.query("INSERT INTO animation_assets (id, kind, name, skeleton_id, folder_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(asset.id, asset.kind, asset.name, asset.skeletonId, folderId, JSON.stringify(asset), now, now);
      broadcast("animation_assets_changed", { id: asset.id, kind: asset.kind });
      return { animationAsset: { asset, folder_id: folderId, created_at: now, updated_at: now } };
    },
    { body: t.Object({ name: t.Optional(t.String()), folderId: t.Optional(t.Union([t.String(), t.Null()])) }) },
  )
  .put(
    "/animation-assets/:id",
    async ({ params, body, status }) => {
      const current = rowById(params.id);
      if (!current) return status(404, "动画资产不存在");
      if (isBuiltinAnimationAssetId(params.id)) return status(403, "内置动画资产不可修改，请先复制");
      const validation = await validateAsset(body.asset);
      if ("error" in validation) return status(400, validation.error);
      const asset = validation.asset;
      if (carriesBuiltinMarker(asset)) return status(403, "普通资产不能声明为内置动画");
      if (asset.id !== params.id) return status(400, "不能修改资产 ID");
      if (asset.kind !== current.kind) return status(400, "不能修改资产种类");
      if (assetSkeletonId(asset) !== current.skeleton_id) return status(400, "不能直接更换资产骨架，请创建重定向副本");
      if (asset.kind === "skeleton") {
        const dependentError = validateDependents(asset);
        if (dependentError) return status(409, dependentError);
      }
      const folderId = body.folderId === undefined ? current.folder_id : body.folderId;
      const folderError = validateFolder(folderId);
      if (folderError) return status(400, folderError);
      const updatedAt = Date.now();
      db.query("UPDATE animation_assets SET name = ?, skeleton_id = ?, folder_id = ?, data = ?, updated_at = ? WHERE id = ?")
        .run(asset.name, assetSkeletonId(asset), folderId, JSON.stringify(asset), updatedAt, asset.id);
      broadcast("animation_assets_changed", { id: asset.id, kind: asset.kind });
      return { animationAsset: { asset, folder_id: folderId, created_at: current.created_at, updated_at: updatedAt } };
    },
    { body: t.Object({ asset: t.Any(), folderId: t.Optional(t.Union([t.String(), t.Null()])) }) },
  )
  .delete("/animation-assets/:id", ({ params, status }) => {
    const row = rowById(params.id);
    if (!row) return status(404, "动画资产不存在");
    if (isBuiltinAnimationAssetId(params.id)) return status(403, "内置动画资产不可删除");
    if (row.kind === "skeleton") {
      const dependent = db.query("SELECT name FROM animation_assets WHERE skeleton_id = ? LIMIT 1").get(params.id) as { name: string } | null;
      if (dependent) return status(409, `骨架仍被动画资产「${dependent.name}」引用`);
    }
    if (row.kind === "motion-clip") {
      const action = referencedBySkeletalProject(params.id);
      if (action) return status(409, `动作仍被骨骼项目序列「${action}」引用`);
    }
    db.query("DELETE FROM animation_assets WHERE id = ?").run(params.id);
    broadcast("animation_assets_changed", { id: params.id, kind: row.kind });
    return { ok: true };
  });
