import { useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, Trash2, X } from "lucide-react";
import IconBtn from "./IconBtn";

interface Props {
  count: number;
  onDelete: () => Promise<void>;
  onDuplicate: () => Promise<void>;
  onApplyDuration: (duration: number) => Promise<void>;
  onClear: () => void;
}

/** 多选批量操作条（>=2 帧时在编辑器顶部浮出） */
export default function BatchBar({ count, onDelete, onDuplicate, onApplyDuration, onClear }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [dur, setDur] = useState("2");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const applyDuration = () => {
    const n = Math.max(1, Math.min(60, parseInt(dur, 10) || 1));
    setDur(String(n));
    run(() => onApplyDuration(n));
  };

  return (
    <motion.div
      className="batch-bar pixel-panel"
      initial={{ opacity: 0, y: -14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ duration: 0.15 }}
    >
      <span className="batch-count">已选 {count} 帧</span>
      <span className="tb-sep" />
      {confirming ? (
        <span className="batch-confirm">
          确认删除？
          <IconBtn className="danger" title="确认删除" disabled={busy} onClick={() => run(onDelete)}>
            <Check size={14} />
          </IconBtn>
          <IconBtn title="放弃删除" disabled={busy} onClick={() => setConfirming(false)}>
            <X size={14} />
          </IconBtn>
        </span>
      ) : (
        <IconBtn className="danger" title="批量删除" disabled={busy} onClick={() => setConfirming(true)}>
          <Trash2 size={14} />
        </IconBtn>
      )}
      <IconBtn title="批量复制（各 ×1）" disabled={busy} onClick={() => run(onDuplicate)}>
        <Copy size={14} />
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
          onKeyDown={(e) => e.key === "Enter" && applyDuration()}
        />
        <button type="button" className="px-btn mini" disabled={busy} onClick={applyDuration}>
          设时长
        </button>
      </span>
      <span className="tb-sep" />
      <IconBtn title="取消选择" disabled={busy} onClick={onClear}>
        <X size={14} />
      </IconBtn>
    </motion.div>
  );
}
