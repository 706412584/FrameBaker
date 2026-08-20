import { useCallback, useEffect, useRef, useState } from "react";
import { BUILTIN_HUMANOID_SKELETON_ID, stripBuiltinAnimationMarker, verifyFbanimV2Entries, type AnimationAssetSummary, type CharacterBinding, type Material, type MotionClip, type SkeletalProjectAnimation, type Skeleton } from "@framebaker/shared";
import { ArrowLeft, Bone, Boxes, Camera, Download, Pause, Pencil, Play, Plus, Trash2, Upload, X } from "lucide-react";
import { api, type Folder, type Project, type SkeletalProjectDocument } from "../api";
import { localizeSkeletonName } from "../builtinAnimationLabels";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import { exportSkeletalProjectPackage } from "../export";
import { readZip } from "../zip";
import AnimationAssetsWorkspace, { BindingEditor, CharacterPreview, SkeletonEditor } from "./AnimationAssetsWorkspace";
import MaterialImportModal from "./MaterialImportModal";
import PxSelect from "./PxSelect";

type WorkspaceTab = "character" | "animations";
type BindingToolTab = "skeleton" | "parts";

export default function SkeletalProjectEditor({ project, onBack }: { project: Project; onBack: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<WorkspaceTab>("character");
  const [document, setDocument] = useState<SkeletalProjectDocument>();
  const [assets, setAssets] = useState<AnimationAssetSummary[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [materialFolders, setMaterialFolders] = useState<Folder[]>([]);
  const [skeleton, setSkeleton] = useState<Skeleton>();
  const [clip, setClip] = useState<MotionClip>();
  const [skeletonToUse, setSkeletonToUse] = useState("");
  const [clipToAdd, setClipToAdd] = useState("");
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [bindingEditorOpen, setBindingEditorOpen] = useState(false);
  const [materialImportOpen, setMaterialImportOpen] = useState(false);
  const [actionEditorClipId, setActionEditorClipId] = useState<string>();
  const [bindingToolTab, setBindingToolTab] = useState<BindingToolTab>("parts");
  const documentRef = useRef<SkeletalProjectDocument | undefined>(undefined);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveRevisionRef = useRef(0);
  const pendingSaveCountRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // 把当前预览帧序列化成 PNG 上传为项目缩略图（image href 需转为绝对 URL，否则离屏渲染取不到图）
  const captureThumbnail = async () => {
    if (busy) return;
    const svg = previewRef.current?.querySelector("svg");
    if (!svg) return;
    setBusy(true);
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      // SVG 作为图片绘制时不会加载外部子资源，需把部件图片内联为 data URL
      await Promise.all([...clone.querySelectorAll("image")].map(async (image) => {
        const href = image.getAttribute("href");
        if (!href || href.startsWith("data:")) return;
        const blob = await (await fetch(new URL(href, location.href).href)).blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error(t("skeletal.thumbnail.failed", { msg: "部件图片读取失败" })));
          reader.readAsDataURL(blob);
        });
        image.setAttribute("href", dataUrl);
      }));
      const box = svg.viewBox.baseVal;
      if (!box.width || !box.height) throw new Error(t("skeletal.thumbnail.failed", { msg: "预览尺寸无效" }));
      const width = 320;
      const height = Math.max(1, Math.round((width * box.height) / box.width));
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error("SVG 渲染失败"));
          element.src = url;
        });
        const canvas = window.document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 不可用");
        context.drawImage(image, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("PNG 编码失败");
        await api.uploadProjectThumbnail(project.id, blob);
        notify(t("skeletal.thumbnail.done"), "info");
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      notify(t("skeletal.thumbnail.failed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

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
    Promise.all([api.getSkeletalProjectDocument(project.id), api.listAnimationAssets(), api.listMaterials(), api.listFolders("material")])
      .then(([nextDocument, nextAssets, nextMaterials, nextMaterialFolders]) => {
        if (!active) return;
        documentRef.current = nextDocument;
        setDocument(nextDocument);
        // 回到已经组装过角色的项目时，直接回到最常用的动作工作区；新项目仍从角色绑定开始。
        setTab(nextDocument.character ? "animations" : "character");
        setAssets(nextAssets);
        setMaterials(nextMaterials.filter((item) => item.kind === "image"));
        setMaterialFolders(nextMaterialFolders);
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

  const saveSkeleton = async (next: Skeleton) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.putAnimationAsset(next.id, next);
      if (result.asset.kind !== "skeleton") throw new Error(t("skeletal.invalidSkeleton"));
      setSkeleton(result.asset);
      notify(t("animation.skeletonEditor.savedNotice"), "info");
    } catch (e) {
      notify(t("animation.skeletonEditor.saveFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!skeletonToUse || !skeletonAssets.some((item) => item.id === skeletonToUse)) setSkeletonToUse(binding?.skeletonId ?? skeletonAssets[0]?.id ?? "");
    if (!clipToAdd || !compatibleClips.some((item) => item.id === clipToAdd)) setClipToAdd(compatibleClips.find((item) => !document?.animations.some((action) => action.motionClipId === item.id))?.id ?? "");
  }, [binding?.skeletonId, clipToAdd, compatibleClips, document, skeletonAssets, skeletonToUse]);

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

  const createProjectSkeleton = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const source = await api.getAnimationAsset(BUILTIN_HUMANOID_SKELETON_ID);
      if (source.asset.kind !== "skeleton") throw new Error(t("skeletal.invalidSkeleton"));
      const baseSkeleton: Skeleton = {
        ...stripBuiltinAnimationMarker(source.asset),
        id: `skeleton-${crypto.randomUUID()}`,
        name: t("animation.skeletonEditor.newSkeletonName"),
        // 默认手臂只保留上臂和前臂两段；腕骨作为末端关节点保留，方便挂手部素材和记录腕部旋转。
        bones: source.asset.bones.map((bone) => bone.semantic === "leftWrist" || bone.semantic === "rightWrist" ? { ...bone, tipOffset: undefined } : bone),
      };
      await api.createAnimationAsset(baseSkeleton, null);
      const nextAssets = await api.listAnimationAssets();
      setAssets(nextAssets);
      setSkeletonToUse(baseSkeleton.id);
      notify(t("animation.skeletonEditor.savedNotice"), "info");
    } catch (e) {
      notify(t("animation.skeletonEditor.createFailed", { msg: (e as Error).message }));
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

  const createProjectAction = async () => {
    if (!document || !skeleton || busy) return;
    setBusy(true);
    try {
      const motion: MotionClip = { schemaVersion: 1, kind: "motion-clip", id: `motion-${crypto.randomUUID()}`, name: t("skeletal.animations.newName"), skeletonId: skeleton.id, duration: 1, loop: false, tracks: [], events: [], provenance: { source: "manual" } };
      const made = await api.createAnimationAsset(motion, null);
      const animation: SkeletalProjectAnimation = { id: `action-${crypto.randomUUID()}`, name: motion.name, motionClipId: made.asset.id, speed: 1, repeat: 1, loop: false };
      if (await save({ ...document, animations: [...document.animations, animation], activeAnimationId: animation.id })) setActionEditorClipId(made.asset.id);
    } catch (e) {
      notify(t("skeletal.animations.addFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
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
        <div className="skeletal-project-actions">
          <button type="button" className="skeletal-tab-action" disabled={busy} onClick={() => importInputRef.current?.click()}><Upload size={17} /> {t("skeletal.import.runtime")}</button>
          <button type="button" className="skeletal-tab-action" disabled={busy || !binding || !document.animations.length} onClick={() => void exportPackage()}><Download size={17} /> {t("skeletal.export.runtime")}</button>
        </div>
      </nav>

      {tab === "character" && <main className="skeletal-character-workspace">
        <section className="pixel-panel skeletal-setup-panel">
          <h2>{t("skeletal.character.title")}</h2>
          <p>{t("skeletal.character.hint")}</p>
          <label>{t("skeletal.character.skeleton")}
            <PxSelect value={skeletonToUse} options={skeletonAssets.map((item) => ({ value: item.id, label: localizeSkeletonName(item.id, item.name, t) }))} onChange={setSkeletonToUse} placeholder={t("skeletal.character.chooseSkeleton")} />
          </label>
          <button type="button" className="px-btn accent" disabled={busy || !skeletonToUse} onClick={() => void createCharacter()}>{binding ? t("skeletal.character.resetBinding") : t("skeletal.character.createBinding")} </button>
          <button type="button" className="px-btn" disabled={busy} onClick={() => void createProjectSkeleton()}>{t("skeletal.character.createSkeleton")}</button>
          {!skeletonAssets.length && <p className="animation-empty">{t("skeletal.character.noSkeletons")}</p>}
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
          <div className="skeletal-binding-tool-tabs" role="tablist">
            <button type="button" className={`px-btn ${bindingToolTab === "skeleton" ? "accent" : ""}`} onClick={() => setBindingToolTab("skeleton")}>{t("skeletal.character.editSkeleton")}</button>
            <button type="button" className={`px-btn ${bindingToolTab === "parts" ? "accent" : ""}`} onClick={() => setBindingToolTab("parts")}>{t("skeletal.character.editParts")}</button>
          </div>
          {bindingToolTab === "skeleton"
            ? <SkeletonEditor skeleton={skeleton} previewBinding={binding} busy={busy} onSave={saveSkeleton} />
            : <BindingEditor binding={binding} skeleton={skeleton} materials={materials} materialFolders={materialFolders} busy={busy} onMaterialsChanged={() => void reloadMaterialLibrary().catch((e) => notify(t("skeletal.loadFailed", { msg: (e as Error).message })))} onSave={async (next: CharacterBinding) => {
              if (await save({ ...document, character: { binding: next } })) setBindingEditorOpen(false);
            }} />}
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
            <button type="button" className="px-btn" disabled={busy} onClick={() => void createProjectAction()}><Plus size={14} /> {t("skeletal.animations.create")}</button>
          </div>
          <div className="skeletal-action-items">{document.animations.map((item) => <button type="button" key={item.id} className={document.activeAnimationId === item.id ? "active" : ""} onClick={() => void save({ ...document, activeAnimationId: item.id })}><strong>{item.name}</strong><span>{assets.find((asset) => asset.id === item.motionClipId)?.name ?? item.motionClipId}</span></button>)}</div>
          {!document.animations.length && <p className="animation-empty">{t("skeletal.animations.empty")}</p>}
        </aside>
        <section className="pixel-panel skeletal-sequence-editor">
          {activeAnimation && clip ? <>
            <div className="skeletal-live-preview" ref={previewRef}><CharacterPreview binding={binding} skeleton={skeleton} clip={clip} time={previewTime} /></div>
            <div className="skeletal-playback-controls">
              <button type="button" className="px-btn accent" onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? t("animation.pause") : t("animation.play")}</button>
              <input type="range" min="0" max={clip.duration} step="0.001" value={previewTime} onChange={(e) => { setPlaying(false); setElapsed(+e.target.value); }} />
              <span>{previewTime.toFixed(2)}s / {clip.duration.toFixed(2)}s</span>
              <button type="button" className="px-btn" disabled={busy} onClick={() => void captureThumbnail()}><Camera size={14} /> {t("skeletal.thumbnail.set")}</button>
            </div>
            <div className="skeletal-action-settings">
              <label>{t("skeletal.animations.name")}<input className="px-input" value={activeAnimation.name} onChange={(e) => { const next = { ...document, animations: document.animations.map((item) => item.id === activeAnimation.id ? { ...item, name: e.target.value } : item) }; documentRef.current = next; setDocument(next); }} onBlur={(e) => void patchAnimation(activeAnimation.id, { name: e.target.value.trim() || activeAnimation.name })} /></label>
              <label>{t("skeletal.animations.speed")}<input key={`speed-${activeAnimation.id}-${activeAnimation.speed}`} className="px-input" type="number" min="0.1" max="8" step="0.1" defaultValue={activeAnimation.speed} onBlur={(e) => void patchAnimation(activeAnimation.id, { speed: Math.min(8, Math.max(.1, +e.target.value || 1)) })} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
              <label>{t("skeletal.animations.repeat")}<input key={`repeat-${activeAnimation.id}-${activeAnimation.repeat}`} className="px-input" type="number" min="1" max="100" step="1" defaultValue={activeAnimation.repeat} onBlur={(e) => void patchAnimation(activeAnimation.id, { repeat: Math.min(100, Math.max(1, Math.round(+e.target.value || 1))) })} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
              <label className="px-check"><input type="checkbox" checked={activeAnimation.loop} onChange={(e) => void patchAnimation(activeAnimation.id, { loop: e.target.checked })} />{t("skeletal.animations.loop")}</label>
              <button type="button" className="px-btn danger" onClick={() => void deleteAnimation(activeAnimation.id)}><Trash2 size={14} /> {t("skeletal.animations.remove")}</button>
              <button type="button" className="px-btn accent" onClick={() => setActionEditorClipId(activeAnimation.motionClipId)}>{t("skeletal.animations.editOnCharacter")}</button>
            </div>
            <div className="skeletal-event-strip"><strong>{t("skeletal.animations.events")}</strong>{clip.events.map((event, index) => <button type="button" key={`${event.time}-${index}`} onClick={() => { setPlaying(false); setElapsed(event.time); }} style={{ left: `${clip.duration ? event.time / clip.duration * 100 : 0}%` }} title={`${event.type} · ${event.name}`}><span>{event.name}</span></button>)}<i style={{ left: `${clip.duration ? previewTime / clip.duration * 100 : 0}%` }} /></div>
          </> : <div className="skeletal-empty-state"><Play size={38} /><h2>{t("skeletal.animations.empty")}</h2><p>{t("skeletal.animations.emptyHint")}</p></div>}
        </section>
      </main>}

      {actionEditorClipId && binding && skeleton && <div className="modal-mask skeletal-action-editor-mask">
        <section className="modal pixel-panel skeletal-action-editor-modal" role="dialog" aria-modal="true" aria-label={t("skeletal.animations.editOnCharacter")}>
          <header className="skeletal-binding-editor-titlebar">
            <div><h2>{t("skeletal.animations.editOnCharacter")}</h2><p>{t("skeletal.animations.editOnCharacterHint")}</p></div>
            <button type="button" className="px-btn icon" title={t("common.close")} aria-label={t("common.close")} onClick={() => setActionEditorClipId(undefined)}><X size={17} /></button>
          </header>
          <AnimationAssetsWorkspace onOpenProjects={() => undefined} initialAssetId={actionEditorClipId} previewBinding={binding} />
        </section>
      </div>}

    </div>
  );
}
