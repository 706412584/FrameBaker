import { describe, expect, test } from "bun:test";
import { deleteMotionKeyframe, quaternionFromZRotation, sampleMotionClip, upsertMotionKeyframe, zRotationFromQuaternion, type MotionClip, type Skeleton } from "../packages/shared/src";

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
});
