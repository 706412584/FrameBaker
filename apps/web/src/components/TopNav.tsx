import { Clapperboard, Package, Settings } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import LangToggle from "./LangToggle";
import NoticeHistory from "./NoticeHistory";
import { useT } from "../i18n";

interface Props {
  current: "home" | "materials" | "settings";
  onNav: (page: "home" | "materials" | "settings") => void;
}

/** 顶部一级导航：项目 / 素材库 / 设置（编辑器页有自己的顶栏，不显示本导航） */
export default function TopNav({ current, onNav }: Props) {
  const t = useT();
  return (
    <nav className="top-nav">
      <span className="brand">FrameBaker</span>
      <button type="button" className={`nav-tab ${current === "home" ? "active" : ""}`} onClick={() => onNav("home")}>
        <Clapperboard size={14} /> {t("项目")}
      </button>
      <button
        type="button"
        className={`nav-tab ${current === "materials" ? "active" : ""}`}
        onClick={() => onNav("materials")}
      >
        <Package size={14} /> {t("素材库")}
      </button>
      <button
        type="button"
        className={`nav-tab ${current === "settings" ? "active" : ""}`}
        onClick={() => onNav("settings")}
      >
        <Settings size={14} /> {t("设置")}
      </button>
      <div className="spacer" />
      <NoticeHistory />
      <LangToggle />
      <ThemeToggle />
    </nav>
  );
}
