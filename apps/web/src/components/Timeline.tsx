import { useRef } from "react";
import { Star } from "lucide-react";
import { frameImageUrl, type Frame } from "../api";
import type { FrameClickMods } from "./Editor";

interface Props {
  frames: Frame[];
  activeId: string | null;
  selectedIds: Set<string>;
  v: number;
  /** 时间轴高度（布局分隔条可调，80–320） */
  height?: number;
  onFrameClick: (id: string, mods: FrameClickMods) => void;
  onReorder: (from: number, to: number) => void;
  /** 右键菜单（Editor 统一渲染，多选内右键 = 批量操作） */
  onContextMenu: (id: string, pos: { x: number; y: number }) => void;
}

/** 底部时间轴：原生 HTML5 DnD 拖拽换序 + 多选点击 + 右键菜单 */
export default function Timeline({ frames, activeId, selectedIds, v, height, onFrameClick, onReorder, onContextMenu }: Props) {
  const dragFrom = useRef<number | null>(null);

  return (
    <footer className="timeline pixel-bar" style={height ? { height } : undefined}>
      {frames.map((f, i) => (
        <div
          key={f.id}
          className={`tl-item ${f.id === activeId ? "active" : ""} ${selectedIds.has(f.id) ? "selected" : ""}`}
          draggable
          onDragStart={(e) => {
            dragFrom.current = i;
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragFrom.current;
            dragFrom.current = null;
            if (from != null && from !== i) onReorder(from, i);
          }}
          onClick={(e) => onFrameClick(f.id, { ctrl: e.metaKey || e.ctrlKey, shift: e.shiftKey })}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(f.id, { x: e.clientX, y: e.clientY });
          }}
          title={`#${i + 1} · ${f.source}`}
        >
          <img src={frameImageUrl(f.id, v)} alt="" draggable={false} />
          {!!f.is_keyframe && <Star className="tl-kf" size={10} fill="currentColor" />}
          <span className="tl-idx">{i + 1}</span>
          {f.duration > 1 && <span className="tl-dur">×{f.duration}</span>}
        </div>
      ))}
      {frames.length === 0 && <span className="tl-empty">时间轴为空 —— 先导入素材</span>}
    </footer>
  );
}
