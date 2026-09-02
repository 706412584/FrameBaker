// 节点注册表：type -> schema。
// 依赖方向遵循 AGENTS.md:39 —— graph/ -> jobs/ 单向；节点实现不得反向 import 执行器。
import type { NodeSchema, PortDef } from "@framebaker/shared";

/** 手写端口定义的简写 */
const port = (name: string, type: PortDef["type"], label: string): PortDef => ({ name, type, label });

/** 阶段1 链路四节点 —— 全部复用既有能力，无新算法 */
export const NODE_SCHEMAS: NodeSchema[] = [
  {
    type: "material.video",
    label: "视频素材",
    inputs: [],
    outputs: [port("video", "video", "视频")],
    paramsSchema: {
      type: "object",
      properties: { materialId: { type: "string", title: "素材 UUID" } },
      required: ["materialId"],
    },
    execution: "server",
  },
  {
    type: "material.image",
    label: "图片素材",
    inputs: [],
    outputs: [port("images", "image[]", "帧序列")],
    paramsSchema: {
      type: "object",
      properties: { materialId: { type: "string", title: "素材 UUID" } },
      required: ["materialId"],
    },
    execution: "server",
  },
  {
    type: "extract.frames",
    label: "视频抽帧",
    inputs: [port("video", "video", "视频")],
    outputs: [port("images", "image[]", "帧序列")],
    paramsSchema: {
      type: "object",
      properties: {
        fps: { type: "number", title: "固定帧率", description: "与 timestamps 二选一" },
        timestamps: { type: "array", items: { type: "number" }, title: "定点时间戳（秒）" },
        startTime: { type: "number", title: "起始秒", default: 0, description: "区间抽帧起点" },
        endTime: { type: "number", title: "结束秒", default: 0, description: "0 = 到结尾" },
        keepEvery: { type: "integer", title: "每隔 N 帧取 1", default: 1, minimum: 1, description: "1 = 全保留" },
      },
    },
    execution: "server",
  },
  {
    type: "matte.batch",
    label: "批量抠图",
    inputs: [port("images", "image[]", "帧序列")],
    outputs: [port("images", "image[]", "抠后帧序列")],
    paramsSchema: { type: "object", properties: {} },
    execution: "server",
  },
  {
    type: "export.spritesheet",
    label: "导出精灵表",
    inputs: [port("images", "image[]", "帧序列")],
    outputs: [port("sheet", "sheet", "精灵表")],
    paramsSchema: {
      type: "object",
      properties: {
        columns: { type: "number", title: "列数" },
        maxDimension: { type: "number", title: "单边上限 px", default: 16384 },
      },
    },
    execution: "server",
  },
];

const registry = new Map(NODE_SCHEMAS.map((schema) => [schema.type, schema]));

/** 阶段2：sprite 原子抠图节点（matte.<mode>）——共用同一形状，仅 type/label/参数不同 */
const MATTE_MODES = [
  { type: "matte.chroma", label: "抠图·色键", params: { threshold: 42, softness: 12, despillStrength: 0.5, haloPixels: 0 } },
  { type: "matte.spriteflow", label: "抠图·SpriteFlow", params: { sfTolerance: 120, sfEdgeBlend: true, sfBlendZoneRatio: 0.6, sfAlphaCutoff: 8, sfSpillRemoval: true, sfSpillStrength: 0.45 } },
  { type: "matte.birefnet", label: "抠图·BiRefNet", params: { aiModel: "birefnet-general", aiDevice: "auto", aiResolution: 1024 } },
  { type: "matte.corridorkey", label: "抠图·走廊键", params: { corridorkeyScreen: "auto" } },
  { type: "matte.luma", label: "抠图·亮度", params: { lumaBlack: 8, lumaWhite: 235, lumaGamma: 1.0, lumaStrength: 1.0 } },
  { type: "matte.additive", label: "抠图·加色", params: { lumaBlack: 8, lumaWhite: 235, lumaGamma: 1.0, lumaStrength: 1.0 } },
] as const;
for (const m of MATTE_MODES) {
  registry.set(m.type, {
    type: m.type,
    label: m.label,
    inputs: [port("images", "image[]", "帧序列")],
    outputs: [port("images", "image[]", "抠后帧序列")],
    paramsSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(m.params).map(([k, v]) => [k, { type: typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v, title: k }])
      ),
    },
    execution: "server",
  });
}
// 边缘净化（可接在任何抠图后）
registry.set("image.decontaminate", {
  type: "image.decontaminate",
  label: "边缘净化",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "净化帧序列")],
  paramsSchema: {
    type: "object",
    properties: {
      decontaminateRadius: { type: "integer", title: "半径", default: 2 },
      decontaminateStrength: { type: "number", title: "强度", default: 1.0 },
    },
  },
  execution: "server",
});
// 组合抠图管线（与 sprite matte_pipeline 语义完全一致：单次调用、alpha 并集合并、
// 末尾统一 despill+decontaminate —— 与逐个原子节点串联（顺序应用）语义不同）
registry.set("matte.pipeline", {
  type: "matte.pipeline",
  label: "抠图·组合管线",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "抠后帧序列")],
  paramsSchema: {
    type: "object",
    properties: {
      // 抠图模式多选（对齐 sprite 勾选式；固定顺序执行 + alpha 并集合并，additive 全局行为保留）。
      // 全空 = 不抠图（原样输出）。旧图 compat：开关全空但 params.pipeline 字符串存在时回落该串。
      useChroma: { type: "boolean", title: "绿幕 / 纯色", default: true, description: "适合可控纯色背景，速度最快" },
      useSpriteflow: { type: "boolean", title: "SpriteFlow 色键", default: false, description: "边缘渐变色键，含混合区与去溢色" },
      useBirefnet: { type: "boolean", title: "BiRefNet AI", default: false, description: "AI 主体抠图，适合复杂背景" },
      useCorridorkey: { type: "boolean", title: "CorridorKey 走廊", default: false, description: "重建绿/蓝幕边缘，需排在色键后（固定序已保证）" },
      useLuma: { type: "boolean", title: "Luma 亮度", default: false, description: "按亮度保留火焰、闪电、粒子等特效" },
      useAdditive: { type: "boolean", title: "发光特效", default: false, description: "最大 RGB 生成 alpha，适合黑底火焰；开启后跳过去溢色与边缘净化以保留光晕" },
      threshold: { type: "integer", title: "色键阈值", default: 80 },
      softness: { type: "integer", title: "边缘柔化", default: 32 },
      despillStrength: { type: "number", title: "去溢色强度", default: 0.85 },
      haloPixels: { type: "integer", title: "光晕收缩 px", default: 1 },
      keyMode: { type: "string", title: "键色来源", default: "auto", enum: ["auto", "manual"], enumLabels: { auto: "自动", manual: "手动" } },
      manualKeyHex: { type: "string", title: "手动键色", default: "#00FF00" },
      aiModel: { type: "string", title: "AI 模型", default: "birefnet-general" },
      aiDevice: { type: "string", title: "推理设备", default: "auto", enum: ["auto", "cuda", "cpu"] },
      aiResolution: { type: "integer", title: "AI 分辨率", default: 1024 },
      lumaBlack: { type: "integer", title: "亮度黑点", default: 8 },
      lumaWhite: { type: "integer", title: "亮度白点", default: 235 },
      lumaGamma: { type: "number", title: "亮度伽马", default: 1.0 },
      lumaStrength: { type: "number", title: "亮度强度", default: 1.0 },
      corridorkeyScreen: { type: "string", title: "走廊幕色", default: "auto", enum: ["auto", "green", "blue"] },
      sfTolerance: { type: "number", title: "SF 容差", default: 120 },
      sfEdgeBlend: { type: "boolean", title: "SF 边缘混合", default: true },
      sfBlendZoneRatio: { type: "number", title: "SF 混合区", default: 0.6 },
      sfAlphaCutoff: { type: "integer", title: "SF Alpha 截断", default: 8 },
      sfSpillRemoval: { type: "boolean", title: "SF 去溢色", default: true },
      sfSpillStrength: { type: "number", title: "SF 去溢强度", default: 0.45 },
      decontaminate: { type: "boolean", title: "边缘净化", default: true },
      decontaminateRadius: { type: "integer", title: "净化半径", default: 2 },
      decontaminateStrength: { type: "number", title: "净化强度", default: 1.0 },
      effectProtectionEnabled: { type: "boolean", title: "特效保护", default: false, description: "高亮半透明像素恢复不透明（火焰/光效）" },
      effectProtectionThreshold: { type: "integer", title: "特效阈值", default: 200 },
    },
  },
  execution: "server",
});

// 像素量化（客户端 imageops worker 执行；迁移自 sprite quantizeEngine，算法不变）
registry.set("quantize.pixel", {
  type: "quantize.pixel",
  label: "像素量化",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "量化帧序列"), port("palette", "palette", "调色板")],
  paramsSchema: {
    type: "object",
    properties: {
      colors: { type: "integer", title: "颜色数", default: 16, minimum: 2, maximum: 256 },
      method: {
        type: "string", title: "量化算法", default: "wuquant",
        enum: ["wuquant", "neuquant", "rgbquant"],
        enumLabels: { wuquant: "WuQuant（推荐）", neuquant: "NeuQuant", rgbquant: "RGBQuant" },
      },
      dithering: {
        type: "string", title: "抖动", default: "nearest",
        enum: ["nearest", "floyd-steinberg", "stucki", "atkinson", "jarvis", "burkes", "sierra"],
        enumLabels: { nearest: "无抖动（像素风推荐）", "floyd-steinberg": "Floyd-Steinberg", stucki: "Stucki", atkinson: "Atkinson", jarvis: "Jarvis", burkes: "Burkes", sierra: "Sierra" },
      },
      pixelSize: { type: "integer", title: "像素块", default: 1, minimum: 1, maximum: 32 },
    },
  },
  execution: "client",
});

// UI 智能切片（客户端）：analyze 出候选框 rect[]，crop 按框裁出 image[]
registry.set("slice.ui.analyze", {
  type: "slice.ui.analyze",
  label: "UI 切片检测",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("rects", "rect[]", "候选框")],
  paramsSchema: {
    type: "object",
    properties: {
      alphaThreshold: { type: "integer", title: "Alpha 阈值", default: 16 },
      alphaFloodThreshold: { type: "integer", title: "连通阈值", default: 80 },
      colorThreshold: { type: "integer", title: "颜色距离", default: 36 },
      minSize: { type: "integer", title: "最小边", default: 8 },
      mergeGap: { type: "integer", title: "合并间距", default: 2 },
      padding: { type: "integer", title: "外扩", default: 4 },
      /** true = 检测后在画布上暂停，等用户调整/确认候选框再继续下游（人在环） */
      interactive: { type: "boolean", title: "人工确认候选框", default: false },
    },
  },
  execution: "client",
});
registry.set("slice.ui.crop", {
  type: "slice.ui.crop",
  label: "UI 切片裁剪",
  inputs: [port("images", "image[]", "帧序列"), port("rects", "rect[]", "候选框")],
  outputs: [port("images", "image[]", "切片序列")],
  paramsSchema: {
    type: "object",
    properties: {
      padding: { type: "integer", title: "外扩", default: 0 },
    },
  },
  execution: "client",
});

// ===== sprite 视频抽帧流水线对齐：输出与帧处理节点 =====

// 图片输出：帧序列落盘为独立 PNG（最终输出，无下游必需）
registry.set("export.frames", {
  type: "export.frames",
  label: "输出·帧图片",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "帧序列")],
  paramsSchema: { type: "object", properties: {} },
  execution: "server",
});
// 视频输出：qtrle 保 alpha 的 .mov（对齐 sprite save_alpha_mov）
registry.set("export.video", {
  type: "export.video",
  label: "输出·透明视频",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("video", "video", "视频")],
  paramsSchema: {
    type: "object",
    properties: {
      durationMs: { type: "integer", title: "每帧时长 ms", default: 100, minimum: 20, maximum: 5000 },
    },
  },
  execution: "server",
});
// 裁剪（对齐 ProcessSettings.crop_*）
registry.set("frame.crop", {
  type: "frame.crop",
  label: "帧·裁剪",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "裁剪帧序列")],
  paramsSchema: {
    type: "object",
    properties: {
      x: { type: "integer", title: "X", default: 0 },
      y: { type: "integer", title: "Y", default: 0 },
      w: { type: "integer", title: "宽" },
      h: { type: "integer", title: "高" },
    },
    required: ["w", "h"],
  },
  execution: "server",
});
// 画布归一（对齐 ProcessSettings.target_size/reduce_px/canvas_mode）
registry.set("frame.canvas", {
  type: "frame.canvas",
  label: "帧·画布归一",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "归一帧序列")],
  paramsSchema: {
    type: "object",
    properties: {
      targetSize: { type: "integer", title: "目标尺寸（画布高）", default: 0, description: "0 = 不缩放（仅按 trim 裁剪）" },
      reducePx: { type: "integer", title: "整体缩减 px", default: 0, description: "画布边距" },
      canvasMode: {
        type: "string", title: "画布模式", default: "auto",
        enum: ["auto", "square_bottom", "square_center"],
        enumLabels: { auto: "自适应宽度", square_bottom: "方形·贴底", square_center: "方形·居中" },
      },
      trim: { type: "boolean", title: "裁掉透明边", default: true, description: "按 alpha 边界裁剪（sprite 默认行为）" },
    },
  },
  execution: "server",
});
// alpha 后处理（对齐 batch_green_to_black / batch_semitransparent_to_black / _to_opaque）
registry.set("frame.alpha", {
  type: "frame.alpha",
  label: "帧·Alpha 处理",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "处理帧序列")],
  paramsSchema: {
    type: "object",
    properties: {
      greenToBlack: { type: "boolean", title: "绿转黑", default: false },
      semitransparentToBlack: { type: "boolean", title: "半透明转黑", default: false },
      semitransparentToOpaque: { type: "boolean", title: "半透明转不透明", default: false },
      alphaMin: { type: "integer", title: "Alpha 下限", default: 1 },
      alphaMax: { type: "integer", title: "Alpha 上限", default: 254 },
    },
  },
  execution: "server",
});
// 智能选帧（对齐 suggest_job_frames：网格分桶 + 差异签名去重）
registry.set("frames.smart-select", {
  type: "frames.smart-select",
  label: "智能选帧",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "选中帧序列")],
  paramsSchema: {
    type: "object",
    properties: {
      targetCount: { type: "integer", title: "目标帧数", default: 12, minimum: 1 },
    },
  },
  execution: "server",
});

// 单帧预览（对齐 sprite preview_frame 的"时间点取帧"）：视频 → 指定秒的单帧。
// 下游接抠图节点即得"该帧抠图效果"——sprite 的单帧调参工作流。
registry.set("preview.frame", {
  type: "preview.frame",
  label: "单帧预览",
  inputs: [port("video", "video", "视频")],
  outputs: [port("images", "image[]", "预览帧")],
  paramsSchema: {
    type: "object",
    properties: {
      sampleTime: { type: "number", title: "采样秒", default: 0, minimum: 0, description: "拖动下方时间轴或直接输入" },
    },
  },
  execution: "server",
});

// 完整导出包（对齐 sprite export_job：sheet png/webp + frames.zip + export.json + 引擎 manifest）
registry.set("export.package", {
  type: "export.package",
  label: "输出·完整包",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("sheet", "sheet", "导出包")],
  paramsSchema: {
    type: "object",
    properties: {
      columns: { type: "integer", title: "列数", default: 4 },
      sheetFormat: { type: "string", title: "图集格式", default: "png", enum: ["png", "webp", "both"], enumLabels: { png: "PNG", webp: "WebP", both: "PNG + WebP" } },
      webpQuality: { type: "integer", title: "WebP 质量", default: 90, minimum: 1, maximum: 100 },
      includeZip: { type: "boolean", title: "帧 ZIP", default: true },
      includeManifest: { type: "boolean", title: "export.json", default: true },
      durationMs: { type: "integer", title: "每帧时长 ms", default: 100 },
      manifestPhaserHash: { type: "boolean", title: "Phaser JSON(hash)", default: false },
      manifestPhaserArray: { type: "boolean", title: "Phaser JSON(array)", default: false },
      manifestSparrowXml: { type: "boolean", title: "Sparrow/Starling XML", default: false },
      manifestCocosPlist: { type: "boolean", title: "Cocos plist", default: false },
      manifestGodotTres: { type: "boolean", title: "Godot 4 .tres", default: false },
      manifestSprite2dXml: { type: "boolean", title: "Urho3D sprite2d", default: false },
    },
  },
  execution: "server",
});

// ===== sprite 其余能力节点（复用 server.py 原函数，经 matte_cli.py op 通道）=====

// PSD 分层拆解（对齐 POST /api/psd-split）：PSD 素材 → 图层 PNG 序列
registry.set("material.psd", {
  type: "material.psd",
  label: "PSD 分层",
  inputs: [],
  outputs: [port("images", "image[]", "图层序列")],
  paramsSchema: {
    type: "object",
    properties: {
      materialId: { type: "string", title: "素材 UUID" },
      psdExclude: { type: "string", title: "排除词（逗号分隔）", default: "" },
      psdHide: { type: "string", title: "隐藏词（逗号分隔）", default: "" },
      psdOnlyVisible: { type: "boolean", title: "仅可见层", default: false },
    },
    required: ["materialId"],
  },
  execution: "server",
});
// 背景修补（对齐 POST /api/bg-inpaint：LaMa / OpenCV inpaint）
registry.set("image.bg-inpaint", {
  type: "image.bg-inpaint",
  label: "背景修补",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "修补帧序列")],
  paramsSchema: {
    type: "object",
    properties: {
      rects: { type: "string", title: "修补区域 [[x,y,w,h],...]", default: "" },
      aiDevice: { type: "string", title: "推理设备", default: "auto", description: "auto | cuda | cpu" },
    },
    required: ["rects"],
  },
  execution: "server",
});
// 姿态检测（对齐 POST /api/pose-detect：归一化关键点 + 置信度）
registry.set("pose.detect", {
  type: "pose.detect",
  label: "姿态检测",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "可视化帧序列"), port("poses", "rect[]", "关键点数据")],
  paramsSchema: { type: "object", properties: {} },
  execution: "server",
});
// 人体解析（对齐 POST /api/human-parse：ATR 语义部件 + head/torso 复合件）
registry.set("human.parse", {
  type: "human.parse",
  label: "人体解析",
  inputs: [port("images", "image[]", "帧序列")],
  outputs: [port("images", "image[]", "部件序列"), port("poses", "rect[]", "部件清单")],
  paramsSchema: {
    type: "object",
    properties: {
      aiDevice: { type: "string", title: "推理设备", default: "auto" },
    },
  },
  execution: "server",
});
// 场景分层（复用 FrameBaker 既有 image_layers 能力：Qwen-Image-Layered /images/layers；
// splitImageLayers 走素材库，故输入为素材 id 而非上游帧）
registry.set("image.layers", {
  type: "image.layers",
  label: "场景分层",
  inputs: [],
  outputs: [port("images", "image[]", "图层序列")],
  paramsSchema: {
    type: "object",
    properties: {
      materialId: { type: "string", title: "素材 UUID" },
      layerCount: { type: "integer", title: "图层数", default: 4, minimum: 1, maximum: 4 },
    },
    required: ["materialId"],
  },
  execution: "server",
});

export function getNodeSchema(type: string): NodeSchema | undefined {
  return registry.get(type);
}

export function listNodeSchemas(): NodeSchema[] {
  return [...registry.values()];
}

/**
 * 连线类型校验：输出端口与输入端口的 PortType 必须一致，不做隐式转换。
 * 调用方（API 层）从 graph_nodes 解析两端节点的 type 后传入。
 */
export function portsCompatible(
  from: { type: string; port: string } | undefined,
  to: { type: string; port: string }
): boolean {
  if (!from) return false;
  const fromSchema = registry.get(from.type);
  const toSchema = registry.get(to.type);
  if (!fromSchema || !toSchema) return false;
  const out = fromSchema.outputs.find((p) => p.name === from.port);
  const inp = toSchema.inputs.find((p) => p.name === to.port);
  return !!out && !!inp && out.type === inp.type;
}
