import { useEffect, useState } from "react";
import { ImagePlus, Pencil, X } from "lucide-react";
import { api, frameImageUrl, materialImageUrl, type Frame, type Material } from "../api";
import { useT } from "../i18n";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import { useMaterialEditor } from "./MaterialEditor";

export interface ReferenceSelection {
  kind: "material" | "frame";
  id: string;
}

interface Props {
  value: ReferenceSelection | null;
  onChange: (v: ReferenceSelection | null) => void;
  /** 是否显示「项目帧」来源 Tab（仅项目编辑器的 ImportModal 为 true） */
  showFrames: boolean;
  /** showFrames=true 时用于拉取项目帧 */
  projectId?: string;
}

/**
 * 生成弹窗的引用图选择器：素材库 / 项目帧（可选）两个来源，网格单选。
 * 选中显示缩略图 + 清除按钮。
 */
export default function ReferencePicker({ value, onChange, showFrames, projectId }: Props) {
  const t = useT();
  const openMaterialEditor = useMaterialEditor();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"materials" | "frames">("materials");
  const [mats, setMats] = useState<Material[] | null>(null);
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [v, setV] = useState(() => Date.now());

  // 展开时按 Tab 懒加载
  useEffect(() => {
    if (!open) return;
    if (tab === "materials" && mats === null) {
      api.listMaterials().then(setMats).catch((e) => notify(t("msg.load_materials_failed_msg", { msg: (e as Error).message })));
    }
    if (tab === "frames" && frames === null && projectId) {
      api.getFrames(projectId).then(setFrames).catch((e) => notify(t("msg.load_frames_failed_msg", { msg: (e as Error).message })));
    }
  }, [open, tab, mats, frames, projectId]);

  const pick = (sel: ReferenceSelection) => {
    onChange(sel);
    setOpen(false);
  };

  const thumb =
    value == null ? null : value.kind === "material" ? materialImageUrl(value.id, v) : frameImageUrl(value.id, v);

  return (
    <div className="form-row">
      <label>{t("msg.reference_image_optional_template_reference")}</label>
      {value == null ? (
        <div className="file-drop" onClick={() => setOpen((o) => !o)}>
          <span className="ref-empty">
            <ImagePlus size={16} /> {t("msg.choose_reference")}
          </span>
        </div>
      ) : (
        <div className="ref-selected">
          <img src={thumb!} alt={t("msg.reference_image")} draggable={false} />
          <span className="ref-kind">{value.kind === "material" ? t("common.material") : t("msg.project_frames")}</span>
          {value.kind === "material" && (
            <IconBtn
              title={t("materialEdit.action")}
              onClick={() => openMaterialEditor({ id: value.id, name: mats?.find((m) => m.id === value.id)?.name, v, onSaved: () => setV(Date.now()) })}
            >
              <Pencil size={14} />
            </IconBtn>
          )}
          <IconBtn title={t("msg.clear_reference")} onClick={() => onChange(null)}>
            <X size={14} />
          </IconBtn>
        </div>
      )}

      {open && value == null && (
        <div className="ref-panel">
          <div className="import-tabs">
            <button type="button" className={`tab ${tab === "materials" ? "active" : ""}`} onClick={() => setTab("materials")}>
              {t("msg.materials")}
            </button>
            {showFrames && (
              <button type="button" className={`tab ${tab === "frames" ? "active" : ""}`} onClick={() => setTab("frames")}>
                {t("msg.project_frames")}
              </button>
            )}
          </div>
          <div className="mat-pick-grid ref-grid">
            {tab === "materials" ? (
              mats === null ? (
                <div className="empty">{t("msg.loading")}</div>
              ) : mats.length === 0 ? (
                <div className="empty">{t("msg.materials_empty")}</div>
              ) : (
                mats.map((m) => (
                  <div key={m.id} className="mat-pick" title={m.name} onClick={() => pick({ kind: "material", id: m.id })}>
                    <img src={materialImageUrl(m.id, v)} alt="" draggable={false} />
                    <span className={`mat-dot ${m.status}`} />
                    {m.kind !== "video" && (
                      <IconBtn
                        className="mat-pick-edit"
                        title={t("materialEdit.action")}
                        onClick={(event) => {
                          event.stopPropagation();
                          openMaterialEditor({ id: m.id, name: m.name, v, onSaved: () => setV(Date.now()) });
                        }}
                      >
                        <Pencil size={12} />
                      </IconBtn>
                    )}
                  </div>
                ))
              )
            ) : frames === null ? (
              <div className="empty">{t("msg.loading")}</div>
            ) : frames.length === 0 ? (
              <div className="empty">{t("msg.project_has_no_frames")}</div>
            ) : (
              frames.map((f, i) => (
                <div key={f.id} className="mat-pick" title={`#${i + 1}`} onClick={() => pick({ kind: "frame", id: f.id })}>
                  <img src={frameImageUrl(f.id, v)} alt="" draggable={false} />
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
