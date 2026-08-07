import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Download, Eye, Film, ImageDown, Package, Play, Scan, Send, Sparkles, Trash2, Upload, Wand2, X } from "lucide-react";
import { SOURCE_COLORS } from "@framebaker/shared";
import { api, materialFileUrl, materialImageUrl, wsClient, type Folder, type Material } from "../api";
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
import VideoExtractModal from "./VideoExtractModal";
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
  const [extractId, setExtractId] = useState<string | null>(null);
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
      toast(t("msg.deleted_count_materials", { count: r.deleted }));
    } catch (e) {
      notify(t("msg.delete_failed_msg", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const requestBatchDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!(await askConfirm(t("msg.delete_n_selected_materials_this_cannot_be_undone", { n: ids.length })))) return;
    await deleteMaterials(ids);
  };

  // 批量抠图：只对未抠图入队（已抠图跳过；详情页仍可重新抠）
  const requestBatchMatting = async (ids: string[]) => {
    const rawIds = materials.filter((m) => ids.includes(m.id) && m.status !== "matted").map((m) => m.id);
    if (rawIds.length === 0) {
      notify(t("msg.all_selected_are_already_matted_open_detail_to_rematte"), "info");
      return;
    }
    if (!(await askConfirm(t("msg.queue_matting_for_n_unmatted_materials", { n: rawIds.length })))) return;
    setBusy(true);
    try {
      const r = await api.batchMatteMaterials(rawIds);
      const msg =
        r.skipped > 0
          ? t("msg.queued_count_matting_jobs_skipped_skipped_already_matted", { count: r.count, skipped: r.skipped })
          : t("msg.queued_count_matting_jobs", { count: r.count });
      toast(msg);
    } catch (e) {
      notify(t("msg.matting_failed_msg", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const openImportPicker = async (scope: "batch" | string) => {
    const n = scope === "batch" ? selectedIds.size : 1;
    if (n === 0) return;
    if (!(await askConfirm(t("msg.import_n_materials_into_a_project", { n })))) return;
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
      toast(t("msg.imported_count_materials_into_project", { count: r.count }));
    } catch (e) {
      notify(t("msg.import_failed_msg", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const moveSelectedTo = async (folderId: string | null, ids: string[]) => {
    const name =
      folderId == null ? t("msg.ungrouped") : (folders.find((f) => f.id === folderId)?.name ?? folderId);
    if (!(await askConfirm(t("msg.move_n_materials_to_name", { n: ids.length, name })))) return;
    try {
      await api.moveItems("material", ids, folderId);
      await load();
      toast(t("msg.moved_count_materials", { count: ids.length }));
    } catch (e) {
      notify(t("msg.operation_failed_msg", { msg: (e as Error).message }));
    }
  };

  const matteOne = async (id: string, rematte: boolean) => {
    const msg = rematte ? t("msg.re_matte_this_material") : t("msg.queue_matting_for_this_material");
    if (!(await askConfirm(msg))) return;
    setBusy(true);
    try {
      // 单条走详情同款接口，已抠图也可重新抠（批量接口会跳过已抠图）
      await api.matteMaterial(id);
      toast(t("msg.matting_job_queued"));
    } catch (e) {
      notify(t("msg.matting_failed_msg", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const requestBatchExport = async (slot: "raw" | "processed") => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const label = slot === "processed" ? t("msg.matting") : t("msg.original");
    if (!(await askConfirm(t("msg.export_slot_for_n_selected_materials", { n: ids.length, slot: label })))) return;
    const items = materials
      .filter((m) => ids.includes(m.id))
      .map((m) => ({ id: m.id, name: m.name, processed: !!m.processed_path }));
    setBusy(true);
    try {
      const r = await downloadMaterialImages(items, slot, v);
      if (r.ok === 0 && r.skipped > 0) {
        notify(t("msg.none_of_the_selected_materials_have_a_matted_image"), "info");
      } else {
        toast(
          r.skipped > 0 || r.failed > 0
            ? t("msg.exported_ok_skipped_skipped_failed_failed", {
                ok: r.ok,
                skipped: r.skipped,
                failed: r.failed,
              })
            : t("msg.exported_ok", { ok: r.ok })
        );
      }
    } finally {
      setBusy(false);
    }
  };

  /** 批量自动裁透明边：对当前显示槽位（processed 优先）找不透明包围盒后写回 */
  const requestBatchAutoCrop = async (ids: string[]) => {
    if (ids.length === 0) return;
    if (!(await askConfirm(t("msg.auto_trim_transparent_edges_on_n_selected_materials", { n: ids.length })))) return;
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
        t("msg.auto_trimmed_ok_skipped_skipped_failed_failed", { ok, skipped, failed })
      );
    } finally {
      setBusy(false);
    }
  };

  const detail = detailId ? (materials.find((m) => m.id === detailId) ?? null) : null;
  const extractMat = extractId ? (materials.find((m) => m.id === extractId) ?? null) : null;

  const ctxMat = ctxMenu ? (materials.find((m) => m.id === ctxMenu.materialId) ?? null) : null;
  const ctxBatch = ctxMenu != null && selectedIds.size >= 2 && selectedIds.has(ctxMenu.materialId);
  const ctxItems: CtxMenuItem[] = !ctxMenu
    ? []
    : ctxBatch
      ? [
          {
            label: t("msg.import_to_project_n", { n: selectedIds.size }),
            icon: <Send size={13} />,
            onClick: () => void openImportPicker("batch"),
          },
          {
            label: t("msg.batch_matte_n", { n: selectedIds.size }),
            icon: <Wand2 size={13} />,
            onClick: () => void requestBatchMatting([...selectedIds]),
          },
          {
            label: t("msg.auto_trim_n", { n: selectedIds.size }),
            icon: <Scan size={13} />,
            onClick: () => void requestBatchAutoCrop([...selectedIds]),
          },
          {
            label: t("msg.export_original_n", { n: selectedIds.size }),
            icon: <Download size={13} />,
            onClick: () => void requestBatchExport("raw"),
          },
            {
              label: t("msg.export_matted_n", { n: selectedIds.size }),
              icon: <ImageDown size={13} />,
              onClick: () => void requestBatchExport("processed"),
            },
          {
            label: t("msg.delete_n_materials", { n: selectedIds.size }),
            icon: <Trash2 size={13} />,
            danger: true,
            onClick: () => void requestBatchDelete(),
          },
        ]
      : ctxMat
        ? [
            {
              label: t("msg.open_details"),
              icon: <Eye size={13} />,
              onClick: () => setDetailId(ctxMat.id),
            },
            ...(ctxMat.kind === "video"
              ? ([
                  {
                    label: t("videoExtract.open"),
                    icon: <Film size={13} />,
                    onClick: () => setExtractId(ctxMat.id),
                  },
                ] satisfies CtxMenuItem[])
              : ([
                  {
                    label: t("msg.import_to_project"),
                    icon: <Send size={13} />,
                    onClick: () => void openImportPicker(ctxMat.id),
                  },
                  {
                    label: ctxMat.status === "matted" ? t("msg.re_matte") : t("msg.matting"),
                    icon: <Wand2 size={13} />,
                    onClick: () => void matteOne(ctxMat.id, ctxMat.status === "matted"),
                  },
                  {
                    label: t("msg.auto_trim"),
                    icon: <Scan size={13} />,
                    onClick: () => void requestBatchAutoCrop([ctxMat.id]),
                  },
                  {
                    label: t("msg.export_original"),
                    icon: <Download size={13} />,
                    onClick: async () => {
                      try {
                        await downloadMaterialImage(ctxMat.id, ctxMat.name, "raw", v);
                        toast(t("msg.original_exported"));
                      } catch (e) {
                        notify(t("msg.export_failed_msg", { msg: (e as Error).message }));
                      }
                    },
                  },
                  {
                    label: t("msg.export_matted"),
                    icon: <ImageDown size={13} />,
                    disabled: !ctxMat.processed_path,
                    onClick: async () => {
                      try {
                        await downloadMaterialImage(ctxMat.id, ctxMat.name, "processed", v);
                        toast(t("msg.matted_image_exported"));
                      } catch (e) {
                        notify(t("msg.export_failed_msg", { msg: (e as Error).message }));
                      }
                    },
                  },
                ] satisfies CtxMenuItem[])),
            {
              label: t("msg.delete_material"),
              icon: <Trash2 size={13} />,
              danger: true,
              onClick: async () => {
                if (!(await askConfirm(t("msg.delete_this_material_this_cannot_be_undone")))) return;
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
          <div className="home-header-copy">
            <span className="page-kicker">{t("page.assetsWorkspace")}</span>
            <h1>
              <Package size={28} /> {t("msg.materials")}
            </h1>
            <p className="subtitle">
              {t("msg.count_materials_generate_upload_matte_review_import_mod", {
                count: visible.length,
                mod: isMac ? "Cmd" : "Ctrl",
              })}
            </p>
          </div>
          <div className="home-header-actions">
            <div className="mat-actions">
              <motion.button
                type="button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.96 }}
                className="px-btn"
                onClick={() => setImportTab("upload")}
              >
                <Upload size={16} /> {t("msg.upload_materials")}
              </motion.button>
              <motion.button
                type="button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.96 }}
                className="px-btn accent"
                onClick={() => setImportTab("cli")}
              >
                <Sparkles size={16} /> {t("msg.ai_generate")}
              </motion.button>
            </div>
            <FileZoom value={zoom} onChange={setZoom} />
          </div>
        </header>

        <div className="folder-main">
          {materials.length === 0 ? (
            <div className="empty">
              <Package size={32} />
              <p>{t("msg.materials_empty_upload_or_ai_generate_some_first")}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <Package size={32} />
              <p>{t("msg.no_materials_in_this_folder")}</p>
            </div>
          ) : (
            <div className="file-grid" style={{ ["--tile-min" as string]: `${zoom}px` }}>
              {visible.map((m) => (
                <motion.div
                  key={m.id}
                  className={`project-card mat-card ${selectedIds.has(m.id) ? "selected" : ""}`}
                  whileHover={{ y: -4 }}
                  whileTap={{ scale: 0.985 }}
                  layout
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
                    {m.kind === "video" ? (
                      <>
                        <video src={materialFileUrl(m.id, v, "raw")} muted playsInline preload="metadata" draggable={false} />
                        <span className="mat-video-play">
                          <Play size={18} fill="currentColor" />
                        </span>
                      </>
                    ) : (
                      <img src={materialImageUrl(m.id, v)} alt="" draggable={false} loading="lazy" />
                    )}
                    <span
                      className={`mat-check ${selectedIds.has(m.id) ? "on" : ""}`}
                      title={t("msg.select_70b208")}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleOne(m.id);
                      }}
                    >
                      {selectedIds.has(m.id) && <Check size={12} />}
                    </span>
                    {m.kind === "video" && <span className="mat-badge-video">{t("msg.video")}</span>}
                    {m.status === "matted" && <span className="mat-badge-matted">{t("msg.matted_431ee1")}</span>}
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
                <span className="batch-count">{t("msg.count_materials_selected", { count: selectedIds.size })}</span>
                <span className="tb-sep" />
                <IconBtn className="danger" title={t("msg.batch_delete")} disabled={busy} onClick={() => void requestBatchDelete()}>
                  <Trash2 size={14} />
                </IconBtn>
                <IconBtn title={t("msg.import_to_project")} disabled={busy} onClick={() => void openImportPicker("batch")}>
                  <Send size={14} />
                </IconBtn>
                <IconBtn
                  title={t("msg.batch_matte_raw_only")}
                  disabled={busy}
                  onClick={() => void requestBatchMatting([...selectedIds])}
                >
                  <Wand2 size={14} />
                </IconBtn>
                <IconBtn
                  title={t("msg.batch_auto_trim")}
                  disabled={busy}
                  onClick={() => void requestBatchAutoCrop([...selectedIds])}
                >
                  <Scan size={14} />
                </IconBtn>
                <IconBtn title={t("msg.batch_export_original")} disabled={busy} onClick={() => void requestBatchExport("raw")}>
                  <Download size={14} />
                </IconBtn>
                <IconBtn
                  title={t("msg.batch_export_matted_matted_only")}
                  disabled={busy}
                  onClick={() => void requestBatchExport("processed")}
                >
                  <ImageDown size={14} />
                </IconBtn>
                <span className="tb-sep" />
                <IconBtn title={t("msg.clear_selection")} disabled={busy} onClick={clearSelection}>
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
          {extractMat && (
            <VideoExtractModal
              material={extractMat}
              v={v}
              onClose={() => setExtractId(null)}
              onToast={(msg) => {
                toast(msg);
                void load();
                setV((x) => x + 1);
              }}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showPicker && (
            <ProjectPickerModal title={t("msg.import_to_project")} onPick={doImportPick} onClose={() => setShowPicker(false)} />
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
