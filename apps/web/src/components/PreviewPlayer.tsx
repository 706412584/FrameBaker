import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { frameImageUrl, type Frame } from "../api";
import IconBtn from "./IconBtn";

interface Props {
  frames: Frame[];
  v: number;
  /** 受控缩放（工具栏在 Editor 层，25%–400%），乘在 contain-fit 与帧 transform 之上 */
  zoom: number;
  /** 供 Cmd/Ctrl+滚轮缩放回调 */
  onZoomBy: (factor: number) => void;
}

/**
 * 播放预览：按 fps tick 推进，每帧停留 duration 个 tick。
 * 舞台尺寸恒定（跟随布局，overflow hidden），帧图 object-fit: contain 居中不溢出；
 * 应用帧编辑属性（offset/scale/rotation/opacity）与受控 zoom，与编辑器画布语义一致；
 * 播放中缩放立即生效且不打断计时器（zoom 不在计时器依赖里）。
 */
export default function PreviewPlayer({ frames, v, zoom, onZoomBy }: Props) {
  const [fps, setFps] = useState(8);
  const [playing, setPlaying] = useState(true);
  const [cursor, setCursor] = useState(0);
  const tick = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const onZoomByRef = useRef(onZoomBy);
  onZoomByRef.current = onZoomBy;

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = setInterval(() => {
      tick.current += 1;
      const dur = Math.max(1, frames[cursor]?.duration ?? 1);
      if (tick.current >= dur) {
        tick.current = 0;
        setCursor((c) => (c + 1) % frames.length);
      }
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [playing, fps, frames, cursor]);

  // 帧数变化时防止越界
  useEffect(() => {
    if (cursor >= frames.length) {
      setCursor(0);
      tick.current = 0;
    }
  }, [frames.length, cursor]);

  // Cmd/Ctrl+滚轮缩放（原生监听，preventDefault 阻止页面缩放/滚动）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      onZoomByRef.current(e.deltaY < 0 ? 1.25 : 1 / 1.25);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const cur = frames[cursor];

  return (
    <div className="preview">
      <div className="preview-stage" ref={stageRef}>
        {cur ? (
          <img
            key={cur.id}
            src={frameImageUrl(cur.id, v)}
            alt=""
            draggable={false}
            style={{
              // 以舞台中心为基准应用帧属性（rotation 为弧度）；zoom 等比叠加在 offset 与 scale 上
              transform: `translate(${cur.offset_x * zoom}px, ${cur.offset_y * zoom}px) rotate(${cur.rotation}rad) scale(${cur.scale * zoom})`,
              opacity: cur.opacity,
            }}
          />
        ) : (
          <div className="canvas-empty">暂无帧</div>
        )}
      </div>
      <div className="preview-bar pixel-bar">
        <IconBtn onClick={() => setPlaying((p) => !p)} title={playing ? "暂停" : "播放"}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </IconBtn>
        <label className="fps-ctl">
          FPS
          <input type="range" min={1} max={24} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
          <span>{fps}</span>
        </label>
        <span className="frame-indicator">{frames.length ? `${cursor + 1} / ${frames.length}` : "0 / 0"}</span>
        <span className="fps-ctl" title="Cmd/Ctrl+滚轮也可缩放">缩放 {Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
