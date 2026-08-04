interface Props {
  /** col = 竖分隔条（调宽度）；row = 横分隔条（调高度） */
  direction: "col" | "row";
  /** 拖动增量（px）：col 为 dx，row 为 dy（向上拖为负） */
  onDelta: (delta: number) => void;
  /** 双击恢复默认 */
  onReset: () => void;
}

/** 布局分隔条：pointer capture 拖动，拖动期间全局禁文本选择并锁定光标 */
export default function SplitDivider({ direction, onDelta, onReset }: Props) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = direction === "col" ? e.clientX : e.clientY;
    el.classList.add("dragging");
    document.body.classList.add("resizing", direction === "col" ? "resizing-col" : "resizing-row");

    const move = (ev: PointerEvent) => {
      const cur = direction === "col" ? ev.clientX : ev.clientY;
      if (cur !== last) {
        onDelta(cur - last);
        last = cur;
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      document.body.classList.remove("resizing", "resizing-col", "resizing-row");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      className={`split-divider ${direction}`}
      role="separator"
      aria-orientation={direction === "col" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      title="拖动调整大小 · 双击恢复默认"
    />
  );
}
