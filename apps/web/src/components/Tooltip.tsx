import { cloneElement, isValidElement, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactElement, ReactNode } from "react";

let tipId = 0;

/**
 * 轻量 tooltip：包裹任意元素，hover 后短延迟（默认 150ms）显示提示。
 * 用 fixed 定位 + portal 到 body，不受父容器 overflow 裁切。
 */
export default function Tooltip({
  text,
  delay = 150,
  children,
}: {
  text: string;
  delay?: number;
  children: ReactElement<{ onMouseEnter?: (e: MouseEvent) => void; onMouseLeave?: () => void }>;
}) {
  const [visible, setVisible] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const timer = useRef<number | undefined>(undefined);
  const id = useRef(`tip-${++tipId}`);

  if (!text || !isValidElement(children)) return <>{children as ReactNode}</>;

  const handleEnter = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    setStyle({
      position: "fixed",
      left: rect.left + rect.width / 2,
      top: rect.bottom + 6,
      transform: "translateX(-50%)",
    });
    timer.current = window.setTimeout(() => setVisible(true), delay);
  };

  const handleLeave = () => {
    window.clearTimeout(timer.current);
    setVisible(false);
  };

  return (
    <>
      {cloneElement(children, { onMouseEnter: handleEnter, onMouseLeave: handleLeave })}
      {visible &&
        createPortal(
          <div id={id.current} className="tip" style={style} role="tooltip">
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
