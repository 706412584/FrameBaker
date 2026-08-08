import type { HumanoidBoneId, MotionKeyframe } from "@framebaker/shared";
import { BUILTIN_MOTIONS, MOTION_BONE_ORDER } from "./builtinMotions";

export interface RigBone { id: HumanoidBoneId; parent: HumanoidBoneId | null; length: number; rest: number }
export interface RigPoint { x: number; y: number; angle: number }

export const RIG: RigBone[] = [
  { id: "pelvis", parent: null, length: 0, rest: 0 },
  { id: "chest", parent: "pelvis", length: 62, rest: -Math.PI / 2 },
  { id: "neck", parent: "chest", length: 25, rest: 0 }, { id: "head", parent: "neck", length: 30, rest: 0 },
  { id: "leftShoulder", parent: "chest", length: 39, rest: -Math.PI / 2 }, { id: "leftElbow", parent: "leftShoulder", length: 48, rest: -Math.PI / 2 }, { id: "leftWrist", parent: "leftElbow", length: 43, rest: 0 },
  { id: "rightShoulder", parent: "chest", length: 39, rest: Math.PI / 2 }, { id: "rightElbow", parent: "rightShoulder", length: 48, rest: Math.PI / 2 }, { id: "rightWrist", parent: "rightElbow", length: 43, rest: 0 },
  { id: "leftHip", parent: "pelvis", length: 28, rest: Math.PI }, { id: "leftKnee", parent: "leftHip", length: 68, rest: -Math.PI / 2 }, { id: "leftAnkle", parent: "leftKnee", length: 65, rest: 0 },
  { id: "rightHip", parent: "pelvis", length: 28, rest: 0 }, { id: "rightKnee", parent: "rightHip", length: 68, rest: Math.PI / 2 }, { id: "rightAnkle", parent: "rightKnee", length: 65, rest: 0 },
];
export const BONE_IDS = RIG.map((b) => b.id);
export const emptyRotations = () => Object.fromEntries(BONE_IDS.map((id) => [id, 0])) as Record<HumanoidBoneId, number>;
export const makeFrame = (rotations: Partial<Record<HumanoidBoneId, number>> = {}, root = { x: 0, y: 45 }): MotionKeyframe => ({ id: crypto.randomUUID(), root, rotations: { ...emptyRotations(), ...rotations } });

export function forward(frame: MotionKeyframe): Record<HumanoidBoneId, RigPoint> {
  const out = {} as Record<HumanoidBoneId, RigPoint>;
  for (const bone of RIG) {
    if (!bone.parent) { out[bone.id] = { ...frame.root, angle: bone.rest + frame.rotations[bone.id] }; continue; }
    const p = out[bone.parent];
    const angle = p.angle + bone.rest + frame.rotations[bone.id];
    out[bone.id] = { x: p.x + Math.cos(angle) * bone.length, y: p.y + Math.sin(angle) * bone.length, angle };
  }
  return out;
}

export function interpolate(a: MotionKeyframe | undefined, b: MotionKeyframe | undefined, t: number): MotionKeyframe | null {
  if (!a || !b) return null;
  const rotations = emptyRotations();
  for (const id of BONE_IDS) { let d = b.rotations[id] - a.rotations[id]; d = Math.atan2(Math.sin(d), Math.cos(d)); rotations[id] = a.rotations[id] + d * t; }
  return { id: a.id, root: { x: a.root.x + (b.root.x - a.root.x) * t, y: a.root.y + (b.root.y - a.root.y) * t }, rotations };
}

export interface MotionTuning {
  amplitude: number;
  armSwing: number;
  legStride: number;
  bounce: number;
  lean: number;
}

export const DEFAULT_MOTION_TUNING: MotionTuning = {
  amplitude: 1,
  armSwing: 1,
  legStride: 1,
  bounce: 1,
  lean: 0,
};

const ARM_BONES = new Set<HumanoidBoneId>(["leftShoulder", "leftElbow", "leftWrist", "rightShoulder", "rightElbow", "rightWrist"]);
const LEG_BONES = new Set<HumanoidBoneId>(["leftHip", "leftKnee", "leftAnkle", "rightHip", "rightKnee", "rightAnkle"]);

/** 把少量用户参数非破坏地应用到整段动作；原始预设始终作为调整基线。 */
export function tuneMotion(frames: MotionKeyframe[], tuning: MotionTuning): MotionKeyframe[] {
  const centerY = frames.reduce((sum, frame) => sum + frame.root.y, 0) / frames.length;
  const centers = emptyRotations();
  for (const id of BONE_IDS) {
    centers[id] = Math.atan2(
      frames.reduce((sum, frame) => sum + Math.sin(frame.rotations[id]), 0),
      frames.reduce((sum, frame) => sum + Math.cos(frame.rotations[id]), 0),
    );
  }
  return frames.map((frame) => {
    const rotations = emptyRotations();
    for (const id of BONE_IDS) {
      const partScale = ARM_BONES.has(id) ? tuning.armSwing : LEG_BONES.has(id) ? tuning.legStride : 1;
      const delta = Math.atan2(Math.sin(frame.rotations[id] - centers[id]), Math.cos(frame.rotations[id] - centers[id]));
      rotations[id] = centers[id] + delta * tuning.amplitude * partScale;
    }
    rotations.chest += tuning.lean * Math.PI / 180;
    return { ...frame, root: { ...frame.root, y: centerY + (frame.root.y - centerY) * tuning.bounce }, rotations };
  });
}

const LR: Partial<Record<HumanoidBoneId, HumanoidBoneId>> = { leftShoulder:"rightShoulder",rightShoulder:"leftShoulder",leftElbow:"rightElbow",rightElbow:"leftElbow",leftWrist:"rightWrist",rightWrist:"leftWrist",leftHip:"rightHip",rightHip:"leftHip",leftKnee:"rightKnee",rightKnee:"leftKnee",leftAnkle:"rightAnkle",rightAnkle:"leftAnkle" };
export function mirrorFrame(f: MotionKeyframe): MotionKeyframe { const r = emptyRotations(); for (const id of BONE_IDS) r[LR[id] ?? id] = -f.rotations[id]; return { ...f, id: crypto.randomUUID(), root: { x: -f.root.x, y: f.root.y }, rotations: r }; }

export type MotionPresetId = keyof typeof BUILTIN_MOTIONS;
const sampleFrame = (sample: readonly number[]): MotionKeyframe => {
  const rotations = emptyRotations();
  MOTION_BONE_ORDER.forEach((id, index) => { rotations[id] = sample[index + 2]!; });
  return { id: crypto.randomUUID(), root: { x: sample[0]!, y: sample[1]! }, rotations };
};
export const MOTION_PRESET_META = Object.fromEntries(Object.entries(BUILTIN_MOTIONS).map(([id, clip]) => [id, { source: clip.source, sourceClip: clip.sourceClip, loop: clip.loop, frameCount: clip.frames.length }])) as Record<MotionPresetId, { source: string; sourceClip: string; loop: boolean; frameCount: number }>;
export const MOTION_PRESETS = Object.fromEntries(Object.entries(BUILTIN_MOTIONS).map(([id, clip]) => [id, () => clip.frames.map(sampleFrame)])) as Record<MotionPresetId, () => MotionKeyframe[]>;
