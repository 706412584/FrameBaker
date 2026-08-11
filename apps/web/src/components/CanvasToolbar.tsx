import { useRef } from "react";
import { Crosshair, Crop, Eye, Grid3x3, ImagePlus, Maximize2, Minus, Plus, Star, ZoomIn, ZoomOut } from "lucide-react";
import type { Frame, FramePatch } from "../api";
import { normalizeFrameRotation } from "../frameGeometry";
import { useT } from "../i18n";
import IconBtn from "./IconBtn";
import Tooltip from "./Tooltip";

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
  onFit: () => void;
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
      <Tooltip text={t("msg.decrease_label", { label: t(label) })}>
        <IconBtn disabled={disabled} onClick={onMinus}>
          <Minus size={12} />
        </IconBtn>
      </Tooltip>
      <Tooltip text={t("msg.reset_label", { label: t(label) })}>
        <button type="button" className="transform-value" disabled={disabled} onClick={onReset}>
          {value}
        </button>
      </Tooltip>
      <Tooltip text={t("msg.increase_label", { label: t(label) })}>
        <IconBtn disabled={disabled} onClick={onPlus}>
          <Plus size={12} />
        </IconBtn>
      </Tooltip>
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
  onFit,
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
      <Tooltip text={editOnly("msg.onion_skin_red_prev_blue_next")}>
        <IconBtn
          className={editMode && onion ? "on" : ""}
          disabled={!editMode}
          onClick={onToggleOnion}
        >
          <Eye size={15} />
        </IconBtn>
      </Tooltip>
      <Tooltip text={editOnly("msg.grid")}>
        <IconBtn
          className={editMode && showGrid ? "on" : ""}
          disabled={!editMode}
          onClick={onToggleGrid}
        >
          <Grid3x3 size={15} />
        </IconBtn>
      </Tooltip>
      <span className="tb-sep" />
      {/* 视图缩放：编辑/播放都作用于常驻的 Pixi viewport */}
      <Tooltip text={t("msg.zoom_out")}>
        <IconBtn onClick={() => onZoomBy(1 / 1.25)}>
          <ZoomOut size={15} />
        </IconBtn>
      </Tooltip>
      <Tooltip text={t("msg.reset_100")}>
        <button type="button" className="zoom-label zoom-reset" onClick={onZoomReset}>
          {Math.round(zoom * 100)}%
        </button>
      </Tooltip>
      <Tooltip text={t("msg.zoom_in")}>
        <IconBtn onClick={() => onZoomBy(1.25)}>
          <ZoomIn size={15} />
        </IconBtn>
      </Tooltip>
      <Tooltip text={t("msg.fit")}>
        <IconBtn onClick={onFit}>
          <Maximize2 size={15} />
        </IconBtn>
      </Tooltip>
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
      <Tooltip text={editOnly("msg.replace_crop_image")}>
        <IconBtn disabled={!editMode || !frame} onClick={() => fileRef.current?.click()}>
          <ImagePlus size={15} />
        </IconBtn>
      </Tooltip>
      <Tooltip text={editOnly("msg.crop_image")}>
        <IconBtn disabled={!editMode || !frame} onClick={() => frame && onCrop(frame.id)}>
          <Crop size={15} />
        </IconBtn>
      </Tooltip>
      <Tooltip text={editOnly("msg.decrease_duration")}>
        <IconBtn
          disabled={!editMode || !frame || frame.duration <= 1}
          onClick={() => frame && onPatch(frame.id, { duration: Math.max(1, frame.duration - 1) })}
        >
          <Minus size={15} />
        </IconBtn>
      </Tooltip>
      <span className="dur-label">×{editMode ? (frame?.duration ?? "-") : "-"}</span>
      <Tooltip text={editOnly("msg.increase_duration")}>
        <IconBtn
          disabled={!editMode || !frame || frame.duration >= 60}
          onClick={() => frame && onPatch(frame.id, { duration: Math.min(60, frame.duration + 1) })}
        >
          <Plus size={15} />
        </IconBtn>
      </Tooltip>
      <Tooltip text={editOnly("msg.keyframe")}>
        <IconBtn
          className={editMode && frame?.is_keyframe ? "on star" : ""}
          disabled={!editMode || !frame}
          onClick={() => frame && onPatch(frame.id, { is_keyframe: frame.is_keyframe ? 0 : 1 })}
        >
          <Star size={15} />
        </IconBtn>
      </Tooltip>
      {/* 回中：把当前帧 offset 归零（编辑模式专用） */}
      <Tooltip text={editOnly("msg.center_on_canvas")}>
        <IconBtn
          disabled={!editMode || !frame || (frame.offset_x === 0 && frame.offset_y === 0)}
          onClick={() => frame && onPatch(frame.id, { offset_x: 0, offset_y: 0 })}
        >
          <Crosshair size={15} />
        </IconBtn>
      </Tooltip>
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
