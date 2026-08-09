import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skeletalProjectsApi } from "../apps/server/src/api/skeletalProjects";
import { db } from "../apps/server/src/db";

const skeletalId = `test-skeletal-${crypto.randomUUID()}`;
const frameId = `test-frame-${crypto.randomUUID()}`;

const request = (projectId: string, method = "GET", body?: unknown) => skeletalProjectsApi.handle(new Request(`http://localhost/api/projects/${projectId}/skeletal-document`, {
  method,
  headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe("骨骼项目文档 API", () => {
  beforeAll(() => {
    db.query("INSERT INTO projects (id, name, kind, created_at) VALUES (?, ?, 'skeletal', ?)").run(skeletalId, "test skeletal", Date.now());
    db.query("INSERT INTO projects (id, name, kind, created_at) VALUES (?, ?, 'frame', ?)").run(frameId, "test frame", Date.now());
  });

  afterAll(() => {
    db.query("DELETE FROM skeletal_projects WHERE project_id IN (?, ?)").run(skeletalId, frameId);
    db.query("DELETE FROM projects WHERE id IN (?, ?)").run(skeletalId, frameId);
  });

  test("首次读取持久化项目内空文档", async () => {
    const response = await request(skeletalId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: { schemaVersion: 1, projectId: skeletalId, character: null, animations: [], activeAnimationId: null } });
    expect(db.query("SELECT project_id FROM skeletal_projects WHERE project_id = ?").get(skeletalId)).toBeTruthy();
  });

  test("逐帧项目不能读写骨骼文档", async () => {
    expect((await request(frameId)).status).toBe(409);
    expect((await request(frameId, "PUT", { schemaVersion: 1, projectId: frameId, character: null, animations: [], activeAnimationId: null })).status).toBe(409);
  });

  test("拒绝 URL 与文档 projectId 不一致", async () => {
    const response = await request(skeletalId, "PUT", { schemaVersion: 1, projectId: frameId, character: null, animations: [], activeAnimationId: null });
    expect(response.status).toBe(400);
  });

  test("可保存并重读合法空文档", async () => {
    const document = { schemaVersion: 1 as const, projectId: skeletalId, character: null, animations: [], activeAnimationId: null };
    expect((await request(skeletalId, "PUT", document)).status).toBe(200);
    expect(await (await request(skeletalId)).json()).toEqual({ document });
  });
});
