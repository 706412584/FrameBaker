import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addMotionEvent, BUILTIN_ANIMATION_ASSET_IDS, closeMotionLoopSeam, deleteMotionEvent, deleteMotionKeyframe, getBoneEndpoint, isBuiltinAnimationAssetId, MOTION_KEY_TIME_EPSILON, multiplyMatrices, quaternionFromZRotation, reparentTransform2d, sampleMotionClip, transformPoint, transformToMatrix, upsertMotionKeyframe, zRotationFromQuaternion, type AnimationAsset, type AnimationAssetSummary, type CharacterBinding, type JsonValue, type Mat4, type Material, type MotionClip, type MotionInterpolation, type RootMotionPolicy, type Skeleton } from "@framebaker/shared";
import { Copy, Crosshair, Lock, Move, Pause, Pencil, Play, Plus, Redo2, RotateCcw, RotateCw, Save, Trash2, Undo2, Upload, ZoomIn } from "lucide-react";
import { api, materialImageUrl, type Folder } from "../api";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import FolderTree, { type FolderSelection } from "./FolderTree";
import PxSelect from "./PxSelect";

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const identity = () => ({ translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
const BUILTIN_ASSET_ORDER = new Map<string, number>(BUILTIN_ANIMATION_ASSET_IDS.map((id, index) => [id, index]));

function makeExample(skeletonName: string, clipName: string): [Skeleton, MotionClip] {
  const skeletonId = uid("skeleton"), root = uid("root"), torso = uid("torso"), head = uid("head"), armL = uid("arm-l"), armR = uid("arm-r"), legL = uid("leg-l"), legR = uid("leg-r");
  const bone = (id: string, name: string, parentId: string | null, translation: [number, number, number], tipOffset?: [number, number, number]) => ({ id, name, parentId, rest: { ...identity(), translation }, ...(tipOffset ? { tipOffset } : {}) });
  const skeleton: Skeleton = { schemaVersion: 1, kind: "skeleton", id: skeletonId, name: skeletonName, coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" }, bones: [bone(root, "Root", null, [0, -1, 0]), bone(torso, "Torso", root, [0, 1, 0]), bone(head, "Head", torso, [0, 1, 0], [0, .45, 0]), bone(armL, "Arm L", torso, [-.65, .65, 0], [-.55, -.2, 0]), bone(armR, "Arm R", torso, [.65, .65, 0], [.55, -.2, 0]), bone(legL, "Leg L", root, [-.3, .05, 0], [-.15, -1, 0]), bone(legR, "Leg R", root, [.3, .05, 0], [.15, -1, 0])] };
  const q = (angle: number): [number, number, number, number] => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
  const clip: MotionClip = { schemaVersion: 1, kind: "motion-clip", id: uid("motion"), name: clipName, skeletonId, duration: 2, loop: true, tracks: [
    { targetId: torso, property: "translation", interpolation: "linear", keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 1, value: [0, 1.08, 0] }, { time: 2, value: [0, 1, 0] }] },
    { targetId: armL, property: "rotation", interpolation: "linear", keyframes: [{ time: 0, value: q(-.08) }, { time: 1, value: q(.08) }, { time: 2, value: q(-.08) }] },
    { targetId: armR, property: "rotation", interpolation: "linear", keyframes: [{ time: 0, value: q(.08) }, { time: 1, value: q(-.08) }, { time: 2, value: q(.08) }] },
  ], events: [{ time: 1, type: "marker", name: "breath" }], provenance: { source: "manual" } };
  return [skeleton, clip];
}

function SkeletonPreview({ skeleton, clip, rangeClip, time, selectedBone, disabled, onSelectBone, onEditBone }: { skeleton: Skeleton; clip?: MotionClip; rangeClip?: MotionClip; time: number; selectedBone?: string; disabled?: boolean; onSelectBone?: (id: string) => void; onEditBone?: (id: string, patch: { tx?: number; ty?: number; rz?: number }) => void }) {
  const t = useT();
  const pose = useMemo(() => clip ? sampleMotionClip(clip, skeleton, time) : sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, 0), [clip, skeleton, time]);
  const points = skeleton.bones.map((bone) => transformPoint(pose.worldMatrices[bone.id]!, [0, 0, 0]));
  const localAxes = skeleton.bones.map((bone) => {
    if (bone.tipOffset && Math.hypot(...bone.tipOffset) > 1e-8) return bone.tipOffset;
    const child = skeleton.bones.find((item) => item.parentId === bone.id);
    return child ? pose.local[child.id]!.translation : [0, 0, 0] as [number, number, number];
  });
  const ends = skeleton.bones.map((bone, index) => {
    const axis = localAxes[index]!;
    return Math.hypot(...axis) > 1e-8 ? transformPoint(pose.worldMatrices[bone.id]!, axis) : getBoneEndpoint(pose, skeleton, bone.id);
  });
  const bounds = useMemo(() => {
    const source = rangeClip ?? clip;
    const rest: MotionClip = { schemaVersion: 1, kind: "motion-clip", id: "preview-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] };
    const times = source ? [...new Set([0, source.duration, ...source.tracks.flatMap((track) => track.keyframes.map((key) => key.time))])] : [0];
    const samples = times.flatMap((sampleTime) => {
      const sampled = sampleMotionClip(source ?? rest, skeleton, sampleTime);
      return skeleton.bones.flatMap((bone) => {
        const origin = transformPoint(sampled.worldMatrices[bone.id]!, [0, 0, 0]);
        const child = skeleton.bones.find((item) => item.parentId === bone.id);
        const axis = bone.tipOffset && Math.hypot(...bone.tipOffset) > 1e-8 ? bone.tipOffset : child ? sampled.local[child.id]!.translation : [0, 0, 0] as [number, number, number];
        return Math.hypot(...axis) > 1e-8 ? [origin, transformPoint(sampled.worldMatrices[bone.id]!, axis)] : [origin];
      });
    });
    const xs = samples.map((point) => point[0]), ys = samples.map((point) => point[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, [clip, rangeClip, skeleton]);
  const span = Math.max(1, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY), pad = span * .16, width = Math.max(1, bounds.maxX - bounds.minX + pad * 2), height = Math.max(1, bounds.maxY - bounds.minY + pad * 2), top = bounds.maxY + pad;
  const xy = (p: [number, number, number]) => ({ x: p[0], y: top - p[1] });
  const svgPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => { const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY; return point.matrixTransform(svg.getScreenCTM()?.inverse()); };
  const dragRef = useRef<{ id: string; root: boolean; origin: [number, number, number]; parentAngle: number; axisAngle: number; pointer: [number, number]; translation: [number, number, number] } | undefined>(undefined);
  const beginEdit = (event: React.PointerEvent<SVGGElement>, boneId: string, index: number) => {
    onSelectBone?.(boneId);
    if (!onEditBone || disabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
    const bone = skeleton.bones[index]!, parentMatrix = bone.parentId ? pose.worldMatrices[bone.parentId] : undefined, axis = localAxes[index]!, svg = event.currentTarget.ownerSVGElement!;
    const point = svgPoint(svg, event.clientX, event.clientY);
    dragRef.current = { id: boneId, root: bone.parentId === null, origin: points[index]!, parentAngle: parentMatrix ? Math.atan2(parentMatrix[1], parentMatrix[0]) : 0, axisAngle: Math.atan2(axis[1], axis[0]), pointer: [point.x, top - point.y], translation: pose.local[boneId]!.translation };
  };
  const moveEdit = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || !onEditBone) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY), x = point.x, y = top - point.y;
    if (drag.root) onEditBone(drag.id, { tx: drag.translation[0] + x - drag.pointer[0], ty: drag.translation[1] + y - drag.pointer[1] });
    else {
      const angle = Math.atan2(y - drag.origin[1], x - drag.origin[0]) - drag.parentAngle - drag.axisAngle;
      onEditBone(drag.id, { rz: Math.atan2(Math.sin(angle), Math.cos(angle)) * 180 / Math.PI });
    }
  };
  const endEdit = () => { dragRef.current = undefined; };
  const selectedInfo = skeleton.bones.find((bone) => bone.id === selectedBone);
  return <div className="animation-rig-stage"><div className="animation-rig-hud"><strong>{selectedInfo?.name ?? skeleton.name}</strong><span>{t(disabled ? "animation.canvas.playing" : selectedInfo?.parentId === null ? "animation.canvas.dragRoot" : "animation.canvas.dragBone")}</span></div><svg className={`animation-skeleton motion-clip-skeleton${onEditBone ? " interactive" : ""}`} viewBox={`${bounds.minX - pad} 0 ${width} ${height}`} role="img" onPointerMove={moveEdit} onPointerUp={endEdit} onPointerCancel={endEdit}>
    {skeleton.bones.map((bone, index) => {
      const parentIndex = bone.parentId ? skeleton.bones.findIndex((item) => item.id === bone.parentId) : -1;
      if (parentIndex < 0) return null;
      const parent = xy(points[parentIndex]!), point = xy(points[index]!);
      return <line className="animation-rig-link" key={`link-${bone.id}`} x1={parent.x} y1={parent.y} x2={point.x} y2={point.y} />;
    })}
    {skeleton.bones.map((bone, index) => {
      const start = xy(points[index]!), end = ends[index] ? xy(ends[index]!) : start, selected = selectedBone === bone.id;
      return <g className={`animation-rig-bone${selected ? " selected" : ""}`} key={bone.id} role={onSelectBone ? "button" : undefined} tabIndex={onSelectBone ? 0 : undefined} aria-label={bone.name} onPointerDown={(event) => beginEdit(event, bone.id, index)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectBone?.(bone.id); } }}>
        <line className="bone-shadow" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
        <line className="bone-line" x1={start.x} y1={start.y} x2={end.x} y2={end.y}><title>{bone.name}</title></line>
        <circle className="bone-handle" cx={end.x} cy={end.y} r={span * (selected ? .028 : .02)} />
      </g>;
    })}
    {skeleton.bones.map((bone, index) => { const point = xy(points[index]!); return <circle className={`animation-joint-node${selectedBone === bone.id ? " selected" : ""}`} key={`joint-${bone.id}`} cx={point.x} cy={point.y} r={span * .014} />; })}
  </svg><small>{onEditBone ? t("animation.canvas.hint") : skeleton.name}</small></div>;
}

type BindingTransformTool = "translate" | "rotate" | "scale" | "pivot";

interface CharacterPreviewProps {
  binding: CharacterBinding;
  skeleton: Skeleton;
  clip?: MotionClip;
  time: number;
  selectedAttachmentId?: string;
  selectedBoneId?: string;
  showSkeleton?: boolean;
  transformTool?: BindingTransformTool;
  onSelectAttachment?: (id: string) => void;
  onSelectBone?: (id: string) => void;
  onTransformAttachment?: (id: string, patch: Partial<CharacterBinding["attachments"][number]>) => void;
  onBeginTransform?: () => void;
  onEndTransform?: () => void;
}

interface BindingTransformDrag {
  id: string;
  tool: BindingTransformTool;
  start: [number, number];
  rest: CharacterBinding["attachments"][number]["rest"];
  pivot: [number, number];
  size: [number, number];
  bone: Mat4;
  world: Mat4;
  pivotWorld: [number, number];
  startAngle: number;
  startDistance: number;
}

export function CharacterPreview({ binding, skeleton, clip, time, selectedAttachmentId, selectedBoneId, showSkeleton = false, transformTool = "translate", onSelectAttachment, onSelectBone, onTransformAttachment, onBeginTransform, onEndTransform }: CharacterPreviewProps) {
  const t = useT();
  const pose = useMemo(() => sampleMotionClip(clip ?? { schemaVersion: 1, kind: "motion-clip", id: "binding-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, time), [clip, skeleton, time]);
  const dragRef = useRef<BindingTransformDrag | undefined>(undefined);
  const frozenViewBoxRef = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const viewBox = useMemo(() => {
    const restPose = sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "preview-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, 0);
    const attachmentPoints = binding.slots.flatMap((slot) => {
      const attachment = binding.attachments.find((item) => item.id === slot.attachmentId), bone = restPose.worldMatrices[slot.boneId];
      if (!attachment || !bone) return [];
      const world = multiplyMatrices(bone, transformToMatrix(attachment.rest)), [w, h] = attachment.size, [px, py] = attachment.pivot;
      const left = -px * w, bottom = -(1 - py) * h;
      return [[left, bottom, 0], [left + w, bottom, 0], [left, bottom + h, 0], [left + w, bottom + h, 0]].map((point) => transformPoint(world, point as [number, number, number]));
    });
    const skeletonPoints = showSkeleton
      ? skeleton.bones.map((bone) => transformPoint(restPose.worldMatrices[bone.id]!, [0, 0, 0]))
      : [];
    const points = [...attachmentPoints, ...skeletonPoints];
    if (!points.length) return "-2 -2 4 4";
    const minX = Math.min(...points.map((point) => point[0])), maxX = Math.max(...points.map((point) => point[0]));
    const minY = Math.min(...points.map((point) => point[1])), maxY = Math.max(...points.map((point) => point[1]));
    const pad = Math.max(.25, Math.max(maxX - minX, maxY - minY) * (clip ? .35 : .15));
    return `${minX - pad} ${-(maxY + pad)} ${Math.max(.5, maxX - minX + pad * 2)} ${Math.max(.5, maxY - minY + pad * 2)}`;
  }, [binding, clip, showSkeleton, skeleton]);
  const svgPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : point;
  };
  const beginTransform = (event: React.PointerEvent<SVGGraphicsElement>, attachment: CharacterBinding["attachments"][number], bone: Mat4, world: Mat4, tool = transformTool) => {
    onSelectAttachment?.(attachment.id);
    if (!onTransformAttachment) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const point = svgPoint(svg, event.clientX, event.clientY), start: [number, number] = [point.x, -point.y];
    const pivot = transformPoint(world, [0, 0, 0]), pivotWorld: [number, number] = [pivot[0], pivot[1]];
    event.preventDefault();
    event.stopPropagation();
    svg.setPointerCapture(event.pointerId);
    frozenViewBoxRef.current = viewBox;
    dragRef.current = {
      id: attachment.id,
      tool,
      start,
      rest: structuredClone(attachment.rest),
      pivot: [...attachment.pivot],
      size: [...attachment.size],
      bone,
      world,
      pivotWorld,
      startAngle: Math.atan2(start[1] - pivotWorld[1], start[0] - pivotWorld[0]),
      startDistance: Math.hypot(start[0] - pivotWorld[0], start[1] - pivotWorld[1]),
    };
    onBeginTransform?.();
    setDragging(true);
  };
  const moveTransform = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || !onTransformAttachment) return;
    const svgPointValue = svgPoint(event.currentTarget, event.clientX, event.clientY), point: [number, number] = [svgPointValue.x, -svgPointValue.y];
    if (drag.tool === "translate") {
      const worldX = point[0] - drag.start[0], worldY = point[1] - drag.start[1];
      const determinant = drag.bone[0] * drag.bone[5] - drag.bone[1] * drag.bone[4];
      if (Math.abs(determinant) < 1e-8) return;
      let localX = (drag.bone[5] * worldX - drag.bone[4] * worldY) / determinant;
      let localY = (-drag.bone[1] * worldX + drag.bone[0] * worldY) / determinant;
      if (event.shiftKey) [localX, localY] = Math.abs(localX) >= Math.abs(localY) ? [localX, 0] : [0, localY];
      onTransformAttachment(drag.id, { rest: { ...drag.rest, translation: [drag.rest.translation[0] + localX, drag.rest.translation[1] + localY, drag.rest.translation[2]] } });
      return;
    }
    if (drag.tool === "rotate") {
      const currentAngle = Math.atan2(point[1] - drag.pivotWorld[1], point[0] - drag.pivotWorld[0]);
      let angle = zRotationFromQuaternion(drag.rest.rotation) + currentAngle - drag.startAngle;
      if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
      onTransformAttachment(drag.id, { rest: { ...drag.rest, rotation: quaternionFromZRotation(angle) } });
      return;
    }
    if (drag.tool === "scale") {
      if (drag.startDistance < 1e-8) return;
      const factor = Math.max(.05, Math.min(20, Math.hypot(point[0] - drag.pivotWorld[0], point[1] - drag.pivotWorld[1]) / drag.startDistance));
      onTransformAttachment(drag.id, { rest: { ...drag.rest, scale: [drag.rest.scale[0] * factor, drag.rest.scale[1] * factor, drag.rest.scale[2]] } });
      return;
    }
    const worldX = point[0] - drag.start[0], worldY = point[1] - drag.start[1];
    const determinant = drag.world[0] * drag.world[5] - drag.world[1] * drag.world[4];
    if (Math.abs(determinant) < 1e-8) return;
    const localX = (drag.world[5] * worldX - drag.world[4] * worldY) / determinant;
    const localY = (-drag.world[1] * worldX + drag.world[0] * worldY) / determinant;
    const pivot: [number, number] = [Math.max(0, Math.min(1, drag.pivot[0] + localX / drag.size[0])), Math.max(0, Math.min(1, drag.pivot[1] + localY / drag.size[1]))];
    const pivotDeltaX = (pivot[0] - drag.pivot[0]) * drag.size[0], pivotDeltaY = (pivot[1] - drag.pivot[1]) * drag.size[1];
    const restLinear = transformToMatrix({ ...drag.rest, translation: [0, 0, 0] });
    const translation: [number, number, number] = [
      drag.rest.translation[0] + restLinear[0] * pivotDeltaX + restLinear[4] * pivotDeltaY,
      drag.rest.translation[1] + restLinear[1] * pivotDeltaX + restLinear[5] * pivotDeltaY,
      drag.rest.translation[2],
    ];
    onTransformAttachment(drag.id, { pivot, rest: { ...drag.rest, translation } });
  };
  const endTransform = () => {
    if (dragRef.current) onEndTransform?.();
    dragRef.current = undefined;
    frozenViewBoxRef.current = undefined;
    setDragging(false);
  };
  const previewSpan = Math.max(...viewBox.split(" ").slice(2).map(Number));
  const boneNodeRadius = Math.max(previewSpan * .008, .05);
  const handleRadius = Math.max(previewSpan * .01, .055);
  const selectedSlot = binding.slots.find((slot) => slot.attachmentId === selectedAttachmentId);
  const selectedAttachment = binding.attachments.find((attachment) => attachment.id === selectedAttachmentId);
  const selectedBoneMatrix = selectedSlot ? pose.worldMatrices[selectedSlot.boneId] : undefined;
  const selectedWorld = selectedAttachment && selectedBoneMatrix ? multiplyMatrices(selectedBoneMatrix, transformToMatrix(selectedAttachment.rest)) : undefined;
  const selectedGeometry = selectedAttachment && selectedWorld ? (() => {
    const [width, height] = selectedAttachment.size, [pivotX, pivotY] = selectedAttachment.pivot;
    const left = -pivotX * width, right = (1 - pivotX) * width, bottom = -(1 - pivotY) * height, top = pivotY * height;
    const corners = [[left, bottom, 0], [right, bottom, 0], [right, top, 0], [left, top, 0]].map((point) => transformPoint(selectedWorld, point as [number, number, number]));
    const rotateStem = transformPoint(selectedWorld, [(left + right) / 2, top, 0]);
    const rotate = transformPoint(selectedWorld, [(left + right) / 2, top + Math.max(width, height) * .13, 0]);
    return { corners, pivot: transformPoint(selectedWorld, [0, 0, 0]), rotateStem, rotate, scale: corners[2]! };
  })() : undefined;
  return <svg className={`animation-skeleton binding-preview${onTransformAttachment ? " interactive" : ""}`} data-tool={transformTool} viewBox={dragging ? frozenViewBoxRef.current : viewBox} role="img" onPointerMove={moveTransform} onPointerUp={endTransform} onPointerCancel={endTransform}>
    <g transform="scale(1 -1)">{[...binding.slots].sort((a, b) => a.drawOrder - b.drawOrder).map((slot) => {
      const attachment = binding.attachments.find((item) => item.id === slot.attachmentId), matrix = pose.worldMatrices[slot.boneId];
      if (!attachment || !matrix) return null;
      const world = multiplyMatrices(matrix, transformToMatrix(attachment.rest)), [w, h] = attachment.size, [px, py] = attachment.pivot;
      return <g key={slot.id}>
        <image className={selectedAttachmentId === attachment.id ? "selected" : ""} href={materialImageUrl(attachment.materialId, undefined, attachment.imageSlot)} x={-px * w} y={-(1 - py) * h} width={w} height={h} preserveAspectRatio="none" transform={`matrix(${world[0]} ${world[1]} ${world[4]} ${world[5]} ${world[12]} ${world[13]}) scale(1 -1)`} onPointerDown={onTransformAttachment ? (event) => beginTransform(event, attachment, matrix, world) : undefined} onClick={() => onSelectAttachment?.(attachment.id)} />
      </g>;
    })}{showSkeleton && <g className="binding-bone-overlay">
      {skeleton.bones.map((bone) => {
        if (!bone.parentId) return null;
        const parentMatrix = pose.worldMatrices[bone.parentId], matrix = pose.worldMatrices[bone.id];
        if (!parentMatrix || !matrix) return null;
        const parent = transformPoint(parentMatrix, [0, 0, 0]), point = transformPoint(matrix, [0, 0, 0]);
        return <line className={selectedBoneId === bone.id ? "selected" : ""} key={`bone-${bone.id}`} x1={parent[0]} y1={parent[1]} x2={point[0]} y2={point[1]} />;
      })}
      {skeleton.bones.map((bone) => {
        const matrix = pose.worldMatrices[bone.id];
        if (!matrix) return null;
        const point = transformPoint(matrix, [0, 0, 0]);
        return <g className={selectedBoneId === bone.id ? "selected" : ""} key={`node-${bone.id}`} role={onSelectBone ? "button" : undefined} tabIndex={onSelectBone ? 0 : undefined} aria-label={bone.name} onPointerDown={onSelectBone ? (event) => { event.preventDefault(); event.stopPropagation(); onSelectBone(bone.id); } : undefined} onKeyDown={onSelectBone ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectBone(bone.id); } } : undefined}>
          <circle className="binding-bone-node" cx={point[0]} cy={point[1]} r={selectedBoneId === bone.id ? boneNodeRadius * 1.45 : boneNodeRadius}><title>{bone.name}</title></circle>
        </g>;
      })}
    </g>}{selectedGeometry && selectedAttachment && selectedBoneMatrix && selectedWorld && <g className="binding-transform-overlay">
      <polygon className="binding-selection-outline" points={selectedGeometry.corners.map((point) => `${point[0]},${point[1]}`).join(" ")} />
      <line className="binding-rotate-stem" x1={selectedGeometry.rotateStem[0]} y1={selectedGeometry.rotateStem[1]} x2={selectedGeometry.rotate[0]} y2={selectedGeometry.rotate[1]} />
      <circle className="binding-transform-handle rotate" cx={selectedGeometry.rotate[0]} cy={selectedGeometry.rotate[1]} r={handleRadius} onPointerDown={(event) => beginTransform(event, selectedAttachment, selectedBoneMatrix, selectedWorld, "rotate")}><title>{t("animation.binding.toolRotate")}</title></circle>
      <rect className="binding-transform-handle scale" x={selectedGeometry.scale[0] - handleRadius} y={selectedGeometry.scale[1] - handleRadius} width={handleRadius * 2} height={handleRadius * 2} onPointerDown={(event) => beginTransform(event, selectedAttachment, selectedBoneMatrix, selectedWorld, "scale")}><title>{t("animation.binding.toolScale")}</title></rect>
      <circle className="binding-transform-handle pivot" cx={selectedGeometry.pivot[0]} cy={selectedGeometry.pivot[1]} r={handleRadius * .82} onPointerDown={(event) => beginTransform(event, selectedAttachment, selectedBoneMatrix, selectedWorld, "pivot")}><title>{t("animation.binding.toolPivot")}</title></circle>
      <line className="binding-pivot-cross" x1={selectedGeometry.pivot[0] - handleRadius * 1.5} y1={selectedGeometry.pivot[1]} x2={selectedGeometry.pivot[0] + handleRadius * 1.5} y2={selectedGeometry.pivot[1]} />
      <line className="binding-pivot-cross" x1={selectedGeometry.pivot[0]} y1={selectedGeometry.pivot[1] - handleRadius * 1.5} x2={selectedGeometry.pivot[0]} y2={selectedGeometry.pivot[1] + handleRadius * 1.5} />
    </g>}</g>
  </svg>;
}

export function BindingEditor({ binding, skeleton, materials, busy, onSave }: { binding: CharacterBinding; skeleton: Skeleton; materials: Material[]; busy: boolean; onSave: (value: CharacterBinding) => Promise<void> }) {
  const firstSlot = binding.slots[0];
  const t = useT();
  const [draft, setDraft] = useState(binding), [selectedAttachmentId, setSelectedAttachmentId] = useState(binding.attachments[0]?.id ?? ""), [selectedBoneId, setSelectedBoneId] = useState(firstSlot?.boneId ?? skeleton.bones[0]?.id ?? "");
  const [transformTool, setTransformTool] = useState<BindingTransformTool>("translate"), [undoDrafts, setUndoDrafts] = useState<CharacterBinding[]>([]), [redoDrafts, setRedoDrafts] = useState<CharacterBinding[]>([]);
  const draftRef = useRef(draft), continuousEditRef = useRef<CharacterBinding | undefined>(undefined);
  draftRef.current = draft;
  const restPose = useMemo(() => sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "binding-editor-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, 0), [skeleton]);
  useEffect(() => {
    setDraft(binding);
    setUndoDrafts([]);
    setRedoDrafts([]);
    continuousEditRef.current = undefined;
    setSelectedAttachmentId((current) => binding.attachments.some((item) => item.id === current) ? current : binding.attachments[0]?.id ?? "");
    setSelectedBoneId((current) => skeleton.bones.some((bone) => bone.id === current) ? current : binding.slots[0]?.boneId ?? skeleton.bones[0]?.id ?? "");
  }, [binding, skeleton]);
  const patchRegion = (id: string, patch: Partial<CharacterBinding["attachments"][number]>) => setDraft((old) => {
    const next = { ...old, attachments: old.attachments.map((item) => item.id === id ? { ...item, ...patch } : item) };
    draftRef.current = next;
    return next;
  });
  const patchSlot = (index: number, patch: Partial<CharacterBinding["slots"][number]>) => setDraft((old) => {
    const next = { ...old, slots: old.slots.map((item, i) => i === index ? { ...item, ...patch } : item) };
    draftRef.current = next;
    return next;
  });
  const rememberDraft = (value = draftRef.current) => {
    setUndoDrafts((items) => [...items.slice(-49), structuredClone(value)]);
    setRedoDrafts([]);
  };
  const beginContinuousEdit = () => { continuousEditRef.current ??= structuredClone(draftRef.current); };
  const endContinuousEdit = () => {
    const previous = continuousEditRef.current;
    continuousEditRef.current = undefined;
    if (previous && JSON.stringify(previous) !== JSON.stringify(draftRef.current)) rememberDraft(previous);
  };
  const restoreDraft = (value: CharacterBinding) => {
    setDraft(structuredClone(value));
    const attachmentId = value.attachments.some((item) => item.id === selectedAttachmentId) ? selectedAttachmentId : value.attachments[0]?.id ?? "";
    setSelectedAttachmentId(attachmentId);
    setSelectedBoneId(value.slots.find((item) => item.attachmentId === attachmentId)?.boneId ?? skeleton.bones[0]?.id ?? "");
  };
  const travelDraftHistory = (direction: "undo" | "redo") => {
    const source = direction === "undo" ? undoDrafts : redoDrafts, target = source.at(-1);
    if (!target) return;
    if (direction === "undo") {
      setUndoDrafts(source.slice(0, -1));
      setRedoDrafts((items) => [...items, structuredClone(draftRef.current)]);
    } else {
      setRedoDrafts(source.slice(0, -1));
      setUndoDrafts((items) => [...items, structuredClone(draftRef.current)]);
    }
    restoreDraft(target);
  };
  const addRow = () => {
    rememberDraft();
    const id = uid("region"), boneId = skeleton.bones[0]?.id ?? "", order = draft.slots.length ? Math.max(...draft.slots.map((slot) => slot.drawOrder)) + 1 : 0;
    setDraft((old) => ({ ...old, attachments: [...old.attachments, { id, name: t("animation.binding.region"), type: "region", materialId: materials[0]?.id ?? "", imageSlot: "raw", size: [1, 1], pivot: [.5, .5], rest: identity() }], slots: [...old.slots, { id: uid("slot"), name: t("animation.binding.slot"), boneId, attachmentId: id, drawOrder: order }] }));
    setSelectedAttachmentId(id);
    setSelectedBoneId(boneId);
  };
  const selectedAttachment = draft.attachments.find((item) => item.id === selectedAttachmentId);
  const selectedSlotIndex = draft.slots.findIndex((item) => item.attachmentId === selectedAttachmentId);
  const selectedSlot = selectedSlotIndex >= 0 ? draft.slots[selectedSlotIndex] : undefined;
  const selectedMaterial = materials.find((item) => item.id === selectedAttachment?.materialId);
  const selectedBone = skeleton.bones.find((bone) => bone.id === selectedBoneId);
  const selectAttachment = (id: string) => {
    setSelectedAttachmentId(id);
    const slot = draft.slots.find((item) => item.attachmentId === id);
    if (slot) setSelectedBoneId(slot.boneId);
  };
  const bindSelectedToBone = (boneId: string) => {
    setSelectedBoneId(boneId);
    if (!selectedAttachment || !selectedSlot || selectedSlotIndex < 0 || selectedSlot.boneId === boneId) return;
    const oldParent = restPose.worldMatrices[selectedSlot.boneId], newParent = restPose.worldMatrices[boneId];
    if (!oldParent || !newParent) return;
    try {
      const rest = reparentTransform2d(selectedAttachment.rest, oldParent, newParent);
      rememberDraft();
      setDraft((old) => ({
        ...old,
        attachments: old.attachments.map((item) => item.id === selectedAttachment.id ? { ...item, rest } : item),
        slots: old.slots.map((item, index) => index === selectedSlotIndex ? { ...item, boneId } : item),
      }));
    } catch (error) {
      notify(t("animation.binding.reparentFailed", { msg: (error as Error).message }));
    }
  };
  const removeSelected = () => {
    if (!selectedSlot || selectedSlotIndex < 0) return;
    rememberDraft();
    const slots = draft.slots.filter((_, index) => index !== selectedSlotIndex);
    const attachments = slots.some((item) => item.attachmentId === selectedAttachmentId) ? draft.attachments : draft.attachments.filter((item) => item.id !== selectedAttachmentId);
    const next = attachments[0];
    setDraft({ ...draft, slots, attachments });
    setSelectedAttachmentId(next?.id ?? "");
    setSelectedBoneId(slots.find((item) => item.attachmentId === next?.id)?.boneId ?? skeleton.bones[0]?.id ?? "");
  };
  const sliderField = (label: string, value: number, min: number, max: number, step: number, onChange: (value: number) => void) => <label className="binding-tuning-row"><span>{label}</span><input type="range" min={min} max={max} step={step} value={Math.max(min, Math.min(max, value))} onPointerDown={beginContinuousEdit} onPointerUp={endContinuousEdit} onPointerCancel={endContinuousEdit} onChange={(event) => onChange(Number(event.target.value))} /><input className="px-input" type="number" min={min} max={max} step={step} value={Math.round(value * 1000) / 1000} onFocus={beginContinuousEdit} onBlur={endContinuousEdit} onChange={(event) => onChange(Number(event.target.value))} /></label>;
  const setSelectedPivot = (axis: 0 | 1, value: number) => {
    if (!selectedAttachment) return;
    const pivot: [number, number] = [...selectedAttachment.pivot];
    pivot[axis] = value;
    const pivotDeltaX = (pivot[0] - selectedAttachment.pivot[0]) * selectedAttachment.size[0], pivotDeltaY = (pivot[1] - selectedAttachment.pivot[1]) * selectedAttachment.size[1];
    const restLinear = transformToMatrix({ ...selectedAttachment.rest, translation: [0, 0, 0] });
    const translation: [number, number, number] = [
      selectedAttachment.rest.translation[0] + restLinear[0] * pivotDeltaX + restLinear[4] * pivotDeltaY,
      selectedAttachment.rest.translation[1] + restLinear[1] * pivotDeltaX + restLinear[5] * pivotDeltaY,
      selectedAttachment.rest.translation[2],
    ];
    patchRegion(selectedAttachment.id, { pivot, rest: { ...selectedAttachment.rest, translation } });
  };
  const translationRange = selectedAttachment ? Math.max(2, ...selectedAttachment.size.map((value) => value * 3), Math.abs(selectedAttachment.rest.translation[0]) * 1.5, Math.abs(selectedAttachment.rest.translation[1]) * 1.5) : 2;
  const sizeRange = selectedAttachment ? Math.max(2, ...selectedAttachment.size.map((value) => value * 2)) : 2;
  const scaleRange = selectedAttachment ? Math.max(3, selectedAttachment.rest.scale[0] * 1.5, selectedAttachment.rest.scale[1] * 1.5) : 3;
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        travelDraftHistory(event.shiftKey ? "redo" : "undo");
        return;
      }
      const tool = ({ v: "translate", r: "rotate", s: "scale", p: "pivot" } as const)[event.key.toLowerCase() as "v" | "r" | "s" | "p"];
      if (tool) {
        event.preventDefault();
        setTransformTool(tool);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [undoDrafts, redoDrafts]);
  return <section className="binding-editor">
    <header className="binding-editor-heading"><div><h3>{t("animation.binding.visualTitle")}</h3><p>{t("animation.binding.visualHint")}</p></div><button className="px-btn accent" disabled={busy} onClick={() => void onSave(draft)}><Save size={13} />{t("common.save")}</button></header>
    <section className="binding-part-strip"><header><strong>{t("animation.binding.parts")}</strong><button className="px-btn" disabled={!materials.length} onClick={addRow}><Plus size={14} />{t("animation.binding.addRegion")}</button></header><div className="binding-part-list">{draft.slots.map((slot) => { const attachment = draft.attachments.find((item) => item.id === slot.attachmentId), boneName = skeleton.bones.find((bone) => bone.id === slot.boneId)?.name ?? slot.boneId; return attachment && <button type="button" className={selectedAttachmentId === attachment.id ? "selected" : ""} title={`${attachment.name} · ${boneName}`} key={slot.id} onClick={() => selectAttachment(attachment.id)}><span>{attachment.name}</span><small>{boneName}</small></button>; })}</div></section>
    <div className="binding-calibration-workspace">
      <article className="binding-preview-card">
        <div className="binding-canvas-hud"><span><b>1</b>{t("animation.binding.guidePart")}</span><span><b>2</b>{t("animation.binding.guideBone")}</span><span><b>3</b>{t("animation.binding.guideTune")}</span></div>
        <div className="binding-canvas-toolbar" role="toolbar" aria-label={t("animation.binding.tools")}>
          <div className="binding-transform-tools">
            <button type="button" className={transformTool === "translate" ? "on" : ""} aria-pressed={transformTool === "translate"} title={t("animation.binding.toolMoveHint")} onClick={() => setTransformTool("translate")}><Move size={13} />{t("animation.binding.toolMove")}<kbd>V</kbd></button>
            <button type="button" className={transformTool === "rotate" ? "on" : ""} aria-pressed={transformTool === "rotate"} title={t("animation.binding.toolRotateHint")} onClick={() => setTransformTool("rotate")}><RotateCw size={13} />{t("animation.binding.toolRotate")}<kbd>R</kbd></button>
            <button type="button" className={transformTool === "scale" ? "on" : ""} aria-pressed={transformTool === "scale"} title={t("animation.binding.toolScaleHint")} onClick={() => setTransformTool("scale")}><ZoomIn size={13} />{t("animation.binding.toolScale")}<kbd>S</kbd></button>
            <button type="button" className={transformTool === "pivot" ? "on" : ""} aria-pressed={transformTool === "pivot"} title={t("animation.binding.toolPivotHint")} onClick={() => setTransformTool("pivot")}><Crosshair size={13} />{t("animation.binding.toolPivot")}<kbd>P</kbd></button>
          </div>
          <span className="binding-current-link">{selectedAttachment ? `${selectedAttachment.name} → ${selectedBone?.name ?? t("animation.binding.chooseBone")}` : t("animation.binding.choosePart")}</span>
          <div className="binding-history-actions"><button className="px-btn icon" disabled={!undoDrafts.length} onClick={() => travelDraftHistory("undo")} title={t("animation.binding.undo")}><Undo2 size={14} /></button><button className="px-btn icon" disabled={!redoDrafts.length} onClick={() => travelDraftHistory("redo")} title={t("animation.binding.redo")}><Redo2 size={14} /></button></div>
        </div>
        <CharacterPreview binding={draft} skeleton={skeleton} time={0} selectedAttachmentId={selectedAttachmentId} selectedBoneId={selectedBoneId} showSkeleton transformTool={transformTool} onSelectAttachment={selectAttachment} onSelectBone={bindSelectedToBone} onTransformAttachment={patchRegion} onBeginTransform={beginContinuousEdit} onEndTransform={endContinuousEdit} />
        <p>{t("animation.binding.canvasHint")}</p>
      </article>
      <aside className="binding-inspector">{selectedAttachment && selectedSlot ? <>
        <header><div><span>{t("animation.binding.selectedPart")}</span><h3>{selectedAttachment.name}</h3><small>{t("animation.binding.boundTo", { bone: skeleton.bones.find((bone) => bone.id === selectedSlot.boneId)?.name ?? selectedSlot.boneId })}</small></div><button className="px-btn icon danger" title={t("common.delete")} onClick={removeSelected}><Trash2 size={13} /></button></header>
        <section className="binding-inspector-basics"><label>{t("animation.binding.slotName")}<input className="px-input" value={selectedSlot.name} onFocus={beginContinuousEdit} onBlur={endContinuousEdit} onChange={(event) => patchSlot(selectedSlotIndex, { name: event.target.value })} /></label><label>{t("animation.bone")}<PxSelect value={selectedSlot.boneId} options={skeleton.bones.map((bone) => ({ value: bone.id, label: bone.name }))} onChange={bindSelectedToBone} /></label><label>{t("animation.binding.material")}<PxSelect value={selectedAttachment.materialId} options={materials.map((item) => ({ value: item.id, label: item.name }))} onChange={(materialId) => { rememberDraft(); patchRegion(selectedAttachment.id, { materialId, imageSlot: "raw" }); }} /></label><label>{t("animation.binding.imageSlot")}<PxSelect value={selectedAttachment.imageSlot} options={[{ value: "raw", label: t("animation.binding.originalImage") }, { value: "processed", label: t("animation.binding.cutoutImage"), disabled: !selectedMaterial?.processed_path }]} onChange={(imageSlot) => { rememberDraft(); patchRegion(selectedAttachment.id, { imageSlot: imageSlot as "raw" | "processed" }); }} /></label></section>
        <section className="binding-tuning"><h4>{t("animation.binding.restTransform")}</h4>{sliderField(t("animation.binding.translationX"), selectedAttachment.rest.translation[0], -translationRange, translationRange, .01, (value) => { const translation = [...selectedAttachment.rest.translation] as [number, number, number]; translation[0] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, translation } }); })}{sliderField(t("animation.binding.translationY"), selectedAttachment.rest.translation[1], -translationRange, translationRange, .01, (value) => { const translation = [...selectedAttachment.rest.translation] as [number, number, number]; translation[1] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, translation } }); })}{sliderField(t("animation.binding.rotation"), zRotationFromQuaternion(selectedAttachment.rest.rotation) * 180 / Math.PI, -180, 180, 1, (value) => patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, rotation: quaternionFromZRotation(value * Math.PI / 180) } }))}{sliderField(t("animation.binding.scaleX"), selectedAttachment.rest.scale[0], .05, scaleRange, .01, (value) => { const scale = [...selectedAttachment.rest.scale] as [number, number, number]; scale[0] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, scale } }); })}{sliderField(t("animation.binding.scaleY"), selectedAttachment.rest.scale[1], .05, scaleRange, .01, (value) => { const scale = [...selectedAttachment.rest.scale] as [number, number, number]; scale[1] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, scale } }); })}</section>
        <details className="binding-geometry"><summary>{t("animation.binding.geometry")}</summary>{sliderField(t("animation.binding.pivotX"), selectedAttachment.pivot[0], 0, 1, .01, (value) => setSelectedPivot(0, value))}{sliderField(t("animation.binding.pivotY"), selectedAttachment.pivot[1], 0, 1, .01, (value) => setSelectedPivot(1, value))}{sliderField(t("animation.binding.width"), selectedAttachment.size[0], .01, sizeRange, .01, (value) => patchRegion(selectedAttachment.id, { size: [value, selectedAttachment.size[1]] }))}{sliderField(t("animation.binding.height"), selectedAttachment.size[1], .01, sizeRange, .01, (value) => patchRegion(selectedAttachment.id, { size: [selectedAttachment.size[0], value] }))}<label className="binding-order-field">{t("animation.binding.drawOrder")}<input className="px-input" type="number" step="1" value={selectedSlot.drawOrder} onFocus={beginContinuousEdit} onBlur={endContinuousEdit} onChange={(event) => patchSlot(selectedSlotIndex, { drawOrder: Number(event.target.value) })} /></label></details>
        <button className="px-btn" title={t("animation.binding.resetTransform")} onClick={() => { const original = binding.attachments.find((item) => item.id === selectedAttachment.id); if (original) { rememberDraft(); patchRegion(selectedAttachment.id, { rest: structuredClone(original.rest), pivot: [...original.pivot], size: [...original.size] }); } }}><Redo2 size={13} />{t("animation.binding.resetTransform")}</button>
      </> : <p className="animation-empty">{t("animation.binding.empty")}</p>}</aside>
    </div>
  </section>;
}

type AssetFilter = "all" | "skeleton" | "character-binding" | "motion-clip";

export default function AnimationAssetsWorkspace({ onOpenMaterials, onOpenProjects }: { onOpenMaterials: () => void; onOpenProjects: () => void }) {
  const t = useT(), inputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]), [folders, setFolders] = useState<Folder[]>([]), [folder, setFolder] = useState<FolderSelection>("all");
  const [filter, setFilter] = useState<AssetFilter>("all"), [skeletalProjectCount, setSkeletalProjectCount] = useState(0);
  const [selected, setSelected] = useState<string>(), [stored, setStored] = useState<AnimationAsset>(), [skeleton, setSkeleton] = useState<Skeleton>();
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [renaming, setRenaming] = useState(false), [name, setName] = useState("");
  const [selectedBone, setSelectedBone] = useState(""), [busy, setBusy] = useState(false);
  const [materials, setMaterials] = useState<Material[]>([]), [creatingBinding, setCreatingBinding] = useState(false), [bindingSkeletonId, setBindingSkeletonId] = useState("");
  const [draft, setDraft] = useState({ tx: 0, ty: 0, rz: 0, sx: 1, sy: 1 });
  const [eventDraft, setEventDraft] = useState({ type: "", name: "", payload: "" });
  const [eventPayloadError, setEventPayloadError] = useState("");
  const [undo, setUndo] = useState<MotionClip[]>([]), [redo, setRedo] = useState<MotionClip[]>([]);
  const load = useCallback(async () => { const [a, f, m, p] = await Promise.all([api.listAnimationAssets(), api.listFolders("animation"), api.listMaterials(), api.listProjects()]); setAssets(a); setFolders(f); setMaterials(m.filter((item) => item.kind === "image")); setSkeletalProjectCount(p.filter((item) => item.kind === "skeletal").length); }, []);
  useEffect(() => { void load().catch((e) => notify(t("animation.loadFailed", { msg: e.message }))); }, [load, t]);
  useEffect(() => {
    let active = true;
    if (!selected) { setStored(undefined); setSkeleton(undefined); return () => { active = false; }; }
    void api.getAnimationAsset(selected).then(async ({ asset }) => {
      const nextSkeleton = asset.kind === "skeleton" ? asset : asset.kind === "motion-clip" || asset.kind === "character-binding" ? (await api.getAnimationAsset(asset.skeletonId)).asset as Skeleton : undefined;
      if (!active) return;
      setStored(asset); setName(asset.name); setTime(0); setPlaying(false); setSkeleton(nextSkeleton); setSelectedBone(nextSkeleton?.bones[0]?.id ?? ""); setUndo([]); setRedo([]);
    }).catch((e) => { if (active) notify(t("animation.loadFailed", { msg: e.message })); });
    return () => { active = false; };
  }, [selected, t]);
  const clip = stored?.kind === "motion-clip" ? stored : undefined;
  const binding = stored?.kind === "character-binding" ? stored : undefined;
  const builtin = !!stored && isBuiltinAnimationAssetId(stored.id);
  const sampledSelectedTransform = useMemo(() => clip && skeleton && selectedBone ? sampleMotionClip(clip, skeleton, time).local[selectedBone] : undefined, [clip, skeleton, selectedBone, time]);
  const previewClip = useMemo(() => {
    if (!clip || playing || !selectedBone || !sampledSelectedTransform || !Object.values(draft).every(Number.isFinite)) return clip;
    let next = upsertMotionKeyframe(clip, selectedBone, "translation", time, [draft.tx, draft.ty, sampledSelectedTransform.translation[2]]);
    next = upsertMotionKeyframe(next, selectedBone, "rotation", time, quaternionFromZRotation(draft.rz * Math.PI / 180));
    return upsertMotionKeyframe(next, selectedBone, "scale", time, [draft.sx, draft.sy, sampledSelectedTransform.scale[2]]);
  }, [clip, playing, selectedBone, sampledSelectedTransform, time, draft]);
  const poseDraftDirty = !playing && !!sampledSelectedTransform && (
    Math.abs(draft.tx - sampledSelectedTransform.translation[0]) > 1e-6
    || Math.abs(draft.ty - sampledSelectedTransform.translation[1]) > 1e-6
    || Math.abs(draft.rz - zRotationFromQuaternion(sampledSelectedTransform.rotation) * 180 / Math.PI) > 1e-6
    || Math.abs(draft.sx - sampledSelectedTransform.scale[0]) > 1e-6
    || Math.abs(draft.sy - sampledSelectedTransform.scale[1]) > 1e-6
  );
  useEffect(() => {
    if (!clip || !skeleton || !selectedBone) return;
    const transform = sampleMotionClip(clip, skeleton, time).local[selectedBone];
    if (transform) setDraft({ tx: transform.translation[0], ty: transform.translation[1], rz: zRotationFromQuaternion(transform.rotation) * 180 / Math.PI, sx: transform.scale[0], sy: transform.scale[1] });
  }, [clip, skeleton, time]);
  useEffect(() => { if (!playing || !clip) return; let raf = 0, last = performance.now(); const tick = (now: number) => { const delta = (now - last) / 1000; last = now; setTime((old) => { const next = old + delta; if (clip.loop && clip.duration) return next % clip.duration; if (next >= clip.duration) { setPlaying(false); return clip.duration; } return next; }); raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [playing, clip]);
  const inFolder = assets.filter((a) => a.kind !== "render-profile" && (isBuiltinAnimationAssetId(a.id) || folder === "all" || (folder === "ungrouped" ? !a.folder_id : a.folder_id === folder)));
  const counts = { all: inFolder.length, skeleton: inFolder.filter((a) => a.kind === "skeleton").length, "character-binding": inFolder.filter((a) => a.kind === "character-binding").length, "motion-clip": inFolder.filter((a) => a.kind === "motion-clip").length };
  const visible = (filter === "all" ? inFolder : inFolder.filter((asset) => asset.kind === filter)).toSorted((a, b) => (BUILTIN_ASSET_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (BUILTIN_ASSET_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  useEffect(() => {
    if (selected && visible.some((asset) => asset.id === selected)) return;
    setSelected(visible[0]?.id);
  }, [filter, folder, selected, visible]);
  const importFile = async (file?: File) => { if (!file) return; try { const value = JSON.parse(await file.text()) as AnimationAsset; if (value.kind === "render-profile") throw new Error(t("animation.importProfileInProject")); const result = await api.createAnimationAsset(value, folder === "all" || folder === "ungrouped" ? null : folder); await load(); setSelected(result.asset.id); notify(t("animation.imported"), "info"); } catch (e) { notify(t("animation.importFailed", { msg: (e as Error).message })); } };
  const saveName = async () => { if (!stored || builtin || !name.trim()) return; try { const updated = await api.putAnimationAsset(stored.id, { ...stored, name: name.trim() }); setStored(updated.asset); setRenaming(false); await load(); } catch (e) { notify(t("animation.renameFailed", { msg: (e as Error).message })); } };
  const remove = async () => { if (!stored || builtin || !(await askConfirm(t("animation.deleteConfirm", { name: stored.name })))) return; try { await api.deleteAnimationAsset(stored.id); setSelected(undefined); await load(); } catch (e) { notify(t("animation.deleteFailed", { msg: (e as Error).message })); } };
  const copyBuiltinClip = async () => {
    if (!clip || !builtin || busy) return;
    setBusy(true);
    try {
      const targetFolder = folder === "all" || folder === "ungrouped" ? null : folder;
      const copied = await api.copyAnimationAsset(clip.id, t("animation.builtin.copyName", { name: clip.name }), targetFolder);
      await load();
      setSelected(copied.asset.id);
      notify(t("animation.builtin.copied", { name: copied.asset.name }), "info");
    } catch (e) {
      notify(t("animation.builtin.copyFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  const persistClip = async (next: MotionClip, previous: MotionClip) => {
    setBusy(true); setStored(next);
    try { const saved = await api.putAnimationAsset(next.id, next); setStored(saved.asset); return true; }
    catch (e) { setStored(previous); notify(t("animation.saveFailed", { msg: (e as Error).message })); return false; }
    finally { setBusy(false); }
  };
  const commitClipEdit = async (next: MotionClip) => {
    if (!clip || builtin || busy || next === clip) return false;
    if (!(await persistClip(next, clip))) return false;
    setUndo((items) => [...items, clip]); setRedo([]);
    return true;
  };
  const writeKey = async () => {
    if (!clip || !selectedBone || busy || !Object.values(draft).every(Number.isFinite)) return;
    let next = upsertMotionKeyframe(clip, selectedBone, "translation", time, [draft.tx, draft.ty, sampleMotionClip(clip, skeleton!, time).local[selectedBone]!.translation[2]]);
    next = upsertMotionKeyframe(next, selectedBone, "rotation", time, quaternionFromZRotation(draft.rz * Math.PI / 180));
    next = upsertMotionKeyframe(next, selectedBone, "scale", time, [draft.sx, draft.sy, sampleMotionClip(clip, skeleton!, time).local[selectedBone]!.scale[2]]);
    await commitClipEdit(next);
  };
  const deleteKey = async () => {
    if (!clip || !selectedBone || busy) return;
    const next = deleteMotionKeyframe(clip, selectedBone, ["translation", "rotation", "scale"], time);
    if (next === clip) return;
    await commitClipEdit(next);
  };
  const travelHistory = async (direction: "undo" | "redo") => {
    if (!clip || busy) return;
    const source = direction === "undo" ? undo : redo, snapshot = source[source.length - 1];
    if (!snapshot) return;
    if (!(await persistClip(snapshot, clip))) return;
    if (direction === "undo") { setUndo(source.slice(0, -1)); setRedo((items) => [...items, clip]); }
    else { setRedo(source.slice(0, -1)); setUndo((items) => [...items, clip]); }
  };
  const toggleLoop = async (loop: boolean) => { if (clip && !busy) await commitClipEdit({ ...clip, loop }); };
  const addEvent = async () => {
    if (!clip || busy || !eventDraft.type.trim() || !eventDraft.name.trim() || time < 0 || time > clip.duration || (clip.loop && time >= clip.duration)) return;
    let payload: Record<string, JsonValue> | undefined;
    if (eventDraft.payload.trim()) {
      try {
        const parsed: unknown = JSON.parse(eventDraft.payload);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        payload = parsed as Record<string, JsonValue>;
      } catch {
        setEventPayloadError(t("animation.eventPayloadInvalid"));
        return;
      }
    }
    const event = { time, type: eventDraft.type, name: eventDraft.name, ...(payload ? { payload } : {}) };
    if (await commitClipEdit(addMotionEvent(clip, event))) {
      setEventDraft({ type: "", name: "", payload: "" });
      setEventPayloadError("");
    }
  };
  const setInterpolation = async (targetId: string, property: string, interpolation: MotionInterpolation) => {
    if (!clip || busy) return;
    await commitClipEdit({ ...clip, tracks: clip.tracks.map((track) => track.targetId === targetId && track.property === property ? { ...track, interpolation } : track) });
  };
  const smoothAllTracks = async () => {
    if (!clip || busy || !clip.tracks.some((track) => track.interpolation === "step")) return;
    await commitClipEdit({ ...clip, tracks: clip.tracks.map((track) => ({ ...track, interpolation: "linear" })) });
  };
  const setRootMotion = async (value: string) => {
    if (!clip || busy) return;
    const next = { ...clip };
    if (value) next.rootMotion = value as RootMotionPolicy;
    else delete next.rootMotion;
    await commitClipEdit(next);
  };
  const hasCurrentKey = !!clip?.tracks.some((track) => track.targetId === selectedBone && track.keyframes.some((key) => Math.abs(key.time - time) <= MOTION_KEY_TIME_EPSILON));
  const selectedBoneInfo = skeleton?.bones.find((bone) => bone.id === selectedBone);
  const isRootBone = selectedBoneInfo?.parentId === null;
  const numberField = (key: keyof typeof draft, label: string, step = .01) => <label>{label}<input className="px-input" type="number" step={step} value={draft[key]} disabled={busy || builtin} onChange={(event) => { setPlaying(false); setDraft((old) => ({ ...old, [key]: +event.target.value })); }} /></label>;
  const selectBone = (id: string) => {
    setPlaying(false);
    setSelectedBone(id);
    if (!clip || !skeleton) return;
    const transform = sampleMotionClip(clip, skeleton, time).local[id];
    if (transform) setDraft({ tx: transform.translation[0], ty: transform.translation[1], rz: zRotationFromQuaternion(transform.rotation) * 180 / Math.PI, sx: transform.scale[0], sy: transform.scale[1] });
  };
  const editBoneOnCanvas = (id: string, patch: { tx?: number; ty?: number; rz?: number }) => {
    if (!clip || !skeleton || builtin) return;
    setPlaying(false);
    if (id === selectedBone) setDraft((old) => ({ ...old, ...patch }));
    else {
      const transform = sampleMotionClip(clip, skeleton, time).local[id];
      if (!transform) return;
      setSelectedBone(id);
      setDraft({ tx: transform.translation[0], ty: transform.translation[1], rz: zRotationFromQuaternion(transform.rotation) * 180 / Math.PI, sx: transform.scale[0], sy: transform.scale[1], ...patch });
    }
  };
  const resetSelectedBone = () => {
    if (!selectedBoneInfo || builtin) return;
    setPlaying(false);
    setDraft({
      tx: selectedBoneInfo.rest.translation[0],
      ty: selectedBoneInfo.rest.translation[1],
      rz: zRotationFromQuaternion(selectedBoneInfo.rest.rotation) * 180 / Math.PI,
      sx: selectedBoneInfo.rest.scale[0],
      sy: selectedBoneInfo.rest.scale[1],
    });
  };
  const nudgeRotation = (degrees: number) => { if (builtin) return; setPlaying(false); setDraft((old) => ({ ...old, rz: Math.max(-180, Math.min(180, old.rz + degrees)) })); };
  const createBinding = async () => { const selectedSkeleton = assets.find((item) => item.id === bindingSkeletonId && item.kind === "skeleton"); if (!selectedSkeleton) return; try { const made = await api.createAnimationAsset({ schemaVersion: 1, kind: "character-binding", id: uid("binding"), name: t("animation.binding.newName"), skeletonId: selectedSkeleton.id, slots: [], attachments: [] }, folder === "all" || folder === "ungrouped" ? null : folder); setCreatingBinding(false); await load(); setSelected(made.asset.id); } catch (e) { notify(t("animation.binding.createFailed", { msg: (e as Error).message })); } };
  return <><ol className="animation-flow-map">
    <li className={materials.length ? "done" : ""}><b>1</b><span><strong>{t("animation.flow.parts")}</strong><small>{t("animation.flow.partsHint")}</small></span><button className="px-btn" onClick={onOpenMaterials}>{t("animation.flow.openMaterials")}</button></li>
    <li className={counts.skeleton && counts["character-binding"] ? "done" : ""}><b>2</b><button onClick={() => setFilter("character-binding")}><strong>{t("animation.flow.binding")}</strong><small>{t("animation.flow.bindingHint")}</small></button></li>
    <li className={counts["motion-clip"] ? "done" : ""}><b>3</b><button onClick={() => setFilter("motion-clip")}><strong>{t("animation.flow.motion")}</strong><small>{t("animation.flow.motionHint")}</small></button></li>
    <li className={skeletalProjectCount ? "done" : ""}><b>4</b><span><strong>{t("animation.flow.project")}</strong><small>{t("animation.flow.projectHint")}</small></span><button className="px-btn" onClick={onOpenProjects}>{t("animation.flow.openProjects")}</button></li>
  </ol><div className="animation-workspace">
    <FolderTree className="animation-folders" title={t("animation.folders")} kind="animation" folders={folders} selected={folder} onSelect={setFolder} onCreate={async (n, p) => { await api.createFolder("animation", n, p); await load(); }} onRename={async (id, n) => { await api.patchFolder(id, { name: n }); await load(); }} onDelete={async (id) => { await api.deleteFolder(id); await load(); }} onMoveFolder={async (id, p) => { await api.patchFolder(id, { parentId: p }); await load(); }} onDropItems={(folderId, ids) => void api.moveItems("animation", ids, folderId).then(load).catch((e) => notify(t("animation.moveFailed", { msg: e.message })))} />
    <div className="animation-filter-rail"><strong>{t("animation.filter.title")}</strong>{(["all", "skeleton", "character-binding", "motion-clip"] as AssetFilter[]).map((kind) => <button key={kind} className={filter === kind ? "on" : ""} onClick={() => setFilter(kind)}>{t(`animation.filter.${kind}`)} <span>{counts[kind]}</span></button>)}</div>
    <section className="pixel-panel animation-library"><header><h2>{t("animation.assets")}</h2><div className="animation-library-actions"><input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(e) => { void importFile(e.target.files?.[0]); e.currentTarget.value = ""; }} /><button className="px-btn" onClick={() => inputRef.current?.click()}><Upload size={14} />{t("animation.importJson")}</button><button className="px-btn" onClick={() => setCreatingBinding((value) => !value)}><Plus size={14} />{t("animation.binding.create")}</button><button className="px-btn accent" onClick={() => void (async () => { let skeletonId: string | undefined; try { const [s, c] = makeExample(t("animation.exampleSkeletonName"), t("animation.exampleClipName")); skeletonId = s.id; const targetFolder = folder === "all" || folder === "ungrouped" ? null : folder; await api.createAnimationAsset(s, targetFolder); const made = await api.createAnimationAsset(c, targetFolder); await load(); setSelected(made.asset.id); } catch (e) { if (skeletonId) await api.deleteAnimationAsset(skeletonId).catch(() => undefined); notify(t("animation.exampleFailed", { msg: (e as Error).message })); } })()}><Plus size={14} />{t("animation.createExample")}</button></div></header>{creatingBinding && <div className="binding-create"><label>{t("animation.binding.skeleton")}<PxSelect value={bindingSkeletonId} options={assets.filter((item) => item.kind === "skeleton").map((item) => ({ value: item.id, label: item.name }))} onChange={setBindingSkeletonId} /></label><button className="px-btn accent" disabled={!bindingSkeletonId} onClick={() => void createBinding()}>{t("animation.binding.confirmCreate")}</button><button className="px-btn" onClick={() => setCreatingBinding(false)}>{t("common.cancel")}</button></div>}<div className="animation-list">{visible.map((asset) => { const locked = isBuiltinAnimationAssetId(asset.id); return <button draggable={!locked} onDragStart={locked ? undefined : (e) => e.dataTransfer.setData("application/x-framebaker-ids", JSON.stringify([asset.id]))} className={`${selected === asset.id ? "on" : ""}${locked ? " builtin" : ""}`} key={asset.id} onClick={() => setSelected(asset.id)}><strong>{asset.name}</strong><span>{locked && <Lock size={11} />}{locked ? t("animation.builtin.badge") : asset.kind === "skeleton" ? t("animation.skeleton") : asset.kind === "motion-clip" ? t("animation.motionClip") : t("animation.binding.kind")}</span></button>; })}{!visible.length && <p>{t("animation.empty")}</p>}</div></section>
    <main className="pixel-panel animation-preview">{stored && skeleton ? <><header>{renaming && !builtin ? <input className="px-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void saveName()} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /> : <h2>{stored.name}</h2>}<div>{builtin ? <span className="animation-builtin-badge"><Lock size={13} />{t("animation.builtin.badge")}</span> : <><button className="px-btn icon" onClick={() => setRenaming(true)} title={t("animation.rename")}><Pencil size={14} /></button><button className="px-btn icon danger" onClick={() => void remove()} title={t("common.delete")}><Trash2 size={14} /></button></>}</div></header>
      {builtin && <aside className="animation-builtin-notice"><Lock size={20} /><div><strong>{t("animation.builtin.title")}</strong><p>{t(clip ? "animation.builtin.clipHint" : "animation.builtin.skeletonHint")}</p></div>{clip && <button className="px-btn accent" disabled={busy} onClick={() => void copyBuiltinClip()}><Copy size={14} />{t("animation.builtin.copyEdit")}</button>}</aside>}
      {stored.kind === "skeleton" && <SkeletonPreview skeleton={skeleton} time={0} />}
      {binding && <BindingEditor binding={binding} skeleton={skeleton} materials={materials} busy={busy} onSave={async (next) => { setBusy(true); try { const saved = await api.putAnimationAsset(next.id, next); setStored(saved.asset); notify(t("animation.binding.saved"), "info"); } catch (e) { notify(t("animation.saveFailed", { msg: (e as Error).message })); } finally { setBusy(false); } }} />}
      {clip && <>
        <div className="animation-motion-compose">
        <section className="animation-motion-stage">
        <SkeletonPreview skeleton={skeleton} clip={previewClip} rangeClip={clip} time={time} selectedBone={selectedBone} disabled={playing} onSelectBone={selectBone} onEditBone={builtin ? undefined : editBoneOnCanvas} />
        <div className="animation-controls"><button className="px-btn accent" disabled={busy} onClick={() => setPlaying((v) => !v)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? t("animation.pause") : t("animation.play")}</button><input type="range" min="0" max={clip.duration} step="0.001" value={time} onChange={(e) => { setPlaying(false); setTime(+e.target.value); }} /><span>{time.toFixed(2)}s / {clip.duration.toFixed(2)}s</span><label className="px-check"><input type="checkbox" checked={clip.loop} disabled={busy || builtin} onChange={(event) => void toggleLoop(event.target.checked)} />{t("animation.loop")}</label>{clip.loop && <button className="px-btn" disabled={busy || builtin} onClick={() => skeleton && void commitClipEdit(closeMotionLoopSeam(clip, skeleton))}>{t("animation.closeLoopSeam")}</button>}</div>

        <ol className="animation-quick-guide" aria-label={t("animation.guide.title")}>
          <li><b>1</b><span>{t("animation.guide.time")}</span></li>
          <li><b>2</b><span>{t("animation.guide.bone")}</span></li>
          <li><b>3</b><span>{t("animation.guide.pose")}</span></li>
          <li><b>4</b><span>{t("animation.guide.save")}</span></li>
        </ol>
        </section>

        <section className="animation-key-editor">
          <header className="animation-pose-heading">
            <div><span>{time.toFixed(2)}s</span><h3>{t("animation.poseEditor")}</h3></div>
            <div><button className="px-btn icon" disabled={busy || builtin || !undo.length} onClick={() => void travelHistory("undo")} title={t("animation.undo")}><Undo2 size={14} /></button><button className="px-btn icon" disabled={busy || builtin || !redo.length} onClick={() => void travelHistory("redo")} title={t("animation.redo")}><Redo2 size={14} /></button></div>
          </header>
          <label className="animation-bone-picker">{t("animation.bone")}<PxSelect value={selectedBone} disabled={busy} options={skeleton.bones.map((bone) => ({ value: bone.id, label: bone.name }))} onChange={selectBone} /></label>
          <p className="animation-bone-hint">{t(isRootBone ? "animation.rootHint" : "animation.jointHint")}</p>
          {isRootBone && <div className="animation-root-fields">{numberField("tx", t("animation.translationX"))}{numberField("ty", t("animation.translationY"))}</div>}
          <div className="animation-rotation-editor">
            <label>{t("animation.rotationZ")}<input type="range" min="-180" max="180" step="1" value={draft.rz} disabled={busy || builtin} onChange={(event) => { setPlaying(false); setDraft((old) => ({ ...old, rz: +event.target.value })); }} /></label>
            <button className="px-btn" type="button" disabled={busy || builtin} onClick={() => nudgeRotation(-5)}>{t("animation.rotateLeftShort")}</button>
            <input className="px-input" type="number" min="-180" max="180" step="1" value={draft.rz} disabled={busy || builtin} aria-label={t("animation.rotationZ")} onChange={(event) => { setPlaying(false); setDraft((old) => ({ ...old, rz: +event.target.value })); }} />
            <button className="px-btn" type="button" disabled={busy || builtin} onClick={() => nudgeRotation(5)}>{t("animation.rotateRightShort")}</button>
          </div>
          <details className="animation-transform-advanced">
            <summary>{t("animation.advancedTransform")}</summary>
            <p>{t("animation.advancedTransformHint")}</p>
            <div className="animation-transform-fields">{!isRootBone && numberField("tx", t("animation.translationX"))}{!isRootBone && numberField("ty", t("animation.translationY"))}{numberField("sx", t("animation.scaleX"))}{numberField("sy", t("animation.scaleY"))}</div>
          </details>
          <div className="animation-pose-actions">
            <span className={poseDraftDirty ? "dirty" : hasCurrentKey ? "has-key" : ""}>{t(poseDraftDirty ? "animation.unsavedPose" : hasCurrentKey ? "animation.currentKey" : "animation.noCurrentKey")}</span>
            <button className="px-btn" type="button" disabled={builtin || !selectedBoneInfo} onClick={resetSelectedBone}><RotateCcw size={13} />{t("animation.resetBone")}</button>
            <button className="px-btn accent" disabled={busy || builtin || !selectedBone} onClick={() => void writeKey()}>{t(hasCurrentKey ? "animation.updatePose" : "animation.savePose")}</button>
            <button className="px-btn danger" disabled={busy || builtin || !hasCurrentKey} onClick={() => void deleteKey()}>{t("animation.deleteKey")}</button>
          </div>
        </section>
        </div>

        <details className="animation-clip-tools">
          <summary>{t("animation.advancedSettings")}</summary>
          <label>{t("animation.rootMotion")}<PxSelect value={clip.rootMotion ?? ""} disabled={busy || builtin} options={[{ value: "", label: t("animation.unspecified") }, { value: "preserve", label: t("animation.root.preserve") }, { value: "in-place", label: t("animation.root.inPlace") }, { value: "extracted", label: t("animation.root.extracted") }]} onChange={(value) => void setRootMotion(value)} /></label>
          <div className="animation-event-form"><input className="px-input" value={eventDraft.type} disabled={busy || builtin} placeholder={t("animation.eventType")} onChange={(e) => setEventDraft((old) => ({ ...old, type: e.target.value }))} /><input className="px-input" value={eventDraft.name} disabled={busy || builtin} placeholder={t("animation.eventName")} onChange={(e) => setEventDraft((old) => ({ ...old, name: e.target.value }))} /><textarea className="px-input" rows={2} value={eventDraft.payload} disabled={busy || builtin} aria-invalid={!!eventPayloadError} placeholder={t("animation.eventPayload")} onChange={(e) => { setEventDraft((old) => ({ ...old, payload: e.target.value })); setEventPayloadError(""); }} />{eventPayloadError && <span className="animation-event-error">{eventPayloadError}</span>}<button className="px-btn" disabled={busy || builtin || !eventDraft.type.trim() || !eventDraft.name.trim() || (clip.loop && time >= clip.duration)} onClick={() => void addEvent()}>{t("animation.addEvent")}</button></div>
          <div className="animation-event-list">{clip.events.map((event, index) => <div key={`${event.time}-${index}`}><button onClick={() => { setPlaying(false); setTime(event.time); }}><span>{event.time.toFixed(3)}s · {event.type} · {event.name}</span>{event.payload && <code>{JSON.stringify(event.payload)}</code>}</button><button className="px-btn icon danger" disabled={busy || builtin} title={t("common.delete")} onClick={() => void commitClipEdit(deleteMotionEvent(clip, index))}><Trash2 size={12} /></button></div>)}</div>
        </details>

        <section className="animation-timeline">
          <header><div><h3>{t("animation.timeline")}</h3><p>{t("animation.timelineHint")}</p></div><button className="px-btn" disabled={busy || builtin || !clip.tracks.some((track) => track.interpolation === "step")} onClick={() => void smoothAllTracks()}>{t("animation.interpolation.smoothAll")}</button></header>
          <div className="animation-timeline-ruler"><span /><div><i style={{ left: "0%" }}>0s</i><i style={{ left: "50%" }}>{(clip.duration / 2).toFixed(2)}s</i><i style={{ left: "100%" }}>{clip.duration.toFixed(2)}s</i></div><span /></div>
          <div className="animation-tracks">{clip.tracks.map((track) => <div className={`animation-track${track.targetId === selectedBone ? " selected" : ""}`} key={`${track.targetId}-${track.property}`}>
            <span>{skeleton.bones.find((bone) => bone.id === track.targetId)?.name ?? t("animation.unknownBone")} · {t(`animation.channel.${track.property}`)}</span>
            <div className="animation-track-lane" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setPlaying(false); setTime(Math.max(0, Math.min(clip.duration, (event.clientX - bounds.left) / bounds.width * clip.duration))); }}>
              {track.keyframes.map((key, k) => <button className="animation-key-dot" aria-label={`${key.time}s`} key={k} onClick={(event) => { event.stopPropagation(); setTime(key.time); selectBone(track.targetId); }} style={{ left: `${clip.duration ? key.time / clip.duration * 100 : 0}%` }} />)}
              <b className="animation-playhead" style={{ left: `${clip.duration ? time / clip.duration * 100 : 0}%` }} />
            </div>
            <div className="animation-track-interpolation"><button className={track.interpolation === "step" ? "on" : ""} disabled={busy || builtin} title={t("animation.interpolation.holdHint")} onClick={() => void setInterpolation(track.targetId, track.property, "step")}>{t("animation.interpolation.hold")}</button><button className={track.interpolation === "linear" ? "on" : ""} disabled={busy || builtin} title={t("animation.interpolation.smoothHint")} onClick={() => void setInterpolation(track.targetId, track.property, "linear")}>{t("animation.interpolation.smooth")}</button></div>
          </div>)}</div>
        </section>
      </>}
    </> : <p>{t("animation.selectHint")}</p>}</main>
  </div></>;
}
