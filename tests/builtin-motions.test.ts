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

describe("最早六组内置骨骼动作", () => {
  test("目录严格固定为最早六组，不混入后加的 jump", () => {
    expect(BUILTIN_MOTION_IDS).toEqual(["idle", "walk", "run", "attack", "hurt", "death"]);
    expect(BUILTIN_MOTION_IDS.map((id) => BUILTIN_MOTIONS[id].frames.length)).toEqual([12, 12, 12, 16, 8, 16]);
  });

  test("稳定骨架和六个动作全部通过通用动画 schema", () => {
    const skeleton = createBuiltinHumanoidSkeleton();
    expect(validateSkeleton(skeleton).ok).toBeTrue();
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

  test("每个原始采样的通用 FK 骨端与最早标量 FK 完全一致", () => {
    const skeleton = createBuiltinHumanoidSkeleton();
    for (const id of BUILTIN_MOTION_IDS) {
      const clip = createBuiltinMotionClip(id);
      BUILTIN_MOTIONS[id].frames.forEach((frame, index) => {
        const legacy = legacyForward(frame);
        const pose = sampleMotionClip(clip, skeleton, index / 12);
        expect(pose.local[BUILTIN_HUMANOID_ROOT_ID]!.translation[0]).toBeCloseTo(frame[0]!, 10);
        expect(pose.local[BUILTIN_HUMANOID_ROOT_ID]!.translation[1]).toBeCloseTo(-frame[1]!, 10);
        expect(pose.local[BUILTIN_HUMANOID_ROOT_ID]!.translation[2]).toBe(0);
        for (const bone of BUILTIN_HUMANOID_RIG) {
          const point = bone.length
            ? getBoneEndpoint(pose, skeleton, BUILTIN_HUMANOID_BONE_IDS[bone.id])
            : pose.worldMatrices[BUILTIN_HUMANOID_BONE_IDS[bone.id]]!.slice(12, 15);
          expectPoint(point, legacy[bone.id]!);
        }
      });
    }
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
