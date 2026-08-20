import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import commonSchema from "../packages/shared/schemas/animation/v1/common.schema.json";
import motionClipV1Schema from "../packages/shared/schemas/animation/v1/motion-clip.schema.json";
import motionClipV2Schema from "../packages/shared/schemas/animation/v2/motion-clip.schema.json";
import { addMotionEvent, closeMotionLoopSeam, deleteMotionEvent, deleteMotionKeyframe, findMotionSegmentIndex, migrateMotionClipV1ToV2, multiplyMatrices, quaternionFromZRotation, reparentTransform2d, sampleMotionClip, setMotionSegmentInterpolation, transformToMatrix, upsertMotionKeyframe, validateMotionClip, zRotationFromQuaternion, type MotionClip, type MotionClipV1, type MotionClipV2, type Skeleton, type Transform } from "../packages/shared/src";

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

describe("MotionClip v2 cubic 时间曲线", () => {
  const linearClip = (): MotionClipV1 => ({
    ...clip() as MotionClipV1,
    tracks: [{ targetId: "b", property: "translation", interpolation: "linear", keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [10, 0, 0] }] }],
  });

  test("v1 保持原语义并拒绝 v2 字段", () => {
    const invalid = structuredClone(linearClip()) as unknown as Record<string, unknown>;
    const track = (invalid.tracks as Array<Record<string, unknown>>)[0]!;
    track.interpolation = "cubic-bezier";
    (track.keyframes as Array<Record<string, unknown>>)[0]!.outInterpolation = { type: "linear" };
    expect(validateMotionClip(invalid, skeleton).ok).toBeFalse();
  });

  test("v1/v2 JSON schema 分别接受自己的格式并交叉拒绝", () => {
    const migrated = migrateMotionClipV1ToV2(linearClip());
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(commonSchema);
    const validateV1 = ajv.compile(motionClipV1Schema), validateV2 = ajv.compile(motionClipV2Schema);
    expect(validateV1(linearClip())).toBeTrue();
    expect(validateV1(migrated)).toBeFalse();
    expect(validateV2(migrated)).toBeTrue();
    expect(validateV2(linearClip())).toBeFalse();
  });

  test("显式迁移无损，读取和采样不会改写 v1", () => {
    const source = linearClip(), before = structuredClone(source);
    const migrated = migrateMotionClipV1ToV2(source);
    expect(source).toEqual(before);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.tracks[0]!.keyframes.map((key) => key.outInterpolation)).toEqual([{ type: "linear" }, null]);
    for (const time of [0, .25, 1, 1.75, 2]) {
      expect(sampleMotionClip(migrated, skeleton, time).local.b!.translation).toEqual(sampleMotionClip(source, skeleton, time).local.b!.translation);
    }
  });

  test("cubic-bezier 对 Vec3 lerp 与四元数 slerp 使用同一有界时间量", () => {
    const curve = { type: "cubic-bezier" as const, x1: 0, y1: 0, x2: 1, y2: 0 };
    let value = setMotionSegmentInterpolation(linearClip(), "b", "translation", 0, curve) as MotionClipV2;
    expect(validateMotionClip(value, skeleton).ok).toBeTrue();
    expect(sampleMotionClip(value, skeleton, 1).local.b!.translation[0]).toBeCloseTo(1.25, 8);
    expect(sampleMotionClip(value, skeleton, 0).local.b!.translation[0]).toBe(0);
    expect(sampleMotionClip(value, skeleton, 2).local.b!.translation[0]).toBe(10);

    value = { ...value, tracks: [{ targetId: "b", property: "rotation", keyframes: [{ time: 0, value: quaternionFromZRotation(0), outInterpolation: curve }, { time: 2, value: quaternionFromZRotation(Math.PI / 2), outInterpolation: null }] }] };
    expect(zRotationFromQuaternion(sampleMotionClip(value, skeleton, 1).local.b!.rotation)).toBeCloseTo(Math.PI / 16, 8);
  });

  test("校验控制点与末尾 null，并在插入删除时维持片段归属", () => {
    const curve = { type: "cubic-bezier" as const, x1: .2, y1: .3, x2: .7, y2: .8 };
    let value = setMotionSegmentInterpolation(linearClip(), "b", "translation", 0, curve) as MotionClipV2;
    value = upsertMotionKeyframe(value, "b", "translation", 1, [5, 0, 0]) as MotionClipV2;
    expect(value.tracks[0]!.keyframes.map((key) => key.outInterpolation)).toEqual([curve, curve, null]);
    value = deleteMotionKeyframe(value, "b", "translation", 2) as MotionClipV2;
    expect(value.tracks[0]!.keyframes.at(-1)!.outInterpolation).toBeNull();
    expect(validateMotionClip(value, skeleton).ok).toBeTrue();

    const invalid = structuredClone(value);
    invalid.tracks[0]!.keyframes[0]!.outInterpolation = { ...curve, x1: 2 };
    expect(validateMotionClip(invalid, skeleton).ok).toBeFalse();
    invalid.tracks[0]!.keyframes[0]!.outInterpolation = null;
    expect(validateMotionClip(invalid, skeleton).ok).toBeFalse();
  });

  test("片段定位在末尾禁用，并且采样严格服从 clip 版本", () => {
    expect(findMotionSegmentIndex([{ time: 0 }, { time: 1 }], 0)).toBe(0);
    expect(findMotionSegmentIndex([{ time: 0 }, { time: 1 }], 1)).toBe(-1);
    expect(findMotionSegmentIndex([{ time: 0 }], 0)).toBe(-1);
    const malformed = {
      ...migrateMotionClipV1ToV2(linearClip()),
      tracks: [{ targetId: "b", property: "translation", interpolation: "linear", keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [1, 0, 0], outInterpolation: null }] }],
    } as unknown as MotionClip;
    expect(validateMotionClip(malformed, skeleton).ok).toBeFalse();
    expect(() => sampleMotionClip(malformed, skeleton, 1)).toThrow("缺少片段插值");
  });
});

describe("自由变形 warp 轨道", () => {
  // 3×3 网格的自描述 value：[列数, 行数, 之后 18 个行优先位移分量]
  const warpA = [3, 3, ...new Array<number>(18).fill(0)];
  const warpB = [3, 3, ...new Array<number>(18).fill(.4)];

  test("step 插值取片段起始值，采样还原 grid 与 points", () => {
    let value = upsertMotionKeyframe(clip(), "att:part", "warp", 1, warpB);
    value = upsertMotionKeyframe(value, "att:part", "warp", 0, warpA);
    value.tracks[0]!.interpolation = "step";
    expect(validateMotionClip(value, skeleton).ok).toBe(true);
    const warp = sampleMotionClip(value, skeleton, .5).attachmentOffsets.part!.deformWarp!;
    expect(warp.grid).toEqual([3, 3]);
    expect(warp.points).toEqual(new Array<number>(18).fill(0));
  });

  test("linear 中点逐元素插值", () => {
    let value = upsertMotionKeyframe(clip(), "att:part", "warp", 0, warpA);
    value = upsertMotionKeyframe(value, "att:part", "warp", 2, warpB);
    const warp = sampleMotionClip(value, skeleton, 1).attachmentOffsets.part!.deformWarp!;
    expect(warp.grid).toEqual([3, 3]);
    expect(warp.points).toEqual(new Array<number>(18).fill(.2));
  });

  test("校验拒绝骨骼目标的 warp 轨道", () => {
    const value = upsertMotionKeyframe(clip(), "b", "warp", 0, warpA);
    expect(validateMotionClip(value, skeleton).ok).toBe(false);
  });

  test.each([
    // 头声明 3×3 需要 20 个数，这里只有 6 个，长度不自洽
    ["value 长度不自洽", [{ time: 0, value: [3, 3, 0, 0, 0, 0] }]],
    // 两条 key 各自自洽（3×3 与 2×2），但同轨道长度不一致
    ["keyframe 长度不一致", [{ time: 0, value: warpA }, { time: 1, value: [2, 2, ...new Array<number>(8).fill(0)] }]],
    // 位移分量超出 [-4, 4]
    ["位移超出范围", [{ time: 0, value: [2, 2, 5, ...new Array<number>(7).fill(0)] }]],
  ])("校验拒绝非法 warp 轨道：%s", (_, keyframes) => {
    const value: MotionClip = { ...clip(), tracks: [{ targetId: "att:part", property: "warp", interpolation: "linear", keyframes }] };
    expect(validateMotionClip(value, skeleton).ok).toBe(false);
  });
});
