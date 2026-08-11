import type { Database } from "bun:sqlite";
import {
  BUILTIN_ANIMATION_CATALOG_VERSION,
  BUILTIN_HUMANOID_SKELETON_ID,
  createBuiltinAnimationAssets,
  getBuiltinAnimationCatalogVersion,
  isBuiltinAnimationAssetId,
  validateCharacterBinding,
  validateMotionClip,
  validateSkeleton,
  type AnimationAsset,
  type CharacterBinding,
  type MotionClip,
  type Skeleton,
} from "@framebaker/shared";

type AssetRow = {
  id: string;
  kind: string;
  name: string;
  skeleton_id: string | null;
  folder_id: string | null;
  data: string;
  created_at: number;
  updated_at: number;
};

function firstIssue(result: { ok: boolean; issues: Array<{ path: string; message: string }> }): string {
  const issue = result.issues[0];
  return issue ? `${issue.path} ${issue.message}` : "未知错误";
}

function assertCanonicalAssets(assets: AnimationAsset[]) {
  const skeleton = assets[0] as Skeleton;
  const skeletonResult = validateSkeleton(skeleton);
  if (!skeletonResult.ok) throw new Error(`内置骨架无效：${firstIssue(skeletonResult)}`);
  for (const clip of assets.slice(1) as MotionClip[]) {
    const result = validateMotionClip(clip, skeleton);
    if (!result.ok) throw new Error(`内置动作「${clip.name}」无效：${firstIssue(result)}`);
  }
}

function semanticBoneMap(skeleton: Skeleton): Map<string, string> {
  const semanticById = new Map<string, string>();
  for (const bone of skeleton.bones) if (bone.semantic) semanticById.set(bone.id, bone.semantic);
  for (const [semantic, id] of Object.entries(skeleton.semanticProfile?.bones ?? {})) semanticById.set(id, semantic);
  return semanticById;
}

/**
 * 服务启动时事务化安装/修复最早六组动作。固定资产 ID 保留项目引用；旧版 UUID 骨骼依赖按语义迁移。
 * 任意无法无损映射的自定义依赖都会让事务整体回滚，避免静默丢关键帧或附件绑定。
 */
export function ensureBuiltinAnimationAssets(database: Database): void {
  const canonical = createBuiltinAnimationAssets();
  assertCanonicalAssets(canonical);
  const canonicalSkeleton = canonical[0];
  const canonicalJson = new Map(canonical.map((asset) => [asset.id, JSON.stringify(asset)]));
  const rows = database.query("SELECT * FROM animation_assets WHERE id IN (?, ?, ?, ?, ?, ?, ?)").all(...canonical.map((asset) => asset.id)) as AssetRow[];
  for (const row of rows) {
    const version = getBuiltinAnimationCatalogVersion(JSON.parse(row.data) as AnimationAsset);
    if (version !== null && version > BUILTIN_ANIMATION_CATALOG_VERSION) {
      throw new Error(`内置动画资产 ${row.id} 来自更新版本 ${version}，当前仅支持 ${BUILTIN_ANIMATION_CATALOG_VERSION}`);
    }
  }

  database.transaction(() => {
    const oldSkeletonRow = rows.find((row) => row.id === BUILTIN_HUMANOID_SKELETON_ID);
    const skeletonChanged = !oldSkeletonRow || oldSkeletonRow.data !== canonicalJson.get(BUILTIN_HUMANOID_SKELETON_ID);
    if (oldSkeletonRow && skeletonChanged) {
      const oldSkeleton = JSON.parse(oldSkeletonRow.data) as Skeleton;
      const oldSemanticById = semanticBoneMap(oldSkeleton);
      const canonicalIdBySemantic = new Map(canonicalSkeleton.bones.flatMap((bone) => bone.semantic ? [[bone.semantic, bone.id]] : []));
      for (const [semantic, id] of Object.entries(canonicalSkeleton.semanticProfile?.bones ?? {})) canonicalIdBySemantic.set(semantic, id);
      const canonicalIds = new Set(canonicalSkeleton.bones.map((bone) => bone.id));
      const remap = (id: string, owner: string): string => {
        if (canonicalIds.has(id)) return id;
        const semantic = oldSemanticById.get(id);
        const mapped = semantic ? canonicalIdBySemantic.get(semantic) : undefined;
        if (!mapped) throw new Error(`内置骨架升级无法迁移「${owner}」引用的骨骼 ${id}`);
        return mapped;
      };

      const dependents = database.query("SELECT * FROM animation_assets WHERE skeleton_id = ?").all(BUILTIN_HUMANOID_SKELETON_ID) as AssetRow[];
      for (const row of dependents) {
        if (isBuiltinAnimationAssetId(row.id)) continue;
        const asset = JSON.parse(row.data) as AnimationAsset;
        if (asset.kind === "motion-clip") {
          const next = {
            ...asset,
            tracks: asset.tracks.map((track) => ({ ...track, targetId: remap(track.targetId, asset.name) })),
            ...(asset.contacts ? { contacts: asset.contacts.map((contact) => ({ ...contact, targetId: remap(contact.targetId, asset.name) })) } : {}),
          } as MotionClip;
          const result = validateMotionClip(next, canonicalSkeleton);
          if (!result.ok) throw new Error(`内置骨架升级后动作「${asset.name}」无效：${firstIssue(result)}`);
          database.query("UPDATE animation_assets SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), Date.now(), row.id);
        } else if (asset.kind === "character-binding") {
          const next: CharacterBinding = { ...asset, slots: asset.slots.map((slot) => ({ ...slot, boneId: remap(slot.boneId, asset.name) })) };
          const result = validateCharacterBinding(next, canonicalSkeleton);
          if (!result.ok) throw new Error(`内置骨架升级后绑定「${asset.name}」无效：${firstIssue(result)}`);
          database.query("UPDATE animation_assets SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), Date.now(), row.id);
        }
      }

      const projects = database.query("SELECT project_id, document FROM skeletal_projects").all() as Array<{ project_id: string; document: string }>;
      for (const row of projects) {
        const document = JSON.parse(row.document) as { character?: { binding?: CharacterBinding } | null };
        const binding = document.character?.binding;
        if (!binding || binding.skeletonId !== BUILTIN_HUMANOID_SKELETON_ID) continue;
        const nextBinding: CharacterBinding = { ...binding, slots: binding.slots.map((slot) => ({ ...slot, boneId: remap(slot.boneId, binding.name) })) };
        const result = validateCharacterBinding(nextBinding, canonicalSkeleton);
        if (!result.ok) throw new Error(`内置骨架升级后项目绑定「${binding.name}」无效：${firstIssue(result)}`);
        document.character = { ...document.character!, binding: nextBinding };
        database.query("UPDATE skeletal_projects SET document = ?, updated_at = ? WHERE project_id = ?").run(JSON.stringify(document), Date.now(), row.project_id);
      }
    }

    const now = Date.now();
    for (const asset of canonical) {
      const data = canonicalJson.get(asset.id)!;
      const skeletonId = asset.kind === "motion-clip" ? asset.skeletonId : null;
      const current = database.query("SELECT * FROM animation_assets WHERE id = ?").get(asset.id) as AssetRow | null;
      if (!current) {
        database.query("INSERT INTO animation_assets (id, kind, name, skeleton_id, folder_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
          .run(asset.id, asset.kind, asset.name, skeletonId, data, now, now);
      } else if (current.kind !== asset.kind || current.name !== asset.name || current.skeleton_id !== skeletonId || current.folder_id !== null || current.data !== data) {
        database.query("UPDATE animation_assets SET kind = ?, name = ?, skeleton_id = ?, folder_id = NULL, data = ?, updated_at = ? WHERE id = ?")
          .run(asset.kind, asset.name, skeletonId, data, now, asset.id);
      }
    }
  })();
}
