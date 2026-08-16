import {
  BUILTIN_HUMANOID_BONE_IDS,
  BUILTIN_HUMANOID_ROOT_ID,
  BUILTIN_HUMANOID_SKELETON_ID,
} from "@framebaker/shared";

type Translate = (key: string) => string;

const BUILTIN_BONE_LABEL_KEYS = new Map<string, string>([
  [BUILTIN_HUMANOID_ROOT_ID, "animation.builtin.bone.root"],
  [BUILTIN_HUMANOID_BONE_IDS.pelvis, "animation.builtin.bone.pelvis"],
  [BUILTIN_HUMANOID_BONE_IDS.chest, "animation.builtin.bone.chest"],
  [BUILTIN_HUMANOID_BONE_IDS.neck, "animation.builtin.bone.neck"],
  [BUILTIN_HUMANOID_BONE_IDS.head, "animation.builtin.bone.head"],
  [BUILTIN_HUMANOID_BONE_IDS.leftShoulder, "animation.builtin.bone.leftShoulder"],
  [BUILTIN_HUMANOID_BONE_IDS.leftElbow, "animation.builtin.bone.leftElbow"],
  [BUILTIN_HUMANOID_BONE_IDS.leftWrist, "animation.builtin.bone.leftWrist"],
  [BUILTIN_HUMANOID_BONE_IDS.rightShoulder, "animation.builtin.bone.rightShoulder"],
  [BUILTIN_HUMANOID_BONE_IDS.rightElbow, "animation.builtin.bone.rightElbow"],
  [BUILTIN_HUMANOID_BONE_IDS.rightWrist, "animation.builtin.bone.rightWrist"],
  [BUILTIN_HUMANOID_BONE_IDS.leftHip, "animation.builtin.bone.leftHip"],
  [BUILTIN_HUMANOID_BONE_IDS.leftKnee, "animation.builtin.bone.leftKnee"],
  [BUILTIN_HUMANOID_BONE_IDS.leftAnkle, "animation.builtin.bone.leftAnkle"],
  [BUILTIN_HUMANOID_BONE_IDS.rightHip, "animation.builtin.bone.rightHip"],
  [BUILTIN_HUMANOID_BONE_IDS.rightKnee, "animation.builtin.bone.rightKnee"],
  [BUILTIN_HUMANOID_BONE_IDS.rightAnkle, "animation.builtin.bone.rightAnkle"],
]);

export function localizeSkeletonName(id: string, name: string, t: Translate): string {
  return id === BUILTIN_HUMANOID_SKELETON_ID ? t("animation.builtin.skeletonName") : name;
}

export function localizeBoneName(skeletonId: string, boneId: string, name: string, t: Translate): string {
  if (skeletonId !== BUILTIN_HUMANOID_SKELETON_ID) return name;
  const key = BUILTIN_BONE_LABEL_KEYS.get(boneId);
  return key ? t(key) : name;
}
