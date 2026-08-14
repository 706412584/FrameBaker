import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../apps/server/src/app";
import { db, getFrame, getMaterial, nextFrameIdx, serializeFrame, serializeMaterial, STORAGE_ROOT } from "../apps/server/src/db";
import { JobCancelledError, runCmd } from "../apps/server/src/jobs/run";
import { parseThumbnailSize, serveMediaFile } from "../apps/server/src/media";
import { clearFramePlacement } from "../apps/server/src/timeline";
import { invalidateProjectUndo, undoProject } from "../apps/server/src/undo";

function createUndoFixture() {
  const projectId = `undo-project-${crypto.randomUUID()}`;
  const axisId = crypto.randomUUID();
  const trackId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const frameId = crypto.randomUUID();
  const projectPath = join(STORAGE_ROOT, "projects", projectId);
  const rawPath = join(projectPath, "raw", `${frameId}.png`);
  mkdirSync(join(projectPath, "raw"), { recursive: true });
  mkdirSync(join(projectPath, "processed"), { recursive: true });
  writeFileSync(rawPath, "original-image");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "撤销测试", Date.now());
  db.query("INSERT INTO animation_axes (id, project_id, name, idx, fps, created_at) VALUES (?, ?, 'Test', 0, 8, ?)").run(axisId, projectId, Date.now());
  db.query("INSERT INTO animation_tracks (id, axis_id, name, idx, is_primary) VALUES (?, ?, 'Main', 0, 1)").run(trackId, axisId);
  db.query("INSERT INTO animation_steps (id, axis_id, idx, duration) VALUES (?, ?, 0, 1)").run(stepId, axisId);
  db.query("INSERT INTO frames (id, project_id, track_id, step_id, is_asset, idx, raw_path, status) VALUES (?, ?, ?, ?, 0, 0, ?, 'ready')").run(
    frameId,
    projectId,
    trackId,
    stepId,
    rawPath
  );
  return { projectId, axisId, trackId, stepId, frameId, projectPath, rawPath };
}

function cleanupUndoFixture(fixture: ReturnType<typeof createUndoFixture>) {
  invalidateProjectUndo(fixture.projectId);
  db.query("DELETE FROM attack_effects WHERE project_id=?").run(fixture.projectId);
  db.query("DELETE FROM frames WHERE project_id=?").run(fixture.projectId);
  db.query("DELETE FROM animation_steps WHERE axis_id=?").run(fixture.axisId);
  db.query("DELETE FROM animation_tracks WHERE axis_id=?").run(fixture.axisId);
  db.query("DELETE FROM animation_axes WHERE project_id=?").run(fixture.projectId);
  db.query("DELETE FROM projects WHERE id=?").run(fixture.projectId);
  rmSync(fixture.projectPath, { recursive: true, force: true });
}

function patchFrame(frameId: string, body: Record<string, unknown>) {
  return app.handle(new Request(`http://localhost/api/frames/${frameId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function undoCount(projectId: string): number {
  return (db.query("SELECT COUNT(*) count FROM project_undo WHERE project_id=?").get(projectId) as { count: number }).count;
}

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

describe("媒体响应", () => {
  test("缩略图尺寸只接受 64 到 1024 的整数", () => {
    expect(parseThumbnailSize("64")).toBe(64);
    expect(parseThumbnailSize("320")).toBe(320);
    expect(parseThumbnailSize("1024")).toBe(1024);
    for (const value of [undefined, "", "63", "1025", "64.5", " 320", "1e2"]) {
      expect(parseThumbnailSize(value)).toBeNull();
    }
  });

  test("图片支持版本化缓存与 ETag 条件请求", async () => {
    const path = `/tmp/framebaker-media-${crypto.randomUUID()}.png`;
    try {
      await Bun.write(path, "image-bytes");
      const response = serveMediaFile(path, new Request("http://localhost/image.png?v=1"), "image/png");
      const etag = response.headers.get("etag");
      expect(await response.text()).toBe("image-bytes");
      expect(etag).toBeTruthy();
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const revalidated = serveMediaFile(
        path,
        new Request("http://localhost/image.png", { headers: { "If-None-Match": etag! } }),
        "image/png"
      );
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    } finally {
      unlinkSync(path);
    }
  });
});

describe("SQLite 实体转换", () => {
  test("解析帧 JSON 字段并在损坏数据时安全回退", () => {
    const frame = serializeFrame({
      id: "frame", project_id: "project", idx: 0, raw_path: "/tmp/raw.png", processed_path: null, status: "ready", duration: 1,
      is_keyframe: 0, offset_x: 0, offset_y: 0, scale: 1, rotation: 0, opacity: 1, tags: "invalid", source: "upload", metadata: "{bad",
      attack_effect: '{"strokes":[],"offset_x":1,"offset_y":2,"scale":1,"rotation":0,"opacity":1}',
    });
    expect(frame.tags).toEqual([]);
    expect(frame.metadata).toEqual({});
    expect(frame.attack_effect?.offset_y).toBe(2);
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

describe("时间轴单元格", () => {
  test("空图片单元格可创建、读取、删除并撤销独立攻击特效", async () => {
    const fixture = createUndoFixture();
    const effect = {
      strokes: [{ color: "#ff8a18", size: 24, brush: "dry", points: [
        { x: -20, y: 8, pressure: 0.2 },
        { x: 0, y: -12, pressure: 1 },
        { x: 24, y: 4, pressure: 0.2 },
      ] }],
      offset_x: 3,
      offset_y: -2,
      scale: 1,
      rotation: 0,
      opacity: 1,
      style: "flame",
    };
    try {
      clearFramePlacement(fixture.frameId);
      const url = `http://localhost/api/tracks/${fixture.trackId}/steps/${fixture.stepId}/effect`;
      const created = await app.handle(new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(effect),
      }));
      expect(created.status).toBe(200);

      const timeline = await app.handle(new Request(`http://localhost/api/projects/${fixture.projectId}/timeline`));
      const body = await timeline.json() as { frames: unknown[]; effects: Array<{ track_id: string; step_id: string; effect: typeof effect }> };
      expect(body.frames).toHaveLength(0);
      expect(body.effects).toHaveLength(1);
      expect(body.effects[0]).toMatchObject({ track_id: fixture.trackId, step_id: fixture.stepId, effect: { style: "flame", offset_x: 3, strokes: [{ brush: "dry" }] } });

      expect((await app.handle(new Request(url, { method: "DELETE" }))).status).toBe(200);
      expect(db.query("SELECT id FROM attack_effects WHERE project_id=?").get(fixture.projectId)).toBeNull();
      expect(await undoProject(fixture.projectId)).toBeTrue();
      expect(db.query("SELECT id FROM attack_effects WHERE project_id=?").get(fixture.projectId)).not.toBeNull();
    } finally {
      cleanupUndoFixture(fixture);
    }
  });

  test("清空实例帧后保留原步骤", () => {
    const projectId = `test-project-${crypto.randomUUID()}`;
    const axisId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const frameId = crypto.randomUUID();
    try {
      db.query("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "清空单元格测试", Date.now());
      db.query("INSERT INTO animation_axes (id, project_id, name, idx, fps, created_at) VALUES (?, ?, ?, 0, 8, ?)").run(axisId, projectId, "测试轴", Date.now());
      db.query("INSERT INTO animation_tracks (id, axis_id, name, idx, is_primary) VALUES (?, ?, ?, 0, 1)").run(trackId, axisId, "测试轨道");
      db.query("INSERT INTO animation_steps (id, axis_id, idx, duration) VALUES (?, ?, 0, 1)").run(stepId, axisId);
      db.query("INSERT INTO frames (id, project_id, track_id, step_id, is_asset, idx, raw_path, status) VALUES (?, ?, ?, ?, 0, 0, ?, ?)").run(
        frameId,
        projectId,
        trackId,
        stepId,
        "/tmp/frame.png",
        "ready"
      );

      expect(clearFramePlacement(frameId)?.id).toBe(frameId);
      expect(getFrame(frameId)).toBeNull();
      expect(db.query("SELECT id FROM animation_steps WHERE id = ?").get(stepId)).toEqual({ id: stepId });
    } finally {
      db.query("DELETE FROM frames WHERE project_id = ?").run(projectId);
      db.query("DELETE FROM animation_steps WHERE axis_id = ?").run(axisId);
      db.query("DELETE FROM animation_tracks WHERE axis_id = ?").run(axisId);
      db.query("DELETE FROM animation_axes WHERE project_id = ?").run(projectId);
      db.query("DELETE FROM projects WHERE id = ?").run(projectId);
    }
  });
});

describe("项目级撤销", () => {
  test("仅成功 mutation 提交历史，纯 DB 编辑不复制图片", async () => {
    const fixture = createUndoFixture();
    try {
      expect((await patchFrame(fixture.frameId, {})).status).toBe(400);
      expect(undoCount(fixture.projectId)).toBe(0);
      expect(readdirSync(join(STORAGE_ROOT, "undo", ".pending"))).toHaveLength(0);

      expect((await patchFrame(fixture.frameId, { offset_x: 12 })).status).toBe(200);
      const history = db.query("SELECT files_path FROM project_undo WHERE project_id=?").get(fixture.projectId) as { files_path: string };
      expect(history.files_path).toBe("");
      expect(getFrame(fixture.frameId)?.offset_x).toBe(12);

      const undone = await app.handle(new Request(`http://localhost/api/projects/${fixture.projectId}/undo`, { method: "POST" }));
      expect(undone.status).toBe(200);
      expect(getFrame(fixture.frameId)?.offset_x).toBe(0);
      expect(undoCount(fixture.projectId)).toBe(0);
    } finally {
      cleanupUndoFixture(fixture);
    }
  });

  test("删除帧后同时恢复数据库和图片文件", async () => {
    const fixture = createUndoFixture();
    try {
      const deleted = await app.handle(new Request(`http://localhost/api/frames/${fixture.frameId}`, { method: "DELETE" }));
      expect(deleted.status).toBe(200);
      expect(getFrame(fixture.frameId)).toBeNull();
      expect(existsSync(fixture.rawPath)).toBeFalse();
      const history = db.query("SELECT files_path FROM project_undo WHERE project_id=?").get(fixture.projectId) as { files_path: string };
      expect(history.files_path).toBeTruthy();
      expect(existsSync(history.files_path)).toBeTrue();

      expect(await undoProject(fixture.projectId)).toBeTrue();
      expect(getFrame(fixture.frameId)?.id).toBe(fixture.frameId);
      expect(readFileSync(fixture.rawPath, "utf8")).toBe("original-image");
      expect(undoCount(fixture.projectId)).toBe(0);
    } finally {
      cleanupUndoFixture(fixture);
    }
  });

  test("素材导入按 body 中的项目建立可恢复文件快照", async () => {
    const fixture = createUndoFixture();
    const materialId = crypto.randomUUID();
    const materialPath = join(STORAGE_ROOT, "materials", materialId, "raw.png");
    try {
      mkdirSync(join(STORAGE_ROOT, "materials", materialId), { recursive: true });
      writeFileSync(materialPath, "material-image");
      db.query("INSERT INTO materials (id, name, raw_path, status, source, metadata, created_at) VALUES (?, '测试素材', ?, 'raw', 'upload', '{}', ?)").run(
        materialId,
        materialPath,
        Date.now()
      );
      const imported = await app.handle(new Request(`http://localhost/api/materials/${materialId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: fixture.projectId, count: 1 }),
      }));
      expect(imported.status).toBe(200);
      expect((db.query("SELECT COUNT(*) count FROM frames WHERE project_id=?").get(fixture.projectId) as { count: number }).count).toBe(2);
      const history = db.query("SELECT files_path FROM project_undo WHERE project_id=?").get(fixture.projectId) as { files_path: string };
      expect(history.files_path).toBeTruthy();

      expect(await undoProject(fixture.projectId)).toBeTrue();
      expect((db.query("SELECT COUNT(*) count FROM frames WHERE project_id=?").get(fixture.projectId) as { count: number }).count).toBe(1);
      expect(readdirSync(join(fixture.projectPath, "raw"))).toEqual([`${fixture.frameId}.png`]);
    } finally {
      db.query("DELETE FROM materials WHERE id=?").run(materialId);
      rmSync(join(STORAGE_ROOT, "materials", materialId), { recursive: true, force: true });
      cleanupUndoFixture(fixture);
    }
  });

  test("DB 恢复失败时回滚文件并保留未消费快照", async () => {
    const fixture = createUndoFixture();
    try {
      expect((await app.handle(new Request(`http://localhost/api/frames/${fixture.frameId}`, { method: "DELETE" }))).status).toBe(200);
      const item = db.query("SELECT id,snapshot,files_path FROM project_undo WHERE project_id=?").get(fixture.projectId) as { id: string; snapshot: string; files_path: string };
      const snapshot = JSON.parse(item.snapshot) as { tables: { frames: Array<Record<string, unknown>> } };
      snapshot.tables.frames.push({ ...snapshot.tables.frames[0] });
      db.query("UPDATE project_undo SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), item.id);
      const marker = join(fixture.projectPath, "current-state.txt");
      writeFileSync(marker, "post-delete");

      await expect(undoProject(fixture.projectId)).rejects.toThrow();
      expect(getFrame(fixture.frameId)).toBeNull();
      expect(existsSync(fixture.rawPath)).toBeFalse();
      expect(readFileSync(marker, "utf8")).toBe("post-delete");
      expect(undoCount(fixture.projectId)).toBe(1);
      expect(existsSync(item.files_path)).toBeTrue();
    } finally {
      cleanupUndoFixture(fixture);
    }
  });

  test("外部 mutation 会使旧历史失效", async () => {
    const fixture = createUndoFixture();
    try {
      expect((await patchFrame(fixture.frameId, { opacity: 0.5 })).status).toBe(200);
      expect(undoCount(fixture.projectId)).toBe(1);
      invalidateProjectUndo(fixture.projectId);
      expect(undoCount(fixture.projectId)).toBe(0);
      expect(await undoProject(fixture.projectId)).toBeFalse();
    } finally {
      cleanupUndoFixture(fixture);
    }
  });

  test("同项目并发编辑按顺序形成历史，不同项目互不影响", async () => {
    const first = createUndoFixture();
    const second = createUndoFixture();
    try {
      const responses = await Promise.all([
        patchFrame(first.frameId, { offset_x: 1 }),
        patchFrame(first.frameId, { offset_x: 2 }),
        patchFrame(second.frameId, { offset_x: 9 }),
      ]);
      expect(responses.every((response) => response.status === 200)).toBeTrue();
      expect(undoCount(first.projectId)).toBe(2);
      expect(undoCount(second.projectId)).toBe(1);

      expect(await undoProject(first.projectId)).toBeTrue();
      expect(getFrame(first.frameId)?.offset_x).not.toBe(0);
      expect(getFrame(second.frameId)?.offset_x).toBe(9);
      expect(await undoProject(first.projectId)).toBeTrue();
      expect(getFrame(first.frameId)?.offset_x).toBe(0);
    } finally {
      cleanupUndoFixture(first);
      cleanupUndoFixture(second);
    }
  });

  test("每个项目最多保留 50 条历史", async () => {
    const fixture = createUndoFixture();
    try {
      for (let i = 1; i <= 51; i++) {
        expect((await patchFrame(fixture.frameId, { offset_x: i })).status).toBe(200);
      }
      expect(undoCount(fixture.projectId)).toBe(50);
    } finally {
      cleanupUndoFixture(fixture);
    }
  });
});
