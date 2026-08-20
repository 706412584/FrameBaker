import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { addMotionEvent, ATTACHMENT_TARGET_PREFIX, BUILTIN_ANIMATION_ASSET_IDS, closeMotionLoopSeam, DEFAULT_CUBIC_MOTION_INTERPOLATION, deleteMotionEvent, deleteMotionKeyframe, findMotionSegmentIndex, getBoneEndpoint, isAttachmentTargetId, isBuiltinAnimationAssetId, MOTION_KEY_TIME_EPSILON, multiplyMatrices, quaternionFromZRotation, reparentTransform2d, sampleMotionClip, setMotionSegmentInterpolation, transformPoint, transformToMatrix, upsertMotionKeyframe, zRotationFromQuaternion, type AnimationAsset, type AnimationAssetSummary, type AnyMotionTrack, type AttachmentOffset, type CharacterBinding, type CubicBezierMotionInterpolation, type JsonValue, type Mat4, type Material, type MotionClip, type MotionSegmentInterpolation, type MotionTrack, type MotionTrackV2, type RootMotionPolicy, type Skeleton } from "@framebaker/shared";
import { Copy, Crosshair, Lock, Move, Pause, Pencil, Play, Plus, Redo2, RotateCcw, RotateCw, Save, Trash2, Undo2, Upload, Waves, ZoomIn } from "lucide-react";
import { api, materialImageUrl, wsClient, type Folder } from "../api";
import { attachmentLocalBounds, attachmentLocalCorners, attachmentSvgImageY, fitAttachmentSizeToImage } from "../bindingGeometry";
import { localizeBoneName, localizeSkeletonName } from "../builtinAnimationLabels";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import FolderTree, { type FolderSelection } from "./FolderTree";
import { useMaterialEditor } from "./MaterialEditor";
import PxSelect from "./PxSelect";

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const identity = () => ({ translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
const BUILTIN_ASSET_ORDER = new Map<string, number>(BUILTIN_ANIMATION_ASSET_IDS.map((id, index) => [id, index]));
const DEFAULT_ATTACHMENT_DEFORM = { axis: "vertical" as const, bend: 0, sway: 0, frequency: 2, phase: 0 };
const WARP_MAPS = {
  vertical: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="128"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(128,128,0)"/><stop offset=".25" stop-color="rgb(136,128,0)"/><stop offset=".5" stop-color="rgb(160,128,0)"/><stop offset=".75" stop-color="rgb(200,128,0)"/><stop offset="1" stop-color="rgb(255,128,0)"/></linearGradient></defs><rect width="16" height="128" fill="url(#g)"/></svg>')}`,
  horizontal: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="16"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgb(128,128,0)"/><stop offset=".25" stop-color="rgb(128,136,0)"/><stop offset=".5" stop-color="rgb(128,160,0)"/><stop offset=".75" stop-color="rgb(128,200,0)"/><stop offset="1" stop-color="rgb(128,255,0)"/></linearGradient></defs><rect width="128" height="16" fill="url(#g)"/></svg>')}`,
};
const HUMANOID_COLLAPSED_SEMANTICS = new Set(["neck", "leftShoulder", "rightShoulder", "leftHip", "rightHip"]);
const HUMANOID_SEGMENT_ORIGIN: Record<string, string> = {
  head: "neck",
  leftElbow: "leftShoulder",
  rightElbow: "rightShoulder",
  leftKnee: "leftHip",
  rightKnee: "rightHip",
};

function pointToSegmentDistance(point: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }) {
  const dx = end.x - start.x, dy = end.y - start.y, lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - start.x - amount * dx, point.y - start.y - amount * dy);
}

function SkeletonPreview({ skeleton, clip, rangeClip, time, selectedBone, disabled, onSelectBone, onEditBone }: { skeleton: Skeleton; clip?: MotionClip; rangeClip?: MotionClip; time: number; selectedBone?: string; disabled?: boolean; onSelectBone?: (id: string) => void; onEditBone?: (id: string, patch: { tx?: number; ty?: number; rz?: number }) => void }) {
  const t = useT();
  const [camera, setCamera] = useState({ zoom: 1, x: 0, y: 0 });
  useEffect(() => setCamera({ zoom: 1, x: 0, y: 0 }), [skeleton.id, clip?.id]);
  const skeletonName = localizeSkeletonName(skeleton.id, skeleton.name, t);
  const boneName = (bone: Skeleton["bones"][number]) => localizeBoneName(skeleton.id, bone.id, bone.name, t);
  const humanoid = skeleton.semanticProfile?.id === "humanoid-v1";
  const isVisibleSegment = (bone: Skeleton["bones"][number]) => !humanoid || !bone.semantic || !HUMANOID_COLLAPSED_SEMANTICS.has(bone.semantic);
  const pose = useMemo(() => clip ? sampleMotionClip(clip, skeleton, time) : sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, 0), [clip, skeleton, time]);
  const points = skeleton.bones.map((bone) => transformPoint(pose.worldMatrices[bone.id]!, [0, 0, 0]));
  const segmentStarts = skeleton.bones.map((bone, index) => {
    const originSemantic = humanoid && bone.semantic ? HUMANOID_SEGMENT_ORIGIN[bone.semantic] : undefined;
    if (!originSemantic) return points[index]!;
    const originIndex = skeleton.bones.findIndex((item) => item.semantic === originSemantic);
    return originIndex >= 0 ? points[originIndex]! : points[index]!;
  });
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
  const baseX = bounds.minX - pad, viewWidth = width / camera.zoom, viewHeight = height / camera.zoom;
  const viewX = camera.zoom === 1 ? baseX : Math.max(baseX, Math.min(baseX + width - viewWidth, camera.x));
  const viewY = camera.zoom === 1 ? 0 : Math.max(0, Math.min(height - viewHeight, camera.y));
  const xy = (p: [number, number, number]) => ({ x: p[0], y: top - p[1] });
  const svgPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => { const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY; return point.matrixTransform(svg.getScreenCTM()?.inverse()); };
  const zoomCanvas = (event: React.WheelEvent<SVGSVGElement>) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    const zoom = Math.max(1, Math.min(8, camera.zoom * Math.exp(-event.deltaY * .0015)));
    if (Math.abs(zoom - camera.zoom) < 1e-6) return;
    if (zoom === 1) {
      setCamera({ zoom, x: baseX, y: 0 });
      return;
    }
    const nextWidth = width / zoom, nextHeight = height / zoom;
    const ratioX = (point.x - viewX) / viewWidth, ratioY = (point.y - viewY) / viewHeight;
    setCamera({
      zoom,
      x: Math.max(baseX, Math.min(baseX + width - nextWidth, point.x - ratioX * nextWidth)),
      y: Math.max(0, Math.min(height - nextHeight, point.y - ratioY * nextHeight)),
    });
  };
  const dragRef = useRef<{ id: string; root: boolean; origin: [number, number, number]; displayAngle: number; rotation: number; pointer: [number, number]; translation: [number, number, number] } | undefined>(undefined);
  const beginEdit = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    const candidates = skeleton.bones.map((bone, index) => {
      const start = xy(segmentStarts[index]!), end = ends[index] ? xy(ends[index]!) : start;
      return { bone, index, distance: pointToSegmentDistance(point, start, end) };
    }).filter((candidate) => isVisibleSegment(candidate.bone) && candidate.distance <= span * .035).sort((a, b) => a.distance - b.distance);
    if (!candidates.length) return;
    const selectedIndex = candidates.findIndex((candidate) => candidate.bone.id === selectedBone);
    const candidate = event.altKey
      ? candidates[selectedIndex >= 0 ? (selectedIndex + 1) % candidates.length : Math.min(1, candidates.length - 1)]!
      : candidates[selectedIndex >= 0 ? selectedIndex : 0]!;
    const { bone, index } = candidate, boneId = bone.id;
    onSelectBone?.(boneId);
    if (!onEditBone || disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = segmentStarts[index]!, end = ends[index] ?? origin;
    dragRef.current = { id: boneId, root: bone.parentId === null, origin, displayAngle: Math.atan2(end[1] - origin[1], end[0] - origin[0]), rotation: zRotationFromQuaternion(pose.local[boneId]!.rotation), pointer: [point.x, top - point.y], translation: pose.local[boneId]!.translation };
  };
  const moveEdit = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || !onEditBone) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY), x = point.x, y = top - point.y;
    if (drag.root) onEditBone(drag.id, { tx: drag.translation[0] + x - drag.pointer[0], ty: drag.translation[1] + y - drag.pointer[1] });
    else {
      const angle = drag.rotation + Math.atan2(y - drag.origin[1], x - drag.origin[0]) - drag.displayAngle;
      onEditBone(drag.id, { rz: Math.atan2(Math.sin(angle), Math.cos(angle)) * 180 / Math.PI });
    }
  };
  const endEdit = () => { dragRef.current = undefined; };
  const selectedInfo = skeleton.bones.find((bone) => bone.id === selectedBone);
  return <div className="animation-rig-stage"><div className="animation-rig-hud"><strong>{selectedInfo ? boneName(selectedInfo) : skeletonName}</strong><span>{t(disabled ? "animation.canvas.playing" : selectedInfo?.parentId === null ? "animation.canvas.dragRoot" : "animation.canvas.dragBone")} · {Math.round(camera.zoom * 100)}%</span></div><svg className={`animation-skeleton motion-clip-skeleton${onEditBone ? " interactive" : ""}`} viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} role="img" onWheel={zoomCanvas} onPointerDown={beginEdit} onPointerMove={moveEdit} onPointerUp={endEdit} onPointerCancel={endEdit}>
    {!humanoid && skeleton.bones.map((bone, index) => {
      const parentIndex = bone.parentId ? skeleton.bones.findIndex((item) => item.id === bone.parentId) : -1;
      if (parentIndex < 0 || !isVisibleSegment(skeleton.bones[parentIndex]!)) return null;
      const parent = xy(points[parentIndex]!), point = xy(points[index]!);
      return <line className="animation-rig-link" key={`link-${bone.id}`} x1={parent.x} y1={parent.y} x2={point.x} y2={point.y} />;
    })}
    {skeleton.bones.map((bone, index) => {
      if (!isVisibleSegment(bone)) return null;
      const start = xy(segmentStarts[index]!), end = ends[index] ? xy(ends[index]!) : start, selected = selectedBone === bone.id;
      return <g className={`animation-rig-bone${selected ? " selected" : ""}`} key={bone.id} role={onSelectBone ? "button" : undefined} tabIndex={onSelectBone ? 0 : undefined} aria-label={boneName(bone)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectBone?.(bone.id); } }}>
        <line className="bone-shadow" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
        <line className="bone-line" x1={start.x} y1={start.y} x2={end.x} y2={end.y}><title>{boneName(bone)}</title></line>
        <circle className="bone-handle" cx={end.x} cy={end.y} r={span * (selected ? .028 : .02)} />
      </g>;
    })}
    {skeleton.bones.map((bone, index) => { if (!isVisibleSegment(bone)) return null; const point = xy(segmentStarts[index]!); return <circle className={`animation-joint-node${selectedBone === bone.id ? " selected" : ""}`} key={`joint-${bone.id}`} cx={point.x} cy={point.y} r={span * .014} />; })}
  </svg><small>{onEditBone ? `${t("animation.canvas.hint")} ${t("animation.canvas.zoomHint")}` : `${skeletonName} · ${t("animation.canvas.zoomHint")}`}</small></div>;
}

export function SkeletonEditor({ skeleton, previewBinding, busy, onSave }: { skeleton: Skeleton; previewBinding?: CharacterBinding; busy: boolean; onSave: (next: Skeleton) => Promise<void> }) {
  const t = useT();
  const [draft, setDraft] = useState(() => structuredClone(skeleton));
  const [selectedBone, setSelectedBone] = useState(skeleton.bones[0]?.id ?? "");
  useEffect(() => { setDraft(structuredClone(skeleton)); setSelectedBone(skeleton.bones[0]?.id ?? ""); }, [skeleton]);
  const selected = draft.bones.find((bone) => bone.id === selectedBone);
  const sampled = useMemo(() => sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "skeleton-edit-rest", name: "Rest", skeletonId: draft.id, duration: 0, loop: false, tracks: [], events: [] }, draft, 0), [draft]);
  const patchBone = (id: string, patch: Partial<Skeleton["bones"][number]>) => setDraft((old) => ({ ...old, bones: old.bones.map((bone) => bone.id === id ? { ...bone, ...patch } : bone) }));
  const editOnCanvas = (id: string, patch: { tx?: number; ty?: number; rz?: number }) => {
    const bone = draft.bones.find((item) => item.id === id);
    if (!bone) return;
    const translation = [...bone.rest.translation] as [number, number, number];
    if (patch.tx !== undefined) translation[0] = patch.tx;
    if (patch.ty !== undefined) translation[1] = patch.ty;
    patchBone(id, { rest: { ...bone.rest, translation, rotation: patch.rz === undefined ? bone.rest.rotation : quaternionFromZRotation(patch.rz * Math.PI / 180) } });
  };
  const setRestNumber = (property: "tx" | "ty" | "rz" | "length" | "tipAngle", value: number) => {
    if (!selected || !Number.isFinite(value)) return;
    if (property === "length" || property === "tipAngle") {
      const current = selected.tipOffset ?? [40, 0, 0];
      const length = property === "length" ? Math.max(0, value) : Math.hypot(current[0], current[1]);
      const angle = property === "tipAngle" ? value * Math.PI / 180 : Math.atan2(current[1], current[0]);
      patchBone(selected.id, { tipOffset: [Math.cos(angle) * length, Math.sin(angle) * length, 0] });
      return;
    }
    const rest = structuredClone(selected.rest);
    if (property === "tx") rest.translation[0] = value;
    else if (property === "ty") rest.translation[1] = value;
    else rest.rotation = quaternionFromZRotation(value * Math.PI / 180);
    patchBone(selected.id, { rest });
  };
  const canParentTo = (parentId: string) => {
    let cursor: string | null = parentId;
    while (cursor) {
      if (cursor === selectedBone) return false;
      cursor = draft.bones.find((bone) => bone.id === cursor)?.parentId ?? null;
    }
    return true;
  };
  const changeParent = (parentId: string) => {
    if (!selected || (parentId && !canParentTo(parentId))) return;
    const oldParent = selected.parentId ? sampled.worldMatrices[selected.parentId]! : transformToMatrix(identity());
    const newParent = parentId ? sampled.worldMatrices[parentId]! : transformToMatrix(identity());
    patchBone(selected.id, { parentId: parentId || null, rest: reparentTransform2d(selected.rest, oldParent, newParent) });
  };
  const addBone = () => {
    if (!selected) return;
    const id = uid("bone"), translation = [...(selected.tipOffset ?? [40, 0, 0])] as [number, number, number];
    setDraft((old) => ({ ...old, bones: [...old.bones, { id, name: t("animation.skeletonEditor.newBoneName"), parentId: selected.id, rest: { ...identity(), translation }, tipOffset: [40, 0, 0] }] }));
    setSelectedBone(id);
  };
  const removeBone = () => {
    if (!selected || draft.bones.length <= 1 || draft.bones.some((bone) => bone.parentId === selected.id)) return;
    const next = draft.bones.find((bone) => bone.id !== selected.id)!;
    setDraft((old) => ({ ...old, bones: old.bones.filter((bone) => bone.id !== selected.id) }));
    setSelectedBone(selected.parentId ?? next.id);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(skeleton);
  const selectedLength = selected?.tipOffset ? Math.hypot(selected.tipOffset[0], selected.tipOffset[1]) : 0;
  const selectedDirection = selected?.tipOffset ? Math.atan2(selected.tipOffset[1], selected.tipOffset[0]) * 180 / Math.PI : 0;
  return <section className="skeleton-editor">
    {previewBinding
      ? <CharacterPreview binding={previewBinding} skeleton={draft} time={0} selectedBoneId={selectedBone} showSkeleton onSelectBone={setSelectedBone} />
      : <SkeletonPreview skeleton={draft} time={0} selectedBone={selectedBone} disabled={busy} onSelectBone={setSelectedBone} onEditBone={editOnCanvas} />}
    <aside className="skeleton-editor-inspector">
      <header><div><span>{t("animation.skeletonEditor.selectedBone")}</span><h3>{selected?.name}</h3></div><button className="px-btn" type="button" disabled={!selected || busy} onClick={addBone}><Plus size={13} />{t("animation.skeletonEditor.addChild")}</button></header>
      {selected && <>
        <label>{t("animation.skeletonEditor.boneName")}<input className="px-input" value={selected.name} disabled={busy} onChange={(event) => patchBone(selected.id, { name: event.target.value })} /></label>
        <label>{t("animation.skeletonEditor.parent")}<PxSelect value={selected.parentId ?? ""} disabled={busy} options={[{ value: "", label: t("animation.skeletonEditor.noParent") }, ...draft.bones.filter((bone) => bone.id !== selected.id && canParentTo(bone.id)).map((bone) => ({ value: bone.id, label: bone.name }))]} onChange={changeParent} /></label>
        <div className="skeleton-editor-fields">
          <label>{t("animation.translationX")}<input className="px-input" type="number" step="1" value={selected.rest.translation[0]} onChange={(event) => setRestNumber("tx", +event.target.value)} /></label>
          <label>{t("animation.translationY")}<input className="px-input" type="number" step="1" value={selected.rest.translation[1]} onChange={(event) => setRestNumber("ty", +event.target.value)} /></label>
          <label>{t("animation.rotationZ")}<input className="px-input" type="number" step="1" value={zRotationFromQuaternion(selected.rest.rotation) * 180 / Math.PI} onChange={(event) => setRestNumber("rz", +event.target.value)} /></label>
          <label>{t("animation.skeletonEditor.length")}<input className="px-input" type="number" min="0" step="1" value={Math.round(selectedLength * 100) / 100} onChange={(event) => setRestNumber("length", +event.target.value)} /></label>
          <label>{t("animation.skeletonEditor.direction")}<input className="px-input" type="number" step="1" value={Math.round(selectedDirection * 100) / 100} onChange={(event) => setRestNumber("tipAngle", +event.target.value)} /></label>
        </div>
        <button className="px-btn danger" type="button" disabled={busy || draft.bones.length <= 1 || draft.bones.some((bone) => bone.parentId === selected.id)} onClick={removeBone}><Trash2 size={13} />{t("animation.skeletonEditor.deleteBone")}</button>
      </>}
      <div className="skeleton-editor-actions"><span>{t(dirty ? "animation.skeletonEditor.unsaved" : "animation.skeletonEditor.saved")}</span><button className="px-btn accent" type="button" disabled={busy || !dirty} onClick={() => void onSave(draft)}>{t("common.save")}</button></div>
    </aside>
  </section>;
}

type BindingTransformTool = "translate" | "rotate" | "scale" | "pivot" | "warp";

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
  /** 动作编辑模式：拖拽/检查器产生部件偏移关键帧（att: 轨道）而非修改绑定 rest；tx/ty 为 rest 后局部像素、rz 为角度制，sx/sy 为缩放倍率，bend 为 deform 弯曲增量的绝对值。 */
  onTransformAttachmentOffset?: (id: string, patch: { tx?: number; ty?: number; rz?: number; sx?: number; sy?: number; bend?: number }) => void;
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
  deform: CharacterBinding["attachments"][number]["deform"];
  /** 骨骼世界 × 部件 rest（不含偏移）；偏移平移增量换算到此空间。 */
  restWorld: Mat4;
  /** 拖拽开始时的部件偏移（rz 弧度），偏移模式下以此累加。 */
  offsetStart: { tx: number; ty: number; rz: number; sx: number; sy: number };
}

/** 部件偏移（att: 轨道采样值）转为叠加矩阵（T×R×S）；无偏移时返回 undefined，行为与之前完全一致。 */
function attachmentOffsetMatrix(offset: AttachmentOffset | undefined): Mat4 | undefined {
  if (!offset || (!offset.translation && !offset.rotation && !offset.scale)) return undefined;
  return transformToMatrix({ translation: offset.translation ?? [0, 0, 0], rotation: offset.rotation ?? [0, 0, 0, 1], scale: offset.scale ?? [1, 1, 1] });
}

/** 部件当前有效 deform bend：绑定静态 bend + att: deform 轨道增量。 */
function effectiveDeformBend(attachment: CharacterBinding["attachments"][number], offset: AttachmentOffset | undefined): number | undefined {
  const bend = (attachment.deform?.bend ?? 0) + (offset?.deformBend ?? 0);
  return attachment.deform || offset?.deformBend ? bend : undefined;
}

export function CharacterPreview({ binding, skeleton, clip, time, selectedAttachmentId, selectedBoneId, showSkeleton = false, transformTool = "translate", onSelectAttachment, onSelectBone, onTransformAttachment, onTransformAttachmentOffset, onBeginTransform, onEndTransform }: CharacterPreviewProps) {
  const t = useT();
  const filterPrefix = useId().replaceAll(":", "");
  const boneName = (bone: Skeleton["bones"][number]) => localizeBoneName(skeleton.id, bone.id, bone.name, t);
  const pose = useMemo(() => sampleMotionClip(clip ?? { schemaVersion: 1, kind: "motion-clip", id: "binding-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, time, binding.boneRotationOffsets), [binding.boneRotationOffsets, clip, skeleton, time]);
  const canTransform = !!(onTransformAttachment || onTransformAttachmentOffset);
  const offsetMode = !!onTransformAttachmentOffset && !onTransformAttachment;
  // 素材图片在编辑器内被替换后，按 id  bump 版本号破除 <image> 缓存（与素材页同一 WS 模式）
  const [materialV, setMaterialV] = useState<Record<string, number>>({});
  useEffect(() => wsClient.subscribe((msg) => {
    if (msg.type !== "material_updated") return;
    const id = (msg.payload as { id?: string } | undefined)?.id;
    if (id) setMaterialV((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }), []);
  const dragRef = useRef<BindingTransformDrag | undefined>(undefined);
  const frozenViewBoxRef = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const viewBox = useMemo(() => {
    const previewClip = clip ?? { schemaVersion: 1 as const, kind: "motion-clip" as const, id: "preview-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] };
    const keyTimes = clip ? [...new Set([0, clip.duration, ...clip.tracks.flatMap((track) => track.keyframes.map((key) => key.time))])].sort((a, b) => a - b) : [0];
    const times = clip ? [...keyTimes, ...keyTimes.slice(1).map((end, index) => (keyTimes[index]! + end) / 2)] : keyTimes;
    const points = times.flatMap((sampleTime) => {
      const sampled = sampleMotionClip(previewClip, skeleton, sampleTime, binding.boneRotationOffsets);
      const attachmentPoints = binding.slots.flatMap((slot) => {
        const attachment = binding.attachments.find((item) => item.id === slot.attachmentId), bone = sampled.worldMatrices[slot.boneId];
        if (!attachment || !bone) return [];
        const restWorld = multiplyMatrices(bone, transformToMatrix(attachment.rest));
        const offset = attachmentOffsetMatrix(sampled.attachmentOffsets[slot.attachmentId]);
        const world = offset ? multiplyMatrices(restWorld, offset) : restWorld;
        const deform = attachment.deform ?? DEFAULT_ATTACHMENT_DEFORM;
        const bend = effectiveDeformBend(attachment, sampled.attachmentOffsets[slot.attachmentId]);
        const deformExtent = bend !== undefined ? Math.min(1, Math.abs(bend) + Math.abs(deform.sway)) * Math.max(...attachment.size) / 2 : 0;
        return attachmentLocalCorners(attachment.size, attachment.pivot).flatMap((point) => {
          const offset: [number, number] = deform.axis === "horizontal" ? [0, deformExtent] : [deformExtent, 0];
          return [transformPoint(world, [point[0] - offset[0], point[1] - offset[1], 0]), transformPoint(world, [point[0] + offset[0], point[1] + offset[1], 0])];
        });
      });
      const skeletonPoints = showSkeleton
        ? skeleton.bones.flatMap((bone) => {
          const matrix = sampled.worldMatrices[bone.id];
          if (!matrix) return [];
          const origin = transformPoint(matrix, [0, 0, 0]);
          const endpoint = getBoneEndpoint(sampled, skeleton, bone.id);
          return endpoint ? [origin, endpoint] : [origin];
        })
        : [];
      return [...attachmentPoints, ...skeletonPoints];
    });
    if (!points.length) return "-2 -2 4 4";
    const minX = Math.min(...points.map((point) => point[0])), maxX = Math.max(...points.map((point) => point[0]));
    const minY = Math.min(...points.map((point) => point[1])), maxY = Math.max(...points.map((point) => point[1]));
    const pad = Math.max(.2, Math.max(maxX - minX, maxY - minY) * .12);
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
    if (canTransform && attachment.id !== selectedAttachmentId) return;
    onSelectAttachment?.(attachment.id);
    if (!canTransform) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const point = svgPoint(svg, event.clientX, event.clientY), start: [number, number] = [point.x, -point.y];
    const pivot = transformPoint(world, [0, 0, 0]), pivotWorld: [number, number] = [pivot[0], pivot[1]];
    event.preventDefault();
    event.stopPropagation();
    svg.setPointerCapture(event.pointerId);
    frozenViewBoxRef.current = viewBox;
    const offset = pose.attachmentOffsets[attachment.id];
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
      deform: attachment.deform ? structuredClone(attachment.deform) : undefined,
      restWorld: multiplyMatrices(bone, transformToMatrix(attachment.rest)),
      offsetStart: { tx: offset?.translation?.[0] ?? 0, ty: offset?.translation?.[1] ?? 0, rz: offset?.rotation ? zRotationFromQuaternion(offset.rotation) : 0, sx: offset?.scale?.[0] ?? 1, sy: offset?.scale?.[1] ?? 1 },
    };
    onBeginTransform?.();
    setDragging(true);
  };
  const moveTransform = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || (!onTransformAttachment && !onTransformAttachmentOffset)) return;
    const svgPointValue = svgPoint(event.currentTarget, event.clientX, event.clientY), point: [number, number] = [svgPointValue.x, -svgPointValue.y];
    if (drag.tool === "translate") {
      const worldX = point[0] - drag.start[0], worldY = point[1] - drag.start[1];
      // 偏移轨道叠加在 rest 之后，平移增量需换算到 rest 后的局部空间（drag.restWorld）；rest 编辑则换算到骨骼空间（drag.bone）
      const basis = onTransformAttachmentOffset ? drag.restWorld : drag.bone;
      const determinant = basis[0] * basis[5] - basis[1] * basis[4];
      if (Math.abs(determinant) < 1e-8) return;
      let localX = (basis[5] * worldX - basis[4] * worldY) / determinant;
      let localY = (-basis[1] * worldX + basis[0] * worldY) / determinant;
      if (event.shiftKey) [localX, localY] = Math.abs(localX) >= Math.abs(localY) ? [localX, 0] : [0, localY];
      if (onTransformAttachmentOffset) {
        onTransformAttachmentOffset(drag.id, { tx: drag.offsetStart.tx + localX, ty: drag.offsetStart.ty + localY });
        return;
      }
      onTransformAttachment!(drag.id, { rest: { ...drag.rest, translation: [drag.rest.translation[0] + localX, drag.rest.translation[1] + localY, drag.rest.translation[2]] } });
      return;
    }
    if (drag.tool === "rotate") {
      const currentAngle = Math.atan2(point[1] - drag.pivotWorld[1], point[0] - drag.pivotWorld[0]);
      if (onTransformAttachmentOffset) {
        let angle = drag.offsetStart.rz + currentAngle - drag.startAngle;
        if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
        onTransformAttachmentOffset(drag.id, { rz: Math.atan2(Math.sin(angle), Math.cos(angle)) * 180 / Math.PI });
        return;
      }
      let angle = zRotationFromQuaternion(drag.rest.rotation) + currentAngle - drag.startAngle;
      if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
      onTransformAttachment!(drag.id, { rest: { ...drag.rest, rotation: quaternionFromZRotation(angle) } });
      return;
    }
    if (drag.tool === "scale") {
      if (drag.startDistance < 1e-8) return;
      const factor = Math.max(.05, Math.min(20, Math.hypot(point[0] - drag.pivotWorld[0], point[1] - drag.pivotWorld[1]) / drag.startDistance));
      if (onTransformAttachmentOffset) {
        onTransformAttachmentOffset(drag.id, { sx: drag.offsetStart.sx * factor, sy: drag.offsetStart.sy * factor });
        return;
      }
      if (!onTransformAttachment) return;
      onTransformAttachment(drag.id, { rest: { ...drag.rest, scale: [drag.rest.scale[0] * factor, drag.rest.scale[1] * factor, drag.rest.scale[2]] } });
      return;
    }
    if (!onTransformAttachment) return;
    if (drag.tool === "warp") {
      const determinant = drag.world[0] * drag.world[5] - drag.world[1] * drag.world[4];
      if (Math.abs(determinant) < 1e-8) return;
      const worldX = point[0] - drag.start[0], worldY = point[1] - drag.start[1];
      const localX = (drag.world[5] * worldX - drag.world[4] * worldY) / determinant;
      const localY = (-drag.world[1] * worldX + drag.world[0] * worldY) / determinant;
      const deform = drag.deform ?? DEFAULT_ATTACHMENT_DEFORM;
      const delta = (deform.axis === "vertical" ? localX : localY) / Math.max(...drag.size);
      onTransformAttachment(drag.id, { deform: { ...deform, bend: Math.max(-1, Math.min(1, deform.bend + delta * 2)) } });
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
  const selectedWorld = selectedAttachment && selectedBoneMatrix ? (() => {
    const restWorld = multiplyMatrices(selectedBoneMatrix, transformToMatrix(selectedAttachment.rest));
    const offset = attachmentOffsetMatrix(pose.attachmentOffsets[selectedAttachment.id]);
    return offset ? multiplyMatrices(restWorld, offset) : restWorld;
  })() : undefined;
  const selectedGeometry = selectedAttachment && selectedWorld ? (() => {
    const [width, height] = selectedAttachment.size;
    const { left, right, top } = attachmentLocalBounds(selectedAttachment.size, selectedAttachment.pivot);
    const corners = attachmentLocalCorners(selectedAttachment.size, selectedAttachment.pivot).map((point) => transformPoint(selectedWorld, [...point]));
    const rotateStem = transformPoint(selectedWorld, [(left + right) / 2, top, 0]);
    const rotate = transformPoint(selectedWorld, [(left + right) / 2, top + Math.max(width, height) * .13, 0]);
    return { corners, pivot: transformPoint(selectedWorld, [0, 0, 0]), rotateStem, rotate, scale: corners[2]! };
  })() : undefined;
  return <svg className={`animation-skeleton binding-preview${canTransform ? " interactive" : ""}`} data-tool={transformTool} data-offset-mode={offsetMode || undefined} viewBox={dragging ? frozenViewBoxRef.current : viewBox} role="img" onPointerMove={moveTransform} onPointerUp={endTransform} onPointerCancel={endTransform}>
    <defs>{binding.attachments.filter((attachment) => effectiveDeformBend(attachment, pose.attachmentOffsets[attachment.id]) !== undefined).map((attachment) => {
      const deform = attachment.deform ?? DEFAULT_ATTACHMENT_DEFORM;
      const bend = effectiveDeformBend(attachment, pose.attachmentOffsets[attachment.id])!;
      // bend 取「绑定静态值 + att: deform 轨道增量」，sway 仍按绑定参数随时间摆动，二者叠加
      const amount = Math.max(-1, Math.min(1, bend + deform.sway * Math.sin(time * Math.PI * 2 * deform.frequency + deform.phase)));
      return <filter id={`${filterPrefix}-warp-${attachment.id}`} key={attachment.id} x="-100%" y="-100%" width="300%" height="300%" colorInterpolationFilters="sRGB"><feImage href={WARP_MAPS[deform.axis]} preserveAspectRatio="none" result="warp-map" /><feDisplacementMap in="SourceGraphic" in2="warp-map" scale={amount * Math.max(...attachment.size)} xChannelSelector="R" yChannelSelector="G" /></filter>;
    })}</defs>
    <g transform="scale(1 -1)">{[...binding.slots].sort((a, b) => a.drawOrder - b.drawOrder).map((slot) => {
      const attachment = binding.attachments.find((item) => item.id === slot.attachmentId), matrix = pose.worldMatrices[slot.boneId];
      if (!attachment || !matrix) return null;
      const restWorld = multiplyMatrices(matrix, transformToMatrix(attachment.rest)), offset = attachmentOffsetMatrix(pose.attachmentOffsets[slot.attachmentId]);
      const world = offset ? multiplyMatrices(restWorld, offset) : restWorld, [w, h] = attachment.size, [px] = attachment.pivot;
      const deformed = effectiveDeformBend(attachment, pose.attachmentOffsets[slot.attachmentId]) !== undefined;
      return <g key={slot.id}>
        <image className={`${selectedAttachmentId === attachment.id ? "selected" : ""}${deformed ? " deformed" : ""}`} href={materialImageUrl(attachment.materialId, materialV[attachment.materialId], attachment.imageSlot)} x={-px * w} y={attachmentSvgImageY(attachment.size, attachment.pivot)} width={w} height={h} preserveAspectRatio="none" filter={deformed ? `url(#${filterPrefix}-warp-${attachment.id})` : undefined} transform={`matrix(${world[0]} ${world[1]} ${world[4]} ${world[5]} ${world[12]} ${world[13]}) scale(1 -1)`} onPointerDown={canTransform && selectedAttachmentId === attachment.id ? (event) => beginTransform(event, attachment, matrix, world) : undefined} onClick={onSelectAttachment ? () => onSelectAttachment(attachment.id) : undefined} />
      </g>;
    })}{showSkeleton && <g className="binding-bone-overlay">
      {skeleton.bones.map((bone) => {
        const matrix = pose.worldMatrices[bone.id];
        if (!matrix) return null;
        const start = transformPoint(matrix, [0, 0, 0]);
        const child = skeleton.bones.find((item) => item.parentId === bone.id);
        const end = bone.tipOffset
          ? transformPoint(matrix, bone.tipOffset)
          : child && pose.worldMatrices[child.id]
            ? transformPoint(pose.worldMatrices[child.id]!, [0, 0, 0])
            : null;
        if (!end || Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-8) return null;
        return <line className={selectedBoneId === bone.id ? "selected" : ""} key={`bone-${bone.id}`} x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} />;
      })}
      {skeleton.bones.map((bone) => {
        const matrix = pose.worldMatrices[bone.id];
        if (!matrix) return null;
        const point = transformPoint(matrix, [0, 0, 0]);
        return <g className={selectedBoneId === bone.id ? "selected" : ""} key={`node-${bone.id}`} role={onSelectBone ? "button" : undefined} tabIndex={onSelectBone ? 0 : undefined} aria-label={boneName(bone)} onPointerDown={onSelectBone ? (event) => { event.preventDefault(); event.stopPropagation(); onSelectBone(bone.id); } : undefined} onKeyDown={onSelectBone ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectBone(bone.id); } } : undefined}>
          <circle className="binding-bone-node" cx={point[0]} cy={point[1]} r={selectedBoneId === bone.id ? boneNodeRadius * 1.45 : boneNodeRadius}><title>{boneName(bone)}</title></circle>
        </g>;
      })}
    </g>}{selectedGeometry && selectedAttachment && selectedBoneMatrix && selectedWorld && <g className="binding-transform-overlay">
      <polygon className="binding-selection-outline" points={selectedGeometry.corners.map((point) => `${point[0]},${point[1]}`).join(" ")} onPointerDown={(event) => beginTransform(event, selectedAttachment, selectedBoneMatrix, selectedWorld)} />
      <line className="binding-rotate-stem" x1={selectedGeometry.rotateStem[0]} y1={selectedGeometry.rotateStem[1]} x2={selectedGeometry.rotate[0]} y2={selectedGeometry.rotate[1]} />
      <circle className="binding-transform-handle rotate" cx={selectedGeometry.rotate[0]} cy={selectedGeometry.rotate[1]} r={handleRadius} onPointerDown={(event) => beginTransform(event, selectedAttachment, selectedBoneMatrix, selectedWorld, "rotate")}><title>{t("animation.binding.toolRotate")}</title></circle>
      <rect className="binding-transform-handle scale" x={selectedGeometry.scale[0] - handleRadius} y={selectedGeometry.scale[1] - handleRadius} width={handleRadius * 2} height={handleRadius * 2} onPointerDown={(event) => beginTransform(event, selectedAttachment, selectedBoneMatrix, selectedWorld, "scale")}><title>{t("animation.binding.toolScale")}</title></rect>
      {!offsetMode && <circle className="binding-transform-handle pivot" cx={selectedGeometry.pivot[0]} cy={selectedGeometry.pivot[1]} r={handleRadius * .82} onPointerDown={(event) => beginTransform(event, selectedAttachment, selectedBoneMatrix, selectedWorld, "pivot")}><title>{t("animation.binding.toolPivot")}</title></circle>}
      {!offsetMode && <line className="binding-pivot-cross" x1={selectedGeometry.pivot[0] - handleRadius * 1.5} y1={selectedGeometry.pivot[1]} x2={selectedGeometry.pivot[0] + handleRadius * 1.5} y2={selectedGeometry.pivot[1]} />}
      {!offsetMode && <line className="binding-pivot-cross" x1={selectedGeometry.pivot[0]} y1={selectedGeometry.pivot[1] - handleRadius * 1.5} x2={selectedGeometry.pivot[0]} y2={selectedGeometry.pivot[1] + handleRadius * 1.5} />}
    </g>}</g>
  </svg>;
}

export function BindingEditor({ binding, skeleton, materials, materialFolders, busy, onSave, onMaterialsChanged }: { binding: CharacterBinding; skeleton: Skeleton; materials: Material[]; materialFolders: Folder[]; busy: boolean; onSave: (value: CharacterBinding) => Promise<void>; onMaterialsChanged?: () => void }) {
  const firstSlot = binding.slots[0];
  const t = useT();
  const openMaterialEditor = useMaterialEditor();
  const boneName = (bone: Skeleton["bones"][number]) => localizeBoneName(skeleton.id, bone.id, bone.name, t);
  const attachmentName = (attachment: CharacterBinding["attachments"][number]) =>
    attachment.name === "区域附件" || attachment.name === "Region"
      ? materials.find((material) => material.id === attachment.materialId)?.name ?? attachment.name
      : attachment.name;
  const [draft, setDraft] = useState(binding), [selectedAttachmentId, setSelectedAttachmentId] = useState(binding.attachments[0]?.id ?? ""), [selectedBoneId, setSelectedBoneId] = useState(firstSlot?.boneId ?? skeleton.bones[0]?.id ?? "");
  const [transformTool, setTransformTool] = useState<BindingTransformTool>("translate"), [undoDrafts, setUndoDrafts] = useState<CharacterBinding[]>([]), [redoDrafts, setRedoDrafts] = useState<CharacterBinding[]>([]);
  const [fittingAspect, setFittingAspect] = useState(false);
  const initialMaterial = materials.find((item) => item.id === binding.attachments[0]?.materialId);
  const [materialFolder, setMaterialFolder] = useState<FolderSelection>(initialMaterial?.folder_id ?? (initialMaterial ? "ungrouped" : "all"));
  const draftRef = useRef(draft), continuousEditRef = useRef<CharacterBinding | undefined>(undefined), fitRequestRef = useRef(0);
  draftRef.current = draft;
  const restPose = useMemo(() => sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "binding-editor-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, 0, draft.boneRotationOffsets), [draft.boneRotationOffsets, skeleton]);
  const defaultAttachmentSize = useMemo(() => {
    const points = skeleton.bones.flatMap((bone) => {
      const world = restPose.worldMatrices[bone.id];
      if (!world) return [];
      const origin = transformPoint(world, [0, 0, 0]);
      const endpoint = getBoneEndpoint(restPose, skeleton, bone.id);
      return endpoint ? [origin, endpoint] : [origin];
    });
    if (!points.length) return 1;
    const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
    return Math.max(.5, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 4);
  }, [restPose, skeleton]);
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
    const id = uid("region"), boneId = selectedBoneId || skeleton.bones[0]?.id || "", order = draft.slots.length ? Math.max(...draft.slots.map((slot) => slot.drawOrder)) + 1 : 0;
    setDraft((old) => ({ ...old, attachments: [...old.attachments, { id, name: materials[0]?.name ?? t("animation.binding.region"), type: "region", materialId: materials[0]?.id ?? "", imageSlot: "raw", size: [defaultAttachmentSize, defaultAttachmentSize], pivot: [.5, .5], rest: identity() }], slots: [...old.slots, { id: uid("slot"), name: t("animation.binding.slot"), boneId, attachmentId: id, drawOrder: order }] }));
    setSelectedAttachmentId(id);
    setSelectedBoneId(boneId);
  };
  const selectedAttachment = draft.attachments.find((item) => item.id === selectedAttachmentId);
  const selectedSlotIndex = draft.slots.findIndex((item) => item.attachmentId === selectedAttachmentId);
  const selectedSlot = selectedSlotIndex >= 0 ? draft.slots[selectedSlotIndex] : undefined;
  const selectedMaterial = materials.find((item) => item.id === selectedAttachment?.materialId);
  const selectedSlotBone = selectedSlot ? skeleton.bones.find((bone) => bone.id === selectedSlot.boneId) : undefined;
  const selectedSlotBoneName = selectedSlotBone ? boneName(selectedSlotBone) : selectedSlot?.boneId ?? "";
  const selectedSlotName = selectedSlot?.name?.trim() || (selectedAttachment ? attachmentName(selectedAttachment) : "");
  const materialFolderOptions = useMemo(() => {
    const byId = new Map(materialFolders.map((folder) => [folder.id, folder]));
    const pathOf = (folder: Folder) => {
      const names = [folder.name];
      const seen = new Set([folder.id]);
      let parentId = folder.parent_id;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        names.unshift(parent.name);
        parentId = parent.parent_id;
      }
      return names.join(" / ");
    };
    return [
      { value: "all", label: t("msg.all") },
      { value: "ungrouped", label: t("msg.ungrouped") },
      ...materialFolders.map((folder) => ({ value: folder.id, label: pathOf(folder) })),
    ];
  }, [materialFolders, t]);
  const visibleMaterials = useMemo(() => {
    if (materialFolder === "all") return materials;
    if (materialFolder === "ungrouped") return materials.filter((item) => !item.folder_id);
    return materials.filter((item) => item.folder_id === materialFolder);
  }, [materialFolder, materials]);
  const materialOptions = useMemo(() => {
    const options = visibleMaterials.map((item) => ({ value: item.id, label: item.name }));
    return selectedMaterial && !visibleMaterials.some((item) => item.id === selectedMaterial.id)
      ? [{ value: selectedMaterial.id, label: t("animation.binding.currentMaterial", { name: selectedMaterial.name }) }, ...options]
      : options;
  }, [selectedMaterial, t, visibleMaterials]);
  const selectedBone = skeleton.bones.find((bone) => bone.id === selectedBoneId);
  const selectedBoneOffset = (draft.boneRotationOffsets?.[selectedBoneId] ?? 0) * 180 / Math.PI;
  const setSelectedBoneOffset = (degrees: number) => {
    if (!selectedBone) return;
    setDraft((old) => {
      const boneRotationOffsets = { ...old.boneRotationOffsets };
      if (Math.abs(degrees) < 1e-8) delete boneRotationOffsets[selectedBone.id];
      else boneRotationOffsets[selectedBone.id] = degrees * Math.PI / 180;
      const next = { ...old, ...(Object.keys(boneRotationOffsets).length ? { boneRotationOffsets } : { boneRotationOffsets: undefined }) };
      draftRef.current = next;
      return next;
    });
  };
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
  const fitRegionToMaterial = async (attachment: CharacterBinding["attachments"][number], materialId: string, imageSlot: "raw" | "processed", remember = true) => {
    const requestId = ++fitRequestRef.current;
    setFittingAspect(true);
    try {
      const response = await fetch(materialImageUrl(materialId, undefined, imageSlot, undefined, true));
      if (!response.ok) throw new Error(`${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      const current = draftRef.current.attachments.find((item) => item.id === attachment.id);
      if (requestId !== fitRequestRef.current || !current || current.materialId !== materialId || current.imageSlot !== imageSlot) {
        bitmap.close();
        return;
      }
      const size = fitAttachmentSizeToImage(current.size, bitmap.width, bitmap.height);
      bitmap.close();
      if (remember) rememberDraft();
      patchRegion(attachment.id, { size });
    } catch (error) {
      if (requestId === fitRequestRef.current) notify(t("animation.binding.fitImageAspectFailed", { msg: (error as Error).message }));
    } finally {
      if (requestId === fitRequestRef.current) setFittingAspect(false);
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
      const tool = ({ v: "translate", r: "rotate", s: "scale", p: "pivot", w: "warp" } as const)[event.key.toLowerCase() as "v" | "r" | "s" | "p" | "w"];
      if (tool) {
        event.preventDefault();
        setTransformTool(tool);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [undoDrafts, redoDrafts]);
  return <section className="binding-editor">
    <header className="binding-editor-heading"><div><h3>{t("animation.binding.visualTitle")}</h3><p>{t("animation.binding.visualHint")}</p></div><div className="binding-editor-actions"><button className="px-btn" disabled={!materials.length} onClick={addRow}><Plus size={14} />{t("animation.binding.addRegion")}</button><button className="px-btn accent" disabled={busy} onClick={() => void onSave({ ...draftRef.current, slots: [...draftRef.current.slots].sort((a, b) => a.drawOrder - b.drawOrder).map((slot, drawOrder) => ({ ...slot, drawOrder })) })}><Save size={13} />{t("common.save")}</button></div></header>
    <section className="binding-part-strip"><header><strong>{t("animation.binding.parts")}</strong></header><div className="binding-part-list">{draft.slots.map((slot) => { const attachment = draft.attachments.find((item) => item.id === slot.attachmentId), bone = skeleton.bones.find((item) => item.id === slot.boneId), label = bone ? boneName(bone) : slot.boneId; if (!attachment) return null; const slotName = slot.name?.trim() || attachmentName(attachment); return <button type="button" className={selectedAttachmentId === attachment.id ? "selected" : ""} title={`${slotName} · ${attachmentName(attachment)} · ${label}`} key={slot.id} onClick={() => selectAttachment(attachment.id)}><span>{slotName}</span><small>{attachmentName(attachment)} · {label}</small></button>; })}</div></section>
    <div className="binding-calibration-workspace">
      <article className="binding-preview-card">
        <div className="binding-canvas-hud"><span><b>1</b>{t("animation.binding.guidePart")}</span><span><b>2</b>{t("animation.binding.guideBone")}</span><span><b>3</b>{t("animation.binding.guideTune")}</span></div>
        <div className="binding-canvas-toolbar" role="toolbar" aria-label={t("animation.binding.tools")}>
          <div className="binding-transform-tools">
            <button type="button" className={transformTool === "translate" ? "on" : ""} aria-pressed={transformTool === "translate"} title={t("animation.binding.toolMoveHint")} onClick={() => setTransformTool("translate")}><Move size={13} />{t("animation.binding.toolMove")}<kbd>V</kbd></button>
            <button type="button" className={transformTool === "rotate" ? "on" : ""} aria-pressed={transformTool === "rotate"} title={t("animation.binding.toolRotateHint")} onClick={() => setTransformTool("rotate")}><RotateCw size={13} />{t("animation.binding.toolRotate")}<kbd>R</kbd></button>
            <button type="button" className={transformTool === "scale" ? "on" : ""} aria-pressed={transformTool === "scale"} title={t("animation.binding.toolScaleHint")} onClick={() => setTransformTool("scale")}><ZoomIn size={13} />{t("animation.binding.toolScale")}<kbd>S</kbd></button>
            <button type="button" className={transformTool === "pivot" ? "on" : ""} aria-pressed={transformTool === "pivot"} title={t("animation.binding.toolPivotHint")} onClick={() => setTransformTool("pivot")}><Crosshair size={13} />{t("animation.binding.toolPivot")}<kbd>P</kbd></button>
            <button type="button" className={transformTool === "warp" ? "on" : ""} aria-pressed={transformTool === "warp"} title={t("animation.binding.toolWarpHint")} onClick={() => setTransformTool("warp")}><Waves size={13} />{t("animation.binding.toolWarp")}<kbd>W</kbd></button>
          </div>
          <span className="binding-current-link">{selectedAttachment ? `${selectedSlotName} → ${selectedBone ? boneName(selectedBone) : t("animation.binding.chooseBone")}` : t("animation.binding.choosePart")}</span>
          <div className="binding-history-actions"><button className="px-btn icon" disabled={!undoDrafts.length} onClick={() => travelDraftHistory("undo")} title={t("animation.binding.undo")}><Undo2 size={14} /></button><button className="px-btn icon" disabled={!redoDrafts.length} onClick={() => travelDraftHistory("redo")} title={t("animation.binding.redo")}><Redo2 size={14} /></button></div>
        </div>
        <div className="binding-joint-test"><span><RotateCw size={14} /><strong>{t("animation.binding.jointTest")}</strong><small>{t("animation.binding.jointTestHint")}</small></span><input type="range" min="-180" max="180" step="1" value={selectedBoneOffset} disabled={!selectedBone} onPointerDown={beginContinuousEdit} onPointerUp={endContinuousEdit} onPointerCancel={endContinuousEdit} onChange={(event) => setSelectedBoneOffset(Number(event.target.value))} /><output>{Math.round(selectedBoneOffset)}°</output><button type="button" className="px-btn" disabled={Math.abs(selectedBoneOffset) < 1e-8} onClick={() => { rememberDraft(); setSelectedBoneOffset(0); }}>{t("animation.binding.jointTestReset")}</button></div>
        <CharacterPreview binding={draft} skeleton={skeleton} time={0} selectedAttachmentId={selectedAttachmentId} selectedBoneId={selectedBoneId} showSkeleton transformTool={transformTool} onSelectAttachment={selectAttachment} onSelectBone={bindSelectedToBone} onTransformAttachment={patchRegion} onBeginTransform={beginContinuousEdit} onEndTransform={endContinuousEdit} />
        <p>{t("animation.binding.canvasHint")}</p>
      </article>
      <aside className="binding-inspector">{selectedAttachment && selectedSlot ? <>
        <header><div><span>{t("animation.binding.selectedPart")}</span><h3>{selectedSlotName}</h3><small>{t("animation.binding.boundTo", { bone: selectedSlotBoneName })}</small></div><button className="px-btn icon danger" title={t("common.delete")} onClick={removeSelected}><Trash2 size={13} /></button></header>
        <section className="binding-inspector-basics"><label>{t("animation.binding.slotName")}<input className="px-input" value={selectedSlot.name} onFocus={beginContinuousEdit} onBlur={endContinuousEdit} onChange={(event) => patchSlot(selectedSlotIndex, { name: event.target.value })} /></label><label>{t("animation.bone")}<PxSelect value={selectedSlot.boneId} options={skeleton.bones.map((bone) => ({ value: bone.id, label: boneName(bone) }))} onChange={bindSelectedToBone} /></label><label>{t("animation.binding.materialFolder")}<PxSelect value={materialFolder} options={materialFolderOptions} onChange={setMaterialFolder} /></label><label>{t("animation.binding.material")}<PxSelect value={selectedAttachment.materialId} options={materialOptions} onChange={(materialId) => { const imageSlot = materials.find((item) => item.id === materialId)?.processed_path ? "processed" : "raw"; rememberDraft(); patchRegion(selectedAttachment.id, { materialId, imageSlot }); void fitRegionToMaterial(selectedAttachment, materialId, imageSlot, false); }} /></label><label>{t("animation.binding.imageSlot")}<PxSelect value={selectedAttachment.imageSlot} options={[{ value: "raw", label: t("animation.binding.originalImage") }, { value: "processed", label: t("animation.binding.cutoutImage"), disabled: !selectedMaterial?.processed_path }]} onChange={(value) => { const imageSlot = value as "raw" | "processed"; rememberDraft(); patchRegion(selectedAttachment.id, { imageSlot }); void fitRegionToMaterial(selectedAttachment, selectedAttachment.materialId, imageSlot, false); }} /></label><button type="button" className="px-btn binding-fit-aspect" disabled={fittingAspect || !selectedAttachment.materialId} onClick={() => void fitRegionToMaterial(selectedAttachment, selectedAttachment.materialId, selectedAttachment.imageSlot)}>{t(fittingAspect ? "animation.binding.fittingImageAspect" : "animation.binding.fitImageAspect")}</button><button type="button" className="px-btn" disabled={!selectedAttachment.materialId} title={t("animation.binding.editMaterialHint")} onClick={() => openMaterialEditor({ id: selectedAttachment.materialId, name: attachmentName(selectedAttachment), onSaved: () => onMaterialsChanged?.() })}><Pencil size={13} />{t("animation.binding.editMaterial")}</button></section>
        <section className="binding-tuning"><h4>{t("animation.binding.restTransform")}</h4>{sliderField(t("animation.binding.translationX"), selectedAttachment.rest.translation[0], -translationRange, translationRange, .01, (value) => { const translation = [...selectedAttachment.rest.translation] as [number, number, number]; translation[0] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, translation } }); })}{sliderField(t("animation.binding.translationY"), selectedAttachment.rest.translation[1], -translationRange, translationRange, .01, (value) => { const translation = [...selectedAttachment.rest.translation] as [number, number, number]; translation[1] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, translation } }); })}{sliderField(t("animation.binding.rotation"), zRotationFromQuaternion(selectedAttachment.rest.rotation) * 180 / Math.PI, -180, 180, 1, (value) => patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, rotation: quaternionFromZRotation(value * Math.PI / 180) } }))}{sliderField(t("animation.binding.scaleX"), selectedAttachment.rest.scale[0], .05, scaleRange, .01, (value) => { const scale = [...selectedAttachment.rest.scale] as [number, number, number]; scale[0] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, scale } }); })}{sliderField(t("animation.binding.scaleY"), selectedAttachment.rest.scale[1], .05, scaleRange, .01, (value) => { const scale = [...selectedAttachment.rest.scale] as [number, number, number]; scale[1] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, scale } }); })}</section>
        <details className="binding-geometry"><summary>{t("animation.binding.deform")}</summary><label className="binding-order-field">{t("animation.binding.deformAxis")}<PxSelect value={selectedAttachment.deform?.axis ?? "vertical"} options={[{ value: "vertical", label: t("animation.binding.deformVertical") }, { value: "horizontal", label: t("animation.binding.deformHorizontal") }]} onChange={(axis) => { rememberDraft(); patchRegion(selectedAttachment.id, { deform: { ...(selectedAttachment.deform ?? DEFAULT_ATTACHMENT_DEFORM), axis: axis as "vertical" | "horizontal" } }); }} /></label>{sliderField(t("animation.binding.bend"), selectedAttachment.deform?.bend ?? 0, -1, 1, .01, (value) => patchRegion(selectedAttachment.id, { deform: { ...(selectedAttachment.deform ?? DEFAULT_ATTACHMENT_DEFORM), bend: value } }))}{sliderField(t("animation.binding.sway"), selectedAttachment.deform?.sway ?? 0, -1, 1, .01, (value) => patchRegion(selectedAttachment.id, { deform: { ...(selectedAttachment.deform ?? DEFAULT_ATTACHMENT_DEFORM), sway: value } }))}{sliderField(t("animation.binding.frequency"), selectedAttachment.deform?.frequency ?? 2, 0, 10, .1, (value) => patchRegion(selectedAttachment.id, { deform: { ...(selectedAttachment.deform ?? DEFAULT_ATTACHMENT_DEFORM), frequency: value } }))}{sliderField(t("animation.binding.phase"), (selectedAttachment.deform?.phase ?? 0) * 180 / Math.PI, -360, 360, 1, (value) => patchRegion(selectedAttachment.id, { deform: { ...(selectedAttachment.deform ?? DEFAULT_ATTACHMENT_DEFORM), phase: value * Math.PI / 180 } }))}<button type="button" className="px-btn" disabled={!selectedAttachment.deform} onClick={() => { rememberDraft(); patchRegion(selectedAttachment.id, { deform: undefined }); }}>{t("animation.binding.disableDeform")}</button></details>
        <details className="binding-geometry"><summary>{t("animation.binding.geometry")}</summary>{sliderField(t("animation.binding.pivotX"), selectedAttachment.pivot[0], 0, 1, .01, (value) => setSelectedPivot(0, value))}{sliderField(t("animation.binding.pivotY"), selectedAttachment.pivot[1], 0, 1, .01, (value) => setSelectedPivot(1, value))}{sliderField(t("animation.binding.width"), selectedAttachment.size[0], .01, sizeRange, .01, (value) => patchRegion(selectedAttachment.id, { size: [value, selectedAttachment.size[1]] }))}{sliderField(t("animation.binding.height"), selectedAttachment.size[1], .01, sizeRange, .01, (value) => patchRegion(selectedAttachment.id, { size: [selectedAttachment.size[0], value] }))}<label className="binding-order-field">{t("animation.binding.drawOrder")}<input className="px-input" type="number" step="1" value={selectedSlot.drawOrder} onFocus={beginContinuousEdit} onBlur={endContinuousEdit} onChange={(event) => patchSlot(selectedSlotIndex, { drawOrder: Number(event.target.value) })} /></label></details>
        <button className="px-btn" title={t("animation.binding.resetTransform")} onClick={() => { const original = binding.attachments.find((item) => item.id === selectedAttachment.id); if (original) { rememberDraft(); patchRegion(selectedAttachment.id, { rest: structuredClone(original.rest), pivot: [...original.pivot], size: [...original.size], deform: original.deform ? structuredClone(original.deform) : undefined }); } }}><Redo2 size={13} />{t("animation.binding.resetTransform")}</button>
      </> : <p className="animation-empty">{t("animation.binding.empty")}</p>}</aside>
    </div>
  </section>;
}

type AssetFilter = "all" | "skeleton" | "motion-clip";
type PoseDraft = { tx: number; ty: number; rz: number; sx: number; sy: number };
/** 部件偏移草稿：tx/ty 为 rest 后局部像素，rz 为角度制。 */
/** 部件偏移草稿：tx/ty 为 rest 后局部像素，rz 为角度制，sx/sy 为缩放倍率，bend 为 deform 弯曲增量。 */
type AttachmentDraft = { tx: number; ty: number; rz: number; sx: number; sy: number; bend: number };

const offsetToAttachmentDraft = (offset?: AttachmentOffset): AttachmentDraft => ({
  tx: offset?.translation?.[0] ?? 0,
  ty: offset?.translation?.[1] ?? 0,
  rz: offset?.rotation ? zRotationFromQuaternion(offset.rotation) * 180 / Math.PI : 0,
  sx: offset?.scale?.[0] ?? 1,
  sy: offset?.scale?.[1] ?? 1,
  bend: offset?.deformBend ?? 0,
});

const transformToPoseDraft = (transform: ReturnType<typeof sampleMotionClip>["local"][string]): PoseDraft => ({
  tx: transform.translation[0],
  ty: transform.translation[1],
  rz: zRotationFromQuaternion(transform.rotation) * 180 / Math.PI,
  sx: transform.scale[0],
  sy: transform.scale[1],
});

export default function AnimationAssetsWorkspace({ onOpenProjects, initialAssetId, previewBinding }: { onOpenProjects: () => void; initialAssetId?: string; previewBinding?: CharacterBinding }) {
  const t = useT(), inputRef = useRef<HTMLInputElement>(null);
  const openMaterialEditor = useMaterialEditor();
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]), [folders, setFolders] = useState<Folder[]>([]), [folder, setFolder] = useState<FolderSelection>("all");
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [selected, setSelected] = useState<string>(), [stored, setStored] = useState<AnimationAsset>(), [skeleton, setSkeleton] = useState<Skeleton>();
  const [createActionOpen, setCreateActionOpen] = useState(false);
  const [newAction, setNewAction] = useState({ name: "", skeletonId: "", duration: 1, loop: false });
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [renaming, setRenaming] = useState(false), [name, setName] = useState("");
  const [durationDraft, setDurationDraft] = useState("");
  const [selectedBone, setSelectedBone] = useState(""), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<PoseDraft>({ tx: 0, ty: 0, rz: 0, sx: 1, sy: 1 });
  const [stagedDrafts, setStagedDrafts] = useState<Record<string, PoseDraft>>({});
  const [selectedAttachmentId, setSelectedAttachmentId] = useState("");
  const [attachmentDraft, setAttachmentDraft] = useState<AttachmentDraft>({ tx: 0, ty: 0, rz: 0, sx: 1, sy: 1, bend: 0 });
  const [stagedAttachmentDrafts, setStagedAttachmentDrafts] = useState<Record<string, AttachmentDraft>>({});
  const [eventDraft, setEventDraft] = useState({ type: "", name: "", payload: "" });
  const [eventPayloadError, setEventPayloadError] = useState("");
  const [undo, setUndo] = useState<MotionClip[]>([]), [redo, setRedo] = useState<MotionClip[]>([]);
  const load = useCallback(async () => { const [a, f] = await Promise.all([api.listAnimationAssets(), api.listFolders("animation")]); setAssets(a); setFolders(f); }, []);
  useEffect(() => { void load().catch((e) => notify(t("animation.loadFailed", { msg: e.message }))); }, [load, t]);
  useEffect(() => {
    if (initialAssetId) setSelected(initialAssetId);
  }, [initialAssetId]);
  useEffect(() => {
    let active = true;
    if (!selected) { setStored(undefined); setSkeleton(undefined); return () => { active = false; }; }
    void api.getAnimationAsset(selected).then(async ({ asset }) => {
      const nextSkeleton = asset.kind === "skeleton" ? asset : (await api.getAnimationAsset(asset.skeletonId)).asset as Skeleton;
      if (!active) return;
      setStored(asset); setName(asset.name); setDurationDraft(asset.kind === "motion-clip" ? String(asset.duration) : ""); setTime(0); setPlaying(false); setSkeleton(nextSkeleton); setSelectedBone(nextSkeleton?.bones[0]?.id ?? ""); setStagedDrafts({}); setSelectedAttachmentId(""); setStagedAttachmentDrafts({}); setUndo([]); setRedo([]);
    }).catch((e) => { if (active) notify(t("animation.loadFailed", { msg: e.message })); });
    return () => { active = false; };
  }, [selected, t]);
  const clip = stored?.kind === "motion-clip" ? stored : undefined;
  const builtin = !!stored && isBuiltinAnimationAssetId(stored.id);
  const boneLabelById = (boneId: string) => {
    const bone = skeleton?.bones.find((item) => item.id === boneId);
    return bone && skeleton ? localizeBoneName(skeleton.id, bone.id, bone.name, t) : t("animation.unknownBone");
  };
  const attachmentLabelById = (attachmentId: string) => previewBinding?.attachments.find((item) => item.id === attachmentId)?.name ?? attachmentId;
  const trackTargetLabel = (targetId: string) => isAttachmentTargetId(targetId) ? attachmentLabelById(targetId.slice(ATTACHMENT_TARGET_PREFIX.length)) : boneLabelById(targetId);
  const sampledPose = useMemo(() => clip && skeleton ? sampleMotionClip(clip, skeleton, time) : undefined, [clip, skeleton, time]);
  const sampledSelectedTransform = selectedBone ? sampledPose?.local[selectedBone] : undefined;
  const previewClip = useMemo(() => {
    if (!clip || playing || !selectedBone || !sampledPose) return clip;
    let next = clip;
    for (const [boneId, boneDraft] of Object.entries({ ...stagedDrafts, [selectedBone]: draft })) {
      const transform = sampledPose.local[boneId];
      if (!transform || !Object.values(boneDraft).every(Number.isFinite)) continue;
      next = upsertMotionKeyframe(next, boneId, "translation", time, [boneDraft.tx, boneDraft.ty, transform.translation[2]]);
      next = upsertMotionKeyframe(next, boneId, "rotation", time, quaternionFromZRotation(boneDraft.rz * Math.PI / 180));
      next = upsertMotionKeyframe(next, boneId, "scale", time, [boneDraft.sx, boneDraft.sy, transform.scale[2]]);
    }
    // 部件偏移草稿临时写入 att: 轨道做所见即所得（未保存，不落库）
    for (const [attachmentId, partDraft] of Object.entries({ ...stagedAttachmentDrafts, ...(selectedAttachmentId ? { [selectedAttachmentId]: attachmentDraft } : {}) })) {
      if (!Object.values(partDraft).every(Number.isFinite)) continue;
      const targetId = `${ATTACHMENT_TARGET_PREFIX}${attachmentId}`;
      next = upsertMotionKeyframe(next, targetId, "translation", time, [partDraft.tx, partDraft.ty, 0]);
      next = upsertMotionKeyframe(next, targetId, "rotation", time, quaternionFromZRotation(partDraft.rz * Math.PI / 180));
      next = upsertMotionKeyframe(next, targetId, "scale", time, [partDraft.sx, partDraft.sy, 1]);
      next = upsertMotionKeyframe(next, targetId, "deform", time, [partDraft.bend, 0, 0]);
    }
    return next;
  }, [clip, playing, selectedBone, sampledPose, stagedDrafts, stagedAttachmentDrafts, selectedAttachmentId, attachmentDraft, time, draft]);
  const poseDraftDirty = !playing && !!sampledPose && Object.entries({ ...stagedDrafts, ...(selectedBone ? { [selectedBone]: draft } : {}) }).some(([boneId, boneDraft]) => {
    const transform = sampledPose.local[boneId];
    return !!transform && (
      Math.abs(boneDraft.tx - transform.translation[0]) > 1e-6
      || Math.abs(boneDraft.ty - transform.translation[1]) > 1e-6
      || Math.abs(boneDraft.rz - zRotationFromQuaternion(transform.rotation) * 180 / Math.PI) > 1e-6
      || Math.abs(boneDraft.sx - transform.scale[0]) > 1e-6
      || Math.abs(boneDraft.sy - transform.scale[1]) > 1e-6
    );
  });
  const attachmentDraftDirty = !playing && !!sampledPose && Object.entries({ ...stagedAttachmentDrafts, ...(selectedAttachmentId ? { [selectedAttachmentId]: attachmentDraft } : {}) }).some(([attachmentId, partDraft]) => {
    const base = offsetToAttachmentDraft(sampledPose.attachmentOffsets[attachmentId]);
    return Math.abs(partDraft.tx - base.tx) > 1e-6 || Math.abs(partDraft.ty - base.ty) > 1e-6 || Math.abs(partDraft.rz - base.rz) > 1e-6
      || Math.abs(partDraft.sx - base.sx) > 1e-6 || Math.abs(partDraft.sy - base.sy) > 1e-6 || Math.abs(partDraft.bend - base.bend) > 1e-6;
  });
  useEffect(() => {
    if (!clip || !skeleton || !selectedBone) return;
    const sampled = sampleMotionClip(clip, skeleton, time);
    const transform = sampled.local[selectedBone];
    setStagedDrafts({});
    setStagedAttachmentDrafts({});
    if (transform) setDraft(transformToPoseDraft(transform));
    setAttachmentDraft(offsetToAttachmentDraft(selectedAttachmentId ? sampled.attachmentOffsets[selectedAttachmentId] : undefined));
  }, [clip, skeleton, time]);
  useEffect(() => { if (!playing || !clip) return; let raf = 0, last = performance.now(); const tick = (now: number) => { const delta = (now - last) / 1000; last = now; setTime((old) => { const next = old + delta; if (clip.loop && clip.duration) return next % clip.duration; if (next >= clip.duration) { setPlaying(false); return clip.duration; } return next; }); raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [playing, clip]);
  const inFolder = assets.filter((a) => isBuiltinAnimationAssetId(a.id) || folder === "all" || (folder === "ungrouped" ? !a.folder_id : a.folder_id === folder));
  const counts = { all: inFolder.length, skeleton: inFolder.filter((a) => a.kind === "skeleton").length, "motion-clip": inFolder.filter((a) => a.kind === "motion-clip").length };
  const visible = (filter === "all" ? inFolder : inFolder.filter((asset) => asset.kind === filter)).toSorted((a, b) => (BUILTIN_ASSET_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (BUILTIN_ASSET_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  useEffect(() => {
    if (initialAssetId && visible.some((asset) => asset.id === initialAssetId)) {
      if (selected !== initialAssetId) setSelected(initialAssetId);
      return;
    }
    if (selected && visible.some((asset) => asset.id === selected)) return;
    setSelected(visible[0]?.id);
  }, [filter, folder, initialAssetId, selected, visible]);
  const importFile = async (file?: File) => { if (!file) return; try { const value = JSON.parse(await file.text()) as AnimationAsset; const result = await api.createAnimationAsset(value, folder === "all" || folder === "ungrouped" ? null : folder); await load(); setSelected(result.asset.id); notify(t("animation.imported"), "info"); } catch (e) { notify(t("animation.importFailed", { msg: (e as Error).message })); } };
  const createSkeleton = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const asset: Skeleton = {
        schemaVersion: 1,
        kind: "skeleton",
        id: uid("skeleton"),
        name: t("animation.skeletonEditor.newSkeletonName"),
        coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "pixel" },
        bones: [{ id: uid("root"), name: "Root", parentId: null, rest: identity(), tipOffset: [0, 60, 0] }],
      };
      const targetFolder = folder === "all" || folder === "ungrouped" ? null : folder;
      const made = await api.createAnimationAsset(asset, targetFolder);
      await load();
      setFilter("skeleton");
      setSelected(made.asset.id);
    } catch (e) {
      notify(t("animation.skeletonEditor.createFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  const saveSkeleton = async (next: Skeleton) => {
    if (busy || builtin || stored?.kind !== "skeleton") return;
    setBusy(true);
    try {
      const saved = await api.putAnimationAsset(next.id, next);
      setStored(saved.asset);
      setSkeleton(saved.asset as Skeleton);
      await load();
      notify(t("animation.skeletonEditor.savedNotice"), "info");
    } catch (e) {
      notify(t("animation.skeletonEditor.saveFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  const openCreateAction = () => {
    const skeletonId = skeleton?.id ?? assets.find((asset) => asset.kind === "skeleton")?.id ?? "";
    setNewAction({ name: t("animation.newActionName"), skeletonId, duration: 1, loop: false });
    setCreateActionOpen(true);
  };
  const createAction = async () => {
    if (busy || !newAction.name.trim() || !newAction.skeletonId || !Number.isFinite(newAction.duration) || newAction.duration <= 0) return;
    setBusy(true);
    try {
      const motion: MotionClip = { schemaVersion: 1, kind: "motion-clip", id: uid("motion"), name: newAction.name.trim(), skeletonId: newAction.skeletonId, duration: newAction.duration, loop: newAction.loop, tracks: [], events: [], provenance: { source: "manual" } };
      const targetFolder = folder === "all" || folder === "ungrouped" ? null : folder;
      const made = await api.createAnimationAsset(motion, targetFolder);
      await load();
      setCreateActionOpen(false);
      setFilter("motion-clip");
      setSelected(made.asset.id);
    } catch (e) {
      notify(t("animation.createActionFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  const saveName = async () => { if (!stored || builtin || !name.trim()) return; try { const updated = await api.putAnimationAsset(stored.id, { ...stored, name: name.trim() }); setStored(updated.asset); setRenaming(false); setUndo([]); setRedo([]); await load(); } catch (e) { notify(t("animation.renameFailed", { msg: (e as Error).message })); } };
  const remove = async () => { if (!stored || builtin || !(await askConfirm(t("animation.deleteConfirm", { name: stored.name })))) return; try { await api.deleteAnimationAsset(stored.id); setSelected(undefined); await load(); } catch (e) { notify(t("animation.deleteFailed", { msg: (e as Error).message })); } };
  const copyBuiltinClip = async (patch?: Pick<MotionClip, "loop">) => {
    if (!clip || !builtin || busy) return;
    setBusy(true);
    try {
      const targetFolder = folder === "all" || folder === "ungrouped" ? null : folder;
      const copied = await api.copyAnimationAsset(clip.id, t("animation.builtin.copyName", { name: clip.name }), targetFolder);
      let editable = copied;
      if (patch) {
        try { editable = await api.putAnimationAsset(copied.asset.id, { ...copied.asset, ...patch }); }
        catch (error) { await api.deleteAnimationAsset(copied.asset.id).catch(() => undefined); throw error; }
      }
      await load();
      setSelected(editable.asset.id);
      notify(t("animation.builtin.copied", { name: editable.asset.name }), "info");
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
    if (!clip || !skeleton || busy) return;
    if (previewBinding && selectedAttachmentId) {
      let next = clip;
      for (const [attachmentId, partDraft] of Object.entries({ ...stagedAttachmentDrafts, [selectedAttachmentId]: attachmentDraft })) {
        if (!Object.values(partDraft).every(Number.isFinite)) return;
        const targetId = `${ATTACHMENT_TARGET_PREFIX}${attachmentId}`;
        next = upsertMotionKeyframe(next, targetId, "translation", time, [partDraft.tx, partDraft.ty, 0]);
        next = upsertMotionKeyframe(next, targetId, "rotation", time, quaternionFromZRotation(partDraft.rz * Math.PI / 180));
        next = upsertMotionKeyframe(next, targetId, "scale", time, [partDraft.sx, partDraft.sy, 1]);
        next = upsertMotionKeyframe(next, targetId, "deform", time, [partDraft.bend, 0, 0]);
      }
      if (await commitClipEdit(next)) setStagedAttachmentDrafts({});
      return;
    }
    if (!selectedBone) return;
    const sampled = sampleMotionClip(clip, skeleton, time);
    let next = clip;
    for (const [boneId, boneDraft] of Object.entries({ ...stagedDrafts, [selectedBone]: draft })) {
      const transform = sampled.local[boneId];
      if (!transform || !Object.values(boneDraft).every(Number.isFinite)) return;
      next = upsertMotionKeyframe(next, boneId, "translation", time, [boneDraft.tx, boneDraft.ty, transform.translation[2]]);
      next = upsertMotionKeyframe(next, boneId, "rotation", time, quaternionFromZRotation(boneDraft.rz * Math.PI / 180));
      next = upsertMotionKeyframe(next, boneId, "scale", time, [boneDraft.sx, boneDraft.sy, transform.scale[2]]);
    }
    if (await commitClipEdit(next)) setStagedDrafts({});
  };
  const deleteKey = async () => {
    if (!clip || busy) return;
    if (previewBinding && selectedAttachmentId) {
      const next = deleteMotionKeyframe(clip, `${ATTACHMENT_TARGET_PREFIX}${selectedAttachmentId}`, ["translation", "rotation", "scale", "deform"], time);
      if (next === clip) return;
      await commitClipEdit(next);
      return;
    }
    if (!selectedBone) return;
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
  const toggleLoop = async (loop: boolean) => {
    if (!clip || busy) return;
    if (builtin) {
      await copyBuiltinClip({ loop });
      return;
    }
    const terminalTime = Math.max(0, clip.duration - MOTION_KEY_TIME_EPSILON);
    const movesTerminalEvents = loop && clip.events.some((event) => event.time >= clip.duration);
    const events = movesTerminalEvents ? clip.events.map((event) => event.time >= clip.duration ? { ...event, time: terminalTime } : event) : clip.events;
    if (await commitClipEdit({ ...clip, loop, events }) && movesTerminalEvents) notify(t("animation.loopTerminalEventsMoved"), "info");
  };
  const saveDuration = async () => {
    if (!clip || builtin || busy) return;
    const duration = Number(durationDraft);
    if (!Number.isFinite(duration) || duration <= 0) {
      setDurationDraft(String(clip.duration));
      notify(t("animation.durationInvalid"));
      return;
    }
    if (Math.abs(duration - clip.duration) <= MOTION_KEY_TIME_EPSILON) return;
    const trimsContent = duration < clip.duration && (
      clip.tracks.some((track) => track.keyframes.some((key) => key.time > duration))
      || clip.events.some((event) => event.time > duration || (clip.loop && event.time >= duration))
      || clip.contacts?.some((contact) => contact.intervals.some((interval) => interval.end > duration))
    );
    if (trimsContent && !(await askConfirm(t("animation.durationTrimConfirm")))) {
      setDurationDraft(String(clip.duration));
      return;
    }
    const tracks = clip.tracks.flatMap((track) => {
      const keyframes = track.keyframes.filter((key) => key.time <= duration);
      if (!keyframes.length) return [];
      if (clip.schemaVersion === 2) keyframes[keyframes.length - 1] = { ...keyframes[keyframes.length - 1]!, outInterpolation: null };
      return [{ ...track, keyframes } as AnyMotionTrack];
    });
    const terminalTime = Math.max(0, duration - MOTION_KEY_TIME_EPSILON);
    const events = clip.events.filter((event) => event.time <= duration).map((event) => clip.loop && event.time >= duration ? { ...event, time: terminalTime } : event);
    const contacts = clip.contacts?.map((contact) => ({ ...contact, intervals: contact.intervals.filter((interval) => interval.start <= duration).map((interval) => ({ ...interval, end: Math.min(interval.end, duration) })) })).filter((contact) => contact.intervals.length);
    const next = { ...clip, duration, tracks, events, ...(contacts ? { contacts } : {}) } as MotionClip;
    if (await commitClipEdit(next)) {
      setDurationDraft(String(duration));
      setTime((old) => Math.min(old, duration));
    } else setDurationDraft(String(clip.duration));
  };
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
  const segmentInterpolationAt = (track: AnyMotionTrack): MotionSegmentInterpolation | null => {
    const index = findMotionSegmentIndex(track.keyframes, time);
    if (index < 0) return null;
    if (clip?.schemaVersion === 1) return { type: (track as MotionTrack).interpolation };
    return (track as MotionTrackV2).keyframes[index]!.outInterpolation;
  };
  const setInterpolation = async (targetId: string, property: AnyMotionTrack["property"], interpolation: MotionSegmentInterpolation) => {
    if (!clip || busy) return;
    const upgrades = clip.schemaVersion === 1 && interpolation.type === "cubic-bezier";
    if (await commitClipEdit(setMotionSegmentInterpolation(clip, targetId, property, time, interpolation)) && upgrades) notify(t("animation.interpolation.upgraded"), "info");
  };
  const smoothAllTracks = async () => {
    if (!clip || busy) return;
    if (clip.schemaVersion === 1) {
      if (!clip.tracks.some((track) => track.interpolation === "step")) return;
      await commitClipEdit({ ...clip, tracks: clip.tracks.map((track) => ({ ...track, interpolation: "linear" })) });
      return;
    }
    if (!clip.tracks.some((track) => track.keyframes.some((key) => key.outInterpolation?.type === "step"))) return;
    await commitClipEdit({ ...clip, tracks: clip.tracks.map((track) => ({ ...track, keyframes: track.keyframes.map((key) => key.outInterpolation?.type === "step" ? { ...key, outInterpolation: { type: "linear" as const } } : key) })) } as MotionClip);
  };
  const setRootMotion = async (value: string) => {
    if (!clip || busy) return;
    const next = { ...clip };
    if (value) next.rootMotion = value as RootMotionPolicy;
    else delete next.rootMotion;
    await commitClipEdit(next);
  };
  const selectedTrackTargetId = previewBinding && selectedAttachmentId ? `${ATTACHMENT_TARGET_PREFIX}${selectedAttachmentId}` : selectedBone;
  const hasCurrentKey = !!clip?.tracks.some((track) => track.targetId === selectedTrackTargetId && track.keyframes.some((key) => Math.abs(key.time - time) <= MOTION_KEY_TIME_EPSILON));
  const selectedBoneInfo = skeleton?.bones.find((bone) => bone.id === selectedBone);
  const selectedAttachmentInfo = previewBinding?.attachments.find((item) => item.id === selectedAttachmentId);
  const isRootBone = selectedBoneInfo?.parentId === null;
  const numberField = (key: keyof typeof draft, label: string, step = .01) => <label>{label}<input className="px-input" type="number" step={step} value={draft[key]} disabled={busy || builtin} onChange={(event) => { setPlaying(false); setDraft((old) => ({ ...old, [key]: +event.target.value })); }} /></label>;
  const partNumberField = (key: "tx" | "ty" | "sx" | "sy", label: string, step = .01) => <label>{label}<input className="px-input" type="number" step={step} value={attachmentDraft[key]} disabled={busy || builtin} onChange={(event) => { setPlaying(false); setAttachmentDraft((old) => ({ ...old, [key]: +event.target.value })); }} /></label>;
  const selectBone = (id: string) => {
    setPlaying(false);
    if (selectedAttachmentId) {
      setStagedAttachmentDrafts((old) => ({ ...old, [selectedAttachmentId]: attachmentDraft }));
      setSelectedAttachmentId("");
    }
    if (id === selectedBone) return;
    if (selectedBone) setStagedDrafts((old) => ({ ...old, [selectedBone]: draft }));
    setSelectedBone(id);
    if (!clip || !skeleton) return;
    const transform = sampleMotionClip(clip, skeleton, time).local[id];
    if (transform) setDraft(stagedDrafts[id] ?? transformToPoseDraft(transform));
  };
  const selectAttachment = (id: string) => {
    if (!previewBinding?.attachments.some((item) => item.id === id)) return;
    setPlaying(false);
    if (id === selectedAttachmentId) return;
    if (selectedAttachmentId) setStagedAttachmentDrafts((old) => ({ ...old, [selectedAttachmentId]: attachmentDraft }));
    setSelectedAttachmentId(id);
    if (!clip || !skeleton) return;
    setAttachmentDraft(stagedAttachmentDrafts[id] ?? offsetToAttachmentDraft(sampleMotionClip(clip, skeleton, time).attachmentOffsets[id]));
  };
  const editAttachmentOnCanvas = (id: string, patch: Partial<AttachmentDraft>) => {
    if (!clip || !skeleton || builtin) return;
    setPlaying(false);
    if (id === selectedAttachmentId) setAttachmentDraft((old) => ({ ...old, ...patch }));
    else {
      const base = stagedAttachmentDrafts[id] ?? offsetToAttachmentDraft(sampleMotionClip(clip, skeleton, time).attachmentOffsets[id]);
      if (selectedAttachmentId) setStagedAttachmentDrafts((old) => ({ ...old, [selectedAttachmentId]: attachmentDraft }));
      setSelectedAttachmentId(id);
      setAttachmentDraft({ ...base, ...patch });
    }
  };
  const resetSelectedAttachment = () => {
    if (builtin) return;
    setPlaying(false);
    setAttachmentDraft({ tx: 0, ty: 0, rz: 0, sx: 1, sy: 1, bend: 0 });
  };
  const editBoneOnCanvas = (id: string, patch: { tx?: number; ty?: number; rz?: number }) => {
    if (!clip || !skeleton || builtin) return;
    setPlaying(false);
    if (id === selectedBone) setDraft((old) => ({ ...old, ...patch }));
    else {
      const transform = sampleMotionClip(clip, skeleton, time).local[id];
      if (!transform) return;
      if (selectedBone) setStagedDrafts((old) => ({ ...old, [selectedBone]: draft }));
      setSelectedBone(id);
      setDraft({ ...(stagedDrafts[id] ?? transformToPoseDraft(transform)), ...patch });
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
  return <>{createActionOpen && <div className="modal-mask" onMouseDown={(event) => event.target === event.currentTarget && !busy && setCreateActionOpen(false)}>
    <form className="modal pixel-panel animation-create-action-modal" role="dialog" aria-modal="true" aria-labelledby="animation-create-action-title" onSubmit={(event) => { event.preventDefault(); void createAction(); }}>
      <h2 id="animation-create-action-title">{t("animation.createAction")}</h2>
      <p>{t("animation.createActionHint")}</p>
      <label>{t("animation.actionName")}<input className="px-input" autoFocus value={newAction.name} onChange={(event) => setNewAction((old) => ({ ...old, name: event.target.value }))} /></label>
      <label>{t("animation.actionSkeleton")}<PxSelect value={newAction.skeletonId} options={assets.filter((asset) => asset.kind === "skeleton").map((asset) => ({ value: asset.id, label: localizeSkeletonName(asset.id, asset.name, t) }))} onChange={(skeletonId) => setNewAction((old) => ({ ...old, skeletonId }))} /></label>
      <label>{t("animation.actionDuration")}<input className="px-input" type="number" min="0.01" step="0.01" value={newAction.duration} onChange={(event) => setNewAction((old) => ({ ...old, duration: Number(event.target.value) }))} /></label>
      <label className="px-check"><input type="checkbox" checked={newAction.loop} onChange={(event) => setNewAction((old) => ({ ...old, loop: event.target.checked }))} />{t("animation.loop")}</label>
      <div className="modal-actions"><button className="px-btn" type="button" disabled={busy} onClick={() => setCreateActionOpen(false)}>{t("common.cancel")}</button><button className="px-btn accent" type="submit" disabled={busy || !newAction.name.trim() || !newAction.skeletonId || !Number.isFinite(newAction.duration) || newAction.duration <= 0}>{t("animation.createAction")}</button></div>
    </form>
  </div>}{!previewBinding && <ol className="animation-flow-map">
    <li className={counts.skeleton ? "done" : ""}><b>1</b><button onClick={() => setFilter("skeleton")}><strong>{t("animation.flow.skeleton")}</strong><small>{t("animation.flow.skeletonHint")}</small></button></li>
    <li className={counts["motion-clip"] ? "done" : ""}><b>2</b><button onClick={() => setFilter("motion-clip")}><strong>{t("animation.flow.motion")}</strong><small>{t("animation.flow.motionHint")}</small></button></li>
    <li><b>3</b><span><strong>{t("animation.flow.project")}</strong><small>{t("animation.flow.projectHint")}</small></span><button className="px-btn" onClick={onOpenProjects}>{t("animation.flow.openProjects")}</button></li>
  </ol>}<div className={`animation-workspace${previewBinding ? " embedded" : ""}`}>
    {!previewBinding && <><FolderTree className="animation-folders" title={t("animation.folders")} kind="animation" folders={folders} selected={folder} onSelect={setFolder} onCreate={async (n, p) => { await api.createFolder("animation", n, p); await load(); }} onRename={async (id, n) => { await api.patchFolder(id, { name: n }); await load(); }} onDelete={async (id) => { await api.deleteFolder(id); await load(); }} onMoveFolder={async (id, p) => { await api.patchFolder(id, { parentId: p }); await load(); }} onDropItems={(folderId, ids) => void api.moveItems("animation", ids, folderId).then(load).catch((e) => notify(t("animation.moveFailed", { msg: e.message })))} />
    <div className="animation-filter-rail"><strong>{t("animation.filter.title")}</strong>{(["all", "skeleton", "motion-clip"] as AssetFilter[]).map((kind) => <button key={kind} className={filter === kind ? "on" : ""} onClick={() => setFilter(kind)}>{t(`animation.filter.${kind}`)} <span>{counts[kind]}</span></button>)}</div>
    <section className="pixel-panel animation-library"><header><h2>{t("animation.assets")}</h2><div className="animation-library-actions"><input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(e) => { void importFile(e.target.files?.[0]); e.currentTarget.value = ""; }} /><button className="px-btn" onClick={() => inputRef.current?.click()}><Upload size={14} />{t("animation.importJson")}</button><button className="px-btn" disabled={busy} onClick={() => void createSkeleton()}><Plus size={14} />{t("animation.skeletonEditor.create")}</button><button className="px-btn accent" onClick={openCreateAction}><Plus size={14} />{t("animation.createAction")}</button></div></header><div className="animation-list">{visible.map((asset) => { const locked = isBuiltinAnimationAssetId(asset.id); return <button draggable={!locked} onDragStart={locked ? undefined : (e) => e.dataTransfer.setData("application/x-framebaker-ids", JSON.stringify([asset.id]))} className={`${selected === asset.id ? "on" : ""}${locked ? " builtin" : ""}`} key={asset.id} onClick={() => setSelected(asset.id)}><strong>{asset.kind === "skeleton" ? localizeSkeletonName(asset.id, asset.name, t) : asset.name}</strong><span>{locked && <Lock size={11} />}{locked ? t("animation.builtin.badge") : asset.kind === "skeleton" ? t("animation.skeleton") : t("animation.motionClip")}</span></button>; })}{!visible.length && <p>{t("animation.empty")}</p>}</div></section></>}
    <main className="pixel-panel animation-preview">{stored && skeleton ? <><header>{renaming && !builtin ? <input className="px-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void saveName()} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /> : <h2>{stored.kind === "skeleton" ? localizeSkeletonName(stored.id, stored.name, t) : stored.name}</h2>}{!previewBinding && <div>{builtin ? <span className="animation-builtin-badge"><Lock size={13} />{t("animation.builtin.badge")}</span> : <><button className="px-btn icon" onClick={() => setRenaming(true)} title={t("animation.rename")}><Pencil size={14} /></button><button className="px-btn icon danger" onClick={() => void remove()} title={t("common.delete")}><Trash2 size={14} /></button></>}</div>}</header>
      {builtin && <aside className="animation-builtin-notice"><Lock size={20} /><div><strong>{t("animation.builtin.title")}</strong><p>{t(clip ? "animation.builtin.clipHint" : "animation.builtin.skeletonHint")}</p></div>{clip && <button className="px-btn accent" disabled={busy} onClick={() => void copyBuiltinClip()}><Copy size={14} />{t("animation.builtin.copyEdit")}</button>}</aside>}
      {stored.kind === "skeleton" && (builtin ? <SkeletonPreview skeleton={skeleton} time={0} /> : <SkeletonEditor skeleton={skeleton} busy={busy} onSave={saveSkeleton} />)}
      {clip && <>
        <div className="animation-motion-compose">
        <section className="animation-motion-stage">
        {previewBinding
          ? <CharacterPreview binding={previewBinding} skeleton={skeleton} clip={previewClip} time={time} selectedAttachmentId={selectedAttachmentId || undefined} selectedBoneId={selectedBone} showSkeleton onSelectBone={selectBone} onSelectAttachment={selectAttachment} onTransformAttachmentOffset={builtin || playing ? undefined : editAttachmentOnCanvas} />
          : <SkeletonPreview skeleton={skeleton} clip={previewClip} rangeClip={clip} time={time} selectedBone={selectedBone} disabled={playing} onSelectBone={selectBone} onEditBone={builtin ? undefined : editBoneOnCanvas} />}
        <div className="animation-controls"><button className="px-btn accent" disabled={busy} onClick={() => setPlaying((v) => !v)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? t("animation.pause") : t("animation.play")}</button><input type="range" min="0" max={clip.duration} step="0.001" value={time} onChange={(e) => { setPlaying(false); setTime(+e.target.value); }} /><span>{time.toFixed(2)}s / {clip.duration.toFixed(2)}s</span><label className="px-check" title={builtin ? t("animation.builtin.loopEditHint") : undefined}><input type="checkbox" checked={clip.loop} disabled={busy} onChange={(event) => void toggleLoop(event.target.checked)} />{t("animation.loop")}</label>{clip.loop && <button className="px-btn" disabled={busy || builtin} onClick={() => skeleton && void commitClipEdit(closeMotionLoopSeam(clip, skeleton))}>{t("animation.closeLoopSeam")}</button>}</div>

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
          {previewBinding && selectedAttachmentId && selectedAttachmentInfo ? <>
            <label className="animation-bone-picker">{t("animation.part")}<PxSelect value={selectedAttachmentId} disabled={busy} options={previewBinding.attachments.map((attachment) => ({ value: attachment.id, label: attachment.name }))} onChange={selectAttachment} /></label>
            <p className="animation-bone-hint">{t("animation.partHint")}</p>
            <div className="animation-root-fields">{partNumberField("tx", t("animation.partOffsetX"))}{partNumberField("ty", t("animation.partOffsetY"))}</div>
            <div className="animation-root-fields">{partNumberField("sx", t("animation.partScaleX"))}{partNumberField("sy", t("animation.partScaleY"))}</div>
            <div className="animation-rotation-editor">
              <label>{t("animation.partRotation")}<input type="range" min="-180" max="180" step="1" value={attachmentDraft.rz} disabled={busy || builtin} onChange={(event) => { setPlaying(false); setAttachmentDraft((old) => ({ ...old, rz: +event.target.value })); }} /></label>
              <input className="px-input" type="number" min="-180" max="180" step="1" value={attachmentDraft.rz} disabled={busy || builtin} aria-label={t("animation.partRotation")} onChange={(event) => { setPlaying(false); setAttachmentDraft((old) => ({ ...old, rz: +event.target.value })); }} />
            </div>
            <div className="animation-rotation-editor">
              <label>{t("animation.partBend")}<input type="range" min="-1" max="1" step="0.01" value={attachmentDraft.bend} disabled={busy || builtin} onChange={(event) => { setPlaying(false); setAttachmentDraft((old) => ({ ...old, bend: +event.target.value })); }} /></label>
              <input className="px-input" type="number" min="-1" max="1" step="0.01" value={attachmentDraft.bend} disabled={busy || builtin} aria-label={t("animation.partBend")} onChange={(event) => { setPlaying(false); setAttachmentDraft((old) => ({ ...old, bend: Math.max(-1, Math.min(1, +event.target.value)) })); }} />
            </div>
            <p className="animation-bone-hint">{t("animation.partBendHint")}</p>
            <div className="animation-pose-actions">
              <span className={attachmentDraftDirty ? "dirty" : hasCurrentKey ? "has-key" : ""}>{t(attachmentDraftDirty ? "animation.unsavedPose" : hasCurrentKey ? "animation.currentKey" : "animation.noCurrentKey")}</span>
              <button className="px-btn" type="button" disabled={builtin} onClick={resetSelectedAttachment}><RotateCcw size={13} />{t("animation.resetPartOffset")}</button>
              <button className="px-btn accent" disabled={busy || builtin} onClick={() => void writeKey()}>{t(hasCurrentKey ? "animation.updatePose" : "animation.savePose")}</button>
              <button className="px-btn danger" disabled={busy || builtin || !hasCurrentKey} onClick={() => void deleteKey()}>{t("animation.deleteKey")}</button>
            </div>
            <div className="animation-pose-actions">
              <button className="px-btn" type="button" disabled={!selectedAttachmentInfo.materialId} title={t("animation.binding.editMaterialHint")} onClick={() => openMaterialEditor({ id: selectedAttachmentInfo.materialId, name: selectedAttachmentInfo.name })}><Pencil size={13} />{t("animation.binding.editMaterial")}</button>
              <button className="px-btn" type="button" onClick={() => selectBone(selectedBone)}>{t("animation.backToBone")}</button>
            </div>
          </> : <>
          <label className="animation-bone-picker">{t("animation.bone")}<PxSelect value={selectedBone} disabled={busy} options={skeleton.bones.map((bone) => ({ value: bone.id, label: localizeBoneName(skeleton.id, bone.id, bone.name, t) }))} onChange={selectBone} /></label>
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
          </>}
        </section>
        </div>

        <details className="animation-clip-tools">
          <summary>{t("animation.advancedSettings")}</summary>
          <div className="animation-duration-setting"><label>{t("animation.actionDuration")}<input className="px-input" type="number" min="0.01" step="0.01" value={durationDraft} disabled={busy || builtin} onChange={(event) => setDurationDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveDuration(); }} /></label><button className="px-btn" type="button" disabled={busy || builtin || durationDraft === String(clip.duration)} onClick={() => void saveDuration()}>{t("animation.saveDuration")}</button></div>
          <label>{t("animation.rootMotion")}<PxSelect value={clip.rootMotion ?? ""} disabled={busy || builtin} options={[{ value: "", label: t("animation.unspecified") }, { value: "preserve", label: t("animation.root.preserve") }, { value: "in-place", label: t("animation.root.inPlace") }, { value: "extracted", label: t("animation.root.extracted") }]} onChange={(value) => void setRootMotion(value)} /></label>
          <div className="animation-event-form"><input className="px-input" value={eventDraft.type} disabled={busy || builtin} placeholder={t("animation.eventType")} onChange={(e) => setEventDraft((old) => ({ ...old, type: e.target.value }))} /><input className="px-input" value={eventDraft.name} disabled={busy || builtin} placeholder={t("animation.eventName")} onChange={(e) => setEventDraft((old) => ({ ...old, name: e.target.value }))} /><textarea className="px-input" rows={2} value={eventDraft.payload} disabled={busy || builtin} aria-invalid={!!eventPayloadError} placeholder={t("animation.eventPayload")} onChange={(e) => { setEventDraft((old) => ({ ...old, payload: e.target.value })); setEventPayloadError(""); }} />{eventPayloadError && <span className="animation-event-error">{eventPayloadError}</span>}<button className="px-btn" disabled={busy || builtin || !eventDraft.type.trim() || !eventDraft.name.trim() || (clip.loop && time >= clip.duration)} onClick={() => void addEvent()}>{t("animation.addEvent")}</button></div>
          <div className="animation-event-list">{clip.events.map((event, index) => <div key={`${event.time}-${index}`}><button onClick={() => { setPlaying(false); setTime(event.time); }}><span>{event.time.toFixed(3)}s · {event.type} · {event.name}</span>{event.payload && <code>{JSON.stringify(event.payload)}</code>}</button><button className="px-btn icon danger" disabled={busy || builtin} title={t("common.delete")} onClick={() => void commitClipEdit(deleteMotionEvent(clip, index))}><Trash2 size={12} /></button></div>)}</div>
        </details>

        <section className="animation-timeline">
          <header><div><h3>{t("animation.timeline")}</h3><p>{t("animation.timelineHint")}</p></div><button className="px-btn" disabled={busy || builtin || !clip.tracks.some((track) => clip.schemaVersion === 1 ? (track as MotionTrack).interpolation === "step" : (track as MotionTrackV2).keyframes.some((key) => key.outInterpolation?.type === "step"))} onClick={() => void smoothAllTracks()}>{t("animation.interpolation.smoothAll")}</button></header>
          <div className="animation-timeline-ruler"><span /><div><i style={{ left: "0%" }}>0s</i><i style={{ left: "50%" }}>{(clip.duration / 2).toFixed(2)}s</i><i style={{ left: "100%" }}>{clip.duration.toFixed(2)}s</i></div><span /></div>
          <div className="animation-tracks">{clip.tracks.map((track) => <div className={`animation-track${track.targetId === selectedTrackTargetId ? " selected" : ""}`} key={`${track.targetId}-${track.property}`}>
            <span>{trackTargetLabel(track.targetId)} · {t(`animation.channel.${track.property}`)}</span>
            <div className="animation-track-lane" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setPlaying(false); setTime(Math.max(0, Math.min(clip.duration, (event.clientX - bounds.left) / bounds.width * clip.duration))); }}>
              {track.keyframes.map((key, k) => <button className="animation-key-dot" aria-label={`${key.time}s`} key={k} onClick={(event) => { event.stopPropagation(); setTime(key.time); if (isAttachmentTargetId(track.targetId)) selectAttachment(track.targetId.slice(ATTACHMENT_TARGET_PREFIX.length)); else selectBone(track.targetId); }} style={{ left: `${clip.duration ? key.time / clip.duration * 100 : 0}%` }} />)}
              <b className="animation-playhead" style={{ left: `${clip.duration ? time / clip.duration * 100 : 0}%` }} />
            </div>
            {(() => { const interpolation = segmentInterpolationAt(track); const cubic = interpolation?.type === "cubic-bezier" ? interpolation : null; return <div className="animation-track-interpolation"><button className={interpolation?.type === "step" ? "on" : ""} disabled={busy || builtin || !interpolation} title={t("animation.interpolation.holdHint")} onClick={() => void setInterpolation(track.targetId, track.property, { type: "step" })}>{t("animation.interpolation.hold")}</button><button className={interpolation?.type === "linear" ? "on" : ""} disabled={busy || builtin || !interpolation} title={t("animation.interpolation.smoothHint")} onClick={() => void setInterpolation(track.targetId, track.property, { type: "linear" })}>{t("animation.interpolation.smooth")}</button><button className={cubic ? "on" : ""} disabled={busy || builtin || !interpolation} title={t("animation.interpolation.cubicHint")} onClick={() => void setInterpolation(track.targetId, track.property, cubic ?? DEFAULT_CUBIC_MOTION_INTERPOLATION)}>{t("animation.interpolation.cubic")}</button>{cubic && <span className="animation-cubic-controls">{(["x1", "y1", "x2", "y2"] as const).map((key) => <label key={key}>{key}<input className="px-input" type="number" min="0" max="1" step="0.01" value={cubic[key]} disabled={busy || builtin} onChange={(event) => { const value = Math.max(0, Math.min(1, Number(event.target.value))); if (Number.isFinite(value)) void setInterpolation(track.targetId, track.property, { ...cubic, [key]: value } as CubicBezierMotionInterpolation); }} /></label>)}</span>}</div>; })()}
          </div>)}</div>
        </section>
      </>}
    </> : <p>{t("animation.selectHint")}</p>}</main>
  </div></>;
}
