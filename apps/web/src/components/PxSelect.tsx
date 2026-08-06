import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface PxSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: PxSelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * 像素风下拉选择（替代原生 select）：
 * 按钮式触发器与 .px-input 同字体同尺寸（原生 select 不吃全局 font 继承，高度/字体总会错位的根因）；
 * 蒙层点击 / Esc 关闭，disabled 选项仅展示不可选
 */
export default function PxSelect({ value, options, onChange, placeholder = "请选择", className = "", disabled }: Props) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={`px-select ${className}${open ? " open" : ""}`}>
      <button type="button" className="px-select-btn" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span className={current ? "" : "px-select-ph"}>{current?.label ?? placeholder}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <div className="px-select-mask" onClick={() => setOpen(false)} />
          <ul className="px-select-list">
            {options.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  className={`px-select-opt${o.value === value ? " on" : ""}`}
                  disabled={o.disabled}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  {o.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
