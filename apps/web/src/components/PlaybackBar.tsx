import { motion } from "motion/react";
import { Pause, Play } from "lucide-react";
import IconBtn from "./IconBtn";

interface Props {
  fps: number;
  paused: boolean;
  cursor: number;
  total: number;
  zoom: number;
  onTogglePause: () => void;
  onFpsChange: (fps: number) => void;
}

/** 播放控制条：覆盖在画布框内部底部的悬浮条（不挤占布局），仅播放时显示 */
export default function PlaybackBar({ fps, paused, cursor, total, zoom, onTogglePause, onFpsChange }: Props) {
  return (
    <motion.div
      className="playback-bar"
      style={{ x: "-50%" }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.15 }}
    >
      <IconBtn onClick={onTogglePause} title={paused ? "继续" : "暂停"}>
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </IconBtn>
      <label className="fps-ctl">
        FPS
        <input type="range" min={1} max={24} value={fps} onChange={(e) => onFpsChange(Number(e.target.value))} />
        <span>{fps}</span>
      </label>
      <span className="frame-indicator">{total ? `${cursor + 1} / ${total}` : "0 / 0"}</span>
      <span className="fps-ctl" title="工具栏 ± 或 Cmd/Ctrl+滚轮缩放">缩放 {Math.round(zoom * 100)}%</span>
    </motion.div>
  );
}
