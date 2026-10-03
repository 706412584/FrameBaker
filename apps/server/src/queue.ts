import type { JobType } from "@framebaker/shared";
import { db, uid } from "./db";
import { broadcast } from "./ws";
import { buildGeneratedFollowUp, extractFrames, generateFrames, type ExtractPayload, type GeneratePayload } from "./jobs/extract";
import { getSettingJson } from "./provider";
import { matte, type SpriteMattingParams } from "./jobs/matting";
import { JobCancelledError } from "./jobs/run";
import { splitImageLayers, type ImageLayersPayload } from "./jobs/imageLayers";
import { splitComfyLayers, type ComfyLayersPayload } from "./jobs/comfyLayers";
import { installAiEngine, type AiEnginePayload } from "./jobs/aiEngine";

export interface JobPayload {
  extract?: ExtractPayload;
  generate?: GeneratePayload;
  /** pipeline 非空时走 sprite 管线（chroma/birefnet…）而非 rembg */
  matting?: { target: "frame" | "material"; id: string; pipeline?: string; model?: string; mattingParams?: Record<string, unknown> };
  imageLayers?: ImageLayersPayload;
  comfyLayers?: ComfyLayersPayload;
  aiEngine?: AiEnginePayload;
}

// 任务负载双写：内存 Map 供运行热路径（findActiveMattingJob / runJob），SQLite payload 列供重启恢复。
const payloads = new Map<string, JobPayload>();
const controllers = new Map<string, AbortController>();
const waiting: string[] = [];
let running = 0;

/**
 * 任务队列并发数：settings.queueConcurrency 优先（clamp 1~16），env FRAMEBAKER_QUEUE_CONCURRENCY 兜底，默认 2。
 * 每次实时读取，设置页改动即时生效（pump 频率低，单次轻量 DB 查询开销可忽略）。
 */
export function getQueueConcurrency(): number {
  const clamp = (n: number) => Math.max(1, Math.min(16, Math.floor(n)));
  const saved = getSettingJson<number>("queueConcurrency");
  if (typeof saved === "number" && saved >= 1) return clamp(saved);
  const env = Number(process.env.FRAMEBAKER_QUEUE_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return clamp(env);
  return 2;
}

export interface InterruptedJobRow {
  id: string;
  project_id: string;
  type: string;
  status: string;
  payload: string | null;
}

export type RecoveryVerdict = { action: "requeue" } | { action: "error"; reason: string };

/**
 * 纯函数：评估一条重启遗留任务能否恢复。
 * - 无 payload（升级前遗留）→ error
 * - running → error（无法断点续传；重跑对 extract/generate 等有重复副作用，不做）
 * - queued 且拆帧源文件已不在 → error
 * - 其余 queued → requeue（从未启动，无副作用，重跑安全）
 */
export function assessJobRecovery(
  type: string,
  status: string,
  hasPayload: boolean,
  stagingFileExists: boolean
): RecoveryVerdict {
  if (!hasPayload) return { action: "error", reason: "任务负载缺失，无法恢复（可能由旧版本创建），请重新发起" };
  if (status === "running") return { action: "error", reason: "服务重启，任务执行中断，请重新发起" };
  if (type === "extract_frames" && !stagingFileExists) {
    return { action: "error", reason: "导入源文件已不存在（重启期间被清理），请重新导入" };
  }
  return { action: "requeue" };
}

/** 从 jobs 行反序列化负载；损坏时抛错（由调用方决定处置） */
function parseJobPayload(row: { type: string; payload: string | null }): JobPayload | null {
  if (!row.payload) return null;
  const parsed = JSON.parse(row.payload) as JobPayload;
  return parsed && typeof parsed === "object" ? parsed : null;
}

/**
 * 恢复重启遗留的 queued/running 任务：可恢复的重新入队（保持 queued 状态），
 * 不可恢复的标 error 并给出原因。模块加载与测试共用。
 */
export function recoverInterruptedJobsFrom(rows: InterruptedJobRow[]): void {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  for (const row of rows) {
    if (row.status !== "queued" && row.status !== "running") continue;
    let payload: JobPayload | null = null;
    let parseError = false;
    try {
      payload = parseJobPayload(row);
    } catch {
      parseError = true;
    }
    const stagingFileExists = payload?.extract?.stagingFile ? existsSync(payload.extract.stagingFile) : true;
    let verdict: RecoveryVerdict;
    if (parseError) {
      verdict = { action: "error", reason: "任务负载损坏，无法恢复" };
    } else {
      verdict = assessJobRecovery(row.type, row.status, payload !== null, stagingFileExists);
    }
    if (verdict.action === "requeue" && payload) {
      payloads.set(row.id, payload);
      waiting.push(row.id);
    } else if (verdict.action === "error") {
      setJob(row.id, "error", null, verdict.reason);
      broadcast("job_error", { id: row.id, projectId: row.project_id, type: row.type, error: verdict.reason });
    }
  }
}

// 启动时恢复上次进程遗留的任务（payload 已持久化，queued 可无损续跑）
recoverInterruptedJobsFrom(
  db.query("SELECT id, project_id, type, status, payload FROM jobs WHERE status IN ('queued', 'running')").all() as InterruptedJobRow[]
);
pump();

export function createJob(projectId: string, type: JobType, payload: JobPayload): string {
  const id = uid();
  db.query("INSERT INTO jobs (id, project_id, type, status, created_at, payload) VALUES (?, ?, ?, 'queued', ?, ?)").run(
    id,
    projectId,
    type,
    Date.now(),
    JSON.stringify(payload)
  );
  payloads.set(id, payload);
  waiting.push(id);
  broadcast("job_queued", { id, projectId, type });
  pump();
  return id;
}

/** 图片批量生成拆成独立任务，由全局队列统一控制并发；视频仍只创建一个任务。 */
export function createGenerationJobs(projectId: string, generate: GeneratePayload): string[] {
  const count = generate.mediaKind === "video" ? 1 : generate.count;
  return Array.from({ length: count }, (_, batchIndex) =>
    createJob(projectId, "generate_frames", {
      generate: {
        ...generate,
        count: 1,
        batchCount: count,
        batchIndex,
      },
    })
  );
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
  targetId: string,
  pipeline?: string,
  model?: string,
  mattingParams?: Record<string, unknown>
): { jobId: string; duplicate: boolean } {
  // 去重按目标素材（同图重复入队无意义）；pipeline 不参与去重键
  const existing = findActiveMattingJob(target, targetId);
  if (existing) return { jobId: existing, duplicate: true };
  return { jobId: createJob(projectId, "matting", { matting: { target, id: targetId, pipeline, model, mattingParams } }), duplicate: false };
}

function enqueueMatting(projectId: string, target: "frame" | "material", id: string) {
  createMattingJob(projectId, target, id); // 已有进行中任务则忽略（拆帧/生成后的自动抠图）
}

function enqueueGeneratedFollowUp(source: GeneratePayload, referenceMaterialId: string) {
  const material = db.query("SELECT raw_path FROM materials WHERE id = ?").get(referenceMaterialId) as { raw_path: string | null } | null;
  if (!material?.raw_path) throw new Error("完整角色已生成，但素材文件缺失，无法继续拆分");
  const followUp = buildGeneratedFollowUp(source, referenceMaterialId, material.raw_path);
  if (!followUp) return;
  if (source.characterPartSetId) {
    // 首次生成建立身份基准；已有基准不可被后续试生成静默覆盖。
    db.query("UPDATE character_part_sets SET reference_material_id = ?, updated_at = ? WHERE id = ? AND reference_material_id IS NULL")
      .run(referenceMaterialId, Date.now(), source.characterPartSetId);
  }
  createJob("", "generate_frames", { generate: followUp });
}

function pump() {
  while (running < getQueueConcurrency() && waiting.length > 0) {
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
    payload: string | null;
  } | null;
  if (!job) return;
  // 内存命中（常规路径）；未命中则从持久化 payload 反序列化（重启恢复的任务）
  let payload = payloads.get(id) ?? null;
  if (!payload && job.payload) {
    try {
      payload = JSON.parse(job.payload) as JobPayload;
    } catch {
      payload = null;
    }
  }
  if (!payload) payload = {};
  const ac = new AbortController();
  controllers.set(id, ac);
  const signal = ac.signal;
  let generatedReferenceId: string | undefined;
  // 相同 progress 文本去重（如视频轮询每 5s 的重复心跳），避免无谓 DB 写 + 全局广播
  let lastProgress = "";
  const report = (p: string) => {
    if (signal.aborted) return;
    if (p === lastProgress) return;
    lastProgress = p;
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
      const generated = await generateFrames(payload.generate, report, enqueueMatting, signal);
      if (payload.generate.followUp && generated[0]?.kind === "image") generatedReferenceId = generated[0].id;
    } else if (job.type === "matting" && payload.matting) {
      if (signal.aborted) throw new JobCancelledError();
      const warn = await matte(payload.matting.target, payload.matting.id, signal, payload.matting.pipeline, payload.matting.model, payload.matting.mattingParams as SpriteMattingParams | undefined);
      if (warn) report(warn); // 引擎缺失等警告写进 job.progress
    } else if (job.type === "image_layers" && payload.imageLayers) {
      await splitImageLayers(payload.imageLayers, report, signal);
    } else if (job.type === "comfy_layers" && payload.comfyLayers) {
      await splitComfyLayers(payload.comfyLayers, report, signal);
    } else if (job.type === "ai_engine" && payload.aiEngine) {
      await installAiEngine(payload.aiEngine, report, signal);
    } else {
      throw new Error(`未知任务类型: ${job.type}`);
    }
    if (signal.aborted) throw new JobCancelledError();
    if (generatedReferenceId && payload.generate) enqueueGeneratedFollowUp(payload.generate, generatedReferenceId);
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
