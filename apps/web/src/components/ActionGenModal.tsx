import { useState } from "react";
import { motion } from "motion/react";
import { PersonStanding, X } from "lucide-react";
import { ACTION_PRESETS } from "@framebaker/shared";
import { api, materialImageUrl, type Material } from "../api";
import { useServerConfig } from "../config";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import SizePicker from "./SizePicker";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}

/**
 * 多动作生成：以当前素材为引用图（优先抠图后，角色外观由图保持），
 * 按勾选的动作预设逐动作生成帧序列——每个动作一个生成任务（提交即关窗，进度见右侧任务面板），
 * 产出素材按「素材名_动作 #i」命名入库，可再抠图/切分/导入项目
 */
export default function ActionGenModal({ material: m, v, onClose, onToast }: Props) {
  const slot = m.processed_path ? "processed" : "raw";
  // 去掉拆帧/切分遗留的「 #n」序号作为命名基准（与 GridSplitModal 同款处理）
  const base = m.name.replace(/\s*#\d+$/, "").trim() || "素材";
  const [selected, setSelected] = useState<Set<string>>(() => new Set(["idle", "walk"]));
  const [count, setCount] = useState(4);
  const [extra, setExtra] = useState("");
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const cfg = useServerConfig();

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 逐动作调用既有生成接口（复用任务队列/引用图校验），单动作失败不中断整批
  const submit = async () => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    const sel = resolveProviderSelection(cfg?.gen.providers ?? [], providerId, model);
    const suffix = extra.trim();
    const actions = ACTION_PRESETS.filter((a) => selected.has(a.id));
    let firstErr: string | null = null;
    let ok = 0;
    for (const a of actions) {
      try {
        await api.generateMaterial({
          prompt: suffix ? `${a.prompt}, ${suffix}` : a.prompt,
          count,
          autoMatting,
          name: `${base}_${a.label}`,
          referenceMaterialId: m.id,
          ...sel,
          ...(size ? { size } : {}),
        });
        ok++;
      } catch (e) {
        firstErr ??= (e as Error).message; // 如 CLI provider 未配引用图参数名
      }
    }
    if (ok === 0) {
      notify(`提交失败: ${firstErr ?? "未知错误"}`);
      setSubmitting(false);
      return;
    }
    onToast(
      firstErr
        ? `已入队 ${ok}/${actions.length} 个动作（共 ${ok * count} 帧），部分失败: ${firstErr}`
        : `已入队 ${ok} 个动作共 ${ok * count} 帧，进度见右侧任务面板`
    );
    onClose();
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="modal pixel-panel ag-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>多动作生成</h2>
          <IconBtn onClick={onClose} title="关闭">
            <X size={16} />
          </IconBtn>
        </div>

        <div className="hint">
          以「{m.name}」为引用图（{slot === "processed" ? "抠图后" : "原图"}），逐动作生成帧序列；产出素材按「{base}
          _动作 #i」命名入库
        </div>

        {/* 参考图 + 动作预设多选 */}
        <div className="ag-main">
          <div className="ag-ref">
            <img src={materialImageUrl(m.id, v, slot)} alt={m.name} draggable={false} />
            <span className="ag-ref-tag">参考图</span>
          </div>
          <div className="ag-actions">
            {ACTION_PRESETS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`ag-chip ${selected.has(a.id) ? "on" : ""}`}
                disabled={submitting}
                title={a.prompt}
                onClick={() => toggle(a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-row">
          <label>附加描述（可空，拼接到每个动作提示词之后）</label>
          <input
            className="px-input"
            value={extra}
            disabled={submitting}
            placeholder="例如：holding a sword, facing right, pixel art"
            onChange={(e) => setExtra(e.target.value)}
          />
        </div>

        <div className="form-row">
          <label>
            每动作帧数：{count}（{selected.size} 个动作 × {count} 帧 = {selected.size * count} 张）
          </label>
          <input
            type="range"
            min={1}
            max={16}
            value={count}
            disabled={submitting}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </div>

        <ProviderModelPicker providerId={providerId} model={model} onProviderChange={setProviderId} onModelChange={setModel} />
        <SizePicker providerId={providerId} value={size} onChange={setSize} />
        <MattingOption checked={autoMatting} onChange={setAutoMatting} />

        <div className="modal-actions">
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={selected.size === 0 || submitting}
            onClick={submit}
          >
            <PersonStanding size={14} /> {submitting ? "提交中…" : `生成 ${selected.size || ""} 个动作`}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
