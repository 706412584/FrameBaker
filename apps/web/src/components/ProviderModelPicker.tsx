import type { GenProviderInfo } from "@framebaker/shared";
import { isLikelyImageOnlyModel, pickPreferredVideoModel } from "@framebaker/shared";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import PxSelect from "./PxSelect";

interface Props {
  providerId: string;
  model: string;
  onProviderChange: (id: string) => void;
  onModelChange: (m: string) => void;
  /** 视频模式：只列出支持视频生成的 provider（CLI / 百炼 / MiniMax） */
  videoOnly?: boolean;
  /** 视频模式且有引用图时，优先选 i2v（如 happyhorse-1.1-i2v） */
  preferI2v?: boolean;
}

/** 提交生成时解析 providerId/model：缺省取第一个已配置 provider；api 系模型缺省取列表第一项（视频模式避开图模） */
export function resolveProviderSelection(
  providers: GenProviderInfo[],
  providerId: string,
  model: string,
  opts?: { videoOnly?: boolean; preferI2v?: boolean }
): { providerId?: string; model?: string } {
  const p = providers.find((x) => x.id === providerId) ?? providers.find((x) => x.configured) ?? providers[0];
  if (!p) return {};
  let m = model.trim();
  if (!m && p.type !== "cli") {
    m = opts?.videoOnly ? pickPreferredVideoModel(p.models, { preferI2v: opts.preferI2v }) : (p.models[0] ?? "");
  } else if (m && opts?.videoOnly && isLikelyImageOnlyModel(m) && p.models.length > 0) {
    m = pickPreferredVideoModel(p.models, { preferI2v: opts.preferI2v });
  }
  return { providerId: p.id, model: m || undefined };
}

const TYPE_LABEL: Record<GenProviderInfo["type"], string> = {
  cli: "CLI",
  api: "API",
  dashscope: "msg.bailian",
  gemini: "banana",
  minimax: "MiniMax",
};

/** 生成弹窗共用：provider 选择（设置页可配多个，CLI/API 共存）+ 生成时单独选模型 */
export default function ProviderModelPicker({
  providerId,
  model,
  onProviderChange,
  onModelChange,
  videoOnly,
  preferI2v,
}: Props) {
  const t = useT();
  const cfg = useServerConfig();
  const providers = (cfg?.gen.providers ?? []).filter((p) => (videoOnly ? p.video : true));

  if (cfg && providers.length === 0) {
    return videoOnly ? (
      <div className="hint warn">{t("msg.no_video_gen_provider_cli_bailian_minimax_add_in_setting")}</div>
    ) : (
      <div className="hint warn">{t("msg.no_gen_provider_add_cli_api_providers_in_settings")}</div>
    );
  }
  const provider =
    providers.find((p) => p.id === providerId) ?? providers.find((p) => p.configured) ?? providers[0];
  if (!provider) return null;
  const defaultModel =
    provider.type !== "cli"
      ? videoOnly
        ? pickPreferredVideoModel(provider.models, { preferI2v })
        : provider.models[0] || ""
      : "";
  // 视频模式若当前仍停在图模，自动改用列表里的视频模型
  const effectiveModel =
    provider.type !== "cli"
      ? model && !(videoOnly && isLikelyImageOnlyModel(model))
        ? model
        : defaultModel
      : model;

  return (
    <div className="form-row">
      <label>{t("msg.gen_provider_model_manage_in_settings")}</label>
      <div className="form-inline">
        <PxSelect
          value={provider.id}
          options={providers.map((p) => ({
            value: p.id,
            label: `${p.name}（${t(TYPE_LABEL[p.type])}${p.configured ? "" : t("msg.incomplete")}）`,
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
              placeholder={t("msg.model_name_required")}
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
            />
          )
        ) : (
          <input
            className="px-input"
            placeholder={t("msg.model_via_model_arg_name_optional")}
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
