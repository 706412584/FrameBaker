// 工作流图页：左侧图列表，右侧 React Flow 无限画布。
// 节点拖动位置防抖持久化；执行状态走 WS graph_node_status 实时回填节点。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type ReactFlowInstance,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GitBranch, ListTodo, PanelLeftClose, PanelLeftOpen, Play, Square, Trash2 } from "lucide-react";
import { api, type GraphSummary, type Material, type NodeSchema } from "../api";
import { getLocale, useT } from "../i18n";
import { notify } from "../notice";
import { wsClient } from "../api/ws";
import { quantizeImage, sliceAnalyze, sliceCrop, type QuantizeOptions } from "../imageops/client";
import { PORT_COLORS, type PortType, type WSMessage } from "@framebaker/shared";

/** WS graph_client_task 载荷 */
interface ClientTaskPayload {
  graphId: string;
  nodeId: string;
  taskId: string;
  nodeType: string;
  params?: Record<string, unknown>;
  inputUrls?: Record<string, string[]>;
  inputPassthrough?: Record<string, Record<string, unknown>>;
}

// ---- 节点组件：标题 + 端口 + 参数摘要 + 执行状态 ----

/** 预览背景（localStorage + graph-preview-bg-change 事件广播，切换时全画布同步） */
function usePreviewBg() {
  const [bg, setBg] = useState(readPreviewBg);
  useEffect(() => {
    const sync = () => setBg(readPreviewBg());
    window.addEventListener("graph-preview-bg-change", sync);
    return () => window.removeEventListener("graph-preview-bg-change", sync);
  }, []);
  return bg;
}

/**
 * 预览背景模式（对齐 sprite PreviewPanel）：透明帧的观感极度依赖背景亮度 ——
 * 白色半透明纹理在浅底上会炸成"蛛网"，深底才是真实观感。默认深色棋盘格。
 */
const PREVIEW_BG_KEY = "framebaker-graph-preview-bg";
const PREVIEW_BG_COLOR_KEY = "framebaker-graph-preview-bg-color";
type PreviewBgMode = "checker" | "dark" | "light" | "custom";

function readPreviewBg(): { mode: PreviewBgMode; color: string } {
  let mode: PreviewBgMode = "checker";
  let color = "#1a1a20";
  try {
    const m = localStorage.getItem(PREVIEW_BG_KEY);
    if (m === "checker" || m === "dark" || m === "light" || m === "custom") mode = m;
    const c = localStorage.getItem(PREVIEW_BG_COLOR_KEY);
    if (c) color = c;
  } catch {
    /* 隐私模式下 localStorage 不可用 → 用默认值 */
  }
  return { mode, color };
}

function writePreviewBg(mode: PreviewBgMode, color: string) {
  try {
    localStorage.setItem(PREVIEW_BG_KEY, mode);
    localStorage.setItem(PREVIEW_BG_COLOR_KEY, color);
  } catch {
    /* 忽略写入失败 */
  }
}

/**
 * matte.pipeline 参数按模式显隐：未勾选模式的专属参数不渲染。
 * 公共参数（净化/特效保护/键色）在任何模式勾选时显示。
 */
const MATTE_MODE_PARAM_MAP: Record<string, string[]> = {
  chroma: ["threshold", "softness", "despillStrength", "haloPixels", "keyMode", "manualKeyHex"],
  spriteflow: ["sfTolerance", "sfEdgeBlend", "sfBlendZoneRatio", "sfAlphaCutoff", "sfSpillRemoval", "sfSpillStrength"],
  birefnet: ["aiModel", "aiDevice", "aiResolution"],
  corridorkey: ["corridorkeyScreen"],
  luma: ["lumaBlack", "lumaWhite", "lumaGamma", "lumaStrength"],
  additive: ["lumaBlack", "lumaWhite", "lumaGamma", "lumaStrength"],
};

/** 返回应显示的参数键集合；非 matte.pipeline 返回 null（全显） */
function visibleMatteParams(params: Record<string, unknown>): Set<string> | null {
  const switches: Array<[string, string]> = [
    ["useChroma", "chroma"],
    ["useSpriteflow", "spriteflow"],
    ["useBirefnet", "birefnet"],
    ["useCorridorkey", "corridorkey"],
    ["useLuma", "luma"],
    ["useAdditive", "additive"],
  ];
  const active = switches.filter(([k]) => params[k] === true).map(([, m]) => m);
  if (active.length === 0) {
    // 开关全空（旧图 legacy pipeline 串）→ 全显，避免藏参数
    return null;
  }
  const visible = new Set<string>();
  for (const mode of active) {
    for (const k of MATTE_MODE_PARAM_MAP[mode] ?? []) visible.add(k);
  }
  // 公共参数
  for (const k of ["decontaminate", "decontaminateRadius", "decontaminateStrength", "effectProtectionEnabled", "effectProtectionThreshold"]) {
    visible.add(k);
  }
  return visible;
}

type GraphNodeData = {
  schema: NodeSchema;
  params: Record<string, unknown>;
  runStatus?: string;
  runProgress?: string;
  /** 产物预览（done 时由 WS 回填）：图片首帧或视频 URL */
  previewUrl?: string;
  previewKind?: "image" | "video";
  /** 多帧序列的全部帧 URL（lightbox 播放器用） */
  frameUrls?: string[];
  /** preview.frame 产物元信息（时间轴拖动用） */
  previewMeta?: { sampleTime: number; duration: number };
  /** 立即预览沿链应用过的节点类型（显示"已过 N 个处理"） */
  appliedNodes?: string[];
  /** 导出产物目录（export.* 节点；产物清单/打开文件夹/下载用） */
  outputDir?: string;
  /** 参数已改、下次执行将重算（含下游）——黄色描边提示 */
  dirty?: boolean;
  [key: string]: unknown;
};

// ---- 小工具 ----

/** 文件选择（一次性 input，无 UI 依赖） */
function pickFile(onPick: (file: File) => void, accept?: string) {
  const input = document.createElement("input");
  input.type = "file";
  if (accept) input.accept = accept;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) onPick(file);
  };
  input.click();
}

/** 素材 kind 简易推断（上传下拉即时刷新用；服务端另有权威推断） */
function inferKind(name: string): "image" | "video" {
  return /\.(mp4|mov|webm|gif)$/i.test(name) ? "video" : "image";
}

const STATUS_CLASS: Record<string, string> = {
  running: "gn-status-running",
  done: "gn-status-done",
  "skipped-cache": "gn-status-cache",
  error: "gn-status-error",
  cancelled: "gn-status-cancelled",
};

/** dirty（参数已改待重算）优先于普通状态描边 */
const nodeStatusClass = (d: GraphNodeData) =>
  d.dirty ? "gn-status-dirty" : (STATUS_CLASS[d.runStatus ?? ""] ?? "");

function WorkflowNode({ id, data, selected }: NodeProps) {
  const t = useT();
  const d = data as GraphNodeData;
  const previewBg = usePreviewBg();
  const bgStyle = previewBg.mode === "custom" ? { ["--preview-bg-color" as string]: previewBg.color } : undefined;
  // 素材下拉数据（materialId 字段用）：按需拉一次，节点级缓存
  const [materials, setMaterials] = useState<Material[]>([]);
  const [uploading, setUploading] = useState(false);
  const hasMaterialField = Object.keys((d.schema.paramsSchema.properties ?? {}) as Record<string, unknown>).includes(
    "materialId"
  );
  useEffect(() => {
    if (!hasMaterialField) return;
    let active = true;
    api.listMaterials().then((ms) => active && setMaterials(ms)).catch(() => {});
    return () => {
      active = false;
    };
  }, [hasMaterialField]);

  const setParam = (key: string, value: unknown) =>
    window.dispatchEvent(new CustomEvent("graph-param-change", { detail: { nodeId: id, key, value } }));

  const uploadMaterial = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("graphRaw", "true"); // 视频/GIF/PSD 原样直存为单素材（graph 语义）
      const r = await api.uploadMaterial(fd);
      const materialId = "materialId" in r ? r.materialId : undefined;
      if (materialId) {
        setMaterials((ms) => [...ms, { id: materialId, name: file.name, kind: inferKind(file.name) } as Material]);
        setParam("materialId", materialId);
      }
    } catch (e) {
      notify(`${t("graph.upload_failed")}: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const props = (d.schema.paramsSchema.properties ?? {}) as Record<
    string,
    { type?: string; title?: string; description?: string; default?: unknown; enum?: string[]; enumLabels?: Record<string, string> }
  >;

  return (
    <div className={`graph-node ${nodeStatusClass(d)} ${selected ? "graph-node-selected" : ""}`}>
      <div className="graph-node-title">{d.schema.label}</div>
      {/* 内联参数（ComfyUI 风格）：直接在卡片上编辑 */}
      {Object.keys(props).length > 0 && (
        <div className="graph-node-fields nodrag nopan">
          {Object.entries(props)
            .filter(([key]) => {
              if (d.schema.type !== "matte.pipeline") return true;
              const visible = visibleMatteParams(d.params);
              return !visible || visible.has(key) || key.startsWith("use");
            })
            .map(([key, prop]) => {
            const value = d.params[key] ?? prop.default;
            if (key === "materialId") {
              return (
                <div key={key} className="graph-field">
                  <span className="graph-field-label" title={prop.description ?? key}>
                    {prop.title ?? key}
                  </span>
                  <select
                    className="graph-field-input"
                    value={String(d.params[key] ?? "")}
                    disabled={uploading}
                    onChange={(e) => {
                      if (e.target.value === "__upload__") {
                        pickFile(uploadMaterial);
                        e.target.value = String(d.params[key] ?? "");
                        return;
                      }
                      setParam(key, e.target.value);
                    }}
                  >
                    <option value="">{t("graph.pick_material")}</option>
                    <option value="__upload__">{uploading ? t("graph.uploading") : t("graph.upload_material")}</option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }
            if (prop.type === "boolean") {
              return (
                <label key={key} className="graph-field graph-field-bool" title={prop.description ?? key}>
                  <span className="graph-field-label">{prop.title ?? key}</span>
                  <input
                    type="checkbox"
                    className="graph-field-check"
                    checked={value === true}
                    onChange={(e) => setParam(key, e.target.checked)}
                  />
                </label>
              );
            }
            if (prop.type === "integer" || prop.type === "number") {
              return (
                <div key={key} className="graph-field">
                  <span className="graph-field-label" title={prop.description ?? key}>
                    {prop.title ?? key}
                  </span>
                  <input
                    type="number"
                    className="graph-field-input"
                    value={value === undefined || value === null ? "" : Number(value)}
                    step={prop.type === "number" ? "any" : "1"}
                    onChange={(e) => {
                      const v = e.target.value === "" ? undefined : Number(e.target.value);
                      setParam(key, v);
                    }}
                  />
                </div>
              );
            }
            // enum 字符串 → 下拉（enumLabels 给中文标签）
            if (prop.type === "string" && Array.isArray(prop.enum) && prop.enum.length > 0) {
              return (
                <div key={key} className="graph-field">
                  <span className="graph-field-label" title={prop.description ?? key}>
                    {prop.title ?? key}
                  </span>
                  <select
                    className="graph-field-input"
                    value={String(value ?? prop.enum[0])}
                    onChange={(e) => setParam(key, e.target.value)}
                  >
                    {prop.enum.map((opt) => (
                      <option key={opt} value={opt}>
                        {prop.enumLabels?.[opt] ?? opt}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }
            return (
              <div key={key} className="graph-field">
                <span className="graph-field-label" title={prop.description ?? key}>
                  {prop.title ?? key}
                </span>
                <input
                  type="text"
                  className="graph-field-input"
                  value={String(value ?? "")}
                  placeholder={prop.description ?? ""}
                  onChange={(e) => setParam(key, e.target.value)}
                />
              </div>
            );
          })}
        </div>
      )}
      {/* 单帧预览时间轴（preview.frame）：拖动改采样秒；「立即预览」不跑全图直接看帧，「取帧」重跑该链 */}
      {(d.schema.type === "preview.frame" || (d.previewMeta && d.previewMeta.duration > 0)) && (
        <div className="graph-timeline nodrag nopan">
          <input
            type="range"
            className="graph-timeline-range"
            min={0}
            max={Math.floor((d.previewMeta?.duration ?? 30) * 10) / 10}
            step={0.1}
            value={Number(d.params.sampleTime ?? 0)}
            onChange={(e) => setParam("sampleTime", Number(e.target.value))}
          />
          <span className="graph-timeline-time">
            {Number(d.params.sampleTime ?? 0).toFixed(1)}s / {(d.previewMeta?.duration ?? 0) > 0 ? d.previewMeta!.duration.toFixed(1) : "?"}s
          </span>
          <button
            type="button"
            className="graph-timeline-instant"
            onClick={() => window.dispatchEvent(new CustomEvent("graph-preview-instant", { detail: { nodeId: id } }))}
            title={t("graph.instant_hint")}
          >
            {t("graph.instant_preview")}
          </button>
          <button
            type="button"
            className="graph-timeline-run"
            title={t("graph.rerun_hint")}
            onClick={() => window.dispatchEvent(new CustomEvent("graph-preview-run", { detail: { nodeId: id } }))}
          >
            {t("graph.rerun_preview")}
          </button>
        </div>
      )}
      <div className="graph-node-ports">
        <div className="graph-node-in">
          {d.schema.inputs.map((p) => (
            <span key={p.name} className="graph-port graph-port-in" title={`${p.name} (${p.type})`}>
              {/* React Flow 真实连接锚点：连线定位/拖拽依赖 Handle，标签只负责展示 */}
              <Handle type="target" position={Position.Left} id={p.name} isConnectable />
              <span
                className="graph-port-label"
                style={{ ["--port-color" as string]: PORT_COLORS[p.type as PortType] }}
              >
                {p.label}
              </span>
            </span>
          ))}
        </div>
        <div className="graph-node-out">
          {d.schema.outputs.map((p) => (
            <span key={p.name} className="graph-port graph-port-out" title={`${p.name} (${p.type})`}>
              <span
                className="graph-port-label"
                style={{ ["--port-color" as string]: PORT_COLORS[p.type as PortType] }}
              >
                {p.label}
              </span>
              <Handle type="source" position={Position.Right} id={p.name} isConnectable />
            </span>
          ))}
        </div>
      </div>
      {d.previewUrl && (
        <button
          type="button"
          className="graph-node-preview"
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(
              new CustomEvent("graph-preview-open", {
                detail: { url: d.previewUrl, kind: d.previewKind, urls: d.frameUrls },
              })
            );
          }}
          title={d.frameUrls && d.frameUrls.length > 1 ? `${t("graph.preview_frames")}: ${d.frameUrls.length}` : d.previewKind === "video" ? t("graph.preview_video") : t("graph.preview_image")}
        >
          {d.previewKind === "video" ? (
            <video src={d.previewUrl} muted playsInline className={`graph-node-preview-media preview-bg-${previewBg.mode}`} style={bgStyle} />
          ) : (
            <img src={d.previewUrl} alt="" className={`graph-node-preview-media preview-bg-${previewBg.mode}`} style={bgStyle} />
          )}
          {d.frameUrls && d.frameUrls.length > 1 && (
            <span className="graph-node-preview-badge">{d.frameUrls.length}</span>
          )}
          {d.appliedNodes && d.appliedNodes.length > 0 && (
            <span className="graph-node-preview-chain" title={d.appliedNodes.join(" → ")}>
              {t("graph.chain_applied", { count: d.appliedNodes.length })}
            </span>
          )}
        </button>
      )}
      {d.runStatus === "running" && d.runProgress && <div className="graph-node-progress">{d.runProgress}</div>}
      {d.outputDir && <ArtifactPanel outputDir={d.outputDir} />}
    </div>
  );
}

/** 导出产物面板：目录清单（点开加载）+ 打开文件夹 + 逐文件下载 */
function ArtifactPanel({ outputDir }: { outputDir: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Array<{ name: string; isDir: boolean; size: number }> | null>(null);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !entries) {
      api.listGraphDir(outputDir).then(setEntries).catch(() => setEntries([]));
    }
  };
  const openFolder = () => {
    api.openGraphFolder(outputDir).catch((e) => notify(String((e as Error).message)));
  };
  // 保存到自定义目录：File System Access API 选目录（Chromium），不支持则退化为路径输入
  const saveTo = async () => {
    let targetDir: string | null = null;
    const w = window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
    if (typeof w.showDirectoryPicker === "function") {
      try {
        const handle = await w.showDirectoryPicker();
        targetDir = (handle as unknown as { getPath?: () => string }).getPath?.() ?? null;
      } catch {
        return; // 用户取消
      }
    }
    if (!targetDir) {
      targetDir = window.prompt(t("graph.save_to_hint")) ?? "";
    }
    if (!targetDir) return;
    api
      .saveGraphArtifacts(outputDir, targetDir)
      .then((r) => notify(t("graph.saved_to", { path: r.savedTo })))
      .catch((e) => notify(String((e as Error).message)));
  };
  const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
  return (
    <div className="graph-artifacts nodrag nopan">
      <div className="graph-artifacts-bar">
        <button type="button" className="graph-artifacts-toggle" onClick={toggle}>
          {open ? "▾" : "▸"} {t("graph.artifacts")}
        </button>
        <button type="button" className="graph-artifacts-open" onClick={saveTo} title={t("graph.save_to_hint")}>
          {t("graph.save_to")}
        </button>
        <button type="button" className="graph-artifacts-open" onClick={openFolder} title={t("graph.open_folder_hint")}>
          {t("graph.open_folder")}
        </button>
      </div>
      {open && (
        <div className="graph-artifacts-list">
          {entries === null ? (
            <span className="graph-artifacts-loading">…</span>
          ) : entries.length === 0 ? (
            <span className="graph-artifacts-empty">{t("graph.no_artifacts")}</span>
          ) : (
            entries.map((e) =>
              e.isDir ? (
                <span key={e.name} className="graph-artifacts-dir">
                  📁 {e.name}/
                </span>
              ) : (
                <a
                  key={e.name}
                  className="graph-artifacts-file"
                  href={`/api/graph/media?path=${encodeURIComponent(outputDir.replaceAll("\\", "/") + "/" + e.name)}&download=1`}
                  download={e.name}
                  title={fmtSize(e.size)}
                >
                  {e.name} <span className="graph-artifacts-size">{fmtSize(e.size)}</span>
                </a>
              )
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 画布缩放控件（自绘）。内置 <Controls> 和 useReactFlow() hook 在本页都拿不到有效 store
 * （provider key 重建 + 受控 nodes 重渲染的组合下，hook 闭包指向过期 store 实例，
 *  d3 transform 纹丝不动 —— 实测验证）。onInit 的 ReactFlow 实例方法稳定有效。
 */
function CanvasControls() {
  const t = useT();
  // 通道选择（实测结论）：本页受控 nodes + provider 重建的组合下，store/instance/hook
  // 三条 zoom API 全部不动 d3 transform；但 d3 原生 wheel listener 正常 —— 按钮直接
  // 向画布 pane 派发合成 wheel（缩放）与 dblclick（React Flow 内置双击放大 = zoomIn）。
  const pane = () => document.querySelector(".react-flow__pane");
  const wheel = (deltaY: number) => {
    const el = pane();
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true, cancelable: true,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        deltaY,
      })
    );
  };
  const zoomInStep = () => {
    const el = pane();
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  };
  return (
    <div className="graph-canvas-controls">
      <button type="button" className="graph-canvas-ctrl" title={t("graph.zoom_in")} onPointerDown={(e) => { e.stopPropagation(); wheel(-120); }}>
        +
      </button>
      <button type="button" className="graph-canvas-ctrl" title={t("graph.zoom_out")} onPointerDown={(e) => { e.stopPropagation(); wheel(120); }}>
        −
      </button>
      <button type="button" className="graph-canvas-ctrl" title={t("graph.fit_view")} onPointerDown={(e) => { e.stopPropagation(); zoomOutFull(); }}>
        ⛶
      </button>
    </div>
  );
}

/** 全景：连续缩小到最小再 dblclick 不可行 —— 用键盘快捷键通道：React Flow 默认数字键 1 fit */
function zoomOutFull() {
  const el = document.querySelector(".react-flow__pane");
  if (!el) return;
  // React Flow 12: fitView 快捷键未启用时，退而求其次重置：多次缩小足够可见全图
  for (let i = 0; i < 6; i++) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, deltaY: 240 }));
  }
}

const nodeTypes = { workflow: WorkflowNode };

// ---- 连线（ComfyUI 风格）：端口类型着色贝塞尔 + 悬停高亮 + 点击删除 ----

type TypedEdgeData = { portType: PortType; [key: string]: unknown };

function TypedEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [hover, setHover] = useState(false);
  const color = PORT_COLORS[(data as TypedEdgeData | undefined)?.portType ?? "image"];
  // 与 React Flow 默认 bezier 同参数（水平出线，弧度 = 距离/2，上限 150）
  const dx = Math.abs(targetX - sourceX) / 2;
  const curvature = Math.min(150, Math.max(40, dx));
  const path = `M ${sourceX},${sourceY} C ${sourceX + (sourcePosition === Position.Right ? curvature : -curvature)},${sourceY} ${targetX + (targetPosition === Position.Left ? -curvature : curvature)},${targetY} ${targetX},${targetY}`;
  return (
    <g
      className="graph-edge"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={() => {
        // 点击连线：走 onEdgesDelete 语义（React Flow 的 elementsRemovable 由外层控制），
        // 这里直接冒泡给外层的 onEdgeClick 处理删除 —— 用自定义事件最简
        window.dispatchEvent(new CustomEvent("graph-edge-remove", { detail: id }));
      }}
    >
      {/* 悬停热区（宽透明描边） */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: "pointer" }} />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={hover ? 4 : 2.5}
        strokeOpacity={hover ? 1 : 0.85}
        strokeLinecap="round"
        style={{ pointerEvents: "none" }}
      />
    </g>
  );
}

const edgeTypes = { typed: TypedEdge };

// ---- 帧序列播放器（对齐 sprite 的动画预览体验：帧按 fps 轮换循环）----

function FramePlayer({ urls }: { urls: string[] }) {
  const t = useT();
  const previewBg = usePreviewBg();
  const bgStyle = previewBg.mode === "custom" ? { ["--preview-bg-color" as string]: previewBg.color } : undefined;
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(10);
  const total = urls.length;

  useEffect(() => {
    if (!playing || total <= 1) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % total), Math.max(20, 1000 / fps));
    return () => clearInterval(id);
  }, [playing, fps, total]);

  return (
    <div className="graph-frame-player">
      <img src={urls[frame]} alt="" className={`graph-lightbox-media preview-bg-${previewBg.mode}`} style={bgStyle} />
      <div className="graph-frame-controls" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="px-btn" onClick={() => setPlaying((p) => !p)}>
          {playing ? t("graph.pause") : t("graph.play")}
        </button>
        <span className="graph-frame-counter">{frame + 1}/{total}</span>
        <label className="graph-frame-fps">
          {t("graph.fps")}
          <input
            type="range"
            min={1}
            max={30}
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
          />
          <span>{fps}</span>
        </label>
        <div className="graph-frame-strip">
          {urls.map((u, i) => (
            <button
              key={u}
              type="button"
              className={`graph-frame-thumb ${i === frame ? "active" : ""}`}
              onClick={() => {
                setPlaying(false);
                setFrame(i);
              }}
            >
              <img src={u} alt="" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- 画布 ----

function GraphCanvas({
  graphId,
  schemas,
  onCreateGraph,
  onImportFile,
  openTaskPanel,
}: {
  graphId: string;
  schemas: NodeSchema[];
  onCreateGraph: () => void;
  onImportFile: (file: File) => void;
  openTaskPanel: () => void;
}) {
  const t = useT();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [running, setRunning] = useState(false);
  const dragTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const didFitRef = useRef(false);
  // 人在环：等待用户确认/调整候选框（slice.ui.analyze interactive 模式）
  type ConfirmCandidate = { name: string; x: number; y: number; w: number; h: number; area?: number; confidence?: number };
  const [pendingConfirm, setPendingConfirm] = useState<{
    taskId: string;
    width: number;
    height: number;
    candidates: ConfirmCandidate[];
    submit: (candidates: ConfirmCandidate[]) => Promise<Response>;
  } | null>(null);
  // 参数编辑：双击节点打开面板；编辑草稿在本地，保存才 PATCH
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [paramDraft, setParamDraft] = useState<Record<string, unknown>>({});
  const [materials, setMaterials] = useState<Material[]>([]);
  const editingNode = nodes.find((n) => n.id === editingNodeId) ?? null;
  const editingSchema = editingNode ? (editingNode.data as GraphNodeData).schema : null;

  const schemaByType = useCallback(
    (type: string) => schemas.find((s) => s.type === type),
    [schemas]
  );

  // 连线端口类型解析：源节点 schema 的输出端口 → PortType（连线着色用）
  const portTypeOf = useCallback(
    (nodeType: string, port: string): PortType => {
      const out = schemaByType(nodeType)?.outputs.find((o) => o.name === port);
      return out?.type ?? "image";
    },
    [schemaByType]
  );

  // 加载图文档
  useEffect(() => {
    let active = true;
    api.getGraph(graphId).then((doc) => {
      if (!active) return;
      const nodesById = new Map(doc.nodes.map((n) => [n.id, n]));
      setNodes(
        doc.nodes.map((n) => ({
          id: n.id,
          type: "workflow" as const,
          position: { x: n.x, y: n.y },
          data: {
            schema: schemaByType(n.type),
            params: n.params,
            ...(n.previewUrl ? { previewUrl: n.previewUrl, previewKind: n.previewKind } : {}),
            ...(n.frameUrls ? { frameUrls: n.frameUrls } : {}),
            ...(n.previewMeta ? { previewMeta: n.previewMeta } : {}),
            ...(n.outputDir ? { outputDir: n.outputDir } : {}),
          } as GraphNodeData,
        }))
      );
      setEdges(
        doc.edges.map((e) => {
          const sourceNode = nodesById.get(e.from_node);
          return {
            id: e.id,
            source: e.from_node,
            sourceHandle: e.from_port,
            target: e.to_node,
            targetHandle: e.to_port,
            type: "typed" as const,
            data: { portType: sourceNode ? portTypeOf(sourceNode.type, e.from_port) : "image" } as TypedEdgeData,
          };
        })
      );
      // 首次适配（fitView prop 在受控重渲染下会反复重置 viewport，缩放会被吃掉）
      if (active && !didFitRef.current) {
        didFitRef.current = true;
        setTimeout(() => fitView({ padding: 0.2, duration: 0 }), 80);
      }
    }).catch((e) => notify(String((e as Error).message)));
    return () => {
      active = false;
    };
  }, [graphId, schemaByType, setNodes, setEdges, portTypeOf]);

  // 执行状态：WS 回填 + 运行标记
  useEffect(() => {
    const onMsg = (msg: WSMessage) => {
      if (msg.type === "graph_node_status") {
        const p = msg.payload as { graphId?: string; nodeId?: string; status?: string; progress?: string; previewUrl?: string; previewKind?: "image" | "video"; frameUrls?: string[]; previewMeta?: { sampleTime: number; duration: number }; outputDir?: string };
        if (p.graphId !== graphId || !p.nodeId) return;
        if (p.status === "running") setRunning(true);
        setNodes((ns) =>
          ns.map((n) =>
            n.id === p.nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    runStatus: p.status,
                    runProgress: p.progress,
                    ...(p.previewUrl ? { previewUrl: p.previewUrl, previewKind: p.previewKind } : {}),
                    ...(p.frameUrls ? { frameUrls: p.frameUrls } : {}),
                    ...(p.previewMeta ? { previewMeta: p.previewMeta } : {}),
                    ...(p.outputDir ? { outputDir: p.outputDir } : {}),
                  },
                }
              : n
          )
        );
      }
      // 客户端节点执行请求：本页负责计算（imageops worker）并回传
      if (msg.type === "graph_client_task") {
        void handleClientTask(msg.payload as ClientTaskPayload);
      }
    };
    return wsClient.subscribe(onMsg);
  }, [graphId, setNodes]);

  // 即时预览（preview.frame 的「立即预览」按钮）：不执行全图、不落缓存——点一下直接看该秒的帧
  useEffect(() => {
    const instant = (e: Event) => {
      const { nodeId } = (e as CustomEvent<{ nodeId: string }>).detail;
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node) return;
      const sampleTime = Number((node.data as GraphNodeData).params.sampleTime ?? 0) || 0;
      api
        .instantPreviewFrame(graphId, { nodeId, sampleTime })
        .then((r) => {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      previewUrl: r.previewUrl,
                      previewKind: "image" as const,
                      previewMeta: { sampleTime: r.sampleTime, duration: r.duration },
                      ...(r.appliedNodes?.length ? { appliedNodes: r.appliedNodes } : {}),
                    },
                  }
                : n
            )
          );
        })
        .catch((err) => notify(String((err as Error).message)));
    };
    window.addEventListener("graph-preview-instant", instant);
    return () => window.removeEventListener("graph-preview-instant", instant);
  }, [graphId, setNodes]);

  // 单帧预览重跑（preview.frame 的「取帧」按钮）：sampleTime 已变 → 该节点及下游 hash 失效 →
  // 全图 run 时缓存自动跳过上游未变节点（这也是内容寻址缓存的核心收益）
  useEffect(() => {
    const rerun = () => {
      if (running) return;
      setNodes((ns) =>
        ns.map((n) => ({ ...n, data: { ...n.data, runStatus: undefined, runProgress: undefined, dirty: undefined } }))
      );
      api.runGraph(graphId).catch((e) => notify(String((e as Error).message)));
      setRunning(true);
    };
    window.addEventListener("graph-preview-run", rerun);
    return () => window.removeEventListener("graph-preview-run", rerun);
  }, [graphId, running]);

  // 预览 lightbox（节点缩略图点击放大；多帧序列 → 播放器）
  const [lightbox, setLightbox] = useState<{ urls: string[]; kind?: "image" | "video" } | null>(null);
  // 预览背景（lightbox 切换条 + 全画布缩略图同步）
  const previewBg = usePreviewBg();
  const bgStyle = previewBg.mode === "custom" ? { ["--preview-bg-color" as string]: previewBg.color } : undefined;
  const setPreviewBg = (mode: PreviewBgMode, color?: string) => {
    writePreviewBg(mode, color ?? previewBg.color);
    window.dispatchEvent(new Event("graph-preview-bg-change"));
  };
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ url: string; kind?: "image" | "video"; urls?: string[] }>).detail;
      setLightbox({ urls: d.urls?.length ? d.urls : [d.url], kind: d.kind });
    };
    window.addEventListener("graph-preview-open", open);
    return () => window.removeEventListener("graph-preview-open", open);
  }, []);

  // ---- 客户端节点执行（quantize.pixel / slice.ui.analyze / slice.ui.crop 在浏览器 worker 跑）----
  const handleClientTask = useCallback(
    async (task: ClientTaskPayload) => {
      if (task.graphId !== graphId) return;
      try {
        const inputUrls = task.inputUrls?.images ?? [];
        if (!inputUrls.length) throw new Error("客户端节点缺少图片输入");

        // 人在环（server 节点挂起）：ui.layer.analyze interactive → 确认面板（可增删改候选框）
        if (task.nodeType === "ui.layer.confirm") {
          const candidates = (task.inputPassthrough?.rects as { candidates?: ConfirmCandidate[] } | undefined)?.candidates ?? [];
          setPendingConfirm({
            taskId: task.taskId,
            width: 0,
            height: 0,
            candidates,
            submit: (confirmed) =>
              fetch(`/api/graphs/${graphId}/client-result/${task.taskId}/complete`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ outputs: { rects: { candidates: confirmed } } }),
              }),
          });
          setNodes((ns) =>
            ns.map((n) => (n.id === task.nodeId ? { ...n, data: { ...n.data, runStatus: "waiting-for-input" } } : n))
          );
          return;
        }

        // 分析型：slice.ui.analyze → 输出候选框 JSON（不上传文件）
        if (task.nodeType === "slice.ui.analyze") {
          const res = await fetch(inputUrls[0]!);
          if (!res.ok) throw new Error(`拉取输入图失败: ${res.status}`);
          const blob = await res.blob();
          // 未在节点参数里显式给出的键不传 —— 让 analyzeUiSmartSlicesData 对去底图
          // 自动收紧 padding/mergeGap（sprite 原版语义）
          const opts: Record<string, number> = {};
          for (const key of ["alphaThreshold", "alphaFloodThreshold", "colorThreshold", "minSize", "mergeGap", "padding"]) {
            if (task.params && key in task.params) opts[key] = Number(task.params[key]);
          }
          const result = await sliceAnalyze(blob, opts);
          const submit = (candidates: ConfirmCandidate[]) =>
            fetch(`/api/graphs/${graphId}/client-result/${task.taskId}/complete`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ outputs: { rects: { candidates, width: result.width, height: result.height } } }),
            });
          // 人在环：interactive 模式下暂停，画布上弹候选框调整面板，用户确认后继续下游
          if (task.params?.interactive === true) {
            setPendingConfirm({ taskId: task.taskId, width: result.width, height: result.height, candidates: result.candidates, submit });
            setNodes((ns) =>
              ns.map((n) => (n.id === task.nodeId ? { ...n, data: { ...n.data, runStatus: "waiting-for-input" } } : n))
            );
            return;
          }
          await submit(result.candidates);
          return;
        }

        // 产物型：quantize.pixel / slice.ui.crop
        const fileNames: string[] = [];
        if (task.nodeType === "slice.ui.crop") {
          const rects = (task.inputPassthrough?.rects as { candidates?: Array<{ x: number; y: number; w: number; h: number; name?: string }> } | undefined)?.candidates ?? [];
          if (!rects.length) throw new Error("裁剪节点缺少候选框输入");
          const res = await fetch(inputUrls[0]!);
          if (!res.ok) throw new Error(`拉取输入图失败: ${res.status}`);
          const blob = await res.blob();
          for (let i = 0; i < rects.length; i++) {
            const out = await sliceCrop(blob, rects[i]!);
            const name = `slice_${String(i).padStart(4, "0")}.png`;
            const up = await fetch(
              `/api/graphs/${graphId}/client-result/${task.taskId}?name=${encodeURIComponent(name)}`,
              { method: "POST", headers: { "Content-Type": "image/png" }, body: out }
            );
            if (!up.ok) throw new Error(`产物上传失败: ${up.status}`);
            fileNames.push(name);
          }
        } else if (task.nodeType === "quantize.pixel") {
          for (let i = 0; i < inputUrls.length; i++) {
            const res = await fetch(inputUrls[i]!);
            if (!res.ok) throw new Error(`拉取输入图失败: ${res.status}`);
            const blob = await res.blob();
            const options = {
              colors: Number(task.params?.colors ?? 16),
              method: (task.params?.method as QuantizeOptions["method"]) ?? "wuquant",
              dithering: (task.params?.dithering as QuantizeOptions["dithering"]) ?? "nearest",
              pixelSize: Number(task.params?.pixelSize ?? 1),
            };
            const r = await quantizeImage(blob, options);
            const name = `quant_${String(i).padStart(4, "0")}.png`;
            const up = await fetch(
              `/api/graphs/${graphId}/client-result/${task.taskId}?name=${encodeURIComponent(name)}`,
              { method: "POST", headers: { "Content-Type": "image/png" }, body: r.blob }
            );
            if (!up.ok) throw new Error(`产物上传失败: ${up.status}`);
            fileNames.push(name);
          }
        } else {
          throw new Error(`未知客户端节点: ${task.nodeType}`);
        }
        await fetch(`/api/graphs/${graphId}/client-result/${task.taskId}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileNames }),
        });
      } catch (e) {
        notify(`${t("graph.client_task_failed")}: ${(e as Error).message}`);
        await fetch(`/api/graphs/${graphId}/client-result/${task.taskId}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: (e as Error).message }),
        }).catch(() => {});
      }
    },
    [graphId, t]
  );

  // 轮询兜底：WS 断连时靠 running 接口收敛
  useEffect(() => {
    const id = setInterval(() => {
      api.graphRunning(graphId).then(setRunning).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [graphId]);

  // 节点拖动结束 → 防抖持久化位置
  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      const timers = dragTimers.current;
      const old = timers.get(node.id);
      if (old) clearTimeout(old);
      const pos = node.position;
      timers.set(
        node.id,
        setTimeout(() => {
          api.patchGraphNode(graphId, node.id, { x: pos.x, y: pos.y }).catch(() => {});
          timers.delete(node.id);
        }, 400)
      );
    },
    [graphId]
  );

  // 连线（React Flow 校验 handle 存在性；类型校验在服务端，失败弹错）
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      api
        .addGraphEdge(graphId, { fromNode: c.source, fromPort: c.sourceHandle, toNode: c.target, toPort: c.targetHandle })
        .then((r) => {
          const sourceNode = nodes.find((n) => n.id === c.source);
          setEdges((es) =>
            addEdge(
              {
                id: r.edgeId,
                source: c.source!,
                sourceHandle: c.sourceHandle,
                target: c.target!,
                targetHandle: c.targetHandle,
                type: "typed",
                data: { portType: sourceNode ? portTypeOf((sourceNode.data as GraphNodeData).schema.type, c.sourceHandle!) : "image" } as TypedEdgeData,
              },
              es
            )
          );
        })
        .catch((e) => notify(String((e as Error).message)));
    },
    [graphId, nodes, portTypeOf, setEdges]
  );

  // 断线
  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) api.deleteGraphEdge(graphId, e.id).catch(() => {});
    },
    [graphId]
  );

  // 点击连线删除（TypedEdge 里自定义事件冒泡）
  useEffect(() => {
    const remove = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setEdges((es) => es.filter((edge) => edge.id !== id));
      api.deleteGraphEdge(graphId, id).catch(() => {});
    };
    window.addEventListener("graph-edge-remove", remove);
    return () => window.removeEventListener("graph-edge-remove", remove);
  }, [graphId, setEdges]);

  // 节点内联参数编辑（ComfyUI 风格）：事件 → 本地即时更新 + 防抖 PATCH 落库
  const paramTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  useEffect(() => {
    const onParam = (e: Event) => {
      const { nodeId, key, value } = (e as CustomEvent<{ nodeId: string; key: string; value: unknown }>).detail;
      if (!nodeId || key === undefined) return;
      // 参数已变 → 该节点与全部下游标 dirty（下次执行重算；连线方向已知，闭包即可求）
      setNodes((ns) => {
        const downstream = new Set<string>();
        const stack = [nodeId];
        while (stack.length) {
          const cur = stack.pop()!;
          if (downstream.has(cur)) continue;
          downstream.add(cur);
          for (const edge of edgesRef.current) {
            if (edge.source === cur) stack.push(edge.target);
          }
        }
        return ns.map((n) =>
          downstream.has(n.id) ? { ...n, data: { ...n.data, dirty: true } as GraphNodeData } : n
        );
      });
      // 本地即时反映
      setNodes((ns) =>
        ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, params: { ...(n.data as GraphNodeData).params, [key]: value } } } : n))
      );
      // 防抖 400ms 落库（整个 params 对象 PATCH）
      const timers = paramTimers.current;
      const old = timers.get(nodeId);
      if (old) clearTimeout(old);
      timers.set(
        nodeId,
        setTimeout(() => {
          const target = nodesRef.current.find((n) => n.id === nodeId);
          if (target) {
            api.patchGraphNode(graphId, nodeId, { params: (target.data as GraphNodeData).params }).catch((err) =>
              notify(String((err as Error).message))
            );
          }
          timers.delete(nodeId);
        }, 400)
      );
    };
    window.addEventListener("graph-param-change", onParam);
    return () => window.removeEventListener("graph-param-change", onParam);
  }, [graphId, setNodes]);

  // ---- 右键节点菜单（ComfyUI 风格 context menu）----
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    // 只在真右键（button===2）时开菜单：左键拖动后松开等场景不触发
    if (e.button !== 2) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const onRun = useCallback(() => {
    // 新一轮执行：清除上次的节点状态/预览/脏标（缓存命中的节点会立刻回填预览）
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: {
          ...n.data,
          runStatus: undefined,
          runProgress: undefined,
          previewUrl: undefined,
          previewKind: undefined,
          frameUrls: undefined,
          previewMeta: undefined,
          dirty: undefined,
        },
      }))
    );
    api.runGraph(graphId).catch((e) => notify(String((e as Error).message)));
    setRunning(true);
  }, [graphId, setNodes]);

  const onCancel = useCallback(() => {
    api.cancelGraph(graphId).catch(() => {});
  }, [graphId]);

  // 工具栏导入工作流（隐藏 file input）
  const importRef = useRef<HTMLInputElement>(null);

  // 导出工作流 JSON：图名 + 节点（类型/参数/位置）+ 连线（索引式，导入按数组序还原）
  const exportGraph = useCallback(() => {
    api.getGraph(graphId).then((doc) => {
      const idx = new Map(doc.nodes.map((n, i) => [n.id, i]));
      const payload = {
        name: doc.graph.name,
        nodes: doc.nodes.map((n) => ({ type: n.type, params: n.params, x: n.x, y: n.y })),
        edges: doc.edges
          .filter((e) => idx.has(e.from_node) && idx.has(e.to_node))
          .map((e) => ({
            from: idx.get(e.from_node)!,
            fromPort: e.from_port,
            to: idx.get(e.to_node)!,
            toPort: e.to_port,
          })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `workflow-${doc.graph.name.replace(/[\/:*?"<>|]/g, "_")}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }).catch((e) => notify(String((e as Error).message)));
  }, [graphId]);

  // 从工具栏下拉加节点
  const addNodeFromSchema = useCallback(
    (type: string) => {
      const pos = screenToFlowPosition({ x: 260, y: 220 + nodes.length * 40 });
      api
        .addGraphNode(graphId, { type, x: pos.x, y: pos.y })
        .then((r) =>
          setNodes((ns) => [
            ...ns,
            {
              id: r.nodeId,
              type: "workflow" as const,
              position: pos,
              data: { schema: schemaByType(type), params: {} } as GraphNodeData,
            },
          ])
        )
        .catch((e) => notify(String((e as Error).message)));
    },
    [graphId, nodes.length, screenToFlowPosition, schemaByType, setNodes]
  );

  const onDeleteNode = useCallback(
    (id: string) => {
      api.deleteGraphNode(graphId, id).then(() => {
        setNodes((ns) => ns.filter((n) => n.id !== id));
        if (editingNodeId === id) setEditingNodeId(null);
      }).catch(() => {});
    },
    [graphId, editingNodeId, setNodes]
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      onDeleteNode(nodeId);
      setContextMenu(null);
    },
    [onDeleteNode]
  );

  // ---- 参数编辑面板 ----

  // 素材列表（material.* 节点的 materialId 下拉用）；打开面板时按需拉
  useEffect(() => {
    if (!editingNodeId || materials.length > 0) return;
    let active = true;
    api.listMaterials().then((ms) => active && setMaterials(ms)).catch(() => {});
    return () => {
      active = false;
    };
  }, [editingNodeId, materials.length]);

  const openNodeEditor = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      setParamDraft({ ...(node.data as GraphNodeData).params });
      setEditingNodeId(nodeId);
    },
    [nodes]
  );

  const saveNodeParams = useCallback(async () => {
    if (!editingNode) return;
    try {
      await api.patchGraphNode(graphId, editingNode.id, { params: paramDraft });
      // 参数可能带默认值补全 —— 以后端回来的图文档为准刷新卡片
      const doc = await api.getGraph(graphId);
      const fresh = doc.nodes.find((n) => n.id === editingNode.id);
      setNodes((ns) =>
        ns.map((n) =>
          n.id === editingNode.id
            ? { ...n, data: { ...n.data, params: fresh?.params ?? paramDraft } as GraphNodeData }
            : n
        )
      );
      setEditingNodeId(null);
    } catch (e) {
      notify(String((e as Error).message));
    }
  }, [editingNode, graphId, paramDraft, setNodes]);

  return (
    <div className="graph-canvas-wrap">
      {lightbox && (
        <div className="graph-lightbox" onClick={() => setLightbox(null)}>
          <div className="graph-lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <select
              value={previewBg.mode}
              onChange={(e) => setPreviewBg(e.target.value as PreviewBgMode)}
              title={t("graph.preview_bg")}
            >
              <option value="checker">{t("graph.bg_checker")}</option>
              <option value="dark">{t("graph.bg_dark")}</option>
              <option value="light">{t("graph.bg_light")}</option>
              <option value="custom">{t("graph.bg_custom")}</option>
            </select>
            <input
              type="color"
              value={previewBg.color}
              disabled={previewBg.mode !== "custom"}
              onChange={(e) => setPreviewBg("custom", e.target.value)}
              title={t("graph.bg_custom")}
            />
          </div>
          {lightbox.kind === "video" ? (
            <video src={lightbox.urls[0]} controls autoPlay loop className="graph-lightbox-media" onClick={(e) => e.stopPropagation()} />
          ) : lightbox.urls.length > 1 ? (
            <div onClick={(e) => e.stopPropagation()}>
              <FramePlayer urls={lightbox.urls} />
            </div>
          ) : (
            <img src={lightbox.urls[0]} alt="" className={`graph-lightbox-media preview-bg-${previewBg.mode}`} style={bgStyle} />
          )}
          <button type="button" className="graph-lightbox-close" onClick={() => setLightbox(null)}>
            ✕
          </button>
        </div>
      )}
      {editingNode && editingSchema && (
        <div className="graph-confirm-panel graph-params-panel">
          <div className="graph-confirm-head">
            {editingSchema.label}
            <button type="button" className="graph-confirm-del" onClick={() => setEditingNodeId(null)} title={t("common.close")}>
              ✕
            </button>
          </div>
          <div className="graph-confirm-list">
            {Object.entries((editingSchema.paramsSchema.properties ?? {}) as Record<string, { type?: string; title?: string; description?: string; default?: unknown }>).map(([key, prop]) => {
              const isMaterialId = key === "materialId";
              const current = paramDraft[key];
              return (
                <div key={key} className="graph-param-row">
                  <label className="graph-param-label" title={prop.description ?? key}>
                    {prop.title ?? key}
                  </label>
                  {isMaterialId ? (
                    <select
                      className="graph-param-input"
                      value={String(current ?? "")}
                      onChange={(e) => setParamDraft((d) => ({ ...d, [key]: e.target.value }))}
                    >
                      <option value="">{t("graph.pick_material")}</option>
                      {materials
                        .filter((m) => (editingSchema.type === "material.video" ? m.kind === "video" : m.kind === "image"))
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  ) : prop.type === "boolean" ? (
                    <input
                      type="checkbox"
                      className="graph-param-check"
                      checked={current === true}
                      onChange={(e) => setParamDraft((d) => ({ ...d, [key]: e.target.checked }))}
                    />
                  ) : prop.type === "integer" || prop.type === "number" ? (
                    <input
                      type="number"
                      className="graph-param-input"
                      value={current === undefined || current === null ? (prop.default as number | undefined) ?? "" : Number(current)}
                      step={prop.type === "number" ? "any" : "1"}
                      onChange={(e) => {
                        const v = e.target.value === "" ? undefined : Number(e.target.value);
                        setParamDraft((d) => ({ ...d, [key]: v }));
                      }}
                    />
                  ) : (
                    <input
                      type="text"
                      className="graph-param-input"
                      value={String(current ?? (prop.default as string | undefined) ?? "")}
                      placeholder={prop.description ?? ""}
                      onChange={(e) => setParamDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="graph-confirm-actions">
            <button type="button" className="px-btn" onClick={() => void saveNodeParams()}>
              {t("graph.save_params")}
            </button>
          </div>
        </div>
      )}
      {pendingConfirm && (
        <div className="graph-confirm-panel">
          <div className="graph-confirm-head">
            {t("graph.confirm_slices", { count: pendingConfirm.candidates.length })}
            <span className="graph-confirm-meta">{pendingConfirm.width}×{pendingConfirm.height}</span>
          </div>
          <div className="graph-confirm-list">
            {pendingConfirm.candidates.map((c, i) => (
              <div key={c.name} className="graph-confirm-row">
                <span className="graph-confirm-name">{c.name}</span>
                {(["x", "y", "w", "h"] as const).map((k) => (
                  <label key={k}>
                    {k}
                    <input
                      type="number"
                      value={c[k]}
                      onChange={(e) => {
                        const v = Math.max(0, Number(e.target.value) || 0);
                        setPendingConfirm((p) =>
                          p
                            ? { ...p, candidates: p.candidates.map((cc, j) => (j === i ? { ...cc, [k]: v } : cc)) }
                            : p
                        );
                      }}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className="graph-confirm-del"
                  onClick={() => setPendingConfirm((p) => (p ? { ...p, candidates: p.candidates.filter((_, j) => j !== i) } : p))}
                  title={t("graph.delete")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="graph-confirm-actions">
            <button
              type="button"
              className="px-btn"
              onClick={() => {
                const idx = (pendingConfirm.candidates.length + 1).toString().padStart(2, "0");
                setPendingConfirm((p) =>
                  p
                    ? {
                        ...p,
                        candidates: [
                          ...p.candidates,
                          { name: `manual_${idx}`, x: 0, y: 0, w: 64, h: 64 },
                        ],
                      }
                    : p
                );
              }}
            >
              {t("graph.add_candidate")}
            </button>
            <button
              type="button"
              className="px-btn"
              onClick={async () => {
                const p = pendingConfirm;
                setPendingConfirm(null);
                await p.submit(p.candidates);
              }}
            >
              {t("graph.confirm")}
            </button>
          </div>
        </div>
      )}
      <div className="graph-toolbar">
        <select
          className="px-btn graph-add-select"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) addNodeFromSchema(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">{t("graph.add_node")}</option>
          {schemas.map((s) => (
            <option key={s.type} value={s.type}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          type="button"
          className="px-btn"
          onClick={() => importRef.current?.click()}
          title={t("graph.import_hint")}
        >
          {t("graph.import")}
        </button>
        <button type="button" className="px-btn" onClick={onCreateGraph} title={t("graph.new")}>
          {t("graph.new")}
        </button>
        <button
          type="button"
          className="px-btn"
          onClick={exportGraph}
          title={t("graph.export_hint")}
        >
          {t("graph.export")}
        </button>
        <button
          type="button"
          className="px-btn graph-task-entry"
          onClick={openTaskPanel}
          title={t("graph.tasks")}
        >
          <ListTodo size={14} />
          {t("graph.tasks")}
          {running && <span className="graph-task-badge-inline">●</span>}
        </button>
        {running ? (
          <button type="button" className="px-btn danger" onClick={onCancel}>
            <Square size={14} />
            {t("graph.cancel")}
          </button>
        ) : (
          <button type="button" className="px-btn" onClick={onRun}>
            <Play size={14} />
            {t("graph.run")}
          </button>
        )}
        <button
          type="button"
          className="px-btn danger"
          onClick={() => {
            const sel = nodes.find((n) => n.selected);
            if (sel) onDeleteNode(sel.id);
          }}
          title={t("graph.delete_selected")}
        >
          <Trash2 size={14} />
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="graph-import-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportFile(f);
            e.target.value = "";
          }}
        />
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(_e, node) => openNodeEditor(node.id)}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={() => {
          closeContextMenu();
          setEditingNodeId(null);
        }}
        onNodeClick={closeContextMenu}
        onMoveStart={closeContextMenu}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <CanvasControls />
      </ReactFlow>
      {contextMenu && (
        <div
          className="graph-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerLeave={closeContextMenu}
        >
          <button
            type="button"
            className="graph-context-item"
            onClick={() => {
              openNodeEditor(contextMenu.nodeId);
              closeContextMenu();
            }}
          >
            {t("graph.edit_params")}
          </button>
          <button type="button" className="graph-context-item danger" onClick={() => removeNode(contextMenu.nodeId)}>
            {t("graph.delete_node")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- 页面：列表 + 选中画布 ----

export default function GraphPage() {
  const t = useT();
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [schemas, setSchemas] = useState<NodeSchema[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listGraphs().then(setGraphs).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    api.listGraphNodeSchemas().then(setSchemas).catch(() => {});
    return wsClient.subscribe((msg) => {
      if (msg.type === "graphs_changed") refresh();
    });
  }, [refresh]);

  const create = () => {
    api
      .createGraph(t("graph.default_name"))
      .then((r) => {
        refresh();
        setSelected(r.id);
      })
      .catch((e) => notify(String((e as Error).message)));
  };

  // 从模板一键建图（sprite 视频抽帧流水线等）
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description: string }>>([]);
  useEffect(() => {
    api.listGraphTemplates().then(setTemplates).catch(() => {});
  }, []);
  const createFromTemplate = (templateId: string) => {
    api
      .createGraphFromTemplate(templateId)
      .then((r) => {
        refresh();
        setSelected(r.id);
      })
      .catch((e) => notify(String((e as Error).message)));
  };

  // 导入工作流 JSON（导出格式）：文件选择 → 创建图 → 打开
  const importRef = useRef<HTMLInputElement>(null);
  const onImportFile = (file: File) => {
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as {
          name?: string;
          nodes: Array<{ type: string; params?: Record<string, unknown>; x?: number; y?: number }>;
          edges?: Array<{ from: number; fromPort: string; to: number; toPort: string }>;
        };
        if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
          throw new Error(t("graph.import_invalid"));
        }
        return api.importGraph({ name: parsed.name, nodes: parsed.nodes, edges: parsed.edges });
      })
      .then((r) => {
        refresh();
        setSelected(r.id);
      })
      .catch((e) => notify(String((e as Error).message)));
  };

  const remove = (id: string) => {
    api.deleteGraph(id).then(() => {
      if (selected === id) setSelected(null);
      refresh();
    }).catch(() => {});
  };

  // 任务面板（工具栏入口控制；GraphCanvas 的任务按钮回调）
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);

  // 侧栏：宽度可拖拽 + Ctrl+B 收起（localStorage 持久化；参照 layout.ts 双写模式，此处本地即可）
  const [sidebarW, setSidebarW] = useState(() => {
    const v = Number(localStorage.getItem("framebaker-graph-sidebar-w"));
    return Number.isFinite(v) && v >= 160 && v <= 420 ? v : 200;
  });
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem("framebaker-graph-sidebar-hidden") === "1"
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        setSidebarHidden((h) => {
          localStorage.setItem("framebaker-graph-sidebar-hidden", h ? "0" : "1");
          return !h;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    let latestW = startW;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(160, Math.min(420, startW + ev.clientX - startX));
      latestW = w;
      setSidebarW(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // 闭包里的 sidebarW 是拖拽前的旧值 —— 用 move 期间跟踪的最新值落盘
      localStorage.setItem("framebaker-graph-sidebar-w", String(Math.round(latestW)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="graph-page">
      <TaskPanel onOpenGraph={(id) => setSelected(id)} open={taskPanelOpen} onClose={() => setTaskPanelOpen(false)} />
      {sidebarHidden ? (
        <aside className="graph-list graph-list-collapsed">
          <button
            type="button"
            className="graph-list-expand"
            onClick={() => {
              setSidebarHidden(false);
              localStorage.setItem("framebaker-graph-sidebar-hidden", "0");
            }}
            title={t("graph.show_sidebar")}
          >
            <PanelLeftOpen size={16} />
          </button>
        </aside>
      ) : (
      <aside className="graph-list" style={{ width: sidebarW }}>
        <div className="graph-list-head">
          <GitBranch size={14} />
          <span>{t("graph.workflows")}</span>
          <span className="spacer" />
          {templates.length > 0 && (
            <select
              className="px-btn graph-add-select"
              defaultValue=""
              title={templates[0]!.description}
              onChange={(e) => {
                if (e.target.value) createFromTemplate(e.target.value);
                e.target.value = "";
              }}
            >
              <option value="">{t("graph.from_template")}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {graphs.map((g) => (
          <div key={g.id} className={`graph-list-item ${selected === g.id ? "active" : ""}`}>
            <button type="button" className="graph-list-btn" onClick={() => setSelected(g.id)}>
              {g.name}
            </button>
            <button type="button" className="graph-list-del" onClick={() => remove(g.id)} title={t("graph.delete")}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {graphs.length === 0 && <div className="graph-list-empty">{t("graph.empty")}</div>}
        <button
          type="button"
          className="graph-list-collapse"
          onClick={() => {
            setSidebarHidden(true);
            localStorage.setItem("framebaker-graph-sidebar-hidden", "1");
          }}
          title={t("graph.hide_sidebar") + " (Ctrl+B)"}
        >
          <PanelLeftClose size={14} />
        </button>
      </aside>
      )}
      {!sidebarHidden && <div className="graph-sidebar-resizer" onPointerDown={startResize} title={t("graph.resize_sidebar")} />}
      {selected ? (
        <ReactFlowProvider key={selected}>
          <GraphCanvas
          graphId={selected}
          schemas={schemas}
          onCreateGraph={create}
          onImportFile={onImportFile}
          openTaskPanel={() => setTaskPanelOpen((o) => !o)}
        />
        </ReactFlowProvider>
      ) : (
        <div className="graph-placeholder">{t("graph.select_hint")}</div>
      )}
    </div>
  );
}

// ---- 任务悬浮面板（ComfyUI 式）：角标 + 当前进度 + 执行历史 ----

type RunRecord = {
  id: string; graphId: string; graphName: string; startedAt: number;
  finishedAt: number | null; status: string;
  nodeStats: { total: number; done: number; cached: number; error: number };
};

function TaskPanel({
  onOpenGraph,
  open,
  onClose,
}: {
  onOpenGraph: (graphId: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  // 当前运行中的图（来自各画布共享的 WS 事件，跨图显示）
  const [live, setLive] = useState<{ graphId: string; graphName: string; nodeId: string; nodeType: string; progress: string }[]>([]);
  const runsRef = useRef<RunRecord[]>([]);

  const refresh = useCallback(() => {
    api.listGraphRuns().then((r) => {
      setRuns(r);
      runsRef.current = r;
    }).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return wsClient.subscribe((msg: WSMessage) => {
      if (msg.type === "graph_runs_changed") refresh();
      if (msg.type === "graph_node_status") {
        const p = msg.payload as { graphId?: string; nodeId?: string; status?: string; progress?: string };
        if (!p.graphId || !p.nodeId) return;
        setLive((cur) => {
          const rest = cur.filter((l) => l.graphId !== p.graphId);
          if (p.status === "running") {
            // 图名从执行记录里查（graph_runs_changed 已先于此事件刷新 runs）
            const name = runsRef.current.find((r) => r.graphId === p.graphId)?.graphName ?? "";
            return [...rest, { graphId: p.graphId!, graphName: name, nodeId: p.nodeId!, nodeType: "", progress: p.progress ?? "" }];
          }
          return rest;
        });
      }
    });
  }, [refresh]);

  const runningCount = live.length;
  const runningRun = runs.find((r) => r.status === "running");

  if (!open) return null;
  return (
    <div className="graph-task-fab">
      <div className="graph-task-panel">
        <div className="graph-task-head">
          <span>{t("graph.tasks")}</span>
          <span className="spacer" />
          <button type="button" className="graph-task-close" onClick={onClose} title={t("common.close")}>
            ✕
          </button>
        </div>
        {runningRun || runningCount > 0 ? (
          <div className="graph-task-live">
            {live.map((l) => (
              <div key={l.graphId} className="graph-task-live-row">
                <span className="graph-task-dot" />
                <span className="graph-task-name">{l.graphName || l.graphId.slice(0, 8)}</span>
                <span className="graph-task-progress">{l.progress || "…"}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="graph-task-empty">{t("graph.no_running")}</div>
        )}
        <div className="graph-task-history">
          {runs.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`graph-task-run ${r.status}`}
              onClick={() => onOpenGraph(r.graphId)}
              title={t("graph.open_graph")}
            >
              <span className="graph-task-run-name">{r.graphName}</span>
              <span className="graph-task-run-meta">
                {r.status === "running"
                  ? t("graph.running")
                  : r.nodeStats.error > 0
                    ? `${t("graph.run_error")} ${r.nodeStats.error}`
                    : `${r.nodeStats.done + r.nodeStats.cached}/${r.nodeStats.total}`}
              </span>
              <span className="graph-task-run-time">
                {new Date(r.startedAt).toLocaleTimeString(getLocale(), { hour12: false })}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
