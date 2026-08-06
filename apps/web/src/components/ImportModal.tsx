import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Package, Scissors, Search, Sparkles, Upload, X } from "lucide-react";
import { SOURCE_COLORS } from "@framebaker/shared";
import { api, materialImageUrl, type Material } from "../api";
import { useServerConfig } from "../config";
import { isVideoFile, useCropQueue } from "../hooks/useCropQueue";
import { notify } from "../notice";
import { themedSourceColor, useTheme } from "../theme";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import CropModal from "./CropModal";
import PxSelect from "./PxSelect";
import PromptEnhancer from "./PromptEnhancer";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import SizePicker from "./SizePicker";
import ReferencePicker, { type ReferenceSelection } from "./ReferencePicker";

type Tab = "materials" | "upload" | "cli";

type FileState = "pending" | "uploading" | "queued" | "done" | "error";
interface UploadItem {
  file: File;
  state: FileState;
  cropped?: boolean;
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
  const [matQuery, setMatQuery] = useState(""); // 素材搜索（name + prompt 本地过滤）
  // 上传 Tab：多文件逐个分发
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
  const [mediaKind, setMediaKind] = useState<"image" | "video">("image"); // 生成内容：图片逐帧 / 视频逐帧切割
  const [videoFps, setVideoFps] = useState(8); // 视频抽帧帧率
  const [submitting, setSubmitting] = useState(false);
  const [cropDismissed, setCropDismissed] = useState(false); // 「是否需要剪裁」确认行已回答
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const theme = useTheme();
  const cfg = useServerConfig();

  // 打开素材库 Tab 时加载素材列表
  useEffect(() => {
    if (tab === "materials" && mats === null) {
      api
        .listMaterials()
        .then((list) => {
          setMats(list);
          setMatV(Date.now());
        })
        .catch((e) => notify(`加载素材库失败: ${e.message}`));
    }
  }, [tab, mats]);

  const updateItem = (index: number, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  // 剪裁队列：逐张剪裁 / 单张重裁（确认后 PNG 替换原文件并标 cropped）
  const crop = useCropQueue(items, (i, file) => updateItem(i, { file, cropped: true }));
  const imageCount = items.filter((it) => !isVideoFile(it.file)).length;

  // 多任务轮询（上传 Tab）：全部结束后汇总（生成 Tab 不轮询——提交即关窗，由右侧任务面板跟踪）
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

  const resetProgress = () => {
    setFinished(false);
    if (pollRef.current) clearTimeout(pollRef.current);
  };

  // ---- 素材库 Tab ----
  const togglePick = (id: string) => {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // 搜索过滤：不影响已选（过滤掉的仍保留在 pickedIds）
  const q = matQuery.trim().toLowerCase();
  const filteredMats = (mats ?? []).filter((m) => {
    if (!q) return true;
    const prompt = typeof m.metadata.prompt === "string" ? m.metadata.prompt : "";
    return m.name.toLowerCase().includes(q) || prompt.toLowerCase().includes(q);
  });

  const submitPick = async () => {
    if (pickedIds.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api.batchImportMaterials(pickedIds, projectId);
      onDone(); // 刷新帧列表（WS 也会广播 frames_changed）
      onClose();
    } catch (e) {
      notify(`导入失败: ${(e as Error).message}`);
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

  // ---- 生成 Tab：提交即关窗，进度与结果由右侧任务面板展示 ----
  const submitGenerate = async () => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    try {
      const providers = (cfg?.gen.providers ?? []).filter((p) => (mediaKind === "video" ? p.video : true));
      const sel = resolveProviderSelection(providers, providerId, model);
      await api.generate({
        projectId,
        prompt: prompt.trim(),
        count,
        autoMatting,
        ...sel,
        ...(mediaKind === "video" ? { mediaKind: "video" as const, fps: videoFps } : {}),
        ...(mediaKind === "image" && size ? { size } : {}),
        ...(mediaKind === "image" && reference?.kind === "material" ? { referenceMaterialId: reference.id } : {}),
        ...(mediaKind === "image" && reference?.kind === "frame" ? { referenceFrameId: reference.id } : {}),
      });
      notify("已加入任务队列，可在右侧任务面板查看进度", "info");
      onDone();
      onClose();
    } catch (e) {
      notify(`提交失败: ${(e as Error).message}`);
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
              resetProgress();
            }}
          >
            <Package size={14} /> 素材库
          </button>
          <button type="button" className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => { setTab("upload"); resetProgress(); }}>
            <Upload size={14} /> 上传文件
          </button>
          <button type="button" className={`tab ${tab === "cli" ? "active" : ""}`} onClick={() => { setTab("cli"); resetProgress(); }}>
            <Sparkles size={14} /> 生成
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
                <div className="mat-search">
                  <Search size={14} />
                  <input
                    className="px-input"
                    placeholder="搜索素材名 / prompt"
                    value={matQuery}
                    onChange={(e) => setMatQuery(e.target.value)}
                  />
                </div>
                {filteredMats.length === 0 ? (
                  <div className="empty">无匹配素材</div>
                ) : (
                <div className="mat-pick-grid">
                  {filteredMats.map((m) => {
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
                )}
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
                    {it.cropped && <span className="up-cropped">已剪裁</span>}
                    <span className="up-size">{(it.file.size / 1024).toFixed(1)} KB</span>
                    {!isVideoFile(it.file) && !submitting && (
                      <IconBtn className="up-crop" title="剪裁此图" onClick={() => crop.startOne(i)}>
                        <Scissors size={12} />
                      </IconBtn>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {imageCount > 0 && !cropDismissed && !submitting && !finished && (
              <div className="crop-ask">
                <span>{imageCount} 张图片，导入前需要剪裁吗？（GIF/MP4 不参与）</span>
                <button
                  type="button"
                  className="px-btn mini"
                  onClick={() => {
                    setCropDismissed(true);
                    crop.startAll();
                  }}
                >
                  <Scissors size={12} /> 逐张剪裁
                </button>
                <button type="button" className="px-btn mini" onClick={() => setCropDismissed(true)}>
                  不需要，直接导入
                </button>
              </div>
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
              <label>生成内容</label>
              <PxSelect
                value={mediaKind}
                options={[
                  { value: "image", label: "图片（逐帧生成）" },
                  { value: "video", label: "视频（生成后逐帧切割）" },
                ]}
                onChange={(v) => setMediaKind(v as "image" | "video")}
              />
            </div>
            <PromptEnhancer
              label="提示词 Prompt"
              placeholder={mediaKind === "video" ? "例如：像素小骑士向右奔跑，循环动作" : "例如：持剑的小骑士，向右走路循环"}
              value={prompt}
              onChange={setPrompt}
            />
            {mediaKind === "image" ? (
              <div className="form-row">
                <label>帧数：{count}</label>
                <input type="range" min={1} max={16} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </div>
            ) : (
              <div className="form-row">
                <label>视频抽帧帧率：{videoFps} fps（生成一段视频后逐帧切割入库）</label>
                <input type="range" min={1} max={24} value={videoFps} onChange={(e) => setVideoFps(Number(e.target.value))} />
              </div>
            )}
            {mediaKind === "image" && (
              <ReferencePicker value={reference} onChange={setReference} showFrames projectId={projectId} />
            )}
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
              生成方式在「设置」页配置（CLI / OpenAI 兼容 / 百炼 / banana / MiniMax，可配多个共存；也可用环境变量{" "}
              <code>FRAMEBAKER_GEN_CLI</code> 兜底）。
              <br />
              CLI 填命令与参数名即可（无需手写占位符；引用图需配「引用图参数名」）；API / 百炼 / banana / MiniMax
              原生支持引用图
              <br />
              视频生成仅支持 CLI / 百炼 / MiniMax（异步任务约需数分钟；CLI 产出 mp4 即自动逐帧切割）
            </div>
            <div className="modal-actions">
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn accent"
                disabled={!prompt.trim() || submitting}
                onClick={submitGenerate}
              >
                <Sparkles size={14} /> 开始生成
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
