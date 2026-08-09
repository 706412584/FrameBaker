import { describe, expect, test } from "bun:test";
import { sortImportFiles } from "../apps/web/src/hooks/useImportWorkflow";

describe("多文件导入顺序", () => {
  test("按文件名自然升序排列数字帧", () => {
    const files = ["run_12.png", "run_2.png", "run_1.png"].map((name) => new File([], name));
    expect(sortImportFiles(files).map((file) => file.name)).toEqual(["run_1.png", "run_2.png", "run_12.png"]);
  });
});