import { describe, expect, test } from "bun:test";
import { quaternionFromZRotation, validateMotionClip, type MotionClip, type Skeleton } from "../packages/shared/src";
import { areSkeletonsRetargetCompatible, retargetMotionClip } from "../apps/web/src/motionRetarget";

const transform = (translation: [number, number, number]) => ({ translation, rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });

const sourceSkeleton: Skeleton = {
  schemaVersion: 1,
  kind: "skeleton",
  id: "source-skeleton",
  name: "Source",
  coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "pixel" },
  bones: [
    { id: "source-root", name: "Root", parentId: null, rest: transform([0, -45, 0]), semantic: "root" },
    { id: "source-shoulder", name: "Shoulder", parentId: "source-root", rest: transform([50, 0, 0]), semantic: "rightShoulder" },
    { id: "source-elbow", name: "Elbow", parentId: "source-shoulder", rest: transform([40, 0, 0]), semantic: "rightElbow" },
  ],
  semanticProfile: { id: "humanoid-v1", bones: { root: "source-root", rightShoulder: "source-shoulder", rightElbow: "source-elbow" } },
};

const targetSkeleton: Skeleton = {
  schemaVersion: 1,
  kind: "skeleton",
  id: "target-skeleton",
  name: "Target",
  coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" },
  bones: [
    { id: "target-root", name: "Root", parentId: null, rest: transform([0, -1.5, 0]), semantic: "root" },
    { id: "target-shoulder", name: "Shoulder", parentId: "target-root", rest: transform([.5, 0, 0]), semantic: "rightShoulder" },
    { id: "target-elbow", name: "Elbow", parentId: "target-shoulder", rest: transform([.4, 0, 0]), semantic: "rightElbow" },
  ],
  semanticProfile: { id: "humanoid-v1", bones: { root: "target-root", rightShoulder: "target-shoulder", rightElbow: "target-elbow" } },
};

const sourceClip: MotionClip = {
  schemaVersion: 1,
  kind: "motion-clip",
  id: "source-attack",
  name: "Source attack",
  skeletonId: sourceSkeleton.id,
  duration: 1.25,
  loop: false,
  rootMotion: "preserve",
  tracks: [
    { targetId: "source-root", property: "translation", interpolation: "linear", keyframes: [{ time: 0, value: [0, -45, 0] }, { time: .7, value: [12, -48, 0] }] },
    { targetId: "source-shoulder", property: "rotation", interpolation: "linear", keyframes: [{ time: 0, value: quaternionFromZRotation(.2) }, { time: .625, value: quaternionFromZRotation(42 * Math.PI / 180) }] },
    { targetId: "source-elbow", property: "rotation", interpolation: "linear", keyframes: [{ time: 0, value: quaternionFromZRotation(0) }, { time: .7, value: quaternionFromZRotation(-.8) }] },
  ],
  events: [
    { time: .25, type: "attack-windup", name: "sword-ready" },
    { time: .7, type: "attack-hit", name: "sword-impact" },
    { time: 1, type: "attack-recover", name: "sword-reset" },
  ],
};

describe("语义骨架动作重定向", () => {
  test("创建普通副本并保留源动作的时间、事件与来源", () => {
    expect(areSkeletonsRetargetCompatible(sourceSkeleton, targetSkeleton)).toBeTrue();
    const retargeted = retargetMotionClip(sourceClip, sourceSkeleton, targetSkeleton, "Retargeted attack");
    expect(retargeted.id).not.toBe(sourceClip.id);
    expect(retargeted.skeletonId).toBe(targetSkeleton.id);
    expect(retargeted.duration).toBe(sourceClip.duration);
    expect(retargeted.events).toEqual(sourceClip.events);
    expect(retargeted.events).not.toBe(sourceClip.events);
    expect(retargeted.tracks.every((track) => targetSkeleton.bones.some((bone) => bone.id === track.targetId))).toBeTrue();
    expect(retargeted.provenance?.parameters?.sourceMotionClipId).toBe(sourceClip.id);
    expect(validateMotionClip(retargeted, targetSkeleton).ok).toBeTrue();
  });

  test("拒绝缺少同一语义协议的骨架", () => {
    const incompatible = { ...targetSkeleton, id: "other", semanticProfile: { ...targetSkeleton.semanticProfile!, id: "other-profile" } };
    expect(areSkeletonsRetargetCompatible(sourceSkeleton, incompatible)).toBeFalse();
    expect(() => retargetMotionClip(sourceClip, sourceSkeleton, incompatible, "Invalid")).toThrow("语义关节协议");
  });
});
