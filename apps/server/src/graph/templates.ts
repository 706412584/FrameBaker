// 预置工作流模板 —— 节点 + 连线一次成型，一键创建。
// 「sprite 视频抽帧流水线」对齐 sprite 工坊的完整链路：
//   导入视频 → 抽帧 → 去底 → 画布归一 → 智能选帧 → 三种输出（完整包 / 透明视频 / 帧图片）

export interface TemplateNode {
  key: string; // 模板内引用键（连线用），非 DB id
  type: string;
  params: Record<string, unknown>;
  x: number;
  y: number;
}

export interface TemplateEdge {
  from: string; // TemplateNode.key
  fromPort: string;
  to: string;
  toPort: string;
}

export interface GraphTemplate {
  id: string;
  name: string;
  description: string;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
}

export const GRAPH_TEMPLATES: GraphTemplate[] = [
  {
    id: "sprite-pipeline",
    name: "视频抽帧流水线",
    description: "视频 → 抽帧 → 去底 → 画布归一 → 智能选帧 → 完整包/透明视频/帧图片（sprite 工坊完整链路）",
    nodes: [
      { key: "src", type: "material.video", params: { materialId: "" }, x: 0, y: 0 },
      { key: "extract", type: "extract.frames", params: { fps: 8 }, x: 230, y: 0 },
      { key: "matte", type: "matte.pipeline", params: { useChroma: false, useSpriteflow: true, sfTolerance: 15, threshold: 80, softness: 32, despillStrength: 0.85, haloPixels: 1, decontaminate: true }, x: 460, y: 0 },
      { key: "canvas", type: "frame.canvas", params: { targetSize: 512, reducePx: 20, canvasMode: "auto", trim: true }, x: 690, y: 0 },
      { key: "select", type: "frames.smart-select", params: { targetCount: 12 }, x: 920, y: 0 },
      { key: "pkg", type: "export.package", params: { columns: 4, sheetFormat: "png", includeZip: true, includeManifest: true, durationMs: 100, manifestFormats: "phaser_hash,phaser_array,sparrow_xml,cocos_plist,godot_tres,sprite2d_xml" }, x: 1200, y: -140 },
      { key: "video", type: "export.video", params: { durationMs: 100 }, x: 1200, y: 0 },
      { key: "frames", type: "export.frames", params: {}, x: 1200, y: 140 },
    ],
    edges: [
      { from: "src", fromPort: "video", to: "extract", toPort: "video" },
      { from: "extract", fromPort: "images", to: "matte", toPort: "images" },
      { from: "matte", fromPort: "images", to: "canvas", toPort: "images" },
      { from: "canvas", fromPort: "images", to: "select", toPort: "images" },
      { from: "select", fromPort: "images", to: "pkg", toPort: "images" },
      { from: "select", fromPort: "images", to: "video", toPort: "images" },
      { from: "select", fromPort: "images", to: "frames", toPort: "images" },
    ],
  },
  {
    id: "char-anim-bake",
    name: "立绘骨骼动画",
    description: "立绘 → See-through 语义分层 → 骨段映射 → 烘 idle/walk 动作 → 精灵表+逐帧（本地免费，替代动作视频生成）",
    nodes: [
      { key: "src", type: "material.image", params: { materialId: "" }, x: 0, y: 0 },
      { key: "st", type: "comfy.seethrough", params: { resolution: 1024, depthResolution: 640 }, x: 230, y: 0 },
      { key: "map", type: "anim.map-parts", params: { singleFoot: false, splitSleeve: false }, x: 460, y: 0 },
      { key: "bake", type: "anim.bake", params: { clip: "motion-original-preset-idle", frameCount: 8 }, x: 690, y: 0 },
      { key: "frames", type: "export.frames", params: {}, x: 920, y: 0 },
    ],
    edges: [
      { from: "src", fromPort: "images", to: "st", toPort: "images" },
      { from: "st", fromPort: "rects", to: "map", toPort: "rects" },
      { from: "map", fromPort: "sheet", to: "bake", toPort: "sheet" },
      { from: "bake", fromPort: "images", to: "frames", toPort: "images" },
    ],
  },
  {
    id: "char-h3-video",
    name: "立绘动作视频",
    description: "立绘 → H3 生成动作循环视频 → 抽帧 → 抠图 → 画布归一 → 输出（本地 ComfyUI 免费路线）",
    nodes: [
      { key: "src", type: "material.image", params: { materialId: "" }, x: 0, y: 0 },
      { key: "h3", type: "comfy.h3-video", params: { action: "idle" }, x: 230, y: 0 },
      { key: "extract", type: "extract.frames", params: { fps: 8 }, x: 460, y: 0 },
      { key: "matte", type: "matte.pipeline", params: { useChroma: false, useSpriteflow: true, sfTolerance: 15, threshold: 80, softness: 32, despillStrength: 0.85, haloPixels: 1, decontaminate: true }, x: 690, y: 0 },
      { key: "canvas", type: "frame.canvas", params: { targetSize: 512, reducePx: 20, canvasMode: "auto", trim: true }, x: 920, y: 0 },
      { key: "frames", type: "export.frames", params: {}, x: 1150, y: 0 },
    ],
    edges: [
      { from: "src", fromPort: "images", to: "h3", toPort: "images" },
      { from: "h3", fromPort: "video", to: "extract", toPort: "video" },
      { from: "extract", fromPort: "images", to: "matte", toPort: "images" },
      { from: "matte", fromPort: "images", to: "canvas", toPort: "images" },
      { from: "canvas", fromPort: "images", to: "frames", toPort: "images" },
    ],
  },
  {
    id: "ai-image-gen",
    name: "AI 图片生成",
    description: "提示词 → Z-Image Turbo 生图 → 入库素材库 + 输出 PNG（本地 ComfyUI 免费路线）",
    nodes: [
      { key: "gen", type: "comfy.image-gen", params: { prompt: "", size: 1024 }, x: 0, y: 0 },
      { key: "toLib", type: "frames.to-material", params: { name: "ai_gen" }, x: 230, y: -80 },
      { key: "frames", type: "export.frames", params: {}, x: 230, y: 80 },
    ],
    edges: [
      { from: "gen", fromPort: "images", to: "toLib", toPort: "images" },
      { from: "gen", fromPort: "images", to: "frames", toPort: "images" },
    ],
  },
  {
    id: "ai-image-edit",
    name: "AI 图片编辑",
    description: "素材图 → Qwen-Image-Edit 2509 按指令编辑（改背景/配色/服饰）→ 入库 + 输出（本地 ComfyUI 免费路线）",
    nodes: [
      { key: "src", type: "material.image", params: { materialId: "" }, x: 0, y: 0 },
      { key: "edit", type: "comfy.image-edit", params: { prompt: "" }, x: 230, y: 0 },
      { key: "toLib", type: "frames.to-material", params: { name: "ai_edit" }, x: 460, y: -80 },
      { key: "frames", type: "export.frames", params: {}, x: 460, y: 80 },
    ],
    edges: [
      { from: "src", fromPort: "images", to: "edit", toPort: "images" },
      { from: "edit", fromPort: "images", to: "toLib", toPort: "images" },
      { from: "edit", fromPort: "images", to: "frames", toPort: "images" },
    ],
  },
  {
    id: "layered-psd",
    name: "UI 图分层 PSD",
    description: "UI 完整图 → 本地 Qwen-Image-Layered 遮挡分层（免费）→ 图层合成 PSD（可导入 PS/GIMP 继续编辑）",
    nodes: [
      { key: "src", type: "material.image", params: { materialId: "" }, x: 0, y: 0 },
      { key: "layered", type: "comfy.layered", params: { prompt: "", layers: 2, size: 640, filterSolid: true }, x: 230, y: 0 },
      { key: "psd", type: "layers.to-psd", params: { name: "ui_layers" }, x: 460, y: 0 },
    ],
    edges: [
      { from: "src", fromPort: "images", to: "layered", toPort: "images" },
      { from: "layered", fromPort: "images", to: "psd", toPort: "images" },
    ],
  },
  {
    id: "ui-slice",
    name: "UI 切片",
    description: "UI 大图 → OpenCV 候选框 + GrabCut 去底图层 → 入库素材库 + 输出帧图片（sprite ui-layer-lab 完整能力）",
    nodes: [
      { key: "src", type: "material.image", params: { materialId: "" }, x: 0, y: 0 },
      { key: "analyze", type: "ui.layer.analyze", params: { maxNodes: 64, minSize: 8, alphaMode: "cutout" }, x: 230, y: 0 },
      { key: "toLib", type: "frames.to-material", params: { name: "ui_slice" }, x: 460, y: -80 },
      { key: "frames", type: "export.frames", params: {}, x: 460, y: 80 },
    ],
    edges: [
      { from: "src", fromPort: "images", to: "analyze", toPort: "images" },
      { from: "analyze", fromPort: "images", to: "toLib", toPort: "images" },
      { from: "analyze", fromPort: "images", to: "frames", toPort: "images" },
    ],
  },
];
