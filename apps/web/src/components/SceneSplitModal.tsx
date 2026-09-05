import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Layers3, MousePointerSquareDashed, Plus, Scan, ScanSearch, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { api, materialImageUrl, type Material } from "../api";
import { cropImage, detectComponents, findOpaqueBounds, sliceAnalyze } from "../imageops/client";
import type { CropRect } from "../imageops/ops";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import PromptEnhancer from "./PromptEnhancer";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import SizePicker from "./SizePicker";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onToast: (msg: string) => void;
  /** 切分/生成完成后刷新素材库 */
  onChanged: () => void;
}

type SceneTab = "auto" | "manual" | "model";
type DetectMode = "components" | "uiSlice";
type Rect = CropRect & { name: string };
type DragRect = { x0: number; y0: number; x1: number; y1: number };

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n) || lo));

/**
 * 加强版「场景拆分」：单弹窗三 Tab
 * - auto：连通域 / UI 智能切片自动预填候选框（纯 JS，等效 OpenCV）
 * - manual：原图上拖框手动指定区域
 * - model：Qwen 分层（云端 /images/layers 或本地 ComfyUI），可选先生成完整场景图
 * auto/manual 共享候选框画布 + 逐块 cropImage→uploadMaterial 上传（复刻 GridSplitModal 落库语义）。
 */
export default function SceneSplitModal({ material: m, v, onClose, onToast, onChanged }: Props) {
  const t = useT();
  const cfg = useServerConfig();
  useModalEscClose(onClose);
  const slot = m.processed_path ? "processed" : "raw";
  const base = m.name.replace(/\s*#\d+$/, "").trim() || t("common.material");

  const [tab, setTab] = useState<SceneTab>("auto");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  // ---- 共享画布状态（auto + manual）----
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [autoTrim, setAutoTrim] = useState(true);
  const [autoMatting, setAutoMatting] = useState(!m.processed_path);
  const [disp, setDisp] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const imgRef = useRef<HTMLImageElement>(null);

  // ---- auto 参数 ----
  const [detectMode, setDetectMode] = useState<DetectMode>("components");
  const [minSize, setMinSize] = useState(16);

  // ---- model 参数 ----
  const engineOptions = useMemo(() => {
    const list: Array<{ value: "cloud" | "local"; label: string; enabled: boolean }> = [
      { value: "cloud", label: t("sceneSplit.engineCloud"), enabled: cfg?.imageLayers.configured ?? false },
      { value: "local", label: t("sceneSplit.engineLocal"), enabled: cfg?.comfyLocal.configured ?? false },
    ];
    return list;
  }, [cfg, t]);
  const [engine, setEngine] = useState<"cloud" | "local">("cloud");
  const [layers, setLayers] = useState(2);
  const [localPrompt, setLocalPrompt] = useState("");
  const [localSize, setLocalSize] = useState(640);
  const [filterSolid, setFilterSolid] = useState(true);
  // 默认引擎跟随配置：云端没配但本地配了则默认本地，避免开始按钮一进来就灰置。
  useEffect(() => {
    if (!cfg) return;
    if (!cfg.imageLayers.configured && cfg.comfyLocal.configured) setEngine("local");
  }, [cfg]);
  // 先生成场景图
  const [genOpen, setGenOpen] = useState(false);
  const [genPrompt, setGenPrompt] = useState("");
  const [genProviderId, setGenProviderId] = useState("");
  const [genModel, setGenModel] = useState("");
  const [genSize, setGenSize] = useState("");
  const [genUseRef, setGenUseRef] = useState(true);

  // 载入图片尺寸
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(materialImageUrl(m.id, v, slot));
        if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
        const bmp = await createImageBitmap(await res.blob());
        if (!alive) { bmp.close(); return; }
        setImgSize({ w: bmp.width, h: bmp.height });
        bmp.close();
      } catch (e) {
        notify(t("msg.failed_to_read_material_image") + `: ${(e as Error).message}`);
      }
    })();
    return () => { alive = false; };
  }, [m.id, v, slot, t]);

  const fetchSlotBlob = useCallback(async (which: "raw" | "processed"): Promise<Blob> => {
    const res = await fetch(materialImageUrl(m.id, v, which));
    if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
    return res.blob();
  }, [m.id, v, t]);

  const nameRects = (list: CropRect[]): Rect[] =>
    list.map((r, i) => ({ ...r, name: `${base}_part_${String(i + 1).padStart(2, "0")}` }));

  /** 自动检测：连通域（透明图）或 UI 智能切片（实底图） */
  const runDetect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setProgress(t("sceneSplit.detecting"));
    try {
      const blob = await fetchSlotBlob(slot);
      const found = detectMode === "components"
        ? await detectComponents(blob, { minAreaPixels: Math.max(16, minSize * minSize), maxComponents: 64 })
        : (await sliceAnalyze(blob, { minSize })).candidates.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
      if (!found.length) {
        notify(t("sceneSplit.noRegions"), "info");
        setRects([]);
        return;
      }
      setRects(nameRects(found));
      onToast(t("sceneSplit.detectedCount", { count: found.length }));
    } catch (e) {
      notify(t("sceneSplit.detectFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
      setProgress("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, detectMode, minSize, slot, fetchSlotBlob, t]);

  // 切到 auto Tab 且尚无候选时自动检测一次
  useEffect(() => {
    if (tab === "auto" && imgSize && rects.length === 0 && !busy) void runDetect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, imgSize]);

  // ---- 画布拖框（显示坐标 ↔ 图片像素）----
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || busy) return;
    const r = e.currentTarget.getBoundingClientRect();
    setDragRect({ x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRect) return;
    const r = e.currentTarget.getBoundingClientRect();
    setDragRect((d) => (d ? { ...d, x1: Math.max(0, Math.min(r.width, e.clientX - r.left)), y1: Math.max(0, Math.min(r.height, e.clientY - r.top)) } : d));
  };
  const onCanvasPointerUp = () => {
    if (!dragRect) return;
    const host = imgRef.current;
    const dispW = host?.clientWidth || 1;
    const dispH = host?.clientHeight || 1;
    const natW = host?.naturalWidth || dispW;
    const natH = host?.naturalHeight || dispH;
    const toImg = (val: number, disp: number, nat: number) => Math.round((val / disp) * nat);
    const x = toImg(Math.min(dragRect.x0, dragRect.x1), dispW, natW);
    const y = toImg(Math.min(dragRect.y0, dragRect.y1), dispH, natH);
    const w = toImg(Math.abs(dragRect.x1 - dragRect.x0), dispW, natW);
    const h = toImg(Math.abs(dragRect.y1 - dragRect.y0), dispH, natH);
    setDragRect(null);
    if (w < 4 || h < 4) return; // 误触忽略
    setRects((prev) => [...prev, { x, y, w, h, name: `${base}_part_${String(prev.length + 1).padStart(2, "0")}` }]);
  };

  const updateRect = (i: number, key: keyof CropRect, val: number) =>
    setRects((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: Math.max(0, val) } : r)));
  const renameRect = (i: number, name: string) =>
    setRects((prev) => prev.map((r, j) => (j === i ? { ...r, name } : r)));
  const deleteRect = (i: number) => setRects((prev) => prev.filter((_, j) => j !== i));
  const addRect = () =>
    setRects((prev) => [...prev, { x: 0, y: 0, w: 64, h: 64, name: `${base}_part_${String(prev.length + 1).padStart(2, "0")}` }]);

  /** 逐块裁剪并上传为新素材（复刻 GridSplitModal 落库语义） */
  const applySplit = async () => {
    if (busy || !imgSize || rects.length === 0) return;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    let firstError = "";
    try {
      const blob = await fetchSlotBlob(slot);
      const rawBlob = m.processed_path ? await fetchSlotBlob("raw") : blob;
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i]!;
        setProgress(t("sceneSplit.uploading", { i: i + 1, total: rects.length }));
        try {
          let cell = await cropImage(blob, rect);
          let rawCell = m.processed_path ? await cropImage(rawBlob, rect) : cell;
          if (autoTrim) {
            const bounds = await findOpaqueBounds(cell);
            if (bounds && (bounds.w < rect.w || bounds.h < rect.h || bounds.x > 0 || bounds.y > 0)) {
              cell = await cropImage(cell, bounds);
              if (m.processed_path) rawCell = await cropImage(rawCell, bounds);
            }
          }
          if (!m.processed_path) rawCell = cell;
          const cellName = rect.name.trim() || `${base}_part_${i + 1}`;
          const fd = new FormData();
          fd.append("file", rawCell, `${cellName}.png`);
          if (m.processed_path) fd.append("processedFile", cell, `${cellName}_processed.png`);
          fd.append("autoMatting", String(autoMatting && !m.processed_path));
          fd.append("metadata", JSON.stringify({
            sceneSplit: { fromMaterial: m.id, mode: tab, sourceSlot: slot, rect },
          }));
          if (m.folder_id) fd.append("folderId", m.folder_id);
          await api.uploadMaterial(fd);
          ok++;
        } catch (e) {
          fail++;
          firstError ||= (e as Error).message;
        }
      }
      if (ok === 0 && firstError) throw new Error(firstError);
      onChanged();
      onToast(fail ? t("sceneSplit.doneWithFail", { ok, fail }) : t("sceneSplit.done", { ok }));
      onClose();
    } catch (e) {
      notify(t("sceneSplit.splitFailed", { msg: (e as Error).message }));
      setBusy(false);
      setProgress("");
    }
  };

  /** 模型拆分：云端 layerMaterial / 本地 comfyLayerMaterial（异步入队） */
  const runModelSplit = async () => {
    if (busy) return;
    const opt = engineOptions.find((o) => o.value === engine);
    if (!opt?.enabled) {
      notify(t("sceneSplit.engineNotConfigured"));
      return;
    }
    setBusy(true);
    try {
      if (engine === "cloud") {
        await api.layerMaterial(m.id, {
          layers, numInferenceSteps: 50, trueCfgScale: 4, seed: 0,
          autoMatting: autoMatting && !m.processed_path,
        });
      } else {
        await api.comfyLayerMaterial(m.id, {
          prompt: localPrompt.trim() || undefined, layers, size: localSize, filterSolid,
        });
      }
      onToast(t("sceneSplit.layerQueued"));
      onClose();
    } catch (e) {
      notify(t("sceneSplit.layerFailed", { msg: (e as Error).message }));
      setBusy(false);
    }
  };

  /** 先生成一张完整场景图（新素材），供随后再对它做拆分 */
  const runGenerateScene = async () => {
    if (busy || !genPrompt.trim()) return;
    setBusy(true);
    try {
      const providers = cfg?.gen.providers ?? [];
      const sel = resolveProviderSelection(providers, genProviderId, genModel, {});
      await api.generateMaterial({
        prompt: genPrompt.trim(),
        count: 1,
        autoMatting: false,
        name: `${base}_scene`,
        ...(genUseRef ? { referenceMaterialId: m.id } : {}),
        folderId: m.folder_id,
        ...sel,
        ...(genSize ? { size: genSize } : {}),
      });
      onToast(t("sceneSplit.sceneQueued"));
      onChanged();
      setGenOpen(false);
    } catch (e) {
      notify(t("sceneSplit.sceneFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const syncDisp = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    setDisp({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
  }, []);
  useEffect(() => {
    syncDisp();
    window.addEventListener("resize", syncDisp);
    return () => window.removeEventListener("resize", syncDisp);
  }, [syncDisp, imgSize, tab]);

  const scale = imgSize ? { sx: disp.w / imgSize.w, sy: disp.h / imgSize.h } : { sx: 1, sy: 1 };

  const canvasPane = (
    <section className="gs-preview-pane">
      <div
        className="graph-confirm-canvas scene-canvas"
        onPointerDown={tab === "manual" || tab === "auto" ? onCanvasPointerDown : undefined}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      >
        <img ref={imgRef} src={materialImageUrl(m.id, v, slot)} alt={m.name} draggable={false} onLoad={syncDisp} />
        {rects.map((r, i) => (
          <span
            key={i}
            className="graph-confirm-rect"
            style={{ left: r.x * scale.sx, top: r.y * scale.sy, width: r.w * scale.sx, height: r.h * scale.sy }}
            title={r.name}
          />
        ))}
        {dragRect && (
          <span
            className="graph-confirm-rect dragging"
            style={{
              left: Math.min(dragRect.x0, dragRect.x1),
              top: Math.min(dragRect.y0, dragRect.y1),
              width: Math.abs(dragRect.x1 - dragRect.x0),
              height: Math.abs(dragRect.y1 - dragRect.y0),
            }}
          />
        )}
        <span className="graph-confirm-canvas-hint">{t("sceneSplit.dragHint")}</span>
      </div>
      <div className="form-inline gs-tools">
        {tab === "auto" && (
          <>
            <label className="px-check">
              {t("sceneSplit.detectMode")}
              <select className="px-input" value={detectMode} disabled={busy} onChange={(e) => setDetectMode(e.target.value as DetectMode)}>
                <option value="components">{t("sceneSplit.modeComponents")}</option>
                <option value="uiSlice">{t("sceneSplit.modeUiSlice")}</option>
              </select>
            </label>
            <label className="px-check">
              {t("sceneSplit.minSize")}
              <input className="px-input num" type="number" min={1} max={256} value={minSize} disabled={busy}
                onChange={(e) => setMinSize(clampInt(Number(e.target.value), 1, 256))} />
            </label>
            <button type="button" className="px-btn mini accent" disabled={busy || !imgSize} onClick={() => void runDetect()}>
              <ScanSearch size={14} /> {t("sceneSplit.redetect")}
            </button>
          </>
        )}
        <button type="button" className="px-btn mini" disabled={busy} onClick={addRect}>
          <Plus size={14} /> {t("sceneSplit.addRect")}
        </button>
        {rects.length > 0 && (
          <button type="button" className="px-btn mini" disabled={busy} onClick={() => setRects([])}>
            {t("common.clear")}
          </button>
        )}
        <span className="gs-total">{t("sceneSplit.rectCount", { count: rects.length })}</span>
      </div>
      <div className="gs-options">
        <label className="px-check">
          <input type="checkbox" checked={autoTrim} disabled={busy} onChange={(e) => setAutoTrim(e.target.checked)} />
          {t("sceneSplit.autoTrim")}
        </label>
        {!m.processed_path && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}
      </div>
    </section>
  );

  const rectListPane = (
    <aside className="scene-rect-list">
      <div className="hint">{t("sceneSplit.rectListHint")}</div>
      {rects.map((r, i) => (
        <div key={i} className="graph-confirm-row scene-rect-row">
          <input className="px-input scene-rect-name" value={r.name} disabled={busy}
            onChange={(e) => renameRect(i, e.target.value)} />
          {(["x", "y", "w", "h"] as const).map((k) => (
            <label key={k}>
              {k}
              <input className="px-input num" type="number" value={r[k]} disabled={busy}
                onChange={(e) => updateRect(i, k, Number(e.target.value) || 0)} />
            </label>
          ))}
          <IconBtn className="danger" title={t("graph.delete")} disabled={busy} onClick={() => deleteRect(i)}>
            <Trash2 size={13} />
          </IconBtn>
        </div>
      ))}
    </aside>
  );

  const modelPane = (
    <section className="scene-model-pane">
      <div className="hint">{t("sceneSplit.modelHint")}</div>
      <div className="form-inline">
        <label className="px-check">
          {t("sceneSplit.engine")}
          <select className="px-input" value={engine} disabled={busy} onChange={(e) => setEngine(e.target.value as "cloud" | "local")}>
            {engineOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={!o.enabled}>
                {o.label}{o.enabled ? "" : ` · ${t("sceneSplit.notConfigured")}`}
              </option>
            ))}
          </select>
        </label>
        <label className="px-check">
          {t("sceneSplit.layers")}
          <input className="px-input num" type="number" min={1} max={4} value={layers} disabled={busy}
            onChange={(e) => setLayers(clampInt(Number(e.target.value), 1, 4))} />
        </label>
      </div>
      {engine === "local" && (
        <>
          <label className="field">
            <span>{t("sceneSplit.localPrompt")}</span>
            <textarea className="px-input" value={localPrompt} disabled={busy}
              placeholder={t("sceneSplit.localPromptPlaceholder")} onChange={(e) => setLocalPrompt(e.target.value)} />
          </label>
          <div className="form-inline">
            <label className="px-check">
              {t("sceneSplit.localSize")}
              <input className="px-input num" type="number" min={512} max={1024} step={64} value={localSize} disabled={busy}
                onChange={(e) => setLocalSize(clampInt(Number(e.target.value), 512, 1024))} />
            </label>
            <label className="px-check">
              <input type="checkbox" checked={filterSolid} disabled={busy} onChange={(e) => setFilterSolid(e.target.checked)} />
              {t("sceneSplit.filterSolid")}
            </label>
          </div>
        </>
      )}
      {engine === "cloud" && !m.processed_path && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}

      <div className="scene-gen-section">
        <button type="button" className={`px-btn mini${genOpen ? " accent" : ""}`} disabled={busy} onClick={() => setGenOpen((s) => !s)}>
          <Sparkles size={14} /> {t("sceneSplit.genSceneToggle")}
        </button>
        {genOpen && (
          <div className="scene-gen-body">
            <div className="hint">{t("sceneSplit.genSceneHint")}</div>
            <PromptEnhancer
              mediaKind="image"
              label={t("sceneSplit.genPrompt")}
              value={genPrompt}
              placeholder={t("sceneSplit.genPromptPlaceholder")}
              onChange={setGenPrompt}
            />
            <label className="px-check">
              <input type="checkbox" checked={genUseRef} disabled={busy} onChange={(e) => setGenUseRef(e.target.checked)} />
              {t("sceneSplit.genUseRef")}
            </label>
            <ProviderModelPicker providerId={genProviderId} model={genModel} onProviderChange={setGenProviderId} onModelChange={setGenModel} />
            <SizePicker providerId={genProviderId} value={genSize} onChange={setGenSize} />
            <button type="button" className="px-btn accent" disabled={busy || !genPrompt.trim()} onClick={() => void runGenerateScene()}>
              <Sparkles size={14} /> {busy ? t("common.submitting") : t("sceneSplit.genSceneSubmit")}
            </button>
          </div>
        )}
      </div>
    </section>
  );

  const tabs: Array<{ id: SceneTab; label: string; icon: React.ReactNode }> = [
    { id: "auto", label: t("sceneSplit.tabAuto"), icon: <Scan size={14} /> },
    { id: "manual", label: t("sceneSplit.tabManual"), icon: <MousePointerSquareDashed size={14} /> },
    { id: "model", label: t("sceneSplit.tabModel"), icon: <Layers3 size={14} /> },
  ];

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="modal pixel-panel gs-modal scene-split-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gs-header">
          <div>
            <h2><Scan size={18} /> {t("sceneSplit.title")}</h2>
            <p>{t("sceneSplit.subtitle")}</p>
          </div>
          <IconBtn onClick={onClose} title={t("common.close")}><X size={16} /></IconBtn>
        </header>

        <div className="generation-line-tabs" role="tablist" aria-label={t("sceneSplit.title")}>
          {tabs.map((tb) => (
            <button key={tb.id} type="button" role="tab" aria-selected={tab === tb.id}
              className={tab === tb.id ? "active" : ""} disabled={busy} onClick={() => setTab(tb.id)}>
              {tb.icon} {tb.label}
            </button>
          ))}
        </div>

        <div className="gs-layout scene-layout">
          {tab === "model" ? modelPane : <>{canvasPane}{rectListPane}</>}
        </div>

        <footer className="modal-actions gs-footer">
          <button type="button" className="px-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          {tab === "model" ? (
            <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent"
              disabled={busy || !engineOptions.find((o) => o.value === engine)?.enabled} onClick={() => void runModelSplit()}>
              <Layers3 size={14} /> {busy ? t("common.submitting") : t("sceneSplit.runModelSplit")}
            </motion.button>
          ) : (
            <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent"
              disabled={busy || rects.length === 0} onClick={() => void applySplit()}>
              <Wand2 size={14} /> {busy ? (progress || t("sceneSplit.splitting")) : t("sceneSplit.splitInto", { count: rects.length })}
            </motion.button>
          )}
        </footer>
      </motion.div>
    </motion.div>
  );
}

