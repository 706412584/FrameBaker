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
 * - 视频：点选动作注入提示词 → 文生视频 → fps 抽帧（无拼图/切分）
 */
export default function ActionGenModal({ material: m, v, onClose, onToast }: Props) {
  const t = useT();
  const slot = m.processed_path ? "processed" : "raw";
  const base = m.name.replace(/\s*#\d+$/, "").trim() || t("素材");
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
  const [videoFps, setVideoFps] = useState(8);
  const [autoMatting, setAutoMatting] = useState(true);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const cfg = useServerConfig();

  const isVideo = mediaKind === "video";
  const maxItems = isVideo ? ACTION_VIDEO_MAX_ACTIONS : ACTION_SHEET_MAX_FRAMES;
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
        notify(t(isVideo ? "最多注入 {n} 个动作" : "最多 {n} 帧", { n: maxItems }), "info");
        return prev;
      }
      return [...prev, { key: nextKey(), id }];
    });
  };

  /** 视频：点选动作直接设为当前注入（单动作最常见）；Shift 语义用「追加」按钮另走 addFrame */
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
        t("网格 {cols}×{rows} 只有 {cells} 格，少于已选 {n} 个动作", {
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
    const nameTag = sameAction
      ? isVideo
        ? frames[0]!.label
        : `${frames[0]!.label}${frames.length}帧`
      : isVideo
        ? `动作${frames.length}段`
        : `连续${frames.length}帧`;

    try {
      if (isVideo) {
        await api.generateMaterial({
          prompt: buildActionVideoPrompt({
            actions: frames,
            characterPrompt,
            extra: extra.trim(),
          }),
          count: 1,
          autoMatting,
          name: `${base}_${nameTag}_vid`,
          folderId: m.folder_id,
          mediaKind: "video",
          fps: videoFps,
          // 百炼 HappyHorse i2v/r2v 作首帧/参考；t2v 忽略
          referenceMaterialId: m.id,
          ...sel,
        });
        onToast(
          t("已入队动作视频「{action}」；完成后按 {fps} fps 抽帧成素材", {
            action: sameAction ? t(frames[0]!.label) : nameTag,
            fps: videoFps,
          })
        );
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
          t("已入队连续动作表（{cols}×{rows} · {n} 帧）；完成后打开该素材用「网格切分」拆格", {
            cols,
            rows,
            n: frames.length,
          })
        );
      }
      onClose();
    } catch (e) {
      notify(t("提交失败: {msg}", { msg: (e as Error).message }));
      setSubmitting(false);
    }
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel ag-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("多动作生成")}</h2>
          <IconBtn onClick={onClose} title={t("关闭")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="form-row">
          <label>{t("生成方式")}</label>
          <PxSelect
            value={mediaKind}
            options={[
              { value: "image", label: t("图片拼图表（再网格切分）") },
              { value: "video", label: t("视频（注入动作 → 抽帧）") },
            ]}
            onChange={(v) => switchMediaKind(v as "image" | "video")}
          />
        </div>

        <div className="hint">
          {isVideo
            ? t("以当前素材为引用图注入动作（百炼选 i2v/r2v 效果更好）；生成短视频再按帧率拆成素材，无需拼图与切分")
            : t("以「{name}」为引用图（{slot}），按顺序追加连续帧（可重复同一动作）；一次生成拼图表再切分", {
                name: m.name,
                slot: slot === "processed" ? t("抠图后") : t("原图"),
              })}
          {characterPrompt
            ? ` · ${t("已附带原提示词以锁定角色描述")}`
            : isVideo
              ? ` · ${t("原素材无提示词时主要靠引用图（i2v）约束外观")}`
              : ` · ${t("原素材无提示词，主要靠引用图约束外观")}`}
        </div>

        <div className="ag-main">
          <div className="ag-ref">
            <img src={materialImageUrl(m.id, v, slot)} alt={m.name} draggable={false} />
            <span className="ag-ref-tag">{isVideo ? t("角色参考") : t("参考图")}</span>
          </div>
          <div className="ag-actions-col">
            <div className="ag-actions">
              {ACTION_PRESETS.map((a) => {
                const active = isVideo && seq.length === 1 && seq[0]?.id === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`ag-chip${active ? " on" : ""}`}
                    disabled={submitting || (!isVideo && seq.length >= maxItems)}
                    title={
                      isVideo
                        ? t("注入动作「{label}」", { label: t(a.label) })
                        : t("追加一帧「{label}」", { label: t(a.label) })
                    }
                    onClick={() => injectAction(a.id)}
                  >
                    {isVideo ? null : <Plus size={12} />} {t(a.label)}
                  </button>
                );
              })}
            </div>
            {isVideo ? (
              <div className="ag-quick">
                <span className="hint">{t("可追加衔接动作（最多 {n} 段）", { n: ACTION_VIDEO_MAX_ACTIONS })}</span>
                {ACTION_PRESETS.slice(0, 4).map((a) => (
                  <button
                    key={`append-${a.id}`}
                    type="button"
                    className="px-btn mini"
                    disabled={submitting || seq.length >= ACTION_VIDEO_MAX_ACTIONS}
                    onClick={() => addFrame(a.id)}
                  >
                    +{t(a.label)}
                  </button>
                ))}
                <button type="button" className="px-btn mini" disabled={submitting || seq.length === 0} onClick={() => setSeq([])}>
                  {t("清空")}
                </button>
              </div>
            ) : (
              <div className="ag-quick">
                <span className="hint">{t("一键填满")}</span>
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
                  {t("清空")}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="form-row">
          <label>
            {isVideo
              ? t("已注入动作（{n}/{max}）· 点击可移除 · 顺序即片内衔接", {
                  n: seq.length,
                  max: ACTION_VIDEO_MAX_ACTIONS,
                })
              : t("帧序列（{n}/{max}）· 点击可移除 · 顺序即时间轴", {
                  n: seq.length,
                  max: ACTION_SHEET_MAX_FRAMES,
                })}
          </label>
          <div className="ag-seq">
            {seq.length === 0 ? (
              <span className="hint">
                {isVideo ? t("点左侧动作注入；需要多段动作时用下方「+动作」追加") : t("点上方动作追加帧，可重复追加同一动作以保证循环连续")}
              </span>
            ) : (
              seq.map((s, i) => {
                const p = ACTION_PRESETS.find((a) => a.id === s.id)!;
                return (
                  <button
                    key={s.key}
                    type="button"
                    className="ag-seq-chip"
                    disabled={submitting}
                    title={t("移除第 {i} 项", { i: i + 1 })}
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
          <label>{isVideo ? t("附加描述（可空，拼接到视频提示词之后）") : t("附加描述（可空，拼接到拼图提示词之后）")}</label>
          <input
            className="px-input"
            value={extra}
            disabled={submitting}
            placeholder={t("例如：holding a sword, facing right, pixel art")}
            onChange={(e) => setExtra(e.target.value)}
          />
        </div>

        {isVideo ? (
          <div className="form-row">
            <label>{t("视频抽帧帧率：{fps} fps（生成一段视频后逐帧切割成多个素材）", { fps: videoFps })}</label>
            <input
              type="range"
              min={1}
              max={24}
              value={videoFps}
              disabled={submitting}
              onChange={(e) => setVideoFps(Number(e.target.value))}
            />
          </div>
        ) : (
          <>
            <div className="form-inline">
              <label className="px-check">
                {t("列数")}
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
                {t("行数")}
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
                {t("布局 {cols}×{rows}（{cells} 格）· {n} 帧连续 · 左→右、上→下", {
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
        <MattingOption checked={autoMatting} onChange={setAutoMatting} />

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
              ? t("提交中…")
              : isVideo
                ? t("生成动作视频（{action}）", {
                    action: sameAction ? t(frames[0]?.label ?? "") : t("{n} 段动作", { n: frames.length }),
                  })
                : t("生成连续动作表（{n} 帧 · {cols}×{rows}）", { n: frames.length || "", cols, rows })}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
