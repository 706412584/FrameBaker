import { describe, expect, test } from "bun:test";
import type { MaterialRow } from "@framebaker/shared";
import { sortMaterialsByFrameNumber } from "../apps/server/src/api/materials";

function material(name: string, createdAt: number): MaterialRow {
  return {
    id: name,
    name,
    raw_path: null,
    processed_path: null,
    status: "raw",
    source: "extract",
    folder_id: null,
    metadata: "{}",
    created_at: createdAt,
  };
}

describe("素材导入顺序", () => {
  test("忽略选择顺序并按帧编号自然升序排列", () => {
    const selected = [material("run #120", 1), material("run #10", 2), material("run #2", 3), material("run #1", 4)];
    expect(sortMaterialsByFrameNumber(selected).map((item) => item.name)).toEqual([
      "run #1",
      "run #2",
      "run #10",
      "run #120",
    ]);
  });
});