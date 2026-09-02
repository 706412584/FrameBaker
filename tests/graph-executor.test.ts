import { describe, expect, test } from "bun:test";
import { topoSort, computeNodeHashes } from "../apps/server/src/graph/executor";
import type { GraphEdge, GraphNode } from "@framebaker/shared";

const node = (id: string, type: string): GraphNode => ({
  id, graph_id: "g", type, params: {}, x: 0, y: 0,
});
const edge = (from: string, fromPort: string, to: string, toPort: string): GraphEdge => ({
  id: `${from}-${to}`, graph_id: "g", from_node: from, from_port: fromPort, to_node: to, to_port: toPort,
});

describe("graph executor", () => {
  test("topoSort 线性链保序", () => {
    const nodes = [node("a", "material.video"), node("b", "extract.frames"), node("c", "matte.batch")];
    const edges = [edge("a", "video", "b", "video"), edge("b", "images", "c", "images")];
    expect(topoSort(nodes, edges)).toEqual(["a", "b", "c"]);
  });

  test("topoSort 分支：无依赖节点都在依赖者之前", () => {
    const nodes = [node("a", "material.video"), node("b", "material.video"), node("c", "extract.frames"), node("d", "matte.batch")];
    // c 依赖 a，d 依赖 b 和 c
    const edges = [edge("a", "video", "c", "video"), edge("b", "images", "d", "images"), edge("c", "images", "d", "images")];
    const order = topoSort(nodes, edges);
    const pos = (id: string) => order.indexOf(id);
    expect(pos("a")).toBeLessThan(pos("c"));
    expect(pos("b")).toBeLessThan(pos("d"));
    expect(pos("c")).toBeLessThan(pos("d"));
    expect(order.length).toBe(4);
  });

  test("topoSort 环检测", () => {
    const nodes = [node("a", "matte.batch"), node("b", "matte.batch")];
    const edges = [edge("a", "images", "b", "images"), edge("b", "images", "a", "images")];
    expect(() => topoSort(nodes, edges)).toThrow("环");
  });

  test("computeNodeHashes：上游变化传播到下游", () => {
    const mkGraph = (fps: number) => {
      const a: GraphNode = { ...node("a", "material.video"), params: { materialId: "m-test" } };
      const b: GraphNode = { ...node("b", "extract.frames"), params: { fps } };
      const c = node("c", "matte.batch");
      return { nodes: [a, b, c], edges: [edge("a", "video", "b", "video"), edge("b", "images", "c", "images")] };
    };
    const h1 = computeNodeHashes(mkGraph(12));
    const h2 = computeNodeHashes(mkGraph(24));
    // 抽帧参数变 → 抽帧 hash 变 → 下游抠图 hash 变；源节点不受影响（素材不存在 → missing hash，稳定）
    expect(h1.get("b")!.images).not.toBe(h2.get("b")!.images);
    expect(h1.get("c")!.images).not.toBe(h2.get("c")!.images);
    expect(h1.get("a")!.video).toBe(h2.get("a")!.video);
    // 同图重算 → 稳定
    expect(computeNodeHashes(mkGraph(12))).toEqual(h1);
  });

  test("computeNodeHashes：未知节点类型抛错", () => {
    expect(() =>
      computeNodeHashes({ nodes: [node("a", "bogus.type")], edges: [] })
    ).toThrow("未知节点类型");
  });
});
