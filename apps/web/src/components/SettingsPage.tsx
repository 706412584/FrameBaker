import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { PlugZap, Plus, Save, Settings2, Stethoscope, Trash2, Wand2 } from "lucide-react";
import type {
  DoctorResponse,
  GenProvider,
  GenProviderType,
  MattingSettings,
  ProviderTestResponse,
} from "@framebaker/shared";
import { REMBG_MODELS } from "@framebaker/shared";
import { api } from "../api";
import { refreshServerConfig, useServerConfig } from "../config";
import { askConfirm, notify } from "../notice";

/** 编辑草稿：apiModels 用逗号分隔文本编辑，保存时才拆成数组 */
interface ProviderDraft {
  id: string;
  name: string;
  type: GenProviderType;
  cliTemplate: string;
  apiBaseUrl: string;
  apiKey: string;
  modelsText: string;
  apiSize: string;
}

const MAT_DEFAULT: MattingSettings = { cliTemplate: "", model: "" };

function toDraft(p: GenProvider): ProviderDraft {
  return { ...p, modelsText: p.apiModels.join(", ") };
}

function fromDraft(d: ProviderDraft): GenProvider {
  return {
    id: d.id,
    name: d.name.trim() || d.id,
    type: d.type,
    cliTemplate: d.cliTemplate,
    apiBaseUrl: d.apiBaseUrl,
    apiKey: d.apiKey,
    apiModels: d.modelsText
      .split(/[,，\n]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    apiSize: d.apiSize,
  };
}

function newDraft(type: GenProviderType): ProviderDraft {
  return {
    id: crypto.randomUUID(),
    name: type === "cli" ? "未命名 CLI" : "未命名 API",
    type,
    cliTemplate: "",
    apiBaseUrl: "",
    apiKey: "",
    modelsText: "",
    apiSize: "",
  };
}

function engineText(cfg: ReturnType<typeof useServerConfig>): string {
  if (!cfg) return "引擎检测中…";
  switch (cfg.matting.engine) {
    case "custom-cli":
      return "引擎: 自定义 CLI";
    case "rembg-bundled":
      return `引擎: rembg/${cfg.matting.model}`;
    case "rembg-path":
      return `引擎: rembg/${cfg.matting.model}（PATH）`;
    default:
      return "未安装抠图引擎，将仅复制原图";
  }
}

/** 设置页：生成 provider 列表（CLI/API 多个共存，生成时选择）+ 抠图配置 + 体检 */
export default function SettingsPage() {
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const [mat, setMat] = useState<MattingSettings>(MAT_DEFAULT);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savingMat, setSavingMat] = useState(false);
  const [tests, setTests] = useState<Record<string, { testing: boolean; result: ProviderTestResponse | null }>>({});
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
      })
      .catch((e) => notify(`读取设置失败: ${(e as Error).message}`));
  }, []);

  const runDoctorCheck = () => {
    setDoctorLoading(true);
    api
      .getDoctor()
      .then(setDoctor)
      .catch((e) => notify(`体检失败: ${(e as Error).message}`))
      .finally(() => setDoctorLoading(false));
  };
  useEffect(() => {
    runDoctorCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchDraft = (id: string, patch: Partial<ProviderDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const addProvider = (type: GenProviderType) => setDrafts((prev) => [...prev, newDraft(type)]);

  /** 任意卡片保存/删除都整表写入 genProviders */
  const persist = async (list: ProviderDraft[]): Promise<boolean> => {
    try {
      await api.putSetting("genProviders", list.map(fromDraft));
      await refreshServerConfig();
      return true;
    } catch (e) {
      notify(`保存失败: ${(e as Error).message}`);
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
    if (!(await askConfirm(`确定删除 provider「${d?.name ?? id}」吗？`))) return;
    const next = drafts.filter((x) => x.id !== id);
    if (await persist(next)) {
      setDrafts(next);
      notify("已删除 provider", "info");
      runDoctorCheck();
    }
  };

  const testOne = async (d: ProviderDraft) => {
    setTests((prev) => ({ ...prev, [d.id]: { testing: true, result: null } }));
    try {
      const result = await api.testProvider({
        apiBaseUrl: d.apiBaseUrl,
        apiKey: d.apiKey,
        apiModel: d.modelsText.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)[0],
      });
      setTests((prev) => ({ ...prev, [d.id]: { testing: false, result } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [d.id]: { testing: false, result: { ok: false, error: (e as Error).message } } }));
    }
  };

  const saveMatting = async () => {
    setSavingMat(true);
    try {
      await api.putSetting("matting", mat);
      await refreshServerConfig();
      notify("抠图配置已保存", "info");
      runDoctorCheck();
    } catch (e) {
      notify(`保存失败: ${(e as Error).message}`);
    } finally {
      setSavingMat(false);
    }
  };

  return (
    <div className="page settings-page">
      <header className="home-header">
        <h1>
          <Settings2 size={24} /> 设置
        </h1>
        <p className="subtitle">生成 provider（CLI / API 可配多个共存，生成时选择模型）· 抠图引擎 · 体检</p>
      </header>

      {/* ===== 生成 Provider 列表 ===== */}
      <section className="settings-sec">
        <h3>
          <Settings2 size={14} /> 生成 Provider
          <span className="settings-head-actions">
            <button type="button" className="px-btn mini" onClick={() => addProvider("cli")}>
              <Plus size={12} /> CLI
            </button>
            <button type="button" className="px-btn mini" onClick={() => addProvider("api")}>
              <Plus size={12} /> API
            </button>
          </span>
        </h3>

        {drafts.length === 0 && (
          <div className="hint">
            还没有 provider。添加一个 CLI 或 API provider；也可用环境变量 <code>FRAMEBAKER_GEN_CLI</code> 兜底（列表为空时生效）。
          </div>
        )}

        {drafts.map((d) => {
          const t = tests[d.id];
          return (
            <div key={d.id} className="provider-card">
              <div className="provider-head">
                <span className={`provider-type ${d.type}`}>{d.type === "cli" ? "CLI" : "API"}</span>
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
                  <Save size={12} /> {savingId === d.id ? "保存中…" : savedId === d.id ? "已保存 ✓" : "保存"}
                </motion.button>
                <button type="button" className="px-btn mini danger" onClick={() => removeOne(d.id)}>
                  <Trash2 size={12} /> 删除
                </button>
              </div>

              {d.type === "cli" ? (
                <div className="form-row">
                  <label>命令模板</label>
                  <textarea
                    className="px-input px-textarea"
                    rows={2}
                    placeholder={'mygen --prompt "{prompt}" --model {model} --ref {reference} -o {output}'}
                    value={d.cliTemplate}
                    onChange={(e) => patchDraft(d.id, { cliTemplate: e.target.value })}
                  />
                  <div className="hint">
                    占位符：{"{prompt}"} {"{output}"} {"{index}"} {"{reference}"} {"{model}"}
                    （{"{model}"} 由生成弹窗的模型输入填入）；模板按空白切分为 argv，不经 shell
                  </div>
                </div>
              ) : (
                <>
                  <div className="form-row">
                    <label>Base URL / API Key</label>
                    <div className="form-inline">
                      <input
                        className="px-input"
                        placeholder="https://api.openai.com/v1（或百炼等兼容端点）"
                        value={d.apiBaseUrl}
                        onChange={(e) => patchDraft(d.id, { apiBaseUrl: e.target.value })}
                      />
                      <input
                        className="px-input"
                        type="password"
                        autoComplete="off"
                        placeholder="sk-…"
                        value={d.apiKey}
                        onChange={(e) => patchDraft(d.id, { apiKey: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label>可用模型（逗号分隔，生成时下拉选择）/ 尺寸（可留空）</label>
                    <div className="form-inline">
                      <input
                        className="px-input"
                        placeholder="gpt-image-1, wanx2.1-t2i-turbo"
                        value={d.modelsText}
                        onChange={(e) => patchDraft(d.id, { modelsText: e.target.value })}
                      />
                      <input
                        className="px-input num"
                        placeholder="1024x1024"
                        value={d.apiSize}
                        onChange={(e) => patchDraft(d.id, { apiSize: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="provider-test">
                    <button
                      type="button"
                      className="px-btn mini"
                      disabled={t?.testing}
                      onClick={() => testOne(d)}
                    >
                      <PlugZap size={12} /> {t?.testing ? "测试中…" : "测试连接"}
                    </button>
                    {t?.result && (
                      <span className={`engine-status ${t.result.ok ? "ok" : "bad"}`}>
                        <span className="dot" />
                        {t.result.ok
                          ? `连通（${t.result.latencyMs}ms）${
                              t.result.modelsFound === true
                                ? "，模型在列表中"
                                : t.result.modelsFound === false
                                  ? "，但模型列表中没有首个模型"
                                  : ""
                            }`
                          : `失败：${t.result.error}`}
                      </span>
                    )}
                  </div>
                  <div className="hint">
                    调用 <code>POST {"{Base URL}"}/images/generations</code>；测试连接走 <code>GET /models</code>
                    ；API 方式暂不支持引用图
                  </div>
                </>
              )}
            </div>
          );
        })}
      </section>

      {/* ===== 抠图 ===== */}
      <section className="settings-sec">
        <h3>
          <Wand2 size={14} /> 抠图
          <span className={`engine-status ${cfg && cfg.matting.engine !== "none" ? "ok" : "bad"}`}>
            <span className="dot" />
            {engineText(cfg)}
          </span>
        </h3>
        <div className="form-row">
          <label>自定义 CLI 模板（留空走自动探测：.venv-matting → PATH rembg → 原样复制）</label>
          <input
            className="px-input"
            placeholder={"rembg i -m {model} {input} {output}（留空用自动探测）"}
            value={mat.cliTemplate}
            onChange={(e) => setMat((s) => ({ ...s, cliTemplate: e.target.value }))}
          />
        </div>
        <div className="form-row">
          <label>默认模型（生成/上传抠图时使用；留空用 env / 默认 u2net）</label>
          <input
            className="px-input"
            list="rembg-model-list"
            placeholder="u2net"
            value={mat.model}
            onChange={(e) => setMat((s) => ({ ...s, model: e.target.value }))}
          />
          <datalist id="rembg-model-list">
            {REMBG_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {cfg && (
            <div className="hint">
              当前生效模型：<code>{cfg.matting.model}</code>（
              {cfg.matting.modelCached ? "已缓存 storage/models" : "未缓存，首次抠图自动下载，约百 MB"}）
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
            <Save size={14} /> {savingMat ? "保存中…" : "保存抠图配置"}
          </motion.button>
        </div>
      </section>

      {/* ===== 体检 ===== */}
      <section className="settings-sec">
        <h3>
          <Stethoscope size={14} /> 体检
          <span className="settings-head-actions">
            <button type="button" className="px-btn mini" disabled={doctorLoading} onClick={runDoctorCheck}>
              {doctorLoading ? "检查中…" : "重新检查"}
            </button>
          </span>
        </h3>
        {doctor === null ? (
          <div className="hint">正在检查…</div>
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
