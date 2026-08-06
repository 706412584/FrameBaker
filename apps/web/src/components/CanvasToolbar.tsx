import { useRef } from "react";
import { Crosshair, Eye, Grid3x3, ImagePlus, Minus, Plus, Star, ZoomIn, ZoomOut } from "lucide-react";
import type { Frame, FramePatch } from "../api";
import IconBtn from "./IconBtn";

interface Props {
  /** edit=编辑模式；preview=FrameEditor 播放模式（缩放始终控制 Pixi viewport） */
  mode: "edit" | "preview";
  onion: boolean;
  showGrid: boolean;
  zoom: number;
  frame: Frame | null;
  onToggleOnion: () => void;
  onToggleGrid: () => void;
  onZoomBy: (factor: number) => void;
  onZoomReset: () => void;
  onReplace: (id: string, file: File) => void;
  onPatch: (id: string, patch: FramePatch) => void;
}

interface TransformStepperProps {
  label: string;
  value: string;
  disabled: boolean;
  onMinus: () => void;
  onPlus: () => void;
  onReset: () => void;
}

const EDIT_ONLY_HINT = "编辑模式下可用";
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function normalizeRotation(value: number) {
  const turn = Math.PI * 2;
  return clamp(round((((value + Math.PI) % turn) + turn) % turn - Math.PI, 6), -Math.PI, Math.PI);
}

/** 紧凑的变换步进器；点击数值可复位该属性 */
function TransformStepper({ label, value, disabled, onMinus, onPlus, onReset }: TransformStepperProps) {
  return (
    <span className="transform-stepper">
      <span className="transform-name">{label}</span>
      <IconBtn disabled={disabled} onClick={onMinus} title={`${label}减少`}>
        <Minus size={12} />
      </IconBtn>
      <button type="button" className="transform-value" disabled={disabled} onClick={onReset} title={`复位${label}`}>
        {value}
      </button>
      <IconBtn disabled={disabled} onClick={onPlus} title={`${label}增加`}>
        <Plus size={12} />
      </IconBtn>
    </span>
  );
}

/** 画布工具栏：编辑/预览两种模式恒定渲染，编辑向按钮在预览模式置灰 */
export default function CanvasToolbar({
  mode,
  onion,
  showGrid,
  zoom,
  frame,
  onToggleOnion,
  onToggleGrid,
  onZoomBy,
  onZoomReset,
  onReplace,
  onPatch,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const editMode = mode === "edit";
  const editOnly = (title: string) => (editMode ? title : `${title}（${EDIT_ONLY_HINT}）`);

  return (
    <div className="toolbar pixel-bar">
      <IconBtn
        className={editMode && onion ? "on" : ""}
        disabled={!editMode}
        onClick={onToggleOnion}
        title={editOnly("洋葱皮（红=前一帧 蓝=后一帧）")}
      >
        <Eye size={15} />
      </IconBtn>
      <IconBtn
        className={editMode && showGrid ? "on" : ""}
        disabled={!editMode}
        onClick={onToggleGrid}
        title={editOnly("网格")}
      >
        <Grid3x3 size={15} />
      </IconBtn>
      <span className="tb-sep" />
      {/* 视图缩放：编辑/播放都作用于常驻的 Pixi viewport */}
      <IconBtn onClick={() => onZoomBy(1 / 1.25)} title="缩小">
        <ZoomOut size={15} />
      </IconBtn>
      <button type="button" className="zoom-label zoom-reset" onClick={onZoomReset} title="复位 100%">
        {Math.round(zoom * 100)}%
      </button>
      <IconBtn onClick={() => onZoomBy(1.25)} title="放大">
        <ZoomIn size={15} />
      </IconBtn>
      <span className="tb-sep" />
      <TransformStepper
        label="缩放"
        value={`${Math.round((frame?.scale ?? 1) * 100)}%`}
        disabled={!editMode || !frame}
        onMinus={() => frame && onPatch(frame.id, { scale: round(clamp(frame.scale - 0.1, 0.1, 8)) })}
        onPlus={() => frame && onPatch(frame.id, { scale: round(clamp(frame.scale + 0.1, 0.1, 8)) })}
        onReset={() => frame && onPatch(frame.id, { scale: 1 })}
      />
      <TransformStepper
        label="旋转"
        value={`${Math.round(((frame?.rotation ?? 0) * 180) / Math.PI)}°`}
        disabled={!editMode || !frame}
        onMinus={() => frame && onPatch(frame.id, { rotation: normalizeRotation(frame.rotation - Math.PI / 12) })}
        onPlus={() => frame && onPatch(frame.id, { rotation: normalizeRotation(frame.rotation + Math.PI / 12) })}
        onReset={() => frame && onPatch(frame.id, { rotation: 0 })}
      />
      <TransformStepper
        label="透明"
        value={`${Math.round((frame?.opacity ?? 1) * 100)}%`}
        disabled={!editMode || !frame}
        onMinus={() => frame && onPatch(frame.id, { opacity: round(clamp(frame.opacity - 0.1, 0, 1)) })}
        onPlus={() => frame && onPatch(frame.id, { opacity: round(clamp(frame.opacity + 0.1, 0, 1)) })}
        onReset={() => frame && onPatch(frame.id, { opacity: 1 })}
      />
      <span className="tb-sep" />
      <IconBtn disabled={!editMode || !frame} onClick={() => fileRef.current?.click()} title={editOnly("替换并剪裁图片")}>
        <ImagePlus size={15} />
      </IconBtn>
      <IconBtn
        disabled={!editMode || !frame || frame.duration <= 1}
        onClick={() => frame && onPatch(frame.id, { duration: Math.max(1, frame.duration - 1) })}
        title={editOnly("减少帧时长")}
      >
        <Minus size={15} />
      </IconBtn>
      <span className="dur-label">×{editMode ? (frame?.duration ?? "-") : "-"}</span>
      <IconBtn
        disabled={!editMode || !frame || frame.duration >= 60}
        onClick={() => frame && onPatch(frame.id, { duration: Math.min(60, frame.duration + 1) })}
        title={editOnly("增加帧时长")}
      >
        <Plus size={15} />
      </IconBtn>
      <IconBtn
        className={editMode && frame?.is_keyframe ? "on star" : ""}
        disabled={!editMode || !frame}
        onClick={() => frame && onPatch(frame.id, { is_keyframe: frame.is_keyframe ? 0 : 1 })}
        title={editOnly("关键帧")}
      >
        <Star size={15} />
      </IconBtn>
      {/* 回中：把当前帧 offset 归零（编辑模式专用） */}
      <IconBtn
        disabled={!editMode || !frame || (frame.offset_x === 0 && frame.offset_y === 0)}
        onClick={() => frame && onPatch(frame.id, { offset_x: 0, offset_y: 0 })}
        title={editOnly("回到画布中心")}
      >
        <Crosshair size={15} />
      </IconBtn>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && frame) onReplace(frame.id, f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
