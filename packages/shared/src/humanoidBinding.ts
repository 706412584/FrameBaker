import { quaternionFromZRotation, type AnimationBone, type CharacterBinding, type Skeleton } from "./animation";
import type { ArticulatedCharacterPartRole, CharacterPartRole } from "./types";

/**
 * 部件角色 → 人形骨骼语义。注意内置动作的运动语义：
 * 上臂挂 shoulder 骨（肩→肘段）、前臂含手挂 elbow 骨（肘→腕段）、wrist 骨（手）不挂件；
 * 大腿挂 knee 骨（髋→膝段）、小腿含脚挂 ankle 骨（膝→踝段）、hip 骨是骨盆连接段不挂件。
 */
export const HUMANOID_PART_ROLE_TO_BONE_SEMANTIC: Partial<Record<ArticulatedCharacterPartRole, string>> = {
  "head": "head",
  "torso": "chest",
  "pelvis": "pelvis",
  "upper-arm-left": "leftShoulder",
  "forearm-left": "leftElbow",
  "upper-arm-right": "rightShoulder",
  "forearm-right": "rightElbow",
  "thigh-left": "leftKnee",
  "shin-left": "leftAnkle",
  "thigh-right": "rightKnee",
  "shin-right": "rightAnkle",
};

/** 侧视角色的标准绘制层级：右侧肢体在后、躯干居中、左侧肢体在前、头最上（脸始终可见）。 */
const HUMANOID_DRAW_ORDER: Partial<Record<ArticulatedCharacterPartRole, number>> = {
  "shin-right": 0,
  "thigh-right": 1,
  "forearm-right": 2,
  "upper-arm-right": 3,
  "pelvis": 4,
  "torso": 5,
  "upper-arm-left": 6,
  "forearm-left": 7,
  "thigh-left": 8,
  "shin-left": 9,
  "head": 10,
};

/**
 * 部件显示尺寸启发式（按真实人形装备角色标定）：
 * 宽度为骨架总高的比例（贴合角色横向体型），高度为骨骼段长的倍率（保证关节衔接）。
 */
const HUMANOID_PART_METRICS: Partial<Record<ArticulatedCharacterPartRole, { widthOfFigure: number; heightOfBone: number }>> = {
  "head": { widthOfFigure: 0.31, heightOfBone: 2.1 },
  "torso": { widthOfFigure: 0.19, heightOfBone: 1.0 },
  "pelvis": { widthOfFigure: 0.16, heightOfBone: 0 }, // pelvis 无骨长，高度用总高比例 0.2
  "upper-arm-left": { widthOfFigure: 0.11, heightOfBone: 1.18 },
  "upper-arm-right": { widthOfFigure: 0.11, heightOfBone: 1.18 },
  "forearm-left": { widthOfFigure: 0.095, heightOfBone: 1.17 },
  "forearm-right": { widthOfFigure: 0.095, heightOfBone: 1.17 },
  "thigh-left": { widthOfFigure: 0.13, heightOfBone: 1.09 },
  "thigh-right": { widthOfFigure: 0.13, heightOfBone: 1.09 },
  "shin-left": { widthOfFigure: 0.14, heightOfBone: 1.2 },
  "shin-right": { widthOfFigure: 0.14, heightOfBone: 1.2 },
};

const quaternionZAngle = (q: readonly [number, number, number, number]): number => 2 * Math.atan2(q[2], q[3]);

interface RestPoseBone { bone: AnimationBone; worldX: number; worldY: number; worldAngle: number; length: number }

/** 2D 静止姿态 FK：假定所有旋转均为纯 Z 轴（像素骨架约定）。 */
function evaluateRestPose(skeleton: Skeleton): Map<string, RestPoseBone> {
  const byId = new Map(skeleton.bones.map((bone) => [bone.id, bone]));
  const cache = new Map<string, RestPoseBone>();
  const resolve = (bone: AnimationBone): RestPoseBone => {
    const existing = cache.get(bone.id);
    if (existing) return existing;
    const local = quaternionZAngle(bone.rest.rotation);
    const [tx, ty] = bone.rest.translation;
    let entry: RestPoseBone;
    const parent = bone.parentId ? byId.get(bone.parentId) : undefined;
    if (!parent) {
      entry = { bone, worldX: tx, worldY: ty, worldAngle: local, length: 0 };
    } else {
      const parentPose = resolve(parent);
      const cos = Math.cos(parentPose.worldAngle), sin = Math.sin(parentPose.worldAngle);
      entry = {
        bone,
        worldX: parentPose.worldX + cos * tx - sin * ty,
        worldY: parentPose.worldY + sin * tx + cos * ty,
        worldAngle: parentPose.worldAngle + local,
        length: 0,
      };
    }
    entry.length = bone.tipOffset ? Math.hypot(bone.tipOffset[0], bone.tipOffset[1]) : 0;
    cache.set(bone.id, entry);
    return entry;
  };
  for (const bone of skeleton.bones) resolve(bone);
  return cache;
}

/** 骨架整体高度（含骨端），用于把部件宽度换算成绝对像素。 */
export function measureSkeletonHeight(skeleton: Skeleton): number {
  const poses = evaluateRestPose(skeleton);
  let minY = Infinity, maxY = -Infinity;
  for (const pose of poses.values()) {
    minY = Math.min(minY, pose.worldY);
    maxY = Math.max(maxY, pose.worldY);
    if (pose.bone.tipOffset) {
      const cos = Math.cos(pose.worldAngle), sin = Math.sin(pose.worldAngle);
      const tipY = pose.worldY + sin * pose.bone.tipOffset[0] + cos * pose.bone.tipOffset[1];
      minY = Math.min(minY, tipY);
      maxY = Math.max(maxY, tipY);
    }
  }
  return Number.isFinite(maxY - minY) && maxY > minY ? maxY - minY : 1;
}

function semanticBoneIndex(skeleton: Skeleton): Map<string, AnimationBone> {
  const byId = new Map(skeleton.bones.map((bone) => [bone.id, bone]));
  const index = new Map<string, AnimationBone>();
  for (const bone of skeleton.bones) if (bone.semantic) index.set(bone.semantic, bone);
  for (const [semantic, boneId] of Object.entries(skeleton.semanticProfile?.bones ?? {})) {
    const bone = byId.get(boneId);
    if (bone) index.set(semantic, bone);
  }
  return index;
}

/** 自动组装所需的人形骨骼语义（去重）。 */
export const HUMANOID_REQUIRED_SEMANTICS: string[] = [...new Set(Object.values(HUMANOID_PART_ROLE_TO_BONE_SEMANTIC) as string[])];

export interface HumanoidSkeletonDiagnosis {
  isHumanoid: boolean;
  /** 已按语义匹配到的骨骼语义名。 */
  matched: string[];
  /** 缺失或命名不一致、无法匹配的骨骼语义名。 */
  missing: string[];
}

/**
 * 诊断骨架是否具备完整人形语义，并列出缺失项。骨骼命名/语义约定不一致时，
 * 自动组装会静默失效——本函数把缺失语义暴露出来，供 UI 提示用户修正。
 */
export function diagnoseHumanoidSkeleton(skeleton: Skeleton): HumanoidSkeletonDiagnosis {
  const semantics = semanticBoneIndex(skeleton);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const semantic of HUMANOID_REQUIRED_SEMANTICS) (semantics.has(semantic) ? matched : missing).push(semantic);
  return { isHumanoid: missing.length === 0, matched, missing };
}

/** 该骨架是否具备完整的人形动作语义（可用自动组装与标准 12 分件提示词）。 */
export function isHumanoidSkeleton(skeleton: Skeleton): boolean {
  return diagnoseHumanoidSkeleton(skeleton).isHumanoid;
}

/** 用于分件提示词的部件描述列表：人形返回标准 11 部件；自定义骨架按有长度的骨段命名。 */
export function deriveSkeletonPartDescriptors(skeleton: Skeleton): string[] {
  if (isHumanoidSkeleton(skeleton)) {
    return [
      "head including helmet or hair",
      "torso from neck to waist, excluding shoulders, sleeves and upper arms",
      "pelvis from waist to hip sockets, excluding thighs and trouser legs",
      "left upper arm including shoulder clothing, ending at the elbow, no hand",
      "left forearm including the hand",
      "right upper arm including shoulder clothing, ending at the elbow, no hand",
      "right forearm including the hand",
      "left thigh including upper trouser leg, ending at the knee",
      "left shin including lower trouser leg and foot",
      "right thigh including upper trouser leg, ending at the knee",
      "right shin including lower trouser leg and foot",
    ];
  }
  return skeleton.bones.filter((bone) => bone.tipOffset).map((bone) => bone.name);
}

export interface HumanoidAutoBindingPart {
  role: CharacterPartRole;
  materialId: string;
  name?: string;
  /** 覆盖整体 imageSlot；未抠图的素材应传 "raw"。 */
  imageSlot?: "raw" | "processed";
}

export interface HumanoidAutoBindingResult {
  binding: CharacterBinding;
  /** 因角色不受支持（如 weapon）或骨架缺少对应语义而跳过的角色。 */
  skipped: CharacterPartRole[];
}

/**
 * 按人形语义一键生成角色绑定：部件挂到正确的运动骨骼段、
 * 静止旋转抵消骨骼朝向使贴图立直、尺寸按标定启发式、绘制层级右后左前头最上。
 */
export function buildHumanoidAutoBinding(options: {
  id: string;
  name: string;
  skeleton: Skeleton;
  parts: HumanoidAutoBindingPart[];
  imageSlot?: "raw" | "processed";
}): HumanoidAutoBindingResult {
  const { skeleton } = options;
  const semantics = semanticBoneIndex(skeleton);
  const poses = evaluateRestPose(skeleton);
  const figureHeight = measureSkeletonHeight(skeleton);
  const defaultImageSlot = options.imageSlot ?? "processed";
  const skipped: CharacterPartRole[] = [];
  const attachments: CharacterBinding["attachments"] = [];
  const slots: CharacterBinding["slots"] = [];
  const usedOrders = new Set<number>();
  let overflowOrder = 100;

  for (const part of options.parts) {
    const semantic = HUMANOID_PART_ROLE_TO_BONE_SEMANTIC[part.role as ArticulatedCharacterPartRole];
    const bone = semantic ? semantics.get(semantic) : undefined;
    const metrics = HUMANOID_PART_METRICS[part.role as ArticulatedCharacterPartRole];
    if (!semantic || !bone || !metrics) {
      skipped.push(part.role);
      continue;
    }
    const pose = poses.get(bone.id)!;
    const boneLength = pose.length;
    const width = Math.max(1, figureHeight * metrics.widthOfFigure);
    const height = Math.max(1, part.role === "pelvis" ? figureHeight * 0.2 : boneLength * metrics.heightOfBone);
    // 平移在骨骼本地系：沿骨骼方向居中；骨盆无骨长，向下悬挂裙甲。
    const translation: [number, number, number] = part.role === "pelvis"
      ? [0, -height * 0.35, 0]
      : [boneLength / 2, 0, 0];
    const attachmentId = `att-${part.role}`;
    let drawOrder = HUMANOID_DRAW_ORDER[part.role as ArticulatedCharacterPartRole] ?? overflowOrder++;
    while (usedOrders.has(drawOrder)) drawOrder = overflowOrder++;
    usedOrders.add(drawOrder);
    attachments.push({
      id: attachmentId,
      name: part.name?.trim() || part.role,
      type: "region",
      materialId: part.materialId,
      imageSlot: part.imageSlot ?? defaultImageSlot,
      size: [Math.round(width * 100) / 100, Math.round(height * 100) / 100],
      pivot: [0.5, 0.5],
      rest: {
        translation,
        // 抵消骨骼世界朝向，使立绘方向的贴图在静止姿态立直。
        rotation: quaternionFromZRotation(-pose.worldAngle),
        scale: [1, 1, 1],
      },
    });
    slots.push({
      id: `slot-${part.role}`,
      name: part.name?.trim() || part.role,
      boneId: bone.id,
      attachmentId,
      drawOrder,
    });
  }

  return {
    binding: {
      schemaVersion: 1,
      kind: "character-binding",
      id: options.id,
      name: options.name,
      skeletonId: skeleton.id,
      slots,
      attachments,
    },
    skipped,
  };
}
