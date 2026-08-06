import { useState } from "react";
import { motion } from "motion/react";
import { Grid3x3, X } from "lucide-react";
import { api, materialImageUrl, type Material } from "../api";
import { cropImage } from "../imageops/client";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string) => void;
}

const clampCell = (n: number) => Math.max(1, Math.min(8, Math.floor(n) || 1));

/**
 * 多宫格精灵图网格切分：等分行×列 + 网格线实时预览，
 * 确认后逐格切成独立素材入库（可再抠图/剪裁/导入项目），原素材保留
 */
export default function GridSplitModal({ material: m, v, onClose, onDone, onToast }: Props) {
  const slot = m.processed_path ? "processed" : "raw";
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const total = rows * cols;

  const split = async () => {
    if (busy) return;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error("读取素材图片失败");
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const W = bitmap.width;
      const H = bitmap.height;
      bitmap.close();
      if (W < cols || H < rows) throw new Error(`图片 ${W}×${H} 小于网格 ${cols}×${rows}`);
      const cw = Math.floor(W / cols);
      const ch = Math.floor(H / rows);
      const base = m.name.replace(/\s*#\d+$/, "").trim() || "素材";
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c + 1;
          setProgress(`切分上传中 ${i}/${total}`);
          try {
            // 等分整数像素，右/下边缘吃掉余数
            const w = c === cols - 1 ? W - cw * c : cw;
            const h = r === rows - 1 ? H - ch * r : ch;
            const cell = await cropImage(blob, { x: cw * c, y: ch * r, w, h });
            const fd = new FormData();
            fd.append("file", cell, `${base}_r${r + 1}c${c + 1}.png`);
            fd.append("autoMatting", String(autoMatting));
            await api.uploadMaterial(fd);
            ok++;
          } catch {
            fail++; // 单格失败不中断整批
          }
        }
      }
      onDone();
      onToast(fail ? `切分完成：成功 ${ok} / 失败 ${fail}` : `已切出 ${ok} 个素材`);
      onClose();
    } catch (e) {
      notify(`切分失败: ${(e as Error).message}`);
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel gs-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>网格切分</h2>
          <IconBtn onClick={onClose} title="关闭">
            <X size={16} />
          </IconBtn>
        </div>

        <div className="hint">作用于：{slot === "processed" ? "抠图后" : "原图"} · 逐格切成独立素材，原素材保留</div>

        {/* 网格线预览：行列实时可调 */}
        <div className="gs-wrap">
          <img src={materialImageUrl(m.id, v, slot)} alt={m.name} draggable={false} />
          {Array.from({ length: cols - 1 }, (_, i) => (
            <div key={`v${i}`} className="gs-line v" style={{ left: `${((i + 1) / cols) * 100}%` }} />
          ))}
          {Array.from({ length: rows - 1 }, (_, i) => (
            <div key={`h${i}`} className="gs-line h" style={{ top: `${((i + 1) / rows) * 100}%` }} />
          ))}
        </div>

        <div className="form-inline">
          <label className="px-check">
            列数
            <input
              className="px-input num"
              type="number"
              min={1}
              max={8}
              value={cols}
              disabled={busy}
              onChange={(e) => setCols(clampCell(Number(e.target.value)))}
            />
          </label>
          <label className="px-check">
            行数
            <input
              className="px-input num"
              type="number"
              min={1}
              max={8}
              value={rows}
              disabled={busy}
              onChange={(e) => setRows(clampCell(Number(e.target.value)))}
            />
          </label>
          <span className="gs-total">共 {total} 格</span>
        </div>

        <MattingOption checked={autoMatting} onChange={setAutoMatting} />

        <div className="modal-actions">
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={busy}
            onClick={split}
          >
            <Grid3x3 size={14} /> {busy ? progress || "切分中…" : `切成 ${total} 个素材`}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
