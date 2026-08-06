import type { GenProviderInfo } from "@framebaker/shared";
import { useServerConfig } from "../config";
import PxSelect from "./PxSelect";

interface Props {
  providerId: string;
  model: string;
  onProviderChange: (id: string) => void;
  onModelChange: (m: string) => void;
  /** 视频模式：只列出支持视频生成的 provider（CLI / 百炼 / MiniMax） */
  videoOnly?: boolean;
}

/** 提交生成时解析 providerId/model：缺省取第一个已配置 provider；api 系模型缺省取列表第一项 */
export function resolveProviderSelection(
  providers: GenProviderInfo[],
  providerId: string,
  model: string
): { providerId?: string; model?: string } {
  const p = providers.find((x) => x.id === providerId) ?? providers.find((x) => x.configured) ?? providers[0];
  if (!p) return {};
  const m = model.trim() || (p.type !== "cli" ? (p.models[0] ?? "") : "");
  return { providerId: p.id, model: m || undefined };
}

const TYPE_LABEL: Record<GenProviderInfo["type"], string> = {
  cli: "CLI",
  api: "API",
  dashscope: "百炼",
  gemini: "banana",
  minimax: "MiniMax",
};

/** 生成弹窗共用：provider 选择（设置页可配多个，CLI/API 共存）+ 生成时单独选模型 */
export default function ProviderModelPicker({ providerId, model, onProviderChange, onModelChange, videoOnly }: Props) {
  const cfg = useServerConfig();
  const providers = (cfg?.gen.providers ?? []).filter((p) => (videoOnly ? p.video : true));

  if (cfg && providers.length === 0) {
    return videoOnly ? (
      <div className="hint warn">无可用的视频生成 provider（支持：CLI / 百炼 / MiniMax），请到「设置」页添加</div>
    ) : (
      <div className="hint warn">未配置生成方式：请到「设置」页添加生成 provider（CLI / API 可配多个共存）</div>
    );
  }
  const provider =
    providers.find((p) => p.id === providerId) ?? providers.find((p) => p.configured) ?? providers[0];
  if (!provider) return null;
  const effectiveModel = provider.type !== "cli" ? model || provider.models[0] || "" : model;

  return (
    <div className="form-row">
      <label>生成 Provider / 模型（在「设置」页管理）</label>
      <div className="form-inline">
        <PxSelect
          value={provider.id}
          options={providers.map((p) => ({
            value: p.id,
            label: `${p.name}（${TYPE_LABEL[p.type]}${p.configured ? "" : "·未配齐"}）`,
            disabled: !p.configured,
          }))}
          onChange={(id) => {
            onProviderChange(id);
            onModelChange("");
          }}
        />
        {provider.type !== "cli" ? (
          provider.models.length > 0 ? (
            <PxSelect value={effectiveModel} options={provider.models.map((m) => ({ value: m, label: m }))} onChange={onModelChange} />
          ) : (
            <input
              className="px-input"
              placeholder="模型名（必填）"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
            />
          )
        ) : (
          <input
            className="px-input"
            placeholder="模型（按「模型参数名」下发，可空）"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
