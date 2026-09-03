"""本地 ComfyUI + Qwen-Image-Edit 2509 图片编辑（免费路线，替代 Maker edit_image）。

用法：
    python comfy_qwen_edit.py --image in.png --prompt "把背景改成纯白" --out wdcs2_edit/bg_white
    python comfy_qwen_edit.py --image in.png --ref2 ref.png --prompt "参考图1的服饰替换主图人物服饰" --out x/y
    python comfy_qwen_edit.py --image in.png --prompt "..." --full   # 20 步 cfg4.0 高质量

前置：
    1. ComfyUI 已在 http://127.0.0.1:8188 运行
    2. 输入图已放进 F:/ai/comfui/input/（--image 只写文件名）

硬规则：必须用 2509（qwen_image_edit_2509_fp8_e4m3fn + 2509-Lightning-4steps LoRA），
不要换 2511；2511 走 FluxKontextMultiReferenceLatentMethod 另一套参数，本项目未验收。
"""

import argparse
import json
import time
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"

NEG = "text, watermark, blurry, low quality, deformed, extra limbs"


def build_workflow(image, prompt, neg, out_prefix, seed, steps, cfg, ref2, ref3):
    """API 格式工作流，等价于官方 Qwen-Image-Edit_文生图_2509.json 子图展平。

    Lightning 4 步：steps=4 / cfg=1.0 / LoRA on（默认）
    全量高质量：steps=20 / cfg=4.0 / LoRA off（--full）
    """
    use_lora = steps <= 8 and cfg <= 1.5
    wf = {
        "37": {"class_type": "UNETLoader",
               "inputs": {"unet_name": "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
                          "weight_dtype": "default"}},
        "38": {"class_type": "CLIPLoader",
               "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
                          "type": "qwen_image", "device": "default"}},
        "39": {"class_type": "VAELoader",
               "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "78": {"class_type": "LoadImage", "inputs": {"image": image}},
        # 官方图必经：把输入图缩到 Qwen-Edit 支持的分辨率档位，跳过会构图错位
        "117": {"class_type": "FluxKontextImageScale", "inputs": {"image": ["78", 0]}},
        "66": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["37", 0], "shift": 3.0}},
        "75": {"class_type": "CFGNorm",
               "inputs": {"model": ["66", 0], "strength": 1.0, "pre_cfg": False}},
        "111": {"class_type": "TextEncodeQwenImageEditPlus",
                "inputs": {"clip": ["38", 0], "vae": ["39", 0],
                           "image1": ["117", 0], "prompt": prompt}},
        "110": {"class_type": "TextEncodeQwenImageEditPlus",
                "inputs": {"clip": ["38", 0], "vae": ["39", 0],
                           "image1": ["117", 0], "prompt": neg}},
        "88": {"class_type": "VAEEncode", "inputs": {"pixels": ["117", 0], "vae": ["39", 0]}},
        "3": {"class_type": "KSampler",
              "inputs": {"model": ["75", 0], "positive": ["111", 0], "negative": ["110", 0],
                         "latent_image": ["88", 0], "seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["39", 0]}},
        "469": {"class_type": "SaveImage",
                "inputs": {"images": ["8", 0], "filename_prefix": out_prefix}},
    }
    if use_lora:
        wf["89"] = {"class_type": "LoraLoaderModelOnly",
                    "inputs": {"model": ["37", 0],
                               "lora_name": "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
                               "strength_model": 1.0}}
        wf["66"]["inputs"]["model"] = ["89", 0]
    # 参考图走 image2/image3，正负两路都要喂（官方图如此接线）
    for slot, name in (("image2", ref2), ("image3", ref3)):
        if not name:
            continue
        nid = "500" if slot == "image2" else "501"
        wf[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        wf["111"]["inputs"][slot] = [nid, 0]
        wf["110"]["inputs"][slot] = [nid, 0]
    return wf


def submit(workflow):
    data = json.dumps({"prompt": workflow, "client_id": str(uuid.uuid4())}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    res = json.loads(urllib.request.urlopen(req).read())
    if res.get("node_errors"):
        raise SystemExit("ComfyUI 拒绝任务: %s" % res["node_errors"])
    return res["prompt_id"]


def wait(prompt_id, timeout=900):
    start = time.time()
    while time.time() - start < timeout:
        try:
            hist = json.loads(urllib.request.urlopen(COMFY + "/history/" + prompt_id).read())
        except OSError:
            hist = {}
        if prompt_id in hist:
            entry = hist[prompt_id]
            files = [item["filename"]
                     for out in entry.get("outputs", {}).values()
                     for value in out.values() if isinstance(value, list)
                     for item in value if isinstance(item, dict) and "filename" in item]
            return entry.get("status", {}).get("status_str"), files, time.time() - start
        time.sleep(3)
    raise SystemExit("等待超时: " + prompt_id)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="F:/ai/comfui/input/ 下的主图文件名")
    ap.add_argument("--prompt", required=True, help="编辑指令，中文即可")
    ap.add_argument("--out", required=True, help="SaveImage filename_prefix，如 wdcs2_edit/01_bg")
    ap.add_argument("--ref2", default="", help="参考图1文件名（可选）")
    ap.add_argument("--ref3", default="", help="参考图2文件名（可选）")
    ap.add_argument("--neg", default=NEG)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--full", action="store_true", help="20 步 cfg4.0 不用 Lightning LoRA")
    args = ap.parse_args()

    steps, cfg = (20, 4.0) if args.full else (4, 1.0)
    wf = build_workflow(args.image, args.prompt, args.neg, args.out,
                        args.seed, steps, cfg, args.ref2, args.ref3)
    pid = submit(wf)
    print("submitted", pid, "steps=%d cfg=%.1f" % (steps, cfg), flush=True)
    status, files, elapsed = wait(pid)
    print("%s  %.0fs  %s" % (status, elapsed, files))


if __name__ == "__main__":
    main()
