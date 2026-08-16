import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { characterPartSetsApi } from "../apps/server/src/api/characterPartSets";
import { createAutomaticCharacterPartSet } from "../apps/server/src/api/materials";
import { db, STORAGE_ROOT } from "../apps/server/src/db";
import { buildGeneratedFollowUp } from "../apps/server/src/jobs/extract";
import { createGeneratedArtifactCommitter } from "../apps/server/src/jobs/generatedArtifacts";

const materialId = `test-part-${crypto.randomUUID()}`;
const secondMaterialId = `test-part-${crypto.randomUUID()}`;
let setId = "";
const generatedMaterialIds: string[] = [];
const automaticSetIds: string[] = [];
const call = (path: string, method = "GET", body?: unknown) => characterPartSetsApi.handle(new Request(`http://localhost/api${path}`, {
  method,
  headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe("CharacterPartSet API", () => {
  beforeAll(() => {
    const insert = db.query("INSERT INTO materials (id,name,status,source,created_at) VALUES (?,?,'raw','upload',?)");
    insert.run(materialId, "Test head", Date.now());
    insert.run(secondMaterialId, "Test torso", Date.now());
  });
  afterAll(() => {
    if (setId) {
      db.query("DELETE FROM character_part_set_members WHERE set_id = ?").run(setId);
      db.query("DELETE FROM character_part_sets WHERE id = ?").run(setId);
    }
    for (const id of generatedMaterialIds) {
      db.query("DELETE FROM materials WHERE id = ?").run(id);
      rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
    }
    for (const id of automaticSetIds) db.query("DELETE FROM character_part_sets WHERE id = ?").run(id);
    db.query("DELETE FROM materials WHERE id = ?").run(materialId);
    db.query("DELETE FROM materials WHERE id = ?").run(secondMaterialId);
  });

  test("创建、读取和更新角色部件集", async () => {
    const created = await call("/character-part-sets", "POST", { name: "Test character", source: "manual", referenceMaterialId: null, members: [{ materialId, role: "head", name: "Head" }] });
    expect(created.status).toBe(200);
    const payload = await created.json() as any;
    setId = payload.characterPartSet.id;
    expect(payload.characterPartSet.members).toEqual([{ materialId, role: "head", name: "Head" }]);
    const updated = await call(`/character-part-sets/${setId}`, "PUT", { name: "Updated character", referenceMaterialId: materialId, members: [{ materialId, role: "forearm-left", name: "Left forearm" }] });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).characterPartSet.source).toBe("manual");
    expect((await call(`/character-part-sets/${setId}`)).status).toBe(200);

    const legacy = await call(`/character-part-sets/${setId}`, "PUT", { name: "Legacy character", referenceMaterialId: null, members: [{ materialId, role: "arm-left", name: "Whole left arm" }] });
    expect(legacy.status).toBe(200);
    expect((await legacy.json() as any).characterPartSet.members[0].role).toBe("arm-left");
  });

  test("拒绝重复素材成员", async () => {
    const response = await call("/character-part-sets", "POST", { name: "Duplicate", source: "manual", members: [{ materialId, role: "head", name: "Head" }, { materialId, role: "torso", name: "Torso" }] });
    expect(response.status).toBe(400);
  });

  test("拒绝同一标准部件职责重复，允许多个自定义附件", async () => {
    const duplicateRole = await call("/character-part-sets", "POST", { name: "Duplicate role", source: "manual", members: [{ materialId, role: "forearm-left", name: "Left hand A" }, { materialId: secondMaterialId, role: "forearm-left", name: "Left hand B" }] });
    expect(duplicateRole.status).toBe(400);
    const accessories = await call("/character-part-sets", "POST", { name: "Accessories", source: "manual", members: [{ materialId, role: "accessory", name: "Cape" }, { materialId: secondMaterialId, role: "accessory", name: "Hat" }] });
    expect(accessories.status).toBe(200);
    const id = (await accessories.json() as any).characterPartSet.id;
    db.query("DELETE FROM character_part_set_members WHERE set_id = ?").run(id);
    db.query("DELETE FROM character_part_sets WHERE id = ?").run(id);
  });

  test("骨骼生成无需用户选择目标部件集，由服务端自动建立内部归属", () => {
    const id = createAutomaticCharacterPartSet("Test generated parts", "decomposed", materialId);
    automaticSetIds.push(id);
    expect(db.query("SELECT name, source, reference_material_id FROM character_part_sets WHERE id = ?").get(id)).toEqual({
      name: "Test generated parts",
      source: "decomposed",
      reference_material_id: materialId,
    });
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
      referenceMaterialId: materialId,
      gridRows: 3,
      gridCols: 5,
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
    expect(metadata.referenceMaterialId).toBe(materialId);
    expect(metadata.gridRows).toBe(3);
    expect(metadata.gridCols).toBe(5);
  });

  test("完整人物成功后构建单次引用分件任务并终止递归", () => {
    const next = buildGeneratedFollowUp({
      prompt: "complete character",
      count: 1,
      autoMatting: true,
      target: { kind: "materials" },
      providerId: "provider",
      characterPartSetId: setId,
      intent: "skeletal-character",
      followUp: { prompt: "decompose exact character", name: "15 parts", autoMatting: false, gridRows: 3, gridCols: 5 },
    }, materialId, "/safe/material/raw.png");

    expect(next).toMatchObject({
      prompt: "decompose exact character",
      name: "15 parts",
      count: 1,
      autoMatting: false,
      gridRows: 3,
      gridCols: 5,
      referenceMaterialId: materialId,
      referencePaths: ["/safe/material/raw.png"],
      intent: "skeletal-decompose",
      characterPartSetId: setId,
    });
    expect(next?.followUp).toBeUndefined();
  });
});
