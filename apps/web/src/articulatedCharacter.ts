import {
  ARTICULATED_CHARACTER_PART_ROLES,
  BUILTIN_MOTIONS,
  BUILTIN_MOTION_IDS,
  MOTION_BONE_ORDER,
  multiplyQuaternions,
  quaternionFromZRotation,
  type ArticulatedCharacterPartRole,
  type BuiltinMotionId,
  type CharacterBinding,
  type CharacterPartSet,
  type Material,
  type MotionClip,
  type MotionTrack,
  type Skeleton,
  type Transform,
} from "@framebaker/shared";

export { BUILTIN_MOTION_IDS, type BuiltinMotionId } from "@framebaker/shared";

export interface ArticulatedPartSetStatus {
  complete: boolean;
  missing: ArticulatedCharacterPartRole[];
  duplicate: ArticulatedCharacterPartRole[];
}

export interface ArticulatedCharacterAssetNames {
  skeleton: string;
  binding: string;
  clip: string;
}

export interface ArticulatedPartImageMetric {
  width: number;
  height: number;
  imageSlot: "raw" | "processed";
}

export type ArticulatedPartImageMetrics = Partial<Record<ArticulatedCharacterPartRole, ArticulatedPartImageMetric>>;

const identity = (translation: [number, number, number] = [0, 0, 0]): Transform => ({
  translation,
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});

export function getArticulatedPartSetStatus(partSet: CharacterPartSet | undefined): ArticulatedPartSetStatus {
  const counts = new Map<string, number>();
  for (const member of partSet?.members ?? []) counts.set(member.role, (counts.get(member.role) ?? 0) + 1);
  const missing = ARTICULATED_CHARACTER_PART_ROLES.filter((role) => !counts.get(role));
  const duplicate = ARTICULATED_CHARACTER_PART_ROLES.filter((role) => (counts.get(role) ?? 0) > 1);
  return { complete: missing.length === 0 && duplicate.length === 0, missing, duplicate };
}

/** 组装前读取实际 PNG 尺寸；单张失败时保留默认几何，不阻断整套角色创建。 */
export async function measureArticulatedPartImages(
  partSet: CharacterPartSet,
  materials: Material[],
  imageUrl: (materialId: string, imageSlot: "raw" | "processed") => string,
): Promise<ArticulatedPartImageMetrics> {
  const entries = await Promise.all(ARTICULATED_CHARACTER_PART_ROLES.map(async (role) => {
    const member = partSet.members.find((item) => item.role === role);
    const material = member ? materials.find((item) => item.id === member.materialId) : undefined;
    if (!member || !material) return [role, undefined] as const;
    const imageSlot = material.processed_path ? "processed" as const : "raw" as const;
    try {
      const response = await fetch(imageUrl(material.id, imageSlot));
      if (!response.ok) throw new Error(`${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      const metric: ArticulatedPartImageMetric = { width: bitmap.width, height: bitmap.height, imageSlot };
      bitmap.close();
      return [role, metric] as const;
    } catch {
      return [role, { width: 0, height: 0, imageSlot }] as const;
    }
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [ArticulatedCharacterPartRole, ArticulatedPartImageMetric] => !!entry[1]));
}

/**
 * 把标准 12 分件集直接组装为可编辑的多关节角色，并重定向内置 Sword_Attack。
 * 手、脚节点作为关节/武器挂点存在，但不要求额外贴图。
 */
export function buildArticulatedAttackAssets(partSet: CharacterPartSet, names: ArticulatedCharacterAssetNames, imageMetrics: ArticulatedPartImageMetrics = {}): {
  skeleton: Skeleton;
  binding: CharacterBinding;
  clip: MotionClip;
} {
  const status = getArticulatedPartSetStatus(partSet);
  if (!status.complete) throw new Error(`12 分件不完整：缺少 ${status.missing.join(", ") || "无"}；重复 ${status.duplicate.join(", ") || "无"}`);

  const instance = crypto.randomUUID();
  const skeletonId = `skeleton-articulated-${instance}`;
  const boneId = (semantic: string) => `${semantic}-${instance}`;
  const ids = {
    root: boneId("root"), pelvis: boneId("pelvis"), torso: boneId("torso"), head: boneId("head"),
    upperArmLeft: boneId("upper-arm-left"), forearmLeft: boneId("forearm-left"), handLeft: boneId("hand-left"),
    upperArmRight: boneId("upper-arm-right"), forearmRight: boneId("forearm-right"), handRight: boneId("hand-right"), weapon: boneId("weapon"),
    thighLeft: boneId("thigh-left"), shinLeft: boneId("shin-left"), footLeft: boneId("foot-left"),
    thighRight: boneId("thigh-right"), shinRight: boneId("shin-right"), footRight: boneId("foot-right"),
  };

  const member = (role: ArticulatedCharacterPartRole) => partSet.members.find((item) => item.role === role)!;
  const baseRegions: Array<{ role: ArticulatedCharacterPartRole; bone: string; canonicalSize: [number, number]; pivot: [number, number]; drawOrder: number; rotation?: number; overlap?: number }> = [
    { role: "thigh-left", bone: ids.thighLeft, canonicalSize: [.43, .94], pivot: [.5, 1], drawOrder: 0, overlap: .045 },
    { role: "shin-left", bone: ids.shinLeft, canonicalSize: [.37, .91], pivot: [.5, 1], drawOrder: 1, overlap: .035 },
    { role: "upper-arm-left", bone: ids.upperArmLeft, canonicalSize: [.4, .73], pivot: [.5, 1], drawOrder: 2, overlap: .035 },
    { role: "forearm-left", bone: ids.forearmLeft, canonicalSize: [.36, .66], pivot: [.5, 1], drawOrder: 3, overlap: .025 },
    { role: "thigh-right", bone: ids.thighRight, canonicalSize: [.43, .94], pivot: [.5, 1], drawOrder: 4, overlap: .045 },
    { role: "shin-right", bone: ids.shinRight, canonicalSize: [.37, .91], pivot: [.5, 1], drawOrder: 5, overlap: .035 },
    { role: "torso", bone: ids.torso, canonicalSize: [1.12, 1.18], pivot: [.5, 0], drawOrder: 6 },
    { role: "pelvis", bone: ids.pelvis, canonicalSize: [.88, .5], pivot: [.5, .5], drawOrder: 7 },
    { role: "upper-arm-right", bone: ids.upperArmRight, canonicalSize: [.4, .73], pivot: [.5, 1], drawOrder: 8, overlap: .035 },
    { role: "forearm-right", bone: ids.forearmRight, canonicalSize: [.36, .66], pivot: [.5, 1], drawOrder: 9, overlap: .025 },
    { role: "head", bone: ids.head, canonicalSize: [.78, .78], pivot: [.5, 0], drawOrder: 10 },
    // 分件约定武器握柄朝上；轴心使用 Y-up 坐标，因此握点约在距图片底部 82% 处。
    { role: "weapon", bone: ids.weapon, canonicalSize: [.3, 1.56], pivot: [.5, .82], drawOrder: 11, rotation: -.12 },
  ];
  const scaleSamples = baseRegions.flatMap((region) => {
    const metric = imageMetrics[region.role];
    return metric && metric.height > 0 ? [region.canonicalSize[1] / metric.height] : [];
  }).sort((a, b) => a - b);
  const sharedPixelScale = scaleSamples.length
    ? scaleSamples.length % 2
      ? scaleSamples[Math.floor(scaleSamples.length / 2)]!
      : (scaleSamples[scaleSamples.length / 2 - 1]! + scaleSamples[scaleSamples.length / 2]!) / 2
    : undefined;
  const regions = baseRegions.map((region) => {
    const metric = imageMetrics[region.role];
    if (!metric || !(metric.width > 0) || !(metric.height > 0)) return { ...region, size: region.canonicalSize };
    const canonicalHeight = region.canonicalSize[1];
    const measuredHeight = sharedPixelScale
      ? Math.max(canonicalHeight * .78, Math.min(canonicalHeight * 1.22, metric.height * sharedPixelScale))
      : canonicalHeight;
    return { ...region, size: [measuredHeight * metric.width / metric.height, measuredHeight] as [number, number] };
  });
  const size = (role: ArticulatedCharacterPartRole) => regions.find((region) => region.role === role)!.size;
  const [torsoWidth, torsoHeight] = size("torso"), [pelvisWidth, pelvisHeight] = size("pelvis"), [, headHeight] = size("head");
  const [, upperArmLeftHeight] = size("upper-arm-left"), [, forearmLeftHeight] = size("forearm-left");
  const [, upperArmRightHeight] = size("upper-arm-right"), [, forearmRightHeight] = size("forearm-right");
  const [shinLeftWidth, thighLeftHeight] = [size("shin-left")[0], size("thigh-left")[1]], shinLeftHeight = size("shin-left")[1];
  const [shinRightWidth, thighRightHeight] = [size("shin-right")[0], size("thigh-right")[1]], shinRightHeight = size("shin-right")[1];
  const [, weaponHeight] = size("weapon");
  const bone = (id: string, name: string, parentId: string | null, translation: [number, number, number], tipOffset?: [number, number, number], semantic?: string) => ({
    id, name, parentId, rest: identity(translation), ...(tipOffset ? { tipOffset } : {}), ...(semantic ? { semantic } : {}),
  });
  const skeleton: Skeleton = {
    schemaVersion: 1,
    kind: "skeleton",
    id: skeletonId,
    name: names.skeleton,
    coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" },
    bones: [
      bone(ids.root, "根节点", null, [0, -1.65, 0], undefined, "root"),
      bone(ids.pelvis, "骨盆", ids.root, [0, 0, 0], [0, pelvisHeight * .7, 0], "pelvis"),
      bone(ids.torso, "躯干", ids.pelvis, [0, pelvisHeight * .36, 0], [0, torsoHeight * .86, 0], "chest"),
      bone(ids.head, "头部", ids.torso, [0, torsoHeight * .88, 0], [0, headHeight * .79, 0], "head"),
      bone(ids.upperArmLeft, "左肩 / 左上臂", ids.torso, [-torsoWidth * .43, torsoHeight * .64, 0], [0, -upperArmLeftHeight * .9, 0], "leftShoulder"),
      bone(ids.forearmLeft, "左肘 / 左前臂", ids.upperArmLeft, [0, -upperArmLeftHeight * .88, 0], [0, -forearmLeftHeight * .88, 0], "leftElbow"),
      bone(ids.handLeft, "左腕", ids.forearmLeft, [0, -forearmLeftHeight * .85, 0], [0, -forearmLeftHeight * .24, 0], "leftWrist"),
      bone(ids.upperArmRight, "右肩 / 右上臂", ids.torso, [torsoWidth * .43, torsoHeight * .64, 0], [0, -upperArmRightHeight * .9, 0], "rightShoulder"),
      bone(ids.forearmRight, "右肘 / 右前臂", ids.upperArmRight, [0, -upperArmRightHeight * .88, 0], [0, -forearmRightHeight * .88, 0], "rightElbow"),
      bone(ids.handRight, "右腕", ids.forearmRight, [0, -forearmRightHeight * .85, 0], [0, -forearmRightHeight * .24, 0], "rightWrist"),
      bone(ids.weapon, "武器挂点", ids.handRight, [0, -forearmRightHeight * .09, 0], [0, weaponHeight * .8, 0], "weapon"),
      bone(ids.thighLeft, "左髋 / 左大腿", ids.pelvis, [-pelvisWidth * .26, -pelvisHeight * .16, 0], [0, -thighLeftHeight * .91, 0], "leftHip"),
      bone(ids.shinLeft, "左膝 / 左小腿", ids.thighLeft, [0, -thighLeftHeight * .88, 0], [0, -shinLeftHeight * .92, 0], "leftKnee"),
      bone(ids.footLeft, "左踝", ids.shinLeft, [0, -shinLeftHeight * .89, 0], [Math.max(.16, shinLeftWidth * .86), -Math.max(.04, shinLeftHeight * .09), 0], "leftAnkle"),
      bone(ids.thighRight, "右髋 / 右大腿", ids.pelvis, [pelvisWidth * .26, -pelvisHeight * .16, 0], [0, -thighRightHeight * .91, 0], "rightHip"),
      bone(ids.shinRight, "右膝 / 右小腿", ids.thighRight, [0, -thighRightHeight * .88, 0], [0, -shinRightHeight * .92, 0], "rightKnee"),
      bone(ids.footRight, "右踝", ids.shinRight, [0, -shinRightHeight * .89, 0], [Math.max(.16, shinRightWidth * .86), -Math.max(.04, shinRightHeight * .09), 0], "rightAnkle"),
    ],
    semanticProfile: {
      id: "humanoid-v1",
      bones: {
        root: ids.root, pelvis: ids.pelvis, chest: ids.torso, head: ids.head,
        leftShoulder: ids.upperArmLeft, leftElbow: ids.forearmLeft, leftWrist: ids.handLeft,
        rightShoulder: ids.upperArmRight, rightElbow: ids.forearmRight, rightWrist: ids.handRight,
        leftHip: ids.thighLeft, leftKnee: ids.shinLeft, leftAnkle: ids.footLeft,
        rightHip: ids.thighRight, rightKnee: ids.shinRight, rightAnkle: ids.footRight,
        weapon: ids.weapon,
      },
    },
  };
  const attachments = regions.map((region) => {
    const part = member(region.role);
    const overlap = (region.overlap ?? 0) * region.size[1] / region.canonicalSize[1];
    return {
      id: `region-${region.role}-${instance}`,
      name: part.name,
      type: "region" as const,
      materialId: part.materialId,
      imageSlot: imageMetrics[region.role]?.imageSlot ?? "raw" as const,
      size: region.size,
      pivot: region.pivot,
      rest: { ...identity([0, overlap, 0]), rotation: quaternionFromZRotation(region.rotation ?? 0) },
    };
  });
  const binding: CharacterBinding = {
    schemaVersion: 1,
    kind: "character-binding",
    id: `binding-articulated-${instance}`,
    name: names.binding,
    skeletonId,
    attachments,
    slots: regions.map((region, index) => ({
      id: `slot-${region.role}-${instance}`,
      name: `${member(region.role).name}插槽`,
      boneId: region.bone,
      attachmentId: attachments[index]!.id,
      drawOrder: region.drawOrder,
    })),
  };

  const duration = 4 / 3;
  const smoothSamples = (values: number[]) => Array.from({ length: 41 }, (_, frame) => {
    const position = frame / 40 * (values.length - 1);
    const index = Math.min(values.length - 2, Math.floor(position));
    const amount = position - index;
    const before = values[Math.max(0, index - 1)]!, start = values[index]!, end = values[index + 1]!, after = values[Math.min(values.length - 1, index + 2)]!;
    return .5 * ((2 * start) + (-before + end) * amount + (2 * before - 5 * start + 4 * end - after) * amount ** 2 + (-before + 3 * start - 3 * end + after) * amount ** 3);
  });
  const rootX = smoothSamples([0, -.05, -.12, -.22, -.32, -.36, -.3, -.16, .05, .28, .42, .34, .22, .11, .04, 0]);
  const rootY = smoothSamples([-1.65, -1.66, -1.69, -1.73, -1.77, -1.75, -1.69, -1.59, -1.49, -1.43, -1.47, -1.53, -1.58, -1.62, -1.64, -1.65]);
  const torsoMotion = [0, -.01, -.035, -.075, -.12, -.11, -.06, .01, .08, .13, .12, .085, .05, .025, .01, 0];
  const armLeftMotion = [0, -.03, -.1, -.22, -.4, -.52, -.32, -.05, .24, .48, .55, .38, .18, .04, -.02, 0];
  const armRightMotion = [0, .12, .35, .7, 1.05, 1.18, .82, .3, -.35, -.92, -1.18, -.82, -.42, -.16, -.04, 0];
  const legLeftMotion = [0, .025, .07, .13, .19, .22, .17, .06, -.07, -.18, -.22, -.16, -.09, -.04, -.01, 0];
  const legRightMotion = legLeftMotion.map((value) => -value);
  const elbowLeft = [0, -.01, -.03, -.07, -.12, -.16, -.13, -.07, .02, .09, .13, .09, .05, .02, 0, 0];
  const elbowRight = elbowLeft.map((value) => -value);
  const kneeLeft = [0, .01, .03, .06, .1, .13, .11, .06, .01, -.04, -.06, -.045, -.025, -.01, 0, 0];
  const kneeRight = kneeLeft.map((value) => -value);
  const scaled = (values: number[], factor: number) => values.map((value) => value * factor);
  const combined = (...values: number[][]) => values[0]!.map((_, index) => values.reduce((sum, curve) => sum + curve[index]!, 0));
  const pelvisMotion = scaled(torsoMotion, .2);
  const curves = {
    pelvis: smoothSamples(pelvisMotion),
    torso: smoothSamples(combined(torsoMotion, scaled(pelvisMotion, -1))),
    head: smoothSamples([0, .01, .025, .045, .07, .065, .035, -.005, -.045, -.07, -.065, -.045, -.025, -.01, 0, 0]),
    upperArmLeft: smoothSamples(scaled(armLeftMotion, .72)),
    forearmLeft: smoothSamples(combined(scaled(armLeftMotion, .2), elbowLeft)),
    handLeft: smoothSamples(combined(scaled(armLeftMotion, .08), scaled(elbowLeft, -.6))),
    upperArmRight: smoothSamples(scaled(armRightMotion, .72)),
    forearmRight: smoothSamples(combined(scaled(armRightMotion, .2), elbowRight)),
    handRight: smoothSamples(combined(scaled(armRightMotion, .08), scaled(elbowRight, -.6))),
    weapon: smoothSamples([0, .005, .015, .03, .045, .055, .04, .015, -.02, -.045, -.06, -.04, -.02, -.008, 0, 0]),
    thighLeft: smoothSamples(scaled(legLeftMotion, .72)),
    shinLeft: smoothSamples(combined(scaled(legLeftMotion, .2), kneeLeft)),
    footLeft: smoothSamples(combined(scaled(legLeftMotion, .08), scaled(kneeLeft, -.7))),
    thighRight: smoothSamples(scaled(legRightMotion, .72)),
    shinRight: smoothSamples(combined(scaled(legRightMotion, .2), kneeRight)),
    footRight: smoothSamples(combined(scaled(legRightMotion, .08), scaled(kneeRight, -.7))),
  };
  const rotationTrack = (targetId: string, values: number[]): MotionTrack => {
    return {
      targetId,
      property: "rotation",
      interpolation: "linear",
      keyframes: values.map((value, frame) => ({ time: frame / (values.length - 1) * duration, value: quaternionFromZRotation(value) })),
    };
  };
  const clip: MotionClip = {
    schemaVersion: 1,
    kind: "motion-clip",
    id: `motion-articulated-attack-${instance}`,
    name: names.clip,
    skeletonId,
    duration,
    loop: false,
    rootMotion: "preserve",
    tracks: [
      {
        targetId: ids.root,
        property: "translation",
        interpolation: "linear",
        keyframes: rootX.map((x, frame) => ({ time: frame / (rootX.length - 1) * duration, value: [x, rootY[frame]!, 0] })),
      },
      rotationTrack(ids.pelvis, curves.pelvis),
      rotationTrack(ids.torso, curves.torso),
      rotationTrack(ids.head, curves.head),
      rotationTrack(ids.upperArmLeft, curves.upperArmLeft),
      rotationTrack(ids.forearmLeft, curves.forearmLeft),
      rotationTrack(ids.handLeft, curves.handLeft),
      rotationTrack(ids.upperArmRight, curves.upperArmRight),
      rotationTrack(ids.forearmRight, curves.forearmRight),
      rotationTrack(ids.handRight, curves.handRight),
      rotationTrack(ids.weapon, curves.weapon),
      rotationTrack(ids.thighLeft, curves.thighLeft),
      rotationTrack(ids.shinLeft, curves.shinLeft),
      rotationTrack(ids.footLeft, curves.footLeft),
      rotationTrack(ids.thighRight, curves.thighRight),
      rotationTrack(ids.shinRight, curves.shinRight),
      rotationTrack(ids.footRight, curves.footRight),
    ],
    events: [
      { time: 4 / 15 * duration, type: "attack-windup", name: "slash-ready" },
      { time: 9 / 15 * duration, type: "attack-hit", name: "slash-impact" },
      { time: 11 / 15 * duration, type: "attack-recover", name: "slash-recover" },
    ],
    provenance: {
      source: "import",
      adapter: "Quaternius UAL CC0 / Sword_Attack smooth articulated 12-part retarget",
      adapterVersion: "3",
      parameters: { sourceClip: "Sword_Attack", sourceSamples: rootX.length, measuredParts: Object.values(imageMetrics).filter((metric) => metric && metric.width > 0 && metric.height > 0).length },
    },
  };

  return { skeleton, binding, clip };
}

const RETARGET_ROTATION_SCALE: Record<(typeof MOTION_BONE_ORDER)[number], number> = {
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

/**
 * 把早期 humanoid-v1 预制动作重定向到当前骨架。
 * 源动作中的每级关节保持独立轨道；角度先连续展开再相对首帧归零，避免把整条手臂角度重复叠加到肩、肘、腕。
 */
export function buildRetargetedBuiltinMotionClip(skeleton: Skeleton, presetId: BuiltinMotionId, name: string): MotionClip {
  const preset = BUILTIN_MOTIONS[presetId];
  const root = skeleton.bones.find((bone) => bone.semantic === "root") ?? skeleton.bones.find((bone) => bone.parentId === null);
  if (!root) throw new Error("当前骨架没有可用于预制动作的根节点");
  const semanticBone = (semantic: string) => {
    const profileId = skeleton.semanticProfile?.bones[semantic];
    return skeleton.bones.find((bone) => bone.id === profileId) ?? skeleton.bones.find((bone) => bone.semantic === semantic);
  };
  const mapped = MOTION_BONE_ORDER.filter((semantic) => semantic !== "neck" && semanticBone(semantic));
  if (!mapped.length) throw new Error("当前骨架缺少 humanoid-v1 语义关节，无法导入早期预制动作");

  const fps = 12;
  const duration = preset.loop ? preset.frames.length / fps : Math.max(1 / fps, (preset.frames.length - 1) / fps);
  const frameTime = (index: number) => index / fps;
  const rootBase = root.rest.translation;
  const rootX = preset.frames[0]![0], rootY = preset.frames[0]![1];
  const rootValues = preset.frames.map((frame) => [rootBase[0] + (frame[0] - rootX) * .01, rootBase[1] - (frame[1] - rootY) * .01, rootBase[2]] as [number, number, number]);
  if (preset.loop) rootValues.push([...rootValues[0]!] as [number, number, number]);

  const rotationTracks: MotionTrack[] = [];
  for (const semantic of mapped) {
    const bone = semanticBone(semantic)!;
    const sourceIndex = MOTION_BONE_ORDER.indexOf(semantic) + 2;
    const values: number[] = preset.frames.map((frame) => frame[sourceIndex]!);
    const continuous: number[] = [values[0]!];
    for (let index = 1; index < values.length; index += 1) {
      const delta = Math.atan2(Math.sin(values[index]! - values[index - 1]!), Math.cos(values[index]! - values[index - 1]!));
      continuous.push(continuous[index - 1]! + delta);
    }
    const relative = continuous.map((value) => (value - continuous[0]!) * RETARGET_ROTATION_SCALE[semantic]);
    if (preset.loop) relative.push(relative[0]!);
    rotationTracks.push({
      targetId: bone.id,
      property: "rotation",
      interpolation: "linear",
      keyframes: relative.map((value, index) => ({ time: frameTime(index), value: multiplyQuaternions(bone.rest.rotation, quaternionFromZRotation(value)) })),
    });
  }

  return {
    schemaVersion: 1,
    kind: "motion-clip",
    id: `motion-builtin-${presetId}-${crypto.randomUUID()}`,
    name,
    skeletonId: skeleton.id,
    duration,
    loop: preset.loop,
    rootMotion: "preserve",
    tracks: [{ targetId: root.id, property: "translation", interpolation: "linear", keyframes: rootValues.map((value, index) => ({ time: frameTime(index), value })) }, ...rotationTracks],
    events: presetId === "attack" ? [{ time: duration * .58, type: "attack-hit", name: "impact" }] : [],
    provenance: {
      source: "import",
      adapter: "Quaternius UAL CC0 / FrameBaker humanoid-v1 semantic retarget",
      adapterVersion: "1",
      parameters: { presetId, sourceClip: preset.sourceClip, sourceFrames: preset.frames.length, fps },
    },
  };
}
