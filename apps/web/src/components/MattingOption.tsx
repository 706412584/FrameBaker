import type { MattingEngine } from "@framebaker/shared";
import { useServerConfig } from "../config";

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
}

function engineText(engine: MattingEngine, model: string): string {
  switch (engine) {
    case "custom-cli":
      return "引擎: 自定义 CLI";
    case "rembg-bundled":
      return `引擎: rembg/${model}`;
    case "rembg-path":
      return `引擎: rembg/${model}（PATH）`;
    default:
      return "";
  }
}

/** 「抠图去背」显眼开关行 + 引擎状态指示（绿点可用 / 红点缺失） */
export default function MattingOption({ checked, onChange }: Props) {
  const cfg = useServerConfig();
  const engine = cfg?.matting.engine;
  const available = engine != null && engine !== "none";

  return (
    <div className="matting-option">
      <label className="px-check matting-check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="matting-label">抠图去背（透明背景）</span>
      </label>
      <span className={`engine-status ${available ? "ok" : "bad"}`}>
        <span className="dot" />
        {engine == null ? "引擎检测中…" : available ? engineText(engine, cfg!.matting.model) : "未安装抠图引擎，将仅复制原图"}
      </span>
    </div>
  );
}
