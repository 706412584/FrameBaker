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
];
