import { GEN_SIZE_PRESETS } from "@framebaker/shared";
import { useServerConfig } from "../config";
import PxSelect from "./PxSelect";

interface Props {
  providerId: string;
  value: string;
  onChange: (v: string) => void;
}

/**
 * 生成弹窗共用：尺寸选择。预设档位按 provider 类型区分（各家尺寸格式不同）；
 * 空值 = 用 provider 在设置页配的 apiSize；CLI 无尺寸概念，不渲染
 */
export default function SizePicker({ providerId, value, onChange }: Props) {
  const cfg = useServerConfig();
  const providers = cfg?.gen.providers ?? [];
  const provider = providers.find((p) => p.id === providerId) ?? providers.find((p) => p.configured) ?? providers[0];
  if (!provider || provider.type === "cli") return null;
  const options = GEN_SIZE_PRESETS[provider.type];
  // 切换 provider 类型后旧值可能不在新档位里，按空（默认）处理
  const current = options.some((o) => o.value === value) ? value : "";

  return (
    <div className="form-row">
      <label>尺寸（留默认 = 用 provider 在「设置」页配的尺寸）</label>
      <PxSelect value={current} options={options} onChange={onChange} />
    </div>
  );
}
