import { Images, LayoutGrid, X } from "lucide-react";
import { motion } from "motion/react";
import type { AnimationExportFormat } from "../export";
import { useT } from "../i18n";
import IconBtn from "./IconBtn";

interface Props {
  exporting: boolean;
  onExport: (format: AnimationExportFormat) => void;
  onClose: () => void;
}

/** 动画导出格式选择：独立 PNG 序列或自动换行的单张精灵图。 */
export default function ExportAnimationModal({ exporting, onExport, onClose }: Props) {
  const t = useT();
  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && !exporting && onClose()}>
      <motion.div className="modal export-animation-modal pixel-panel" initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }}>
        <div className="modal-title-row">
          <h2>{t("exportAnimation.title")}</h2>
          <IconBtn disabled={exporting} onClick={onClose}><X size={16} /></IconBtn>
        </div>
        <button type="button" className="export-format-card" disabled={exporting} onClick={() => onExport("sequence")}>
          <Images size={28} />
          <span><strong>{t("exportAnimation.sequence")}</strong><small>{t("exportAnimation.sequenceHint")}</small></span>
        </button>
        <button type="button" className="export-format-card" disabled={exporting} onClick={() => onExport("spritesheet")}>
          <LayoutGrid size={28} />
          <span><strong>{t("exportAnimation.spritesheet")}</strong><small>{t("exportAnimation.spritesheetHint")}</small></span>
        </button>
        {exporting && <p className="muted">{t("exportAnimation.exporting")}</p>}
      </motion.div>
    </motion.div>
  );
}
