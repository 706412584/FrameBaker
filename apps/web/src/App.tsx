import { useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import ProjectList from "./components/ProjectList";
import Editor from "./components/Editor";
import MaterialsPage from "./components/MaterialsPage";
import MotionsPage from "./components/MotionsPage";
import SettingsPage from "./components/SettingsPage";
import TopNav from "./components/TopNav";
import AppModals from "./components/AppModals";
import JobPanel from "./components/JobPanel";
import { wsClient } from "./api";

type View =
  | { page: "home" }
  | { page: "editor"; projectId: string }
  | { page: "materials" }
  | { page: "motions" }
  | { page: "settings" };

function viewFromLocation(): View {
  if (/^\/materials/.test(location.pathname)) return { page: "materials" };
  if (/^\/motions/.test(location.pathname)) return { page: "motions" };
  if (/^\/settings/.test(location.pathname)) return { page: "settings" };
  const m = /^\/project\/([\w-]+)/.exec(location.pathname);
  return m ? { page: "editor", projectId: m[1] } : { page: "home" };
}

export default function App() {
  const [view, setView] = useState<View>(viewFromLocation);

  useEffect(() => {
    wsClient.start();
  }, []);

  // 全局屏蔽浏览器原生右键菜单（帧项有自定义右键菜单；输入框/文本域保留原生菜单用于粘贴等）
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);

  // 支持浏览器前进/后退
  useEffect(() => {
    const onPop = () => setView(viewFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav = (v: View) => {
    setView(v);
    const path =
      v.page === "home"
        ? "/"
        : v.page === "materials"
          ? "/materials"
          : v.page === "motions"
            ? "/motions"
          : v.page === "settings"
            ? "/settings"
            : `/project/${v.projectId}`;
    history.pushState(null, "", path);
  };

  return (
    <MotionConfig reducedMotion="user">
      {view.page !== "editor" && <TopNav current={view.page} onNav={(p) => nav({ page: p })} />}
      {view.page === "home" && <ProjectList onOpen={(id) => nav({ page: "editor", projectId: id })} />}
      {view.page === "materials" && <MaterialsPage />}
      {view.page === "motions" && <MotionsPage />}
      {view.page === "settings" && <SettingsPage />}
      {view.page === "editor" && <Editor projectId={view.projectId} onBack={() => nav({ page: "home" })} />}
      {/* 右侧常驻任务队列面板（有任务时才显示） */}
      <JobPanel />
      {/* 全局通知条 + 确认弹窗（notice.ts） */}
      <AppModals />
    </MotionConfig>
  );
}
