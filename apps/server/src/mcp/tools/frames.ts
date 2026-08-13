import { mkdirSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, getFrame, uid, STORAGE_ROOT, serializeFrame } from "../../db";
import { broadcast } from "../../ws";
import { ok, err } from "../helpers";
import { clearFramePlacement, deleteFrameCell, ensureDefaultTimeline, reorderSteps, setStepDuration } from "../../timeline";
import { invalidateProjectUndo } from "../../undo";

export function register(server: McpServer) {
  server.registerTool(
    "list_frames",
    {
      title: "List Frames",
      description:
        "List all frames in a project, sorted by idx (frame order). Returns full frame data including transform properties (offset_x, offset_y, scale, rotation, opacity), duration, is_keyframe, tags, source, and metadata.",
      inputSchema: z.object({
        projectId: z.string().describe("Project UUID"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ projectId }) => {
      const {axis,track}=ensureDefaultTimeline(projectId);
      const rows = db.query("SELECT f.* FROM frames f JOIN animation_steps s ON s.id=f.step_id WHERE f.project_id=? AND f.track_id=? AND s.axis_id=? ORDER BY s.idx").all(projectId,track.id,axis.id) as any[];
      return ok({ frames: rows.map(serializeFrame) });
    }
  );

  server.registerTool(
    "update_frame",
    {
      title: "Update Frame",
      description:
        "Update frame image properties. All fields are optional—only provided fields are updated. Transform semantics: center anchor → offset (px) → rotation (rad) → scale → opacity. Use upsert_attack_effect for independent timeline-cell effects.",
      inputSchema: z.object({
        frameId: z.string().describe("Frame UUID"),
        offset_x: z.number().min(-100000).max(100000).describe("X offset in pixels").optional(),
        offset_y: z.number().min(-100000).max(100000).describe("Y offset in pixels").optional(),
        scale: z.number().min(0.1).max(8).describe("Uniform scale factor").optional(),
        rotation: z.number().min(-3.14159).max(3.14159).describe("Rotation in radians").optional(),
        opacity: z.number().min(0).max(1).describe("Opacity 0-1").optional(),
        duration: z.number().int().min(1).max(600).describe("Frame duration in ticks").optional(),
        is_keyframe: z.number().int().min(0).max(1).describe("1=keyframe, 0=normal").optional(),
        tags: z.array(z.string()).describe("Frame tags").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const { frameId, ...rest } = args;
      const frame = getFrame(frameId);
      if (!frame) return err("帧不存在");
      const updateFields = [
        "offset_x",
        "offset_y",
        "scale",
        "rotation",
        "opacity",
        "duration",
        "is_keyframe",
        "tags",
      ] as const;
      const keys = updateFields.filter((k) => rest[k] !== undefined);
      if (keys.length === 0) return err("没有可更新的字段");
      if(rest.duration!==undefined&&frame.step_id)setStepDuration(frame.step_id,rest.duration);
      const own=keys.filter(k=>k!=="duration");
      if(own.length){const setSql=own.map(k=>`${k} = ?`).join(", ");const values=own.map(k=>(k==="tags"?JSON.stringify(rest[k]):rest[k]) as string|number);db.query(`UPDATE frames SET ${setSql} WHERE id = ?`).run(...values,frameId);}
      const updated = getFrame(frameId)!;
      invalidateProjectUndo(frame.project_id);
      broadcast("frame_updated", { id: frameId, projectId: frame.project_id });
      return ok({ frame: serializeFrame(updated) });
    }
  );

  server.registerTool(
    "delete_frame",
    {
      title: "Delete Frame",
      description:
        "Delete a frame and its image files. Subsequent frames in the project have their idx decremented to fill the gap. Broadcasts frames_changed.",
      inputSchema: z.object({
        frameId: z.string().describe("Frame UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ frameId }) => {
      const frame = getFrame(frameId);
      if (!frame) return err("帧不存在");
      invalidateProjectUndo(frame.project_id);
      for (const p of [frame.raw_path, frame.processed_path]) {
        if (p && existsSync(p)) unlinkSync(p);
      }
      deleteFrameCell(frame.id);
      broadcast("frames_changed", { projectId: frame.project_id });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "clear_frame_cell",
    {
      title: "Clear Frame Cell",
      description:
        "Remove a frame from its timeline cell without deleting reusable asset files. Asset frames return to the asset pool; timeline instances are discarded.",
      inputSchema: z.object({
        frameId: z.string().describe("Timeline frame UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ frameId }) => {
      const frame = clearFramePlacement(frameId);
      if (!frame) return err("轨道单元格不存在");
      invalidateProjectUndo(frame.project_id);
      broadcast("timeline_changed", {
        projectId: frame.project_id,
        frameId: frame.id,
        trackId: frame.track_id,
        stepId: frame.step_id,
      });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "duplicate_frame",
    {
      title: "Duplicate Frame",
      description:
        "Duplicate a frame 1-16 times, inserting copies after the original. Copies all image files and properties with source=duplicate. Broadcasts frames_changed.",
      inputSchema: z.object({
        frameId: z.string().describe("Frame UUID to duplicate"),
        count: z.number().int().min(1).max(16).describe("Number of copies (default 1)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ frameId, count: rawCount }) => {
      const frame = getFrame(frameId);
      if (!frame) return err("帧不存在");
      const count = Math.min(Math.max(rawCount ?? 1, 1), 16);
      invalidateProjectUndo(frame.project_id);
      db.query("UPDATE frames SET idx = idx + ? WHERE project_id = ? AND idx > ?").run(
        count,
        frame.project_id,
        frame.idx
      );
      const rawDir = join(STORAGE_ROOT, "projects", frame.project_id, "raw");
      const procDir = join(STORAGE_ROOT, "projects", frame.project_id, "processed");
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(procDir, { recursive: true });
      for (let i = 1; i <= count; i++) {
        const nid = uid();
        let rawPath = frame.raw_path;
        if (frame.raw_path && existsSync(frame.raw_path)) {
          rawPath = `${rawDir}/dup_${nid}.png`;
          copyFileSync(frame.raw_path, rawPath);
        }
        let procPath = frame.processed_path;
        if (frame.processed_path && existsSync(frame.processed_path)) {
          procPath = `${procDir}/${nid}.png`;
          copyFileSync(frame.processed_path, procPath);
        }
        db.query(
          `INSERT INTO frames (id, project_id, idx, raw_path, processed_path, status, duration, is_keyframe,
             offset_x, offset_y, scale, rotation, opacity, tags, source, metadata, attack_effect)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'duplicate', ?, ?)`
        ).run(
          nid,
          frame.project_id,
          frame.idx + i,
          rawPath,
          procPath,
          frame.status === "ready" ? "ready" : frame.status,
          frame.duration,
          frame.is_keyframe,
          frame.offset_x,
          frame.offset_y,
          frame.scale,
          frame.rotation,
          frame.opacity,
          frame.tags,
          frame.metadata,
          frame.attack_effect
        );
      }
      broadcast("frames_changed", { projectId: frame.project_id });
      return ok({ ok: true, count });
    }
  );

  server.registerTool(
    "reorder_frames",
    {
      title: "Reorder Frames",
      description:
        "Reorder all frames in a project. The frameIds array must contain exactly all frame UUIDs of the project. The array order becomes the new idx order. Broadcasts frames_reordered.",
      inputSchema: z.object({
        projectId: z.string().describe("Project UUID"),
        frameIds: z.array(z.string()).describe("All frame UUIDs in the desired new order"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ projectId, frameIds }) => {
      const {axis,track}=ensureDefaultTimeline(projectId);
      const rows = db.query("SELECT f.id,f.step_id FROM frames f JOIN animation_steps s ON s.id=f.step_id WHERE f.project_id=? AND f.track_id=? AND s.axis_id=?").all(projectId,track.id,axis.id) as Array<{id:string;step_id:string}>;
      const set = new Set(rows.map((r) => r.id));
      const count=(db.query("SELECT COUNT(*) n FROM animation_steps WHERE axis_id=?").get(axis.id) as any).n;
      if (rows.length!==count||frameIds.length !== set.size || new Set(frameIds).size!==frameIds.length||!frameIds.every((id) => set.has(id))) {
        return err("仅支持主轨每步骤恰好一个单元格的旧式时间轴换序");
      }
      invalidateProjectUndo(projectId);
      const byId=new Map(rows.map(r=>[r.id,r.step_id]));reorderSteps(axis.id,frameIds.map(id=>byId.get(id)!));
      broadcast("frames_reordered", { projectId });
      return ok({ ok: true });
    }
  );
}
