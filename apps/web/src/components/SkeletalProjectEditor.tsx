import { ArrowLeft, Bone, Boxes, Library, Play } from "lucide-react";
import type { Project } from "../api";
import { useT } from "../i18n";

export default function SkeletalProjectEditor({ project, onBack }: { project: Project; onBack: () => void }) {
  const t = useT();

  return (
    <div className="skeletal-project-shell">
      <header className="skeletal-project-header">
        <button type="button" className="px-btn" onClick={onBack}>
          <ArrowLeft size={16} /> {t("msg.back_to_projects")}
        </button>
        <div>
          <span className="project-kind-badge skeletal">{t("project.kind.skeletal")}</span>
          <h1>{project.name}</h1>
          <p>{t("project.skeletal.subtitle")}</p>
        </div>
      </header>
      <section className="skeletal-project-welcome pixel-panel">
        <Bone size={42} />
        <div>
          <h2>{t("project.skeletal.readyTitle")}</h2>
          <p>{t("project.skeletal.readyDescription")}</p>
        </div>
        <div className="skeletal-project-steps">
          <span><Boxes size={18} /> {t("project.skeletal.step.parts")}</span>
          <span><Library size={18} /> {t("project.skeletal.step.motion")}</span>
          <span><Play size={18} /> {t("project.skeletal.step.sequence")}</span>
        </div>
      </section>
    </div>
  );
}
