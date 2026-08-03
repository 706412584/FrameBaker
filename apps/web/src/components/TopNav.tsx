import { Clapperboard, Package } from "lucide-react";
import ThemeToggle from "./ThemeToggle";

interface Props {
  current: "home" | "materials";
  onNav: (page: "home" | "materials") => void;
}

/** 顶部一级导航：项目 / 素材库（编辑器页有自己的顶栏，不显示本导航） */
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
      <div className="spacer" />
      <ThemeToggle />
    </nav>
  );
}
