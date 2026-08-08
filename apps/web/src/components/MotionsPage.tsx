import { useCallback, useEffect, useRef, useState } from "react";
import { suggestActionSheetGrid, type HumanoidBoneId, type MotionKeyframe, type MotionView } from "@framebaker/shared";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Image, Pause, Play, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { api, materialImageUrl, type Material } from "../api";
import { useT } from "../i18n";
import { notify } from "../notice";
import { DEFAULT_MOTION_TUNING, forward, interpolate, makeFrame, mirrorFrame, MOTION_PRESET_META, MOTION_PRESETS, RIG, tuneMotion, type MotionPresetId, type MotionTuning } from "../motionRig";
import ActionGenModal from "./ActionGenModal";
import MotionRigCanvas from "./MotionRigCanvas";
import PxSelect from "./PxSelect";

const clone = (frame: MotionKeyframe) => ({ ...frame, id: crypto.randomUUID(), root: { ...frame.root }, rotations: { ...frame.rotations } });

function PoseThumb({ frame, view, className = "" }: { frame: MotionKeyframe; view: MotionView; className?: string }) {
  const points = forward(frame);
  return <svg className={className} viewBox="-125 -195 250 300" aria-hidden="true">
    <g transform={view === "back" || view === "left" ? "scale(-1 1)" : undefined}>
      {RIG.map((bone) => bone.parent && <line key={bone.id} className={bone.id.startsWith("left") ? "left" : bone.id.startsWith("right") ? "right" : "torso"} x1={points[bone.parent].x} y1={points[bone.parent].y} x2={points[bone.id].x} y2={points[bone.id].y} />)}
      {RIG.map((bone) => <circle key={bone.id} cx={points[bone.id].x} cy={points[bone.id].y} r="5" />)}
    </g>
  </svg>;
}

function renderSheet(frames: MotionKeyframe[], view: MotionView) {
  const grid = suggestActionSheetGrid(frames.length);
  const canvas = document.createElement("canvas");
  canvas.width = grid.cols * 512; canvas.height = grid.rows * 512;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#101820"; context.fillRect(0, 0, canvas.width, canvas.height); context.lineCap = "round";
  frames.forEach((frame, index) => {
    const ox = (index % grid.cols) * 512 + 256, oy = Math.floor(index / grid.cols) * 512 + 320;
    const flip = view === "back" || view === "left" ? -1 : 1, points = forward(frame);
    context.lineWidth = 14;
    for (const bone of RIG) {
      if (!bone.parent) continue;
      const a = points[bone.parent], z = points[bone.id];
      context.strokeStyle = "#48c9b0";
      context.beginPath(); context.moveTo(ox + a.x * flip, oy + a.y); context.lineTo(ox + z.x * flip, oy + z.y); context.stroke();
    }
    context.fillStyle = "#f4f1de";
    for (const bone of RIG) { const p = points[bone.id]; context.beginPath(); context.arc(ox + p.x * flip, oy + p.y, 11, 0, Math.PI * 2); context.fill(); }
  });
  return { canvas, grid };
}

export default function MotionsPage() {
  const t = useT();
  const initialClip = useRef<MotionKeyframe[] | null>(null);
  initialClip.current ??= MOTION_PRESETS.idle();
  const [baseFrames, setBaseFrames] = useState(initialClip.current);
  const [frames, setFrames] = useState(initialClip.current);
  const [presetId, setPresetId] = useState<MotionPresetId | "">("idle"), [tuning, setTuning] = useState<MotionTuning>(DEFAULT_MOTION_TUNING);
  const [index, setIndex] = useState(0), [view, setView] = useState<MotionView>("front"), [fps, setFps] = useState(12);
  const [loop, setLoop] = useState(true), [playing, setPlaying] = useState(false), [preview, setPreview] = useState<MotionKeyframe | null>(null);
  const [playRevision, setPlayRevision] = useState(0);
  const [selectedBone, setSelectedBone] = useState<HumanoidBoneId>("pelvis");
  const [materials, setMaterials] = useState<Material[]>([]), [characterId, setCharacterId] = useState(""), [poseId, setPoseId] = useState<string>();
  const [generate, setGenerate] = useState(false), [exporting, setExporting] = useState(false);
  const currentIndex = Math.max(0, Math.min(index, frames.length - 1));
  const playRef = useRef({ frames, fps, loop }); playRef.current = { frames, fps, loop };
  const load = useCallback(() => api.listMaterials().then(setMaterials).catch((error) => notify(t("motion.loadFailed", { msg: error.message }))), [t]);
  useEffect(() => { void load(); }, [load]);
  const images = materials.filter((material) => material.kind === "image"), character = images.find((material) => material.id === characterId);
  const current = frames[currentIndex]!;
  const update = (frame: MotionKeyframe) => {
    const next = frames.map((item, i) => i === currentIndex ? frame : item);
    setFrames(next); setBaseFrames(next); setTuning(DEFAULT_MOTION_TUNING); setPresetId("");
  };
  const choosePreset = (id: MotionPresetId) => {
    const next = MOTION_PRESETS[id]!();
    setPresetId(id); setBaseFrames(next); setTuning(DEFAULT_MOTION_TUNING); setFrames(next); setIndex(0); setPreview(null); setLoop(MOTION_PRESET_META[id].loop); setFps(12); setPlayRevision((value) => value + 1); setPlaying(true);
  };
  const adjustClip = (key: keyof MotionTuning, value: number) => {
    const next = { ...tuning, [key]: value };
    setTuning(next); setFrames(tuneMotion(baseFrames, next)); setPlaying(true);
  };

  useEffect(() => {
    if (!playing) { setPreview(null); return; }
    const start = performance.now(); let raf = 0, active = true;
    const tick = (now: number) => {
      if (!active) return;
      const state = playRef.current, count = state.frames.length, position = (now - start) / 1000 * state.fps, base = Math.floor(position);
      if (count === 0) { setPlaying(false); setPreview(null); return; }
      const i = state.loop ? base % count : Math.min(base, count - 1), next = state.loop ? (i + 1) % count : Math.min(i + 1, count - 1);
      const from = state.frames[i], to = state.frames[next];
      if (!from || !to) { setPreview(null); raf = requestAnimationFrame(tick); return; }
      setIndex(i); setPreview(interpolate(from, to, position - Math.floor(position)));
      if (!state.loop && base >= count - 1) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => { active = false; cancelAnimationFrame(raf); };
  }, [playing, playRevision]);

  const move = (delta: number) => { const to = currentIndex + delta; if (to < 0 || to >= frames.length) return; const reordered = [...frames], [frame] = reordered.splice(currentIndex, 1); reordered.splice(to, 0, frame!); setFrames(reordered); setIndex(to); };
  const nudge = (x: number, y: number) => update({ ...current, root: { x: current.root.x + x, y: current.root.y + y } });
  const exportPose = async (openGenerate: boolean) => {
    setExporting(true);
    try {
      const { canvas, grid } = renderSheet(frames, view);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNG")), "image/png"));
      const form = new FormData(); form.append("file", new File([blob], `humanoid-${view}-${grid.cols}x${grid.rows}-${Date.now()}.png`, { type: "image/png" }));
      const result = await api.uploadMaterial(form); if (!("materialId" in result)) throw new Error(t("motion.exportQueuedUnsupported"));
      setPoseId(result.materialId); await load(); notify(t("motion.exported"), "info");
      if (openGenerate) { if (!character) notify(t("motion.chooseCharacterFirst")); else setGenerate(true); }
    } catch (error) { notify(t("motion.exportFailed", { msg: (error as Error).message })); } finally { setExporting(false); }
  };
  const grid = suggestActionSheetGrid(frames.length);
  const jointLabel = t(`motion.joint.${selectedBone}` as Parameters<typeof t>[0]);

  return <div className="page motions-page">
    <header className="motion-heading"><div><span className="page-kicker">{t("motion.rigName")}</span><h1>{t("motion.editorTitle")}</h1></div><p>{t("motion.editorHint")}</p></header>
    <div className="pixel-panel motion-commandbar">
      <div className="motion-presets"><span>{t("motion.preset")}</span>{(Object.keys(MOTION_PRESETS) as MotionPresetId[]).map((id) => <button className={`motion-chip${id === presetId ? " active" : ""}`} key={id} onClick={() => choosePreset(id)}>{t(`action.${id}` as Parameters<typeof t>[0])}</button>)}</div>
      <div className="motion-playback"><PxSelect value={view} onChange={(next) => setView(next as MotionView)} options={(["front", "back", "left", "right"] as const).map((next) => ({ value: next, label: t(`motion.view.${next}` as Parameters<typeof t>[0]) }))} /><label>{t("motion.fps")}<input className="px-input" type="number" min="1" max="30" value={fps} onChange={(event) => setFps(Math.max(1, Math.min(30, +event.target.value || 1)))} /></label><label className="px-check"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />{t("motion.loop")}</label><button className="px-btn accent" onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? t("motion.stop") : t("motion.play")}</button></div>
    </div>
    <div className="motion-workspace">
      <main className="pixel-panel motion-stage"><div className="motion-stage-label">{t("motion.stage")}</div><MotionRigCanvas frame={preview ?? current} view={view} selected={selectedBone} selectedLabel={jointLabel} disabled={playing} onSelect={setSelectedBone} onChange={update} /><div className="motion-stage-status">{t("motion.currentFrame", { n: currentIndex + 1, total: frames.length })}</div></main>
      <aside className="pixel-panel motion-inspector">
        <section className="motion-tuning"><div className="motion-section-heading"><h3>{t("motion.clipTuning")}</h3><button className="px-btn icon" onClick={() => { setTuning(DEFAULT_MOTION_TUNING); setFrames(baseFrames); setPlaying(true); }} aria-label={t("motion.resetTuning")}><RotateCcw size={14} /></button></div><small>{t("motion.clipTuningHint")}</small>{([
          ["amplitude", "motion.tuning.amplitude", 50, 150, "%", 100],
          ["armSwing", "motion.tuning.armSwing", 0, 180, "%", 100],
          ["legStride", "motion.tuning.legStride", 0, 180, "%", 100],
          ["bounce", "motion.tuning.bounce", 0, 200, "%", 100],
          ["lean", "motion.tuning.lean", -30, 30, "°", 1],
        ] as const).map(([key, label, min, max, suffix, scale]) => <label className="motion-tuning-row" key={key}><span>{t(label)}</span><input type="range" min={min} max={max} value={Math.round(tuning[key] * scale)} onChange={(event) => adjustClip(key, Number(event.target.value) / scale)} /><strong>{Math.round(tuning[key] * scale)}{suffix}</strong></label>)}{presetId && <small className="motion-source">{t("motion.source", { source: MOTION_PRESET_META[presetId].source, clip: MOTION_PRESET_META[presetId].sourceClip, frames: MOTION_PRESET_META[presetId].frameCount })}</small>}</section>
        <section><h3>{t("motion.selectedJoint")}</h3><div className="motion-joint-readout"><strong>{jointLabel}</strong><span>{selectedBone === "pelvis" ? `X ${Math.round(current.root.x)} · Y ${Math.round(current.root.y)}` : `${Math.round(current.rotations[selectedBone] * 180 / Math.PI)}°`}</span></div></section>
        <section><h3>{t("motion.poseOperations")}</h3><div className="motion-inspector-buttons"><button className="px-btn" disabled={playing} onClick={() => update(mirrorFrame(current))}>{t("motion.mirror")}</button><button className="px-btn" disabled={playing} onClick={() => update(makeFrame())}>{t("motion.resetPose")}</button></div><span className="motion-field-label">{t("motion.nudgeRoot")}</span><div className="motion-nudge"><button onClick={() => nudge(0, -4)}><ArrowUp /></button><button onClick={() => nudge(-4, 0)}><ArrowLeft /></button><button onClick={() => nudge(0, 4)}><ArrowDown /></button><button onClick={() => nudge(4, 0)}><ArrowRight /></button></div></section>
        <section><h3>{t("motion.characterReference")}</h3>{character && <img className="motion-character-preview" src={materialImageUrl(character.id, 0)} alt={character.name} />}<PxSelect value={characterId} onChange={setCharacterId} options={[{ value: "", label: t("motion.chooseCharacter") }, ...images.map((material) => ({ value: material.id, label: material.name }))]} />{!images.length && <small>{t("motion.noImageMaterials")}</small>}</section>
        <section><h3>{t("motion.outputPreview")}</h3><div className="motion-sheet-preview" style={{ gridTemplateColumns: `repeat(${grid.cols}, 1fr)` }}>{frames.map((frame) => <PoseThumb key={frame.id} frame={frame} view={view} />)}</div><small>{t("motion.sheetLayout", { cols: grid.cols, rows: grid.rows })}</small></section>
        <section className="motion-export-actions"><button className="px-btn" disabled={exporting} onClick={() => void exportPose(false)}><Image size={15} />{t("motion.export")}</button><button className="px-btn accent" disabled={exporting || !character} onClick={() => void exportPose(true)}><Sparkles size={15} />{t("motion.exportGenerate")}</button></section>
      </aside>
    </div>
    <section className="pixel-panel motion-timeline"><header><div><span className="page-kicker">{t("motion.timeline")}</span><strong>{t("motion.currentFrame", { n: currentIndex + 1, total: frames.length })}</strong></div><div className="motion-timeline-actions"><button className="px-btn" onClick={() => { setFrames((old) => [...old, makeFrame()]); setIndex(frames.length); }}><Plus size={14} />{t("motion.add")}</button><button className="px-btn" onClick={() => { setFrames((old) => [...old.slice(0, currentIndex + 1), clone(old[currentIndex]!), ...old.slice(currentIndex + 1)]); setIndex(currentIndex + 1); }}><Copy size={14} />{t("motion.duplicate")}</button><button className="px-btn" disabled={frames.length === 1} onClick={() => { setFrames((old) => old.filter((_, i) => i !== currentIndex)); setIndex(Math.max(0, currentIndex - 1)); }}><Trash2 size={14} />{t("motion.delete")}</button><button className="px-btn icon" onClick={() => move(-1)}>←</button><button className="px-btn icon" onClick={() => move(1)}>→</button></div></header><div className="motion-frame-strip">{frames.map((frame, i) => <button key={frame.id} className={i === currentIndex ? "selected" : ""} onClick={() => { setPlaying(false); setIndex(i); }}><PoseThumb frame={frame} view={view} /><span>{String(i + 1).padStart(2, "0")}</span></button>)}</div>
    </section>
    {generate && character && poseId && <ActionGenModal material={character} v={0} initialPoseReferenceMaterialId={poseId} onClose={() => setGenerate(false)} onToast={(message) => notify(message, "info")} />}
  </div>;
}
