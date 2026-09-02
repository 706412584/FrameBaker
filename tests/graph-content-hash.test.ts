import { describe, expect, test } from "bun:test";
import { canonicalJson, materialHash, nodeHash } from "../apps/server/src/graph/contentHash";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("graph contentHash", () => {
  test("同参同 hash", () => {
    const a = nodeHash("extract.frames", { fps: 12 }, { video: "abc" });
    const b = nodeHash("extract.frames", { fps: 12 }, { video: "abc" });
    expect(a).toBe(b);
  });

  test("params 键顺序无关（canonical json）", () => {
    const a = nodeHash("matte.batch", { model: "u2net", threshold: 42 }, {});
    const b = nodeHash("matte.batch", { threshold: 42, model: "u2net" }, {});
    expect(a).toBe(b);
  });

  test("嵌套对象的键顺序也无关", () => {
    const a = nodeHash("n", { outer: { b: 1, a: [2, { y: 1, x: 1 }] } }, {});
    const b = nodeHash("n", { outer: { a: [2, { x: 1, y: 1 }], b: 1 } }, {});
    expect(a).toBe(b);
  });

  test("上游 hash 变则结果变", () => {
    const a = nodeHash("matte.batch", {}, { images: "aaa" });
    const b = nodeHash("matte.batch", {}, { images: "bbb" });
    expect(a).not.toBe(b);
  });

  test("上游多端口拼接顺序无关（内部已按端口名排序）", () => {
    const a = nodeHash("slice.ui.crop", {}, { image: "i1", rects: "r1" });
    const b = nodeHash("slice.ui.crop", {}, { rects: "r1", image: "i1" });
    expect(a).toBe(b);
  });

  test("不同 node_type 不碰撞", () => {
    const a = nodeHash("matte.chroma", { x: 1 }, {});
    const b = nodeHash("matte.luma", { x: 1 }, {});
    expect(a).not.toBe(b);
  });

  test("params 不同则 hash 不同", () => {
    expect(nodeHash("n", { fps: 12 }, {})).not.toBe(nodeHash("n", { fps: 24 }, {}));
  });

  test("materialHash 用 size+mtime：内容追加后变化", () => {
    const dir = join("storage", "staging", "hash-test");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "probe.bin");
    writeFileSync(file, "v1");
    const h1 = materialHash("m1", file);
    const h2 = materialHash("m1", file);
    expect(h1).toBe(h2); // 未变则稳定
    writeFileSync(file, "v2-longer-content"); // size 变
    expect(materialHash("m1", file)).not.toBe(h1);
    expect(materialHash("m2", file)).not.toBe(materialHash("m1", file)); // 不同素材不碰撞
  });

  test("materialHash 路径缺失不抛异常", () => {
    expect(materialHash("m1", null)).toBe(materialHash("m1", null));
    expect(typeof materialHash("m1", null)).toBe("string");
  });

  test("canonicalJson 基本形态", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([3, { z: 1, a: 2 }])).toBe('[3,{"a":2,"z":1}]');
    expect(canonicalJson(null)).toBe("null");
  });
});
