import { Elysia, t } from "elysia";
import { isFbanimV2Id, validateCharacterBinding, type CharacterBinding, type SkeletalProjectDocument, type Skeleton } from "@framebaker/shared";
import { db } from "../db";

type ProjectRow = { id: string; kind: string };
type AssetRow = { kind: string; skeleton_id: string | null };

function project(id: string): ProjectRow | null {
  return (db.query("SELECT id, kind FROM projects WHERE id = ?").get(id) as ProjectRow | null) ?? null;
}

function emptyDocument(projectId: string): SkeletalProjectDocument {
  return { schemaVersion: 1, projectId, character: null, animations: [], activeAnimationId: null };
}

function validateDocument(value: unknown, projectId: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "骨骼项目文档必须是对象";
  const document = value as Partial<SkeletalProjectDocument>;
  if (document.schemaVersion !== 1) return "仅支持 schemaVersion 1";
  if (document.projectId !== projectId) return "文档 projectId 必须与 URL 项目一致";
  if (document.character !== null && (!document.character || typeof document.character !== "object" || Array.isArray(document.character))) return "character 无效";
  if (!Array.isArray(document.animations) || document.animations.length > 500) return "animations 必须是至多 500 项的数组";
  if (document.activeAnimationId !== null && (typeof document.activeAnimationId !== "string" || !document.activeAnimationId.trim() || document.activeAnimationId.length > 128)) return "activeAnimationId 无效";

  const ids = new Set<string>(), names = new Set<string>();
  for (const item of document.animations) {
    if (!item || typeof item !== "object") return "动作配置必须是对象";
    if (!isFbanimV2Id(item.id)) return "动作 id 必须是可导出的 ASCII 标识符";
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 200) return "动作名称必须为非空且不超过 200 字符";
    if (ids.has(item.id) || names.has(item.name)) return "动作 id 与名称必须各自唯一";
    ids.add(item.id); names.add(item.name);
    if (typeof item.motionClipId !== "string" || !item.motionClipId.trim() || item.motionClipId.length > 128) return "motionClipId 无效";
    if (typeof item.speed !== "number" || !Number.isFinite(item.speed) || item.speed <= 0 || item.speed > 8) return "speed 必须大于 0 且不超过 8";
    if (!Number.isInteger(item.repeat) || item.repeat < 1 || item.repeat > 100) return "repeat 必须是 1..100 的整数";
    if (typeof item.loop !== "boolean") return "loop 必须是布尔值";
  }
  if (document.activeAnimationId !== null && !ids.has(document.activeAnimationId)) return "activeAnimationId 引用的动作不存在";
  if (!document.character && document.animations.length) return "未组装角色时不能配置动作";

  let skeletonId: string | null = null;
  if (document.character) {
    if (Object.keys(document.character).some((key) => key !== "binding")) return "character 只允许项目内 binding";
    const { binding } = document.character as { binding?: unknown };
    if (!binding || typeof binding !== "object") return "项目角色绑定无效";
    skeletonId = (binding as CharacterBinding).skeletonId;
    const skeletonRow = typeof skeletonId === "string" ? db.query("SELECT data FROM animation_assets WHERE id = ? AND kind = 'skeleton'").get(skeletonId) as { data: string } | null : null;
    if (!skeletonRow) return "项目角色引用的骨架不存在";
    const result = validateCharacterBinding(binding, JSON.parse(skeletonRow.data) as Skeleton);
    if (!result.ok) return `项目角色绑定无效：${result.issues[0]?.path ?? "binding"} ${result.issues[0]?.message ?? "格式错误"}`;
    for (const attachment of result.value.attachments) {
      if (!db.query("SELECT id FROM materials WHERE id = ?").get(attachment.materialId)) return `附件「${attachment.name}」引用的素材不存在`;
    }
  }
  for (const item of document.animations) {
    const clip = db.query("SELECT kind, skeleton_id FROM animation_assets WHERE id = ?").get(item.motionClipId) as AssetRow | null;
    if (!clip || clip.kind !== "motion-clip") return `动作「${item.name}」引用的 MotionClip 不存在`;
    if (clip.skeleton_id !== skeletonId) return `动作「${item.name}」与角色绑定使用的骨架不同`;
  }
  return null;
}

export const skeletalProjectsApi = new Elysia({ prefix: "/api" })
  .get("/projects/:id/skeletal-document", ({ params, status }) => {
    const row = project(params.id);
    if (!row) return status(404, "项目不存在");
    if (row.kind !== "skeletal") return status(409, "逐帧项目没有骨骼项目文档");
    const stored = db.query("SELECT document FROM skeletal_projects WHERE project_id = ?").get(params.id) as { document: string } | null;
    const document = stored ? JSON.parse(stored.document) as SkeletalProjectDocument & { character: ({ binding: CharacterBinding; sourceBindingId?: string | null }) | null } : emptyDocument(params.id);
    if (document.character && "sourceBindingId" in document.character) delete document.character.sourceBindingId;
    if (!stored) db.query("INSERT INTO skeletal_projects (project_id, document, updated_at) VALUES (?, ?, ?)").run(params.id, JSON.stringify(document), Date.now());
    return { document };
  })
  .put("/projects/:id/skeletal-document", ({ params, body, status }) => {
    const row = project(params.id);
    if (!row) return status(404, "项目不存在");
    if (row.kind !== "skeletal") return status(409, "逐帧项目不能保存骨骼项目文档");
    const error = validateDocument(body, params.id);
    if (error) return status(400, error);
    const document = body as SkeletalProjectDocument;
    db.query("INSERT INTO skeletal_projects (project_id, document, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at").run(params.id, JSON.stringify(document), Date.now());
    return { document };
  }, { body: t.Any() });
