import { Elysia, t } from "elysia";
import { canonicalizeJson, sha256Digest, type AnimationAsset, type BakedRasterDraftManifest, type MotionClip, type RasterSequenceManifest, type RenderProfile } from "@framebaker/shared";
import { mkdirSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { db, nextFrameIdx, STORAGE_ROOT, uid } from "../db";
import { assetDigest, pngDimensions, validateRasterDraft } from "../rasterSequence";
import { broadcast } from "../ws";

type AssetRow = { kind: string; data: string };
type SequenceRow = { manifest: string };
const root = join(STORAGE_ROOT, "raster-sequences");
const row = (id: string) => db.query("SELECT manifest FROM raster_sequences WHERE id = ?").get(id) as SequenceRow | null;
const parse = (value: SequenceRow) => JSON.parse(value.manifest) as RasterSequenceManifest;

function sourceAssets(source: BakedRasterDraftManifest["source"]): Record<keyof typeof source, AnimationAsset> {
  const expected = { skeletonId: "skeleton", motionClipId: "motion-clip", characterBindingId: "character-binding", renderProfileId: "render-profile" } as const;
  return Object.fromEntries(Object.entries(expected).map(([key, kind]) => {
    const id = source[key as keyof typeof source];
    const found = db.query("SELECT kind, data FROM animation_assets WHERE id = ?").get(id) as AssetRow | null;
    if (!found || found.kind !== kind) throw new Error(`${kind} 源资产不存在或类型错误`);
    return [key, JSON.parse(found.data)];
  })) as Record<keyof typeof source, AnimationAsset>;
}

export const rasterSequencesApi = new Elysia({ prefix: "/api" })
  .get("/raster-sequences", () => ({ rasterSequences: (db.query("SELECT manifest FROM raster_sequences ORDER BY created_at DESC").all() as SequenceRow[]).map(parse).map(({ id, name, parentId, frameCount, createdAt, source, sourceDigests }) => ({ id, name, parentId, frameCount, createdAt, source, sourceDigests })) }))
  .get("/raster-sequences/:id", ({ params, status }) => { const found = row(params.id); return found ? { rasterSequence: parse(found) } : status(404, "RasterSequence 不存在"); })
  .post("/raster-sequences", async ({ body, status }) => {
    const id = uid(), staging = join(root, `.staging-${id}`), final = join(root, id);
    try {
      const draft = (typeof body.manifest === "string" ? JSON.parse(body.manifest) : body.manifest) as BakedRasterDraftManifest;
      const assets = sourceAssets(draft.source), clip = assets.motionClipId as MotionClip;
      if ((assets.characterBindingId as { skeletonId: string }).skeletonId !== assets.skeletonId.id || clip.skeletonId !== assets.skeletonId.id) throw new Error("动作、绑定与骨架不一致");
      const { width, height, fps, origin, scale, background } = assets.renderProfileId as RenderProfile;
      if (new TextDecoder().decode(canonicalizeJson(draft.profile as never)) !== new TextDecoder().decode(canonicalizeJson({ width, height, fps, origin, scale, background } as never))) throw new Error("RenderProfile 快照已变化，请重新烘焙");
      validateRasterDraft(draft, clip.duration);
      const files = Array.isArray(body.frames) ? body.frames : [body.frames];
      if (files.length !== draft.frames.length) throw new Error("上传帧文件数不匹配");
      mkdirSync(join(staging, "frames"), { recursive: true });
      for (let i = 0; i < files.length; i++) {
        const bytes = new Uint8Array(await files[i]!.arrayBuffer()), dimensions = pngDimensions(bytes);
        if (dimensions.width !== draft.profile.width || dimensions.height !== draft.profile.height) throw new Error(`第 ${i} 帧尺寸不匹配`);
        if (await sha256Digest(bytes) !== draft.frames[i]!.pngDigest) throw new Error(`第 ${i} 帧 PNG 摘要不匹配`);
        await Bun.write(join(staging, "frames", `${i}.png`), bytes);
      }
      const parentId = body.parentId || null;
      const parentRow = parentId ? row(parentId) : null;
      if (parentId && !parentRow) throw new Error("父版本不存在");
      if (parentRow && new TextDecoder().decode(canonicalizeJson(parse(parentRow).source as never)) !== new TextDecoder().decode(canonicalizeJson(draft.source as never))) throw new Error("父版本必须来自同一组源资产");
      if ([...body.name.trim()].length > 1024) throw new Error("序列名称不能超过 1024 个字符");
      const createdAt = Date.now(), sourceDigests = Object.fromEntries(await Promise.all(Object.entries(assets).map(async ([key, value]) => [key, await assetDigest(value)])));
      const manifest: RasterSequenceManifest = { id, name: body.name.trim() || "未命名烘焙序列", schemaVersion: 1, kind: "raster-sequence", bakeEngine: draft.bakeEngine, source: draft.source, sourceDigests: sourceDigests as RasterSequenceManifest["sourceDigests"], profile: draft.profile, frameCount: draft.frames.length, frames: draft.frames.map((frame) => ({ ...frame, path: `frames/${frame.index}.png` })), createdAt, parentId };
      try { db.transaction(() => { db.query("INSERT INTO raster_sequences VALUES (?, ?, ?, ?, ?)").run(id, manifest.name, parentId, JSON.stringify(manifest), createdAt); renameSync(staging, final); })(); }
      catch (error) { rmSync(final, { recursive: true, force: true }); throw error; }
      return { rasterSequence: manifest };
    } catch (error) { rmSync(staging, { recursive: true, force: true }); return status(400, (error as Error).message); }
  }, { body: t.Object({ manifest: t.Any(), name: t.String(), parentId: t.Optional(t.String()), frames: t.Files() }) })
  .post("/raster-sequences/:id/import-project", ({ params, body, status }) => {
    const found = row(params.id); if (!found) return status(404, "RasterSequence 不存在");
    if (!db.query("SELECT id FROM projects WHERE id = ?").get(body.projectId)) return status(404, "项目不存在");
    const sequence = parse(found), importId = uid(), staging = join(STORAGE_ROOT, "staging", `raster-import-${importId}`), moved: string[] = [];
    try {
      mkdirSync(staging, { recursive: true });
      const frameIds = sequence.frames.map(() => uid());
      sequence.frames.forEach((frame, i) => copyFileSync(join(root, sequence.id, frame.path), join(staging, `${frameIds[i]}.png`)));
      // 项目 duration 单位是播放 tick；按 profile FPS 播放时每个烘焙帧恰为一个 tick。
      const start = nextFrameIdx(body.projectId), duration = 1;
      db.transaction(() => sequence.frames.forEach((frame, i) => {
        const id = frameIds[i]!, target = join(STORAGE_ROOT, "projects", body.projectId, "raw", `${id}.png`);
        renameSync(join(staging, `${id}.png`), target); moved.push(target);
        db.query("INSERT INTO frames (id, project_id, idx, raw_path, processed_path, status, duration, source, metadata) VALUES (?, ?, ?, ?, NULL, 'ready', ?, 'raster', ?)").run(id, body.projectId, start + i, target, duration, JSON.stringify({ rasterSequenceId: sequence.id, frameIndex: frame.index, fps: sequence.profile.fps, pixelDigest: frame.pixelDigest, pngDigest: frame.pngDigest }));
      }))();
      rmSync(staging, { recursive: true, force: true });
      broadcast("frames_changed", { projectId: body.projectId });
      return { ok: true, count: frameIds.length };
    } catch (error) { moved.forEach((path) => rmSync(path, { force: true })); rmSync(staging, { recursive: true, force: true }); return status(400, (error as Error).message); }
  }, { body: t.Object({ projectId: t.String() }) })
  .delete("/raster-sequences/:id", ({ params, status }) => { if (!row(params.id)) return status(404, "RasterSequence 不存在"); db.transaction(() => db.query("DELETE FROM raster_sequences WHERE id = ?").run(params.id))(); rmSync(join(root, params.id), { recursive: true, force: true }); return { ok: true }; });
