import type { MattingEngine } from "@framebaker/shared";
import { useServerConfig } from "../config";
import { useT, t } from "../i18n";

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
}

function engineText(engine: MattingEngine, model: string): string {
  switch (engine) {
    case "custom-cli":
      return t("引擎: 自定义 CLI");
    case "rembg-bundled":
      return t("引擎: rembg/{model}", { model });
    case "rembg-path":
      return t("引擎: rembg/{model}（PATH）", { model });
    default:
      return "";
  }
}

/** 「抠图去背」显眼开关行 + 引擎状态指示（绿点可用 / 红点缺失） */
export default function MattingOption({ checked, onChange }: Props) {
  useT(); // 订阅语言切换，engineText 用模块级 t 读实时语言
  const cfg = useServerConfig();
  const engine = cfg?.matting.engine;
  const available = engine != null && engine !== "none";

  return (
    <div className="matting-option">
      <label className="px-check matting-check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="matting-label">{t("抠图去背（透明背景）")}</span>
      </label>
      <span className={`engine-status ${available ? "ok" : "bad"}`}>
        <span className="dot" />
        {engine == null ? t("引擎检测中…") : available ? engineText(engine, cfg!.matting.model) : t("未安装抠图引擎，将仅复制原图")}
      </span>
    </div>
  );
}
