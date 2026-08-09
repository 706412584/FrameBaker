import { Elysia, t } from "elysia";
import type { CharacterPartRole, CharacterPartSet } from "@framebaker/shared";
import { db, uid } from "../db";

type SetRow = { id: string; name: string; source: CharacterPartSet["source"]; reference_material_id: string | null; created_at: number; updated_at: number };
type MemberRow = { material_id: string; role: CharacterPartRole; name: string };

function serialize(row: SetRow): CharacterPartSet {
  const members = db.query("SELECT material_id, role, name FROM character_part_set_members WHERE set_id = ? ORDER BY rowid").all(row.id) as MemberRow[];
  return { id: row.id, name: row.name, source: row.source, referenceMaterialId: row.reference_material_id, members: members.map((m) => ({ materialId: m.material_id, role: m.role, name: m.name })), created_at: row.created_at, updated_at: row.updated_at };
}
const getSet = (id: string) => db.query("SELECT * FROM character_part_sets WHERE id = ?").get(id) as SetRow | null;
const role = t.Union([t.Literal("head"), t.Literal("torso"), t.Literal("arm-left"), t.Literal("arm-right"), t.Literal("leg-left"), t.Literal("leg-right"), t.Literal("weapon"), t.Literal("accessory"), t.Literal("custom")]);
const members = t.Array(t.Object({ materialId: t.String(), role, name: t.String() }));

function validateMaterials(referenceMaterialId: string | null, items: Array<{ materialId: string }>): string | null {
  const ids = items.map((m) => m.materialId);
  if (new Set(ids).size !== ids.length) return "同一素材不能重复加入部件集";
  for (const id of [...ids, ...(referenceMaterialId ? [referenceMaterialId] : [])]) {
    if (!db.query("SELECT 1 FROM materials WHERE id = ?").get(id)) return `素材不存在: ${id}`;
  }
  return null;
}
function validateText(name: string, items: Array<{ name: string }>): string | null {
  if (!name.trim()) return "部件集名称不能为空";
  if (items.some((item) => !item.name.trim())) return "成员名称不能为空";
  return null;
}
function replaceMembers(setId: string, items: Array<{ materialId: string; role: CharacterPartRole; name: string }>) {
  db.query("DELETE FROM character_part_set_members WHERE set_id = ?").run(setId);
  const insert = db.query("INSERT INTO character_part_set_members (set_id, material_id, role, name) VALUES (?, ?, ?, ?)");
  for (const item of items) insert.run(setId, item.materialId, item.role, item.name.trim());
}

export const characterPartSetsApi = new Elysia({ prefix: "/api" })
  .get("/character-part-sets", () => ({ characterPartSets: (db.query("SELECT * FROM character_part_sets ORDER BY created_at DESC").all() as SetRow[]).map(serialize) }))
  .get("/character-part-sets/:id", ({ params, status }) => { const row = getSet(params.id); return row ? { characterPartSet: serialize(row) } : status(404, "角色部件集不存在"); })
  .post("/character-part-sets", ({ body, status }) => {
    const error = validateText(body.name, body.members) ?? validateMaterials(body.referenceMaterialId ?? null, body.members); if (error) return status(400, error);
    const id = uid(), now = Date.now();
    db.transaction(() => { db.query("INSERT INTO character_part_sets (id,name,source,reference_material_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, body.name.trim(), body.source, body.referenceMaterialId ?? null, now, now); replaceMembers(id, body.members); })();
    return { characterPartSet: serialize(getSet(id)!) };
  }, { body: t.Object({ name: t.String({ minLength: 1 }), source: t.Union([t.Literal("manual"), t.Literal("generated"), t.Literal("decomposed")]), referenceMaterialId: t.Optional(t.Union([t.String(), t.Null()])), members }) })
  .put("/character-part-sets/:id", ({ params, body, status }) => {
    const existing = getSet(params.id); if (!existing) return status(404, "角色部件集不存在");
    const error = validateText(body.name, body.members) ?? validateMaterials(body.referenceMaterialId ?? null, body.members); if (error) return status(400, error);
    db.transaction(() => { db.query("UPDATE character_part_sets SET name=?, reference_material_id=?, updated_at=? WHERE id=?").run(body.name.trim(), body.referenceMaterialId ?? null, Date.now(), params.id); replaceMembers(params.id, body.members); })();
    return { characterPartSet: serialize(getSet(params.id)!) };
  }, { body: t.Object({ name: t.String({ minLength: 1 }), referenceMaterialId: t.Optional(t.Union([t.String(), t.Null()])), members }) })
  .delete("/character-part-sets/:id", ({ params, status }) => { if (!getSet(params.id)) return status(404, "角色部件集不存在"); db.transaction(() => { db.query("DELETE FROM character_part_set_members WHERE set_id=?").run(params.id); db.query("DELETE FROM character_part_sets WHERE id=?").run(params.id); })(); return { ok: true }; });
