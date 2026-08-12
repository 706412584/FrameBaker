import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { PersonStanding, Plus, X } from "lucide-react";
import {
  ACTION_PRESETS,
  ACTION_SHEET_MAX_FRAMES,
  ACTION_VIDEO_MAX_ACTIONS,
  buildActionSheetPrompt,
  buildActionVideoPrompt,
  suggestActionSheetGrid,
  type ActionPresetId,
} from "@framebaker/shared";
import { api, materialImageUrl, type Material } from "../api";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import PxSelect from "./PxSelect";
import SizePicker from "./SizePicker";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}

type SeqItem = { key: string; id: ActionPresetId };

let seqKey = 0;
const nextKey = () => `f${++seqKey}`;

function resolveFrames(seq: SeqItem[]) {
  return seq.map((s) => {
    const p = ACTION_PRESETS.find((a) => a.id === s.id)!;
    return { id: p.id, label: p.label, prompt: p.prompt };
  });
}

/**
 * 多动作生成：
 * - 图片：引用图 + 有序帧序列 → 一次拼图表 → 网格切分
 * - 视频：点选动作注入提示词 → 文生视频素材 → 素材详情单独抽帧
 */
export default function ActionGenModal({ material: m, v, onClose, onToast }: Props) {
  const t = useT();
  useModalEscClose(onClose);
  const slot = m.processed_path ? "processed" : "raw";
  const base = m.name.replace(/\s*#\d+$/, "").trim() || t("common.material");
  const characterPrompt = typeof m.metadata.prompt === "string" ? m.metadata.prompt : null;

  const [mediaKind, setMediaKind] = useState<"image" | "video">("image");
  // 图片：默认走路×4；视频：默认只注入「走路」一次
  const [seq, setSeq] = useState<SeqItem[]>(() =>
    Array.from({ length: 4 }, () => ({ key: nextKey(), id: "walk" as ActionPresetId }))
  );
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(1);
  const [gridTouched, setGridTouched] = useState(false);
  const [extra, setExtra] = useState("");
  const [autoMatting, setAutoMatting] = useState(true);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const cfg = useServerConfig();

  const isVideo = mediaKind === "video";
  const maxItems = ACTION_SHEET_MAX_FRAMES;
  const frames = useMemo(() => resolveFrames(seq), [seq]);
  const sameAction = frames.length > 0 && frames.every((f) => f.id === frames[0]!.id);

  useEffect(() => {
    if (isVideo || gridTouched) return;
    const g = suggestActionSheetGrid(frames.length || 1);
    setCols(g.cols);
    setRows(g.rows);
  }, [frames.length, gridTouched, isVideo]);

  const switchMediaKind = (next: "image" | "video") => {
    if (next === mediaKind) return;
    setMediaKind(next);
    setModel("");
    setSize("");
    setGridTouched(false);
    // 视频只需注入动作，不必重复走路×4；切回图片恢复拼图默认
    if (next === "video") {
      const first = seq[0]?.id ?? ("walk" as ActionPresetId);
      setSeq([{ key: nextKey(), id: first }]);
    } else {
      setSeq(Array.from({ length: 4 }, () => ({ key: nextKey(), id: "walk" as ActionPresetId })));
    }
  };

  const addFrame = (id: ActionPresetId) => {
    setSeq((prev) => {
      if (prev.length >= maxItems) {
        notify(t("msg.max_n_frames", { n: maxItems }), "info");
        return prev;
      }
      return [...prev, { key: nextKey(), id }];
    });
  };

  /** 视频：点选即注入（单动作替换）；图片：追加一帧 */
  const injectAction = (id: ActionPresetId) => {
    if (isVideo) {
      setSeq([{ key: nextKey(), id }]);
      return;
    }
    addFrame(id);
  };

  /** 一键填满（仅图片）：清空后追加同一动作 n 帧 */
  const fillAction = (id: ActionPresetId, n: number) => {
    const count = Math.max(1, Math.min(ACTION_SHEET_MAX_FRAMES, n));
    setSeq(Array.from({ length: count }, () => ({ key: nextKey(), id })));
    setGridTouched(false);
  };

  const removeAt = (key: string) => setSeq((prev) => prev.filter((s) => s.key !== key));

  const submit = async () => {
    if (frames.length === 0 || submitting) return;
    if (!isVideo && cols * rows < frames.length) {
      notify(
        t("msg.grid_cols_rows_has_cells_cells_n_selected_frames", {
          cols,
          rows,
          cells: cols * rows,
          n: frames.length,
        })
      );
      return;
    }
    setSubmitting(true);
    const providers = (cfg?.gen.providers ?? []).filter((p) => (isVideo ? p.video : true));
    const sel = resolveProviderSelection(providers, providerId, model, {
      videoOnly: isVideo,
      preferI2v: isVideo,
    });
    const nameTag = isVideo
      ? frames[0]!.id
      : sameAction
        ? `${frames[0]!.id}${frames.length}`
        : `seq${frames.length}`;

    try {
      if (isVideo) {
        await api.generateMaterial({
          prompt: buildActionVideoPrompt({
            actions: frames.slice(0, ACTION_VIDEO_MAX_ACTIONS),
            characterPrompt,
            extra: extra.trim(),
          }),
          count: 1,
          autoMatting: false,
          name: `${base}_${nameTag}_vid`,
          folderId: m.folder_id,
          mediaKind: "video",
          referenceMaterialId: m.id,
          ...sel,
          ...(size ? { size } : {}),
        });
        onToast(t("msg.queued_action_video_action_open_it_in_materials_and_extr", { action: t(frames[0]!.label) }));
      } else {
        await api.generateMaterial({
          prompt: buildActionSheetPrompt({
            frames,
            cols,
            rows,
            characterPrompt,
            extra: extra.trim(),
          }),
          count: 1,
          autoMatting,
          name: `${base}_${nameTag}_${cols}x${rows}`,
          referenceMaterialId: m.id,
          folderId: m.folder_id,
          ...sel,
          ...(size ? { size } : {}),
        });
        onToast(
          t("msg.queued_continuous_sheet_cols_rows_n_frames_when_done_ope", {
            cols,
            rows,
            n: frames.length,
          })
        );
      }
      onClose();
    } catch (e) {
      notify(t("msg.submit_failed_msg", { msg: (e as Error).message }));
      setSubmitting(false);
    }
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}  >
      <motion.div
        className="modal pixel-panel ag-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("msg.multi_action_generate")}</h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="form-row">
          <label>{t("msg.generation_mode")}</label>
          <PxSelect
            value={mediaKind}
            options={[
              { value: "image", label: t("msg.image_sprite_sheet_then_grid_split") },
              { value: "video", label: t("msg.video_extract_frames_later_in_materials") },
            ]}
            onChange={(v) => switchMediaKind(v as "image" | "video")}
          />
        </div>

        <div className="hint">
          {isVideo
            ? t("msg.inject_actions_with_ref_bailian_i2v_r2v_best_saves_video")
            : t("msg.ref_name_slot_append_continuous_frames_same_action_repea", {
                name: m.name,
                slot: slot === "processed" ? t("msg.matted") : t("msg.original"),
              })}
          {characterPrompt
            ? ` · ${t("msg.original_prompt_included_to_lock_character_description")}`
            : isVideo
              ? ` · ${t("msg.no_original_prompt_appearance_relies_mainly_on_the_ref_i")}`
              : ` · ${t("msg.no_original_prompt_appearance_relies_mainly_on_the_refer")}`}
        </div>

        <div className="ag-main">
          <div className="ag-ref">
            <img src={materialImageUrl(m.id, v, slot, 512)} alt={m.name} draggable={false} decoding="async" />
            <span className="ag-ref-tag">{isVideo ? t("msg.character_ref") : t("msg.reference")}</span>
          </div>
          <div className="ag-actions-col">
            <div className="ag-actions">
              {ACTION_PRESETS.map((a) => {
                const active = isVideo && seq[0]?.id === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`ag-chip${active ? " on" : ""}`}
                    disabled={submitting || (!isVideo && seq.length >= maxItems)}
                    title={
                      isVideo
                        ? t("msg.inject_action_label", { label: t(a.label) })
                        : t("msg.append_frame_label", { label: t(a.label) })
                    }
                    onClick={() => injectAction(a.id)}
                  >
                    {isVideo ? null : <Plus size={12} />} {t(a.label)}
                  </button>
                );
              })}
            </div>
            {isVideo ? null : (
              <div className="ag-quick">
                <span className="hint">{t("msg.quick_fill")}</span>
                {(["walk", "run", "idle", "attack"] as ActionPresetId[]).map((id) => {
                  const p = ACTION_PRESETS.find((a) => a.id === id)!;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="px-btn mini"
                      disabled={submitting}
                      onClick={() => fillAction(id, 4)}
                    >
                      {t(p.label)}×4
                    </button>
                  );
                })}
                <button type="button" className="px-btn mini" disabled={submitting || seq.length === 0} onClick={() => setSeq([])}>
                  {t("common.clear")}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="form-row">
          <label>
            {isVideo
              ? t("msg.injected_action_click_a_chip_above_to_change")
              : t("msg.frame_sequence_n_max_click_to_remove_order_timeline", {
                  n: seq.length,
                  max: ACTION_SHEET_MAX_FRAMES,
                })}
          </label>
          <div className="ag-seq">
            {seq.length === 0 ? (
              <span className="hint">
                {isVideo ? t("msg.click_an_action_above_to_inject_into_the_prompt") : t("msg.click_actions_above_to_append_frames_repeat_the_same_act")}
              </span>
            ) : isVideo ? (
              (() => {
                const s = seq[0]!;
                const p = ACTION_PRESETS.find((a) => a.id === s.id)!;
                return (
                  <span className="ag-seq-chip" style={{ cursor: "default" }}>
                    {t(p.label)}
                  </span>
                );
              })()
            ) : (
              seq.map((s, i) => {
                const p = ACTION_PRESETS.find((a) => a.id === s.id)!;
                return (
                  <button
                    key={s.key}
                    type="button"
                    className="ag-seq-chip"
                    disabled={submitting}
                    title={t("msg.remove_item_i", { i: i + 1 })}
                    onClick={() => removeAt(s.key)}
                  >
                    <span className="ag-seq-i">{i + 1}</span>
                    {t(p.label)}
                    <X size={11} />
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="form-row">
          <label>{isVideo ? t("msg.extra_desc_optional_appended_to_video_prompt") : t("msg.extra_desc_optional_appended_to_sheet_prompt")}</label>
          <input
            className="px-input"
            value={extra}
            disabled={submitting}
            placeholder={t("msg.e_g_holding_a_sword_facing_right_pixel_art")}
            onChange={(e) => setExtra(e.target.value)}
          />
        </div>

        {isVideo ? (
          <div className="hint">{t("msg.when_done_open_the_video_material_and_extract_frames_at")}</div>
        ) : (
          <>
            <div className="form-inline">
              <label className="px-check">
                {t("msg.cols")}
                <input
                  className="px-input num"
                  type="number"
                  min={1}
                  max={8}
                  value={cols}
                  disabled={submitting}
                  onChange={(e) => {
                    setGridTouched(true);
                    setCols(Math.max(1, Math.min(8, Number(e.target.value) || 1)));
                  }}
                />
              </label>
              <label className="px-check">
                {t("msg.rows")}
                <input
                  className="px-input num"
                  type="number"
                  min={1}
                  max={8}
                  value={rows}
                  disabled={submitting}
                  onChange={(e) => {
                    setGridTouched(true);
                    setRows(Math.max(1, Math.min(8, Number(e.target.value) || 1)));
                  }}
                />
              </label>
              <span className="hint" style={{ flex: 1 }}>
                {t("msg.layout_cols_rows_cells_cells_n_continuous_frames_l_r_t_b", {
                  cols,
                  rows,
                  cells: cols * rows,
                  n: frames.length,
                })}
              </span>
            </div>
            <div className="ag-grid-preview" style={{ ["--ag-cols" as string]: cols }}>
              {Array.from({ length: cols * rows }, (_, i) => {
                const a = frames[i];
                return (
                  <div key={i} className={`ag-cell ${a ? "filled" : "empty"}`}>
                    {a ? `${i + 1}.${t(a.label)}` : "·"}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <ProviderModelPicker
          providerId={providerId}
          model={model}
          onProviderChange={setProviderId}
          onModelChange={setModel}
          videoOnly={isVideo}
          preferI2v={isVideo}
        />
        {!isVideo && <SizePicker providerId={providerId} value={size} onChange={setSize} />}
        {isVideo && <SizePicker providerId={providerId} value={size} onChange={setSize} forVideo />}
        {!isVideo && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}

        <div className="modal-actions">
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={frames.length === 0 || submitting}
            onClick={() => void submit()}
          >
            <PersonStanding size={14} />{" "}
            {submitting
              ? t("common.submitting")
              : isVideo
                ? t("msg.generate_action_video_action", {
                    action: t(frames[0]?.label ?? ""),
                  })
                : t("msg.generate_continuous_sheet_n_frames_cols_rows", { n: frames.length || "", cols, rows })}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
