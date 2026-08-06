import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Clapperboard, Film, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, frameImageUrl, type Project } from "../api";
import { getLocale, useT } from "../i18n";
import { askConfirm, notify } from "../notice";

export default function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");

  const load = () => api.listProjects().then(setProjects).catch(console.error);
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const { id } = await api.createProject(name.trim());
      setShowModal(false);
      setName("");
      onOpen(id);
    } catch (e) {
      notify(t("创建失败: {msg}", { msg: (e as Error).message }));
    }
  };

  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!(await askConfirm(t("确定删除该项目及其全部帧吗？此操作不可恢复。")))) return;
    await api.deleteProject(id).catch((err) => notify(t("删除失败: {msg}", { msg: (err as Error).message })));
    load();
  };

  return (
    <div className="page">
      <header className="home-header">
        <h1>
          <Clapperboard size={30} /> FrameBaker
        </h1>
        <p className="subtitle">{t("像素逐帧动画编辑器 · 拆帧 / 生成 / 编辑 / 导出精灵表")}</p>
        <motion.button
          type="button"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="px-btn accent"
          onClick={() => setShowModal(true)}
        >
          <Plus size={16} /> {t("新建项目")}
        </motion.button>
      </header>

      {projects.length === 0 ? (
        <div className="empty">
          <Sparkles size={32} />
          <p>{t("还没有项目，点击「新建项目」开始创作吧")}</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p, i) => (
            <motion.div
              key={p.id}
              className="project-card"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06 }}
              whileHover={{ y: -6 }}
              onClick={() => onOpen(p.id)}
            >
              <div className="thumb">
                {p.first_frame_id ? <img src={frameImageUrl(p.first_frame_id)} alt="" /> : <Film size={40} />}
              </div>
              <div className="info">
                <div className="name">{p.name}</div>
                <div className="meta">
                  {t("{n} 帧", { n: p.frame_count ?? 0 })} · {new Date(p.created_at).toLocaleString(getLocale())}
                </div>
              </div>
              <button type="button" className="icon-btn danger card-del" title={t("删除项目")} onClick={(e) => remove(e, p.id)}>
                <Trash2 size={14} />
              </button>
            </motion.div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {showModal && (
          <motion.div
            className="modal-mask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowModal(false)}
          >
            <motion.div
              className="modal pixel-panel"
              initial={{ scale: 0.9, y: 24 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 24 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2>{t("新建项目")}</h2>
              <input
                className="px-input"
                autoFocus
                placeholder={t("项目名称")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
              <div className="modal-actions">
                <button type="button" className="px-btn" onClick={() => setShowModal(false)}>
                  {t("取消")}
                </button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn accent"
                  onClick={create}
                >
                  {t("创建")}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
