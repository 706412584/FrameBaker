import { Brush, ClipboardCopy, ClipboardPaste, Crosshair, Minus, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { ATTACK_EFFECT_BRUSHES, type AttackEffect, type AttackEffectBrush, type AttackEffectStyle } from "@framebaker/shared";
import { createAttackEffect } from "../attackEffect";
import { normalizeFrameRotation } from "../frameGeometry";
import { useT } from "../i18n";
import AttackEffectPreview from "./AttackEffectPreview";
import IconBtn from "./IconBtn";
import PxSelect from "./PxSelect";
import Tooltip from "./Tooltip";

interface Props {
  effect: AttackEffect | null;
  disabled: boolean;
  drawing: boolean;
  color: string;
  size: number;
  brush: AttackEffectBrush;
  canPaste: boolean;
  onToggleDrawing: () => void;
  onColor: (color: string) => void;
  onSize: (size: number) => void;
  onBrush: (brush: AttackEffectBrush) => void;
  onChange: (effect: AttackEffect | null) => void;
  onCopy: (effect: AttackEffect) => void;
  onPaste: () => void;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 当前时间轴单元格的攻击特效工具：绘制、样式、整体变换及跨步骤复制。 */
export default function AttackEffectToolbar(props: Props) {
  const { effect, disabled, drawing, color, size, brush, canPaste, onToggleDrawing, onColor, onSize, onBrush, onChange, onCopy, onPaste } = props;
  const t = useT();
  const patchEffect = (next: AttackEffect | null) => onChange(next);
  const style = effect?.style ?? "flame";

  return (
    <div className="attack-toolbar pixel-bar">
      <span className="attack-title">{t("attackEffect.title")}</span>
      <Tooltip text={t(drawing ? "attackEffect.stopDrawing" : "attackEffect.startDrawing")}>
        <IconBtn className={drawing ? "on" : ""} disabled={disabled} onClick={onToggleDrawing}>
          <Brush size={15} />
        </IconBtn>
      </Tooltip>
      <AttackEffectPreview color={color} size={size} style={style} brush={brush} />
      <PxSelect
        className="attack-style"
        value={style}
        disabled={disabled}
        options={(["flame", "energy", "ink"] as AttackEffectStyle[]).map((nextStyle) => ({
          value: nextStyle,
          label: t(`attackEffect.style.${nextStyle}`),
        }))}
        onChange={(nextStyle) => patchEffect({ ...(effect ?? createAttackEffect()), style: nextStyle as AttackEffectStyle })}
      />
      <PxSelect
        className="attack-style attack-brush"
        value={brush}
        disabled={disabled}
        options={ATTACK_EFFECT_BRUSHES.map((nextBrush) => ({
          value: nextBrush,
          label: t(`attackEffect.brush.${nextBrush}`),
        }))}
        onChange={(nextBrush) => onBrush(nextBrush as AttackEffectBrush)}
      />
      <label className="attack-color" title={t("attackEffect.color")}>
        <input type="color" value={color} disabled={disabled} onChange={(event) => onColor(event.target.value)} />
      </label>
      <span className="attack-value">{t("attackEffect.brushSize")} {size}</span>
      <input
        className="attack-size-range"
        type="range"
        min="2"
        max="256"
        step="2"
        value={Math.min(256, Math.max(2, size))}
        disabled={disabled}
        aria-label={t("attackEffect.brushSize")}
        onChange={(event) => onSize(Number(event.target.value))}
      />
      <IconBtn disabled={disabled || size <= 1} onClick={() => onSize(Math.max(1, size - 2))}><Minus size={12} /></IconBtn>
      <IconBtn disabled={disabled || size >= 256} onClick={() => onSize(Math.min(256, size + 2))}><Plus size={12} /></IconBtn>
      <span className="tb-sep" />
      <Tooltip text={t("attackEffect.undoStroke")}>
        <IconBtn disabled={disabled || !effect?.strokes.length} onClick={() => effect && patchEffect({ ...effect, strokes: effect.strokes.slice(0, -1) })}>
          <Undo2 size={14} />
        </IconBtn>
      </Tooltip>
      <button className="px-btn danger attack-delete" disabled={disabled || !effect} onClick={() => patchEffect(null)} title={t("attackEffect.deleteHint")}>
        <Trash2 size={13} /> {t("attackEffect.delete")}
      </button>
      <Tooltip text={t("attackEffect.copy")}>
        <IconBtn disabled={!effect?.strokes.length} onClick={() => effect && onCopy(effect)}><ClipboardCopy size={14} /></IconBtn>
      </Tooltip>
      <Tooltip text={t("attackEffect.paste")}>
        <IconBtn disabled={disabled || !canPaste} onClick={onPaste}><ClipboardPaste size={14} /></IconBtn>
      </Tooltip>
      <span className="tb-sep" />
      <span className="attack-value">{t("transform.scale")} {Math.round((effect?.scale ?? 1) * 100)}%</span>
      <IconBtn disabled={disabled || !effect || effect.scale <= 0.1} onClick={() => effect && patchEffect({ ...effect, scale: round(clamp(effect.scale - 0.1, 0.1, 8)) })}><Minus size={12} /></IconBtn>
      <IconBtn disabled={disabled || !effect || effect.scale >= 8} onClick={() => effect && patchEffect({ ...effect, scale: round(clamp(effect.scale + 0.1, 0.1, 8)) })}><Plus size={12} /></IconBtn>
      <Tooltip text={t("attackEffect.rotate")}>
        <IconBtn disabled={disabled || !effect} onClick={() => effect && patchEffect({ ...effect, rotation: normalizeFrameRotation(effect.rotation + Math.PI / 12) })}><RotateCcw size={14} /></IconBtn>
      </Tooltip>
      <span className="attack-value">{t("transform.opacity")} {Math.round((effect?.opacity ?? 1) * 100)}%</span>
      <IconBtn disabled={disabled || !effect || effect.opacity <= 0} onClick={() => effect && patchEffect({ ...effect, opacity: round(clamp(effect.opacity - 0.1, 0, 1)) })}><Minus size={12} /></IconBtn>
      <IconBtn disabled={disabled || !effect || effect.opacity >= 1} onClick={() => effect && patchEffect({ ...effect, opacity: round(clamp(effect.opacity + 0.1, 0, 1)) })}><Plus size={12} /></IconBtn>
      <Tooltip text={t("attackEffect.center")}>
        <IconBtn disabled={disabled || !effect || (effect.offset_x === 0 && effect.offset_y === 0)} onClick={() => effect && patchEffect({ ...effect, offset_x: 0, offset_y: 0 })}><Crosshair size={14} /></IconBtn>
      </Tooltip>
      <span className="attack-help">{t(drawing ? "attackEffect.drawHint" : "attackEffect.moveHint")}</span>
    </div>
  );
}
