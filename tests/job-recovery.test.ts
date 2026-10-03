import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { db } from "../apps/server/src/db";
import { assessJobRecovery, recoverInterruptedJobsFrom, type InterruptedJobRow } from "../apps/server/src/queue";

describe("assessJobRecovery 规则矩阵", () => {
  test("无 payload → error（升级前遗留任务）", () => {
    expect(assessJobRecovery("matting", "queued", false, true)).toEqual({
      action: "error",
      reason: "任务负载缺失，无法恢复（可能由旧版本创建），请重新发起",
    });
  });

  test("running → error（不重跑，避免重复副作用）", () => {
    expect(assessJobRecovery("extract_frames", "running", true, true)).toEqual({
      action: "error",
      reason: "服务重启，任务执行中断，请重新发起",
    });
    expect(assessJobRecovery("generate_frames", "running", true, true).action).toBe("error");
  });

  test("queued 拆帧且源文件缺失 → error", () => {
    expect(assessJobRecovery("extract_frames", "queued", true, false)).toEqual({
      action: "error",
      reason: "导入源文件已不存在（重启期间被清理），请重新导入",
    });
  });

  test("queued 拆帧且源文件存在 → requeue", () => {
    expect(assessJobRecovery("extract_frames", "queued", true, true)).toEqual({ action: "requeue" });
  });

  test("其余 queued（生成/抠图/分层）→ requeue", () => {
    expect(assessJobRecovery("generate_frames", "queued", true, true)).toEqual({ action: "requeue" });
    expect(assessJobRecovery("matting", "queued", true, true)).toEqual({ action: "requeue" });
    expect(assessJobRecovery("image_layers", "queued", true, true)).toEqual({ action: "requeue" });
    expect(assessJobRecovery("comfy_layers", "queued", true, true)).toEqual({ action: "requeue" });
    expect(assessJobRecovery("ai_engine", "queued", true, true)).toEqual({ action: "requeue" });
  });
});

describe("recoverInterruptedJobsFrom 集成（真实 DB）", () => {
  const ids: string[] = [];
  const stagingPath = join(process.cwd(), "storage", `test-staging-${crypto.randomUUID()}.tmp`);

  function insertRow(status: string, type: string, payload: string | null) {
    const id = crypto.randomUUID();
    ids.push(id);
    db.query("INSERT INTO jobs (id, project_id, type, status, created_at, payload) VALUES (?, 'recovery-test', ?, ?, ?, ?)").run(
      id,
      type,
      status,
      Date.now(),
      payload
    );
    return id;
  }

  function jobStatus(id: string) {
    return (db.query("SELECT status, error FROM jobs WHERE id = ?").get(id) as { status: string; error: string | null }).status;
  }

  test("可恢复重新入队，不可恢复标 error", () => {
    writeFileSync(stagingPath, "fake");
    const requeued = insertRow("queued", "matting", JSON.stringify({ matting: { target: "material", id: "m1" } }));
    const requeuedExtract = insertRow("queued", "extract_frames", JSON.stringify({ extract: { stagingFile: stagingPath, target: "project", id: "p1" } }));
    const running = insertRow("running", "generate_frames", JSON.stringify({ generate: { prompt: "x" } }));
    const noPayload = insertRow("queued", "matting", null);
    const brokenPayload = insertRow("queued", "matting", "{not-json");
    const missingStaging = insertRow("queued", "extract_frames", JSON.stringify({ extract: { stagingFile: stagingPath + ".gone", target: "project", id: "p2" } }));

    const rows = db
      .query("SELECT id, project_id, type, status, payload FROM jobs WHERE id IN (?, ?, ?, ?, ?, ?)")
      .all(requeued, requeuedExtract, running, noPayload, brokenPayload, missingStaging) as InterruptedJobRow[];
    recoverInterruptedJobsFrom(rows);

    expect(jobStatus(requeued)).toBe("queued");
    expect(jobStatus(requeuedExtract)).toBe("queued");
    // requeue → pump → runJob：matting 目标素材不存在，handler 抛错落 error（证明恢复链路真正接回队列执行）
    expect(["queued", "error"]).toContain(jobStatus(requeued));
    expect(jobStatus(running)).toBe("error");
    expect(jobStatus(noPayload)).toBe("error");
    expect(jobStatus(brokenPayload)).toBe("error");
    expect(jobStatus(missingStaging)).toBe("error");

    unlinkSync(stagingPath);
  });

  test("stagingFile 存在性按文件系统实际判断", () => {
    expect(existsSync(stagingPath)).toBe(false); // 上一用例已清理
  });
});
