import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Scissors, Sparkles, Upload, X } from "lucide-react";
import { api } from "../api";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { isVideoFile, useCropQueue } from "../hooks/useCropQueue";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import CropModal from "./CropModal";
import PxSelect from "./PxSelect";
import PromptEnhancer from "./PromptEnhancer";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import SizePicker from "./SizePicker";
import ReferencePicker, { type ReferenceSelection } from "./ReferencePicker";

type FileState = "pending" | "uploading" | "queued" | "done" | "error";
interface UploadItem {
  file: File;
  state: FileState;
  cropped?: boolean;
  error?: string | null;
}

interface Props {
  initialTab: "upload" | "cli";
  onClose: () => void;
  onDone: () => void;
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

/** 素材导入弹窗：上传（可多选，单图/GIF/MP4 混合）或 AI 生成，目标为 /api/materials/* */
export default function MaterialImportModal({ initialTab, onClose, onDone }: Props) {
  const t = useT();
  const [tab, setTab] = useState<"upload" | "cli">(initialTab);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [finished, setFinished] = useState(false);
  const [fps, setFps] = useState(8);
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [reference, setReference] = useState<ReferenceSelection | null>(null);
  const [count, setCount] = useState(4);
  const [mediaKind, setMediaKind] = useState<"image" | "video">("image"); // 生成内容：图片 / 视频逐帧切割
  const [videoFps, setVideoFps] = useState(8); // 视频抽帧帧率
  const [submitting, setSubmitting] = useState(false);
  const [cropDismissed, setCropDismissed] = useState(false); // 「是否需要剪裁」确认行已回答
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const cfg = useServerConfig();

  const updateItem = (index: number, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  // 剪裁队列：逐张剪裁 / 单张重裁（确认后 PNG 替换原文件并标 cropped）
  const crop = useCropQueue(items, (i, file) => updateItem(i, { file, cropped: true }));
  const imageCount = items.filter((it) => !isVideoFile(it.file)).length;

  // 上传 Tab：视频文件的 job 队列轮询（生成 Tab 不轮询——提交即关窗，由右侧任务面板跟踪）
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

  // 生成 Tab：提交即关窗，进度与结果由右侧任务面板展示
  const submitGenerate = async () => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    try {
      const providers = (cfg?.gen.providers ?? []).filter((p) => (mediaKind === "video" ? p.video : true));
      const sel = resolveProviderSelection(providers, providerId, model);
      await api.generateMaterial({
        prompt: prompt.trim(),
        count,
        autoMatting,
        ...sel,
        ...(mediaKind === "video" ? { mediaKind: "video" as const, fps: videoFps } : {}),
        ...(mediaKind === "image" && size ? { size } : {}),
        ...(mediaKind === "image" && reference?.kind === "material" ? { referenceMaterialId: reference.id } : {}),
        ...(mediaKind === "image" && reference?.kind === "frame" ? { referenceFrameId: reference.id } : {}),
      });
      notify(t("已加入任务队列，可在右侧任务面板查看进度"), "info");
      onDone();
      onClose();
    } catch (e) {
      notify(t("提交失败: {msg}", { msg: (e as Error).message }));
      setSubmitting(false);
    }
  };

  const okCount = items.filter((it) => it.state === "done").length;
  const errCount = items.filter((it) => it.state === "error").length;

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel import-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("添加素材")}</h2>
          <IconBtn onClick={onClose} title={t("关闭")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="import-tabs">
          <button type="button" className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => { setTab("upload"); resetAll(); }}>
            <Upload size={14} /> {t("上传文件")}
          </button>
          <button type="button" className={`tab ${tab === "cli" ? "active" : ""}`} onClick={() => { setTab("cli"); resetAll(); }}>
            <Sparkles size={14} /> {t("生成")}
          </button>
        </div>

        {tab === "upload" ? (
          <>
            <div className="form-row">
              <label>{t("可多选：PNG/JPG 各成 1 个素材；GIF/MP4 拆帧成多个素材（混合选择也可以）")}</label>
              <div className="file-drop" onClick={() => !submitting && fileRef.current?.click()}>
                {items.length ? t("已选 {n} 个文件（点击重新选择）", { n: items.length }) : t("点击选择文件（可多选）")}
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
                  setCropDismissed(false);
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
                    {it.cropped && <span className="up-cropped">{t("已剪裁")}</span>}
                    <span className="up-size">{(it.file.size / 1024).toFixed(1)} KB</span>
                    {!isVideoFile(it.file) && !submitting && (
                      <IconBtn className="up-crop" title={t("剪裁此图")} onClick={() => crop.startOne(i)}>
                        <Scissors size={12} />
                      </IconBtn>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {imageCount > 0 && !cropDismissed && !submitting && !finished && (
              <div className="crop-ask">
                <span>{t("{n} 张图片，导入前需要剪裁吗？（GIF/MP4 不参与）", { n: imageCount })}</span>
                <button
                  type="button"
                  className="px-btn mini"
                  onClick={() => {
                    setCropDismissed(true);
                    crop.startAll();
                  }}
                >
                  <Scissors size={12} /> {t("逐张剪裁")}
                </button>
                <button type="button" className="px-btn mini" onClick={() => setCropDismissed(true)}>
                  {t("不需要，直接导入")}
                </button>
              </div>
            )}

            {hasVideo && (
              <div className="form-row">
                <label>{t("视频抽帧帧率：{fps} fps（对全部视频文件生效）", { fps })}</label>
                <input type="range" min={1} max={24} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
              </div>
            )}

            <MattingOption checked={autoMatting} onChange={setAutoMatting} />

            {finished && (
              <div className="up-summary">
                {t("成功")} <span className="ok">{okCount}</span> / {t("失败")} <span className={errCount ? "err" : ""}>{errCount}</span>
              </div>
            )}

            <div className="modal-actions">
              {finished ? (
                <button type="button" className="px-btn" onClick={onClose}>
                  {t("完成，关闭面板")}
                </button>
              ) : (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn accent"
                  disabled={items.length === 0 || submitting}
                  onClick={submitUpload}
                >
                  <Upload size={14} /> {submitting ? t("上传中…") : t("上传 {n} 个文件", { n: items.length || "" })}
                </motion.button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="form-row">
              <label>{t("生成内容")}</label>
              <PxSelect
                value={mediaKind}
                options={[
                  { value: "image", label: t("图片（逐张生成）") },
                  { value: "video", label: t("视频（生成后逐帧切割）") },
                ]}
                onChange={(v) => setMediaKind(v as "image" | "video")}
              />
            </div>
            <PromptEnhancer
              label={t("提示词 Prompt")}
              placeholder={mediaKind === "video" ? t("例如：像素小骑士向右奔跑，循环动作") : t("例如：穿斗篷的小史莱姆，待机呼吸")}
              value={prompt}
              onChange={setPrompt}
            />
            {mediaKind === "image" ? (
              <div className="form-row">
                <label>{t("数量：{count}", { count })}</label>
                <input type="range" min={1} max={16} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </div>
            ) : (
              <div className="form-row">
                <label>{t("视频抽帧帧率：{fps} fps（生成一段视频后逐帧切割成多个素材）", { fps: videoFps })}</label>
                <input type="range" min={1} max={24} value={videoFps} onChange={(e) => setVideoFps(Number(e.target.value))} />
              </div>
            )}
            {mediaKind === "image" && <ReferencePicker value={reference} onChange={setReference} showFrames={false} />}
            <ProviderModelPicker
              providerId={providerId}
              model={model}
              onProviderChange={setProviderId}
              onModelChange={setModel}
              videoOnly={mediaKind === "video"}
            />
            {mediaKind === "image" && <SizePicker providerId={providerId} value={size} onChange={setSize} />}
            <MattingOption checked={autoMatting} onChange={setAutoMatting} />
            <div className="hint">
              {t("生成方式在「设置」页配置（CLI / OpenAI 兼容 / 百炼 / banana / MiniMax，可配多个共存；也可用环境变量")}{" "}
              <code>FRAMEBAKER_GEN_CLI</code> {t("兜底）。")}
              <br />
              {t("CLI 填命令与参数名即可（无需手写占位符；引用图需配「引用图参数名」）；API / 百炼 / banana / MiniMax 原生支持引用图")}
              <br />
              {t("视频生成仅支持 CLI / 百炼 / MiniMax（异步任务约需数分钟；CLI 产出 mp4 即自动逐帧切割）")}
            </div>
            <div className="modal-actions">
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn accent"
                disabled={!prompt.trim() || submitting}
                onClick={submitGenerate}
              >
                <Sparkles size={14} /> {t("开始生成")}
              </motion.button>
            </div>
          </>
        )}

        {/* 剪裁工具：逐张队列或单张重裁 */}
        <AnimatePresence>
          {crop.cropIndex != null && items[crop.cropIndex] && (
            <CropModal
              image={items[crop.cropIndex].file}
              title={items[crop.cropIndex].file.name}
              onConfirm={crop.confirm}
              onSkip={crop.skip}
              onConfirmAll={crop.applyRectToAll}
              onTrimAll={crop.trimAll}
              remaining={crop.total - 1}
              onClose={crop.cancel}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
