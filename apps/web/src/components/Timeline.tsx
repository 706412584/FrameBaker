import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, LockOpen, Plus, Sparkles, Trash2 } from "lucide-react";
import { frameImageUrl, type AnimationAxis, type AnimationTrack, type AttackEffectCell, type Frame, type TimelineStep } from "../api";
import { useT } from "../i18n";
import IconBtn from "./IconBtn";
import PxSelect from "./PxSelect";

interface Props {
  axes: AnimationAxis[]; axis: AnimationAxis; tracks: AnimationTrack[]; steps: TimelineStep[]; frames: Frame[]; effects: AttackEffectCell[];
  activeTrackId: string | null; activeStepId: string | null; activeId: string | null; v: number; height?: number;
  onAxis: (id: string) => void; onAddAxis: () => void; onDeleteAxis: () => void;
  onCell: (trackId: string, stepId: string, frameId: string | null) => void;
  onMoveCell: (frameId: string, trackId: string, stepId: string, copy?: boolean) => void;
  onPlaceBatch: (frameIds: string[], trackId: string, stepId?: string) => void;
  onAddTrack: () => void; onPatchTrack: (track: AnimationTrack, patch: Partial<AnimationTrack>) => void;
  onDeleteTrack: (track: AnimationTrack) => void; onMoveTrack: (track: AnimationTrack, delta: number) => void;
  onAddStep: () => void; onDeleteStep: () => void; onReorderSteps: (from: number, to: number) => void; onStepDuration: (duration: number) => void;
  onContextMenu: (id: string, pos: { x: number; y: number }) => void;
}

export default function Timeline(p: Props) {
  const t = useT(); const dragFrom = useRef<number | null>(null);
  const frameDrag = useRef<{ frameId: string; trackId: string; stepId: string; copy?: boolean } | null>(null);
  const [draggingFrameId, setDraggingFrameId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rows = [...p.tracks].sort((a, b) => b.idx - a.idx);
  const cells = useMemo(
    () => new Map(p.frames.filter((f) => f.track_id && f.step_id).map((f) => [`${f.track_id}:${f.step_id}`, f] as const)),
    [p.frames]
  );
  const effects = useMemo(() => new Map(p.effects.map((effect) => [`${effect.track_id}:${effect.step_id}`, effect] as const)), [p.effects]);
  const assetFrameIds = (dataTransfer: DataTransfer): string[] => {
    try {
      const payload = JSON.parse(dataTransfer.getData("application/x-framebaker-frame-cell"));
      return Array.isArray(payload?.frameIds) ? payload.frameIds.filter((id: unknown): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  return <footer className="timeline timeline-matrix pixel-bar" style={p.height ? { height: p.height } : undefined}>
    <div className="tl-controls">
      <div className="tl-axis-picker">
        <span>{t("timeline.axis")}</span>
        <PxSelect
          className="tl-axis-select"
          value={p.axis.id}
          options={p.axes.map((axis) => ({ value: axis.id, label: axis.name }))}
          onChange={p.onAxis}
        />
      </div>
      <IconBtn title={t("timeline.addAxis")} onClick={p.onAddAxis}><Plus size={13}/></IconBtn>
      <IconBtn title={t("timeline.deleteAxis")} disabled={p.axes.length <= 1} onClick={p.onDeleteAxis}><Trash2 size={13}/></IconBtn>
      <span>{t("timeline.backToFront")}</span>
      <button className="px-btn" onClick={p.onAddTrack}><Plus size={13}/>{t("timeline.addTrack")}</button>
      <button className="px-btn" onClick={p.onAddStep}><Plus size={13}/>{t("timeline.addStep")}</button>
      <button className="px-btn" disabled={!p.activeStepId} onClick={p.onDeleteStep}><Trash2 size={13}/>{t("timeline.deleteStep")}</button>
      <button className="px-btn" disabled={!p.activeStepId} onClick={()=>p.onStepDuration(Math.max(1,(p.steps.find(s=>s.id===p.activeStepId)?.duration??1)-1))}>− {t("timeline.duration")}</button>
      <button className="px-btn" disabled={!p.activeStepId} onClick={()=>p.onStepDuration(Math.min(600,(p.steps.find(s=>s.id===p.activeStepId)?.duration??1)+1))}>+ {t("timeline.duration")}</button>
    </div>
    <div className="tl-grid" style={{ gridTemplateColumns: `190px repeat(${p.steps.length}, 64px)` }}>
      <div className="tl-corner">{t("timeline.topmostFirst")}</div>
      {p.steps.map((s, i) => <div key={s.id} className={`tl-step ${s.id === p.activeStepId ? "active" : ""}`} draggable onDragStart={() => { dragFrom.current = i; }} onDragOver={(e) => e.preventDefault()} onDrop={() => { const from=dragFrom.current; dragFrom.current=null; if(from != null && from !== i) p.onReorderSteps(from,i); }}>#{i+1}<small>×{s.duration}</small></div>)}
      {rows.map((track) => <div className="tl-row" key={track.id} style={{ display: "contents" }}>
        <div
          className={`tl-track ${track.id === p.activeTrackId ? "active" : ""} ${dropTarget === `track:${track.id}` ? "drop-target" : ""}`}
          onDragOver={(e) => {
            if (track.locked || frameDrag.current || !Array.from(e.dataTransfer.types).includes("application/x-framebaker-frame-cell")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropTarget(`track:${track.id}`);
          }}
          onDragLeave={() => setDropTarget((current) => current === `track:${track.id}` ? null : current)}
          onDrop={(e) => {
            e.preventDefault();
            setDropTarget(null);
            if (track.locked || frameDrag.current) return;
            const frameIds = assetFrameIds(e.dataTransfer);
            if (frameIds.length) p.onPlaceBatch(frameIds, track.id);
          }}
        >
          <span title={track.name}>{track.name}</span>
          <IconBtn title={track.visible ? t("timeline.hideTrack") : t("timeline.showTrack")} onClick={() => p.onPatchTrack(track,{visible:track.visible?0:1})}>{track.visible?<Eye size={12}/>:<EyeOff size={12}/>}</IconBtn>
          <IconBtn title={track.locked ? t("timeline.unlockTrack") : t("timeline.lockTrack")} onClick={() => p.onPatchTrack(track,{locked:track.locked?0:1})}>{track.locked?<Lock size={12}/>:<LockOpen size={12}/>}</IconBtn>
          <IconBtn title={t("timeline.raiseTrack")} onClick={() => p.onMoveTrack(track,1)}><ArrowUp size={12}/></IconBtn>
          <IconBtn title={t("timeline.lowerTrack")} onClick={() => p.onMoveTrack(track,-1)}><ArrowDown size={12}/></IconBtn>
          {!track.is_primary && <IconBtn title={t("timeline.deleteTrack")} onClick={() => p.onDeleteTrack(track)}><Trash2 size={12}/></IconBtn>}
        </div>
        {p.steps.map((step) => {
          const f=cells.get(`${track.id}:${step.id}`) ?? null; const effect=effects.get(`${track.id}:${step.id}`) ?? null; const targetKey=`${track.id}:${step.id}`;
          return <div
            key={step.id}
            className={`tl-cell ${track.id===p.activeTrackId&&step.id===p.activeStepId?"active":""} ${effect?"has-effect":""} ${f&&!track.locked?"draggable":""} ${f?.id===draggingFrameId?"dragging":""} ${dropTarget===targetKey?"drop-target":""}`}
            draggable={!!f&&!track.locked}
            onDragStart={(e)=>{if(!f||track.locked){e.preventDefault();return;}frameDrag.current={frameId:f.id,trackId:track.id,stepId:step.id};setDraggingFrameId(f.id);e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("application/x-framebaker-frame-cell",JSON.stringify(frameDrag.current));}}
            onDragOver={(e)=>{if(!track.locked&&(frameDrag.current||Array.from(e.dataTransfer.types).includes("application/x-framebaker-frame-cell"))){e.preventDefault();e.dataTransfer.dropEffect=frameDrag.current?"move":"copy";setDropTarget(targetKey);}}}
            onDragLeave={()=>setDropTarget((current)=>current===targetKey?null:current)}
            onDrop={(e)=>{e.preventDefault();const reset=()=>{frameDrag.current=null;setDraggingFrameId(null);setDropTarget(null);};if(frameDrag.current){const s=frameDrag.current;reset();if(!track.locked&&(s.copy||s.trackId!==track.id||s.stepId!==step.id))p.onMoveCell(s.frameId,track.id,step.id,s.copy);return;}try{const payload=JSON.parse(e.dataTransfer.getData("application/x-framebaker-frame-cell"));if(Array.isArray(payload?.frameIds)&&payload.frameIds.length){reset();if(!track.locked)p.onPlaceBatch(payload.frameIds,track.id,step.id);return;}if(payload?.frameId){reset();const copy=payload.copy===true;if(!track.locked&&(copy||payload.trackId!==track.id||payload.stepId!==step.id))p.onMoveCell(payload.frameId,track.id,step.id,copy);return;}}catch{/* 忽略外部无效拖放 */}reset();}}
            onDragEnd={()=>{frameDrag.current=null;setDraggingFrameId(null);setDropTarget(null);}}
            onClick={() => p.onCell(track.id,step.id,f?.id??null)}
            onContextMenu={(e)=>{if(!f)return;e.preventDefault();p.onContextMenu(f.id,{x:e.clientX,y:e.clientY});}}
            title={effect?t("attackEffect.cellHint"):f?(track.locked?t("timeline.lockedCell"):t("timeline.dragCell")):t("timeline.emptyCell")}
          >{f&&<img src={frameImageUrl(f.id,p.v,128)} alt="" draggable={false} loading="lazy" decoding="async"/>}{effect&&<span className="tl-effect-mark"><Sparkles size={15}/></span>}</div>;
        })}
      </div>)}
      {!p.steps.length && <div className="tl-empty">{t("msg.timeline_empty_import_materials_first")}</div>}
    </div>
  </footer>;
}
