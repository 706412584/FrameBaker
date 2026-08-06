import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Download, Eye, ImageDown, Package, Scan, Send, Sparkles, Trash2, Upload, Wand2, X } from "lucide-react";
import { SOURCE_COLORS } from "@framebaker/shared";
import { api, materialImageUrl, wsClient, type Folder, type Material } from "../api";
import { downloadMaterialImage, downloadMaterialImages } from "../export";
import { cropImage, findOpaqueBounds } from "../imageops/client";
import { getLocale, useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import { SOURCE_LABEL_KEYS } from "../sourceLabel";
import { themedSourceColor, useTheme } from "../theme";
import FolderTree, { type FolderSelection } from "./FolderTree";
import FileZoom, { useFileZoom } from "./FileZoom";
import MaterialImportModal from "./MaterialImportModal";
import MaterialModal from "./MaterialModal";
import ProjectPickerModal from "./ProjectPickerModal";
import ContextMenu, { type CtxMenuItem } from "./ContextMenu";
import IconBtn from "./IconBtn";

const isMac = /macintosh|mac os/i.test(navigator.userAgent);

export default function MaterialsPage() {
  const t = useT();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderSel, setFolderSel] = useState<FolderSelection>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [importTab, setImportTab] = useState<"upload" | "cli" | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  /** 右键导入：null=批量选中；string=单素材 id */
  const [pickerScope, setPickerScope] = useState<"batch" | string>("batch");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; materialId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState(0);
  const [zoom, setZoom] = useFileZoom();
  const theme = useTheme();

  const loadFolders = useCallback(async () => {
    try {
      setFolders(await api.listFolders("material"));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await api.listMaterials();
      setMaterials(list);
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
    void load();
    void loadFolders();
    const unsub = wsClient.subscribe((msg) => {
      if (["material_updated", "materials_changed", "job_done"].includes(msg.type)) {
        void load();
        setV((x) => x + 1);
      }
      if (msg.type === "folders_changed") {
        const p = msg.payload as { kind?: string } | undefined;
        if (!p?.kind || p.kind === "material") void loadFolders();
      }
    });
    return unsub;
  }, [load, loadFolders]);

  const visible = useMemo(() => {
    if (folderSel === "all") return materials;
    if (folderSel === "ungrouped") return materials.filter((m) => !m.folder_id);
    return materials.filter((m) => m.folder_id === folderSel);
  }, [materials, folderSel]);

  const currentFolderId = folderSel !== "all" && folderSel !== "ungrouped" ? folderSel : null;

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

  const onCardClick = (e: React.MouseEvent, id: string) => {
    const ctrl = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchorId) {
      const a = visible.findIndex((m) => m.id === anchorId);
      const b = visible.findIndex((m) => m.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        setSelectedIds(new Set(visible.slice(lo, hi + 1).map((m) => m.id)));
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

  const onCardContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!(selectedIds.size >= 2 && selectedIds.has(id))) {
      setSelectedIds(new Set());
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, materialId: id });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const deleteMaterials = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = await api.batchDeleteMaterials(ids);
      setSelectedIds(new Set());
      await load();
      toast(t("已删除 {count} 个素材", { count: r.deleted }));
    } catch (e) {
      notify(t("删除失败: {msg}", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const requestBatchDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!(await askConfirm(t("确认删除选中的 {n} 个素材？此操作不可恢复。", { n: ids.length })))) return;
    await deleteMaterials(ids);
  };

  // 批量抠图：只对未抠图入队（已抠图跳过；详情页仍可重新抠）
  const requestBatchMatting = async (ids: string[]) => {
    const rawIds = materials.filter((m) => ids.includes(m.id) && m.status !== "matted").map((m) => m.id);
    if (rawIds.length === 0) {
      notify(t("选中素材均已抠图，批量不可再抠（可点开详情重新抠）"), "info");
      return;
    }
    if (!(await askConfirm(t("对 {n} 个未抠图素材加入抠图任务？", { n: rawIds.length })))) return;
    setBusy(true);
    try {
      const r = await api.batchMatteMaterials(rawIds);
      const msg =
        r.skipped > 0
          ? t("已加入 {count} 个抠图任务（跳过已抠图 {skipped}）", { count: r.count, skipped: r.skipped })
          : t("已加入 {count} 个抠图任务", { count: r.count });
      toast(msg);
    } catch (e) {
      notify(t("抠图失败: {msg}", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const openImportPicker = async (scope: "batch" | string) => {
    const n = scope === "batch" ? selectedIds.size : 1;
    if (n === 0) return;
    if (!(await askConfirm(t("将 {n} 个素材导入到项目？", { n })))) return;
    setPickerScope(scope);
    setShowPicker(true);
  };

  const doImportPick = async (projectId: string) => {
    const ids = pickerScope === "batch" ? [...selectedIds] : [pickerScope];
    setBusy(true);
    try {
      const r = await api.batchImportMaterials(ids, projectId);
      setShowPicker(false);
      setSelectedIds(new Set());
      toast(t("已导入 {count} 个素材到项目", { count: r.count }));
    } catch (e) {
      notify(t("导入失败: {msg}", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const moveSelectedTo = async (folderId: string | null, ids: string[]) => {
    const name =
      folderId == null ? t("未分组") : (folders.find((f) => f.id === folderId)?.name ?? folderId);
    if (!(await askConfirm(t("将 {n} 个素材移到「{name}」？", { n: ids.length, name })))) return;
    try {
      await api.moveItems("material", ids, folderId);
      await load();
      toast(t("已移动 {count} 个素材", { count: ids.length }));
    } catch (e) {
      notify(t("操作失败: {msg}", { msg: (e as Error).message }));
    }
  };

  const matteOne = async (id: string, rematte: boolean) => {
    const msg = rematte ? t("重新对该素材抠图？") : t("对该素材加入抠图任务？");
    if (!(await askConfirm(msg))) return;
    setBusy(true);
    try {
      // 单条走详情同款接口，已抠图也可重新抠（批量接口会跳过已抠图）
      await api.matteMaterial(id);
      toast(t("抠图任务已加入队列"));
    } catch (e) {
      notify(t("抠图失败: {msg}", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const requestBatchExport = async (slot: "raw" | "processed") => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const label = slot === "processed" ? t("抠图") : t("原图");
    if (!(await askConfirm(t("导出选中的 {n} 个素材的{slot}？", { n: ids.length, slot: label })))) return;
    const items = materials
      .filter((m) => ids.includes(m.id))
      .map((m) => ({ id: m.id, name: m.name, processed: !!m.processed_path }));
    setBusy(true);
    try {
      const r = await downloadMaterialImages(items, slot, v);
      if (r.ok === 0 && r.skipped > 0) {
        notify(t("选中素材均无抠图可导出"), "info");
      } else {
        toast(
          r.skipped > 0 || r.failed > 0
            ? t("已导出 {ok} 张，跳过 {skipped}，失败 {failed}", {
                ok: r.ok,
                skipped: r.skipped,
                failed: r.failed,
              })
            : t("已导出 {ok} 张", { ok: r.ok })
        );
      }
    } finally {
      setBusy(false);
    }
  };

  /** 批量自动裁透明边：对当前显示槽位（processed 优先）找不透明包围盒后写回 */
  const requestBatchAutoCrop = async (ids: string[]) => {
    if (ids.length === 0) return;
    if (!(await askConfirm(t("对选中的 {n} 个素材自动裁掉透明边？", { n: ids.length })))) return;
    setBusy(true);
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (const id of ids) {
        const mat = materials.find((x) => x.id === id);
        if (!mat) {
          skipped++;
          continue;
        }
        const slot = mat.processed_path ? ("processed" as const) : ("raw" as const);
        try {
          const res = await fetch(materialImageUrl(id, v, slot));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const bounds = await findOpaqueBounds(blob);
          if (!bounds) {
            skipped++;
            continue;
          }
          // 已贴边且无余量则跳过
          const bmp = await createImageBitmap(blob);
          const full = bounds.x === 0 && bounds.y === 0 && bounds.w === bmp.width && bounds.h === bmp.height;
          bmp.close();
          if (full) {
            skipped++;
            continue;
          }
          const cropped = await cropImage(blob, bounds);
          await api.replaceMaterialImage(id, cropped, slot);
          ok++;
        } catch {
          failed++;
        }
      }
      setV((x) => x + 1);
      await load();
      toast(
        t("已自动裁边 {ok} 张，跳过 {skipped}，失败 {failed}", { ok, skipped, failed })
      );
    } finally {
      setBusy(false);
    }
  };

  const detail = detailId ? (materials.find((m) => m.id === detailId) ?? null) : null;

  const ctxMat = ctxMenu ? (materials.find((m) => m.id === ctxMenu.materialId) ?? null) : null;
  const ctxBatch = ctxMenu != null && selectedIds.size >= 2 && selectedIds.has(ctxMenu.materialId);
  const ctxItems: CtxMenuItem[] = !ctxMenu
    ? []
    : ctxBatch
      ? [
          {
            label: t("导入到项目（{n}）", { n: selectedIds.size }),
            icon: <Send size={13} />,
            onClick: () => void openImportPicker("batch"),
          },
          {
            label: t("批量抠图（{n}）", { n: selectedIds.size }),
            icon: <Wand2 size={13} />,
            onClick: () => void requestBatchMatting([...selectedIds]),
          },
          {
            label: t("自动裁边（{n}）", { n: selectedIds.size }),
            icon: <Scan size={13} />,
            onClick: () => void requestBatchAutoCrop([...selectedIds]),
          },
          {
            label: t("导出原图（{n}）", { n: selectedIds.size }),
            icon: <Download size={13} />,
            onClick: () => void requestBatchExport("raw"),
          },
            {
              label: t("导出抠图（{n}）", { n: selectedIds.size }),
              icon: <ImageDown size={13} />,
              onClick: () => void requestBatchExport("processed"),
            },
          {
            label: t("删除 {n} 个素材", { n: selectedIds.size }),
            icon: <Trash2 size={13} />,
            danger: true,
            onClick: () => void requestBatchDelete(),
          },
        ]
      : ctxMat
        ? [
            {
              label: t("打开详情"),
              icon: <Eye size={13} />,
              onClick: () => setDetailId(ctxMat.id),
            },
            {
              label: t("导入到项目"),
              icon: <Send size={13} />,
              onClick: () => void openImportPicker(ctxMat.id),
            },
            {
              label: ctxMat.status === "matted" ? t("重新抠图") : t("抠图"),
              icon: <Wand2 size={13} />,
              onClick: () => void matteOne(ctxMat.id, ctxMat.status === "matted"),
            },
            {
              label: t("自动裁边"),
              icon: <Scan size={13} />,
              onClick: () => void requestBatchAutoCrop([ctxMat.id]),
            },
            {
              label: t("导出原图"),
              icon: <Download size={13} />,
              onClick: async () => {
                try {
                  await downloadMaterialImage(ctxMat.id, ctxMat.name, "raw", v);
                  toast(t("已导出原图"));
                } catch (e) {
                  notify(t("导出失败: {msg}", { msg: (e as Error).message }));
                }
              },
            },
            {
              label: t("导出抠图"),
              icon: <ImageDown size={13} />,
              disabled: !ctxMat.processed_path,
              onClick: async () => {
                try {
                  await downloadMaterialImage(ctxMat.id, ctxMat.name, "processed", v);
                  toast(t("已导出抠图"));
                } catch (e) {
                  notify(t("导出失败: {msg}", { msg: (e as Error).message }));
                }
              },
            },
            {
              label: t("删除"),
              icon: <Trash2 size={13} />,
              danger: true,
              onClick: async () => {
                if (!(await askConfirm(t("确认删除该素材？此操作不可恢复。")))) return;
                await deleteMaterials([ctxMat.id]);
                if (detailId === ctxMat.id) setDetailId(null);
              },
            },
          ]
        : [];

  return (
    <div className="page page-with-folders">
      <FolderTree
        kind="material"
        folders={folders}
        selected={folderSel}
        onSelect={setFolderSel}
        onCreate={async (name, parentId) => {
          await api.createFolder("material", name, parentId);
          await loadFolders();
        }}
        onRename={async (id, name) => {
          await api.patchFolder(id, { name });
          await loadFolders();
        }}
        onDelete={async (id) => {
          await api.deleteFolder(id);
          await loadFolders();
          await load();
        }}
        onMoveFolder={async (id, parentId) => {
          await api.patchFolder(id, { parentId });
          await loadFolders();
        }}
        onDropItems={(folderId, ids) => void moveSelectedTo(folderId, ids)}
      />

      <div className="folder-content">
        <header className="home-header">
          <h1>
            <Package size={28} /> {t("素材库")}
          </h1>
          <p className="subtitle">
            {t("{count} 个素材 · 生成 / 上传 → 抠图 → 对比确认 → 导入项目 · {mod}+点击 多选 · Shift+点击 范围选", {
              count: visible.length,
              mod: isMac ? "Cmd" : "Ctrl",
            })}
          </p>
          <div className="mat-actions">
            <motion.button
              type="button"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="px-btn"
              onClick={() => setImportTab("upload")}
            >
              <Upload size={16} /> {t("上传素材")}
            </motion.button>
            <motion.button
              type="button"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="px-btn accent"
              onClick={() => setImportTab("cli")}
            >
              <Sparkles size={16} /> {t("AI 生成")}
            </motion.button>
          </div>
          <FileZoom value={zoom} onChange={setZoom} />
        </header>

        <div className="folder-main">
          {materials.length === 0 ? (
            <div className="empty">
              <Package size={32} />
              <p>{t("素材库为空，先上传或 AI 生成一些素材吧")}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <Package size={32} />
              <p>{t("当前目录没有素材")}</p>
            </div>
          ) : (
            <div className="file-grid" style={{ ["--tile-min" as string]: `${zoom}px` }}>
              {visible.map((m, i) => (
                <motion.div
                  key={m.id}
                  className={`project-card mat-card ${selectedIds.has(m.id) ? "selected" : ""}`}
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.4) }}
                  whileHover={{ y: -6 }}
                  draggable
                  onDragStart={(e) => {
                    const ids = selectedIds.has(m.id) ? [...selectedIds] : [m.id];
                    (e as unknown as React.DragEvent).dataTransfer.setData(
                      "application/x-framebaker-ids",
                      JSON.stringify(ids)
                    );
                    (e as unknown as React.DragEvent).dataTransfer.effectAllowed = "move";
                  }}
                  onClick={(e) => onCardClick(e, m.id)}
                  onContextMenu={(e) => onCardContextMenu(e, m.id)}
                >
                  <div className="thumb">
                    <img src={materialImageUrl(m.id, v)} alt="" draggable={false} />
                    <span
                      className={`mat-check ${selectedIds.has(m.id) ? "on" : ""}`}
                      title={t("选择")}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleOne(m.id);
                      }}
                    >
                      {selectedIds.has(m.id) && <Check size={12} />}
                    </span>
                    {m.status === "matted" && <span className="mat-badge-matted">{t("已抠图")}</span>}
                    <span
                      className="mat-src"
                      style={{ background: themedSourceColor(SOURCE_COLORS[m.source] ?? "#888", theme) }}
                    >
                      {t(SOURCE_LABEL_KEYS[m.source] ?? m.source)}
                    </span>
                  </div>
                  <div className="info">
                    <div className="name">{m.name}</div>
                    <div className="meta">{new Date(m.created_at).toLocaleString(getLocale())}</div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>

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
                <span className="batch-count">{t("已选 {count} 个素材", { count: selectedIds.size })}</span>
                <span className="tb-sep" />
                <IconBtn className="danger" title={t("批量删除")} disabled={busy} onClick={() => void requestBatchDelete()}>
                  <Trash2 size={14} />
                </IconBtn>
                <IconBtn title={t("导入到项目")} disabled={busy} onClick={() => void openImportPicker("batch")}>
                  <Send size={14} />
                </IconBtn>
                <IconBtn
                  title={t("批量抠图（仅未抠图）")}
                  disabled={busy}
                  onClick={() => void requestBatchMatting([...selectedIds])}
                >
                  <Wand2 size={14} />
                </IconBtn>
                <IconBtn
                  title={t("批量自动裁边")}
                  disabled={busy}
                  onClick={() => void requestBatchAutoCrop([...selectedIds])}
                >
                  <Scan size={14} />
                </IconBtn>
                <IconBtn title={t("批量导出原图")} disabled={busy} onClick={() => void requestBatchExport("raw")}>
                  <Download size={14} />
                </IconBtn>
                <IconBtn
                  title={t("批量导出抠图（仅已抠图）")}
                  disabled={busy}
                  onClick={() => void requestBatchExport("processed")}
                >
                  <ImageDown size={14} />
                </IconBtn>
                <span className="tb-sep" />
                <IconBtn title={t("取消选择")} disabled={busy} onClick={clearSelection}>
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
              folderId={currentFolderId}
              onClose={() => setImportTab(null)}
              onDone={() => {
                void load();
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
                void load();
                setV((x) => x + 1);
              }}
              onToast={toast}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showPicker && (
            <ProjectPickerModal title={t("导入到项目")} onPick={doImportPick} onClose={() => setShowPicker(false)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {ctxMenu && (ctxBatch || ctxMat) && (
            <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
