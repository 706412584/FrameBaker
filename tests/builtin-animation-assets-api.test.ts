import { afterAll, describe, expect, test } from "bun:test";
import {
  BUILTIN_ANIMATION_EXTENSION,
  BUILTIN_HUMANOID_SKELETON_ID,
  BUILTIN_MOTION_ASSET_IDS,
  createBuiltinMotionClip,
  isBuiltinAnimationAssetId,
  type MotionClip,
} from "../packages/shared/src";
import { animationAssetsApi } from "../apps/server/src/api/animationAssets";
import { db } from "../apps/server/src/db";

const created = new Set<string>();
const request = (path: string, method = "GET", body?: unknown) => animationAssetsApi.handle(new Request(`http://localhost/api${path}`, {
  method,
  headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe("内置动画资产 API", () => {
  afterAll(() => {
    for (const id of created) db.query("DELETE FROM animation_assets WHERE id = ?").run(id);
  });

  test("启动迁移安装正确骨架和严格六组动作", () => {
    const rows = db.query("SELECT id, kind, skeleton_id, data FROM animation_assets WHERE id = ? OR skeleton_id = ? ORDER BY id")
      .all(BUILTIN_HUMANOID_SKELETON_ID, BUILTIN_HUMANOID_SKELETON_ID) as Array<{ id: string; kind: string; skeleton_id: string | null; data: string }>;
    const builtins = rows.filter((row) => isBuiltinAnimationAssetId(row.id));
    expect(builtins).toHaveLength(7);
    expect(builtins.filter((row) => row.kind === "motion-clip").map((row) => row.id).sort()).toEqual(Object.values(BUILTIN_MOTION_ASSET_IDS).sort());
    expect(builtins.every((row) => {
      const marker = JSON.parse(row.data).extensions?.[BUILTIN_ANIMATION_EXTENSION];
      return marker?.catalog === "quaternius-legacy-humanoid" && marker.version === 2;
    })).toBeTrue();
  });

  test("固定动作不能修改、删除、冒名创建或伪造标记", async () => {
    const id = BUILTIN_MOTION_ASSET_IDS.attack;
    const source = createBuiltinMotionClip("attack");
    expect((await request(`/animation-assets/${id}`, "PUT", { asset: { ...source, name: "tampered" } })).status).toBe(403);
    expect((await request(`/animation-assets/${id}`, "DELETE")).status).toBe(403);
    expect((await request("/animation-assets", "POST", { asset: source, folderId: null })).status).toBe(403);
    const spoof = { ...source, id: `motion-spoof-${crypto.randomUUID()}` };
    expect((await request("/animation-assets", "POST", { asset: spoof, folderId: null })).status).toBe(403);
  });

  test("复制品保留完整攻击数据、移除内置标记并可继续修改删除", async () => {
    const response = await request(`/animation-assets/${BUILTIN_MOTION_ASSET_IDS.attack}/copy`, "POST", { name: "攻击测试副本", folderId: null });
    expect(response.status).toBe(200);
    const stored = (await response.json() as { animationAsset: { asset: MotionClip } }).animationAsset.asset;
    created.add(stored.id);
    expect(stored.name).toBe("攻击测试副本");
    expect(stored.id).not.toBe(BUILTIN_MOTION_ASSET_IDS.attack);
    expect(stored.extensions?.[BUILTIN_ANIMATION_EXTENSION]).toBeUndefined();
    expect(stored.tracks).toEqual(JSON.parse(JSON.stringify(createBuiltinMotionClip("attack").tracks)));

    const changed = { ...stored, name: "攻击测试副本 v2", events: [{ time: .5, type: "attack-hit", name: "impact" }] };
    expect((await request(`/animation-assets/${stored.id}`, "PUT", { asset: changed })).status).toBe(200);
    expect((await request(`/animation-assets/${stored.id}`, "DELETE")).status).toBe(200);
    created.delete(stored.id);
  });
});
