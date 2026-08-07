import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Clapperboard, Film, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, frameImageUrl, wsClient, type Folder, type Project } from "../api";
import { getLocale, useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import { useModalEscClose } from "../hooks/useModalEscClose";
import FolderTree, { type FolderSelection } from "./FolderTree";
import FileZoom, { useFileZoom } from "./FileZoom";

export default function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderSel, setFolderSel] = useState<FolderSelection>("all");
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");
  const [zoom, setZoom] = useFileZoom();
  useModalEscClose(() => setShowModal(false), showModal);

  const loadFolders = useCallback(async () => {
    try {
      setFolders(await api.listFolders("project"));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadFolders();
    const unsub = wsClient.subscribe((msg) => {
      if (msg.type === "folders_changed") {
        const p = msg.payload as { kind?: string } | undefined;
        if (!p?.kind || p.kind === "project") void loadFolders();
      }
    });
    return unsub;
  }, [load, loadFolders]);

  const visible = useMemo(() => {
    if (folderSel === "all") return projects;
    if (folderSel === "ungrouped") return projects.filter((p) => !p.folder_id);
    return projects.filter((p) => p.folder_id === folderSel);
  }, [projects, folderSel]);

  const currentFolderId = folderSel !== "all" && folderSel !== "ungrouped" ? folderSel : null;

  const create = async () => {
    if (!name.trim()) return;
    try {
      const { id } = await api.createProject(name.trim(), currentFolderId);
      setShowModal(false);
      setName("");
      onOpen(id);
    } catch (e) {
      notify(t("msg.create_failed_msg", { msg: (e as Error).message }));
    }
  };

  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!(await askConfirm(t("msg.delete_this_project_and_all_its_frames_this_cannot_be_un")))) return;
    await api.deleteProject(id).catch((err) => notify(t("msg.delete_failed_msg", { msg: (err as Error).message })));
    load();
  };

  const moveToFolder = async (folderId: string | null, ids: string[]) => {
    const name =
      folderId == null ? t("msg.ungrouped") : (folders.find((f) => f.id === folderId)?.name ?? folderId);
    if (!(await askConfirm(t("msg.move_n_projects_to_name", { n: ids.length, name })))) return;
    try {
      await api.moveItems("project", ids, folderId);
      await load();
    } catch (e) {
      notify(t("msg.operation_failed_msg", { msg: (e as Error).message }));
    }
  };

  return (
    <div className="page page-with-folders">
      <FolderTree
        kind="project"
        folders={folders}
        selected={folderSel}
        onSelect={setFolderSel}
        onCreate={async (folderName, parentId) => {
          await api.createFolder("project", folderName, parentId);
          await loadFolders();
        }}
        onRename={async (id, folderName) => {
          await api.patchFolder(id, { name: folderName });
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
        onDropItems={(folderId, ids) => void moveToFolder(folderId, ids)}
      />

      <div className="folder-content">
        <header className="home-header">
          <h1>
            <Clapperboard size={30} /> FrameBaker
          </h1>
          <p className="subtitle">{t("msg.pixel_frame_by_frame_editor_extract_generate_edit_export")}</p>
          <motion.button
            type="button"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            onClick={() => setShowModal(true)}
          >
            <Plus size={16} /> {t("msg.new_project")}
          </motion.button>
          <FileZoom value={zoom} onChange={setZoom} />
        </header>

        <div className="folder-main">
          {projects.length === 0 ? (
            <div className="empty">
              <Sparkles size={32} />
              <p>{t("msg.no_projects_yet_click_new_project_to_start")}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <Clapperboard size={32} />
              <p>{t("msg.no_projects_in_this_folder")}</p>
            </div>
          ) : (
            <div className="file-grid" style={{ ["--tile-min" as string]: `${zoom}px` }}>
              {visible.map((p, i) => (
                <motion.div
                  key={p.id}
                  className="project-card"
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.06, 0.4) }}
                  whileHover={{ y: -6 }}
                  draggable
                  onDragStart={(e) => {
                    const de = e as unknown as React.DragEvent;
                    de.dataTransfer.setData("application/x-framebaker-ids", JSON.stringify([p.id]));
                    de.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onOpen(p.id)}
                >
                  <div className="thumb">
                    {p.first_frame_id ? <img src={frameImageUrl(p.first_frame_id)} alt="" draggable={false} /> : <Film size={40} />}
                  </div>
                  <div className="info">
                    <div className="name">{p.name}</div>
                    <div className="meta">
                      {t("msg.n_frames", { n: p.frame_count ?? 0 })} · {new Date(p.created_at).toLocaleString(getLocale())}
                    </div>
                  </div>
                  <button type="button" className="icon-btn danger card-del" title={t("msg.delete_project")} onClick={(e) => remove(e, p.id)}>
                    <Trash2 size={14} />
                  </button>
                </motion.div>
              ))}
            </div>
          )}
        </div>

      <AnimatePresence>
        {showModal && (
          <motion.div
            className="modal-mask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="modal pixel-panel"
              initial={{ scale: 0.9, y: 24 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 24 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2>{t("msg.new_project")}</h2>
              <input
                className="px-input"
                autoFocus
                placeholder={t("msg.project_name")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
              <div className="modal-actions">
                <button type="button" className="px-btn" onClick={() => setShowModal(false)}>
                  {t("common.cancel")}
                </button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn accent"
                  onClick={create}
                >
                  {t("msg.create")}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
