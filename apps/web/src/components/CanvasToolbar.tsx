import { useRef } from "react";
import { Crosshair, Crop, Eye, Grid3x3, ImagePlus, Minus, Plus, Star, ZoomIn, ZoomOut } from "lucide-react";
import type { Frame, FramePatch } from "../api";
import { normalizeFrameRotation } from "../frameGeometry";
import { useT } from "../i18n";
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
  /** 剪裁当前帧显示图（fetch 当前图进剪裁弹窗） */
  onCrop: (id: string) => void;
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 紧凑的变换步进器；点击数值可复位该属性 */
function TransformStepper({ label, value, disabled, onMinus, onPlus, onReset }: TransformStepperProps) {
  const t = useT();
  return (
    <span className="transform-stepper">
      <span className="transform-name">{t(label)}</span>
      <IconBtn disabled={disabled} onClick={onMinus} title={t("msg.decrease_label", { label: t(label) })}>
        <Minus size={12} />
      </IconBtn>
      <button type="button" className="transform-value" disabled={disabled} onClick={onReset} title={t("msg.reset_label", { label: t(label) })}>
        {value}
      </button>
      <IconBtn disabled={disabled} onClick={onPlus} title={t("msg.increase_label", { label: t(label) })}>
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
  onCrop,
  onPatch,
}: Props) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const editMode = mode === "edit";
  const editOnly = (key: string) =>
    editMode ? t(key) : t("msg.title_hint", { title: t(key), hint: t("msg.available_in_edit_mode") });

  return (
    <div className="toolbar pixel-bar">
      <IconBtn
        className={editMode && onion ? "on" : ""}
        disabled={!editMode}
        onClick={onToggleOnion}
        title={editOnly("msg.onion_skin_red_prev_blue_next")}
      >
        <Eye size={15} />
      </IconBtn>
      <IconBtn
        className={editMode && showGrid ? "on" : ""}
        disabled={!editMode}
        onClick={onToggleGrid}
        title={editOnly("msg.grid")}
      >
        <Grid3x3 size={15} />
      </IconBtn>
      <span className="tb-sep" />
      {/* 视图缩放：编辑/播放都作用于常驻的 Pixi viewport */}
      <IconBtn onClick={() => onZoomBy(1 / 1.25)} title={t("msg.zoom_out")}>
        <ZoomOut size={15} />
      </IconBtn>
      <button type="button" className="zoom-label zoom-reset" onClick={onZoomReset} title={t("msg.reset_100")}>
        {Math.round(zoom * 100)}%
      </button>
      <IconBtn onClick={() => onZoomBy(1.25)} title={t("msg.zoom_in")}>
        <ZoomIn size={15} />
      </IconBtn>
      <span className="tb-sep" />
      <TransformStepper
        label="transform.scale"
        value={`${Math.round((frame?.scale ?? 1) * 100)}%`}
        disabled={!editMode || !frame}
        onMinus={() => frame && onPatch(frame.id, { scale: round(clamp(frame.scale - 0.1, 0.1, 8)) })}
        onPlus={() => frame && onPatch(frame.id, { scale: round(clamp(frame.scale + 0.1, 0.1, 8)) })}
        onReset={() => frame && onPatch(frame.id, { scale: 1 })}
      />
      <TransformStepper
        label="transform.rotation"
        value={`${Math.round(((frame?.rotation ?? 0) * 180) / Math.PI)}°`}
        disabled={!editMode || !frame}
        onMinus={() => frame && onPatch(frame.id, { rotation: normalizeFrameRotation(frame.rotation - Math.PI / 12) })}
        onPlus={() => frame && onPatch(frame.id, { rotation: normalizeFrameRotation(frame.rotation + Math.PI / 12) })}
        onReset={() => frame && onPatch(frame.id, { rotation: 0 })}
      />
      <TransformStepper
        label="transform.opacity"
        value={`${Math.round((frame?.opacity ?? 1) * 100)}%`}
        disabled={!editMode || !frame}
        onMinus={() => frame && onPatch(frame.id, { opacity: round(clamp(frame.opacity - 0.1, 0, 1)) })}
        onPlus={() => frame && onPatch(frame.id, { opacity: round(clamp(frame.opacity + 0.1, 0, 1)) })}
        onReset={() => frame && onPatch(frame.id, { opacity: 1 })}
      />
      <span className="tb-sep" />
      <IconBtn disabled={!editMode || !frame} onClick={() => fileRef.current?.click()} title={editOnly("msg.replace_crop_image")}>
        <ImagePlus size={15} />
      </IconBtn>
      <IconBtn disabled={!editMode || !frame} onClick={() => frame && onCrop(frame.id)} title={editOnly("msg.crop_image")}>
        <Crop size={15} />
      </IconBtn>
      <IconBtn
        disabled={!editMode || !frame || frame.duration <= 1}
        onClick={() => frame && onPatch(frame.id, { duration: Math.max(1, frame.duration - 1) })}
        title={editOnly("msg.decrease_duration")}
      >
        <Minus size={15} />
      </IconBtn>
      <span className="dur-label">×{editMode ? (frame?.duration ?? "-") : "-"}</span>
      <IconBtn
        disabled={!editMode || !frame || frame.duration >= 60}
        onClick={() => frame && onPatch(frame.id, { duration: Math.min(60, frame.duration + 1) })}
        title={editOnly("msg.increase_duration")}
      >
        <Plus size={15} />
      </IconBtn>
      <IconBtn
        className={editMode && frame?.is_keyframe ? "on star" : ""}
        disabled={!editMode || !frame}
        onClick={() => frame && onPatch(frame.id, { is_keyframe: frame.is_keyframe ? 0 : 1 })}
        title={editOnly("msg.keyframe")}
      >
        <Star size={15} />
      </IconBtn>
      {/* 回中：把当前帧 offset 归零（编辑模式专用） */}
      <IconBtn
        disabled={!editMode || !frame || (frame.offset_x === 0 && frame.offset_y === 0)}
        onClick={() => frame && onPatch(frame.id, { offset_x: 0, offset_y: 0 })}
        title={editOnly("msg.center_on_canvas")}
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
