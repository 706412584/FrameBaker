import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { BrainCircuit, Settings2, Wand2, X } from "lucide-react";
import { REMBG_MODELS } from "@framebaker/shared";
import { api, type Material } from "../api";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { notify } from "../notice";

interface Props {
  material: Material;
  onClose: () => void;
  onToast: (msg: string) => void;
}

/**
 * sprite 管线模式（多选组合，与图工作流 matte.pipeline 节点开关同一语义）。
 * 固定执行序：chroma → spriteflow → birefnet → corridorkey → luma → additive（matte_cli 固定序）。
 */
const SPRITE_MODES = ["chroma", "spriteflow", "birefnet", "corridorkey", "luma", "additive"] as const;
type SpriteMode = (typeof SPRITE_MODES)[number];

const MODE_LABEL_KEY: Record<SpriteMode, string> = {
  chroma: "matting.mode.chroma",
  spriteflow: "matting.mode.spriteflow",
  birefnet: "matting.mode.birefnet",
  corridorkey: "matting.mode.corridorkey",
  luma: "matting.mode.luma",
  additive: "matting.mode.additive",
};

/** 各模式可调参数（key=后端 camelCase → --kebab-case CLI） */
interface ParamField {
  key: string;
  labelKey: string;
  type: "number" | "boolean" | "select";
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; labelKey: string }>;
}

const PARAM_FIELDS: Record<SpriteMode, ParamField[]> = {
  chroma: [
    { key: "threshold", labelKey: "matting.param.threshold", type: "number", min: 1, max: 200 },
    { key: "softness", labelKey: "matting.param.softness", type: "number", min: 0, max: 128 },
    { key: "despillStrength", labelKey: "matting.param.despill", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "keyMode", labelKey: "matting.param.keyMode", type: "select", options: [{ value: "auto", labelKey: "matting.param.keyAuto" }, { value: "manual", labelKey: "matting.param.keyManual" }] },
    { key: "manualKeyHex", labelKey: "matting.param.keyHex", type: "select", options: [
      { value: "#00FF00", labelKey: "matting.param.keyGreen" },
      { value: "#0000FF", labelKey: "matting.param.keyBlue" },
      { value: "#FF00FF", labelKey: "matting.param.keyMagenta" },
    ] },
  ],
  spriteflow: [
    { key: "sfTolerance", labelKey: "matting.param.sfTolerance", type: "number", min: 1, max: 200 },
    { key: "sfBlendZoneRatio", labelKey: "matting.param.sfBlend", type: "number", min: 0.05, max: 0.95, step: 0.05 },
    { key: "sfSpillRemoval", labelKey: "matting.param.sfSpill", type: "boolean" },
    { key: "sfSpillStrength", labelKey: "matting.param.sfSpillStrength", type: "number", min: 0, max: 1, step: 0.05 },
  ],
  birefnet: [
    { key: "aiResolution", labelKey: "matting.param.aiResolution", type: "number", min: 256, max: 2048, step: 128 },
  ],
  corridorkey: [
    { key: "corridorkeyScreen", labelKey: "matting.param.ckScreen", type: "select", options: [
      { value: "auto", labelKey: "matting.param.keyAuto" },
      { value: "green", labelKey: "matting.param.keyGreen" },
      { value: "blue", labelKey: "matting.param.keyBlue" },
    ] },
  ],
  luma: [
    { key: "lumaBlack", labelKey: "matting.param.lumaBlack", type: "number", min: 0, max: 128 },
    { key: "lumaWhite", labelKey: "matting.param.lumaWhite", type: "number", min: 128, max: 255 },
    { key: "lumaStrength", labelKey: "matting.param.lumaStrength", type: "number", min: 0, max: 2, step: 0.1 },
  ],
  additive: [],
};

/** 各模式默认参数（对齐 matte_cli.py；容差/sfTolerance 按用户实测改保守值 20/25） */
const DEFAULT_PARAMS: Record<SpriteMode, Record<string, number | string | boolean>> = {
  chroma: { threshold: 20, softness: 32, despillStrength: 0.85, keyMode: "auto", manualKeyHex: "#00FF00" },
  spriteflow: { sfTolerance: 25, sfBlendZoneRatio: 0.6, sfSpillRemoval: true, sfSpillStrength: 0.45 },
  birefnet: { aiResolution: 1024 },
  corridorkey: { corridorkeyScreen: "auto" },
  luma: { lumaBlack: 8, lumaWhite: 235, lumaStrength: 1 },
  additive: {},
};

type ParamValue = number | string | boolean;

/** 参数编辑面板（只渲染所选模式的参数） */
function ModeParams({ mode, values, onChange }: { mode: SpriteMode; values: Record<string, ParamValue>; onChange: (key: string, v: ParamValue) => void }) {
  const t = useT();
  const fields = PARAM_FIELDS[mode];
  if (fields.length === 0) return null;
  return (
    <div className="matting-param-panel">
      {fields.map((f) => (
        <label key={f.key} className="matting-param-field">
          <span>{t(f.labelKey)}</span>
          {f.type === "boolean" ? (
            <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => onChange(f.key, e.target.checked)} />
          ) : f.type === "select" ? (
            <select className="px-input" value={String(values[f.key] ?? "")} onChange={(e) => onChange(f.key, e.target.value)}>
              {(f.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
              ))}
            </select>
          ) : (
            <input
              className="px-input num"
              type="number"
              min={f.min}
              max={f.max}
              step={f.step ?? 1}
              value={Number(values[f.key] ?? 0)}
              onChange={(e) => onChange(f.key, Number(e.target.value))}
            />
          )}
        </label>
      ))}
    </div>
  );
}

/**
 * 抠图模式选择弹窗：
 * - rembg 系模型（默认引擎）：单选即抠
 * - sprite 管线：多选组合（chips，与图工作流 matte.pipeline 节点开关同一语义）+ 可展开参数面板 + 统一「开始抠图」
 *   默认勾选 chroma（保守容差 20）；组合按 matte_cli 固定序执行、alpha 并集。
 */
export default function MattingModeModal({ material: m, onClose, onToast }: Props) {
  const t = useT();
  const cfg = useServerConfig();
  useModalEscClose(onClose);
  const [busy, setBusy] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [selected, setSelected] = useState<Set<SpriteMode>>(new Set(["chroma"]));
  const [params, setParams] = useState<Record<string, ParamValue>>(() => {
    const all: Record<string, ParamValue> = {};
    for (const group of Object.values(DEFAULT_PARAMS)) Object.assign(all, group);
    return all;
  });
  const spriteReady = cfg?.spriteMatting.configured ?? false;

  const pipeline = useMemo(() => SPRITE_MODES.filter((mode) => selected.has(mode)).join(","), [selected]);
  const toggle = (mode: SpriteMode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) next.delete(mode);
      else next.add(mode);
      return next;
    });
  };

  const runRembg = async (model?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.matteMaterial(m.id, undefined, model);
      onToast(t("msg.matting_job_queued"));
      onClose();
    } catch (e) {
      notify(t("msg.matting_failed_msg", { msg: (e as Error).message }));
      setBusy(false);
    }
  };

  const runPipeline = async () => {
    if (busy || !pipeline) return;
    setBusy(true);
    try {
      // 携带所选模式各自的参数（camelCase → 后端白名单 → --kebab-case）
      const carry: Record<string, ParamValue> = {};
      for (const mode of selected) {
        for (const f of PARAM_FIELDS[mode]) carry[f.key] = params[f.key]!;
        Object.assign(carry, DEFAULT_PARAMS[mode]);
      }
      await api.matteMaterial(m.id, pipeline, undefined, carry);
      onToast(t("msg.matting_job_queued"));
      onClose();
    } catch (e) {
      notify(t("msg.matting_failed_msg", { msg: (e as Error).message }));
      setBusy(false);
    }
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="modal pixel-panel matting-mode-modal" initial={{ scale: 0.94 }} animate={{ scale: 1 }} onClick={(e) => e.stopPropagation()}>
        <div className="form-inline">
          <h2 style={{ flex: 1 }}><Wand2 size={16} /> {t("matting.mode.title")}</h2>
          <button type="button" className="px-btn mini" onClick={onClose}><X size={14} /></button>
        </div>
        <p className="hint">{t("matting.mode.hint")}</p>

        {/* 默认引擎：rembg 系（点击即以该模型抠图） */}
        <div className="matting-mode-group">
          <strong>{t("matting.mode.defaultEngine")}</strong>
          <div className="matting-mode-grid">
            {REMBG_MODELS.map((model) => (
              <button key={model} type="button" className="px-btn mini" disabled={busy} onClick={() => void runRembg(model)}>
                {model}
              </button>
            ))}
          </div>
          <span className="hint">{t("matting.mode.defaultDesc")}</span>
        </div>

        {/* sprite 管线：多选组合（与图工作流 matte.pipeline 同一执行链） */}
        <div className="matting-mode-group">
          <div className="matting-mode-group-head">
            <strong><BrainCircuit size={13} /> {t("matting.mode.spriteEngine")}
              {!spriteReady && <span className="hint"> · {t("matting.mode.spriteNotConfigured")}</span>}
            </strong>
            <button type="button" className={`px-btn mini${showParams ? " accent" : ""}`} onClick={() => setShowParams((s) => !s)}>
              <Settings2 size={12} /> {t("matting.param.toggle")}
            </button>
          </div>
          <div className="matting-mode-grid">
            {SPRITE_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`px-btn mini${selected.has(mode) ? " accent" : ""}`}
                disabled={!spriteReady}
                title={t("matting.mode." + mode + "Desc")}
                onClick={() => toggle(mode)}
              >
                {selected.has(mode) ? "✓ " : ""}{t(MODE_LABEL_KEY[mode])}
              </button>
            ))}
          </div>
          {/* 选中模式的参数面板（每模式一组） */}
          {showParams && pipeline && (
            <div className="matting-param-tabs">
              {SPRITE_MODES.filter((mode) => selected.has(mode)).map((mode) => (
                <div key={mode} className="matting-param-tab">
                  <strong className="matting-param-tab-title">{t(MODE_LABEL_KEY[mode])}</strong>
                  <ModeParams mode={mode} values={params} onChange={(k, v) => setParams((prev) => ({ ...prev, [k]: v }))} />
                </div>
              ))}
            </div>
          )}
          <span className="hint">{t("matting.mode.spriteDesc")}</span>
          <div className="form-inline">
            <button type="button" className="px-btn accent" disabled={busy || !spriteReady || !pipeline} onClick={() => void runPipeline()}>
              <Wand2 size={13} /> {busy ? t("common.submitting") : t("matting.mode.runPipeline", { pipeline })}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
