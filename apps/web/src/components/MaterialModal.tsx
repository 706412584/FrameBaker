import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, MoveHorizontal, Send, Trash2, Undo2, Wand2, X } from "lucide-react";
import { api, materialImageUrl, type Material, type Project } from "../api";
import { useServerConfig } from "../config";
import IconBtn from "./IconBtn";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

/** 素材详情：原图/抠图对比滑杆 + 抠图/还原/导入/删除 */
export default function MaterialModal({ material: m, v, onClose, onChanged, onToast }: Props) {
  const [pos, setPos] = useState(55);
  const [busy, setBusy] = useState(false);
  const [matting, setMatting] = useState(false); // 抠图进行中（可能秒级耗时）
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [count, setCount] = useState(1);
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
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doMatting = () => {
    setMatting(true);
    run(async () => {
      const r = await api.matteMaterial(m.id);
      onChanged();
      onToast(r.warning ?? "抠图完成");
    }).finally(() => setMatting(false));
  };

  const doUnmatting = () =>
    run(async () => {
      await api.unmatteMaterial(m.id);
      onChanged();
      onToast("已还原为原图");
    });

  const doDelete = () =>
    run(async () => {
      await api.batchDeleteMaterials([m.id]);
      onChanged();
      onToast("已删除素材");
      onClose();
    });

  const openImport = () => {
    if (!showImport && projects === null) {
      api.listProjects().then(setProjects).catch((e) => alert(`加载项目失败: ${e.message}`));
    }
    setShowImport((s) => !s);
  };

  const doImport = (projectId: string) =>
    run(async () => {
      const r = await api.importMaterial(m.id, projectId, count);
      onToast(`已导入 ${r.count} 帧到项目`);
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
          <IconBtn onClick={onClose} title="关闭">
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
          <img className="cmp-img" src={materialImageUrl(m.id, v, "raw")} alt="原图" draggable={false} />
          {m.processed_path ? (
            <div className="cmp-clip" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
              <img className="cmp-img" src={materialImageUrl(m.id, v, "processed")} alt="抠图后" draggable={false} />
            </div>
          ) : (
            <div className="cmp-clip cmp-placeholder" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
              <span>未抠图</span>
            </div>
          )}
          <div className="cmp-divider" style={{ left: `${pos}%` }}>
            <span className="cmp-handle">
              <MoveHorizontal size={12} />
            </span>
          </div>
          <span className="cmp-tag left">原图</span>
          <span className="cmp-tag right">{m.processed_path ? "抠图后" : "未抠图"}</span>
        </div>

        <div className="mat-meta">
          <span>来源 {m.source}</span>
          <span>{m.status === "matted" ? "已抠图" : "原图"}</span>
          <span>{new Date(m.created_at).toLocaleString("zh-CN")}</span>
          <span className={`engine-status ${engineAvailable ? "ok" : "bad"}`}>
            <span className="dot" />
            {engine == null
              ? "引擎检测中…"
              : engineAvailable
                ? `引擎: rembg/${cfg!.matting.model}`
                : "未安装抠图引擎，抠图将仅复制原图（scripts/setup_matting.sh）"}
          </span>
          {prompt && <span className="mat-prompt">prompt: {prompt}</span>}
        </div>

        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent-cyan"
            disabled={busy || matting}
            onClick={doMatting}
          >
            <Wand2 size={14} /> {matting ? "抠图中…" : m.status === "matted" ? "重新抠图" : "执行抠图"}
          </motion.button>
          {m.status === "matted" && (
            <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" disabled={busy} onClick={doUnmatting}>
              <Undo2 size={14} /> 还原原图
            </motion.button>
          )}
          <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent" disabled={busy} onClick={openImport}>
            <Send size={14} /> 导入到项目
          </motion.button>
          <div style={{ flex: 1 }} />
          {confirmingDelete ? (
            <span className="batch-confirm">
              确认删除？
              <IconBtn className="danger" title="确认删除" disabled={busy} onClick={doDelete}>
                <Check size={14} />
              </IconBtn>
              <IconBtn title="放弃" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                <X size={14} />
              </IconBtn>
            </span>
          ) : (
            <IconBtn className="danger" title="删除素材" disabled={busy} onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={15} />
            </IconBtn>
          )}
        </div>

        {showImport && (
          <div className="mat-import">
            <div className="form-inline">
              <label className="px-check">
                复制帧数
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
              <div className="empty">加载项目中…</div>
            ) : projects.length === 0 ? (
              <div className="empty">还没有项目，请先到「项目」页新建</div>
            ) : (
              <div className="picker-list">
                {projects.map((p) => (
                  <button key={p.id} type="button" className="picker-row" disabled={busy} onClick={() => doImport(p.id)}>
                    <span className="picker-name">{p.name}</span>
                    <span className="picker-meta">{p.frame_count} 帧</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
