"""本地 ComfyUI + See-through 把单张立绘拆成**语义部件图层**（骨骼动画/PSD 用，免费路线）。

与 `comfy_qwen_layered.py` 的根本区别：
    Qwen-Image-Layered 按**遮挡关系**拆（前景/主体/背景），拿不到部件；
    See-through 按**语义部件**拆（hair/face/eyel/eyer/clothing/handwear...），
    每层都做过补全，深度序决定叠放顺序 —— 这才是骨骼动画要的图层。

用法：
    python comfy_seethrough.py --image wdcs2_03_daozhang.png --out st_daozhang
    # 显存吃紧再降分辨率（默认 1024；官方模板 1280）
    python comfy_seethrough.py --image x.png --out y --resolution 768 --depth-resolution 512

前置：
    1. ComfyUI 已在 http://127.0.0.1:8188 运行，且 custom_nodes/ComfyUI-See-through 已装
    2. models/SeeThrough/seethroughv0.0.2_layerdiff3d_nf4/（3.51GB，LayerDiff 3D）
       models/SeeThrough/seethroughv0.0.1_marigold_nf4/（1.80GB，Marigold 深度）
    3. 输入图放 F:/ai/comfui/input/（--image 只写文件名）

硬规则：
    1. **必须 quant_mode=nf4**，且 **resolution 上限 1024**。本机 4060 Laptop 只有 8188MiB，
       nf4 下实测：1024 成功（436s）；1152 在节点 24 抛 torch.OutOfMemoryError
       （已分配 6.32GiB / 再要 329MiB / 上限 8.00GiB）；1280（官方默认）直接把
       ComfyUI 进程打死（exit 7，无 history 记录）。不要照抄官方 1280。
    2. **本地目录名要直接填给 model 参数**（`seethroughv0.0.2_layerdiff3d_nf4`），
       不要填 HF repo id。填 repo id 时 nf4 会走 `_NF4_REPO_MAP` 再联网校验。
    3. `SeeThrough_SavePSD` **不在服务端产出 .psd**：它写每层 RGBA PNG + 每层深度 PNG
       + `<prefix>_<ts>_<uid>_layers.json` 清单（按 depth_median 倒序 = 从后往前叠）。
       PSD 是前端 ag-psd 在浏览器里按这份清单拼的。验收看 PNG + json，不要找 .psd。
    4. `use_lama=True` 会 `torch.hub` 拉 AnimeMangaInpainting/lama_large_512px.ckpt
       用于把头发拆成 hairf/hairb，首次运行会多一次下载。
"""

import argparse
import json
import os
import time
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"
OUTPUT_DIR = "F:/ai/comfui/output"

LAYERDIFF_DIR = "seethroughv0.0.2_layerdiff3d_nf4"
DEPTH_DIR = "seethroughv0.0.1_marigold_nf4"


def build_workflow(image, out_prefix, seed, resolution, steps, depth_resolution,
                   tblr_split, use_lama, quant_mode):
    """API 格式工作流，等价于 workflows/seethrough-basic.json 的接线。

    LoadImage -> GenerateLayers -> GenerateDepth -> PostProcess -> SavePSD
    两个 loader 分别喂 GenerateLayers / GenerateDepth。
    """
    return {
        "27": {"class_type": "LoadImage", "inputs": {"image": image}},
        "28": {"class_type": "SeeThrough_LoadLayerDiffModel",
               "inputs": {"model": LAYERDIFF_DIR, "quant_mode": quant_mode,
                          "cache_tag_embeds": True, "group_offload": False,
                          "auto_download": True}},
        "29": {"class_type": "SeeThrough_LoadDepthModel",
               "inputs": {"model": DEPTH_DIR, "quant_mode": quant_mode,
                          "cache_tag_embeds": True, "group_offload": False,
                          "auto_download": True}},
        "24": {"class_type": "SeeThrough_GenerateLayers",
               "inputs": {"image": ["27", 0], "layerdiff_model": ["28", 0],
                          "seed": seed, "resolution": resolution,
                          "num_inference_steps": steps}},
        "23": {"class_type": "SeeThrough_GenerateDepth",
               "inputs": {"layers": ["24", 0], "depth_model": ["29", 0],
                          "seed": seed, "resolution_depth": depth_resolution}},
        "20": {"class_type": "SeeThrough_PostProcess",
               "inputs": {"layers_depth": ["23", 0],
                          "tblr_split": tblr_split, "use_lama": use_lama}},
        "21": {"class_type": "SeeThrough_SavePSD",
               "inputs": {"parts": ["20", 0], "filename_prefix": out_prefix}},
    }


def submit(workflow):
    data = json.dumps({"prompt": workflow, "client_id": str(uuid.uuid4())}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    res = json.loads(urllib.request.urlopen(req).read())
    if res.get("node_errors"):
        raise SystemExit("ComfyUI 拒绝任务: %s" % res["node_errors"])
    return res["prompt_id"]


def wait(prompt_id, timeout=7200):
    start = time.time()
    while time.time() - start < timeout:
        try:
            hist = json.loads(urllib.request.urlopen(COMFY + "/history/" + prompt_id).read())
        except OSError:
            hist = {}
        if prompt_id in hist:
            entry = hist[prompt_id]
            return entry.get("status", {}).get("status_str"), entry, time.time() - start
        time.sleep(5)
    raise SystemExit("等待超时: " + prompt_id)


def report(entry):
    """SavePSD 不返回文件列表，靠 output 目录里的 layers.json 清单验收。"""
    log = os.path.join(OUTPUT_DIR, "seethrough_psd_info.log")
    if not os.path.exists(log):
        print("未找到 seethrough_psd_info.log，SavePSD 可能没执行")
        return
    with open(log, encoding="utf-8") as fp:
        info_name = fp.read().strip()
    info_path = os.path.join(OUTPUT_DIR, info_name)
    with open(info_path, encoding="utf-8") as fp:
        info = json.load(fp)
    print("清单 %s  画布 %dx%d  图层 %d 张（从后往前）"
          % (info_name, info["width"], info["height"], len(info["layers"])))
    for i, lay in enumerate(info["layers"], 1):
        png = os.path.join(OUTPUT_DIR, lay["filename"])
        size = os.path.getsize(png) if os.path.exists(png) else -1
        print("  %2d %-10s depth=%.4f bbox=(%d,%d,%d,%d) %8d B %s"
              % (i, lay["name"], lay["depth_median"], lay["left"], lay["top"],
                 lay["right"], lay["bottom"], size, lay["filename"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="F:/ai/comfui/input/ 下的文件名")
    ap.add_argument("--out", required=True, help="SavePSD filename_prefix")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--resolution", type=int, default=1024, help="本机上限 1024；1152 会 OOM，1280 会打死进程")
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--depth-resolution", type=int, default=-1,
                    help="-1 = 跟随 layers；显存紧时降到 512/640")
    ap.add_argument("--no-tblr-split", action="store_true", help="不拆左右眼/耳/手部与前后发")
    ap.add_argument("--no-lama", action="store_true", help="头发补全退回 OpenCV，不拉 LaMa 权重")
    ap.add_argument("--bf16", action="store_true", help="用 bf16 原版（本机 8G 显存会 OOM）")
    args = ap.parse_args()

    wf = build_workflow(args.image, args.out, args.seed, args.resolution, args.steps,
                        args.depth_resolution, not args.no_tblr_split,
                        not args.no_lama, "none" if args.bf16 else "nf4")
    pid = submit(wf)
    print("submitted %s res=%d steps=%d depth_res=%d quant=%s"
          % (pid, args.resolution, args.steps, args.depth_resolution,
             "none" if args.bf16 else "nf4"), flush=True)
    status, entry, elapsed = wait(pid)
    print("%s  %.0fs" % (status, elapsed), flush=True)
    if status == "success":
        report(entry)
    else:
        print(json.dumps(entry.get("status", {}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
