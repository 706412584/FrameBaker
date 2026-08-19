import { useCallback, useEffect, useRef, useState } from "react";
import { buildHumanoidAutoBinding, diagnoseHumanoidSkeleton, verifyFbanimV2Entries, type AnimationAssetSummary, type CharacterBinding, type CharacterPartSet, type Material, type MotionClip, type SkeletalProjectAnimation, type Skeleton } from "@framebaker/shared";
import { ArrowLeft, Bone, Boxes, Download, Pause, Pencil, Play, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import { api, type Folder, type Project, type SkeletalProjectDocument } from "../api";
import { localizeSkeletonName } from "../builtinAnimationLabels";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import { exportSkeletalProjectPackage } from "../export";
import { readZip } from "../zip";
import { BindingEditor, CharacterPreview } from "./AnimationAssetsWorkspace";
import MaterialImportModal from "./MaterialImportModal";
import PxSelect from "./PxSelect";

type WorkspaceTab = "character" | "animations";

export default function SkeletalProjectEditor({ project, onBack, onEditActionLibrary }: { project: Project; onBack: () => void; onEditActionLibrary: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<WorkspaceTab>("character");
  const [document, setDocument] = useState<SkeletalProjectDocument>();
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [materialFolders, setMaterialFolders] = useState<Folder[]>([]);
  const [skeleton, setSkeleton] = useState<Skeleton>();
  const [clip, setClip] = useState<MotionClip>();
  const [skeletonToUse, setSkeletonToUse] = useState("");
  const [partSets, setPartSets] = useState<CharacterPartSet[]>([]);
  const [partSetToUse, setPartSetToUse] = useState("");
  const [clipToAdd, setClipToAdd] = useState("");
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [bindingEditorOpen, setBindingEditorOpen] = useState(false);
  const [materialImportOpen, setMaterialImportOpen] = useState(false);
  const documentRef = useRef<SkeletalProjectDocument | undefined>(undefined);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveRevisionRef = useRef(0);
  const pendingSaveCountRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);

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

  const importPackage = async (file?: File) => {
    if (!file || busy) return;
    if (document?.character && !(await askConfirm(t("skeletal.import.replaceConfirm")))) return;
    setBusy(true);
    try {
      const verified = await verifyFbanimV2Entries((await readZip(file)).map((entry) => ({ path: entry.name, bytes: entry.data })));
      if (!verified.ok) throw new Error(verified.issues[0]?.message ?? "包内容校验失败");
      const imported = verified.value;
      const skeletonId = `skeleton-${crypto.randomUUID()}`;
      await api.createAnimationAsset({ ...imported.skeleton, id: skeletonId, name: imported.skeleton.name || file.name.replace(/\.fbanim$/i, "") }, null);
      const materialIds = new Map<string, string>();
      for (const texture of imported.textures) {
        const attachment = imported.characterBinding.attachments.find((item) => item.id === texture.attachmentId);
        const form = new FormData();
        form.append("file", new Blob([texture.bytes.slice().buffer as ArrayBuffer], { type: "image/png" }), `${attachment?.name ?? texture.attachmentId}.png`);
        const result = await api.uploadMaterial(form) as { materialId?: string };
        if (!result.materialId) throw new Error(`纹理「${attachment?.name ?? texture.attachmentId}」导入失败`);
        materialIds.set(texture.attachmentId, result.materialId);
      }
      const binding: CharacterBinding = {
        ...imported.characterBinding,
        id: `binding-${crypto.randomUUID()}`,
        skeletonId,
        attachments: imported.characterBinding.attachments.map((attachment) => ({ ...attachment, materialId: materialIds.get(attachment.id)! })),
      };
      const animations: SkeletalProjectAnimation[] = [];
      for (const action of imported.actions) {
        const motionClipId = `motion-${crypto.randomUUID()}`;
        await api.createAnimationAsset({ ...action.motionClip, id: motionClipId, skeletonId }, null);
        animations.push({ id: `action-${crypto.randomUUID()}`, name: action.name, motionClipId, speed: action.speed, repeat: action.repeat, loop: action.loop });
      }
      const next: SkeletalProjectDocument = { schemaVersion: 1, projectId: project.id, character: { binding }, animations, activeAnimationId: animations[0]?.id ?? null };
      if (!(await save(next))) throw new Error("项目文档保存失败");
      notify(t("skeletal.import.done"), "info");
    } catch (e) {
      notify(t("skeletal.import.failed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    Promise.all([api.getSkeletalProjectDocument(project.id), api.listAnimationAssets(), api.listMaterials(), api.listFolders("material"), api.listCharacterPartSets().catch(() => [])])
      .then(([nextDocument, nextAssets, nextMaterials, nextMaterialFolders, nextPartSets]) => {
        if (!active) return;
        documentRef.current = nextDocument;
        setDocument(nextDocument);
        // 回到已经组装过角色的项目时，直接回到最常用的动作工作区；新项目仍从角色绑定开始。
        setTab(nextDocument.character ? "animations" : "character");
        setAssets(nextAssets);
        setMaterials(nextMaterials.filter((item) => item.kind === "image"));
        setMaterialFolders(nextMaterialFolders);
        // 空部件集（如成员素材已被删除）无法自动组装，不进入向导。
        setPartSets(nextPartSets.filter((item) => item.members.length > 0));
      })
      .catch((e) => active && notify(t("skeletal.loadFailed", { msg: (e as Error).message })));
    return () => { active = false; };
  }, [project.id, t]);

  const save = useCallback(async (next: SkeletalProjectDocument) => {
    const revision = ++saveRevisionRef.current;
    pendingSaveCountRef.current += 1;
    setBusy(true);
    let stored: SkeletalProjectDocument | undefined;
    const operation = saveQueueRef.current.then(async () => {
      stored = await api.putSkeletalProjectDocument(project.id, next);
    });
    saveQueueRef.current = operation.catch(() => undefined);
    try {
      await operation;
      if (revision === saveRevisionRef.current) {
        documentRef.current = stored!;
        setDocument(stored!);
      }
      return true;
    } catch (e) {
      notify(t("skeletal.saveFailed", { msg: (e as Error).message }));
      return false;
    } finally {
      pendingSaveCountRef.current -= 1;
      if (pendingSaveCountRef.current === 0) setBusy(false);
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
  const skeletonAssets = assets.filter((item) => item.kind === "skeleton");
  const compatibleClips = assets.filter((item) => item.kind === "motion-clip" && item.skeleton_id === skeleton?.id);

  const closeBindingEditor = useCallback(() => {
    void askConfirm(t("skeletal.character.closeBindingEditorConfirm")).then((confirmed) => {
      if (confirmed) setBindingEditorOpen(false);
    });
  }, [t]);
  useModalEscClose(closeBindingEditor, bindingEditorOpen && !materialImportOpen);

  const reloadMaterialLibrary = useCallback(async () => {
    const nextMaterials = await api.listMaterials();
    setMaterials(nextMaterials.filter((item) => item.kind === "image"));
  }, []);

  useEffect(() => {
    if (!skeletonToUse || !skeletonAssets.some((item) => item.id === skeletonToUse)) setSkeletonToUse(binding?.skeletonId ?? skeletonAssets[0]?.id ?? "");
    if (!clipToAdd || !compatibleClips.some((item) => item.id === clipToAdd)) setClipToAdd(compatibleClips.find((item) => !document?.animations.some((action) => action.motionClipId === item.id))?.id ?? "");
  }, [binding?.skeletonId, clipToAdd, compatibleClips, document, skeletonAssets, skeletonToUse]);

  useEffect(() => {
    if (!partSetToUse || !partSets.some((item) => item.id === partSetToUse)) setPartSetToUse(partSets[0]?.id ?? "");
  }, [partSets, partSetToUse]);

  const humanoidDiagnosis = skeleton ? diagnoseHumanoidSkeleton(skeleton) : null;
  const canAutoAssemble = !!skeleton && !!humanoidDiagnosis?.isHumanoid && partSets.length > 0;

  const autoAssemble = async () => {
    if (!document || !binding || !skeleton || !partSetToUse) return;
    const partSet = partSets.find((item) => item.id === partSetToUse);
    if (!partSet) return;
    if (binding.slots.length && !(await askConfirm(t("skeletal.character.autoAssembleReplaceConfirm")))) return;
    setBusy(true);
    try {
      const materialById = new Map(materials.map((item) => [item.id, item]));
      const parts = partSet.members
        .filter((member) => materialById.has(member.materialId))
        .map((member) => ({
          role: member.role,
          materialId: member.materialId,
          name: member.name,
          imageSlot: (materialById.get(member.materialId)?.processed_path ? "processed" : "raw") as "raw" | "processed",
        }));
      if (!parts.length) throw new Error(t("skeletal.character.autoAssembleNoMaterials"));
      const { binding: assembled, skipped } = buildHumanoidAutoBinding({
        id: binding.id,
        name: binding.name,
        skeleton,
        parts,
      });
      if (!assembled.slots.length) throw new Error(t("skeletal.character.autoAssembleNoMaterials"));
      if (await save({ ...document, character: { binding: { ...assembled, boneRotationOffsets: binding.boneRotationOffsets } } })) {
        const skippedNames = skipped.filter((role) => role !== "weapon").map((role) => t(`skeletal.partRole.${role}`));
        notify(skippedNames.length
          ? t("skeletal.character.autoAssembledWithSkips", { count: assembled.slots.length, skipped: skippedNames.join("、") })
          : t("skeletal.character.autoAssembled", { count: assembled.slots.length }), "info");
        setBindingEditorOpen(true);
      }
    } catch (e) {
      notify(t("skeletal.character.autoAssembleFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const createCharacter = async () => {
    if (!document || !skeletonToUse) return;
    setBusy(true);
    try {
      const { asset } = await api.getAnimationAsset(skeletonToUse);
      if (asset.kind !== "skeleton") throw new Error(t("skeletal.invalidSkeleton"));
      const skeletonChanged = !!binding && binding.skeletonId !== asset.id;
      if (skeletonChanged && document.animations.length && !(await askConfirm(t("skeletal.character.replaceClearsActions")))) return;
      if (binding && !skeletonChanged && !(await askConfirm(t("skeletal.character.resetBindingConfirm")))) return;
      const nextBinding: CharacterBinding = {
        schemaVersion: 1,
        kind: "character-binding",
        id: `binding-project-${crypto.randomUUID()}`,
        name: t("skeletal.character.projectBindingName", { name: project.name }),
        skeletonId: asset.id,
        slots: [],
        attachments: [],
      };
      const next: SkeletalProjectDocument = {
        ...document,
        character: { binding: nextBinding },
        animations: skeletonChanged ? [] : document.animations,
        activeAnimationId: skeletonChanged ? null : document.activeAnimationId,
      };
      if (await save(next)) setTab("character");
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
    try {
      const { asset } = await api.getAnimationAsset(summary.id);
      if (asset.kind !== "motion-clip") return;
      const animation: SkeletalProjectAnimation = { id: `action-${crypto.randomUUID()}`, name, motionClipId: asset.id, speed: 1, repeat: 1, loop: asset.loop };
      if (!(await save({ ...document, animations: [...document.animations, animation], activeAnimationId: animation.id }))) return;
      setClipToAdd("");
    } catch (e) {
      notify(t("skeletal.animations.addFailed", { msg: (e as Error).message }));
    }
  };

  const patchAnimation = async (id: string, patch: Partial<SkeletalProjectAnimation>) => {
    const current = documentRef.current;
    if (!current) return;
    const next = { ...current, animations: current.animations.map((item) => item.id === id ? { ...item, ...patch } : item) };
    documentRef.current = next;
    setDocument(next);
    await save(next);
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
        <input ref={importInputRef} hidden type="file" accept=".zip,.fbanim,application/zip" onChange={(event) => { void importPackage(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        <button type="button" className="px-btn" disabled={busy} onClick={() => importInputRef.current?.click()}><Upload size={15} /> {t("skeletal.import.runtime")}</button>
        <button type="button" className="skeletal-export-button" disabled={busy || !binding || !document.animations.length} onClick={() => void exportPackage()}><Download size={17} /> {t("skeletal.export.runtime")}</button>
      </nav>

      {tab === "character" && <main className="skeletal-character-workspace">
        <section className="pixel-panel skeletal-setup-panel">
          <h2>{t("skeletal.character.title")}</h2>
          <p>{t("skeletal.character.hint")}</p>
          <label>{t("skeletal.character.skeleton")}
            <PxSelect value={skeletonToUse} options={skeletonAssets.map((item) => ({ value: item.id, label: localizeSkeletonName(item.id, item.name, t) }))} onChange={setSkeletonToUse} placeholder={t("skeletal.character.chooseSkeleton")} />
          </label>
          <button type="button" className="px-btn accent" disabled={busy || !skeletonToUse} onClick={() => void createCharacter()}>{binding ? t("skeletal.character.resetBinding") : t("skeletal.character.createBinding")} </button>
          {!skeletonAssets.length && <p className="animation-empty">{t("skeletal.character.noSkeletons")}</p>}
          {binding && canAutoAssemble && <div className="skeletal-auto-assemble">
            <h3>{t("skeletal.character.autoAssembleTitle")}</h3>
            <p>{t("skeletal.character.autoAssembleHint")}</p>
            <label>{t("skeletal.character.partSet")}
              <PxSelect value={partSetToUse} options={partSets.map((item) => ({ value: item.id, label: item.name }))} onChange={setPartSetToUse} placeholder={t("skeletal.character.choosePartSet")} />
            </label>
            <button type="button" className="px-btn accent" disabled={busy || !partSetToUse} onClick={() => void autoAssemble()}><Sparkles size={14} /> {t("skeletal.character.autoAssemble")}</button>
          </div>}
          {binding && skeleton && humanoidDiagnosis && !humanoidDiagnosis.isHumanoid && <div className="skeletal-semantic-warning">
            <h3>{t("skeletal.character.semanticMismatchTitle")}</h3>
            <p>{t("skeletal.character.semanticMismatchHint")}</p>
            <ul>{humanoidDiagnosis.missing.map((semantic) => <li key={semantic}>{t(`skeletal.boneSemantic.${semantic}`)}</li>)}</ul>
          </div>}
          <button type="button" className="px-btn" onClick={onEditActionLibrary}>{t("skeletal.openActionLibrary")}</button>
        </section>
        <section className="pixel-panel skeletal-character-editor">
          {binding && skeleton ? <div className="skeletal-binding-overview">
            <header><div><h2>{t("skeletal.character.bindingPreview")}</h2><p>{t("skeletal.character.bindingPreviewHint")}</p></div><button type="button" className="px-btn accent" onClick={() => setBindingEditorOpen(true)}><Pencil size={14} /> {t("skeletal.character.editBinding")}</button></header>
            <div className="skeletal-binding-preview"><CharacterPreview binding={binding} skeleton={skeleton} time={0} /></div>
            <div className="skeletal-binding-summary">
              <span><strong>{binding.attachments.length}</strong>{t("skeletal.character.boundParts")}</span>
              <span><strong>{materials.length}</strong>{t("skeletal.character.libraryMaterials")}</span>
            </div>
            <p className="skeletal-material-source-hint">{t("skeletal.character.materialSourceHint")}</p>
          </div> : <div className="skeletal-empty-state"><Bone size={38} /><h2>{t("skeletal.character.empty")}</h2><p>{t("skeletal.character.emptyHint")}</p></div>}
        </section>
      </main>}

      {bindingEditorOpen && binding && skeleton && <div className="modal-mask skeletal-binding-editor-mask">
        <section className="modal pixel-panel skeletal-binding-editor-modal" role="dialog" aria-modal="true" aria-labelledby="skeletal-binding-editor-title">
          <header className="skeletal-binding-editor-titlebar">
            <div><h2 id="skeletal-binding-editor-title">{t("skeletal.character.editBinding")}</h2><p>{t("skeletal.character.editorMaterialHint")}</p></div>
            <div>
              <button type="button" className="px-btn" onClick={() => setMaterialImportOpen(true)}><Upload size={14} /> {t("skeletal.character.importParts")}</button>
              <button type="button" className="px-btn icon" title={t("common.close")} aria-label={t("common.close")} onClick={closeBindingEditor}><X size={17} /></button>
            </div>
          </header>
          <BindingEditor binding={binding} skeleton={skeleton} materials={materials} materialFolders={materialFolders} busy={busy} onSave={async (next: CharacterBinding) => {
            if (await save({ ...document, character: { binding: next } })) setBindingEditorOpen(false);
          }} />
        </section>
        {materialImportOpen && <MaterialImportModal initialTab="upload" onClose={() => setMaterialImportOpen(false)} onDone={() => {
          setMaterialImportOpen(false);
          void reloadMaterialLibrary().catch((e) => notify(t("skeletal.loadFailed", { msg: (e as Error).message })));
        }} />}
      </div>}

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
              <label>{t("skeletal.animations.name")}<input className="px-input" value={activeAnimation.name} onChange={(e) => { const next = { ...document, animations: document.animations.map((item) => item.id === activeAnimation.id ? { ...item, name: e.target.value } : item) }; documentRef.current = next; setDocument(next); }} onBlur={(e) => void patchAnimation(activeAnimation.id, { name: e.target.value.trim() || activeAnimation.name })} /></label>
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
