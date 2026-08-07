import { GEN_SIZE_PRESETS, GEN_VIDEO_SIZE_PRESETS, parseSizePreview } from "@framebaker/shared";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import PxSelect from "./PxSelect";

interface Props {
  providerId: string;
  value: string;
  onChange: (v: string) => void;
  /** 视频生成用视频档位预设；默认图片档位 */
  forVideo?: boolean;
}

const PREVIEW_BOX = 120;

/**
 * 生成弹窗共用：尺寸/比例选择 + 比例预览框。
 * 空值 = 用 provider 在设置页配的 apiSize；CLI 无尺寸概念，不渲染。
 */
export default function SizePicker({ providerId, value, onChange, forVideo }: Props) {
  const t = useT();
  const cfg = useServerConfig();
  const providers = cfg?.gen.providers ?? [];
  const provider = providers.find((p) => p.id === providerId) ?? providers.find((p) => p.configured) ?? providers[0];
  if (!provider || provider.type === "cli") return null;

  const presets = forVideo ? GEN_VIDEO_SIZE_PRESETS[provider.type] : GEN_SIZE_PRESETS[provider.type];
  const options = presets.map((o) => ({ ...o, label: t(o.label) }));
  const current = options.some((o) => o.value === value) ? value : "";
  const effective = current || (forVideo ? provider.videoSize : provider.imageSize) || (forVideo ? "16:9" : "1:1");
  const preview = parseSizePreview(effective);
  const scale = Math.min(PREVIEW_BOX / preview.w, PREVIEW_BOX / preview.h, 1);
  const pw = Math.max(8, Math.round(preview.w * scale));
  const ph = Math.max(8, Math.round(preview.h * scale));

  return (
    <div className="form-row size-picker">
      <label>{forVideo ? t("size.videoLabel") : t("msg.size_blank_provider_size_from_settings")}</label>
      <div className="size-picker-row">
        <PxSelect value={current} options={options} onChange={onChange} />
        <div className="size-preview" title={preview.label}>
          <div className="size-preview-frame" style={{ width: pw, height: ph }} />
          <span className="size-preview-label">
            {current ? preview.label : t("size.previewDefault", { label: preview.label })}
          </span>
        </div>
      </div>
    </div>
  );
}
