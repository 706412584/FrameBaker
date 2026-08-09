import { describe, expect, test } from "bun:test";
import { addMotionEvent, closeMotionLoopSeam, deleteMotionEvent, deleteMotionKeyframe, multiplyMatrices, quaternionFromZRotation, reparentTransform2d, sampleMotionClip, transformToMatrix, upsertMotionKeyframe, validateMotionClip, zRotationFromQuaternion, type MotionClip, type Skeleton, type Transform } from "../packages/shared/src";

const skeleton: Skeleton = { schemaVersion: 1, kind: "skeleton", id: "s", name: "S", coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" }, bones: [{ id: "b", name: "Bone", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] };
const clip = (): MotionClip => ({ schemaVersion: 1, kind: "motion-clip", id: "c", name: "C", skeletonId: "s", duration: 2, loop: false, tracks: [], events: [] });

describe("连续时间轨道编辑", () => {
  test("插入后排序，并在接近时间覆盖且沿用插值", () => {
    let value = upsertMotionKeyframe(clip(), "b", "translation", 1, [1, 0, 0]);
    value = upsertMotionKeyframe(value, "b", "translation", 0, [0, 0, 0]);
    value.tracks[0]!.interpolation = "step";
    value = upsertMotionKeyframe(value, "b", "translation", 1.00005, [2, 0, 0]);
    expect(value.tracks[0]!.interpolation).toBe("step");
    expect(value.tracks[0]!.keyframes.map((key) => key.time)).toEqual([0, 1.00005]);
    expect(value.tracks[0]!.keyframes[1]!.value).toEqual([2, 0, 0]);
  });

  test("删除最后一个 key 时移除空轨道", () => {
    const value = upsertMotionKeyframe(clip(), "b", "scale", 0.5, [2, 2, 1]);
    expect(deleteMotionKeyframe(value, "b", ["translation", "rotation", "scale"], 0.5).tracks).toEqual([]);
  });

  test("Z 角度写入规范四元数并可采样往返", () => {
    const angle = 135 * Math.PI / 180;
    const value = upsertMotionKeyframe(clip(), "b", "rotation", 0, quaternionFromZRotation(angle));
    const sampled = sampleMotionClip(value, skeleton, 0).local.b!.rotation;
    expect(Math.hypot(...sampled)).toBeCloseTo(1, 10);
    expect(zRotationFromQuaternion(sampled)).toBeCloseTo(angle, 10);
  });

  test("附件更换父骨骼时保持二维世界变换", () => {
    const oldParent: Transform = { translation: [3, -2, 0], rotation: quaternionFromZRotation(Math.PI / 6), scale: [1.5, 1.5, 1] };
    const newParent: Transform = { translation: [-4, 5, 0], rotation: quaternionFromZRotation(-Math.PI / 4), scale: [.75, .75, 1] };
    const attachment: Transform = { translation: [2, 1, 0], rotation: quaternionFromZRotation(Math.PI / 8), scale: [1.2, .8, 1] };
    const before = multiplyMatrices(transformToMatrix(oldParent), transformToMatrix(attachment));
    const reparented = reparentTransform2d(attachment, transformToMatrix(oldParent), transformToMatrix(newParent));
    const after = multiplyMatrices(transformToMatrix(newParent), transformToMatrix(reparented));
    for (const index of [0, 1, 4, 5, 12, 13]) expect(after[index]).toBeCloseTo(before[index]!, 10);
  });

  test("事件添加会 trim 并按时间排序，删除使用排序后的明确索引", () => {
    let value = addMotionEvent(clip(), { time: 1.5, type: " marker ", name: " end " });
    value = addMotionEvent(value, { time: 0.25, type: "sound", name: "start", payload: { volume: 1 } });
    expect(value.events.map((event) => [event.time, event.type, event.name])).toEqual([[0.25, "sound", "start"], [1.5, "marker", "end"]]);
    value = deleteMotionEvent(value, 0);
    expect(value.events).toEqual([{ time: 1.5, type: "marker", name: "end" }]);
    expect(validateMotionClip(value, skeleton).ok).toBe(true);
    expect(() => addMotionEvent({ ...clip(), loop: true }, { time: 2, type: "marker", name: "seam" })).toThrow("事件时间超出动作范围");
  });

  test("循环接缝在 duration 写入 t=0 值并保留插值", () => {
    let value = upsertMotionKeyframe({ ...clip(), loop: true }, "b", "translation", 0, [1, 2, 3]);
    value = upsertMotionKeyframe(value, "b", "translation", 1, [9, 8, 7]);
    value.tracks[0]!.interpolation = "step";
    value = closeMotionLoopSeam(value, skeleton);
    const track = value.tracks[0]!;
    expect(track.interpolation).toBe("step");
    expect(track.keyframes.at(-1)).toEqual({ time: 2, value: [1, 2, 3] });
    expect(track.keyframes[0]!.value).toEqual(track.keyframes.at(-1)!.value);
    expect(validateMotionClip(value, skeleton).ok).toBe(true);
    expect(closeMotionLoopSeam({ ...value, loop: false }, skeleton).tracks).toBe(value.tracks);
  });
});
