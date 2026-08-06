import type { JobType } from "@framebaker/shared";
import { db, uid } from "./db";
import { broadcast } from "./ws";
import { extractFrames, generateFrames, type ExtractPayload, type GeneratePayload } from "./jobs/extract";
import { matte } from "./jobs/matting";
import { JobCancelledError } from "./jobs/run";

export interface JobPayload {
  extract?: ExtractPayload;
  generate?: GeneratePayload;
  matting?: { target: "frame" | "material"; id: string };
}

// 任务负载只存内存（状态落 SQLite），重启后 queued/running 任务不会恢复
const payloads = new Map<string, JobPayload>();
const controllers = new Map<string, AbortController>();
const waiting: string[] = [];
let running = 0;
const CONCURRENCY = 2;

// 启动时把上次进程遗留的 queued/running 任务标记为中断（负载随内存丢失，不可能再继续）
db.query("UPDATE jobs SET status = 'error', error = '服务重启，任务中断' WHERE status IN ('queued', 'running')").run();

export function createJob(projectId: string, type: JobType, payload: JobPayload): string {
  const id = uid();
  db.query("INSERT INTO jobs (id, project_id, type, status, created_at) VALUES (?, ?, ?, 'queued', ?)").run(
    id,
    projectId,
    type,
    Date.now()
  );
  payloads.set(id, payload);
  waiting.push(id);
  broadcast("job_queued", { id, projectId, type });
  pump();
  return id;
}

/**
 * 取消任务：queued 直接出队；running 触发 AbortSignal。
 * 返回 false 表示不存在或已结束不可取消。
 */
export function cancelJob(id: string): boolean {
  const job = db.query("SELECT id, project_id, type, status FROM jobs WHERE id = ?").get(id) as {
    id: string;
    project_id: string;
    type: string;
    status: string;
  } | null;
  if (!job) return false;
  if (job.status === "queued") {
    const idx = waiting.indexOf(id);
    if (idx >= 0) waiting.splice(idx, 1);
    setJob(id, "cancelled", "已取消", null);
    payloads.delete(id);
    broadcast("job_cancelled", { id, projectId: job.project_id, type: job.type });
    return true;
  }
  if (job.status === "running") {
    const c = controllers.get(id);
    if (c && !c.signal.aborted) c.abort();
    return true;
  }
  return false;
}

/** 同一 frame/material 是否已有排队或运行中的抠图任务 */
export function findActiveMattingJob(target: "frame" | "material", targetId: string): string | null {
  for (const [jobId, payload] of payloads) {
    const m = payload.matting;
    if (!m || m.target !== target || m.id !== targetId) continue;
    const row = db.query("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | null;
    if (row && (row.status === "queued" || row.status === "running")) return jobId;
  }
  return null;
}

/**
 * 入队抠图（同目标已有 queued/running 则拒绝，避免同一图无限重复抠）。
 * 返回 jobId，或已有任务 id（duplicate=true）。
 */
export function createMattingJob(
  projectId: string,
  target: "frame" | "material",
  targetId: string
): { jobId: string; duplicate: boolean } {
  const existing = findActiveMattingJob(target, targetId);
  if (existing) return { jobId: existing, duplicate: true };
  return { jobId: createJob(projectId, "matting", { matting: { target, id: targetId } }), duplicate: false };
}

function enqueueMatting(projectId: string, target: "frame" | "material", id: string) {
  createMattingJob(projectId, target, id); // 已有进行中任务则忽略（拆帧/生成后的自动抠图）
}

function pump() {
  while (running < CONCURRENCY && waiting.length > 0) {
    const id = waiting.shift()!;
    // 可能已被取消但尚未移出（竞态兜底）
    const row = db.query("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string } | null;
    if (!row || row.status === "cancelled") {
      payloads.delete(id);
      continue;
    }
    running++;
    runJob(id).finally(() => {
      running--;
      pump();
    });
  }
}

function setJob(id: string, status: string, progress?: string | null, error?: string | null) {
  db.query("UPDATE jobs SET status = ?, progress = COALESCE(?, progress), error = COALESCE(?, error) WHERE id = ?").run(
    status,
    progress ?? null,
    error ?? null,
    id
  );
}

async function runJob(id: string) {
  const job = db.query("SELECT * FROM jobs WHERE id = ?").get(id) as {
    id: string;
    project_id: string;
    type: string;
  } | null;
  if (!job) return;
  const payload = payloads.get(id) ?? {};
  const ac = new AbortController();
  controllers.set(id, ac);
  const signal = ac.signal;
  const report = (p: string) => {
    if (signal.aborted) return;
    setJob(id, "running", p);
    broadcast("job_progress", { id, projectId: job.project_id, progress: p });
  };
  setJob(id, "running", "开始处理");
  broadcast("job_running", { id, projectId: job.project_id });
  try {
    if (signal.aborted) throw new JobCancelledError();
    if (job.type === "extract_frames" && payload.extract) {
      await extractFrames(payload.extract, report, enqueueMatting, signal);
    } else if (job.type === "generate_frames" && payload.generate) {
      await generateFrames(payload.generate, report, enqueueMatting, signal);
    } else if (job.type === "matting" && payload.matting) {
      if (signal.aborted) throw new JobCancelledError();
      const warn = await matte(payload.matting.target, payload.matting.id, signal);
      if (warn) report(warn); // 引擎缺失等警告写进 job.progress
    } else {
      throw new Error(`未知任务类型: ${job.type}`);
    }
    if (signal.aborted) throw new JobCancelledError();
    setJob(id, "done", "完成");
    broadcast("job_done", { id, projectId: job.project_id, type: job.type });
  } catch (err) {
    if (err instanceof JobCancelledError || signal.aborted) {
      setJob(id, "cancelled", "已取消", null);
      broadcast("job_cancelled", { id, projectId: job.project_id, type: job.type });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[job ${id}] ${job.type} 失败:`, msg);
      setJob(id, "error", null, msg);
      broadcast("job_error", { id, projectId: job.project_id, type: job.type, error: msg });
    }
  } finally {
    controllers.delete(id);
    payloads.delete(id);
  }
}
