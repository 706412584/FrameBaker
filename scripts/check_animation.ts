import {
  MOTION_CLIP_SCHEMA_VERSION,
  sampleMotionClip,
  SKELETON_SCHEMA_VERSION,
  transformPoint,
  validateMotionClip,
  validateSkeleton,
  type MotionClip,
  type Skeleton,
} from "../packages/shared/src/animation";

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const scaledSkeleton: Skeleton = {
  schemaVersion: SKELETON_SCHEMA_VERSION,
  kind: "skeleton",
  id: "check:scaled",
  name: "Non-uniform scale check",
  coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" },
  bones: [
    { id: "root", name: "root", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] } },
    { id: "child", name: "child", parentId: "root", rest: { translation: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [1, 1, 1] } },
    { id: "grandchild", name: "grandchild", parentId: "child", rest: { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ],
};
const skeletonValidation = validateSkeleton(scaledSkeleton);
ensure(skeletonValidation.ok, `通用骨架校验失败：${JSON.stringify(skeletonValidation.issues)}`);
const cyclicSkeleton = structuredClone(scaledSkeleton);
cyclicSkeleton.bones[0]!.parentId = cyclicSkeleton.bones[1]!.id;
ensure(!validateSkeleton(cyclicSkeleton).ok, "骨架校验器未拒绝父子环");

const emptyClip: MotionClip = {
  schemaVersion: MOTION_CLIP_SCHEMA_VERSION,
  kind: "motion-clip",
  id: "check:empty",
  name: "Empty pose",
  skeletonId: scaledSkeleton.id,
  duration: 0,
  loop: false,
  tracks: [],
  events: [],
};
const scaledPose = sampleMotionClip(emptyClip, scaledSkeleton, 0);
const grandchildOrigin = transformPoint(scaledPose.worldMatrices.grandchild!, [0, 0, 0]);
ensure(Math.hypot(grandchildOrigin[0], grandchildOrigin[1] - 1) < 1e-8, "非均匀缩放下的矩阵 FK 结果错误");

const stepClip: MotionClip = {
  ...emptyClip,
  id: "check:step",
  duration: 2,
  tracks: [{
    targetId: "root",
    property: "translation",
    interpolation: "step",
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [5, 0, 0] }, { time: 2, value: [9, 0, 0] }],
  }],
};
ensure(sampleMotionClip(stepClip, scaledSkeleton, 1).local.root!.translation[0] === 5, "STEP 轨道未在关键帧时刻切换到新值");
ensure(sampleMotionClip(stepClip, scaledSkeleton, 99).local.root!.translation[0] === 9, "非循环动作未钳制到 duration");
const loopStepClip = { ...stepClip, loop: true };
ensure(sampleMotionClip(loopStepClip, scaledSkeleton, loopStepClip.duration).local.root!.translation[0] === 0, "循环动作的 duration 未映射回 0");
ensure(sampleMotionClip(loopStepClip, scaledSkeleton, -1).local.root!.translation[0] === 5, "循环动作未正确处理负时间");

const invalidOptional = structuredClone(stepClip) as unknown as Record<string, unknown>;
invalidOptional.contacts = 42;
ensure(!validateMotionClip(invalidOptional, scaledSkeleton).ok, "动作校验器接受了非法可选字段");
const invalidAxes = structuredClone(scaledSkeleton);
invalidAxes.coordinateSystem.forwardAxis = "+y";
ensure(!validateSkeleton(invalidAxes).ok, "骨架校验器接受了共线坐标轴");
const invalidQuaternion = structuredClone(scaledSkeleton);
invalidQuaternion.bones[0]!.rest.rotation = [0, 0, 0, 2];
ensure(!validateSkeleton(invalidQuaternion).ok, "骨架校验器接受了未归一化四元数");
const invalidExtension = structuredClone(scaledSkeleton);
invalidExtension.extensions = { unnamespaced: true };
ensure(!validateSkeleton(invalidExtension).ok, "骨架校验器接受了未命名空间化的扩展");
const invalidLoopEvent = structuredClone(loopStepClip);
invalidLoopEvent.events = [{ time: invalidLoopEvent.duration, type: "marker", name: "end" }];
ensure(!validateMotionClip(invalidLoopEvent, scaledSkeleton).ok, "动作校验器接受了循环区间终点事件");
let rejectedNonFiniteTime = false;
try { sampleMotionClip(stepClip, scaledSkeleton, Number.NaN); } catch { rejectedNonFiniteTime = true; }
ensure(rejectedNonFiniteTime, "采样器未拒绝非有限时间");

console.log("通用动画检查通过：矩阵 FK、时间边界与运行时校验正常");
