import { useRef } from "react";
import { Crosshair, Eye, Grid3x3, ImagePlus, Minus, Plus, Star, ZoomIn, ZoomOut } from "lucide-react";
import type { Frame, FramePatch } from "../api";
import IconBtn from "./IconBtn";

interface Props {
  /** edit=编辑模式（控制 Pixi viewport）；preview=预览模式（控制 PreviewPlayer zoom） */
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

const EDIT_ONLY_HINT = "编辑模式下可用";

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
      {/* 缩放控件：两种模式都可用，作用于当前模式的目标（Pixi viewport / 预览播放器） */}
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
      <IconBtn disabled={!editMode || !frame} onClick={() => fileRef.current?.click()} title={editOnly("替换图片")}>
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
        accept="image/png,image/jpeg,image/webp,image/gif"
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
