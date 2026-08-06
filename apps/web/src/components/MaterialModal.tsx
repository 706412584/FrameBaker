import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Crop, Grid3x3, MoveHorizontal, PersonStanding, Send, Trash2, Undo2, Wand2, X } from "lucide-react";
import { api, materialImageUrl, type Material, type Project } from "../api";
import { getLocale, useT } from "../i18n";
import { notify } from "../notice";
import { useServerConfig } from "../config";
import IconBtn from "./IconBtn";
import CropModal from "./CropModal";
import GridSplitModal from "./GridSplitModal";
import ActionGenModal from "./ActionGenModal";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

/** 素材详情：原图/抠图对比滑杆 + 抠图/还原/导入/删除 */
export default function MaterialModal({ material: m, v, onClose, onChanged, onToast }: Props) {
  const t = useT();
  const [pos, setPos] = useState(55);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [count, setCount] = useState(1);
  // 剪裁二次加工：载入当前显示图（processed ?? raw），确认后覆盖同一槽位
  const [crop, setCrop] = useState<{ blob: Blob; slot: "raw" | "processed" } | null>(null);
  // 网格切分：多宫格精灵图逐格切成独立素材
  const [showSplit, setShowSplit] = useState(false);
  // 多动作生成：以当前素材为引用图逐动作生成帧序列
  const [showActions, setShowActions] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cfg = useServerConfig();
  const engine = cfg?.matting.engine;
  const engineAvailable = engine != null && engine !== "none";

  // ---- 对比滑杆：pointer 拖动改变 clip 比例 ----
  const updatePos = (e: React.PointerEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const p = ((e.clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(98, Math.max(2, p)));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 抠图走任务队列（模型首次下载可能耗时数分钟，同步请求会挂死；进度见右侧任务面板）
  const doMatting = () =>
    run(async () => {
      await api.matteMaterial(m.id);
      onToast(t("抠图任务已加入队列"));
    });

  const doUnmatting = () =>
    run(async () => {
      await api.unmatteMaterial(m.id);
      onChanged();
      onToast(t("已还原为原图"));
    });

  // 打开剪裁：取当前显示图对应槽位（processed 优先），fetch 成 blob 进剪裁工具
  const openCrop = () =>
    run(async () => {
      const slot = m.processed_path ? "processed" : "raw";
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("读取素材图片失败"));
      setCrop({ blob: await res.blob(), slot });
    });

  const doCrop = (blob: Blob) =>
    run(async () => {
      if (!crop) return;
      await api.replaceMaterialImage(m.id, blob, crop.slot);
      setCrop(null);
      onChanged();
      onToast(t("剪裁完成"));
    });

  const doDelete = () =>
    run(async () => {
      await api.batchDeleteMaterials([m.id]);
      onChanged();
      onToast(t("已删除素材"));
      onClose();
    });

  const openImport = () => {
    if (!showImport && projects === null) {
      api.listProjects().then(setProjects).catch((e) => notify(t("加载项目失败: {msg}", { msg: e.message })));
    }
    setShowImport((s) => !s);
  };

  const doImport = (projectId: string) =>
    run(async () => {
      const r = await api.importMaterial(m.id, projectId, count);
      onToast(t("已导入 {count} 帧到项目", { count: r.count }));
      setShowImport(false);
    });

  const prompt = typeof m.metadata.prompt === "string" ? m.metadata.prompt : null;

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel mat-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{m.name}</h2>
          <IconBtn onClick={onClose} title={t("关闭")}>
            <X size={16} />
          </IconBtn>
        </div>

        {/* 原图 | 抠图后 对比滑杆 */}
        <div
          className="compare"
          ref={wrapRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            updatePos(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) updatePos(e);
          }}
        >
          <img className="cmp-img" src={materialImageUrl(m.id, v, "raw")} alt={t("原图")} draggable={false} />
          {m.processed_path ? (
            <div className="cmp-clip" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
              <img className="cmp-img" src={materialImageUrl(m.id, v, "processed")} alt={t("抠图后")} draggable={false} />
            </div>
          ) : (
            <div className="cmp-clip cmp-placeholder" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
              <span>{t("未抠图")}</span>
            </div>
          )}
          <div className="cmp-divider" style={{ left: `${pos}%` }}>
            <span className="cmp-handle">
              <MoveHorizontal size={12} />
            </span>
          </div>
          <span className="cmp-tag left">{t("原图")}</span>
          <span className="cmp-tag right">{m.processed_path ? t("抠图后") : t("未抠图")}</span>
        </div>

        <div className="mat-meta">
          <span>{t("来源")} {m.source}</span>
          <span>{m.status === "matted" ? t("已抠图") : t("原图")}</span>
          <span>{new Date(m.created_at).toLocaleString(getLocale())}</span>
          <span className={`engine-status ${engineAvailable ? "ok" : "bad"}`}>
            <span className="dot" />
            {engine == null
              ? t("引擎检测中…")
              : engineAvailable
                ? t("引擎: rembg/{model}", { model: cfg!.matting.model })
                : t("未安装抠图引擎，抠图将仅复制原图（scripts/setup_matting.sh，Windows 用 .ps1）")}
          </span>
          {prompt && <span className="mat-prompt">prompt: {prompt}</span>}
        </div>

        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent-cyan"
            disabled={busy}
            onClick={doMatting}
          >
            <Wand2 size={14} /> {m.status === "matted" ? t("重新抠图") : t("执行抠图")}
          </motion.button>
          {m.status === "matted" && (
            <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" disabled={busy} onClick={doUnmatting}>
              <Undo2 size={14} /> {t("还原原图")}
            </motion.button>
          )}
          <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" disabled={busy} onClick={openCrop}>
            <Crop size={14} /> {t("剪裁")}
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn"
            disabled={busy}
            title={t("多宫格精灵图按行×列逐格切成独立素材")}
            onClick={() => setShowSplit(true)}
          >
            <Grid3x3 size={14} /> {t("网格切分")}
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn"
            disabled={busy}
            title={t("以当前素材为引用图，按动作预设（待机/走路/奔跑…）逐动作生成帧序列素材")}
            onClick={() => setShowActions(true)}
          >
            <PersonStanding size={14} /> {t("多动作生成")}
          </motion.button>
          <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent" disabled={busy} onClick={openImport}>
            <Send size={14} /> {t("导入到项目")}
          </motion.button>
          <div style={{ flex: 1 }} />
          {confirmingDelete ? (
            <span className="batch-confirm">
              {t("确认删除？")}
              <IconBtn className="danger" title={t("确认删除")} disabled={busy} onClick={doDelete}>
                <Check size={14} />
              </IconBtn>
              <IconBtn title={t("放弃")} disabled={busy} onClick={() => setConfirmingDelete(false)}>
                <X size={14} />
              </IconBtn>
            </span>
          ) : (
            <IconBtn className="danger" title={t("删除素材")} disabled={busy} onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={15} />
            </IconBtn>
          )}
        </div>

        {showImport && (
          <div className="mat-import">
            <div className="form-inline">
              <label className="px-check">
                {t("复制帧数")}
                <input
                  className="px-input num"
                  type="number"
                  min={1}
                  max={16}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
                />
              </label>
            </div>
            {projects === null ? (
              <div className="empty">{t("加载项目中…")}</div>
            ) : projects.length === 0 ? (
              <div className="empty">{t("还没有项目，请先到「项目」页新建")}</div>
            ) : (
              <div className="picker-list">
                {projects.map((p) => (
                  <button key={p.id} type="button" className="picker-row" disabled={busy} onClick={() => doImport(p.id)}>
                    <span className="picker-name">{p.name}</span>
                    <span className="picker-meta">{t("{count} 帧", { count: p.frame_count ?? 0 })}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 剪裁二次加工：作用于当前显示图对应槽位 */}
        <AnimatePresence>
          {crop && (
            <CropModal
              image={crop.blob}
              title={m.name}
              subtitle={t("作用于：{slot}", { slot: crop.slot === "processed" ? t("抠图后") : t("原图") })}
              onConfirm={doCrop}
              onClose={() => setCrop(null)}
            />
          )}
        </AnimatePresence>

        {/* 网格切分：多宫格精灵图 → N 个素材 */}
        <AnimatePresence>
          {showSplit && (
            <GridSplitModal material={m} v={v} onClose={() => setShowSplit(false)} onDone={onChanged} onToast={onToast} />
          )}
        </AnimatePresence>

        {/* 多动作生成：以当前素材为引用图 → 每动作 N 帧素材 */}
        <AnimatePresence>
          {showActions && (
            <ActionGenModal material={m} v={v} onClose={() => setShowActions(false)} onToast={onToast} />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
