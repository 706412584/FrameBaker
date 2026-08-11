import {
  quaternionFromZRotation,
  zRotationFromQuaternion,
  type AnimationBone,
  type AnyMotionTrack,
  type MotionClip,
  type Skeleton,
  type Vec3,
} from "@framebaker/shared";

const HUMANOID_ROTATION_SCALE: Record<string, number> = {
  pelvis: .45,
  chest: .65,
  neck: .35,
  head: .45,
  leftShoulder: .58,
  leftElbow: .48,
  leftWrist: .34,
  rightShoulder: .58,
  rightElbow: .48,
  rightWrist: .34,
  leftHip: .56,
  leftKnee: .5,
  leftAnkle: .34,
  rightHip: .56,
  rightKnee: .5,
  rightAnkle: .34,
};

function semanticBones(skeleton: Skeleton): Map<string, AnimationBone> {
  const result = new Map<string, AnimationBone>();
  for (const bone of skeleton.bones) if (bone.semantic) result.set(bone.semantic, bone);
  for (const [semantic, id] of Object.entries(skeleton.semanticProfile?.bones ?? {})) {
    const bone = skeleton.bones.find((item) => item.id === id);
    if (bone) result.set(semantic, bone);
  }
  return result;
}

export function areSkeletonsRetargetCompatible(source: Skeleton, target: Skeleton): boolean {
  if (source.id === target.id) return true;
  if (!source.semanticProfile || source.semanticProfile.id !== target.semanticProfile?.id) return false;
  const sourceBones = semanticBones(source), targetBones = semanticBones(target);
  return sourceBones.has("root") && targetBones.has("root")
    && [...sourceBones.keys()].filter((semantic) => semantic !== "root" && targetBones.has(semantic)).length >= 2;
}

function retargetScale(source: Skeleton, target: Skeleton): number {
  const sourceBones = semanticBones(source), targetBones = semanticBones(target), ratios: number[] = [];
  for (const [semantic, sourceBone] of sourceBones) {
    if (semantic === "root") continue;
    const targetBone = targetBones.get(semantic);
    if (!targetBone) continue;
    const sourceLength = Math.hypot(...sourceBone.rest.translation), targetLength = Math.hypot(...targetBone.rest.translation);
    if (sourceLength > 1e-6 && targetLength > 1e-6) ratios.push(targetLength / sourceLength);
  }
  if (!ratios.length) return source.coordinateSystem.unit === target.coordinateSystem.unit ? 1 : .01;
  ratios.sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[middle]! : (ratios[middle - 1]! + ratios[middle]!) / 2;
}

function continuousAngles(track: Extract<AnyMotionTrack, { property: "rotation" }>): number[] {
  const source = track.keyframes.map((key) => zRotationFromQuaternion(key.value));
  const result = [source[0]!];
  for (let index = 1; index < source.length; index += 1) {
    const delta = Math.atan2(Math.sin(source[index]! - source[index - 1]!), Math.cos(source[index]! - source[index - 1]!));
    result.push(result[index - 1]! + delta);
  }
  return result;
}

/**
 * 按同一语义骨架协议生成普通可编辑副本。源动作永不修改；时间、插值、事件和接触区间保持不变。
 * 二维旋转相对源动作首帧归零后施加到目标静止姿势，位移按两套骨架的关节长度中位数换算单位。
 */
export function retargetMotionClip(sourceClip: MotionClip, sourceSkeleton: Skeleton, targetSkeleton: Skeleton, name: string): MotionClip {
  if (sourceClip.skeletonId !== sourceSkeleton.id) throw new Error("源动作与源骨架不匹配");
  if (!areSkeletonsRetargetCompatible(sourceSkeleton, targetSkeleton)) throw new Error("两套骨架没有兼容的语义关节协议");

  const sourceById = new Map(sourceSkeleton.bones.map((bone) => [bone.id, bone]));
  const sourceSemantics = new Map([...semanticBones(sourceSkeleton)].map(([semantic, bone]) => [bone.id, semantic]));
  const targetBySemantic = semanticBones(targetSkeleton);
  const spatialScale = retargetScale(sourceSkeleton, targetSkeleton);
  const tracks = sourceClip.tracks.flatMap((track): AnyMotionTrack[] => {
    const sourceBone = sourceById.get(track.targetId), semantic = sourceSemantics.get(track.targetId);
    const targetBone = semantic ? targetBySemantic.get(semantic) : undefined;
    if (!sourceBone || !semantic || !targetBone) return [];
    if (track.property === "rotation") {
      const angles = continuousAngles(track);
      const baseline = angles.length > 1 ? angles[0]! : zRotationFromQuaternion(sourceBone.rest.rotation);
      const targetRest = zRotationFromQuaternion(targetBone.rest.rotation);
      const scale = sourceSkeleton.semanticProfile?.id === "humanoid-v1" ? HUMANOID_ROTATION_SCALE[semantic] ?? 1 : 1;
      return [{ ...track, targetId: targetBone.id, keyframes: track.keyframes.map((key, index) => ({ ...key, value: quaternionFromZRotation(targetRest + (angles[index]! - baseline) * scale) })) } as AnyMotionTrack];
    }
    if (track.property === "translation") {
      const sourceRest = sourceBone.rest.translation, targetRest = targetBone.rest.translation;
      return [{ ...track, targetId: targetBone.id, keyframes: track.keyframes.map((key) => ({ ...key, value: key.value.map((value, axis) => targetRest[axis]! + (value - sourceRest[axis]!) * spatialScale) as Vec3 })) } as AnyMotionTrack];
    }
    const baseline = track.keyframes.length > 1 ? track.keyframes[0]!.value : sourceBone.rest.scale;
    return [{ ...track, targetId: targetBone.id, keyframes: track.keyframes.map((key) => ({ ...key, value: key.value.map((value, axis) => targetBone.rest.scale[axis]! * value / (baseline[axis] || 1)) as Vec3 })) } as AnyMotionTrack];
  });
  if (!tracks.length) throw new Error("源动作没有可映射到目标骨架的轨道");

  const contacts = sourceClip.contacts?.flatMap((contact) => {
    const semantic = sourceSemantics.get(contact.targetId), targetBone = semantic ? targetBySemantic.get(semantic) : undefined;
    return targetBone ? [{ ...contact, targetId: targetBone.id, intervals: contact.intervals.map((interval) => ({ ...interval })) }] : [];
  });
  return {
    schemaVersion: sourceClip.schemaVersion,
    kind: "motion-clip",
    id: `motion-retarget-${crypto.randomUUID()}`,
    name,
    skeletonId: targetSkeleton.id,
    duration: sourceClip.duration,
    loop: sourceClip.loop,
    rootMotion: sourceClip.rootMotion,
    tracks,
    events: structuredClone(sourceClip.events),
    ...(contacts ? { contacts } : {}),
    provenance: {
      source: "import",
      adapter: "FrameBaker humanoid semantic retarget",
      adapterVersion: "1",
      parameters: {
        sourceMotionClipId: sourceClip.id,
        sourceSkeletonId: sourceSkeleton.id,
        targetSkeletonId: targetSkeleton.id,
        spatialScale,
      },
    },
  } as MotionClip;
}
