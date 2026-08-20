import { motion } from "motion/react";
import { Clapperboard, Package, Settings } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import LangToggle from "./LangToggle";
import NoticeHistory from "./NoticeHistory";
import { useT } from "../i18n";

interface Props {
  current: "home" | "materials" | "motions" | "settings";
  onNav: (page: "home" | "materials" | "motions" | "settings") => void;
}

/** 顶部一级导航：项目 / 素材库 / 设置；骨骼绑定与动作制作统一在骨骼项目内完成。 */
export default function TopNav({ current, onNav }: Props) {
  const t = useT();
  const tabs = [
    { id: "home" as const, icon: Clapperboard, label: t("msg.projects") },
    { id: "materials" as const, icon: Package, label: t("msg.materials") },
    { id: "settings" as const, icon: Settings, label: t("msg.settings") },
  ];

  return (
    <nav className="top-nav">
      <button type="button" className="brand" onClick={() => onNav("home")} aria-label="FrameBaker">
        <span className="brand-mark">
          <Clapperboard size={16} />
        </span>
        <span>FrameBaker</span>
      </button>
      <div className="nav-tabs">
        {tabs.map(({ id, icon: Icon, label }) => (
          <motion.button
            key={id}
            type="button"
            className={`nav-tab ${current === id ? "active" : ""}`}
            whileTap={{ scale: 0.96 }}
            onClick={() => onNav(id)}
          >
            <Icon size={14} />
            <span>{label}</span>
            {current === id && <motion.span className="nav-active-rail" layoutId="nav-active-rail" />}
          </motion.button>
        ))}
      </div>
      <div className="spacer" />
      <div className="nav-tools">
        <NoticeHistory />
        <LangToggle />
        <ThemeToggle />
      </div>
    </nav>
  );
}
