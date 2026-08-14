import { lazy, Suspense, useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import ProjectList from "./components/ProjectList";
import MaterialsPage from "./components/MaterialsPage";
import SettingsPage from "./components/SettingsPage";
import SkeletalProjectEditor from "./components/SkeletalProjectEditor";
import TopNav from "./components/TopNav";
import AppModals from "./components/AppModals";
import JobPanel from "./components/JobPanel";
import { MaterialEditorProvider } from "./components/MaterialEditor";
import { api, wsClient, type Project } from "./api";
import { hasPixi, loadPixi } from "./pixiLoader";
import { useT } from "./i18n";

const Editor = lazy(() => import("./components/Editor"));
const MotionsPage = lazy(() => import("./components/MotionsPage"));


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


function ProjectEditorRoute({ projectId, onBack, onEditActionLibrary }: { projectId: string; onBack: () => void; onEditActionLibrary: () => void }) {
  const t = useT();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(hasPixi);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setProject(null);
    setError("");
    api.getProject(projectId).then((value) => active && setProject(value)).catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!project || project.kind === "skeletal" || ready) return;
    let alive = true;
    loadPixi()
      .then(() => alive && setReady(true))
      .catch((error) => {
        console.error(error);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [project, ready]);

  if (error) return <div className="project-route-state"><p>{t("project.loadFailed", { msg: error })}</p><button type="button" className="px-btn" onClick={onBack}>{t("msg.back_to_projects")}</button></div>;
  if (!project) return <div className="project-route-state">{t("project.loading")}</div>;
  if (project.kind === "skeletal") return <SkeletalProjectEditor project={project} onBack={onBack} onEditActionLibrary={onEditActionLibrary} />;
  if (failed) return <div className="page-loading">{t("msg.editor_engine_load_failed")}</div>;
  if (!ready) return <div className="page-loading">{t("msg.loading_editor")}</div>;
  return (
    <Suspense fallback={<div className="page-loading">{t("msg.loading_editor")}</div>}>
      <Editor projectId={projectId} onBack={onBack} />
    </Suspense>
  );

}

function MotionsRoute({ onOpenMaterials, onOpenProjects }: { onOpenMaterials: () => void; onOpenProjects: () => void }) {
  const t = useT();
  const [ready, setReady] = useState(hasPixi);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (ready) return;
    let alive = true;
    loadPixi()
      .then(() => alive && setReady(true))
      .catch((error) => {
        console.error(error);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [ready]);

  if (failed) return <div className="page-loading">{t("msg.editor_engine_load_failed")}</div>;
  if (!ready) return <div className="page-loading">{t("msg.loading_editor")}</div>;
  return (
    <Suspense fallback={<div className="page-loading">{t("msg.loading_editor")}</div>}>
      <MotionsPage onOpenMaterials={onOpenMaterials} onOpenProjects={onOpenProjects} />
    </Suspense>
  );
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

      <MaterialEditorProvider>
        {view.page !== "editor" && <TopNav current={view.page} onNav={(p) => nav({ page: p })} />}
        {view.page === "home" && <ProjectList onOpen={(id) => nav({ page: "editor", projectId: id })} />}
        {view.page === "materials" && <MaterialsPage />}
        {view.page === "motions" && <MotionsRoute onOpenMaterials={() => nav({ page: "materials" })} onOpenProjects={() => nav({ page: "home" })} />}
        {view.page === "settings" && <SettingsPage />}
        {view.page === "editor" && <ProjectEditorRoute projectId={view.projectId} onBack={() => nav({ page: "home" })} onEditActionLibrary={() => nav({ page: "motions" })} />}
        {/* 右侧常驻任务队列面板（有任务时才显示） */}
        <JobPanel syncOnEnter={view.page === "materials"} />
        {/* 全局通知条 + 确认弹窗（notice.ts） */}
        <AppModals />
      </MaterialEditorProvider>

    </MotionConfig>
  );
}
