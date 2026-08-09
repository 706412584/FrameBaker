import { useCallback, useEffect, useState } from "react";
import type { AnimationAssetSummary, CharacterBinding, Material, MotionClip, SkeletalProjectAnimation, Skeleton } from "@framebaker/shared";
import { ArrowLeft, Bone, Boxes, Pause, Play, Plus, Trash2 } from "lucide-react";
import { api, type Project, type SkeletalProjectDocument } from "../api";
import { useT } from "../i18n";
import { notify } from "../notice";
import { BindingEditor, CharacterPreview } from "./AnimationAssetsWorkspace";
import PxSelect from "./PxSelect";

type WorkspaceTab = "character" | "animations";

export default function SkeletalProjectEditor({ project, onBack }: { project: Project; onBack: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<WorkspaceTab>("character");
  const [document, setDocument] = useState<SkeletalProjectDocument>();
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [skeleton, setSkeleton] = useState<Skeleton>();
  const [clip, setClip] = useState<MotionClip>();
  const [bindingTemplateId, setBindingTemplateId] = useState("");
  const [clipToAdd, setClipToAdd] = useState("");
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([api.getSkeletalProjectDocument(project.id), api.listAnimationAssets(), api.listMaterials()])
      .then(([nextDocument, nextAssets, nextMaterials]) => {
        if (!active) return;
        setDocument(nextDocument);
        setAssets(nextAssets);
        setMaterials(nextMaterials.filter((item) => item.kind === "image"));
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
      </nav>

      {tab === "character" && <main className="skeletal-character-workspace">
        <section className="pixel-panel skeletal-setup-panel">
          <h2>{t("skeletal.character.title")}</h2>
          <p>{t("skeletal.character.hint")}</p>
          <label>{t("skeletal.character.template")}
            <PxSelect value={bindingTemplateId} options={bindingTemplates.map((item) => ({ value: item.id, label: item.name }))} onChange={setBindingTemplateId} placeholder={t("skeletal.character.chooseTemplate")} />
          </label>
          <button type="button" className="px-btn accent" disabled={busy || !bindingTemplateId} onClick={() => void importCharacter()}>{binding ? t("skeletal.character.replace") : t("skeletal.character.import")} </button>
          {!bindingTemplates.length && <p className="animation-empty">{t("skeletal.character.noTemplates")}</p>}
        </section>
        <section className="pixel-panel skeletal-character-editor">
          {binding && skeleton ? <BindingEditor binding={binding} skeleton={skeleton} materials={materials} busy={busy} onSave={async (next: CharacterBinding) => {
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
    </div>
  );
}
