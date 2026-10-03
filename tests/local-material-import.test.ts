import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, STORAGE_ROOT, serializeMaterial } from "../apps/server/src/db";
import type { MaterialRow } from "@framebaker/shared";
import {
  importLocalFileToLibrary,
  importLocalPathToLibrary,
  isSupportedLocalAsset,
  localAssetKind,
} from "../apps/server/src/materialImport";

/** 每个用例自建隔离的源目录与素材，结束后按 id 清理 DB 行 + storage 目录。 */
const createdMaterialIds: string[] = [];
const createdSourceDirs: string[] = [];

function tempSourceDir(): string {
  const dir = join(STORAGE_ROOT, `test-local-import-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  createdSourceDirs.push(dir);
  return dir;
}

function track(materialId: string): string {
  createdMaterialIds.push(materialId);
  return materialId;
}

function materialRow(id: string): MaterialRow | null {
  return (db.query("SELECT * FROM materials WHERE id = ?").get(id) as MaterialRow | null) ?? null;
}

function cleanup() {
  for (const id of createdMaterialIds) {
    db.query("DELETE FROM materials WHERE id = ?").run(id);
    rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
  }
  for (const dir of createdSourceDirs) rmSync(dir, { recursive: true, force: true });
  createdMaterialIds.length = 0;
  createdSourceDirs.length = 0;
}

describe("本地素材导入 — 扩展名判定", () => {
  test("图片/视频扩展名受支持，其余拒绝", () => {
    expect(isSupportedLocalAsset("a.png")).toBe(true);
    expect(isSupportedLocalAsset("a.MP4")).toBe(true); // 大小写不敏感
    expect(isSupportedLocalAsset("a.psd")).toBe(true);
    expect(isSupportedLocalAsset("a.txt")).toBe(false);
    expect(isSupportedLocalAsset("noext")).toBe(false);
  });

  test("kind 按扩展名推断（与 serializeMaterial 同规则）", () => {
    expect(localAssetKind("walk.mp4")).toBe("video");
    expect(localAssetKind("walk.MOV")).toBe("video");
    expect(localAssetKind("frame_0001.png")).toBe("image");
  });
});

describe("本地素材导入 — 单文件", () => {
  test("登记为 source=file 的素材，文件拷进 storage 且可反查", () => {
    const dir = tempSourceDir();
    const src = join(dir, "cgt-wolf.mp4");
    writeFileSync(src, "not-a-real-video-but-copied-verbatim");

    const imported = importLocalFileToLibrary(src);
    track(imported.id);

    expect(imported.kind).toBe("video");
    expect(imported.source).toBe("file");
    expect(imported.name).toBe("cgt-wolf");
    expect(existsSync(imported.raw_path)).toBe(true);

    const row = materialRow(imported.id);
    expect(row).not.toBeNull();
    expect(row!.source).toBe("file");
    expect(row!.status).toBe("raw");
    expect(row!.processed_path).toBeNull();
    // serializeMaterial 依据 raw 路径推断 kind=video（material.video 节点可消费）
    expect(serializeMaterial(row!).kind).toBe("video");
    expect(JSON.parse(row!.metadata).localFile).toBe("cgt-wolf.mp4");
  });

  test("name 覆盖生效；缺省用文件名去扩展名", () => {
    const dir = tempSourceDir();
    const src = join(dir, "frame_0007.png");
    writeFileSync(src, "png-bytes");

    const imported = importLocalFileToLibrary(src, { name: "青狼 抽帧 7" });
    track(imported.id);
    expect(imported.name).toBe("青狼 抽帧 7");
    expect(materialRow(imported.id)!.name).toBe("青狼 抽帧 7");
  });

  test("不支持的扩展名抛错且不落库", () => {
    const dir = tempSourceDir();
    const src = join(dir, "notes.txt");
    writeFileSync(src, "hello");
    const before = (db.query("SELECT COUNT(*) n FROM materials").get() as { n: number }).n;
    expect(() => importLocalFileToLibrary(src)).toThrow(/不支持的素材类型/);
    // 抛错后 DB 无新增、storage/materials 下无新目录
    expect((db.query("SELECT COUNT(*) n FROM materials").get() as { n: number }).n).toBe(before);
  });

  test("路径不存在抛错", () => {
    expect(() => importLocalFileToLibrary(join(STORAGE_ROOT, "definitely-missing.png"))).toThrow(/路径不存在|文件不存在/);
  });
});

describe("本地素材导入 — 目录批量", () => {
  test("导入目录内全部受支持文件，按文件名自然序，跳过不支持类型与子目录", () => {
    const dir = tempSourceDir();
    writeFileSync(join(dir, "run10.png"), "a");
    writeFileSync(join(dir, "run2.png"), "b");
    writeFileSync(join(dir, "run1.png"), "c");
    writeFileSync(join(dir, "readme.txt"), "skip me");
    mkdirSync(join(dir, "nested")); // 当前不递归：子目录应出现在 skipped

    const result = importLocalPathToLibrary(dir);
    for (const m of result.materials) track(m.id);

    // 自然序：run1 < run2 < run10（不是字典序 run1 < run10 < run2）
    expect(result.materials.map((m) => m.name)).toEqual(["run1", "run2", "run10"]);
    expect(result.materials.every((m) => m.source === "file" && m.kind === "image")).toBe(true);
    expect(result.skipped.sort()).toEqual(["nested/", "readme.txt"]);
    expect(result.failed).toEqual([]);
    // 每个素材的文件都真实落盘
    for (const m of result.materials) expect(existsSync(m.raw_path)).toBe(true);
  });

  test("目录内无受支持文件时抛错", () => {
    const dir = tempSourceDir();
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(() => importLocalPathToLibrary(dir)).toThrow(/没有可导入/);
  });

  test("与素材同名同扩展名的子目录被跳过而非崩溃", () => {
    const dir = tempSourceDir();
    writeFileSync(join(dir, "ok1.png"), "a");
    mkdirSync(join(dir, "trap.png")); // 名字像图片，实为目录

    const result = importLocalPathToLibrary(dir);
    for (const m of result.materials) track(m.id);

    expect(result.materials.map((m) => m.name)).toEqual(["ok1"]);
    expect(result.skipped).toEqual(["trap.png/"]);
    expect(result.failed).toEqual([]);
  });
});

describe("本地素材导入 — 符号链接拒绝", () => {
  test("symlink 被拒绝（避免绕过扩展名白名单）", () => {
    const dir = tempSourceDir();
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "sensitive");
    const link = join(dir, "disguised.png");
    try {
      symlinkSync(secret, link);
    } catch {
      return; // Windows 无开发者模式/管理员权限时无法建 symlink，跳过
    }
    expect(() => importLocalFileToLibrary(link)).toThrow(/符号链接/);
  });
});

// 无论用例是否中断都清理，避免污染开发库
afterAll(() => {
  cleanup();
  expect(createdMaterialIds.length).toBe(0);
});
