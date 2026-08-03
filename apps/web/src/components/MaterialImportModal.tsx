import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Sparkles, Upload, X } from "lucide-react";
import { api, type Job } from "../api";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import ReferencePicker, { type ReferenceSelection } from "./ReferencePicker";

type FileState = "pending" | "uploading" | "queued" | "done" | "error";
interface UploadItem {
  file: File;
  state: FileState;
  error?: string | null;
}

interface Props {
  initialTab: "upload" | "cli";
  onClose: () => void;
  onDone: () => void;
}

function isVideoFile(f: File): boolean {
  const ext = f.name.split(".").pop()?.toLowerCase();
  return ext === "gif" || ext === "mp4" || ext === "mov" || ext === "webm";
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

/** 素材导入弹窗：上传（可多选，单图/GIF/MP4 混合）或 CLI 生成，目标为 /api/materials/* */
export default function MaterialImportModal({ initialTab, onClose, onDone }: Props) {
  const [tab, setTab] = useState<"upload" | "cli">(initialTab);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [finished, setFinished] = useState(false);
  const [fps, setFps] = useState(8);
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState<ReferenceSelection | null>(null);
  const [count, setCount] = useState(4);
  const [job, setJob] = useState<Job | null>(null); // CLI 生成的单任务跟踪
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const updateItem = (index: number, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  // CLI 生成：单任务轮询
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

  // 上传 Tab：视频文件的 job 队列轮询
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

  const resetAll = () => {
    setJob(null);
    setFinished(false);
    if (pollRef.current) clearTimeout(pollRef.current);
  };

  const hasVideo = items.some((it) => isVideoFile(it.file));

  // 上传 Tab：多选逐个分发——图片直接成素材（立即完成），GIF/MP4 走 job 队列
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
        fd.append("fps", String(fps));
        fd.append("autoMatting", String(autoMatting));
        const r = await api.uploadMaterial(fd);
        if ("jobId" in r) {
          jobEntries.push({ jobId: r.jobId, index: i });
          updateItem(i, { state: "queued" });
        } else {
          updateItem(i, { state: "done" }); // 单图 → 直接生成 1 个素材
        }
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

  const submitGenerate = async () => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    resetAll();
    try {
      const { jobId } = await api.generateMaterial({
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
          <h2 style={{ flex: 1 }}>添加素材</h2>
          <IconBtn onClick={onClose} title="关闭">
            <X size={16} />
          </IconBtn>
        </div>

        <div className="import-tabs">
          <button type="button" className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => { setTab("upload"); resetAll(); }}>
            <Upload size={14} /> 上传文件
          </button>
          <button type="button" className={`tab ${tab === "cli" ? "active" : ""}`} onClick={() => { setTab("cli"); resetAll(); }}>
            <Sparkles size={14} /> CLI 生成
          </button>
        </div>

        {tab === "upload" ? (
          <>
            <div className="form-row">
              <label>可多选：PNG/JPG 各成 1 个素材；GIF/MP4 拆帧成多个素材（混合选择也可以）</label>
              <div className="file-drop" onClick={() => !submitting && fileRef.current?.click()}>
                {items.length ? `已选 ${items.length} 个文件（点击重新选择）` : "点击选择文件（可多选）"}
              </div>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,image/*,video/mp4,image/gif"
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
                <label>视频抽帧帧率：{fps} fps（对全部视频文件生效）</label>
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
                  <Upload size={14} /> {submitting ? "上传中…" : `上传 ${items.length || ""} 个文件`}
                </motion.button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="form-row">
              <label>提示词 Prompt</label>
              <input
                className="px-input"
                placeholder="例如：pixel art slime idle"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>数量：{count}</label>
              <input type="range" min={1} max={16} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </div>
            <ReferencePicker value={reference} onChange={setReference} showFrames={false} />
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
                <Sparkles size={14} /> 开始生成
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
