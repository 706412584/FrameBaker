import { describe, expect, test } from "bun:test";
import { deriveSkeletonPartDescriptors, diagnoseHumanoidSkeleton, HUMANOID_REQUIRED_SEMANTICS, isHumanoidSkeleton, type AnimationBone, type Skeleton } from "../packages/shared/src";

const bone = (id: string, semantic: string | undefined, parentId: string | null = "root"): AnimationBone => ({
  id,
  name: id,
  parentId,
  rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  tipOffset: [10, 0, 0],
  ...(semantic ? { semantic } : {}),
});

const humanoidSkeleton = (): Skeleton => ({
  schemaVersion: 1,
  kind: "skeleton",
  id: "humanoid",
  name: "Humanoid",
  coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "pixel" },
  bones: [
    { id: "root", name: "Root", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    ...HUMANOID_REQUIRED_SEMANTICS.map((semantic) => bone(semantic, semantic)),
  ],
});

describe("人形骨架语义诊断", () => {
  test("完整语义的骨架被识别为人形且无缺失", () => {
    const skeleton = humanoidSkeleton();
    const diagnosis = diagnoseHumanoidSkeleton(skeleton);
    expect(diagnosis.isHumanoid).toBeTrue();
    expect(diagnosis.missing).toEqual([]);
    expect(diagnosis.matched.sort()).toEqual([...HUMANOID_REQUIRED_SEMANTICS].sort());
    expect(isHumanoidSkeleton(skeleton)).toBeTrue();
  });

  test("命名/语义不一致时列出缺失骨骼段", () => {
    const skeleton = humanoidSkeleton();
    // 模拟命名约定不一致：左肩语义丢失。
    skeleton.bones = skeleton.bones.map((item) => (item.semantic === "leftShoulder" ? { ...item, semantic: "arm_L" } : item));
    const diagnosis = diagnoseHumanoidSkeleton(skeleton);
    expect(diagnosis.isHumanoid).toBeFalse();
    expect(diagnosis.missing).toEqual(["leftShoulder"]);
    expect(isHumanoidSkeleton(skeleton)).toBeFalse();
  });

  test("semanticProfile 也能补齐语义映射", () => {
    const skeleton = humanoidSkeleton();
    const leftShoulder = skeleton.bones.find((item) => item.semantic === "leftShoulder")!;
    delete leftShoulder.semantic;
    expect(diagnoseHumanoidSkeleton(skeleton).isHumanoid).toBeFalse();
    skeleton.semanticProfile = { id: "profile", bones: { leftShoulder: leftShoulder.id } };
    expect(diagnoseHumanoidSkeleton(skeleton).isHumanoid).toBeTrue();
  });

  test("人形骨架的分件描述为固定 11 部件，自定义骨架按骨段命名", () => {
    expect(deriveSkeletonPartDescriptors(humanoidSkeleton())).toHaveLength(11);

    const custom: Skeleton = {
      schemaVersion: 1,
      kind: "skeleton",
      id: "custom",
      name: "Custom",
      coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "pixel" },
      bones: [
        { id: "root", name: "Root", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
        bone("tail-base", undefined),
        bone("tail-tip", undefined, "tail-base"),
      ],
    };
    expect(deriveSkeletonPartDescriptors(custom)).toEqual(["tail-base", "tail-tip"]);
  });
});
