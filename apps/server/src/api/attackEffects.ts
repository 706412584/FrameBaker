import { Elysia, t } from "elysia";
import { db, serializeAttackEffect, uid } from "../db";
import { broadcast } from "../ws";

export const attackEffectSchema = t.Object({
  strokes: t.Array(t.Object({
    color: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
    size: t.Number({ minimum: 1, maximum: 256 }),
    brush: t.Optional(t.Union([
      t.Literal("slash"), t.Literal("bristle"), t.Literal("dry"), t.Literal("spark"), t.Literal("echo"),
    ])),
    points: t.Array(t.Object({
      x: t.Number({ minimum: -100_000, maximum: 100_000 }),
      y: t.Number({ minimum: -100_000, maximum: 100_000 }),
      pressure: t.Number({ minimum: 0.1, maximum: 1 }),
    }), { minItems: 1, maxItems: 4096 }),
  }), { maxItems: 128 }),
  offset_x: t.Number({ minimum: -100_000, maximum: 100_000 }),
  offset_y: t.Number({ minimum: -100_000, maximum: 100_000 }),
  scale: t.Number({ minimum: 0.1, maximum: 8 }),
  rotation: t.Number({ minimum: -Math.PI, maximum: Math.PI }),
  opacity: t.Number({ minimum: 0, maximum: 1 }),
  style: t.Optional(t.Union([t.Literal("flame"), t.Literal("energy"), t.Literal("ink")])),
});

const cellContext = (trackId: string, stepId: string) => db.query(`SELECT a.project_id
  FROM animation_tracks t JOIN animation_axes a ON a.id=t.axis_id
  JOIN animation_steps s ON s.id=? AND s.axis_id=t.axis_id WHERE t.id=?`).get(stepId, trackId) as { project_id: string } | null;

/** 空图片格也可写入独立特效；同一轨道×步骤最多一个特效单元格。 */
export const attackEffectsApi = new Elysia({ prefix: "/api" })
  .put("/tracks/:id/steps/:stepId/effect", ({ params, body, status }) => {
    const context = cellContext(params.id, params.stepId);
    if (!context) return status(404, "轨道与步骤不属于同一动画轴");
    const existing = db.query("SELECT id FROM attack_effects WHERE track_id=? AND step_id=?").get(params.id, params.stepId) as { id: string } | null;
    const id = existing?.id ?? uid();
    if (existing) db.query("UPDATE attack_effects SET effect=? WHERE id=?").run(JSON.stringify(body), id);
    else db.query("INSERT INTO attack_effects VALUES (?,?,?,?,?,?)").run(id, context.project_id, params.id, params.stepId, JSON.stringify(body), Date.now());
    broadcast("timeline_changed", { projectId: context.project_id, trackId: params.id, stepId: params.stepId, effectId: id });
    return { effect: serializeAttackEffect(db.query("SELECT * FROM attack_effects WHERE id=?").get(id) as any) };
  }, { body: attackEffectSchema })
  .delete("/tracks/:id/steps/:stepId/effect", ({ params, status }) => {
    const context = cellContext(params.id, params.stepId);
    if (!context) return status(404, "轨道与步骤不属于同一动画轴");
    db.query("DELETE FROM attack_effects WHERE track_id=? AND step_id=?").run(params.id, params.stepId);
    broadcast("timeline_changed", { projectId: context.project_id, trackId: params.id, stepId: params.stepId });
    return { ok: true };
  });
