import { useState } from "react";
import { Wand2, X } from "lucide-react";
import { api } from "../api";
import { useServerConfig } from "../config";
import { notify } from "../notice";
import IconBtn from "./IconBtn";

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
}

/**
 * 提示词输入行 + 「优化提示词」：调用设置页配置的加强模型，
 * 原/优化后提示词并排展示，由用户点按钮决定用哪版（原文永不覆盖）
 */
export default function PromptEnhancer({ label, placeholder, value, onChange }: Props) {
  const cfg = useServerConfig();
  const enhancers = cfg?.promptEnhancers ?? [];
  const [enhancerId, setEnhancerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnhanceResult | null>(null);

  const run = async () => {
    if (!value.trim() || busy) return;
    if (enhancers.length === 0) {
      notify("未配置提示词加强模型：请到「设置」页添加");
      return;
    }
    setBusy(true);
    try {
      const r = await api.enhancePrompt(enhancerId || undefined, value.trim());
      // original 快照保留发起时的原文，之后用户怎么改输入框都不影响对比
      setResult({ original: value.trim(), enhanced: r.enhanced, enhancerName: r.enhancerName });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-row">
      <label>{label}</label>
      <div className="form-inline">
        <input
          className="px-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {enhancers.length > 1 && (
          <select className="px-input enhance-model" value={enhancerId} onChange={(e) => setEnhancerId(e.target.value)}>
            {enhancers.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="px-btn mini enhance-btn"
          disabled={busy || !value.trim()}
          title={enhancers.length ? `用「${enhancers.find((e) => e.id === (enhancerId || enhancers[0]?.id))?.name}」优化` : "先到「设置」页添加提示词加强模型"}
          onClick={run}
        >
          <Wand2 size={12} /> {busy ? "优化中…" : "优化提示词"}
        </button>
      </div>

      {result && (
        <div className="enhance-panel">
          <div className="enhance-head">
            <span>由「{result.enhancerName}」优化，选用哪一版？（原文不会被覆盖）</span>
            <IconBtn title="关闭对比" onClick={() => setResult(null)}>
              <X size={14} />
            </IconBtn>
          </div>
          <div className="enhance-grid">
            <div className="enhance-block">
              <div className="enhance-tag">原提示词</div>
              <div className="enhance-text">{result.original}</div>
              <button
                type="button"
                className={`px-btn mini ${value === result.original ? "accent" : ""}`}
                onClick={() => onChange(result.original)}
              >
                {value === result.original ? "当前使用中" : "用原提示词"}
              </button>
            </div>
            <div className="enhance-block">
              <div className="enhance-tag new">优化后</div>
              <div className="enhance-text">{result.enhanced}</div>
              <button
                type="button"
                className={`px-btn mini ${value === result.enhanced ? "accent" : ""}`}
                onClick={() => onChange(result.enhanced)}
              >
                {value === result.enhanced ? "当前使用中" : "用优化后的"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
