import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MaterialRow } from "@framebaker/shared";
import { IMAGE_LAYER_COUNT_MAX, IMAGE_LAYER_COUNT_MIN } from "@framebaker/shared";
import { db, getMaterial, renameMaterial, uid, STORAGE_ROOT, serializeMaterial } from "../../db";
import { broadcast } from "../../ws";
import { createJob, createMattingJob } from "../../queue";
import { EXTRACT_TIMESTAMPS_MAX, normalizeExtractTimestamps } from "../../jobs/extract";
import { getImageLayerSettings, imageLayerConfigured, getSpriteMattingSettings, spriteMattingConfigured } from "../../provider";
import { isValidSpritePipeline } from "../../jobs/matting";
import { getAiEngineStatus } from "../../jobs/aiEngine";
import { AI_ENGINE_PYTHON, BUNDLED_SPRITE_PYTHON } from "../../paths";
import { ok, err, sortMaterialsByFrameNumber, importMaterialToProject } from "../helpers";
import { invalidateProjectUndo } from "../../undo";

export function register(server: McpServer) {
  server.registerTool(
    "list_materials",
    {
      title: "List Materials",
      description:
        "List all materials in the library sorted by creation time (newest first). Each material has id, name, status (raw/matted), source, kind (image/video), folder_id, and metadata.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const rows = db
        .query("SELECT * FROM materials ORDER BY created_at DESC")
        .all() as MaterialRow[];
      return ok({ materials: rows.map(serializeMaterial) });
    }
  );

  server.registerTool(
    "rename_material",
    {
      title: "Rename Material",
      description: "Rename one image or video material in the material library.",
      inputSchema: z.object({
        materialId: z.string().describe("Material UUID"),
        name: z.string().trim().min(1).max(200).describe("New material name"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ materialId, name }) => {
      const material = renameMaterial(materialId, name);
      if (!material) return err("素材不存在");
      broadcast("material_updated", { id: materialId });
      return ok({ material: serializeMaterial(material) });
    }
  );

  server.registerTool(
    "matting_material",
    {
      title: "Matting Material",
      description:
        "Run background removal on a single material. Creates an async job—returns jobId. Engine resolution: pipeline param set (chroma/spriteflow/birefnet/corridorkey/luma/additive, comma-combined — runs sprite matte_cli.py, birefnet/corridorkey auto-switch to AI engine venv when configured python lacks torch) → else configured matting engine (custom CLI → bundled rembg → PATH rembg → passthrough). Same material with active matting job returns error.",
      inputSchema: z.object({
        materialId: z.string().describe("Material UUID"),
        pipeline: z.string().optional().describe("Sprite pipeline mode(s): chroma, spriteflow, birefnet, corridorkey, luma, additive — comma-separated for combination (e.g. 'chroma,birefnet'). Empty = default rembg engine."),
        model: z.string().optional().describe("rembg model override (u2net / u2netp / u2net_human_seg / isnet-general-use / isnet-anime / birefnet-general / birefnet-portrait). Only used when pipeline is empty."),
        mattingParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Sprite pipeline tuning params (camelCase keys): chroma→threshold(default 20 safe)/softness/despillStrength/keyMode/manualKeyHex; spriteflow→sfTolerance(25)/sfBlendZoneRatio/sfSpillRemoval/sfSpillStrength; birefnet→aiResolution; corridorkey→corridorkeyScreen; luma→lumaBlack/lumaWhite/lumaStrength. Defaults are conservative — omit unless the matting result is wrong."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId, pipeline, model, mattingParams }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      if (!m.raw_path || !existsSync(m.raw_path)) return err("素材缺少 raw 文件");
      if (/\.(mp4|mov|webm|avi)$/i.test(m.raw_path)) return err("视频素材不能抠图，请先抽帧");
      const mode = pipeline?.trim() ?? "";
      if (mode && !isValidSpritePipeline(mode)) {
        return err("不支持的抠图管线：" + mode + "（可用：chroma/spriteflow/birefnet/corridorkey/luma/additive）");
      }
      if (mode && !spriteMattingConfigured(getSpriteMattingSettings())) {
        return err("sprite 抠图未配置：设置页填 pythonBin 与 matte_cli.py 路径");
      }
      const r = createMattingJob("", "material", m.id, mode || undefined, model?.trim() || undefined, mattingParams);
      if (r.duplicate) return err("该素材已有进行中的抠图任务");
      return ok({ jobId: r.jobId });
    }
  );

  server.registerTool(
    "split_material_layers_local",
    {
      title: "Split Material Layers (Local ComfyUI)",
      description:
        "Decompose a flat image into RGBA layers via LOCAL ComfyUI Qwen-Image-Layered (free, needs local ComfyUI running; ~6-10 min). Alternative to split_material_layers (cloud). prompt describes the whole image incl. occluded parts to guide inpainting. Creates an async comfy_layers job; output layers land as new materials.",
      inputSchema: z.object({
        materialId: z.string(),
        prompt: z.string().optional().describe("Whole-image description incl. occluded parts (guides inpaint)"),
        layers: z.number().int().min(1).max(4).default(2).describe("Layer count; outputs = layers (+1 background, solid layers auto-filtered)"),
        size: z.number().int().min(512).max(1024).default(640).describe("Resolution (640 recommended)"),
        filterSolid: z.boolean().default(true).describe("Drop fully-opaque background plates"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId, prompt, layers, size, filterSolid }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      const input = m.processed_path && existsSync(m.processed_path) ? m.processed_path : m.raw_path;
      if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) return err("只支持图片素材分层");
      const jobId = createJob("", "comfy_layers", { comfyLayers: {
        materialId, prompt: prompt?.trim() ?? "", layers, size, filterSolid,
      } });
      return ok({ jobId });
    }
  );

  server.registerTool(
    "get_ai_engine_status",
    {
      title: "Get AI Engine Status",
      description:
        "Check the on-demand AI matting engine (desktop packaged build): installed BiRefNet models, venv-ai (torch) and venv-rembg readiness. Source-code dev builds return installed:false (configure spriteMatting in settings instead).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ok({ aiEngine: getAiEngineStatus() })
  );

  server.registerTool(
    "split_material_layers",
    {
      title: "Split Material Layers",
      description: "Decompose a flat image into editable RGBA scene layers such as background, whole subject, props, and foreground. This does not split a character into body parts. Creates an async image_layers job.",
      inputSchema: z.object({
        materialId: z.string(),
        layers: z.number().int().min(IMAGE_LAYER_COUNT_MIN).max(IMAGE_LAYER_COUNT_MAX).default(4),
        numInferenceSteps: z.number().int().min(1).max(100).default(50),
        trueCfgScale: z.number().min(0).max(20).default(4),
        negativePrompt: z.string().optional(), seed: z.number().int().min(0).default(0),
        autoMatting: z.boolean().optional().describe("Remove the background before splitting when the material has no processed image"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId, layers, numInferenceSteps, trueCfgScale, negativePrompt, seed, autoMatting }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      const input = m.processed_path && existsSync(m.processed_path) ? m.processed_path : m.raw_path;
      if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) return err("只支持图片素材分层");
      const settings = getImageLayerSettings();
      if (!imageLayerConfigured(settings)) return err("图片分层服务未配置完整");
      const jobId = createJob("", "image_layers", { imageLayers: {
        materialId, model: settings.model, layers, numInferenceSteps, trueCfgScale,
        negativePrompt: negativePrompt?.trim() || undefined, seed, autoMatting,
      } });
      return ok({ jobId });
    }
  );

  server.registerTool(
    "batch_matting",
    {
      title: "Batch Matting",
      description:
        "Run background removal on multiple materials at once. Only materials with status=raw are enqueued; already matted, video, or with active matting jobs are skipped. pipeline param routes to sprite matte_cli.py (chroma/birefnet/...) instead of the default rembg engine. Returns count of enqueued and skipped.",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("Material UUIDs to process"),
        pipeline: z.string().optional().describe("Sprite pipeline mode(s), comma-combined (e.g. 'birefnet' or 'chroma,luma'). Empty = default rembg engine."),
        model: z.string().optional().describe("rembg model override (only when pipeline is empty)"),
        mattingParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Sprite pipeline tuning params, same keys as matting_material"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ ids, pipeline, model, mattingParams }) => {
      const mode = pipeline?.trim() ?? "";
      if (mode && !isValidSpritePipeline(mode)) return err("不支持的抠图管线：" + mode);
      let count = 0;
      let skipped = 0;
      for (const id of ids) {
        const m = getMaterial(id);
        if (!m || !m.raw_path || !existsSync(m.raw_path)) continue;
        if (/\.(mp4|mov|webm|avi)$/i.test(m.raw_path) || m.status === "matted") {
          skipped++;
          continue;
        }
        const r = createMattingJob("", "material", id, mode || undefined, model?.trim() || undefined, mattingParams);
        if (r.duplicate) {
          skipped++;
          continue;
        }
        count++;
      }
      return ok({ ok: true, count, skipped });
    }
  );

  server.registerTool(
    "extract_material_frames",
    {
      title: "Extract Material Frames",
      description:
        "Extract frames from a video/GIF material into individual image materials. For GIF or video with fps: extracts all frames at the given fps. For video with timestamps: extracts at specific time points (max 64). Creates an async job—returns jobId.",
      inputSchema: z.object({
        materialId: z.string().describe("Source material UUID (must be video or GIF)"),
        fps: z.number().int().min(1).max(60).describe("Extraction fps (default 8, ignored if timestamps given)").optional(),
        timestamps: z.array(z.number()).max(64).describe("Specific time points in seconds (video only, not GIF)").optional(),
        autoMatting: z.boolean().describe("Auto-run background removal on extracted frames").optional(),
        folderId: z.string().describe("Target folder for extracted materials (defaults to source material's folder)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId, fps: rawFps, timestamps: rawTs, autoMatting, folderId }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      if (!m.raw_path || !existsSync(m.raw_path)) return err("素材缺少文件");
      const isGif = /\.(gif)$/i.test(m.raw_path);
      const isVideo = /\.(mp4|mov|webm|avi)$/i.test(m.raw_path);
      if (!isGif && !isVideo) return err("仅视频/GIF 素材可抽帧");

      if (rawTs) {
        if (isGif) return err("GIF 不支持定点抽帧，请用 fps 整段拆帧");
        if (rawTs.length > EXTRACT_TIMESTAMPS_MAX) return err(`最多 ${EXTRACT_TIMESTAMPS_MAX} 个时间点`);
      }

      const stagingId = uid();
      const dir = join(STORAGE_ROOT, "staging", stagingId);
      mkdirSync(dir, { recursive: true });
      const ext = m.raw_path.includes(".") ? m.raw_path.split(".").pop()!.toLowerCase() : "mp4";
      const stagingFile = join(dir, `input.${ext}`);
      copyFileSync(m.raw_path, stagingFile);
      const fps = Math.min(Math.max(rawFps ?? 8, 1), 60);

      let mode: "fps" | "timestamps" = "fps";
      let timestamps: number[] | undefined;
      if (rawTs) {
        timestamps = normalizeExtractTimestamps(rawTs.map(Number));
        if (timestamps.length === 0) return err("未提供有效抽帧时间点");
        mode = "timestamps";
      }

      const jobId = createJob("", "extract_frames", {
        extract: {
          stagingFile,
          mediaType: isGif ? "gif" : "mp4",
          fps,
          mode,
          timestamps,
          autoMatting: autoMatting ?? false,
          target: { kind: "materials" },
          originName: (m.name || "素材").replace(/\s*#\d+$/, "").trim() || "素材",
          folderId: folderId !== undefined ? (folderId as string | null) : m.folder_id,
        },
      });
      return ok({ jobId });
    }
  );

  server.registerTool(
    "import_material_to_project",
    {
      title: "Import Material to Project",
      description:
        "Import a material as unassigned project frame(s) in the frame pool, ready to be placed on the timeline. Copies raw and processed slots separately. Video materials must be extracted first. count 1-16, default 1.",
      inputSchema: z.object({
        materialId: z.string().describe("Source material UUID"),
        projectId: z.string().describe("Target project UUID"),
        count: z.number().int().min(1).max(16).describe("Number of copies to import (default 1)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId, projectId, count: rawCount }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!project) return err("项目不存在");
      const count = Math.min(Math.max(rawCount ?? 1, 1), 16);
      try {
        const frameIds: string[] = [];
        invalidateProjectUndo(projectId);
        for (let i = 0; i < count; i++) frameIds.push(importMaterialToProject(m, projectId));
        broadcast("frames_changed", { projectId });
        return ok({ ok: true, count, frameIds });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  server.registerTool(
    "batch_import_materials",
    {
      title: "Batch Import Materials",
      description:
        "Batch import multiple materials to a project's unassigned frame pool. Materials are sorted by frame number in their names (natural sort). Each material becomes 1 frame. Returns count of imported frames.",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("Material UUIDs to import"),
        projectId: z.string().describe("Target project UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ ids, projectId }) => {
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!project) return err("项目不存在");
      let count = 0;
      try {
        const materials = sortMaterialsByFrameNumber(
          ids.map((id) => getMaterial(id)).filter((m): m is MaterialRow => m !== null)
        );
        invalidateProjectUndo(projectId);
        for (const m of materials) {
          importMaterialToProject(m, projectId);
          count++;
        }
      } catch (e) {
        return err((e as Error).message);
      }
      broadcast("frames_changed", { projectId });
      return ok({ ok: true, count });
    }
  );

  server.registerTool(
    "batch_delete_materials",
    {
      title: "Batch Delete Materials",
      description:
        "Delete multiple materials and their disk files. Returns count of deleted materials. Broadcasts materials_changed.",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("Material UUIDs to delete"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ ids }) => {
      const stmt = db.query("DELETE FROM materials WHERE id = ?");
      let deleted = 0;
      for (const id of ids) {
        const m = getMaterial(id);
        if (!m) continue;
        stmt.run(id);
        deleted++;
        rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
      }
      broadcast("materials_changed", {});
      return ok({ ok: true, deleted });
    }
  );

  server.registerTool(
    "unmatting_material",
    {
      title: "Unmatting Material",
      description:
        "Remove the matting (background removal) result from a material, reverting it to raw status. Deletes the processed file.",
      inputSchema: z.object({
        materialId: z.string().describe("Material UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ materialId }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      if (m.processed_path && existsSync(m.processed_path)) rmSync(m.processed_path);
      db.query("UPDATE materials SET status = 'raw', processed_path = NULL WHERE id = ?").run(m.id);
      broadcast("material_updated", { id: m.id });
      return ok({ material: serializeMaterial(getMaterial(m.id)!) });
    }
  );
}

// ===== 网格切帧诊断（AI 编排自查：切完帧知道哪帧坏了）=====

/** Python 版 diagnose（语义与 shared/frameDiag.ts 一致）：PIL 解码 + 逐格内容检测 + 漂移警告 */
const DIAG_PY = `
import json, sys
from PIL import Image

path, rows, cols = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
img = Image.open(path).convert("RGBA")
W, H = img.size
px = img.load()

# 背景采样（六点平均，对齐 frameDiag sampleBackground）
samples = [(0,0),(W-1,0),(0,H-1),(W-1,H-1),(W//2,0),(W//2,H-1)]
bg = [sum(px[x,y][c] for x,y in samples)//len(samples) for c in range(3)]
tol2 = 30*30*3

def is_content(x, y):
    r,g,b,a = px[x,y]
    if a < 24: return False
    if a < 245: return True
    dr,dg,db = r-bg[0], g-bg[1], b-bg[2]
    return dr*dr+dg*dg+db*db > tol2

cell_w, cell_h = W//cols, H//rows
frames = []
for row in range(rows):
    for col in range(cols):
        x0, y0 = col*cell_w, row*cell_h
        x1 = W if col == cols-1 else (col+1)*cell_w
        y1 = H if row == rows-1 else (row+1)*cell_h
        minx=miny=10**9; maxx=maxy=-1; count=0
        for y in range(y0,y1):
            for x in range(x0,x1):
                if is_content(x,y):
                    count+=1
                    if x<minx:minx=x
                    if x>maxx:maxx=x
                    if y<miny:miny=y
                    if y>maxy:maxy=y
        cw, ch = x1-x0, y1-y0
        if count < max(4,(cw*ch)//5000) or maxx<minx:
            frames.append({"index":row*cols+col,"cell":{"x":x0,"y":y0,"w":cw,"h":ch},"content":None,"occupancy":0,"centerOffsetX":0,"centerOffsetY":0,"sameCellScore":0,"warnings":["empty-or-background-only"]})
            continue
        content={"x":minx,"y":miny,"w":maxx-minx+1,"h":maxy-miny+1}
        frames.append({"cell":{"x":x0,"y":y0,"w":cw,"h":ch},"content":content,"index":row*cols+col,"_":0})

valid=[f for f in frames if f["content"]]
avg_w=sum(f["content"]["w"] for f in valid)/max(1,len(valid))
avg_h=sum(f["content"]["h"] for f in valid)/max(1,len(valid))
centers=[((f["content"]["x"]+f["content"]["w"]/2-f["cell"]["x"])/f["cell"]["w"],(f["content"]["y"]+f["content"]["h"]/2-f["cell"]["y"])/f["cell"]["h"]) for f in valid]
avg_cx=sum(c[0] for c in centers)/max(1,len(centers)) if centers else 0.5
avg_cy=sum(c[1] for c in centers)/max(1,len(centers)) if centers else 0.5

out_frames=[]
for f in frames:
    cell, content = f["cell"], f["content"]
    warns=[]
    if content:
        rel_w=abs(content["w"]-avg_w)/avg_w if avg_w else 1
        rel_h=abs(content["h"]-avg_h)/avg_h if avg_h else 1
        ox=(content["x"]+content["w"]/2-(cell["x"]+cell["w"]/2))/cell["w"]
        oy=(content["y"]+content["h"]/2-(cell["y"]+cell["h"]/2))/cell["h"]
        ncx=(content["x"]+content["w"]/2-cell["x"])/cell["w"]
        ncy=(content["y"]+content["h"]/2-cell["y"])/cell["h"]
        gdist=((ncx-avg_cx)**2+(ncy-avg_cy)**2)**0.5
        score=max(0,1-(rel_w+rel_h+abs(ox)+abs(oy)+gdist)/2.5)
        occ=(content["w"]*content["h"])/(cell["w"]*cell["h"])
        if rel_w>0.22: warns.append("width-drift")
        if rel_h>0.22: warns.append("height-drift")
        if abs(ox)>0.14: warns.append("horizontal-offset")
        if abs(oy)>0.14: warns.append("vertical-offset")
        if occ<0.04: warns.append("tiny-content")
        out_frames.append({"index":f["index"],"cell":cell,"content":content,"occupancy":round(occ,4),"centerOffsetX":round(ox,4),"centerOffsetY":round(oy,4),"sameCellScore":round(score,4),"warnings":warns})
    else:
        out_frames.append(f)

result={"sheetWidth":W,"sheetHeight":H,"rows":rows,"cols":cols,"frames":out_frames,"warnings":["frame-occupancy-varies"] if any(f["warnings"] for f in out_frames) else []}
print(json.dumps(result))
`;

/** 服务端找带 PIL 的 python：AI 引擎 venv → 内置 sprite venv → 配置的 sprite venv */
function diagPython(): string | null {
  const candidates = [
    AI_ENGINE_PYTHON,
    BUNDLED_SPRITE_PYTHON,
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function registerDiagTools(server: McpServer) {
  server.registerTool(
    "diagnose_material_grid",
    {
      title: "Diagnose Material Grid Frames",
      description:
        "Check whether a sprite-sheet material splits cleanly into a rows×cols grid BEFORE cutting: per-frame content bounding box, occupancy, center offsets, width/height drift and warnings (empty-or-background-only / tiny-content / width-drift / height-drift / horizontal-offset / vertical-offset). Use after generating sprite sheets or before grid-splitting to catch bad frames. Runs a local Python (PIL) — needs sprite/AI engine configured.",
      inputSchema: z.object({
        materialId: z.string().describe("Material UUID (image)"),
        rows: z.number().int().min(1).max(16),
        cols: z.number().int().min(1).max(16),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ materialId, rows, cols }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      const input = m.processed_path && existsSync(m.processed_path) ? m.processed_path : m.raw_path;
      if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) return err("只支持图片素材");
      const py = diagPython();
      if (!py) return err("诊断需要本地 Python（PIL）：安装 AI 引擎或配置 sprite 抠图");
      const proc = Bun.spawnSync([py, "-c", DIAG_PY, input, String(rows), String(cols)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        return err("诊断失败: " + new TextDecoder().decode(proc.stderr).slice(0, 300));
      }
      try {
        const diag = JSON.parse(new TextDecoder().decode(proc.stdout)) as unknown;
        return ok({ diagnostic: diag });
      } catch {
        return err("诊断输出解析失败");
      }
    }
  );
}
