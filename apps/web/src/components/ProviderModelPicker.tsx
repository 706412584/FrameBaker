import type { GenProviderInfo } from "@framebaker/shared";
import { useServerConfig } from "../config";

interface Props {
  providerId: string;
  model: string;
  onProviderChange: (id: string) => void;
  onModelChange: (m: string) => void;
}

/** 提交生成时解析 providerId/model：缺省取第一个已配置 provider；api 模型缺省取列表第一项 */
export function resolveProviderSelection(
  providers: GenProviderInfo[],
  providerId: string,
  model: string
): { providerId?: string; model?: string } {
  const p = providers.find((x) => x.id === providerId) ?? providers.find((x) => x.configured) ?? providers[0];
  if (!p) return {};
  const m = model.trim() || (p.type === "api" ? (p.models[0] ?? "") : "");
  return { providerId: p.id, model: m || undefined };
}

/** 生成弹窗共用：provider 选择（设置页可配多个，CLI/API 共存）+ 生成时单独选模型 */
export default function ProviderModelPicker({ providerId, model, onProviderChange, onModelChange }: Props) {
  const cfg = useServerConfig();
  const providers = cfg?.gen.providers ?? [];

  if (cfg && providers.length === 0) {
    return <div className="hint warn">未配置生成方式：请到「设置」页添加生成 provider（CLI / API 可配多个共存）</div>;
  }
  const provider =
    providers.find((p) => p.id === providerId) ?? providers.find((p) => p.configured) ?? providers[0];
  if (!provider) return null;
  const effectiveModel = provider.type === "api" ? model || provider.models[0] || "" : model;

  return (
    <div className="form-row">
      <label>生成 Provider / 模型（在「设置」页管理）</label>
      <div className="form-inline">
        <select
          className="px-input"
          value={provider.id}
          onChange={(e) => {
            onProviderChange(e.target.value);
            onModelChange("");
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.configured}>
              {p.name}（{p.type === "cli" ? "CLI" : "API"}
              {p.configured ? "" : "·未配齐"}）
            </option>
          ))}
        </select>
        {provider.type === "api" ? (
          provider.models.length > 0 ? (
            <select className="px-input" value={effectiveModel} onChange={(e) => onModelChange(e.target.value)}>
              {provider.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
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
            placeholder="模型（填 {model} 占位符值，可空）"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
