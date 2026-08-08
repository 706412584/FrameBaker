import { useEffect, useRef } from "react";
import type * as Pixi from "pixi.js";
import type { HumanoidBoneId, MotionKeyframe, MotionView } from "@framebaker/shared";
import { forward, RIG } from "../motionRig";
import { canvasColors, useTheme } from "../theme";

const { Application, Container, Graphics } = (window as typeof window & { PIXI: typeof Pixi }).PIXI;

interface Props {
  frame: MotionKeyframe;
  view: MotionView;
  selected: HumanoidBoneId;
  selectedLabel: string;
  disabled?: boolean;
  onSelect: (id: HumanoidBoneId) => void;
  onChange: (frame: MotionKeyframe) => void;
}

function rigColors() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string) => css.getPropertyValue(name).trim();
  return {
    body: read("--cyan"), selected: read("--accent"), joint: read("--text"), grid: read("--border"),
    axis: read("--purple"), surface: read("--canvas-bg"),
  };
}

/** 固定人形 Pixi 画布：根节点平移，其余关节通过 FK 编辑对应局部骨骼旋转。 */
export default function MotionRigCanvas(props: Props) {
  const { frame, view, selected, selectedLabel, disabled, onSelect, onChange } = props;
  const host = useRef<HTMLDivElement>(null);
  const state = useRef(props);
  state.current = props;
  const ctx = useRef<{ app: Pixi.Application; rig: Pixi.Graphics; viewport: Pixi.Container; draw: () => void } | null>(null);
  const theme = useTheme();

  useEffect(() => {
    let dead = false;
    const app = new Application();
    void app.init({ resizeTo: host.current!, background: canvasColors().bg, antialias: true }).then(() => {
      if (dead) return app.destroy(true);
      host.current!.appendChild(app.canvas);
      const viewport = new Container();
      const rig = new Graphics();
      viewport.addChild(rig);
      app.stage.addChild(viewport);

      const draw = () => {
        const { frame: current, selected: selectedId, view: currentView } = state.current;
        const colors = rigColors();
        const pts = forward(current);
        const flip = currentView === "back" || currentView === "left" ? -1 : 1;
        viewport.scale.set(flip * 1.45, 1.45);
        const g = rig;
        g.clear();
        const w = app.screen.width / 2 + 80;
        const h = app.screen.height / 2 + 120;
        for (let x = -Math.ceil(w / 32) * 32; x <= w; x += 32) g.moveTo(x, -h).lineTo(x, h).stroke({ width: 1, color: colors.grid, alpha: 0.28 });
        for (let y = -Math.ceil(h / 32) * 32; y <= h; y += 32) g.moveTo(-w, y).lineTo(w, y).stroke({ width: 1, color: colors.grid, alpha: 0.28 });
        g.moveTo(0, -h).lineTo(0, h).stroke({ width: 2, color: colors.axis, alpha: 0.45 });
        g.moveTo(-w, 45).lineTo(w, 45).stroke({ width: 2, color: colors.axis, alpha: 0.45 });

        // 胸腔和骨盆只提供人体轮廓，不参与命中或运动计算。
        const leftShoulder = pts.leftShoulder, rightShoulder = pts.rightShoulder;
        const leftHip = pts.leftHip, rightHip = pts.rightHip;
        g.moveTo(leftShoulder.x, leftShoulder.y)
          .lineTo(rightShoulder.x, rightShoulder.y)
          .lineTo(rightHip.x, rightHip.y)
          .lineTo(leftHip.x, leftHip.y)
          .closePath()
          .fill({ color: colors.body, alpha: 0.08 })
          .stroke({ width: 2, color: colors.body, alpha: 0.48 });
        g.moveTo(leftHip.x, leftHip.y)
          .lineTo(pts.pelvis.x, pts.pelvis.y + 10)
          .lineTo(rightHip.x, rightHip.y)
          .lineTo(pts.pelvis.x, pts.pelvis.y - 8)
          .closePath()
          .fill({ color: colors.body, alpha: 0.18 })
          .stroke({ width: 2, color: colors.body, alpha: 0.68 });

        for (const bone of RIG) {
          if (!bone.parent) continue;
          const a = pts[bone.parent], z = pts[bone.id];
          const color = bone.id === selectedId ? colors.selected : colors.body;
          g.moveTo(a.x, a.y).lineTo(z.x, z.y).stroke({ width: 15, color: colors.surface, alpha: 0.96 });
          g.moveTo(a.x, a.y).lineTo(z.x, z.y).stroke({ width: bone.id === selectedId ? 10 : 8, color, alpha: bone.id === selectedId ? 1 : 0.88 });
        }

        // 头、手和脚补足方向感，让编辑对象更接近人体 mannequin 而不是折线图。
        const head = pts.head;
        g.circle(head.x, head.y, 17).fill({ color: colors.surface }).stroke({ width: selectedId === "head" ? 4 : 3, color: selectedId === "head" ? colors.selected : colors.body });
        const footDirection = currentView === "left" ? -1 : 1;
        g.moveTo(pts.leftAnkle.x, pts.leftAnkle.y).lineTo(pts.leftAnkle.x - 17 * footDirection, pts.leftAnkle.y + 3).stroke({ width: 8, color: colors.surface });
        g.moveTo(pts.leftAnkle.x, pts.leftAnkle.y).lineTo(pts.leftAnkle.x - 17 * footDirection, pts.leftAnkle.y + 3).stroke({ width: 5, color: colors.body });
        g.moveTo(pts.rightAnkle.x, pts.rightAnkle.y).lineTo(pts.rightAnkle.x + 17 * footDirection, pts.rightAnkle.y + 3).stroke({ width: 8, color: colors.surface });
        g.moveTo(pts.rightAnkle.x, pts.rightAnkle.y).lineTo(pts.rightAnkle.x + 17 * footDirection, pts.rightAnkle.y + 3).stroke({ width: 5, color: colors.body });

        for (const bone of RIG) {
          if (bone.id === "head") continue;
          const p = pts[bone.id];
          g.circle(p.x, p.y, bone.id === selectedId ? 9 : 4)
            .fill(bone.id === selectedId ? colors.selected : colors.surface)
            .stroke({ width: bone.id === selectedId ? 3 : 2, color: bone.id === selectedId ? colors.surface : colors.body, alpha: bone.id === selectedId ? 1 : 0.82 });
        }
        const selectedBone = RIG.find((bone) => bone.id === selectedId)!;
        if (selectedBone.parent) {
          const parent = pts[selectedBone.parent], point = pts[selectedId];
          g.circle(parent.x, parent.y, 30).stroke({ width: 2, color: colors.selected, alpha: 0.85 });
          const angle = Math.atan2(point.y - parent.y, point.x - parent.x);
          g.moveTo(parent.x, parent.y).lineTo(parent.x + Math.cos(angle) * 38, parent.y + Math.sin(angle) * 38).stroke({ width: 3, color: colors.selected });
        } else {
          const p = pts.pelvis;
          g.moveTo(p.x - 34, p.y).lineTo(p.x + 34, p.y).stroke({ width: 3, color: colors.selected });
          g.moveTo(p.x, p.y - 34).lineTo(p.x, p.y + 34).stroke({ width: 3, color: colors.selected });
          for (const [x, y, ax, ay] of [[34, 0, 27, -6], [34, 0, 27, 6], [-34, 0, -27, -6], [-34, 0, -27, 6], [0, 34, -6, 27], [0, 34, 6, 27], [0, -34, -6, -27], [0, -34, 6, -27]])
            g.moveTo(p.x + x, p.y + y).lineTo(p.x + ax, p.y + ay).stroke({ width: 3, color: colors.selected });
        }
      };
      ctx.current = { app, rig, viewport, draw };
      // humanoid-v1 的下肢长于上身；按人体包围盒中点上移，窄屏也不会裁掉脚。
      const center = () => { viewport.position.set(app.screen.width / 2, app.screen.height / 2 - 65); draw(); };
      app.renderer.on("resize", center);
      center();
      app.stage.eventMode = "static";
      app.stage.hitArea = app.screen;
      let drag: { id: HumanoidBoneId; parentAngle: number; rest: number } | null = null;
      app.stage.on("pointerdown", (event: Pixi.FederatedPointerEvent) => {
        if (state.current.disabled) return;
        const p = viewport.toLocal(event.global), pts = forward(state.current.frame);
        let id: HumanoidBoneId = "pelvis", distance = Infinity;
        for (const bone of RIG) { const q = pts[bone.id], d = Math.hypot(q.x - p.x, q.y - p.y); if (d < distance) { distance = d; id = bone.id; } }
        if (distance > 22) return;
        state.current.onSelect(id);
        if (id === "pelvis") drag = { id, parentAngle: 0, rest: 0 };
        else { const bone = RIG.find((item) => item.id === id)!; drag = { id, parentAngle: pts[bone.parent!].angle, rest: bone.rest }; }
      });
      app.stage.on("pointermove", (event: Pixi.FederatedPointerEvent) => {
        if (!drag) return;
        const p = viewport.toLocal(event.global), current = state.current.frame;
        if (drag.id === "pelvis") state.current.onChange({ ...current, root: { x: p.x, y: p.y } });
        else { const bone = RIG.find((item) => item.id === drag!.id)!, parent = forward(current)[bone.parent!]; state.current.onChange({ ...current, rotations: { ...current.rotations, [drag.id]: Math.atan2(p.y - parent.y, p.x - parent.x) - drag.parentAngle - drag.rest } }); }
      });
      const end = () => { drag = null; };
      app.stage.on("pointerup", end);
      app.stage.on("pointerupoutside", end);
    });
    return () => { dead = true; ctx.current?.app.destroy(true, { children: true }); ctx.current = null; };
  }, []);

  useEffect(() => {
    if (!ctx.current) return;
    ctx.current.app.renderer.background.color = canvasColors().bg;
    ctx.current.draw();
  }, [frame, view, selected, theme]);

  const angle = Math.round(frame.rotations[selected] * 180 / Math.PI);
  return <div className="motion-canvas" ref={host}><div className="motion-canvas-hud"><strong>{selectedLabel}</strong><span>{selected === "pelvis" ? `X ${Math.round(frame.root.x)} · Y ${Math.round(frame.root.y)}` : `${angle}° LOCAL`}</span></div></div>;
}
