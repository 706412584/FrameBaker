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
    if (!(await askConfirm(t("将选中的 {n} 帧时长设为 ×{dur}？", { n: count, dur: n })))) return;
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
      <span className="batch-count">{t("已选 {count} 帧", { count })}</span>
      <span className="tb-sep" />
      <IconBtn
        className="danger"
        title={t("批量删除")}
        disabled={busy}
        onClick={() =>
          void (async () => {
            if (!(await askConfirm(t("确认删除选中的 {n} 帧？", { n: count })))) return;
            await run(onDelete);
          })()
        }
      >
        <Trash2 size={14} />
      </IconBtn>
      <IconBtn
        title={t("批量复制（各 ×1）")}
        disabled={busy}
        onClick={() =>
          void (async () => {
            if (!(await askConfirm(t("复制选中的 {n} 帧（各 ×1）？", { n: count })))) return;
            await run(onDuplicate);
          })()
        }
      >
        <Copy size={14} />
      </IconBtn>
      <IconBtn
        title={busy ? t("处理中…") : t("剪裁透明边（批量）")}
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
          {t("设时长")}
        </button>
      </span>
      <span className="tb-sep" />
      <IconBtn title={t("取消选择")} disabled={busy} onClick={onClear}>
        <X size={14} />
      </IconBtn>
    </motion.div>
  );
}
