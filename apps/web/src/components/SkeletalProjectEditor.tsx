import { useCallback, useEffect, useState } from "react";
import type { AnimationAssetSummary, CharacterBinding, CharacterPartSet, Material, MotionClip, RenderProfile, SkeletalProjectAnimation, Skeleton } from "@framebaker/shared";
import { ArrowLeft, Bone, Boxes, Download, Film, Pause, Play, Plus, Trash2 } from "lucide-react";
import { api, materialImageUrl, type Project, type SkeletalProjectDocument } from "../api";
import { bakedRasterZip, bakeAnimationPngSequence, configuredMotionClipForRaster, type BakedRasterDraft } from "../animationBake";
import { useT } from "../i18n";
import { notify } from "../notice";
import { exportSkeletalProjectPackage } from "../export";
import { BindingEditor, CharacterPreview } from "./AnimationAssetsWorkspace";
import PxSelect from "./PxSelect";

type WorkspaceTab = "character" | "animations" | "raster";

export default function SkeletalProjectEditor({ project, onBack }: { project: Project; onBack: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<WorkspaceTab>("character");
  const [document, setDocument] = useState<SkeletalProjectDocument>();
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [partSets, setPartSets] = useState<CharacterPartSet[]>([]);
  const [frameProjects, setFrameProjects] = useState<Project[]>([]);
  const [partSetId, setPartSetId] = useState("");
  const [skeleton, setSkeleton] = useState<Skeleton>();
  const [clip, setClip] = useState<MotionClip>();
  const [bindingTemplateId, setBindingTemplateId] = useState("");
  const [clipToAdd, setClipToAdd] = useState("");
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rasterProfile, setRasterProfile] = useState<RenderProfile>({ schemaVersion: 1, kind: "render-profile", id: "project-raster-profile", name: "Project raster profile", width: 256, height: 256, fps: 12, origin: [128, 192], scale: 32, background: "transparent" });
  const [rasterDraft, setRasterDraft] = useState<BakedRasterDraft>();
  const [rasterProgress, setRasterProgress] = useState("");
  const [targetFrameProjectId, setTargetFrameProjectId] = useState("");
  const [newFrameProjectName, setNewFrameProjectName] = useState(`${project.name} · ${t("skeletal.raster.frameSuffix")}`);

  const exportPackage = async () => {
    if (!skeleton || !document?.character || !document.animations.length) return;
    setBusy(true);
    try {
      await exportSkeletalProjectPackage(project.name, document, skeleton);
      notify(t("skeletal.export.done"), "info");
    } catch (e) {
      notify(t("skeletal.export.failed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    Promise.all([api.getSkeletalProjectDocument(project.id), api.listAnimationAssets(), api.listMaterials(), api.listCharacterPartSets(), api.listProjects()])
      .then(([nextDocument, nextAssets, nextMaterials, nextPartSets, nextProjects]) => {
        if (!active) return;
        setDocument(nextDocument);
        setAssets(nextAssets);
        setMaterials(nextMaterials.filter((item) => item.kind === "image"));
        setPartSets(nextPartSets);
        setFrameProjects(nextProjects.filter((item) => item.kind === "frame"));
      })
      .catch((e) => active && notify(t("skeletal.loadFailed", { msg: (e as Error).message })));
    return () => { active = false; };
  }, [project.id, t]);

  const save = useCallback(async (next: SkeletalProjectDocument) => {
    setBusy(true);
    try {
      const stored = await api.putSkeletalProjectDocument(project.id, next);
      setDocument(stored);
      return true;
    } catch (e) {
      notify(t("skeletal.saveFailed", { msg: (e as Error).message }));
      return false;
    } finally {
      setBusy(false);
    }
  }, [project.id, t]);

  const binding = document?.character?.binding;
  useEffect(() => {
    let active = true;
    if (!binding?.skeletonId) { setSkeleton(undefined); return () => { active = false; }; }
    api.getAnimationAsset(binding.skeletonId).then(({ asset }) => {
      if (active) setSkeleton(asset.kind === "skeleton" ? asset : undefined);
    }).catch((e) => active && notify(t("skeletal.loadFailed", { msg: (e as Error).message })));
    return () => { active = false; };
  }, [binding?.skeletonId, t]);

  const activeAnimation = document?.animations.find((item) => item.id === document.activeAnimationId);
  useEffect(() => {
    let active = true;
    setPlaying(false);
    setElapsed(0);
    if (!activeAnimation) { setClip(undefined); return () => { active = false; }; }
    api.getAnimationAsset(activeAnimation.motionClipId).then(({ asset }) => {
      if (active) setClip(asset.kind === "motion-clip" ? asset : undefined);
    }).catch((e) => active && notify(t("skeletal.loadFailed", { msg: (e as Error).message })));
    return () => { active = false; };
  }, [activeAnimation?.id, activeAnimation?.motionClipId, t]);

  useEffect(() => {
    if (!playing || !clip || !activeAnimation) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = (now - last) / 1000 * activeAnimation.speed;
      last = now;
      setElapsed((old) => {
        const next = old + delta;
        const end = clip.duration * activeAnimation.repeat;
        if (!activeAnimation.loop && next >= end) {
          setPlaying(false);
          return end;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip, activeAnimation]);

  const previewTime = clip?.duration && activeAnimation
    ? (!activeAnimation.loop && elapsed >= clip.duration * activeAnimation.repeat ? clip.duration : elapsed % clip.duration)
    : 0;
  const bindingTemplates = assets.filter((item) => item.kind === "character-binding");
  const compatibleClips = assets.filter((item) => item.kind === "motion-clip" && item.skeleton_id === binding?.skeletonId);
  const selectedPartSet = partSets.find((set) => set.id === partSetId);
  const assemblyMaterials = selectedPartSet ? materials.filter((material) => selectedPartSet.members.some((member) => member.materialId === material.id)) : materials;

  const importCharacter = async () => {
    if (!document || !bindingTemplateId) return;
    setBusy(true);
    try {
      const { asset } = await api.getAnimationAsset(bindingTemplateId);
      if (asset.kind !== "character-binding") throw new Error(t("skeletal.invalidBinding"));
      const next: SkeletalProjectDocument = {
        ...document,
        character: { sourceBindingId: asset.id, binding: structuredClone(asset) },
        animations: [],
        activeAnimationId: null,
      };
      await save(next);
    } catch (e) {
      notify(t("skeletal.importFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const addAnimation = async () => {
    if (!document || !clipToAdd) return;
    const summary = compatibleClips.find((item) => item.id === clipToAdd);
    if (!summary) return;
    let name = summary.name, suffix = 2;
    while (document.animations.some((item) => item.name === name)) name = `${summary.name} ${suffix++}`;
    const animation: SkeletalProjectAnimation = { id: `action-${crypto.randomUUID()}`, name, motionClipId: summary.id, speed: 1, repeat: 1, loop: true };
    await save({ ...document, animations: [...document.animations, animation], activeAnimationId: animation.id });
    setClipToAdd("");
  };

  const patchAnimation = async (id: string, patch: Partial<SkeletalProjectAnimation>) => {
    if (!document) return;
    await save({ ...document, animations: document.animations.map((item) => item.id === id ? { ...item, ...patch } : item) });
  };

  const deleteAnimation = async (id: string) => {
    if (!document) return;
    const animations = document.animations.filter((item) => item.id !== id);
    await save({ ...document, animations, activeAnimationId: document.activeAnimationId === id ? animations[0]?.id ?? null : document.activeAnimationId });
  };

  const bakeRaster = async () => {
    if (!binding || !skeleton || !clip || !activeAnimation) return;
    setBusy(true);
    setRasterDraft(undefined);
    try {
      const configured = configuredMotionClipForRaster(clip, activeAnimation.speed, activeAnimation.repeat);
      const draft = await bakeAnimationPngSequence({
        skeleton,
        clip: configured,
        binding,
        profile: rasterProfile,
        resolveImage: (attachment) => materialImageUrl(attachment.materialId, undefined, attachment.imageSlot),
        onProgress: (done, total) => setRasterProgress(`${done}/${total}`),
      });
      setRasterDraft(draft);
      notify(t("skeletal.raster.baked", { count: draft.frames.length }), "info");
    } catch (e) {
      notify(t("skeletal.raster.failed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const downloadRaster = async () => {
    if (!rasterDraft || !activeAnimation) return;
    const url = URL.createObjectURL(await bakedRasterZip(rasterDraft));
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.name}-${activeAnimation.name}.zip`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const importRasterToFrameProject = async () => {
    if (!rasterDraft || !activeAnimation || busy) return;
    setBusy(true);
    const temporaryMaterialIds: string[] = [];
    try {
      let targetId = targetFrameProjectId;
      if (!targetId) {
        const created = await api.createProject(newFrameProjectName.trim() || `${project.name} · ${t("skeletal.raster.frameSuffix")}`, "frame");
        targetId = created.id;
        const next = { ...created, folder_id: null, created_at: Date.now() } as Project;
        setFrameProjects((items) => [next, ...items]);
        setTargetFrameProjectId(targetId);
      }
      for (const frame of rasterDraft.frames) {
        setRasterProgress(t("skeletal.raster.importProgress", { current: frame.index + 1, total: rasterDraft.frames.length }));
        const form = new FormData();
        const png = frame.png.buffer.slice(frame.png.byteOffset, frame.png.byteOffset + frame.png.byteLength) as ArrayBuffer;
        form.append("file", new File([png], `${activeAnimation.name}_${String(frame.index + 1).padStart(4, "0")}.png`, { type: "image/png" }));
        form.append("autoMatting", "false");
        const uploaded = await api.uploadMaterial(form);
        if (!("materialId" in uploaded)) throw new Error(t("skeletal.raster.imageExpected"));
        temporaryMaterialIds.push(uploaded.materialId);
        await api.importMaterial(uploaded.materialId, targetId);
      }
      notify(t("skeletal.raster.imported", { count: rasterDraft.frames.length }), "info");
    } catch (e) {
      notify(t("skeletal.raster.failed", { msg: (e as Error).message }));
    } finally {
      if (temporaryMaterialIds.length) await api.batchDeleteMaterials(temporaryMaterialIds).catch(() => undefined);
      setBusy(false);
    }
  };

  if (!document) return <div className="project-route-state">{t("project.loading")}</div>;

  return (
    <div className="skeletal-project-shell">
      <header className="skeletal-project-header">
        <button type="button" className="px-btn" onClick={onBack}><ArrowLeft size={16} /> {t("msg.back_to_projects")}</button>
        <div className="skeletal-project-title">
          <span className="project-kind-badge skeletal">{t("project.kind.skeletal")}</span>
          <h1>{project.name}</h1>
          <p>{t("project.skeletal.subtitle")}</p>
        </div>
      </header>

      <nav className="skeletal-project-tabs" aria-label={t("skeletal.workspaceTabs")}>
        <button type="button" className={tab === "character" ? "active" : ""} onClick={() => setTab("character")}><Boxes size={17} /> {t("skeletal.tab.character")}</button>
        <button type="button" className={tab === "animations" ? "active" : ""} onClick={() => setTab("animations")} disabled={!binding}><Play size={17} /> {t("skeletal.tab.animations")} <span>{document.animations.length}</span></button>
        <button type="button" className={tab === "raster" ? "active" : ""} onClick={() => setTab("raster")} disabled={!binding || !activeAnimation}><Film size={17} /> {t("skeletal.tab.raster")}</button>
        <button type="button" className="skeletal-export-button" disabled={busy || !binding || !document.animations.length} onClick={() => void exportPackage()}><Download size={17} /> {t("skeletal.export.runtime")}</button>
      </nav>

      {tab === "character" && <main className="skeletal-character-workspace">
        <section className="pixel-panel skeletal-setup-panel">
          <h2>{t("skeletal.character.title")}</h2>
          <p>{t("skeletal.character.hint")}</p>
          <label>{t("skeletal.character.template")}
            <PxSelect value={bindingTemplateId} options={bindingTemplates.map((item) => ({ value: item.id, label: item.name }))} onChange={setBindingTemplateId} placeholder={t("skeletal.character.chooseTemplate")} />
          </label>
          <label>{t("skeletal.character.partSet")}
            <PxSelect value={partSetId} options={[{ value: "", label: t("skeletal.character.allMaterials") }, ...partSets.map((set) => ({ value: set.id, label: `${set.name} · ${set.members.length}` }))]} onChange={setPartSetId} />
          </label>
          <button type="button" className="px-btn accent" disabled={busy || !bindingTemplateId} onClick={() => void importCharacter()}>{binding ? t("skeletal.character.replace") : t("skeletal.character.import")} </button>
          {!bindingTemplates.length && <p className="animation-empty">{t("skeletal.character.noTemplates")}</p>}
        </section>
        <section className="pixel-panel skeletal-character-editor">
          {binding && skeleton ? <BindingEditor binding={binding} skeleton={skeleton} materials={assemblyMaterials} busy={busy} onSave={async (next: CharacterBinding) => {
            await save({ ...document, character: { sourceBindingId: document.character?.sourceBindingId ?? null, binding: next } });
          }} /> : <div className="skeletal-empty-state"><Bone size={38} /><h2>{t("skeletal.character.empty")}</h2><p>{t("skeletal.character.emptyHint")}</p></div>}
        </section>
      </main>}

      {tab === "animations" && binding && skeleton && <main className="skeletal-animation-workspace">
        <aside className="pixel-panel skeletal-action-list">
          <header><div><h2>{t("skeletal.animations.title")}</h2><p>{t("skeletal.animations.hint")}</p></div></header>
          <div className="skeletal-add-action">
            <PxSelect value={clipToAdd} options={compatibleClips.map((item) => ({ value: item.id, label: item.name }))} onChange={setClipToAdd} placeholder={t("skeletal.animations.chooseClip")} />
            <button type="button" className="px-btn accent" disabled={busy || !clipToAdd} onClick={() => void addAnimation()}><Plus size={14} /> {t("skeletal.animations.add")}</button>
          </div>
          <div className="skeletal-action-items">{document.animations.map((item) => <button type="button" key={item.id} className={document.activeAnimationId === item.id ? "active" : ""} onClick={() => void save({ ...document, activeAnimationId: item.id })}><strong>{item.name}</strong><span>{assets.find((asset) => asset.id === item.motionClipId)?.name ?? item.motionClipId}</span></button>)}</div>
          {!document.animations.length && <p className="animation-empty">{t("skeletal.animations.empty")}</p>}
        </aside>
        <section className="pixel-panel skeletal-sequence-editor">
          {activeAnimation && clip ? <>
            <div className="skeletal-live-preview"><CharacterPreview binding={binding} skeleton={skeleton} clip={clip} time={previewTime} /></div>
            <div className="skeletal-playback-controls">
              <button type="button" className="px-btn accent" onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? t("animation.pause") : t("animation.play")}</button>
              <input type="range" min="0" max={clip.duration} step="0.001" value={previewTime} onChange={(e) => { setPlaying(false); setElapsed(+e.target.value); }} />
              <span>{previewTime.toFixed(2)}s / {clip.duration.toFixed(2)}s</span>
            </div>
            <div className="skeletal-action-settings">
              <label>{t("skeletal.animations.name")}<input className="px-input" value={activeAnimation.name} onChange={(e) => setDocument({ ...document, animations: document.animations.map((item) => item.id === activeAnimation.id ? { ...item, name: e.target.value } : item) })} onBlur={(e) => void patchAnimation(activeAnimation.id, { name: e.target.value.trim() || activeAnimation.name })} /></label>
              <label>{t("skeletal.animations.speed")}<input className="px-input" type="number" min="0.1" max="8" step="0.1" value={activeAnimation.speed} onChange={(e) => void patchAnimation(activeAnimation.id, { speed: Math.min(8, Math.max(.1, +e.target.value || 1)) })} /></label>
              <label>{t("skeletal.animations.repeat")}<input className="px-input" type="number" min="1" max="100" step="1" value={activeAnimation.repeat} onChange={(e) => void patchAnimation(activeAnimation.id, { repeat: Math.min(100, Math.max(1, Math.round(+e.target.value || 1))) })} /></label>
              <label className="px-check"><input type="checkbox" checked={activeAnimation.loop} onChange={(e) => void patchAnimation(activeAnimation.id, { loop: e.target.checked })} />{t("skeletal.animations.loop")}</label>
              <button type="button" className="px-btn danger" onClick={() => void deleteAnimation(activeAnimation.id)}><Trash2 size={14} /> {t("skeletal.animations.remove")}</button>
            </div>
            <div className="skeletal-event-strip"><strong>{t("skeletal.animations.events")}</strong>{clip.events.map((event, index) => <button type="button" key={`${event.time}-${index}`} onClick={() => { setPlaying(false); setElapsed(event.time); }} style={{ left: `${clip.duration ? event.time / clip.duration * 100 : 0}%` }} title={`${event.type} · ${event.name}`}><span>{event.name}</span></button>)}<i style={{ left: `${clip.duration ? previewTime / clip.duration * 100 : 0}%` }} /></div>
          </> : <div className="skeletal-empty-state"><Play size={38} /><h2>{t("skeletal.animations.empty")}</h2><p>{t("skeletal.animations.emptyHint")}</p></div>}
        </section>
      </main>}

      {tab === "raster" && binding && skeleton && clip && activeAnimation && <main className="pixel-panel skeletal-raster-workspace">
        <header><div><span className="project-kind-badge frame">{t("project.kind.frame")}</span><h2>{t("skeletal.raster.title")}</h2><p>{t("skeletal.raster.hint")}</p></div></header>
        <section className="skeletal-raster-summary"><strong>{activeAnimation.name}</strong><span>{t("skeletal.raster.timing", { speed: activeAnimation.speed, repeat: activeAnimation.repeat })}</span></section>
        <section className="skeletal-raster-config">
          {(["width", "height", "fps", "scale"] as const).map((key) => <label key={key}>{t(`animation.profile.${key}`)}<input className="px-input" type="number" min="1" max={key === "width" || key === "height" ? 4096 : key === "fps" ? 120 : undefined} step={key === "scale" ? .1 : 1} value={rasterProfile[key]} onChange={(e) => { setRasterDraft(undefined); setRasterProfile((old) => ({ ...old, [key]: +e.target.value })); }} /></label>)}
          {([0, 1] as const).map((axis) => <label key={axis}>{t(axis ? "animation.profile.originY" : "animation.profile.originX")}<input className="px-input" type="number" step="1" value={rasterProfile.origin[axis]} onChange={(e) => { const origin = [...rasterProfile.origin] as [number, number]; origin[axis] = +e.target.value; setRasterDraft(undefined); setRasterProfile((old) => ({ ...old, origin })); }} /></label>)}
        </section>
        <div className="animation-editor-actions"><button type="button" className="px-btn accent" disabled={busy} onClick={() => void bakeRaster()}>{busy ? rasterProgress || t("skeletal.raster.baking") : t("skeletal.raster.bake")}</button></div>
        {rasterDraft && <section className="skeletal-raster-result">
          <strong>{t("skeletal.raster.result", { count: rasterDraft.frames.length })}</strong>
          <button type="button" className="px-btn" onClick={() => void downloadRaster()}><Download size={14} /> {t("skeletal.raster.download")}</button>
          <label>{t("skeletal.raster.target")}<PxSelect value={targetFrameProjectId} options={[{ value: "", label: t("skeletal.raster.createTarget") }, ...frameProjects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setTargetFrameProjectId} /></label>
          {!targetFrameProjectId && <input className="px-input" value={newFrameProjectName} onChange={(e) => setNewFrameProjectName(e.target.value)} placeholder={t("skeletal.raster.projectName")} />}
          <button type="button" className="px-btn accent" disabled={busy || (!targetFrameProjectId && !newFrameProjectName.trim())} onClick={() => void importRasterToFrameProject()}><Film size={14} /> {t("skeletal.raster.import")}</button>
        </section>}
      </main>}
    </div>
  );
}
