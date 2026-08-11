import { motion } from "motion/react";
import { ArrowDownToLine, Copy, Star, Trash2 } from "lucide-react";
import { SOURCE_COLORS } from "@framebaker/shared";
import { frameImageUrl, type Frame, type FramePatch } from "../api";
import { themedSourceColor, useTheme } from "../theme";
import { useT } from "../i18n";
import type { FrameClickMods } from "./Editor";
import IconBtn from "./IconBtn";

interface Props {
  frames: Frame[];
  activeId: string | null;
  selectedIds: Set<string>;
  v: number;
  /** 面板宽度（布局分隔条可调，180–480） */
  width?: number;
  onFrameClick: (id: string, mods: FrameClickMods) => void;
  onClearSelection: () => void;
  onPatch: (id: string, patch: FramePatch) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** 右键菜单（Editor 统一渲染，多选内右键 = 批量操作） */
  onContextMenu: (id: string, pos: { x: number; y: number }) => void;
}

const isMac = /macintosh|mac os/i.test(navigator.userAgent);

export default function FrameList({
  frames,
  activeId,
  selectedIds,
  v,
  width,
  onFrameClick,
  onClearSelection,
  onPatch,
  onDuplicate,
  onDelete,
  onContextMenu,
}: Props) {
  const theme = useTheme();
  const t = useT();
  return (
    <aside className="frame-list pixel-panel" style={width ? { width } : undefined}>
      <div className="fl-title">{t("timeline.framePool")}</div>
      <div className="fl-usage"><ArrowDownToLine size={15}/><span>{t("timeline.framePoolHint", { key: isMac ? "Cmd" : "Ctrl" })}</span></div>
      <div className="fl-hint">{t("msg.key_click_multi_select_shift_click_range_right_click_men", { key: isMac ? "Cmd" : "Ctrl" })}</div>
      <div
        className="fl-scroll"
        onClick={(e) => {
          // 点击列表空白处清空多选
          if (e.target === e.currentTarget) onClearSelection();
        }}
      >
        {frames.map((f, i) => (
          <motion.div
            key={f.id}
            className={`fl-item ${f.id === activeId ? "active" : ""} ${selectedIds.has(f.id) ? "selected" : ""}`}
            style={{ borderLeftColor: themedSourceColor(SOURCE_COLORS[f.source] ?? "#888", theme) }}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            draggable
            onDragStartCapture={(e: React.DragEvent<HTMLDivElement>) => {
              // 多选拖拽：拖一组选中帧（按显示顺序，保证动画序列正确）；否则只拖当前帧。资产帧入轨为 copy
              const group = selectedIds.has(f.id) && selectedIds.size > 1
                ? frames.filter((x) => selectedIds.has(x.id)).map((x) => x.id)
                : [f.id];
              e.dataTransfer.effectAllowed = "copy";
              e.dataTransfer.setData("application/x-framebaker-frame-cell", JSON.stringify({ frameIds: group, copy: true }));
            }}
            onClick={(e) => onFrameClick(f.id, { ctrl: e.metaKey || e.ctrlKey, shift: e.shiftKey })}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(f.id, { x: e.clientX, y: e.clientY });
            }}
          >
            <img src={frameImageUrl(f.id, v)} alt="" draggable={false} />
            <div className="fl-meta">
              <span>#{i + 1}</span>
              {f.status !== "ready" && <span className="fl-status">{f.status}</span>}
            </div>
            <div className="fl-ops">
              <IconBtn
                title={t("msg.duplicate_frame")}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  onDuplicate(f.id);
                }}
              >
                <Copy size={12} />
              </IconBtn>
              <IconBtn
                title={t("msg.delete_frame")}
                className="danger"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  onDelete(f.id);
                }}
              >
                <Trash2 size={12} />
              </IconBtn>
              <IconBtn
                title={f.is_keyframe ? t("msg.unmark_keyframe") : t("msg.mark_keyframe")}
                className={f.is_keyframe ? "star-on" : ""}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  onPatch(f.id, { is_keyframe: f.is_keyframe ? 0 : 1 });
                }}
              >
                <Star size={12} />
              </IconBtn>
            </div>
          </motion.div>
        ))}
        {frames.length === 0 && <div className="fl-empty">{t("msg.no_frames")}</div>}
      </div>
    </aside>
  );
}
