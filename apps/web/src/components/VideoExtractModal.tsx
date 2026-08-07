import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { EXTRACT_TIMESTAMPS_MAX } from "@framebaker/shared";
import { Film, Pause, Play, Plus, SkipBack, SkipForward, Trash2, X } from "lucide-react";
import { api, materialFileUrl, type Material } from "../api";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}

type Mark = {
  id: string;
  /** 秒 */
  t: number;
  /** 缩略图 object URL；排队中为 null */
  thumb: string | null;
};

const THUMB_MAX = 96;
let markSeq = 0;
const nextMarkId = () => `m${++markSeq}`;

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00.00";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

/** 区间 + fps → 时间点列表（含端点，去重，截断上限） */
export function fillTimestamps(start: number, end: number, fps: number): number[] {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  const step = 1 / Math.max(1, fps);
  const out: number[] = [];
  const seen = new Set<number>();
  for (let t = a; t <= b + 1e-9; t += step) {
    const key = Math.round(t * 1000);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key / 1000);
    if (out.length >= EXTRACT_TIMESTAMPS_MAX) break;
  }
  if (out.length < EXTRACT_TIMESTAMPS_MAX) {
    const endKey = Math.round(b * 1000);
    if (!seen.has(endKey)) out.push(endKey / 1000);
  }
  return out;
}

/**
 * 视频抽帧编辑器：播放/scrub 打点 + 区间 fps 快捷；
 * 缩略图串行 seek 截取（主线程，单队列）；提交只传 timestamps 给服务端。
 */
export default function VideoExtractModal({ material: m, v, onClose, onToast }: Props) {
  const t = useT();
  useModalEscClose(onClose);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [autoMatting, setAutoMatting] = useState(true);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [fillFps, setFillFps] = useState(8);
  const [submitting, setSubmitting] = useState(false);
  const [thumbPending, setThumbPending] = useState(0);

  // 串行截图队列（同时仅 1 次 seek）
  const queueRef = useRef<Array<{ id: string; t: number }>>([]);
  const busyRef = useRef(false);
  const marksRef = useRef(marks);
  marksRef.current = marks;

  const src = materialFileUrl(m.id, v, "raw");

  const revokeThumb = (url: string | null) => {
    if (url) URL.revokeObjectURL(url);
  };

  useEffect(() => {
    return () => {
      marksRef.current.forEach((mk) => revokeThumb(mk.thumb));
      queueRef.current = [];
    };
  }, []);

  const captureAt = useCallback(async (time: number): Promise<string | null> => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;

    const wasPlaying = !video.paused;
    if (wasPlaying) video.pause();

    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error("seek failed"));
      };
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onErr);
      };
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onErr);
      const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.001));
      if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
        cleanup();
        resolve();
        return;
      }
      video.currentTime = target;
    });

    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const scale = Math.min(1, THUMB_MAX / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(video, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, "image/jpeg", 0.72));
    return blob ? URL.createObjectURL(blob) : null;
  }, []);

  const pumpQueue = useCallback(async () => {
    if (busyRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      setThumbPending(0);
      return;
    }
    busyRef.current = true;
    setThumbPending(queueRef.current.length + 1);
    try {
      const url = await captureAt(next.t);
      setMarks((prev) => {
        if (!prev.some((mk) => mk.id === next.id)) {
          if (url) URL.revokeObjectURL(url);
          return prev;
        }
        return prev.map((mk) => (mk.id === next.id ? { ...mk, thumb: url } : mk));
      });
    } catch {
      /* 缩略图失败不阻断打点 */
    } finally {
      busyRef.current = false;
      setThumbPending(queueRef.current.length);
      void pumpQueue();
    }
  }, [captureAt]);

  const enqueueThumb = useCallback(
    (id: string, time: number) => {
      queueRef.current.push({ id, t: time });
      setThumbPending(queueRef.current.length + (busyRef.current ? 1 : 0));
      void pumpQueue();
    },
    [pumpQueue]
  );

  const addMarkAt = (time: number) => {
    if (marks.length >= EXTRACT_TIMESTAMPS_MAX) {
      notify(t("videoExtract.maxMarks", { n: EXTRACT_TIMESTAMPS_MAX }), "info");
      return;
    }
    const key = Math.round(time * 1000);
    if (marks.some((mk) => Math.round(mk.t * 1000) === key)) {
      notify(t("videoExtract.duplicateMark"), "info");
      return;
    }
    const id = nextMarkId();
    const tSec = key / 1000;
    setMarks((prev) => [...prev, { id, t: tSec, thumb: null }].sort((a, b) => a.t - b.t));
    enqueueThumb(id, tSec);
  };

  const removeMark = (id: string) => {
    setMarks((prev) => {
      const hit = prev.find((mk) => mk.id === id);
      revokeThumb(hit?.thumb ?? null);
      return prev.filter((mk) => mk.id !== id);
    });
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
  };

  const clearMarks = () => {
    marks.forEach((mk) => revokeThumb(mk.thumb));
    queueRef.current = [];
    setMarks([]);
    setThumbPending(0);
  };

  const fillRange = () => {
    const end = rangeEnd > 0 || duration > 0 ? (rangeEnd || duration) : duration;
    const times = fillTimestamps(rangeStart, end, fillFps);
    if (times.length === 0) return;
    clearMarks();
    const next: Mark[] = times.slice(0, EXTRACT_TIMESTAMPS_MAX).map((sec) => ({
      id: nextMarkId(),
      t: sec,
      thumb: null,
    }));
    setMarks(next);
    for (const mk of next) enqueueThumb(mk.id, mk.t);
    if (times.length >= EXTRACT_TIMESTAMPS_MAX) {
      notify(t("videoExtract.truncatedToMax", { n: EXTRACT_TIMESTAMPS_MAX }), "info");
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const seekBy = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), duration || video.duration || 0);
  };

  const onScrub = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrent(value);
  };

  const submit = async () => {
    if (marks.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api.extractMaterial(m.id, {
        timestamps: marks.map((mk) => mk.t),
        autoMatting,
        folderId: m.folder_id,
      });
      onToast(t("videoExtract.queued", { n: marks.length }));
      onClose();
    } catch (e) {
      notify(t("msg.extract_failed_msg", { msg: (e as Error).message }));
      setSubmitting(false);
    }
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}  >
      <motion.div
        className="modal pixel-panel ve-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("videoExtract.title")}</h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>
        <div className="hint">{t("videoExtract.hint", { name: m.name, max: EXTRACT_TIMESTAMPS_MAX })}</div>

        <div className="ve-player">
          <video
            ref={videoRef}
            className="ve-video"
            src={src}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration || 0;
              setDuration(d);
              setRangeEnd(d);
            }}
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        </div>

        <div className="ve-controls form-inline">
          <IconBtn onClick={() => seekBy(-1 / 12)} title={t("videoExtract.stepBack")}>
            <SkipBack size={14} />
          </IconBtn>
          <IconBtn onClick={togglePlay} title={playing ? t("msg.pause") : t("msg.continue")}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </IconBtn>
          <IconBtn onClick={() => seekBy(1 / 12)} title={t("videoExtract.stepForward")}>
            <SkipForward size={14} />
          </IconBtn>
          <input
            className="ve-scrub"
            type="range"
            min={0}
            max={duration || 0}
            step={0.001}
            value={Math.min(current, duration || 0)}
            disabled={!duration}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <span className="ve-time">
            {formatTime(current)} / {formatTime(duration)}
          </span>
          <motion.button
            type="button"
            className="px-btn accent"
            whileTap={{ scale: 0.95 }}
            disabled={submitting || marks.length >= EXTRACT_TIMESTAMPS_MAX}
            onClick={() => addMarkAt(videoRef.current?.currentTime ?? current)}
          >
            <Plus size={14} /> {t("videoExtract.mark")}
          </motion.button>
        </div>

        <div className="ve-range form-row">
          <label>{t("videoExtract.fillRange")}</label>
          <div className="form-inline ve-range-row">
            <label className="ve-num">
              <span>{t("videoExtract.start")}</span>
              <input
                className="px-input num"
                type="number"
                min={0}
                step={0.01}
                value={rangeStart}
                disabled={submitting}
                onChange={(e) => setRangeStart(Number(e.target.value))}
              />
            </label>
            <label className="ve-num">
              <span>{t("videoExtract.end")}</span>
              <input
                className="px-input num"
                type="number"
                min={0}
                step={0.01}
                value={rangeEnd}
                disabled={submitting}
                onChange={(e) => setRangeEnd(Number(e.target.value))}
              />
            </label>
            <label className="ve-num">
              <span>fps</span>
              <input
                className="px-input num"
                type="number"
                min={1}
                max={24}
                value={fillFps}
                disabled={submitting}
                onChange={(e) => setFillFps(Math.min(24, Math.max(1, Number(e.target.value) || 1)))}
              />
            </label>
            <button type="button" className="px-btn mini" disabled={submitting || !duration} onClick={fillRange}>
              {t("videoExtract.applyFill")}
            </button>
            <button type="button" className="px-btn mini" disabled={submitting} onClick={() => setRangeStart(current)}>
              {t("videoExtract.useCurrentStart")}
            </button>
            <button type="button" className="px-btn mini" disabled={submitting} onClick={() => setRangeEnd(current)}>
              {t("videoExtract.useCurrentEnd")}
            </button>
          </div>
        </div>

        <div className="form-row">
          <label>
            {t("videoExtract.marks", { n: marks.length, max: EXTRACT_TIMESTAMPS_MAX })}
            {thumbPending > 0 ? ` · ${t("videoExtract.thumbQueue", { n: thumbPending })}` : ""}
          </label>
          <div className="ve-marks">
            {marks.length === 0 ? (
              <span className="hint">{t("videoExtract.marksEmpty")}</span>
            ) : (
              marks.map((mk, i) => (
                <div key={mk.id} className="ve-mark" title={formatTime(mk.t)}>
                  <button type="button" className="ve-mark-thumb" disabled={submitting} onClick={() => onScrub(mk.t)}>
                    {mk.thumb ? <img src={mk.thumb} alt="" draggable={false} /> : <span className="ve-mark-ph">…</span>}
                  </button>
                  <span className="ve-mark-i">{i + 1}</span>
                  <span className="ve-mark-t">{formatTime(mk.t)}</span>
                  <IconBtn disabled={submitting} onClick={() => removeMark(mk.id)} title={t("common.delete")}>
                    <X size={12} />
                  </IconBtn>
                </div>
              ))
            )}
          </div>
          {marks.length > 0 && (
            <button type="button" className="px-btn mini" disabled={submitting} onClick={clearMarks}>
              <Trash2 size={12} /> {t("common.clear")}
            </button>
          )}
        </div>

        <MattingOption checked={autoMatting} onChange={setAutoMatting} />

        <div className="modal-actions">
          <motion.button
            type="button"
            className="px-btn accent"
            whileTap={{ scale: 0.95 }}
            disabled={marks.length === 0 || submitting}
            onClick={() => void submit()}
          >
            <Film size={14} /> {submitting ? t("common.submitting") : t("videoExtract.submit", { n: marks.length })}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
