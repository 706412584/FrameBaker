import { describe, expect, test } from "bun:test";
import { db, getFrame, getMaterial, nextFrameIdx, serializeFrame, serializeMaterial } from "../apps/server/src/db";
import { JobCancelledError, runCmd } from "../apps/server/src/jobs/run";

describe("外部命令执行器", () => {
  test("成功命令正常结束", async () => {
    await expect(runCmd(["/usr/bin/true"])).resolves.toBeUndefined();
  });

  test("非零退出携带 stderr 上下文", async () => {
    await expect(runCmd(["/bin/sh", "-c", "echo command-failed >&2; exit 7"])).rejects.toThrow("命令执行失败 (/bin/sh): command-failed");
  });

  test("已取消的任务不会启动进程", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCmd(["/usr/bin/false"], undefined, controller.signal)).rejects.toBeInstanceOf(JobCancelledError);
  });
});

describe("SQLite 实体转换", () => {
  test("解析帧 JSON 字段并在损坏数据时安全回退", () => {
    const frame = serializeFrame({
      id: "frame", project_id: "project", idx: 0, raw_path: "/tmp/raw.png", processed_path: null, status: "ready", duration: 1,
      is_keyframe: 0, offset_x: 0, offset_y: 0, scale: 1, rotation: 0, opacity: 1, tags: "invalid", source: "upload", metadata: "{bad",
    });
    expect(frame.tags).toEqual([]);
    expect(frame.metadata).toEqual({});
  });

  test("素材按扩展名推断媒体类型，并优先使用原始路径", () => {
    expect(serializeMaterial({
      id: "video", name: "视频", raw_path: "/tmp/demo.MP4", processed_path: "/tmp/demo.png", status: "raw", source: "upload", folder_id: null, metadata: "{}", created_at: 1,
    }).kind).toBe("video");
    expect(serializeMaterial({
      id: "image", name: "图片", raw_path: null, processed_path: "/tmp/matted.png", status: "matted", source: "upload", folder_id: null, metadata: '{"ok":true}', created_at: 1,
    })).toMatchObject({ kind: "image", metadata: { ok: true } });
  });

  test("读取实体和下一帧序号使用项目范围", () => {
    const projectId = `test-project-${crypto.randomUUID()}`;
    const frameId = crypto.randomUUID();
    const materialId = crypto.randomUUID();
    try {
      db.query("INSERT INTO frames (id, project_id, idx, raw_path, status) VALUES (?, ?, ?, ?, ?)").run(frameId, projectId, 4, "/tmp/frame.png", "ready");
      db.query("INSERT INTO materials (id, name, raw_path, status, created_at) VALUES (?, ?, ?, ?, ?)").run(materialId, "素材", "/tmp/material.png", "raw", Date.now());
      expect(getFrame(frameId)?.id).toBe(frameId);
      expect(getMaterial(materialId)?.id).toBe(materialId);
      expect(nextFrameIdx(projectId)).toBe(5);
      expect(nextFrameIdx(`empty-${projectId}`)).toBe(0);
    } finally {
      db.query("DELETE FROM frames WHERE id = ?").run(frameId);
      db.query("DELETE FROM materials WHERE id = ?").run(materialId);
    }
  });
});
