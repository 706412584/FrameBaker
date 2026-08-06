import { useState } from "react";
import { Wand2, X } from "lucide-react";
import { ENHANCE_STYLES } from "@framebaker/shared";
import { api } from "../api";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import PxSelect from "./PxSelect";

interface Props {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
}

interface EnhanceResult {
  original: string;
  enhanced: string;
  enhancerName: string;
  styleLabel: string;
}

/**
 * 提示词输入行 + 「优化提示词」：调用设置页配置的加强模型，
 * 原/优化后提示词并排展示，由用户点按钮决定用哪版（原文永不覆盖）
 */
export default function PromptEnhancer({ label, placeholder, value, onChange }: Props) {
  const t = useT();
  const cfg = useServerConfig();
  const enhancers = cfg?.promptEnhancers ?? [];
  const [enhancerId, setEnhancerId] = useState("");
  const [style, setStyle] = useState<string>(ENHANCE_STYLES[0].id);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnhanceResult | null>(null);

  const run = async () => {
    if (!value.trim() || busy) return;
    if (enhancers.length === 0) {
      notify(t("未配置提示词加强模型：请到「设置」页添加"));
      return;
    }
    setBusy(true);
    try {
      const r = await api.enhancePrompt(enhancerId || undefined, value.trim(), style);
      // original 快照保留发起时的原文，之后用户怎么改输入框都不影响对比
      setResult({
        original: value.trim(),
        enhanced: r.enhanced,
        enhancerName: r.enhancerName,
        styleLabel: ENHANCE_STYLES.find((s) => s.id === style)?.label ?? style,
      });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-row">
      <label>{label}</label>
      <textarea
        className="px-input px-textarea enhance-prompt"
        rows={3}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="form-inline enhance-bar">
        <PxSelect
          className="enhance-style"
          value={style}
          options={ENHANCE_STYLES.map((s) => ({ value: s.id, label: t(s.label) }))}
          onChange={setStyle}
        />
        {enhancers.length > 1 && (
          <PxSelect
            className="enhance-model"
            value={enhancerId || enhancers[0]?.id || ""}
            options={enhancers.map((e) => ({ value: e.id, label: e.name }))}
            onChange={setEnhancerId}
          />
        )}
        <button
          type="button"
          className="px-btn mini enhance-btn"
          disabled={busy || !value.trim()}
          title={enhancers.length ? t("用「{name}」优化", { name: enhancers.find((e) => e.id === (enhancerId || enhancers[0]?.id))?.name ?? "" }) : t("先到「设置」页添加提示词加强模型")}
          onClick={run}
        >
          <Wand2 size={12} /> {busy ? t("优化中…") : t("优化提示词")}
        </button>
      </div>

      {result && (
        <div className="enhance-panel">
          <div className="enhance-head">
            <span>{t("由「{enhancer}」按「{style}」优化，选用哪一版？（原文不会被覆盖）", { enhancer: result.enhancerName, style: t(result.styleLabel) })}</span>
            <IconBtn title={t("关闭对比")} onClick={() => setResult(null)}>
              <X size={14} />
            </IconBtn>
          </div>
          <div className="enhance-grid">
            <div className="enhance-block">
              <div className="enhance-tag">{t("原提示词")}</div>
              <div className="enhance-text">{result.original}</div>
              <button
                type="button"
                className={`px-btn mini ${value === result.original ? "accent" : ""}`}
                onClick={() => onChange(result.original)}
              >
                {value === result.original ? t("当前使用中") : t("用原提示词")}
              </button>
            </div>
            <div className="enhance-block">
              <div className="enhance-tag new">{t("优化后")}</div>
              <div className="enhance-text">{result.enhanced}</div>
              <button
                type="button"
                className={`px-btn mini ${value === result.enhanced ? "accent" : ""}`}
                onClick={() => onChange(result.enhanced)}
              >
                {value === result.enhanced ? t("当前使用中") : t("用优化后的")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
