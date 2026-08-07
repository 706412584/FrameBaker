import { useState } from "react";
import { motion } from "motion/react";
import { Copy, Scan, Trash2, X } from "lucide-react";
import { useT } from "../i18n";
import { askConfirm } from "../notice";
import IconBtn from "./IconBtn";

interface Props {
  count: number;
  onDelete: () => Promise<void>;
  onDuplicate: () => Promise<void>;
  onApplyDuration: (duration: number) => Promise<void>;
  /** 批量裁掉选中帧的透明边（逐帧 replace，单帧失败不阻塞其余） */
  onTrim: () => Promise<void>;
  onClear: () => void;
}

/** 多选批量操作条（>=2 帧时在编辑器顶部浮出）；危险/变更类操作均走二次确认 */
export default function BatchBar({ count, onDelete, onDuplicate, onApplyDuration, onTrim, onClear }: Props) {
  const [dur, setDur] = useState("2");
  const [busy, setBusy] = useState(false);
  const t = useT();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const applyDuration = async () => {
    const n = Math.max(1, Math.min(60, parseInt(dur, 10) || 1));
    setDur(String(n));
    if (!(await askConfirm(t("msg.set_duration_of_n_frames_to_dur", { n: count, dur: n })))) return;
    await run(() => onApplyDuration(n));
  };

  return (
    <motion.div
      className="batch-bar pixel-panel"
      initial={{ opacity: 0, y: -14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ duration: 0.15 }}
    >
      <span className="batch-count">{t("msg.count_frames_selected", { count })}</span>
      <span className="tb-sep" />
      <IconBtn
        className="danger"
        title={t("msg.batch_delete")}
        disabled={busy}
        onClick={() =>
          void (async () => {
            if (!(await askConfirm(t("msg.delete_n_selected_frames", { n: count })))) return;
            await run(onDelete);
          })()
        }
      >
        <Trash2 size={14} />
      </IconBtn>
      <IconBtn
        title={t("msg.batch_duplicate_1_each")}
        disabled={busy}
        onClick={() =>
          void (async () => {
            if (!(await askConfirm(t("msg.duplicate_n_selected_frames_1_each", { n: count })))) return;
            await run(onDuplicate);
          })()
        }
      >
        <Copy size={14} />
      </IconBtn>
      <IconBtn
        title={busy ? t("msg.processing_1cac8a") : t("msg.trim_transparent_edges_batch")}
        disabled={busy}
        onClick={() => void run(onTrim)}
      >
        <Scan size={14} />
      </IconBtn>
      <span className="tb-sep" />
      <span className="batch-dur">
        <input
          className="px-input num"
          type="number"
          min={1}
          max={60}
          value={dur}
          onChange={(e) => setDur(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void applyDuration()}
        />
        <button type="button" className="px-btn mini" disabled={busy} onClick={() => void applyDuration()}>
          {t("msg.set_duration")}
        </button>
      </span>
      <span className="tb-sep" />
      <IconBtn title={t("msg.clear_selection")} disabled={busy} onClick={onClear}>
        <X size={14} />
      </IconBtn>
    </motion.div>
  );
}
