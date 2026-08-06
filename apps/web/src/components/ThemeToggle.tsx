import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cycleThemeMode, getThemeMode, onThemeChange, type ThemeMode } from "../theme";
import { useT } from "../i18n";

const MODE_META: Record<ThemeMode, { label: string; Icon: typeof Sun }> = {
  system: { label: "跟随系统", Icon: Monitor },
  light: { label: "浅色", Icon: Sun },
  dark: { label: "深色", Icon: Moon },
};

/** 主题切换按钮：三态循环（跟随系统 → 浅色 → 深色） */
export default function ThemeToggle() {
  const t = useT();
  // 主题（含系统主题变化）会影响 system 模式下的解析结果，借此触发重渲染
  const [mode, setMode] = useState<ThemeMode>(getThemeMode);
  useEffect(() => onThemeChange(() => setMode(getThemeMode())), []);

  const { label, Icon } = MODE_META[mode];
  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.12 }}
      whileTap={{ scale: 0.85, rotate: -20 }}
      className="icon-btn"
      onClick={() => {
        cycleThemeMode();
        setMode(getThemeMode());
      }}
      title={t("主题：{label}（点击切换）", { label: t(label) })}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={mode}
          initial={{ rotate: -90, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          exit={{ rotate: 90, opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ display: "inline-flex" }}
        >
          <Icon size={16} />
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
