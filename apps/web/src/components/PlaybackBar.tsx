import type { RefObject } from "react";
import { motion, useDragControls } from "motion/react";
import { GripHorizontal, Pause, Play } from "lucide-react";
import { useT } from "../i18n";
import IconBtn from "./IconBtn";

interface Props {
  dragConstraints: RefObject<HTMLDivElement | null>;
  fps: number;
  paused: boolean;
  cursor: number;
  total: number;
  zoom: number;
  onTogglePause: () => void;
  onFpsChange: (fps: number) => void;
}

/** 播放控制条：覆盖在画布内部且可拖动（不挤占布局），仅播放时显示 */
export default function PlaybackBar({ dragConstraints, fps, paused, cursor, total, zoom, onTogglePause, onFpsChange }: Props) {
  const t = useT();
  const dragControls = useDragControls();
  return (
    <motion.div
      className="playback-bar"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.15 }}
      drag
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={dragConstraints}
      dragElastic={0}
      dragMomentum={false}
    >
      <button
        type="button"
        className="playback-drag-handle"
        title={t("msg.drag_playback_controls")}
        aria-label={t("msg.drag_playback_controls")}
        onPointerDown={(event) => dragControls.start(event)}
      >
        <GripHorizontal size={15} />
      </button>
      <IconBtn onClick={onTogglePause} title={paused ? t("msg.continue") : t("msg.pause")}>
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </IconBtn>
      <label className="fps-ctl">
        FPS
        <input type="range" min={1} max={24} value={fps} onChange={(e) => onFpsChange(Number(e.target.value))} />
        <span>{fps}</span>
      </label>
      <span className="frame-indicator">{total ? `${cursor + 1} / ${total}` : "0 / 0"}</span>
      <span className="fps-ctl" title={t("msg.toolbar_or_cmd_ctrl_wheel_to_zoom")}>{t("msg.zoom_pct", { pct: Math.round(zoom * 100) })}</span>
    </motion.div>
  );
}
