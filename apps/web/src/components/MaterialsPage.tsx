import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Package, Send, Sparkles, Trash2, Upload, Wand2, X } from "lucide-react";
import { SOURCE_COLORS } from "@framebaker/shared";
import { api, materialImageUrl, wsClient, type Material } from "../api";
import { notify } from "../notice";
import { themedSourceColor, useTheme } from "../theme";
import MaterialImportModal from "./MaterialImportModal";
import MaterialModal from "./MaterialModal";
import ProjectPickerModal from "./ProjectPickerModal";
import IconBtn from "./IconBtn";

const isMac = /macintosh|mac os/i.test(navigator.userAgent);

export default function MaterialsPage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [importTab, setImportTab] = useState<"upload" | "cli" | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState(0);
  const theme = useTheme();

  const load = useCallback(async () => {
    try {
      const list = await api.listMaterials();
      setMaterials(list);
      // 选区里已不存在的素材自动剔除
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const alive = new Set(list.map((m) => m.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = wsClient.subscribe((msg) => {
      if (["material_updated", "materials_changed", "job_done"].includes(msg.type)) {
        load();
        setV((x) => x + 1);
      }
    });
    return unsub;
  }, [load]);

  const toast = (msg: string) => notify(msg, "info");

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchorId(id);
  };

  // 卡片点击：plain=打开详情；ctrl=切换选中；shift=范围选
  const onCardClick = (e: React.MouseEvent, id: string) => {
    const ctrl = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchorId) {
      const a = materials.findIndex((m) => m.id === anchorId);
      const b = materials.findIndex((m) => m.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        setSelectedIds(new Set(materials.slice(lo, hi + 1).map((m) => m.id)));
        return;
      }
    }
    if (ctrl) {
      toggleOne(id);
      return;
    }
    setAnchorId(id);
    setDetailId(id);
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setConfirmingDelete(false);
  };

  const batchDelete = async () => {
    const ids = [...selectedIds];
    setBusy(true);
    try {
      const r = await api.batchDeleteMaterials(ids);
      setSelectedIds(new Set());
      setConfirmingDelete(false);
      await load();
      toast(`已删除 ${r.deleted} 个素材`);
    } catch (e) {
      notify(`删除失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 选中素材二次加工：批量抠图入队（不是所有图都需要加工，按需触发）
  const batchMatting = async () => {
    const ids = [...selectedIds];
    setBusy(true);
    try {
      const r = await api.batchMatteMaterials(ids);
      toast(`已加入 ${r.count} 个抠图任务`);
    } catch (e) {
      notify(`抠图失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const batchImport = async (projectId: string) => {
    // 保持网格中的选中顺序
    const ids = materials.filter((m) => selectedIds.has(m.id)).map((m) => m.id);
    setBusy(true);
    try {
      const r = await api.batchImportMaterials(ids, projectId);
      setShowPicker(false);
      setSelectedIds(new Set());
      toast(`已导入 ${r.count} 个素材到项目`);
    } catch (e) {
      notify(`导入失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const detail = detailId ? (materials.find((m) => m.id === detailId) ?? null) : null;

  return (
    <div className="page">
      <header className="home-header">
        <h1>
          <Package size={28} /> 素材库
        </h1>
        <p className="subtitle">
          {materials.length} 个素材 · 生成 / 上传 → 抠图 → 对比确认 → 导入项目 · {isMac ? "Cmd" : "Ctrl"}+点击 多选 ·
          Shift+点击 范围选
        </p>
        <div className="mat-actions">
          <motion.button
            type="button"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="px-btn"
            onClick={() => setImportTab("upload")}
          >
            <Upload size={16} /> 上传素材
          </motion.button>
          <motion.button
            type="button"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            onClick={() => setImportTab("cli")}
          >
            <Sparkles size={16} /> CLI 生成
          </motion.button>
        </div>
      </header>

      {materials.length === 0 ? (
        <div className="empty">
          <Package size={32} />
          <p>素材库为空，先上传或用 CLI 生成一些素材吧</p>
        </div>
      ) : (
        <div className="project-grid">
          {materials.map((m, i) => (
            <motion.div
              key={m.id}
              className={`project-card mat-card ${selectedIds.has(m.id) ? "selected" : ""}`}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.04, 0.4) }}
              whileHover={{ y: -6 }}
              onClick={(e) => onCardClick(e, m.id)}
            >
              <div className="thumb">
                <img src={materialImageUrl(m.id, v)} alt="" draggable={false} />
                <span
                  className={`mat-check ${selectedIds.has(m.id) ? "on" : ""}`}
                  title="选择"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOne(m.id);
                  }}
                >
                  {selectedIds.has(m.id) && <Check size={12} />}
                </span>
                <span
                  className="mat-src"
                  style={{ background: themedSourceColor(SOURCE_COLORS[m.source] ?? "#888", theme) }}
                >
                  {m.source}
                </span>
                <span
                  className={`mat-dot ${m.status}`}
                  title={m.status === "matted" ? "已抠图" : "原图"}
                />
              </div>
              <div className="info">
                <div className="name">{m.name}</div>
                <div className="meta">
                  {m.status === "matted" ? "已抠图" : "原图"} · {new Date(m.created_at).toLocaleString("zh-CN")}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* 批量操作条：有选中时浮出 */}
      <div className="batch-dock page-dock">
        <AnimatePresence>
          {selectedIds.size >= 1 && (
            <motion.div
              className="batch-bar pixel-panel"
              initial={{ opacity: 0, y: -14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.15 }}
            >
              <span className="batch-count">已选 {selectedIds.size} 个素材</span>
              <span className="tb-sep" />
              {confirmingDelete ? (
                <span className="batch-confirm">
                  确认删除？
                  <IconBtn className="danger" title="确认删除" disabled={busy} onClick={batchDelete}>
                    <Check size={14} />
                  </IconBtn>
                  <IconBtn title="放弃删除" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                    <X size={14} />
                  </IconBtn>
                </span>
              ) : (
                <IconBtn className="danger" title="批量删除" disabled={busy} onClick={() => setConfirmingDelete(true)}>
                  <Trash2 size={14} />
                </IconBtn>
              )}
              <IconBtn title="导入到项目" disabled={busy} onClick={() => setShowPicker(true)}>
                <Send size={14} />
              </IconBtn>
              <IconBtn title="批量抠图（对选中素材执行二次加工）" disabled={busy} onClick={batchMatting}>
                <Wand2 size={14} />
              </IconBtn>
              <span className="tb-sep" />
              <IconBtn title="取消选择" disabled={busy} onClick={clearSelection}>
                <X size={14} />
              </IconBtn>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {importTab && (
          <MaterialImportModal
            initialTab={importTab}
            onClose={() => setImportTab(null)}
            onDone={() => {
              load();
              setV((x) => x + 1);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {detail && (
          <MaterialModal
            material={detail}
            v={v}
            onClose={() => setDetailId(null)}
            onChanged={() => {
              load();
              setV((x) => x + 1);
            }}
            onToast={toast}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPicker && (
          <ProjectPickerModal title="导入到项目" onPick={batchImport} onClose={() => setShowPicker(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
