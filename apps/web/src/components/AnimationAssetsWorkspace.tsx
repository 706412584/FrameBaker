import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBoneEndpoint, sampleMotionClip, transformPoint, type AnimationAsset, type AnimationAssetSummary, type MotionClip, type Skeleton } from "@framebaker/shared";
import { Pause, Pencil, Play, Plus, Trash2, Upload } from "lucide-react";
import { api, type Folder } from "../api";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import FolderTree, { type FolderSelection } from "./FolderTree";

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const identity = () => ({ translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });

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

function SkeletonPreview({ skeleton, clip, time }: { skeleton: Skeleton; clip?: MotionClip; time: number }) {
  const pose = useMemo(() => clip ? sampleMotionClip(clip, skeleton, time) : sampleMotionClip({ schemaVersion: 1, kind: "motion-clip", id: "rest", name: "Rest", skeletonId: skeleton.id, duration: 0, loop: false, tracks: [], events: [] }, skeleton, 0), [clip, skeleton, time]);
  const points = skeleton.bones.map((bone) => transformPoint(pose.worldMatrices[bone.id]!, [0, 0, 0]));
  const ends = skeleton.bones.map((bone) => getBoneEndpoint(pose, skeleton, bone.id));
  const all = [...points, ...ends.filter(Boolean) as [number, number, number][]];
  const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0])), minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]));
  const pad = .5, width = Math.max(1, maxX - minX + pad * 2), height = Math.max(1, maxY - minY + pad * 2);
  const xy = (p: [number, number, number]) => ({ x: p[0], y: maxY + pad - p[1] });
  return <svg className="animation-skeleton" viewBox={`${minX - pad} 0 ${width} ${height}`} role="img">
    {skeleton.bones.map((bone, i) => { const parent = bone.parentId ? skeleton.bones.findIndex((b) => b.id === bone.parentId) : -1; if (parent < 0) return null; const a = xy(points[parent]!), b = xy(points[i]!); return <line key={bone.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />; })}
    {skeleton.bones.map((bone, i) => { const p = xy(points[i]!); return <circle key={bone.id} cx={p.x} cy={p.y} r=".07" />; })}
    {ends.map((end, i) => end && skeleton.bones[i]!.tipOffset ? <line className="tip" key={`tip-${i}`} x1={xy(points[i]!).x} y1={xy(points[i]!).y} x2={xy(end).x} y2={xy(end).y} /> : null)}
  </svg>;
}

export default function AnimationAssetsWorkspace() {
  const t = useT(), inputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]), [folders, setFolders] = useState<Folder[]>([]), [folder, setFolder] = useState<FolderSelection>("all");
  const [selected, setSelected] = useState<string>(), [stored, setStored] = useState<AnimationAsset>(), [skeleton, setSkeleton] = useState<Skeleton>();
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [renaming, setRenaming] = useState(false), [name, setName] = useState("");
  const load = useCallback(async () => { const [a, f] = await Promise.all([api.listAnimationAssets(), api.listFolders("animation")]); setAssets(a); setFolders(f); }, []);
  useEffect(() => { void load().catch((e) => notify(t("animation.loadFailed", { msg: e.message }))); }, [load, t]);
  useEffect(() => {
    let active = true;
    if (!selected) { setStored(undefined); setSkeleton(undefined); return () => { active = false; }; }
    void api.getAnimationAsset(selected).then(async ({ asset }) => {
      const nextSkeleton = asset.kind === "skeleton" ? asset : (await api.getAnimationAsset(asset.skeletonId)).asset as Skeleton;
      if (!active) return;
      setStored(asset); setName(asset.name); setTime(0); setPlaying(false); setSkeleton(nextSkeleton);
    }).catch((e) => { if (active) notify(t("animation.loadFailed", { msg: e.message })); });
    return () => { active = false; };
  }, [selected, t]);
  const clip = stored?.kind === "motion-clip" ? stored : undefined;
  useEffect(() => { if (!playing || !clip) return; let raf = 0, last = performance.now(); const tick = (now: number) => { const delta = (now - last) / 1000; last = now; setTime((old) => { const next = old + delta; if (clip.loop && clip.duration) return next % clip.duration; if (next >= clip.duration) { setPlaying(false); return clip.duration; } return next; }); raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [playing, clip]);
  const visible = assets.filter((a) => folder === "all" || (folder === "ungrouped" ? !a.folder_id : a.folder_id === folder));
  const importFile = async (file?: File) => { if (!file) return; try { const value = JSON.parse(await file.text()) as AnimationAsset; const result = await api.createAnimationAsset(value, folder === "all" || folder === "ungrouped" ? null : folder); await load(); setSelected(result.asset.id); notify(t("animation.imported"), "info"); } catch (e) { notify(t("animation.importFailed", { msg: (e as Error).message })); } };
  const saveName = async () => { if (!stored || !name.trim()) return; try { const updated = await api.putAnimationAsset(stored.id, { ...stored, name: name.trim() }); setStored(updated.asset); setRenaming(false); await load(); } catch (e) { notify(t("animation.renameFailed", { msg: (e as Error).message })); } };
  const remove = async () => { if (!stored || !(await askConfirm(t("animation.deleteConfirm", { name: stored.name })))) return; try { await api.deleteAnimationAsset(stored.id); setSelected(undefined); await load(); } catch (e) { notify(t("animation.deleteFailed", { msg: (e as Error).message })); } };
  return <div className="animation-workspace">
    <aside className="pixel-panel animation-folders"><h3>{t("animation.folders")}</h3><FolderTree kind="animation" folders={folders} selected={folder} onSelect={setFolder} onCreate={async (n, p) => { await api.createFolder("animation", n, p); await load(); }} onRename={async (id, n) => { await api.patchFolder(id, { name: n }); await load(); }} onDelete={async (id) => { await api.deleteFolder(id); await load(); }} onMoveFolder={async (id, p) => { await api.patchFolder(id, { parentId: p }); await load(); }} onDropItems={(folderId, ids) => void api.moveItems("animation", ids, folderId).then(load).catch((e) => notify(t("animation.moveFailed", { msg: e.message })))} /></aside>
    <section className="pixel-panel animation-library"><header><h2>{t("animation.assets")}</h2><div><input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(e) => { void importFile(e.target.files?.[0]); e.currentTarget.value = ""; }} /><button className="px-btn" onClick={() => inputRef.current?.click()}><Upload size={14} />{t("animation.importJson")}</button><button className="px-btn accent" onClick={() => void (async () => { let skeletonId: string | undefined; try { const [s, c] = makeExample(t("animation.exampleSkeletonName"), t("animation.exampleClipName")); skeletonId = s.id; const targetFolder = folder === "all" || folder === "ungrouped" ? null : folder; await api.createAnimationAsset(s, targetFolder); const made = await api.createAnimationAsset(c, targetFolder); await load(); setSelected(made.asset.id); } catch (e) { if (skeletonId) await api.deleteAnimationAsset(skeletonId).catch(() => undefined); notify(t("animation.exampleFailed", { msg: (e as Error).message })); } })()}><Plus size={14} />{t("animation.createExample")}</button></div></header><div className="animation-list">{visible.map((asset) => <button draggable onDragStart={(e) => e.dataTransfer.setData("application/x-framebaker-ids", JSON.stringify([asset.id]))} className={selected === asset.id ? "on" : ""} key={asset.id} onClick={() => setSelected(asset.id)}><strong>{asset.name}</strong><span>{asset.kind === "skeleton" ? t("animation.skeleton") : t("animation.motionClip")}</span></button>)}{!visible.length && <p>{t("animation.empty")}</p>}</div></section>
    <main className="pixel-panel animation-preview">{stored && skeleton ? <><header>{renaming ? <input className="px-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void saveName()} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /> : <h2>{stored.name}</h2>}<div><button className="px-btn icon" onClick={() => setRenaming(true)} title={t("animation.rename")}><Pencil size={14} /></button><button className="px-btn icon danger" onClick={() => void remove()} title={t("common.delete")}><Trash2 size={14} /></button></div></header><SkeletonPreview skeleton={skeleton} clip={clip} time={time} />{clip && <><div className="animation-controls"><button className="px-btn accent" onClick={() => setPlaying((v) => !v)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? t("animation.pause") : t("animation.play")}</button><input type="range" min="0" max={clip.duration} step="0.001" value={time} onChange={(e) => { setPlaying(false); setTime(+e.target.value); }} /><span>{time.toFixed(2)}s / {clip.duration.toFixed(2)}s · {clip.loop ? t("animation.loop") : t("animation.once")}</span></div><div className="animation-tracks">{clip.tracks.map((track) => <div key={`${track.targetId}-${track.property}`}><span>{track.targetId} · {track.property}</span>{track.keyframes.map((key, k) => <i key={k} style={{ left: `${clip.duration ? key.time / clip.duration * 100 : 0}%` }} />)}</div>)}<div className="events"><span>{t("animation.events")}</span>{clip.events.map((event, i) => <i key={i} title={event.name} style={{ left: `${clip.duration ? event.time / clip.duration * 100 : 0}%` }} />)}</div></div></>}</> : <p>{t("animation.selectHint")}</p>}</main>
  </div>;
}
