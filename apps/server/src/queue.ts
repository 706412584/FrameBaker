import type { JobType } from "@framebaker/shared";
import { db, uid } from "./db";
import { broadcast } from "./ws";
import { extractFrames, generateFrames, type ExtractPayload, type GeneratePayload } from "./jobs/extract";
import { matte } from "./jobs/matting";

/** 任务产出目标：项目帧 or 素材库 */
export type JobTarget = { kind: "project"; projectId: string } | { kind: "materials" };

export interface JobPayload {
  extract?: ExtractPayload;
  generate?: GeneratePayload;
  matting?: { target: "frame" | "material"; id: string };
}

// 任务负载只存内存（状态落 SQLite），重启后 queued/running 任务不会恢复
const payloads = new Map<string, JobPayload>();
const waiting: string[] = [];
let running = 0;
const CONCURRENCY = 2;

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

function pump() {
  while (running < CONCURRENCY && waiting.length > 0) {
    const id = waiting.shift()!;
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
  const report = (p: string) => {
    setJob(id, "running", p);
    broadcast("job_progress", { id, projectId: job.project_id, progress: p });
  };
  setJob(id, "running", "开始处理");
  broadcast("job_running", { id, projectId: job.project_id });
  try {
    if (job.type === "extract_frames" && payload.extract) {
      await extractFrames(payload.extract, report);
    } else if (job.type === "generate_frames" && payload.generate) {
      await generateFrames(payload.generate, report);
    } else if (job.type === "matting" && payload.matting) {
      const warn = await matte(payload.matting.target, payload.matting.id);
      if (warn) report(warn); // 引擎缺失等警告写进 job.progress
    } else {
      throw new Error(`未知任务类型: ${job.type}`);
    }
    setJob(id, "done", "完成");
    broadcast("job_done", { id, projectId: job.project_id, type: job.type });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[job ${id}] ${job.type} 失败:`, msg);
    setJob(id, "error", null, msg);
    broadcast("job_error", { id, projectId: job.project_id, type: job.type, error: msg });
  } finally {
    payloads.delete(id);
  }
}
