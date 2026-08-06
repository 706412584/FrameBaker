import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { PlugZap, Plus, RefreshCw, Save, Settings2, Sparkles, Stethoscope, Trash2, Wand2 } from "lucide-react";
import type {
  DoctorResponse,
  GenProvider,
  GenProviderType,
  MattingSettings,
  PromptEnhancer,
  ProviderTestResponse,
} from "@framebaker/shared";
import { REMBG_MODELS } from "@framebaker/shared";
import { api } from "../api";
import { refreshServerConfig, useServerConfig } from "../config";
import { askConfirm, notify } from "../notice";
import { t, useT } from "../i18n";
import PxSuggest from "./PxSuggest";

/** 编辑草稿：apiModels 用逗号分隔文本编辑，保存时才拆成数组；CLI 为结构化字段（免模板） */
interface ProviderDraft {
  id: string;
  name: string;
  type: GenProviderType;
  cliBin: string;
  cliPromptArg: string;
  cliOutputArg: string;
  cliModelArg: string;
  cliReferenceArg: string;
  cliExtraArgs: string;
  apiBaseUrl: string;
  apiKey: string;
  modelsText: string;
  apiSize: string;
}

/** 加强模型草稿（同 GenProvider 的 api 系字段，但只走 chat/completions） */
interface EnhancerDraft {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
}

const MAT_DEFAULT: MattingSettings = { cliBin: "", cliInputArg: "", cliOutputArg: "", cliModelArg: "", model: "" };

const CLI_EMPTY = {
  cliBin: "",
  cliPromptArg: "",
  cliOutputArg: "",
  cliModelArg: "",
  cliReferenceArg: "",
  cliExtraArgs: "",
};

function toDraft(p: GenProvider): ProviderDraft {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    cliBin: p.cliBin,
    cliPromptArg: p.cliPromptArg,
    cliOutputArg: p.cliOutputArg,
    cliModelArg: p.cliModelArg,
    cliReferenceArg: p.cliReferenceArg,
    cliExtraArgs: p.cliExtraArgs,
    apiBaseUrl: p.apiBaseUrl,
    apiKey: p.apiKey,
    modelsText: p.apiModels.join(", "),
    apiSize: p.apiSize,
  };
}

function fromDraft(d: ProviderDraft): GenProvider {
  return {
    id: d.id,
    name: d.name.trim() || d.id,
    type: d.type,
    cliBin: d.cliBin,
    cliPromptArg: d.cliPromptArg,
    cliOutputArg: d.cliOutputArg,
    cliModelArg: d.cliModelArg,
    cliReferenceArg: d.cliReferenceArg,
    cliExtraArgs: d.cliExtraArgs,
    apiBaseUrl: d.apiBaseUrl,
    apiKey: d.apiKey,
    apiModels: d.modelsText
      .split(/[,，\n]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    apiSize: d.apiSize,
  };
}

/** 常用厂商预设：一键带出类型 / Base URL / 模型 / 尺寸格式，只需填 key 改名 */
const PRESETS: Array<{ label: string; draft: Omit<ProviderDraft, "id"> }> = [
  {
    label: "OpenAI",
    draft: {
      ...CLI_EMPTY,
      name: "OpenAI",
      type: "api",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "",
      modelsText: "gpt-image-1",
      apiSize: "1024x1024",
    },
  },
  {
    label: "百炼",
    draft: {
      ...CLI_EMPTY,
      name: "百炼（qwen-image）",
      type: "dashscope",
      apiBaseUrl: "https://dashscope.aliyuncs.com",
      apiKey: "",
      modelsText: "qwen-image-2.0-pro, qwen-image-edit-max",
      apiSize: "2048*2048",
    },
  },
  {
    label: "banana",
    draft: {
      ...CLI_EMPTY,
      name: "banana（Gemini）",
      type: "gemini",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "",
      modelsText: "gemini-2.5-flash-image, gemini-3-pro-image-preview",
      apiSize: "1:1",
    },
  },
  {
    label: "MiniMax",
    draft: {
      ...CLI_EMPTY,
      name: "MiniMax",
      type: "minimax",
      apiBaseUrl: "https://api.minimaxi.com",
      apiKey: "",
      modelsText: "image-01",
      apiSize: "1:1",
    },
  },
  {
    label: "火山方舟（豆包）",
    draft: {
      ...CLI_EMPTY,
      name: "火山方舟（豆包 Seedream）",
      type: "api",
      apiBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "",
      modelsText: "doubao-seedream-4-0-250828",
      apiSize: "",
    },
  },
  {
    label: "自定义 CLI",
    draft: {
      ...CLI_EMPTY,
      name: "未命名 CLI",
      type: "cli",
      apiBaseUrl: "",
      apiKey: "",
      modelsText: "",
      apiSize: "",
    },
  },
  {
    label: "自定义 API",
    draft: {
      ...CLI_EMPTY,
      name: "未命名 API",
      type: "api",
      apiBaseUrl: "",
      apiKey: "",
      modelsText: "",
      apiSize: "",
    },
  },
];

/** 卡片类型徽标文案 */
const TYPE_LABEL: Record<GenProviderType, string> = {
  cli: "CLI",
  api: "API",
  dashscope: "百炼",
  gemini: "banana",
  minimax: "MiniMax",
};

/** 各 API 系类型的表单 placeholder 与接口说明 */
const API_TYPE_META: Record<Exclude<GenProviderType, "cli">, { baseUrlPh: string; modelsPh: string; sizePh: string; hint: string }> = {
  api: {
    baseUrlPh: "https://api.openai.com/v1（或火山方舟 /api/v3 等兼容端点）",
    modelsPh: "gpt-image-1, doubao-seedream-4-0-250828",
    sizePh: "1024x1024",
    hint: "文生图 POST {Base URL}/images/generations；选引用图改走 /images/edits（需 gpt-image 系列等支持编辑的模型，dall-e-3 不支持）；测试连接 / 获取模型走 GET /models",
  },
  dashscope: {
    baseUrlPh: "https://dashscope.aliyuncs.com（或 {WorkspaceId}.cn-beijing.maas.aliyuncs.com）",
    modelsPh: "qwen-image-2.0-pro, qwen-image-edit-max",
    sizePh: "2048*2048",
    hint: "百炼原生 POST {Base URL}/api/v1/services/aigc/multimodal-generation/generation（qwen-image 系列不在 OpenAI 兼容模式内）；引用图 base64 随 messages 上送；尺寸为星号格式；测试连接 / 获取模型走 GET compatible-mode/v1/models",
  },
  gemini: {
    baseUrlPh: "https://generativelanguage.googleapis.com",
    modelsPh: "gemini-2.5-flash-image, gemini-3-pro-image-preview",
    sizePh: "1:1",
    hint: "banana（Gemini 图像）：POST {Base URL}/v1beta/models/{模型}:generateContent（x-goog-api-key 头）；引用图以 inlineData base64 上送；尺寸填宽高比如 16:9；测试连接 / 获取模型走 GET /v1beta/models",
  },
  minimax: {
    baseUrlPh: "https://api.minimaxi.com",
    modelsPh: "image-01",
    sizePh: "16:9",
    hint: "MiniMax：POST {Base URL}/v1/image_generation；引用图走 subject_reference（主体特征保持，限一张）；尺寸填宽高比如 16:9；测试连接仅校验字段（无轻量探测端点）；获取模型为 best-effort 试 /v1/models，拉不到就手填",
  },
};

function engineText(cfg: ReturnType<typeof useServerConfig>): string {
  if (!cfg) return t("引擎检测中…");
  switch (cfg.matting.engine) {
    case "custom-cli":
      return t("引擎: 自定义 CLI");
    case "rembg-bundled":
      return t("引擎: rembg/{model}", { model: cfg.matting.model });
    case "rembg-path":
      return t("引擎: rembg/{model}（PATH）", { model: cfg.matting.model });
    default:
      return t("未安装抠图引擎，将仅复制原图");
  }
}

/** 设置页：生成 provider 列表（CLI/API 多个共存，生成时选择）+ 抠图配置 + 体检 */
export default function SettingsPage() {
  const t = useT();
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const [mat, setMat] = useState<MattingSettings>(MAT_DEFAULT);
  const [enhancers, setEnhancers] = useState<EnhancerDraft[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savingMat, setSavingMat] = useState(false);
  const [savingEnh, setSavingEnh] = useState(false);
  const [tests, setTests] = useState<Record<string, { testing: boolean; result: ProviderTestResponse | null }>>({});
  // 「获取模型」拉取结果：models 为拉到的全量列表（可过滤点选），error 时保持手填
  const [modelLists, setModelLists] = useState<Record<string, { loading: boolean; models: string[] | null; error: string | null }>>({});
  const [modelFilters, setModelFilters] = useState<Record<string, string>>({});
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const cfg = useServerConfig();

  // 打开时回填 settings 表中的值（env 兜底在服务端，这里只编辑设置页自己的值）
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const list = Array.isArray(s["genProviders"]) ? (s["genProviders"] as GenProvider[]) : [];
        setDrafts(list.map(toDraft));
        const m = s["matting"] as Partial<MattingSettings> | undefined;
        if (m && typeof m === "object") setMat({ ...MAT_DEFAULT, ...m });
        const enh = Array.isArray(s["promptEnhancers"]) ? (s["promptEnhancers"] as PromptEnhancer[]) : [];
        setEnhancers(
          enh.map((e) => ({
            id: e.id,
            name: e.name,
            apiBaseUrl: e.apiBaseUrl,
            apiKey: e.apiKey,
            apiModel: e.apiModel,
          }))
        );
      })
      .catch((e) => notify(t("读取设置失败: {msg}", { msg: (e as Error).message })));
  }, []);

  const runDoctorCheck = () => {
    setDoctorLoading(true);
    api
      .getDoctor()
      .then(setDoctor)
      .catch((e) => notify(t("体检失败: {msg}", { msg: (e as Error).message })))
      .finally(() => setDoctorLoading(false));
  };
  useEffect(() => {
    runDoctorCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchDraft = (id: string, patch: Partial<ProviderDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const addPreset = (preset: (typeof PRESETS)[number]) =>
    setDrafts((prev) => [...prev, { ...preset.draft, id: crypto.randomUUID(), name: t(preset.draft.name) }]);

  /** 任意卡片保存/删除都整表写入 genProviders */
  const persist = async (list: ProviderDraft[]): Promise<boolean> => {
    try {
      await api.putSetting("genProviders", list.map(fromDraft));
      await refreshServerConfig();
      return true;
    } catch (e) {
      notify(t("保存失败: {msg}", { msg: (e as Error).message }));
      return false;
    }
  };

  const saveOne = async (id: string) => {
    setSavingId(id);
    const ok = await persist(drafts);
    setSavingId(null);
    if (ok) {
      setSavedId(id);
      window.setTimeout(() => setSavedId((s) => (s === id ? null : s)), 2000);
      runDoctorCheck();
    }
  };

  const removeOne = async (id: string) => {
    const d = drafts.find((x) => x.id === id);
    if (!(await askConfirm(t("确定删除 provider「{name}」吗？", { name: d?.name ?? id })))) return;
    const next = drafts.filter((x) => x.id !== id);
    if (await persist(next)) {
      setDrafts(next);
      notify(t("已删除 provider"), "info");
      runDoctorCheck();
    }
  };

  const testOne = async (d: ProviderDraft) => {
    setTests((prev) => ({ ...prev, [d.id]: { testing: true, result: null } }));
    try {
      const result = await api.testProvider({
        type: d.type === "cli" ? undefined : d.type,
        apiBaseUrl: d.apiBaseUrl,
        apiKey: d.apiKey,
        apiModel: d.modelsText.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)[0],
      });
      setTests((prev) => ({ ...prev, [d.id]: { testing: false, result } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [d.id]: { testing: false, result: { ok: false, error: (e as Error).message } } }));
    }
  };

  /** modelsText 逗号分隔文本 ↔ 数组 */
  const splitModels = (text: string) =>
    text.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);

  /** 获取模型：用表单当前 baseUrl/key 拉模型列表（不要求已保存），拉到后渲染点选 chips */
  const fetchModels = async (d: ProviderDraft) => {
    if (d.type === "cli") return;
    setModelLists((prev) => ({ ...prev, [d.id]: { loading: true, models: null, error: null } }));
    try {
      const r = await api.listProviderModels({ type: d.type, apiBaseUrl: d.apiBaseUrl, apiKey: d.apiKey });
      setModelLists((prev) => ({
        ...prev,
        [d.id]: { loading: false, models: r.models ?? null, error: r.ok ? null : (r.error ?? t("拉取失败")) },
      }));
    } catch (e) {
      setModelLists((prev) => ({ ...prev, [d.id]: { loading: false, models: null, error: (e as Error).message } }));
    }
  };

  /** 点选 chip：已在列表则移除，否则追加（保留手输项） */
  const toggleModel = (d: ProviderDraft, model: string) => {
    const list = splitModels(d.modelsText);
    const next = list.includes(model) ? list.filter((m) => m !== model) : [...list, model];
    patchDraft(d.id, { modelsText: next.join(", ") });
  };

  const saveMatting = async () => {
    setSavingMat(true);
    try {
      await api.putSetting("matting", mat);
      await refreshServerConfig();
      notify(t("抠图配置已保存"), "info");
      runDoctorCheck();
    } catch (e) {
      notify(t("保存失败: {msg}", { msg: (e as Error).message }));
    } finally {
      setSavingMat(false);
    }
  };

  // ---- 提示词加强模型 ----
  const patchEnhancer = (id: string, patch: Partial<EnhancerDraft>) =>
    setEnhancers((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const addEnhancer = () =>
    setEnhancers((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: t("未命名加强模型"), apiBaseUrl: "", apiKey: "", apiModel: "" },
    ]);

  const persistEnhancers = async (list: EnhancerDraft[]): Promise<boolean> => {
    try {
      await api.putSetting("promptEnhancers", list);
      await refreshServerConfig();
      return true;
    } catch (e) {
      notify(t("保存失败: {msg}", { msg: (e as Error).message }));
      return false;
    }
  };

  const saveEnhancers = async () => {
    setSavingEnh(true);
    if (await persistEnhancers(enhancers)) {
      notify(t("加强模型已保存"), "info");
      runDoctorCheck();
    }
    setSavingEnh(false);
  };

  const removeEnhancer = async (id: string) => {
    const e = enhancers.find((x) => x.id === id);
    if (!(await askConfirm(t("确定删除加强模型「{name}」吗？", { name: e?.name ?? id })))) return;
    const next = enhancers.filter((x) => x.id !== id);
    if (await persistEnhancers(next)) {
      setEnhancers(next);
      notify(t("已删除加强模型"), "info");
      runDoctorCheck();
    }
  };

  /** 加强模型测试：OpenAI 兼容 chat 端点普遍有 /models，复用 provider 测试 */
  const testEnhancer = async (e: EnhancerDraft) => {
    const key = `enh-${e.id}`;
    setTests((prev) => ({ ...prev, [key]: { testing: true, result: null } }));
    try {
      const result = await api.testProvider({
        type: "api",
        apiBaseUrl: e.apiBaseUrl,
        apiKey: e.apiKey,
        apiModel: e.apiModel,
      });
      setTests((prev) => ({ ...prev, [key]: { testing: false, result } }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [key]: { testing: false, result: { ok: false, error: (err as Error).message } } }));
    }
  };

  return (
    <div className="page settings-page">
      <header className="home-header">
        <h1>
          <Settings2 size={24} /> {t("设置")}
        </h1>
        <p className="subtitle">{t("生成 provider（CLI / API 可配多个共存，生成时选择模型）· 抠图引擎 · 体检")}</p>
      </header>

      {/* ===== 生成 Provider 列表 ===== */}
      <section className="settings-sec">
        <h3>
          <Settings2 size={14} /> {t("生成 Provider")}
        </h3>

        <div className="preset-row">
          <span>{t("快速添加：")}</span>
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="px-btn mini" onClick={() => addPreset(p)}>
              <Plus size={12} /> {t(p.label)}
            </button>
          ))}
        </div>

        {drafts.length === 0 && (
          <div className="hint">
            {t("还没有 provider。点上方预设快速添加（CLI / OpenAI 兼容 / 百炼 / banana / MiniMax / 火山方舟）；也可用环境变量")}{" "}
            <code>FRAMEBAKER_GEN_CLI</code> {t("兜底（列表为空时生效）。")}
          </div>
        )}

        {drafts.map((d) => {
          const tst = tests[d.id];
          const ml = modelLists[d.id];
          return (
            <div key={d.id} className="provider-card">
              <div className="provider-head">
                <span className={`provider-type ${d.type}`}>{t(TYPE_LABEL[d.type])}</span>
                <input
                  className="px-input provider-name"
                  value={d.name}
                  onChange={(e) => patchDraft(d.id, { name: e.target.value })}
                />
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn mini accent"
                  disabled={savingId != null}
                  onClick={() => saveOne(d.id)}
                >
                  <Save size={12} /> {savingId === d.id ? t("保存中…") : savedId === d.id ? t("已保存 ✓") : t("保存")}
                </motion.button>
                <button type="button" className="px-btn mini danger" onClick={() => removeOne(d.id)}>
                  <Trash2 size={12} /> {t("删除")}
                </button>
              </div>

              {d.type === "cli" ? (
                <>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>{t("命令（PATH 名或绝对路径）")}</span>
                        <input
                          className="px-input"
                          placeholder={t("mygen 或 /abs/path/mygen")}
                          value={d.cliBin}
                          onChange={(e) => patchDraft(d.id, { cliBin: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("prompt 参数名")}</span>
                        <input
                          className="px-input"
                          placeholder={t("--prompt（留空=位置参数）")}
                          value={d.cliPromptArg}
                          onChange={(e) => patchDraft(d.id, { cliPromptArg: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("输出参数名")}</span>
                        <input
                          className="px-input"
                          placeholder={t("-o 或 --output")}
                          value={d.cliOutputArg}
                          onChange={(e) => patchDraft(d.id, { cliOutputArg: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>{t("模型参数名（可留空）")}</span>
                        <input
                          className="px-input"
                          placeholder={t("--model（留空不下发模型）")}
                          value={d.cliModelArg}
                          onChange={(e) => patchDraft(d.id, { cliModelArg: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("引用图参数名（可留空）")}</span>
                        <input
                          className="px-input"
                          placeholder={t("--ref（留空=不支持引用图）")}
                          value={d.cliReferenceArg}
                          onChange={(e) => patchDraft(d.id, { cliReferenceArg: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("额外固定参数（可留空）")}</span>
                        <input
                          className="px-input"
                          placeholder={t("--steps 20（原样追加）")}
                          value={d.cliExtraArgs}
                          onChange={(e) => patchDraft(d.id, { cliExtraArgs: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="hint">
                    {t("不用手写任何")} {"{占位符}"}
                    {t("：执行时按上表组装")} <code>argv</code>
                    {t("（命令 + 参数名 值 …），不经 shell；参数名留空表示对应值作位置参数传入；模型 / 引用图在生成弹窗选择后按对应参数名下发")}
                  </div>
                </>
              ) : (
                <>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>Base URL</span>
                        <input
                          className="px-input"
                          placeholder={t(API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].baseUrlPh)}
                          value={d.apiBaseUrl}
                          onChange={(e) => patchDraft(d.id, { apiBaseUrl: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>API Key</span>
                        <input
                          className="px-input"
                          type="password"
                          autoComplete="off"
                          placeholder="sk-…"
                          value={d.apiKey}
                          onChange={(e) => patchDraft(d.id, { apiKey: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>{t("可用模型（逗号分隔，生成时下拉选择）")}</span>
                        <div className="models-fetch-row">
                          <input
                            className="px-input"
                            placeholder={API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].modelsPh}
                            value={d.modelsText}
                            onChange={(e) => patchDraft(d.id, { modelsText: e.target.value })}
                          />
                          <button
                            type="button"
                            className="px-btn mini"
                            disabled={ml?.loading}
                            onClick={() => fetchModels(d)}
                          >
                            <RefreshCw size={12} /> {ml?.loading ? t("拉取中…") : t("获取模型")}
                          </button>
                        </div>
                      </label>
                      <label className="field">
                        <span>{t("尺寸（可留空）")}</span>
                        <input
                          className="px-input num"
                          placeholder={API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].sizePh}
                          value={d.apiSize}
                          onChange={(e) => patchDraft(d.id, { apiSize: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  {ml?.error && <div className="hint">{t("获取模型失败：{err}（可继续手填）", { err: ml.error })}</div>}
                  {ml?.models && (
                    <div className="model-fetch">
                      <input
                        className="px-input model-filter"
                        placeholder={t("过滤模型（共 {count} 个，点击加入/移除）", { count: ml.models.length })}
                        value={modelFilters[d.id] ?? ""}
                        onChange={(e) =>
                          setModelFilters((prev) => ({ ...prev, [d.id]: e.target.value }))
                        }
                      />
                      <div className="model-chips">
                        {ml.models
                          .filter((m) => {
                            const q = (modelFilters[d.id] ?? "").trim().toLowerCase();
                            return !q || m.toLowerCase().includes(q);
                          })
                          .map((m) => {
                            const active = splitModels(d.modelsText).includes(m);
                            return (
                              <button
                                key={m}
                                type="button"
                                className={`model-chip${active ? " active" : ""}`}
                                onClick={() => toggleModel(d, m)}
                              >
                                {m}
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}
                  <div className="provider-test">
                    <button
                      type="button"
                      className="px-btn mini"
                      disabled={tst?.testing}
                      onClick={() => testOne(d)}
                    >
                      <PlugZap size={12} /> {tst?.testing ? t("测试中…") : t("测试连接")}
                    </button>
                    {tst?.result && (
                      <span className={`engine-status ${tst.result.ok ? "ok" : "bad"}`}>
                        <span className="dot" />
                        {tst.result.ok
                          ? tst.result.note ??
                            `${t("连通（{ms}ms）", { ms: tst.result.latencyMs ?? 0 })}${
                              tst.result.modelsFound === true
                                ? t("，模型在列表中")
                                : tst.result.modelsFound === false
                                  ? t("，但模型列表中没有首个模型")
                                  : ""
                            }`
                          : t("失败：{err}", { err: tst.result.error ?? t("未知错误") })}
                      </span>
                    )}
                  </div>
                  <div className="hint">{t(API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].hint)}</div>
                </>
              )}
            </div>
          );
        })}
      </section>

      {/* ===== 抠图 ===== */}
      <section className="settings-sec">
        <h3>
          <Wand2 size={14} /> {t("抠图")}
          <span className={`engine-status ${cfg && cfg.matting.engine !== "none" ? "ok" : "bad"}`}>
            <span className="dot" />
            {engineText(cfg)}
          </span>
        </h3>
        <div className="form-row">
          <label>{t("自定义抠图命令（留空走自动探测：.venv-matting → PATH rembg → 原样复制）")}</label>
          <div className="form-inline">
            <label className="field">
              <span>{t("命令")}</span>
              <input
                className="px-input"
                placeholder={t("mymatte 或 /abs/path/mymatte")}
                value={mat.cliBin}
                onChange={(e) => setMat((s) => ({ ...s, cliBin: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>{t("输入图参数名")}</span>
              <input
                className="px-input"
                placeholder={t("留空=位置参数")}
                value={mat.cliInputArg}
                onChange={(e) => setMat((s) => ({ ...s, cliInputArg: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>{t("输出图参数名")}</span>
              <input
                className="px-input"
                placeholder={t("如 -o")}
                value={mat.cliOutputArg}
                onChange={(e) => setMat((s) => ({ ...s, cliOutputArg: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>{t("模型参数名")}</span>
              <input
                className="px-input num"
                placeholder={t("如 -m")}
                value={mat.cliModelArg}
                onChange={(e) => setMat((s) => ({ ...s, cliModelArg: e.target.value }))}
              />
            </label>
          </div>
        </div>
        <div className="form-row">
          <label>{t("默认模型（生成/上传抠图时使用；留空用 env / 默认 u2net）")}</label>
          <PxSuggest
            placeholder="u2net"
            suggestions={[...REMBG_MODELS]}
            value={mat.model}
            onChange={(v) => setMat((s) => ({ ...s, model: v }))}
          />
          {cfg && (
            <div className="hint">
              {t("当前生效模型：")}<code>{cfg.matting.model}</code>（
              {cfg.matting.modelCached ? t("已缓存 storage/models") : t("未缓存，首次抠图自动下载，约百 MB")}）
            </div>
          )}
        </div>
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={savingMat}
            onClick={saveMatting}
          >
            <Save size={14} /> {savingMat ? t("保存中…") : t("保存抠图配置")}
          </motion.button>
        </div>
      </section>

      {/* ===== 提示词加强模型 ===== */}
      <section className="settings-sec">
        <h3>
          <Sparkles size={14} /> {t("提示词加强模型")}
          <span className="settings-head-actions">
            <button type="button" className="px-btn mini" onClick={addEnhancer}>
              <Plus size={12} /> {t("添加")}
            </button>
          </span>
        </h3>
        <div className="hint">
          {t("用于生成弹窗的「优化提示词」：把简短描述改写成更适合生图的提示词（加强模板内置固定，无需手写）。OpenAI 兼容")}{" "}
          <code>chat/completions</code>{" "}
          {t("接口均可（OpenAI / 百炼兼容模式 qwen / DeepSeek 等）。优化后新旧提示词并排展示，由你选择用哪版。")}
        </div>
        {enhancers.map((e) => {
          const tst = tests[`enh-${e.id}`];
          return (
            <div key={e.id} className="provider-card">
              <div className="provider-head">
                <span className="provider-type enhancer">{t("加强")}</span>
                <input
                  className="px-input provider-name"
                  value={e.name}
                  onChange={(e2) => patchEnhancer(e.id, { name: e2.target.value })}
                />
                <button type="button" className="px-btn mini danger" onClick={() => removeEnhancer(e.id)}>
                  <Trash2 size={12} /> {t("删除")}
                </button>
              </div>
              <div className="form-row">
                <div className="form-inline">
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      className="px-input"
                      placeholder={t("https://api.openai.com/v1（或百炼兼容模式 …/compatible-mode/v1）")}
                      value={e.apiBaseUrl}
                      onChange={(e2) => patchEnhancer(e.id, { apiBaseUrl: e2.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>API Key</span>
                    <input
                      className="px-input"
                      type="password"
                      autoComplete="off"
                      placeholder="sk-…"
                      value={e.apiKey}
                      onChange={(e2) => patchEnhancer(e.id, { apiKey: e2.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("模型")}</span>
                    <input
                      className="px-input"
                      placeholder="gpt-4o-mini / qwen-plus"
                      value={e.apiModel}
                      onChange={(e2) => patchEnhancer(e.id, { apiModel: e2.target.value })}
                    />
                  </label>
                </div>
              </div>
              <div className="provider-test">
                <button type="button" className="px-btn mini" disabled={tst?.testing} onClick={() => testEnhancer(e)}>
                  <PlugZap size={12} /> {tst?.testing ? t("测试中…") : t("测试连接")}
                </button>
                {tst?.result && (
                  <span className={`engine-status ${tst.result.ok ? "ok" : "bad"}`}>
                    <span className="dot" />
                    {tst.result.ok
                      ? `${t("连通（{ms}ms）", { ms: tst.result.latencyMs ?? 0 })}${
                          tst.result.modelsFound === true
                            ? t("，模型在列表中")
                            : tst.result.modelsFound === false
                              ? t("，但模型列表中没有该模型")
                              : ""
                        }`
                      : t("失败：{err}", { err: tst.result.error ?? t("未知错误") })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={savingEnh}
            onClick={saveEnhancers}
          >
            <Save size={14} /> {savingEnh ? t("保存中…") : t("保存加强模型")}
          </motion.button>
        </div>
      </section>

      {/* ===== 体检 ===== */}
      <section className="settings-sec">
        <h3>
          <Stethoscope size={14} /> {t("体检")}
          <span className="settings-head-actions">
            <button type="button" className="px-btn mini" disabled={doctorLoading} onClick={runDoctorCheck}>
              {doctorLoading ? t("检查中…") : t("重新检查")}
            </button>
          </span>
        </h3>
        {doctor === null ? (
          <div className="hint">{t("正在检查…")}</div>
        ) : (
          <ul className="doctor-list">
            {doctor.checks.map((c) => (
              <li key={c.id} className="doctor-item">
                <span className={`engine-status ${c.ok ? "ok" : "bad"}`}>
                  <span className="dot" />
                  {c.label}
                </span>
                <span className="doctor-detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
