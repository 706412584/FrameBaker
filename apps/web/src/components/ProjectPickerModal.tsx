import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Clapperboard, X } from "lucide-react";
import { api, type Project } from "../api";
import { notify } from "../notice";
import IconBtn from "./IconBtn";

interface Props {
  title: string;
  onPick: (projectId: string) => void;
  onClose: () => void;
}

/** 项目选择弹窗：批量/单个导入素材时选择目标项目 */
export default function ProjectPickerModal({ title, onPick, onClose }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => notify(`加载项目失败: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <IconBtn onClick={onClose} title="关闭">
            <X size={16} />
          </IconBtn>
        </div>
        {loading ? (
          <div className="empty">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="empty">还没有项目，请先到「项目」页新建</div>
        ) : (
          <div className="picker-list">
            {projects.map((p) => (
              <button key={p.id} type="button" className="picker-row" onClick={() => onPick(p.id)}>
                <Clapperboard size={14} />
                <span className="picker-name">{p.name}</span>
                <span className="picker-meta">{p.frame_count} 帧</span>
              </button>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
