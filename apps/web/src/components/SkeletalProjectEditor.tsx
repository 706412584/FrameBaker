import { useCallback, useEffect, useState } from "react";
import { BUILTIN_MOTIONS, type AnimationAssetSummary, type CharacterBinding, type CharacterPartSet, type Material, type MotionClip, type SkeletalProjectAnimation, type Skeleton } from "@framebaker/shared";
import { ArrowLeft, Bone, Boxes, Download, Pause, Play, Plus, Trash2 } from "lucide-react";
import { api, materialImageUrl, type Project, type SkeletalProjectDocument } from "../api";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import { exportSkeletalProjectPackage } from "../export";
import { BUILTIN_MOTION_IDS, buildArticulatedAttackAssets, buildRetargetedBuiltinMotionClip, getArticulatedPartSetStatus, type BuiltinMotionId } from "../articulatedCharacter";
import { areSkeletonsRetargetCompatible, retargetMotionClip } from "../motionRetarget";
import { BindingEditor, CharacterPreview } from "./AnimationAssetsWorkspace";
import PxSelect from "./PxSelect";

type WorkspaceTab = "character" | "animations";

export default function SkeletalProjectEditor({ project, onBack, onEditActionLibrary }: { project: Project; onBack: () => void; onEditActionLibrary: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<WorkspaceTab>("character");
  const [document, setDocument] = useState<SkeletalProjectDocument>();
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [partSets, setPartSets] = useState<CharacterPartSet[]>([]);
  const [assetSkeletons, setAssetSkeletons] = useState<Record<string, Skeleton>>({});
  const [partSetId, setPartSetId] = useState("");
  const [skeleton, setSkeleton] = useState<Skeleton>();
  const [clip, setClip] = useState<MotionClip>();
  const [bindingTemplateId, setBindingTemplateId] = useState("");
  const [clipToAdd, setClipToAdd] = useState("");
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);

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
    Promise.all([api.getSkeletalProjectDocument(project.id), api.listAnimationAssets(), api.listMaterials(), api.listCharacterPartSets()])
      .then(([nextDocument, nextAssets, nextMaterials, nextPartSets]) => {
        if (!active) return;
        setDocument(nextDocument);
        // 回到已经组装过角色的项目时，直接回到最常用的动作工作区；新项目仍从角色绑定开始。
        setTab(nextDocument.character ? "animations" : "character");
        setAssets(nextAssets);
        setMaterials(nextMaterials.filter((item) => item.kind === "image"));
        setPartSets(nextPartSets);
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

  useEffect(() => {
    let active = true;
    const ids = [...new Set(assets.flatMap((asset) => asset.kind === "motion-clip" && asset.skeleton_id ? [asset.skeleton_id] : []))];
    Promise.all(ids.map((id) => api.getAnimationAsset(id).then(({ asset }) => asset.kind === "skeleton" ? asset : undefined).catch(() => undefined)))
      .then((loaded) => {
        if (!active) return;
        setAssetSkeletons(Object.fromEntries(loaded.flatMap((item) => item ? [[item.id, item]] : [])));
      });
    return () => { active = false; };
  }, [assets]);

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
  const compatibleClips = assets.filter((item) => item.kind === "motion-clip" && !!skeleton && (
    item.skeleton_id === skeleton.id
    || !!item.skeleton_id && !!assetSkeletons[item.skeleton_id] && areSkeletonsRetargetCompatible(assetSkeletons[item.skeleton_id]!, skeleton)
  ));
  const selectedPartSet = partSets.find((set) => set.id === partSetId);
  const articulatedPartSetStatus = getArticulatedPartSetStatus(selectedPartSet);
  const assemblyMaterials = selectedPartSet ? materials.filter((material) => selectedPartSet.members.some((member) => member.materialId === material.id)) : materials;

  useEffect(() => {
    if (!bindingTemplateId || !bindingTemplates.some((item) => item.id === bindingTemplateId)) setBindingTemplateId(document?.character?.sourceBindingId && bindingTemplates.some((item) => item.id === document.character!.sourceBindingId) ? document.character.sourceBindingId : bindingTemplates[0]?.id ?? "");
    if (!partSetId || !partSets.some((set) => set.id === partSetId)) setPartSetId(partSets.find((set) => getArticulatedPartSetStatus(set).complete)?.id ?? partSets.find((set) => set.members.length)?.id ?? "");
    if (!clipToAdd || !compatibleClips.some((item) => item.id === clipToAdd)) setClipToAdd(compatibleClips.find((item) => !document?.animations.some((action) => action.motionClipId === item.id))?.id ?? "");
  }, [bindingTemplateId, bindingTemplates, clipToAdd, compatibleClips, document, partSetId, partSets]);

  const assembleArticulatedAttack = async () => {
    if (!document || !selectedPartSet || !articulatedPartSetStatus.complete || busy) return;
    if ((document.character || document.animations.length) && !(await askConfirm(t("skeletal.character.articulatedReplaceConfirm")))) return;
    const made = buildArticulatedAttackAssets(selectedPartSet, {
      skeleton: t("skeletal.character.articulatedSkeletonName", { name: selectedPartSet.name }),
      binding: t("skeletal.character.articulatedBindingName", { name: selectedPartSet.name }),
      clip: t("skeletal.character.articulatedAttackName"),
    });
    const createdIds: string[] = [];
    setBusy(true);
    try {
      await api.createAnimationAsset(made.skeleton); createdIds.push(made.skeleton.id);
      await api.createAnimationAsset(made.binding); createdIds.push(made.binding.id);
      await api.createAnimationAsset(made.clip); createdIds.push(made.clip.id);
      const action: SkeletalProjectAnimation = { id: `action-${crypto.randomUUID()}`, name: "attack", motionClipId: made.clip.id, speed: 1, repeat: 1, loop: false };
      const next: SkeletalProjectDocument = {
        ...document,
        character: { sourceBindingId: made.binding.id, binding: structuredClone(made.binding) },
        animations: [action],
        activeAnimationId: action.id,
      };
      const stored = await api.putSkeletalProjectDocument(project.id, next);
      setDocument(stored);
      setAssets(await api.listAnimationAssets());
      setBindingTemplateId(made.binding.id);
      setTab("animations");
      notify(t("skeletal.character.articulatedCreated"), "info");
    } catch (e) {
      for (const id of createdIds.reverse()) await api.deleteAnimationAsset(id).catch(() => undefined);
      notify(t("skeletal.character.articulatedFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const importCharacter = async () => {
    if (!document || !bindingTemplateId) return;
    setBusy(true);
    try {
      const { asset } = await api.getAnimationAsset(bindingTemplateId);
      if (asset.kind !== "character-binding") throw new Error(t("skeletal.invalidBinding"));
      const skeletonChanged = !!binding && binding.skeletonId !== asset.skeletonId;
      if (skeletonChanged && document.animations.length && !(await askConfirm(t("skeletal.character.replaceClearsActions")))) return;
      const next: SkeletalProjectDocument = {
        ...document,
        character: { sourceBindingId: asset.id, binding: structuredClone(asset) },
        animations: skeletonChanged ? [] : document.animations,
        activeAnimationId: skeletonChanged ? null : document.activeAnimationId,
      };
      if (await save(next)) setTab("animations");
    } catch (e) {
      notify(t("skeletal.importFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const addAnimation = async () => {
    if (!document || !skeleton || !clipToAdd) return;
    const summary = compatibleClips.find((item) => item.id === clipToAdd);
    if (!summary) return;
    let name = summary.name, suffix = 2;
    while (document.animations.some((item) => item.name === name)) name = `${summary.name} ${suffix++}`;
    let createdId: string | undefined;
    try {
      const { asset } = await api.getAnimationAsset(summary.id);
      if (asset.kind !== "motion-clip") return;
      let motion = asset;
      if (asset.skeletonId !== skeleton.id) {
        const sourceSkeleton = assetSkeletons[asset.skeletonId] ?? (await api.getAnimationAsset(asset.skeletonId)).asset;
        if (sourceSkeleton.kind !== "skeleton") throw new Error(t("skeletal.animations.retargetMissingSkeleton"));
        motion = retargetMotionClip(asset, sourceSkeleton, skeleton, t("skeletal.animations.retargetedClipName", { name: asset.name }));
        await api.createAnimationAsset(motion);
        createdId = motion.id;
      }
      const animation: SkeletalProjectAnimation = { id: `action-${crypto.randomUUID()}`, name, motionClipId: motion.id, speed: 1, repeat: 1, loop: motion.loop };
      if (!(await save({ ...document, animations: [...document.animations, animation], activeAnimationId: animation.id }))) {
        if (createdId) await api.deleteAnimationAsset(createdId).catch(() => undefined);
        return;
      }
      if (createdId) {
        setAssets(await api.listAnimationAssets().catch(() => assets));
        notify(t("skeletal.animations.retargeted", { name: asset.name }), "info");
      }
      setClipToAdd("");
    } catch (e) {
      if (createdId) await api.deleteAnimationAsset(createdId).catch(() => undefined);
      notify(t("skeletal.animations.retargetFailed", { msg: (e as Error).message }));
    }
  };

  const importBuiltinMotion = async (presetId: BuiltinMotionId) => {
    if (!document || !skeleton || busy) return;
    const existing = document.animations.find((item) => item.name === presetId);
    if (existing) {
      await save({ ...document, activeAnimationId: existing.id });
      return;
    }
    const label = t(`action.${presetId}` as Parameters<typeof t>[0]);
    let createdId: string | undefined;
    let projectSaved = false;
    setBusy(true);
    try {
      const motion = buildRetargetedBuiltinMotionClip(skeleton, presetId, t("skeletal.animations.builtinClipName", { name: label }));
      await api.createAnimationAsset(motion);
      createdId = motion.id;
      const animation: SkeletalProjectAnimation = { id: `action-${crypto.randomUUID()}`, name: presetId, motionClipId: motion.id, speed: 1, repeat: 1, loop: motion.loop };
      const stored = await api.putSkeletalProjectDocument(project.id, { ...document, animations: [...document.animations, animation], activeAnimationId: animation.id });
      projectSaved = true;
      setDocument(stored);
      setAssets(await api.listAnimationAssets().catch(() => assets));
      notify(t("skeletal.animations.builtinImported", { name: label }), "info");
    } catch (e) {
      if (createdId && !projectSaved) await api.deleteAnimationAsset(createdId).catch(() => undefined);
      notify(t("skeletal.animations.builtinFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
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
        <button type="button" className={`${tab === "character" ? "active " : ""}${binding ? "done" : ""}`} onClick={() => setTab("character")}><Boxes size={17} /> 1. {t("skeletal.tab.character")}</button>
        <button type="button" title={!binding ? t("skeletal.step.requiresCharacter") : undefined} className={`${tab === "animations" ? "active " : ""}${document.animations.length ? "done" : ""}`} onClick={() => binding ? setTab("animations") : undefined}><Play size={17} /> 2. {t("skeletal.tab.animations")} <span>{document.animations.length}</span></button>
        <button type="button" className="skeletal-export-button" disabled={busy || !binding || !document.animations.length} onClick={() => void exportPackage()}><Download size={17} /> {t("skeletal.export.runtime")}</button>
      </nav>

      {tab === "character" && <main className="skeletal-character-workspace">
        <section className="pixel-panel skeletal-setup-panel">
          <h2>{t("skeletal.character.title")}</h2>
          <p>{t("skeletal.character.hint")}</p>
          <div className="skeletal-character-picker">
            <strong>{t("skeletal.character.chooseCharacter")}</strong>
            <small>{t("skeletal.character.chooseCharacterHint")}</small>
            {partSets.length ? <div className="skeletal-character-cards">
              {partSets.map((set) => {
                const status = getArticulatedPartSetStatus(set);
                const previewMaterial = set.members.map((member) => materials.find((item) => item.id === member.materialId)).find(Boolean);
                return <button key={set.id} type="button" className={`skeletal-character-card${set.id === partSetId ? " selected" : ""}`} aria-pressed={set.id === partSetId} onClick={() => setPartSetId(set.id)}>
                  <span className="skeletal-character-card-icon">{previewMaterial ? <img src={materialImageUrl(previewMaterial.id, undefined, previewMaterial.processed_path ? "processed" : "raw", 64)} alt="" /> : <Boxes size={18} />}</span>
                  <span><strong>{set.name}</strong><small>{set.members.length} · {status.complete ? t("skeletal.character.articulatedReady") : t("skeletal.character.articulatedMissing", { roles: status.missing.slice(0, 2).map((role) => t(`skeletal.partRole.${role}`)).join("、") })}</small></span>
                </button>;
              })}
            </div> : <p className="animation-empty">{t("skeletal.character.noPartSets")}</p>}
          </div>
          <label>{t("skeletal.character.template")}
            <PxSelect value={bindingTemplateId} options={bindingTemplates.map((item) => ({ value: item.id, label: item.name }))} onChange={setBindingTemplateId} placeholder={t("skeletal.character.chooseTemplate")} />
          </label>
          <label>{t("skeletal.character.partSet")}
            <PxSelect value={partSetId} options={[{ value: "", label: t("skeletal.character.allMaterials") }, ...partSets.map((set) => ({ value: set.id, label: `${set.name} · ${set.members.length}` }))]} onChange={setPartSetId} />
          </label>
          <p>{t("skeletal.character.partSetHint")}</p>
          <section className={`articulated-setup-card ${articulatedPartSetStatus.complete ? "complete" : "incomplete"}`}>
            <strong>{t("skeletal.character.articulatedTitle")}</strong>
            {selectedPartSet ? articulatedPartSetStatus.complete
              ? <p>{t("skeletal.character.articulatedReady")}</p>
              : <p>{t("skeletal.character.articulatedMissing", { roles: articulatedPartSetStatus.missing.map((role) => t(`skeletal.partRole.${role}`)).join("、") || t("skeletal.character.articulatedDuplicate") })}</p>
              : <p>{t("skeletal.character.articulatedChooseSet")}</p>}
            <button type="button" className="px-btn accent" disabled={busy || !articulatedPartSetStatus.complete} onClick={() => void assembleArticulatedAttack()}><Bone size={14} /> {t("skeletal.character.articulatedCreate")}</button>
          </section>
          <button type="button" className="px-btn accent" disabled={busy || !bindingTemplateId} onClick={() => void importCharacter()}>{binding ? t("skeletal.character.replace") : t("skeletal.character.import")} </button>
          {!bindingTemplates.length && <p className="animation-empty">{t("skeletal.character.noTemplates")}</p>}
          <button type="button" className="px-btn" onClick={onEditActionLibrary}>{t("skeletal.openActionLibrary")}</button>
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
          <section className="skeletal-builtin-presets"><header><strong>{t("skeletal.animations.builtinTitle")}</strong><p>{t("skeletal.animations.builtinHint")}</p></header><div>{BUILTIN_MOTION_IDS.map((presetId) => { const existing = document.animations.find((item) => item.name === presetId); const preset = BUILTIN_MOTIONS[presetId]; return <button type="button" className={existing ? "added" : ""} disabled={busy} key={presetId} onClick={() => void importBuiltinMotion(presetId)}><span><strong>{t(`action.${presetId}` as Parameters<typeof t>[0])}</strong><small>{t(preset.loop ? "animation.loop" : "animation.once")} · {preset.frames.length} {t("skeletal.animations.frames")}</small></span><b>{t(existing ? "skeletal.animations.builtinAdded" : "skeletal.animations.builtinImport")}</b></button>; })}</div></section>
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
              <label>{t("skeletal.animations.speed")}<input key={`speed-${activeAnimation.id}-${activeAnimation.speed}`} className="px-input" type="number" min="0.1" max="8" step="0.1" defaultValue={activeAnimation.speed} onBlur={(e) => void patchAnimation(activeAnimation.id, { speed: Math.min(8, Math.max(.1, +e.target.value || 1)) })} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
              <label>{t("skeletal.animations.repeat")}<input key={`repeat-${activeAnimation.id}-${activeAnimation.repeat}`} className="px-input" type="number" min="1" max="100" step="1" defaultValue={activeAnimation.repeat} onBlur={(e) => void patchAnimation(activeAnimation.id, { repeat: Math.min(100, Math.max(1, Math.round(+e.target.value || 1))) })} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
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
