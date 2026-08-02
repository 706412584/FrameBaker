import { useEffect, useState } from "react";
import ProjectList from "./components/ProjectList";
import Editor from "./components/Editor";
import MaterialsPage from "./components/MaterialsPage";
import TopNav from "./components/TopNav";
import { wsClient } from "./api";

type View = { page: "home" } | { page: "editor"; projectId: string } | { page: "materials" };

function viewFromLocation(): View {
  if (/^\/materials/.test(location.pathname)) return { page: "materials" };
  const m = /^\/project\/([\w-]+)/.exec(location.pathname);
  return m ? { page: "editor", projectId: m[1] } : { page: "home" };
}

export default function App() {
  const [view, setView] = useState<View>(viewFromLocation);

  useEffect(() => {
    wsClient.start();
  }, []);

  // 支持浏览器前进/后退
  useEffect(() => {
    const onPop = () => setView(viewFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav = (v: View) => {
    setView(v);
    const path = v.page === "home" ? "/" : v.page === "materials" ? "/materials" : `/project/${v.projectId}`;
    history.pushState(null, "", path);
  };

  return (
    <>
      {view.page !== "editor" && (
        <TopNav current={view.page === "materials" ? "materials" : "home"} onNav={(p) => nav({ page: p })} />
      )}
      {view.page === "home" && <ProjectList onOpen={(id) => nav({ page: "editor", projectId: id })} />}
      {view.page === "materials" && <MaterialsPage />}
      {view.page === "editor" && <Editor projectId={view.projectId} onBack={() => nav({ page: "home" })} />}
    </>
  );
}
