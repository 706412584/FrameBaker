import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { characterPartSetsApi } from "../apps/server/src/api/characterPartSets";
import { db, STORAGE_ROOT } from "../apps/server/src/db";
import { createGeneratedArtifactCommitter } from "../apps/server/src/jobs/generatedArtifacts";

const materialId = `test-part-${crypto.randomUUID()}`;
let setId = "";
const generatedMaterialIds: string[] = [];
const call = (path: string, method = "GET", body?: unknown) => characterPartSetsApi.handle(new Request(`http://localhost/api${path}`, {
  method,
  headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe("CharacterPartSet API", () => {
  beforeAll(() => db.query("INSERT INTO materials (id,name,status,source,created_at) VALUES (?,?,'raw','upload',?)").run(materialId, "Test head", Date.now()));
  afterAll(() => {
    if (setId) {
      db.query("DELETE FROM character_part_set_members WHERE set_id = ?").run(setId);
      db.query("DELETE FROM character_part_sets WHERE id = ?").run(setId);
    }
    for (const id of generatedMaterialIds) {
      db.query("DELETE FROM materials WHERE id = ?").run(id);
      rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
    }
    db.query("DELETE FROM materials WHERE id = ?").run(materialId);
  });

  test("创建、读取和更新角色部件集", async () => {
    const created = await call("/character-part-sets", "POST", { name: "Test character", source: "manual", referenceMaterialId: null, members: [{ materialId, role: "head", name: "Head" }] });
    expect(created.status).toBe(200);
    const payload = await created.json() as any;
    setId = payload.characterPartSet.id;
    expect(payload.characterPartSet.members).toEqual([{ materialId, role: "head", name: "Head" }]);
    const updated = await call(`/character-part-sets/${setId}`, "PUT", { name: "Updated character", referenceMaterialId: materialId, members: [{ materialId, role: "accessory", name: "Hat" }] });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).characterPartSet.source).toBe("manual");
  });

  test("拒绝重复素材成员", async () => {
    const response = await call("/character-part-sets", "POST", { name: "Duplicate", source: "manual", members: [{ materialId, role: "head", name: "Head" }, { materialId, role: "torso", name: "Torso" }] });
    expect(response.status).toBe(400);
  });

  test("骨骼部件表产物保留目标部件集关联但不冒充独立部件", async () => {
    const committer = createGeneratedArtifactCommitter({
      target: { kind: "materials" },
      count: 1,
      autoMatting: false,
      name: "Generated arm",
      source: "api",
      prompt: "pixel arm",
      providerName: "test",
      intent: "skeletal-parts",
      characterPartSetId: setId,
      enqueueMatting() {},
    });
    const allocation = committer.allocate("image", 0);
    await Bun.write(allocation.path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]));
    const result = committer.commit(allocation);
    committer.finish();
    generatedMaterialIds.push(result.id);

    const member = db.query("SELECT role, name FROM character_part_set_members WHERE set_id = ? AND material_id = ?").get(setId, result.id);
    expect(member).toBeNull();
    const metadata = JSON.parse((db.query("SELECT metadata FROM materials WHERE id = ?").get(result.id) as { metadata: string }).metadata);
    expect(metadata.intent).toBe("skeletal-parts");
    expect(metadata.characterPartSetId).toBe(setId);
  });
});
