import type { AnimationAxis, AnimationTrack, Frame, TimelineResponse, TimelineStep } from "@framebaker/shared";
import { db, getFrame, nextFrameIdx, serializeFrame, uid } from "./db";

type Defaults = { axis: AnimationAxis; track: AnimationTrack };

export function ensureDefaultTimeline(projectId: string): Defaults {
  return db.transaction(() => {
    let axis = db.query("SELECT * FROM animation_axes WHERE project_id = ? ORDER BY idx, id LIMIT 1").get(projectId) as AnimationAxis | null;
    if (!axis) {
      const exists = db.query("SELECT created_at FROM projects WHERE id = ?").get(projectId) as { created_at: number } | null;
      if (!exists) throw new Error("项目不存在");
      const id = uid();
      db.query("INSERT INTO animation_axes VALUES (?, ?, 'Default', 0, 8, ?)").run(id, projectId, exists.created_at);
      axis = db.query("SELECT * FROM animation_axes WHERE id = ?").get(id) as AnimationAxis;
    }
    let track = db.query("SELECT * FROM animation_tracks WHERE axis_id = ? ORDER BY is_primary DESC, idx, id LIMIT 1").get(axis.id) as AnimationTrack | null;
    if (!track) {
      const id = uid();
      db.query("INSERT INTO animation_tracks VALUES (?, ?, 'Main', 0, 1, 0, 1)").run(id, axis.id);
      track = db.query("SELECT * FROM animation_tracks WHERE id = ?").get(id) as AnimationTrack;
    }
    return { axis, track };
  })();
}

export function getTimeline(projectId: string, axisId?: string): TimelineResponse {
  ensureDefaultTimeline(projectId);
  const axes = db.query("SELECT * FROM animation_axes WHERE project_id = ? ORDER BY idx, id").all(projectId) as AnimationAxis[];
  const axis = (axisId ? axes.find((a) => a.id === axisId) : axes[0]);
  if (!axis) throw new Error(axisId ? "动画轴不存在或不属于项目" : "项目不存在");
  const tracks = db.query("SELECT * FROM animation_tracks WHERE axis_id = ? ORDER BY idx, id").all(axis.id) as AnimationTrack[];
  const steps = db.query("SELECT * FROM animation_steps WHERE axis_id = ? ORDER BY idx, id").all(axis.id) as TimelineStep[];
  const frames = db.query(`SELECT f.* FROM frames f JOIN animation_tracks t ON t.id=f.track_id
    JOIN animation_steps s ON s.id=f.step_id WHERE t.axis_id=? AND s.axis_id=? ORDER BY s.idx,t.idx,f.id`).all(axis.id, axis.id) as any[];
  const poolFrames = db.query("SELECT * FROM frames WHERE project_id=? AND is_asset=1 AND track_id IS NULL AND step_id IS NULL ORDER BY idx,id").all(projectId) as any[];
  const assetFrames = db.query("SELECT * FROM frames WHERE project_id=? AND is_asset=1 ORDER BY idx,id").all(projectId) as any[];
  return { axes, axis, tracks, steps, frames: frames.map(serializeFrame), poolFrames: poolFrames.map(serializeFrame), assetFrames: assetFrames.map(serializeFrame) };
}

/** 导入只进入待编排帧池；用户拖入时间轴后才绑定轨道和步骤。 */
export function appendFramePool(projectId: string, frame: {
  id?: string; raw_path?: string | null; processed_path?: string | null; status?: string; source?: string; metadata?: string;
}): string {
  const id = frame.id ?? uid();
  db.query(`INSERT INTO frames (id,project_id,idx,raw_path,processed_path,status,source,metadata)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, projectId, nextFrameIdx(projectId), frame.raw_path ?? null, frame.processed_path ?? null, frame.status ?? "ready", frame.source ?? "upload", frame.metadata ?? "{}");
  return id;
}

export function appendFrameCell(projectId: string, frame: {
  id?: string; raw_path?: string | null; processed_path?: string | null; status?: string; source?: string; metadata?: string;
}): string {
  return db.transaction(() => {
    const { axis, track } = ensureDefaultTimeline(projectId);
    const idx = (db.query("SELECT COALESCE(MAX(idx),-1)+1 next FROM animation_steps WHERE axis_id=?").get(axis.id) as { next: number }).next;
    const stepId = uid(); const id = frame.id ?? uid();
    db.query("INSERT INTO animation_steps (id,axis_id,idx,duration) VALUES (?,?,?,1)").run(stepId, axis.id, idx);
    db.query(`INSERT INTO frames (id,project_id,track_id,step_id,idx,raw_path,processed_path,status,source,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, track.id, stepId, idx, frame.raw_path ?? null, frame.processed_path ?? null, frame.status ?? "ready", frame.source ?? "upload", frame.metadata ?? "{}");
    return id;
  })();
}

export interface NewFrameCell {
  id: string; raw_path: string | null; processed_path: string | null; status: string; source: string; metadata: string;
}

/** 在复制素材文件前校验整批目标，避免失败导入遗留孤儿文件。 */
export function validateFrameImportTarget(projectId: string, count: number, target: { axisId: string; trackId: string; startStepId?: string }) {
  const track = db.query(`SELECT t.id,t.axis_id,a.project_id FROM animation_tracks t JOIN animation_axes a ON a.id=t.axis_id WHERE t.id=?`).get(target.trackId) as {id:string;axis_id:string;project_id:string}|null;
  if (!track || track.project_id !== projectId || track.axis_id !== target.axisId) throw new Error("目标动画轴或轨道不属于项目");
  if (!target.startStepId) return;
  const all = db.query("SELECT * FROM animation_steps WHERE axis_id=? ORDER BY idx,id").all(target.axisId) as TimelineStep[];
  const start = all.findIndex((step) => step.id === target.startStepId);
  if (start < 0) throw new Error("起始步骤不属于目标动画轴");
  const steps = all.slice(start, start + count);
  if (steps.length !== count) throw new Error("目标步骤空间不足");
  const occupied = db.query(`SELECT step_id FROM frames WHERE track_id=? AND step_id IN (${steps.map(() => "?").join(",")})`).all(target.trackId, ...steps.map((step) => step.id));
  if (occupied.length) throw new Error("目标轨道的步骤已被占用");
}

/** 批量把新帧放入指定轨道；先完整校验目标与占用，避免部分写入。 */
export function importFrameCellsToTarget(projectId: string, cells: NewFrameCell[], target: { axisId: string; trackId: string; startStepId?: string }): string[] {
  return db.transaction(() => {
    validateFrameImportTarget(projectId, cells.length, target);
    const track = db.query(`SELECT t.id,t.axis_id,a.project_id FROM animation_tracks t JOIN animation_axes a ON a.id=t.axis_id WHERE t.id=?`).get(target.trackId) as {id:string;axis_id:string;project_id:string}|null;
    if (!track || track.project_id !== projectId || track.axis_id !== target.axisId) throw new Error("目标动画轴或轨道不属于项目");
    let steps: TimelineStep[] = [];
    if (target.startStepId) {
      const all = db.query("SELECT * FROM animation_steps WHERE axis_id=? ORDER BY idx,id").all(target.axisId) as TimelineStep[];
      const start = all.findIndex((s) => s.id === target.startStepId);
      if (start < 0) throw new Error("起始步骤不属于目标动画轴");
      steps = all.slice(start, start + cells.length);
      if (steps.length !== cells.length) throw new Error("目标步骤空间不足");
      const occupied = db.query(`SELECT step_id FROM frames WHERE track_id=? AND step_id IN (${steps.map(() => "?").join(",")})`).all(target.trackId, ...steps.map((s) => s.id));
      if (occupied.length) throw new Error("目标轨道的步骤已被占用");
    } else {
      let idx = (db.query("SELECT COALESCE(MAX(idx),-1)+1 next FROM animation_steps WHERE axis_id=?").get(target.axisId) as {next:number}).next;
      steps = cells.map(() => ({ id: uid(), axis_id: target.axisId, idx: idx++, duration: 1 }));
      for (const step of steps) db.query("INSERT INTO animation_steps (id,axis_id,idx,duration) VALUES (?,?,?,?)").run(step.id, step.axis_id, step.idx, step.duration);
    }
    cells.forEach((cell, i) => db.query(`INSERT INTO frames (id,project_id,track_id,step_id,idx,raw_path,processed_path,status,source,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cell.id, projectId, target.trackId, steps[i].id, steps[i].idx, cell.raw_path, cell.processed_path, cell.status, cell.source, cell.metadata));
    syncAxis(target.axisId);
    return cells.map((cell) => cell.id);
  })();
}

export function syncAxis(axisId: string) {
  const steps = db.query("SELECT id,idx,duration FROM animation_steps WHERE axis_id=? ORDER BY idx,id").all(axisId) as TimelineStep[];
  const update = db.query("UPDATE frames SET idx=?, duration=? WHERE step_id=?");
  db.transaction(() => steps.forEach((s, i) => { if (s.idx !== i) db.query("UPDATE animation_steps SET idx=? WHERE id=?").run(-i - 1, s.id); }))();
  db.transaction(() => steps.forEach((s, i) => { db.query("UPDATE animation_steps SET idx=? WHERE id=?").run(i, s.id); update.run(i, s.duration, s.id); }))();
}

export function setStepDuration(stepId: string, duration: number) {
  db.transaction(() => { db.query("UPDATE animation_steps SET duration=? WHERE id=?").run(duration, stepId); db.query("UPDATE frames SET duration=? WHERE step_id=?").run(duration, stepId); })();
}

export function deleteFrameCell(frameId: string) {
  const frame = getFrame(frameId); if (!frame) return null;
  db.transaction(() => { db.query("DELETE FROM frames WHERE id=?").run(frameId); if (frame.step_id) db.query("DELETE FROM animation_steps WHERE id=? AND NOT EXISTS (SELECT 1 FROM frames WHERE step_id=?)").run(frame.step_id, frame.step_id); })();
  const axis = frame.step_id ? db.query("SELECT axis_id FROM animation_steps WHERE id=?").get(frame.step_id) as { axis_id: string } | null : null;
  const fallback = frame.track_id ? db.query("SELECT axis_id FROM animation_tracks WHERE id=?").get(frame.track_id) as { axis_id: string } | null : null;
  if (axis || fallback) syncAxis((axis ?? fallback)!.axis_id);
  return frame;
}

/** 清空时间轴单元格：资产退回左侧资产池，实例只删记录；保留步骤且不删除共享图片文件。 */
export function clearFramePlacement(frameId: string) {
  const frame = getFrame(frameId);
  if (!frame || !frame.track_id || !frame.step_id) return null;
  const track = db.query("SELECT axis_id FROM animation_tracks WHERE id=?").get(frame.track_id) as { axis_id: string } | null;
  db.transaction(() => {
    if (frame.is_asset) {
      db.query("UPDATE frames SET track_id=NULL,step_id=NULL WHERE id=?").run(frameId);
    } else {
      db.query("DELETE FROM frames WHERE id=?").run(frameId);
    }
  })();
  if (track) syncAxis(track.axis_id);
  return frame;
}

export function reorderSteps(axisId: string, ids: string[]) {
  const current = db.query("SELECT id FROM animation_steps WHERE axis_id=?").all(axisId) as Array<{id:string}>;
  const set = new Set(current.map(x=>x.id));
  if (ids.length !== set.size || new Set(ids).size !== ids.length || !ids.every(id=>set.has(id))) throw new Error("stepIds 必须恰好且不重复地包含动画轴的全部步骤");
  db.transaction(() => { ids.forEach((id,i)=>db.query("UPDATE animation_steps SET idx=? WHERE id=?").run(-i-1,id)); ids.forEach((id,i)=>db.query("UPDATE animation_steps SET idx=? WHERE id=?").run(i,id)); })();
  syncAxis(axisId);
}

export function placeFrame(frameId: string, trackId: string, stepId: string, swap = false, copy = false): Frame {
  const frame = getFrame(frameId);
  if (!frame) throw new Error("帧不存在");
  const row = db.query(`SELECT t.axis_id, a.project_id FROM animation_tracks t JOIN animation_axes a ON a.id=t.axis_id
    JOIN animation_steps s ON s.id=? AND s.axis_id=t.axis_id WHERE t.id=?`).get(stepId, trackId) as {axis_id:string;project_id:string}|null;
  if (!row || row.project_id !== frame.project_id) throw new Error("轨道和步骤必须属于帧所在项目的同一动画轴");
  const source = frame.track_id ? db.query("SELECT axis_id FROM animation_tracks WHERE id=?").get(frame.track_id) as { axis_id: string } | null : null;
  if (!copy && source && source.axis_id !== row.axis_id) throw new Error("不能跨动画轴移动帧");
  const occupied = db.query("SELECT id FROM frames WHERE track_id=? AND step_id=? AND id<>?").get(trackId, stepId, frameId) as { id: string } | null;
  if (occupied && !swap) throw new Error("OCCUPIED");
  let placedId = frameId;
  db.transaction(() => {
    if (copy) {
      if (!frame.is_asset) throw new Error("只有帧资产可以创建时间轴实例");
      if (occupied) db.query("UPDATE frames SET track_id=NULL,step_id=NULL,is_asset=1,idx=? WHERE id=?").run(nextFrameIdx(frame.project_id), occupied.id);
      placedId = uid();
      db.query(`INSERT INTO frames (id,project_id,track_id,step_id,is_asset,idx,raw_path,processed_path,status,duration,is_keyframe,offset_x,offset_y,scale,rotation,opacity,tags,source,metadata)
        VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(placedId,frame.project_id,trackId,stepId,frame.idx,frame.raw_path,frame.processed_path,frame.status,frame.duration,frame.is_keyframe,frame.offset_x,frame.offset_y,frame.scale,frame.rotation,frame.opacity,frame.tags,frame.source,frame.metadata);
    } else if (occupied) {
      // 唯一坐标约束下先暂时移开目标帧，再完成原子交换。
      db.query("UPDATE frames SET track_id=NULL,step_id=NULL WHERE id=?").run(occupied.id);
      db.query("UPDATE frames SET track_id=?,step_id=? WHERE id=?").run(trackId, stepId, frameId);
      if (frame.track_id && frame.step_id) {
        db.query("UPDATE frames SET track_id=?,step_id=? WHERE id=?").run(frame.track_id, frame.step_id, occupied.id);
      } else {
        db.query("UPDATE frames SET idx=? WHERE id=?").run(nextFrameIdx(frame.project_id), occupied.id);
      }
    } else {
      db.query("UPDATE frames SET track_id=?,step_id=? WHERE id=?").run(trackId, stepId, frameId);
    }
    syncAxis(row.axis_id);
  })();
  return serializeFrame(getFrame(placedId)!);
}

/**
 * 批量把资产帧 copy 到目标轨道的连续格子（从 startStepId 起；该轨道上被占用的格子其原帧推回资产池；
 * 连续 step 不足时新建追加到 axis 末尾）。只影响目标轨道的 cell，不动其他轨道。
 */
export function placeAssetFramesBatch(
  projectId: string,
  frameIds: string[],
  target: { axisId: string; trackId: string; startStepId?: string }
): string[] {
  if (!frameIds.length) return [];
  return db.transaction(() => {
    const track = db.query(`SELECT t.id,t.axis_id,a.project_id FROM animation_tracks t JOIN animation_axes a ON a.id=t.axis_id WHERE t.id=?`).get(target.trackId) as { id: string; axis_id: string; project_id: string } | null;
    if (!track || track.project_id !== projectId || track.axis_id !== target.axisId) throw new Error("目标轨道不属于项目的该动画轴");
    // 在创建 step 或挪动已有 cell 前一次性校验全部来源，确保失败时不产生任何时间轴变更。
    const frames = frameIds.map((frameId) => {
      const frame = getFrame(frameId);
      if (!frame) throw new Error("帧不存在");
      if (frame.project_id !== projectId) throw new Error("资产帧与目标轨道必须属于同一项目");
      if (!frame.is_asset) throw new Error("只有帧资产可以创建时间轴实例");
      return frame;
    });
    const n = frameIds.length;
    const all = db.query("SELECT * FROM animation_steps WHERE axis_id=? ORDER BY idx,id").all(target.axisId) as TimelineStep[];
    // 解析目标连续 step 序列：从 startStepId 起取现有 step；无 startStepId 则全部新建
    const steps: TimelineStep[] = [];
    if (target.startStepId) {
      const startIdx = all.findIndex((s) => s.id === target.startStepId);
      if (startIdx < 0) throw new Error("起始步骤不属于目标动画轴");
      for (let i = startIdx; i < all.length && steps.length < n; i++) steps.push(all[i]!);
    }
    let nextIdx = (db.query("SELECT COALESCE(MAX(idx),-1)+1 next FROM animation_steps WHERE axis_id=?").get(target.axisId) as { next: number }).next;
    while (steps.length < n) {
      const id = uid();
      db.query("INSERT INTO animation_steps (id,axis_id,idx,duration) VALUES (?,?,?,1)").run(id, target.axisId, nextIdx);
      steps.push({ id, axis_id: target.axisId, idx: nextIdx, duration: 1 });
      nextIdx++;
    }
    const placedIds: string[] = [];
    frames.forEach((frame, i) => {
      const step = steps[i]!;
      // 目标轨道该 step 若已有帧 → 推回资产池（与单帧 copy+swap 行为一致）
      const occupied = db.query("SELECT id FROM frames WHERE track_id=? AND step_id=?").get(target.trackId, step.id) as { id: string } | null;
      if (occupied) db.query("UPDATE frames SET track_id=NULL,step_id=NULL,is_asset=1,idx=? WHERE id=?").run(nextFrameIdx(projectId), occupied.id);
      const placedId = uid();
      db.query(`INSERT INTO frames (id,project_id,track_id,step_id,is_asset,idx,raw_path,processed_path,status,duration,is_keyframe,offset_x,offset_y,scale,rotation,opacity,tags,source,metadata)
        VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(placedId, projectId, target.trackId, step.id, step.idx, frame.raw_path, frame.processed_path, frame.status, frame.duration, frame.is_keyframe, frame.offset_x, frame.offset_y, frame.scale, frame.rotation, frame.opacity, frame.tags, frame.source, frame.metadata);
      placedIds.push(placedId);
    });
    syncAxis(target.axisId);
    return placedIds;
  })();
}
