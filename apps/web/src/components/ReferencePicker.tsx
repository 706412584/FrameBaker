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

interface Props<T extends ReferenceSelection[] | ReferenceSelection | null> {
  value: T;
  onChange: (v: T) => void;
  /** 是否显示「项目帧」来源 Tab（仅项目编辑器的 ImportModal 为 true） */
  showFrames: boolean;
  /** showFrames=true 时用于拉取项目帧 */
  projectId?: string;
  /** 自定义标题与说明；缺省保持通用引用图文案 */
  label?: string;
  description?: string;
}

/**
 * 生成弹窗的引用图选择器：素材库 / 项目帧（可选）两个来源，最多选择 10 张。
 */
export default function ReferencePicker<T extends ReferenceSelection[] | ReferenceSelection | null>({ value, onChange, showFrames, projectId, label, description }: Props<T>) {
  const t = useT();
  const openMaterialEditor = useMaterialEditor();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"materials" | "frames">("materials");
  const [mats, setMats] = useState<Material[] | null>(null);
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [v, setV] = useState(() => Date.now());
  const multiple = Array.isArray(value);
  const selectedValues: ReferenceSelection[] = multiple ? value : value ? [value] : [];
  const emit = (items: ReferenceSelection[]) => onChange((multiple ? items : items[0] ?? null) as T);

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
    const selected = selectedValues.some((item) => item.kind === sel.kind && item.id === sel.id);
    if (selected) {
      emit(selectedValues.filter((item) => item.kind !== sel.kind || item.id !== sel.id));
      return;
    }
    if (multiple && selectedValues.length >= 10) {
      notify(t("msg.reference_images_limit"));
      return;
    }
    emit(multiple ? [...selectedValues, sel] : [sel]);
  };

  const thumb = (item: ReferenceSelection) =>
    item.kind === "material" ? materialImageUrl(item.id, v, "processed", 256) : frameImageUrl(item.id, v, 256);

  return (
    <div className="form-row">

      <label>{label ?? t("msg.reference_image_optional_template_reference")}</label>
      {description && <div className="hint">{description}</div>}
      {selectedValues.length > 0 && (
        <div className="ref-selected-list">
          {selectedValues.map((item) => (
            <div className="ref-selected" key={`${item.kind}:${item.id}`}>
              <img src={thumb(item)} alt={t("msg.reference_image")} draggable={false} loading="lazy" decoding="async" />
              <span className="ref-kind">{item.kind === "material" ? t("common.material") : t("msg.project_frames")}</span>
              {item.kind === "material" && (
                <IconBtn
                  title={t("materialEdit.action")}
                  onClick={() => openMaterialEditor({ id: item.id, name: mats?.find((m) => m.id === item.id)?.name, v, onSaved: () => setV(Date.now()) })}
                >
                  <Pencil size={14} />
                </IconBtn>
              )}
              <IconBtn title={t("msg.clear_reference")} onClick={() => pick(item)}>
                <X size={14} />
              </IconBtn>
            </div>
          ))}

        </div>
      )}
      <div className="file-drop" onClick={() => setOpen((o) => !o)}>
        <span className="ref-empty">
          <ImagePlus size={16} /> {t("msg.choose_reference")}{multiple ? ` (${selectedValues.length}/10)` : ""}
        </span>
      </div>
      {selectedValues.length > 1 && (
        <div className="hint">{t("msg.multiple_references_model_support_tip", { count: selectedValues.length })}</div>
      )}

      {open && (
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
                  <div key={m.id} className={`mat-pick ${selectedValues.some((item) => item.kind === "material" && item.id === m.id) ? "on" : ""}`} title={m.name} onClick={() => pick({ kind: "material", id: m.id })}>
                    <img src={materialImageUrl(m.id, v, "processed", 256)} alt="" draggable={false} loading="lazy" decoding="async" />
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
                <div key={f.id} className={`mat-pick ${selectedValues.some((item) => item.kind === "frame" && item.id === f.id) ? "on" : ""}`} title={`#${i + 1}`} onClick={() => pick({ kind: "frame", id: f.id })}>
                  <img src={frameImageUrl(f.id, v, 256)} alt="" draggable={false} loading="lazy" decoding="async" />
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
