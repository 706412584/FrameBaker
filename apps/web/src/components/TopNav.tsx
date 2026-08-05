import { Clapperboard, Package, Settings } from "lucide-react";
import ThemeToggle from "./ThemeToggle";

interface Props {
  current: "home" | "materials" | "settings";
  onNav: (page: "home" | "materials" | "settings") => void;
}

/** 顶部一级导航：项目 / 素材库 / 设置（编辑器页有自己的顶栏，不显示本导航） */
export default function TopNav({ current, onNav }: Props) {
  return (
    <nav className="top-nav">
      <span className="brand">FrameBaker</span>
      <button type="button" className={`nav-tab ${current === "home" ? "active" : ""}`} onClick={() => onNav("home")}>
        <Clapperboard size={14} /> 项目
      </button>
      <button
        type="button"
        className={`nav-tab ${current === "materials" ? "active" : ""}`}
        onClick={() => onNav("materials")}
      >
        <Package size={14} /> 素材库
      </button>
      <button
        type="button"
        className={`nav-tab ${current === "settings" ? "active" : ""}`}
        onClick={() => onNav("settings")}
      >
        <Settings size={14} /> 设置
      </button>
      <div className="spacer" />
      <ThemeToggle />
    </nav>
  );
}
