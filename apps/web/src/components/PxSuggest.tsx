import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

interface Props {
  value: string;
  /** 建议项（可自由输入，不限于列表） */
  suggestions: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * 带主题化建议下拉的输入框（替代原生 datalist——原生弹层不吃主题样式）：
 * 输入时按子串过滤建议；聚焦/点箭头展开全部；蒙层点击 / Esc 关闭；点建议项回填
 */
export default function PxSuggest({ value, suggestions, onChange, placeholder, className = "" }: Props) {
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const list = q ? suggestions.filter((s) => s.toLowerCase().includes(q)) : suggestions;
    return list.filter((s) => s !== value); // 已完全一致的建议不再占位
  }, [value, suggestions]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={`px-suggest ${className}`}>
      <input
        className="px-input"
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
      />
      <button
        type="button"
        className="px-suggest-toggle"
        title="展开建议"
        tabIndex={-1}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={14} />
      </button>
      {open && filtered.length > 0 && (
        <>
          <div className="px-select-mask" onClick={() => setOpen(false)} />
          <ul className="px-select-list">
            {filtered.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className="px-select-opt"
                  onClick={() => {
                    onChange(s);
                    setOpen(false);
                  }}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
