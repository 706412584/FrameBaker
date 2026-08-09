import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addMotionEvent, BUILTIN_ANIMATION_ASSET_IDS, closeMotionLoopSeam, deleteMotionEvent, deleteMotionKeyframe, getBoneEndpoint, isBuiltinAnimationAssetId, MOTION_KEY_TIME_EPSILON, multiplyMatrices, quaternionFromZRotation, sampleMotionClip, transformPoint, transformToMatrix, upsertMotionKeyframe, zRotationFromQuaternion, type AnimationAsset, type AnimationAssetSummary, type CharacterBinding, type Mat4, type Material, type MotionClip, type MotionInterpolation, type RootMotionPolicy, type Skeleton } from "@framebaker/shared";
import { Copy, Lock, Move, Pause, Pencil, Play, Plus, Redo2, RotateCcw, RotateCw, Save, Trash2, Undo2, Upload, ZoomIn, ZoomOut } from "lucide-react";
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

function SkeletonPreview({ skeleton, clip, time, selectedBone, onSelectBone }: { skeleton: Skeleton; clip?: MotionClip; time: number; selectedBone?: string; onSelectBone?: (id: string) => void }) {
  const pose = useMemo(() => clip ? sampleMotionClip(clip, skeleton, time) : sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, 0), [clip, skeleton, time]);
  const points = skeleton.bones.map((bone) => transformPoint(pose.worldMatrices[bone.id]!, [0, 0, 0]));
  const ends = skeleton.bones.map((bone) => getBoneEndpoint(pose, skeleton, bone.id));
  const all = [...points, ...ends.filter(Boolean) as [number, number, number][]];
  const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0])), minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]));
  const pad = .5, width = Math.max(1, maxX - minX + pad * 2), height = Math.max(1, maxY - minY + pad * 2);
  const xy = (p: [number, number, number]) => ({ x: p[0], y: maxY + pad - p[1] });
  return <svg className="animation-skeleton" viewBox={`${minX - pad} 0 ${width} ${height}`} role="img">
    {skeleton.bones.map((bone, i) => { const parent = bone.parentId ? skeleton.bones.findIndex((b) => b.id === bone.parentId) : -1; if (parent < 0) return null; const a = xy(points[parent]!), b = xy(points[i]!); return <line key={bone.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />; })}
    {skeleton.bones.map((bone, i) => { const p = xy(points[i]!); return <circle className={selectedBone === bone.id ? "selected" : ""} key={bone.id} cx={p.x} cy={p.y} r=".09" role={onSelectBone ? "button" : undefined} tabIndex={onSelectBone ? 0 : undefined} aria-label={bone.name} onClick={() => onSelectBone?.(bone.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelectBone?.(bone.id); }} />; })}
    {ends.map((end, i) => end && skeleton.bones[i]!.tipOffset ? <line className="tip" key={`tip-${i}`} x1={xy(points[i]!).x} y1={xy(points[i]!).y} x2={xy(end).x} y2={xy(end).y} /> : null)}
  </svg>;
}

export function CharacterPreview({ binding, skeleton, clip, time, selectedAttachmentId, selectedBoneId, showSkeleton = false, onSelectAttachment, onSelectBone, onMoveAttachment }: { binding: CharacterBinding; skeleton: Skeleton; clip?: MotionClip; time: number; selectedAttachmentId?: string; selectedBoneId?: string; showSkeleton?: boolean; onSelectAttachment?: (id: string) => void; onSelectBone?: (id: string) => void; onMoveAttachment?: (id: string, translation: [number, number, number]) => void }) {
  const pose = useMemo(() => sampleMotionClip(clip ?? { schemaVersion: 1, kind: "motion-clip", id: "binding-rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, time), [clip, skeleton, time]);
  const dragRef = useRef<{ id: string; x: number; y: number; translation: [number, number, number]; bone: Mat4 } | undefined>(undefined);
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
  const moveAttachment = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || !onMoveAttachment) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    const worldX = point.x - drag.x;
    const worldY = -(point.y - drag.y);
    const determinant = drag.bone[0] * drag.bone[5] - drag.bone[1] * drag.bone[4];
    if (Math.abs(determinant) < 1e-8) return;
    const localX = (drag.bone[5] * worldX - drag.bone[4] * worldY) / determinant;
    const localY = (-drag.bone[1] * worldX + drag.bone[0] * worldY) / determinant;
    onMoveAttachment(drag.id, [drag.translation[0] + localX, drag.translation[1] + localY, drag.translation[2]]);
  };
  const endDrag = () => { dragRef.current = undefined; frozenViewBoxRef.current = undefined; setDragging(false); };
  const previewSpan = Math.max(...viewBox.split(" ").slice(2).map(Number));
  const boneNodeRadius = Math.max(previewSpan * .008, .05);
  return <svg className={`animation-skeleton binding-preview${onMoveAttachment ? " interactive" : ""}`} viewBox={dragging ? frozenViewBoxRef.current : viewBox} role="img" onPointerMove={moveAttachment} onPointerUp={endDrag} onPointerCancel={endDrag}>
    <g transform="scale(1 -1)">{[...binding.slots].sort((a, b) => a.drawOrder - b.drawOrder).map((slot) => {
      const attachment = binding.attachments.find((item) => item.id === slot.attachmentId), matrix = pose.worldMatrices[slot.boneId];
      if (!attachment || !matrix) return null;
      const world = multiplyMatrices(matrix, transformToMatrix(attachment.rest)), [w, h] = attachment.size, [px, py] = attachment.pivot;
      return <g key={slot.id}>
        <image className={selectedAttachmentId === attachment.id ? "selected" : ""} href={materialImageUrl(attachment.materialId, undefined, attachment.imageSlot)} x={-px * w} y={-(1 - py) * h} width={w} height={h} preserveAspectRatio="none" transform={`matrix(${world[0]} ${world[1]} ${world[4]} ${world[5]} ${world[12]} ${world[13]}) scale(1 -1)`} onPointerDown={onMoveAttachment ? (event) => { const svg = event.currentTarget.ownerSVGElement; if (!svg) return; const point = svgPoint(svg, event.clientX, event.clientY); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); onSelectAttachment?.(attachment.id); frozenViewBoxRef.current = viewBox; dragRef.current = { id: attachment.id, x: point.x, y: point.y, translation: [...attachment.rest.translation], bone: matrix }; setDragging(true); } : undefined} onClick={() => onSelectAttachment?.(attachment.id)} />
        {selectedAttachmentId === attachment.id && <><circle className="binding-pivot" cx="0" cy="0" r=".075" transform={`matrix(${world[0]} ${world[1]} ${world[4]} ${world[5]} ${world[12]} ${world[13]})`} /><line className="binding-pivot-cross" x1="-.13" y1="0" x2=".13" y2="0" transform={`matrix(${world[0]} ${world[1]} ${world[4]} ${world[5]} ${world[12]} ${world[13]})`} /><line className="binding-pivot-cross" x1="0" y1="-.13" x2="0" y2=".13" transform={`matrix(${world[0]} ${world[1]} ${world[4]} ${world[5]} ${world[12]} ${world[13]})`} /></>}
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
    </g>}</g>
  </svg>;
}

export function BindingEditor({ binding, skeleton, materials, busy, onSave }: { binding: CharacterBinding; skeleton: Skeleton; materials: Material[]; busy: boolean; onSave: (value: CharacterBinding) => Promise<void> }) {
  const firstSlot = binding.slots[0];
  const t = useT(), [draft, setDraft] = useState(binding), [selectedAttachmentId, setSelectedAttachmentId] = useState(binding.attachments[0]?.id ?? ""), [selectedBoneId, setSelectedBoneId] = useState(firstSlot?.boneId ?? skeleton.bones[0]?.id ?? "");
  useEffect(() => {
    setDraft(binding);
    setSelectedAttachmentId((current) => binding.attachments.some((item) => item.id === current) ? current : binding.attachments[0]?.id ?? "");
    setSelectedBoneId((current) => skeleton.bones.some((bone) => bone.id === current) ? current : binding.slots[0]?.boneId ?? skeleton.bones[0]?.id ?? "");
  }, [binding, skeleton]);
  const patchRegion = (id: string, patch: Partial<CharacterBinding["attachments"][number]>) => setDraft((old) => ({ ...old, attachments: old.attachments.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const patchSlot = (index: number, patch: Partial<CharacterBinding["slots"][number]>) => setDraft((old) => ({ ...old, slots: old.slots.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  const addRow = () => {
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
    if (selectedSlotIndex >= 0) patchSlot(selectedSlotIndex, { boneId });
  };
  const rotateSelected = (degrees: number) => selectedAttachment && patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, rotation: quaternionFromZRotation(zRotationFromQuaternion(selectedAttachment.rest.rotation) + degrees * Math.PI / 180) } });
  const scaleSelected = (factor: number) => selectedAttachment && patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, scale: [selectedAttachment.rest.scale[0] * factor, selectedAttachment.rest.scale[1] * factor, selectedAttachment.rest.scale[2]] } });
  const removeSelected = () => {
    if (!selectedSlot || selectedSlotIndex < 0) return;
    const slots = draft.slots.filter((_, index) => index !== selectedSlotIndex);
    const attachments = slots.some((item) => item.attachmentId === selectedAttachmentId) ? draft.attachments : draft.attachments.filter((item) => item.id !== selectedAttachmentId);
    const next = attachments[0];
    setDraft({ ...draft, slots, attachments });
    setSelectedAttachmentId(next?.id ?? "");
    setSelectedBoneId(slots.find((item) => item.attachmentId === next?.id)?.boneId ?? skeleton.bones[0]?.id ?? "");
  };
  const sliderField = (label: string, value: number, min: number, max: number, step: number, onChange: (value: number) => void) => <label className="binding-tuning-row"><span>{label}</span><input type="range" min={min} max={max} step={step} value={Math.max(min, Math.min(max, value))} onChange={(event) => onChange(Number(event.target.value))} /><input className="px-input" type="number" min={min} max={max} step={step} value={Math.round(value * 1000) / 1000} onChange={(event) => onChange(Number(event.target.value))} /></label>;
  const translationRange = selectedAttachment ? Math.max(2, ...selectedAttachment.size.map((value) => value * 3), Math.abs(selectedAttachment.rest.translation[0]) * 1.5, Math.abs(selectedAttachment.rest.translation[1]) * 1.5) : 2;
  const sizeRange = selectedAttachment ? Math.max(2, ...selectedAttachment.size.map((value) => value * 2)) : 2;
  const scaleRange = selectedAttachment ? Math.max(3, selectedAttachment.rest.scale[0] * 1.5, selectedAttachment.rest.scale[1] * 1.5) : 3;
  return <section className="binding-editor">
    <header className="binding-editor-heading"><div><h3>{t("animation.binding.visualTitle")}</h3><p>{t("animation.binding.visualHint")}</p></div><button className="px-btn accent" disabled={busy} onClick={() => void onSave(draft)}><Save size={13} />{t("common.save")}</button></header>
    <section className="binding-part-strip"><header><strong>{t("animation.binding.parts")}</strong><button className="px-btn" disabled={!materials.length} onClick={addRow}><Plus size={14} />{t("animation.binding.addRegion")}</button></header><div className="binding-part-list">{draft.slots.map((slot) => { const attachment = draft.attachments.find((item) => item.id === slot.attachmentId), boneName = skeleton.bones.find((bone) => bone.id === slot.boneId)?.name ?? slot.boneId; return attachment && <button type="button" className={selectedAttachmentId === attachment.id ? "selected" : ""} title={`${attachment.name} · ${boneName}`} key={slot.id} onClick={() => selectAttachment(attachment.id)}><span>{attachment.name}</span><small>{boneName}</small></button>; })}</div></section>
    <div className="binding-calibration-workspace">
      <article className="binding-preview-card"><div className="binding-canvas-hud"><span><b>1</b>{t("animation.binding.guidePart")}</span><span><b>2</b>{t("animation.binding.guideBone")}</span><span><b>3</b>{t("animation.binding.guideTune")}</span></div><CharacterPreview binding={draft} skeleton={skeleton} time={0} selectedAttachmentId={selectedAttachmentId} selectedBoneId={selectedBoneId} showSkeleton onSelectAttachment={selectAttachment} onSelectBone={bindSelectedToBone} onMoveAttachment={(id, translation) => { const attachment = draft.attachments.find((item) => item.id === id); if (attachment) patchRegion(id, { rest: { ...attachment.rest, translation } }); }} />{selectedAttachment && <div className="binding-gizmo-toolbar"><span><Move size={13} />{selectedAttachment.name} → {selectedBone?.name ?? t("animation.binding.chooseBone")}</span><button className="px-btn icon" title={t("animation.binding.rotateLeft")} onClick={() => rotateSelected(-5)}><RotateCcw size={13} /></button><button className="px-btn icon" title={t("animation.binding.rotateRight")} onClick={() => rotateSelected(5)}><RotateCw size={13} /></button><button className="px-btn icon" title={t("animation.binding.scaleDown")} onClick={() => scaleSelected(.95)}><ZoomOut size={13} /></button><button className="px-btn icon" title={t("animation.binding.scaleUp")} onClick={() => scaleSelected(1.05)}><ZoomIn size={13} /></button></div>}<p>{t("animation.binding.canvasHint")}</p></article>
      <aside className="binding-inspector">{selectedAttachment && selectedSlot ? <>
        <header><div><span>{t("animation.binding.selectedPart")}</span><h3>{selectedAttachment.name}</h3><small>{t("animation.binding.boundTo", { bone: skeleton.bones.find((bone) => bone.id === selectedSlot.boneId)?.name ?? selectedSlot.boneId })}</small></div><button className="px-btn icon danger" title={t("common.delete")} onClick={removeSelected}><Trash2 size={13} /></button></header>
        <section className="binding-inspector-basics"><label>{t("animation.binding.slotName")}<input className="px-input" value={selectedSlot.name} onChange={(event) => patchSlot(selectedSlotIndex, { name: event.target.value })} /></label><label>{t("animation.bone")}<PxSelect value={selectedSlot.boneId} options={skeleton.bones.map((bone) => ({ value: bone.id, label: bone.name }))} onChange={bindSelectedToBone} /></label><label>{t("animation.binding.material")}<PxSelect value={selectedAttachment.materialId} options={materials.map((item) => ({ value: item.id, label: item.name }))} onChange={(materialId) => patchRegion(selectedAttachment.id, { materialId, imageSlot: "raw" })} /></label><label>{t("animation.binding.imageSlot")}<PxSelect value={selectedAttachment.imageSlot} options={[{ value: "raw", label: t("animation.binding.originalImage") }, { value: "processed", label: t("animation.binding.cutoutImage"), disabled: !selectedMaterial?.processed_path }]} onChange={(imageSlot) => patchRegion(selectedAttachment.id, { imageSlot: imageSlot as "raw" | "processed" })} /></label></section>
        <section className="binding-tuning"><h4>{t("animation.binding.restTransform")}</h4>{sliderField(t("animation.binding.translationX"), selectedAttachment.rest.translation[0], -translationRange, translationRange, .01, (value) => { const translation = [...selectedAttachment.rest.translation] as [number, number, number]; translation[0] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, translation } }); })}{sliderField(t("animation.binding.translationY"), selectedAttachment.rest.translation[1], -translationRange, translationRange, .01, (value) => { const translation = [...selectedAttachment.rest.translation] as [number, number, number]; translation[1] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, translation } }); })}{sliderField(t("animation.binding.rotation"), zRotationFromQuaternion(selectedAttachment.rest.rotation) * 180 / Math.PI, -180, 180, 1, (value) => patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, rotation: quaternionFromZRotation(value * Math.PI / 180) } }))}{sliderField(t("animation.binding.scaleX"), selectedAttachment.rest.scale[0], .05, scaleRange, .01, (value) => { const scale = [...selectedAttachment.rest.scale] as [number, number, number]; scale[0] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, scale } }); })}{sliderField(t("animation.binding.scaleY"), selectedAttachment.rest.scale[1], .05, scaleRange, .01, (value) => { const scale = [...selectedAttachment.rest.scale] as [number, number, number]; scale[1] = value; patchRegion(selectedAttachment.id, { rest: { ...selectedAttachment.rest, scale } }); })}</section>
        <details className="binding-geometry"><summary>{t("animation.binding.geometry")}</summary>{sliderField(t("animation.binding.pivotX"), selectedAttachment.pivot[0], 0, 1, .01, (value) => patchRegion(selectedAttachment.id, { pivot: [value, selectedAttachment.pivot[1]] }))}{sliderField(t("animation.binding.pivotY"), selectedAttachment.pivot[1], 0, 1, .01, (value) => patchRegion(selectedAttachment.id, { pivot: [selectedAttachment.pivot[0], value] }))}{sliderField(t("animation.binding.width"), selectedAttachment.size[0], .01, sizeRange, .01, (value) => patchRegion(selectedAttachment.id, { size: [value, selectedAttachment.size[1]] }))}{sliderField(t("animation.binding.height"), selectedAttachment.size[1], .01, sizeRange, .01, (value) => patchRegion(selectedAttachment.id, { size: [selectedAttachment.size[0], value] }))}<label className="binding-order-field">{t("animation.binding.drawOrder")}<input className="px-input" type="number" step="1" value={selectedSlot.drawOrder} onChange={(event) => patchSlot(selectedSlotIndex, { drawOrder: Number(event.target.value) })} /></label></details>
        <button className="px-btn" title={t("animation.binding.resetTransform")} onClick={() => { const original = binding.attachments.find((item) => item.id === selectedAttachment.id); if (original) patchRegion(selectedAttachment.id, { rest: structuredClone(original.rest), pivot: [...original.pivot], size: [...original.size] }); }}><Redo2 size={13} />{t("animation.binding.resetTransform")}</button>
      </> : <p className="animation-empty">{t("animation.binding.empty")}</p>}</aside>
    </div>
  </section>;
}

export default function AnimationAssetsWorkspace() {
  const t = useT(), inputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]), [folders, setFolders] = useState<Folder[]>([]), [folder, setFolder] = useState<FolderSelection>("all");
  const [selected, setSelected] = useState<string>(), [stored, setStored] = useState<AnimationAsset>(), [skeleton, setSkeleton] = useState<Skeleton>();
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [renaming, setRenaming] = useState(false), [name, setName] = useState("");
  const [selectedBone, setSelectedBone] = useState(""), [busy, setBusy] = useState(false);
  const [materials, setMaterials] = useState<Material[]>([]), [creatingBinding, setCreatingBinding] = useState(false), [bindingSkeletonId, setBindingSkeletonId] = useState("");
  const [draft, setDraft] = useState({ tx: 0, ty: 0, rz: 0, sx: 1, sy: 1 });
  const [eventDraft, setEventDraft] = useState({ type: "", name: "" });
  const [undo, setUndo] = useState<MotionClip[]>([]), [redo, setRedo] = useState<MotionClip[]>([]);
  const load = useCallback(async () => { const [a, f, m] = await Promise.all([api.listAnimationAssets(), api.listFolders("animation"), api.listMaterials()]); setAssets(a); setFolders(f); setMaterials(m.filter((item) => item.kind === "image")); }, []);
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
  useEffect(() => {
    if (!clip || !skeleton || !selectedBone) return;
    const transform = sampleMotionClip(clip, skeleton, time).local[selectedBone];
    if (transform) setDraft({ tx: transform.translation[0], ty: transform.translation[1], rz: zRotationFromQuaternion(transform.rotation) * 180 / Math.PI, sx: transform.scale[0], sy: transform.scale[1] });
  }, [clip, skeleton, selectedBone, time]);
  useEffect(() => { if (!playing || !clip) return; let raf = 0, last = performance.now(); const tick = (now: number) => { const delta = (now - last) / 1000; last = now; setTime((old) => { const next = old + delta; if (clip.loop && clip.duration) return next % clip.duration; if (next >= clip.duration) { setPlaying(false); return clip.duration; } return next; }); raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [playing, clip]);
  const visible = assets.filter((a) => a.kind !== "render-profile" && (isBuiltinAnimationAssetId(a.id) || folder === "all" || (folder === "ungrouped" ? !a.folder_id : a.folder_id === folder))).toSorted((a, b) => (BUILTIN_ASSET_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (BUILTIN_ASSET_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER));
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
    if (await commitClipEdit(addMotionEvent(clip, { time, type: eventDraft.type, name: eventDraft.name }))) setEventDraft({ type: "", name: "" });
  };
  const setInterpolation = async (targetId: string, property: string, interpolation: MotionInterpolation) => {
    if (!clip || busy) return;
    await commitClipEdit({ ...clip, tracks: clip.tracks.map((track) => track.targetId === targetId && track.property === property ? { ...track, interpolation } : track) });
  };
  const setRootMotion = async (value: string) => {
    if (!clip || busy) return;
    const next = { ...clip };
    if (value) next.rootMotion = value as RootMotionPolicy;
    else delete next.rootMotion;
    await commitClipEdit(next);
  };
  const hasCurrentKey = !!clip?.tracks.some((track) => track.targetId === selectedBone && track.keyframes.some((key) => Math.abs(key.time - time) <= MOTION_KEY_TIME_EPSILON));
  const numberField = (key: keyof typeof draft, label: string) => <label>{label}<input className="px-input" type="number" step="0.01" value={draft[key]} disabled={busy || builtin} onChange={(event) => setDraft((old) => ({ ...old, [key]: +event.target.value }))} /></label>;
  const createBinding = async () => { const selectedSkeleton = assets.find((item) => item.id === bindingSkeletonId && item.kind === "skeleton"); if (!selectedSkeleton) return; try { const made = await api.createAnimationAsset({ schemaVersion: 1, kind: "character-binding", id: uid("binding"), name: t("animation.binding.newName"), skeletonId: selectedSkeleton.id, slots: [], attachments: [] }, folder === "all" || folder === "ungrouped" ? null : folder); setCreatingBinding(false); await load(); setSelected(made.asset.id); } catch (e) { notify(t("animation.binding.createFailed", { msg: (e as Error).message })); } };
  return <div className="animation-workspace">
    <aside className="pixel-panel animation-folders"><h3>{t("animation.folders")}</h3><FolderTree kind="animation" folders={folders} selected={folder} onSelect={setFolder} onCreate={async (n, p) => { await api.createFolder("animation", n, p); await load(); }} onRename={async (id, n) => { await api.patchFolder(id, { name: n }); await load(); }} onDelete={async (id) => { await api.deleteFolder(id); await load(); }} onMoveFolder={async (id, p) => { await api.patchFolder(id, { parentId: p }); await load(); }} onDropItems={(folderId, ids) => void api.moveItems("animation", ids, folderId).then(load).catch((e) => notify(t("animation.moveFailed", { msg: e.message })))} /></aside>
    <section className="pixel-panel animation-library"><header><h2>{t("animation.assets")}</h2><div className="animation-library-actions"><input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(e) => { void importFile(e.target.files?.[0]); e.currentTarget.value = ""; }} /><button className="px-btn" onClick={() => inputRef.current?.click()}><Upload size={14} />{t("animation.importJson")}</button><button className="px-btn" onClick={() => setCreatingBinding((value) => !value)}><Plus size={14} />{t("animation.binding.create")}</button><button className="px-btn accent" onClick={() => void (async () => { let skeletonId: string | undefined; try { const [s, c] = makeExample(t("animation.exampleSkeletonName"), t("animation.exampleClipName")); skeletonId = s.id; const targetFolder = folder === "all" || folder === "ungrouped" ? null : folder; await api.createAnimationAsset(s, targetFolder); const made = await api.createAnimationAsset(c, targetFolder); await load(); setSelected(made.asset.id); } catch (e) { if (skeletonId) await api.deleteAnimationAsset(skeletonId).catch(() => undefined); notify(t("animation.exampleFailed", { msg: (e as Error).message })); } })()}><Plus size={14} />{t("animation.createExample")}</button></div></header>{creatingBinding && <div className="binding-create"><label>{t("animation.binding.skeleton")}<PxSelect value={bindingSkeletonId} options={assets.filter((item) => item.kind === "skeleton").map((item) => ({ value: item.id, label: item.name }))} onChange={setBindingSkeletonId} /></label><button className="px-btn accent" disabled={!bindingSkeletonId} onClick={() => void createBinding()}>{t("animation.binding.confirmCreate")}</button><button className="px-btn" onClick={() => setCreatingBinding(false)}>{t("common.cancel")}</button></div>}<div className="animation-list">{visible.map((asset) => { const locked = isBuiltinAnimationAssetId(asset.id); return <button draggable={!locked} onDragStart={locked ? undefined : (e) => e.dataTransfer.setData("application/x-framebaker-ids", JSON.stringify([asset.id]))} className={`${selected === asset.id ? "on" : ""}${locked ? " builtin" : ""}`} key={asset.id} onClick={() => setSelected(asset.id)}><strong>{asset.name}</strong><span>{locked && <Lock size={11} />}{locked ? t("animation.builtin.badge") : asset.kind === "skeleton" ? t("animation.skeleton") : asset.kind === "motion-clip" ? t("animation.motionClip") : t("animation.binding.kind")}</span></button>; })}{!visible.length && <p>{t("animation.empty")}</p>}</div></section>
    <main className="pixel-panel animation-preview">{stored && skeleton ? <><header>{renaming && !builtin ? <input className="px-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void saveName()} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /> : <h2>{stored.name}</h2>}<div>{builtin ? <span className="animation-builtin-badge"><Lock size={13} />{t("animation.builtin.badge")}</span> : <><button className="px-btn icon" onClick={() => setRenaming(true)} title={t("animation.rename")}><Pencil size={14} /></button><button className="px-btn icon danger" onClick={() => void remove()} title={t("common.delete")}><Trash2 size={14} /></button></>}</div></header>
      {builtin && <aside className="animation-builtin-notice"><Lock size={20} /><div><strong>{t("animation.builtin.title")}</strong><p>{t(clip ? "animation.builtin.clipHint" : "animation.builtin.skeletonHint")}</p></div>{clip && <button className="px-btn accent" disabled={busy} onClick={() => void copyBuiltinClip()}><Copy size={14} />{t("animation.builtin.copyEdit")}</button>}</aside>}
      {!binding && <SkeletonPreview skeleton={skeleton} clip={clip} time={time} selectedBone={clip ? selectedBone : undefined} onSelectBone={clip ? setSelectedBone : undefined} />}
      {binding && <BindingEditor binding={binding} skeleton={skeleton} materials={materials} busy={busy} onSave={async (next) => { setBusy(true); try { const saved = await api.putAnimationAsset(next.id, next); setStored(saved.asset); notify(t("animation.binding.saved"), "info"); } catch (e) { notify(t("animation.saveFailed", { msg: (e as Error).message })); } finally { setBusy(false); } }} />}
      {clip && <><div className="animation-controls"><button className="px-btn accent" disabled={busy} onClick={() => setPlaying((v) => !v)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? t("animation.pause") : t("animation.play")}</button><input type="range" min="0" max={clip.duration} step="0.001" value={time} onChange={(e) => { setPlaying(false); setTime(+e.target.value); }} /><span>{time.toFixed(2)}s / {clip.duration.toFixed(2)}s</span><label className="px-check"><input type="checkbox" checked={clip.loop} disabled={busy || builtin} onChange={(event) => void toggleLoop(event.target.checked)} />{t("animation.loop")}</label>{clip.loop && <button className="px-btn" disabled={busy || builtin} onClick={() => skeleton && void commitClipEdit(closeMotionLoopSeam(clip, skeleton))}>{t("animation.closeLoopSeam")}</button>}</div>
        <section className="animation-key-editor"><div className="animation-editor-actions"><label>{t("animation.bone")}<PxSelect value={selectedBone} disabled={busy} options={skeleton.bones.map((bone) => ({ value: bone.id, label: bone.name }))} onChange={setSelectedBone} /></label><button className="px-btn icon" disabled={busy || builtin || !undo.length} onClick={() => void travelHistory("undo")} title={t("animation.undo")}><Undo2 size={14} /></button><button className="px-btn icon" disabled={busy || builtin || !redo.length} onClick={() => void travelHistory("redo")} title={t("animation.redo")}><Redo2 size={14} /></button></div><div className="animation-transform-fields">{numberField("tx", t("animation.translationX"))}{numberField("ty", t("animation.translationY"))}{numberField("rz", t("animation.rotationZ"))}{numberField("sx", t("animation.scaleX"))}{numberField("sy", t("animation.scaleY"))}</div><div className="animation-editor-actions"><button className="px-btn accent" disabled={busy || builtin || !selectedBone} onClick={() => void writeKey()}>{t("animation.writeKey")}</button><button className="px-btn danger" disabled={busy || builtin || !hasCurrentKey} onClick={() => void deleteKey()}>{t("animation.deleteKey")}</button></div></section>
        <section className="animation-clip-tools"><label>{t("animation.rootMotion")}<PxSelect value={clip.rootMotion ?? ""} disabled={busy || builtin} options={[{ value: "", label: t("animation.unspecified") }, { value: "preserve", label: t("animation.root.preserve") }, { value: "in-place", label: t("animation.root.inPlace") }, { value: "extracted", label: t("animation.root.extracted") }]} onChange={(value) => void setRootMotion(value)} /></label><div className="animation-event-form"><input className="px-input" value={eventDraft.type} disabled={busy || builtin} placeholder={t("animation.eventType")} onChange={(e) => setEventDraft((old) => ({ ...old, type: e.target.value }))} /><input className="px-input" value={eventDraft.name} disabled={busy || builtin} placeholder={t("animation.eventName")} onChange={(e) => setEventDraft((old) => ({ ...old, name: e.target.value }))} /><button className="px-btn" disabled={busy || builtin || !eventDraft.type.trim() || !eventDraft.name.trim() || (clip.loop && time >= clip.duration)} onClick={() => void addEvent()}>{t("animation.addEvent")}</button></div><div className="animation-event-list">{clip.events.map((event, index) => <div key={`${event.time}-${index}`}><button onClick={() => { setPlaying(false); setTime(event.time); }}>{event.time.toFixed(3)}s · {event.type} · {event.name}</button><button className="px-btn icon danger" disabled={busy || builtin} title={t("common.delete")} onClick={() => void commitClipEdit(deleteMotionEvent(clip, index))}><Trash2 size={12} /></button></div>)}</div></section>
        <div className="animation-tracks">{clip.tracks.map((track) => <div key={`${track.targetId}-${track.property}`}><span>{skeleton.bones.find((bone) => bone.id === track.targetId)?.name ?? t("animation.unknownBone")} · {t(`animation.channel.${track.property}`)}</span><div className="animation-track-interpolation"><button className={track.interpolation === "step" ? "on" : ""} disabled={busy || builtin} onClick={() => void setInterpolation(track.targetId, track.property, "step")}>step</button><button className={track.interpolation === "linear" ? "on" : ""} disabled={busy || builtin} onClick={() => void setInterpolation(track.targetId, track.property, "linear")}>linear</button></div>{track.keyframes.map((key, k) => <button className="animation-key-dot" aria-label={`${key.time}s`} key={k} onClick={() => { setPlaying(false); setTime(key.time); setSelectedBone(track.targetId); }} style={{ left: `${clip.duration ? key.time / clip.duration * 100 : 0}%` }} />)}<b className="animation-playhead" style={{ left: `${clip.duration ? time / clip.duration * 100 : 0}%` }} /></div>)}</div></>}
    </> : <p>{t("animation.selectHint")}</p>}</main>
  </div>;
}
