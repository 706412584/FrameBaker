/**
 * 用真实分件的画布坐标反解 FrameBaker 绑定，再按内置动作烘出逐帧部件变换。
 *
 * 为什么不直接用 buildHumanoidAutoBinding：
 *   它的 size / translation 是「标准装备角色」的启发式标定（torso 宽 = 身高 19%、
 *   部件沿骨段居中）。See-through 拆出来的是宽袍道长，实测部件框和启发式差一倍以上，
 *   直接用会把袍摆压成条、把鞋放到袍子外面。
 *
 * 正确做法是反解：把骨架按身高缩放对齐到角色外接框，然后
 *   attachment.rest.translation = inverse(骨骼静止世界矩阵) × 部件中心
 *   attachment.rest.rotation    = -骨骼静止世界角（静止时贴图立直）
 *   attachment.size             = 部件真实像素尺寸 × 缩放
 * 这样静止姿态严格还原原立绘，动起来才是绕真实关节转。
 *
 * 用法：
 *   bun build_binding_and_bake.ts <parts目录> <clipId> <帧数> > poses.json
 */
import {
  createBuiltinAnimationAssets, sampleMotionClip, transformToMatrix, multiplyMatrices,
  quaternionFromZRotation, type Mat4, type MotionClip, type Skeleton, type Vec3,
} from "@framebaker/shared";
import { readFileSync } from "node:fs";

const partsDir = process.argv[2];
const clipId = process.argv[3] ?? "motion-original-preset-walk";
const frameCount = Number(process.argv[4] ?? 8);

const ROLE_TO_SEMANTIC: Record<string, string> = {
  "head": "head", "hair-back": "head", "torso": "chest", "pelvis": "pelvis",
  "upper-arm-left": "leftShoulder", "forearm-left": "leftElbow",
  "upper-arm-right": "rightShoulder", "forearm-right": "rightElbow",
  "thigh-left": "leftKnee", "shin-left": "leftAnkle",
  "thigh-right": "rightKnee", "shin-right": "rightAnkle",
};
const DRAW_ORDER: Record<string, number> = {
  "hair-back": -1,
  "shin-right": 0, "thigh-right": 1, "forearm-right": 2, "upper-arm-right": 3,
  "pelvis": 4, "torso": 5, "upper-arm-left": 6, "forearm-left": 7,
  "thigh-left": 8, "shin-left": 9, "head": 10,
};

const layout = JSON.parse(readFileSync(`${partsDir}/layout.json`, "utf-8")) as {
  canvas: number;
  parts: Record<string, { left: number; top: number; width: number; height: number; cx: number; cy: number }>;
};

const assets = createBuiltinAnimationAssets();
const skeleton = assets[0] as Skeleton;
const clip = (assets.slice(1) as MotionClip[]).find((c) => c.id === clipId);
if (!clip) throw new Error("未知动作 " + clipId);

/** 骨架静止姿态世界矩阵（纯 rest，不含任何动作）。 */
const restWorld: Record<string, Mat4> = {};
{
  const pending = new Set(skeleton.bones.map((b) => b.id));
  while (pending.size) {
    let moved = false;
    for (const bone of skeleton.bones) {
      if (!pending.has(bone.id) || (bone.parentId && !restWorld[bone.parentId])) continue;
      const local = transformToMatrix(bone.rest);
      restWorld[bone.id] = bone.parentId ? multiplyMatrices(restWorld[bone.parentId]!, local) : local;
      pending.delete(bone.id);
      moved = true;
    }
    if (!moved) throw new Error("骨架层级无效");
  }
}
const boneBySemantic = new Map(skeleton.bones.flatMap((b) => (b.semantic ? [[b.semantic, b] as const] : [])));
for (const [semantic, id] of Object.entries(skeleton.semanticProfile?.bones ?? {})) {
  const bone = skeleton.bones.find((b) => b.id === id);
  if (bone) boneBySemantic.set(semantic, bone);
}

// 骨架静止竖向范围（含骨端），用于和角色外接框对齐
let skTop = -Infinity, skBottom = Infinity, skSumX = 0, skCount = 0;
for (const bone of skeleton.bones) {
  const m = restWorld[bone.id]!;
  const pts: Vec3[] = [[m[12], m[13], 0]];
  if (bone.tipOffset) {
    const [tx, ty] = bone.tipOffset;
    pts.push([m[12] + m[0] * tx + m[4] * ty, m[13] + m[1] * tx + m[5] * ty, 0]);
  }
  for (const [x, y] of pts) {
    skTop = Math.max(skTop, y);
    skBottom = Math.min(skBottom, y);
    skSumX += x; skCount++;
  }
}
const skHeight = skTop - skBottom;
const skCenterX = skSumX / skCount;

// 角色外接框（所有部件并集）
const boxes = Object.values(layout.parts);
const chLeft = Math.min(...boxes.map((b) => b.left));
const chRight = Math.max(...boxes.map((b) => b.left + b.width));
const chTop = Math.min(...boxes.map((b) => b.top));
const chBottom = Math.max(...boxes.map((b) => b.top + b.height));
const scale = skHeight / (chBottom - chTop);
const chCenterX = (chLeft + chRight) / 2;

/** 画布像素 → 骨架空间（y 翻向上，脚底对齐骨架最低点，横向中线对齐）。 */
const toSkeleton = (px: number, py: number): [number, number] => [
  (px - chCenterX) * scale + skCenterX,
  (chBottom - py) * scale + skBottom,
];

interface BoundPart { role: string; boneId: string; tx: number; ty: number; rot: number; w: number; h: number; draw: number }
const bound: BoundPart[] = [];
for (const [role, box] of Object.entries(layout.parts)) {
  const semantic = ROLE_TO_SEMANTIC[role];
  const bone = semantic ? boneBySemantic.get(semantic) : undefined;
  if (!bone) { console.error("跳过无对应骨骼的部件", role); continue; }
  const m = restWorld[bone.id]!;
  const boneAngle = Math.atan2(m[1], m[0]);
  const [wx, wy] = toSkeleton(box.cx, box.cy);
  // 反解到骨骼本地系：先平移到骨骼原点，再反转骨骼世界角
  const dx = wx - m[12], dy = wy - m[13];
  const cos = Math.cos(-boneAngle), sin = Math.sin(-boneAngle);
  bound.push({
    role, boneId: bone.id,
    tx: dx * cos - dy * sin,
    ty: dx * sin + dy * cos,
    rot: -boneAngle,
    w: box.width * scale, h: box.height * scale,
    draw: DRAW_ORDER[role] ?? 50,
  });
}
bound.sort((a, b) => a.draw - b.draw);

const frames = [];
for (let i = 0; i < frameCount; i++) {
  const time = (clip.duration * i) / frameCount;
  const pose = sampleMotionClip(clip, skeleton, time);
  const parts = bound.map((p) => {
    const world = multiplyMatrices(pose.worldMatrices[p.boneId]!, transformToMatrix({
      translation: [p.tx, p.ty, 0], rotation: quaternionFromZRotation(p.rot), scale: [1, 1, 1],
    }));
    return {
      role: p.role, x: world[12], y: world[13],
      angle: Math.atan2(world[1], world[0]),
      w: p.w, h: p.h, pivot: [0.5, 0.5],
    };
  });
  frames.push({ index: i, time, parts });
}

console.log(JSON.stringify({
  clip: clip.id, name: clip.name, duration: clip.duration, loop: clip.loop, frameCount,
  fit: { scale, skHeight, charHeight: chBottom - chTop }, frames,
}, null, 1));
