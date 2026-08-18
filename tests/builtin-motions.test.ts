import { describe, expect, test } from "bun:test";
import {
  BUILTIN_HUMANOID_BONE_IDS,
  BUILTIN_HUMANOID_RIG,
  BUILTIN_HUMANOID_ROOT_ID,
  BUILTIN_MOTIONS,
  BUILTIN_MOTION_IDS,
  MOTION_BONE_ORDER,
  createBuiltinHumanoidSkeleton,
  createBuiltinMotionClip,
  getBoneEndpoint,
  sampleMotionClip,
  validateMotionClip,
  validateSkeleton,
  type BuiltinMotionId,
} from "../packages/shared/src";

type LegacyPoint = { x: number; y: number; angle: number };

function legacyForward(frame: readonly number[]): Record<string, LegacyPoint> {
  const points: Record<string, LegacyPoint> = {};
  for (const bone of BUILTIN_HUMANOID_RIG) {
    const rotation = frame[MOTION_BONE_ORDER.indexOf(bone.id) + 2]!;
    if (!bone.parent) {
      points[bone.id] = { x: frame[0]!, y: frame[1]!, angle: bone.rest + rotation };
      continue;
    }
    const parent = points[bone.parent]!;
    const angle = parent.angle + bone.rest + rotation;
    points[bone.id] = { x: parent.x + Math.cos(angle) * bone.length, y: parent.y + Math.sin(angle) * bone.length, angle };
  }
  return points;
}

function expectPoint(actual: readonly number[] | null, expected: LegacyPoint) {
  expect(actual).not.toBeNull();
  expect(actual![0]).toBeCloseTo(expected.x, 6);
  expect(actual![1]).toBeCloseTo(-expected.y, 6);
  expect(actual![2]).toBeCloseTo(0, 6);
}

describe("内置人形骨骼与六组动作", () => {
  test("动作目录固定为产品支持的六组，不混入后加的 jump", () => {
    expect(BUILTIN_MOTION_IDS).toEqual(["idle", "walk", "run", "attack", "hurt", "death"]);
    expect(BUILTIN_MOTION_IDS.map((id) => BUILTIN_MOTIONS[id].frames.length)).toEqual([12, 12, 12, 16, 8, 16]);
  });

  test("稳定骨架和六个动作全部通过通用动画 schema", () => {
    const skeleton = createBuiltinHumanoidSkeleton();
    expect(validateSkeleton(skeleton).ok).toBeTrue();
    expect(skeleton.name).toBe("内置 · 人形骨骼");
    expect(skeleton.coordinateSystem.unit).toBe("pixel");
    expect(skeleton.bones).toHaveLength(17);
    for (const id of BUILTIN_MOTION_IDS) {
      const clip = createBuiltinMotionClip(id);
      expect(validateMotionClip(clip, skeleton).ok).toBeTrue();
      expect(clip.tracks).toHaveLength(17);
      expect(clip.tracks.some((track) => track.targetId === BUILTIN_HUMANOID_BONE_IDS.neck)).toBeTrue();
      expect(clip.loop).toBe(["idle", "walk", "run"].includes(id));
      expect(clip.duration).toBe((BUILTIN_MOTIONS[id].frames.length - (clip.loop ? 0 : 1)) / 12);
    }
  });

  test("未修正骨骼的通用 FK 骨端与基准标量 FK 完全一致", () => {
    const skeleton = createBuiltinHumanoidSkeleton();
    // 臂链带视角修正/肢体重定向，run 的颈链另有重定向；其余骨骼必须与旧标量 FK 无损一致。
    const armBones = new Set(["leftShoulder", "leftElbow", "leftWrist", "rightShoulder", "rightElbow", "rightWrist"]);
    for (const id of BUILTIN_MOTION_IDS) {
      const clip = createBuiltinMotionClip(id);
      const retargetedNeck = id === "run";
      BUILTIN_MOTIONS[id].frames.forEach((frame, index) => {
        const legacy = legacyForward(frame);
        const pose = sampleMotionClip(clip, skeleton, index / 12);
        expect(pose.local[BUILTIN_HUMANOID_ROOT_ID]!.translation[0]).toBeCloseTo(frame[0]!, 10);
        expect(pose.local[BUILTIN_HUMANOID_ROOT_ID]!.translation[1]).toBeCloseTo(-frame[1]!, 10);
        expect(pose.local[BUILTIN_HUMANOID_ROOT_ID]!.translation[2]).toBe(0);
        for (const bone of BUILTIN_HUMANOID_RIG) {
          if (armBones.has(bone.id)) continue;
          if (retargetedNeck && (bone.id === "neck" || bone.id === "head")) continue;
          const point = bone.length
            ? getBoneEndpoint(pose, skeleton, BUILTIN_HUMANOID_BONE_IDS[bone.id])
            : pose.worldMatrices[BUILTIN_HUMANOID_BONE_IDS[bone.id]]!.slice(12, 15);
          expectPoint(point, legacy[bone.id]!);
        }
      });
    }
  });

  test("重定向后的臂部姿态保持自然：静态动作前臂下垂、run 屈肘不翻转", () => {
    const skeleton = createBuiltinHumanoidSkeleton();
    const worldDirection = (pose: ReturnType<typeof sampleMotionClip>, semantic: "leftElbow" | "rightElbow") => {
      const boneId = BUILTIN_HUMANOID_BONE_IDS[semantic];
      const matrix = pose.worldMatrices[boneId]!;
      const tip = getBoneEndpoint(pose, skeleton, boneId)!;
      return Math.atan2(tip[1] - matrix[13], tip[0] - matrix[12]) * 180 / Math.PI;
    };
    const localAngle = (pose: ReturnType<typeof sampleMotionClip>, semantic: "leftElbow" | "rightElbow") => {
      const rotation = pose.local[BUILTIN_HUMANOID_BONE_IDS[semantic]]!.rotation;
      return 2 * Math.atan2(rotation[2], rotation[3]) * 180 / Math.PI;
    };
    for (const id of ["idle", "walk", "hurt"] as const) {
      const clip = createBuiltinMotionClip(id);
      BUILTIN_MOTIONS[id].frames.forEach((_, index) => {
        const pose = sampleMotionClip(clip, skeleton, index / 12);
        for (const semantic of ["leftElbow", "rightElbow"] as const) {
          const direction = worldDirection(pose, semantic);
          // 前臂应大致下垂（允许步态自然前摆），不再水平外伸。
          expect(direction).toBeGreaterThan(-140);
          expect(direction).toBeLessThan(-25);
        }
      });
    }
    const run = createBuiltinMotionClip("run");
    BUILTIN_MOTIONS.run.frames.forEach((_, index) => {
      const pose = sampleMotionClip(run, skeleton, index / 12);
      for (const semantic of ["leftElbow", "rightElbow"] as const) {
        const bend = localAngle(pose, semantic);
        // 奔跑屈肘应稳定向前弯曲，不出现反关节符号翻转。
        expect(bend).toBeGreaterThan(40);
        expect(bend).toBeLessThan(115);
      }
    });
  });

  test("循环动作显式闭合到首帧，非循环动作停在最后采样", () => {
    for (const id of BUILTIN_MOTION_IDS) {
      const clip = createBuiltinMotionClip(id as BuiltinMotionId);
      const sourceCount = BUILTIN_MOTIONS[id].frames.length;
      for (const track of clip.tracks) {
        expect(track.keyframes).toHaveLength(sourceCount + (clip.loop ? 1 : 0));
        if (clip.loop) {
          expect(track.keyframes.at(-1)!.time).toBe(clip.duration);
          expect(track.keyframes.at(-1)!.value).toEqual(track.keyframes[0]!.value);
        } else {
          expect(track.keyframes.at(-1)!.time).toBe(clip.duration);
        }
      }
    }
  });
});
