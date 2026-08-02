import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Package, Terminal, Upload, X } from "lucide-react";
import { SOURCE_COLORS } from "@framebaker/shared";
import { api, materialImageUrl, type Job, type Material } from "../api";
import { themedSourceColor, useTheme } from "../theme";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import ReferencePicker, { type ReferenceSelection } from "./ReferencePicker";

type Tab = "materials" | "upload" | "cli";

type FileState = "pending" | "uploading" | "queued" | "done" | "error";
interface UploadItem {
  file: File;
  state: FileState;
  error?: string | null;
}

interface Props {
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}

function inferType(f: File): "gif" | "mp4" | "image" {
  const ext = f.name.split(".").pop()?.toLowerCase();
  if (ext === "gif") return "gif";
  if (ext === "mp4" || ext === "mov" || ext === "webm") return "mp4";
  return "image";
}

function stateIcon(s: FileState): string {
  switch (s) {
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "uploading":
      return "↑";
    case "queued":
      return "…";
    default:
      return "·";
  }
}

export default function ImportModal({ projectId, onClose, onDone }: Props) {
  const [tab, setTab] = useState<Tab>("materials");
  // 素材库 Tab：素材多选导入
  const [mats, setMats] = useState<Material[] | null>(null);
  const [matV, setMatV] = useState(0);
  const [pickedIds, setPickedIds] = useState<string[]>([]); // 数组保持点选顺序
  // 上传 Tab：多文件逐个分发
  const [items, setItems] = useState<UploadItem[]>([]);
  const [finished, setFinished] = useState(false);
  const [fps, setFps] = useState(8);
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState<ReferenceSelection | null>(null);
  const [count, setCount] = useState(4);
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const theme = useTheme();

  // 打开素材库 Tab 时加载素材列表
  useEffect(() => {
    if (tab === "materials" && mats === null) {
      api
        .listMaterials()
        .then((list) => {
          setMats(list);
          setMatV(Date.now());
        })
        .catch((e) => alert(`加载素材库失败: ${e.message}`));
    }
  }, [tab, mats]);

  const updateItem = (index: number, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  // 单任务轮询（CLI 生成），WS 也会触发帧列表刷新，这里是面板内展示 + 兜底
  const startPoll = (jobId: string) => {
    const tick = async () => {
      try {
        const j = await api.getJob(jobId);
        setJob(j);
        if (j.status === "done") {
          setSubmitting(false);
          onDone();
          return;
        }
        if (j.status === "error") {
          setSubmitting(false);
          return;
        }
        pollRef.current = window.setTimeout(tick, 1000);
      } catch {
        pollRef.current = window.setTimeout(tick, 1500);
      }
    };
    tick();
  };

  // 多任务轮询（上传 Tab）：全部结束后汇总
  const pollJobs = (entries: { jobId: string; index: number }[]) => {
    const pending = new Map(entries.map((e) => [e.jobId, e.index]));
    const tick = async () => {
      for (const [jobId, index] of [...pending]) {
        try {
          const j = await api.getJob(jobId);
          if (j.status === "done") {
            updateItem(index, { state: "done" });
            pending.delete(jobId);
          } else if (j.status === "error") {
            updateItem(index, { state: "error", error: j.error });
            pending.delete(jobId);
          }
        } catch {
          /* 继续轮询 */
        }
      }
      if (pending.size === 0) {
        setSubmitting(false);
        setFinished(true);
        onDone();
        return;
      }
      pollRef.current = window.setTimeout(tick, 1000);
    };
    tick();
  };

  useEffect(
    () => () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    },
    []
  );

  const resetJob = () => {
    setJob(null);
    setFinished(false);
    if (pollRef.current) clearTimeout(pollRef.current);
  };

  // ---- 素材库 Tab ----
  const togglePick = (id: string) => {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submitPick = async () => {
    if (pickedIds.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api.batchImportMaterials(pickedIds, projectId);
      onDone(); // 刷新帧列表（WS 也会广播 frames_changed）
      onClose();
    } catch (e) {
      alert(`导入失败: ${(e as Error).message}`);
      setSubmitting(false);
    }
  };

  // 跳转素材库（pushState + 手动派发 popstate，App 监听的是 popstate）
  const goMaterials = () => {
    history.pushState(null, "", "/materials");
    window.dispatchEvent(new PopStateEvent("popstate"));
    onClose();
  };

  // ---- 上传 Tab ----
  const hasVideo = items.some((it) => inferType(it.file) !== "image");

  const submitUpload = async () => {
    if (items.length === 0 || submitting) return;
    setSubmitting(true);
    setFinished(false);
    const jobEntries: { jobId: string; index: number }[] = [];
    for (let i = 0; i < items.length; i++) {
      updateItem(i, { state: "uploading", error: null });
      try {
        const fd = new FormData();
        fd.append("file", items[i].file);
        fd.append("projectId", projectId);
        fd.append("type", inferType(items[i].file));
        fd.append("fps", String(fps));
        fd.append("autoMatting", String(autoMatting));
        const { jobId } = await api.upload(fd);
        jobEntries.push({ jobId, index: i });
        updateItem(i, { state: "queued" });
      } catch (e) {
        // 单个失败不阻塞其他文件
        updateItem(i, { state: "error", error: (e as Error).message });
      }
    }
    if (jobEntries.length === 0) {
      setSubmitting(false);
      setFinished(true);
      onDone();
    } else {
      pollJobs(jobEntries);
    }
  };

  // ---- CLI 生成 Tab ----
  const submitGenerate = async () => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    resetJob();
    try {
      const { jobId } = await api.generate({
        projectId,
        prompt: prompt.trim(),
        count,
        autoMatting,
        ...(reference?.kind === "material" ? { referenceMaterialId: reference.id } : {}),
        ...(reference?.kind === "frame" ? { referenceFrameId: reference.id } : {}),
      });
      startPoll(jobId);
    } catch (e) {
      alert(`提交失败: ${(e as Error).message}`);
      setSubmitting(false);
    }
  };

  const okCount = items.filter((it) => it.state === "done").length;
  const errCount = items.filter((it) => it.state === "error").length;
  const jobDone = job?.status === "done";
  const jobError = job?.status === "error";

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>导入素材</h2>
          <IconBtn onClick={onClose} title="关闭">
            <X size={16} />
          </IconBtn>
        </div>

        <div className="import-tabs">
          <button
            type="button"
            className={`tab ${tab === "materials" ? "active" : ""}`}
            onClick={() => {
              setTab("materials");
              resetJob();
            }}
          >
            <Package size={14} /> 素材库
          </button>
          <button type="button" className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => { setTab("upload"); resetJob(); }}>
            <Upload size={14} /> 上传文件
          </button>
          <button type="button" className={`tab ${tab === "cli" ? "active" : ""}`} onClick={() => { setTab("cli"); resetJob(); }}>
            <Terminal size={14} /> CLI 生成
          </button>
        </div>

        {tab === "materials" && (
          <>
            {mats === null ? (
              <div className="empty">加载素材库…</div>
            ) : mats.length === 0 ? (
              <div className="empty">
                <Package size={28} />
                <p>素材库为空，先去素材库生成或上传素材</p>
                <button type="button" className="px-btn accent" onClick={goMaterials}>
                  前往素材库
                </button>
              </div>
            ) : (
              <>
                <div className="mat-pick-grid">
                  {mats.map((m) => {
                    const picked = pickedIds.includes(m.id);
                    return (
                      <div
                        key={m.id}
                        className={`mat-pick ${picked ? "on" : ""}`}
                        title={m.name}
                        onClick={() => togglePick(m.id)}
                      >
                        <img src={materialImageUrl(m.id, matV)} alt="" draggable={false} />
                        <span className={`mat-dot ${m.status}`} title={m.status === "matted" ? "已抠图" : "原图"} />
                        <span
                          className="mat-src"
                          style={{ background: themedSourceColor(SOURCE_COLORS[m.source] ?? "#888", theme) }}
                        >
                          {m.source}
                        </span>
                        <span className={`mat-check ${picked ? "on" : ""}`}>{picked && <Check size={12} />}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="up-summary">
                  已选 <span className="ok">{pickedIds.length}</span> 个素材（按点选顺序追加到时间轴末尾）
                </div>
                <div className="modal-actions">
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    className="px-btn accent"
                    disabled={pickedIds.length === 0 || submitting}
                    onClick={submitPick}
                  >
                    <Package size={14} /> {submitting ? "导入中…" : `导入选中的 ${pickedIds.length} 个素材`}
                  </motion.button>
                </div>
              </>
            )}
          </>
        )}

        {tab === "upload" && (
          <>
            <div className="form-row">
              <label>可多选：PNG/JPG 逐张成帧；GIF/MP4 拆帧（按扩展名自动分发）</label>
              <div className="file-drop" onClick={() => !submitting && fileRef.current?.click()}>
                {items.length ? `已选 ${items.length} 个文件（点击重新选择）` : "点击选择文件（可多选）"}
              </div>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                accept=".gif,.mp4,.mov,.webm,.png,.jpg,.jpeg,.webp,image/*,video/mp4,image/gif"
                onChange={(e) => {
                  setItems(Array.from(e.target.files ?? []).map((file) => ({ file, state: "pending" as FileState })));
                  setFinished(false);
                  e.target.value = "";
                }}
              />
            </div>

            {items.length > 0 && (
              <ul className="up-list">
                {items.map((it, i) => (
                  <li key={`${it.file.name}-${i}`} className="up-item">
                    <span className={`up-state ${it.state}`}>{stateIcon(it.state)}</span>
                    <span className="up-name" title={it.error ?? it.file.name}>
                      {it.file.name}
                    </span>
                    <span className="up-size">{(it.file.size / 1024).toFixed(1)} KB</span>
                  </li>
                ))}
              </ul>
            )}

            {hasVideo && (
              <div className="form-row">
                <label>MP4 抽帧帧率：{fps} fps（对全部视频文件生效）</label>
                <input type="range" min={1} max={24} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
              </div>
            )}

            <MattingOption checked={autoMatting} onChange={setAutoMatting} />

            {finished && (
              <div className="up-summary">
                成功 <span className="ok">{okCount}</span> / 失败 <span className={errCount ? "err" : ""}>{errCount}</span>
              </div>
            )}

            <div className="modal-actions">
              {finished ? (
                <button type="button" className="px-btn" onClick={onClose}>
                  完成，关闭面板
                </button>
              ) : (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn accent"
                  disabled={items.length === 0 || submitting}
                  onClick={submitUpload}
                >
                  <Upload size={14} /> {submitting ? "上传中…" : `导入 ${items.length || ""} 个文件`}
                </motion.button>
              )}
            </div>
          </>
        )}

        {tab === "cli" && (
          <>
            <div className="form-row">
              <label>提示词 Prompt</label>
              <input
                className="px-input"
                placeholder="例如：pixel art knight walking"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>帧数：{count}</label>
              <input type="range" min={1} max={16} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </div>
            <ReferencePicker value={reference} onChange={setReference} showFrames projectId={projectId} />
            <MattingOption checked={autoMatting} onChange={setAutoMatting} />
            <div className="hint">
              需在服务端配置环境变量 <code>FRAMEBAKER_GEN_CLI</code>，例如：
              <br />
              <code>{'FRAMEBAKER_GEN_CLI=\'mygen --prompt "{prompt}" --ref {reference} -o {output}\' bun dev'}</code>
              <br />
              可用占位符：{"{prompt}"} {"{output}"} {"{index}"} {"{reference}"}（选了引用图时模板必须含 {"{reference}"}）
            </div>
            <div className="modal-actions">
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn accent"
                disabled={!prompt.trim() || submitting || (job != null && !jobDone && !jobError)}
                onClick={submitGenerate}
              >
                <Terminal size={14} /> 开始生成
              </motion.button>
            </div>
          </>
        )}

        {job && tab === "cli" && (
          <div className="job-status">
            <div className="label">
              <span>任务 {job.type}</span>
              {jobDone ? (
                <span className="ok">完成 ✓</span>
              ) : jobError ? (
                <span className="err">失败 ✗</span>
              ) : (
                <span>{job.progress ?? job.status}</span>
              )}
            </div>
            <div className={`px-progress ${jobDone ? "done" : ""} ${jobError ? "error" : ""}`}>
              <div className="bar" />
            </div>
            {jobError && <div className="job-error-text">{job.error}</div>}
            {jobDone && (
              <div className="modal-actions">
                <button type="button" className="px-btn" onClick={onClose}>
                  完成，关闭面板
                </button>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
