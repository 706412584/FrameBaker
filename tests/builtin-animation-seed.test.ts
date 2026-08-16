import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ANIMATION_CATALOG_VERSION,
  BUILTIN_ANIMATION_EXTENSION,
  BUILTIN_HUMANOID_BONE_IDS,
  BUILTIN_HUMANOID_SKELETON_ID,
  createBuiltinAnimationAssets,
  createBuiltinHumanoidSkeleton,
  quaternionFromZRotation,
  type MotionClip,
  type Skeleton,
} from "../packages/shared/src";
import { ensureBuiltinAnimationAssets, normalizeGeneratedAnimationAssetNames } from "../apps/server/src/builtinAnimationAssets";

function memoryDb(): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE animation_assets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, skeleton_id TEXT,
      folder_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE skeletal_projects (project_id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  return database;
}

function insertAsset(database: Database, asset: Skeleton | MotionClip, time = 1) {
  database.query("INSERT INTO animation_assets (id, kind, name, skeleton_id, folder_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
    .run(asset.id, asset.kind, asset.name, asset.kind === "motion-clip" ? asset.skeletonId : null, JSON.stringify(asset), time, time);
}

describe("内置动画启动迁移", () => {
  test("空库安装后重复执行完全幂等", () => {
    const database = memoryDb();
    ensureBuiltinAnimationAssets(database);
    const first = database.query("SELECT id, data, created_at, updated_at FROM animation_assets ORDER BY id").all();
    expect(first).toHaveLength(7);
    ensureBuiltinAnimationAssets(database);
    expect(database.query("SELECT id, data, created_at, updated_at FROM animation_assets ORDER BY id").all()).toEqual(first);
    database.close();
  });

  test("旧 UUID 骨骼上的自定义动作按 semantic 无损迁移", () => {
    const database = memoryDb();
    const canonical = createBuiltinHumanoidSkeleton();
    const oldId = new Map(canonical.bones.map((bone) => [bone.id, `old-${bone.semantic ?? bone.id}`]));
    const oldSkeleton: Skeleton = {
      ...canonical,
      extensions: undefined,
      bones: canonical.bones.map((bone) => ({ ...bone, id: oldId.get(bone.id)!, parentId: bone.parentId ? oldId.get(bone.parentId)! : null })),
      semanticProfile: { id: "humanoid-v1", bones: Object.fromEntries(Object.entries(canonical.semanticProfile!.bones).map(([semantic, id]) => [semantic, oldId.get(id)!])) },
    };
    const custom: MotionClip = {
      schemaVersion: 1,
      kind: "motion-clip",
      id: "custom-legacy-motion",
      name: "Custom legacy motion",
      skeletonId: BUILTIN_HUMANOID_SKELETON_ID,
      duration: 1,
      loop: false,
      tracks: [{ targetId: oldId.get(BUILTIN_HUMANOID_BONE_IDS.chest)!, property: "rotation", interpolation: "linear", keyframes: [{ time: 0, value: quaternionFromZRotation(.25) }] }],
      events: [],
    };
    insertAsset(database, oldSkeleton);
    insertAsset(database, custom);
    ensureBuiltinAnimationAssets(database);
    const migrated = JSON.parse((database.query("SELECT data FROM animation_assets WHERE id = ?").get(custom.id) as { data: string }).data) as MotionClip;
    expect(migrated.tracks[0]!.targetId).toBe(BUILTIN_HUMANOID_BONE_IDS.chest);
    expect(database.query("SELECT COUNT(*) count FROM animation_assets").get()).toEqual({ count: 8 });
    database.close();
  });

  test("比运行程序更新的目录版本会拒绝降级且不写入", () => {
    const database = memoryDb();
    const [skeleton] = createBuiltinAnimationAssets();
    skeleton.extensions![BUILTIN_ANIMATION_EXTENSION] = { catalog: "quaternius-legacy-humanoid", asset: "skeleton", version: BUILTIN_ANIMATION_CATALOG_VERSION + 1 };
    insertAsset(database, skeleton);
    expect(() => ensureBuiltinAnimationAssets(database)).toThrow("来自更新版本");
    expect(database.query("SELECT COUNT(*) count FROM animation_assets").get()).toEqual({ count: 1 });
    database.close();
  });

  test("清理自动生成名称中的开发历史措辞但保留普通用户命名", () => {
    const database = memoryDb();
    const [, source] = createBuiltinAnimationAssets();
    const generated: MotionClip = { ...source, id: "generated-motion", name: "待机 · 早期预制重定向", extensions: undefined };
    const custom: MotionClip = { ...source, id: "custom-motion", name: "我的早期冒险动作", extensions: undefined };
    insertAsset(database, generated);
    insertAsset(database, custom);
    normalizeGeneratedAnimationAssetNames(database);
    const rows = database.query("SELECT id, name, data FROM animation_assets ORDER BY id").all() as Array<{ id: string; name: string; data: string }>;
    expect(rows.map((row) => [row.id, row.name])).toEqual([["custom-motion", "我的早期冒险动作"], ["generated-motion", "待机"]]);
    expect(JSON.parse(rows[1]!.data).name).toBe("待机");
    database.close();
  });
});
