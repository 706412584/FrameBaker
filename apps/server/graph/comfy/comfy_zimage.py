"""本地 ComfyUI + Z-Image Turbo (GGUF) 图片生成（免费路线，替代 Maker generate_image）。

用法：
    python comfy_zimage.py --prompt "青灰道袍白发道长,全身,纯白背景" --out wdcs2_gen/daozhang --size 1024
    python comfy_zimage.py --prompt "..." --image in.png --denoise 0.5 --out x/y      # 图生图
    python comfy_zimage.py --prompt "..." --image in.png --mask m.png --out x/y       # 局部重绘

前置：
    1. ComfyUI 已在 http://127.0.0.1:8188 运行
    2. 图生图/重绘的输入图与遮罩已放进 F:/ai/comfui/input/（只写文件名）

硬规则：Z-Image Turbo 必须 cfg=1.0 / steps=8 / res_multistep+simple。
调高 cfg 会糊；这是 turbo 蒸馏模型的固定档位，不是可调参数。
"""

import argparse
import json
import time
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"

NEG = "text, watermark, blurry, low quality, deformed"


def build_workflow(prompt, neg, out_prefix, seed, steps, cfg, width, height,
                   denoise, image, mask):
    """API 格式工作流，等价于 api_z_image_turbo_gguf{,_img2img,_inpaint}.json 三合一。"""
    wf = {
        "28": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "z-image-turbo-Q4_K_M.gguf"}},
        "30": {"class_type": "CLIPLoaderGGUF",
               "inputs": {"clip_name": "qwen3-4b-Q4_K_M.gguf", "type": "lumina2"}},
        "29": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "11": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["28", 0], "shift": 3.0}},
        "27": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["30", 0]}},
        "104": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["30", 0]}},
        "13": {"class_type": "EmptySD3LatentImage",
               "inputs": {"width": width, "height": height, "batch_size": 1}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": "res_multistep", "scheduler": "simple",
                         "denoise": denoise, "model": ["11", 0],
                         "positive": ["27", 0], "negative": ["104", 0],
                         "latent_image": ["13", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["29", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": out_prefix}},
    }
    if image:
        wf["100"] = {"class_type": "LoadImage", "inputs": {"image": image}}
        if mask:
            wf["101"] = {"class_type": "LoadImageMask",
                         "inputs": {"image": mask, "channel": "red"}}
            wf["102"] = {"class_type": "VAEEncodeForInpaint",
                         "inputs": {"pixels": ["100", 0], "vae": ["29", 0],
                                    "mask": ["101", 0], "grow_mask_by": 6}}
            wf["3"]["inputs"]["latent_image"] = ["102", 0]
        else:
            wf["101"] = {"class_type": "VAEEncode",
                         "inputs": {"pixels": ["100", 0], "vae": ["29", 0]}}
            wf["3"]["inputs"]["latent_image"] = ["101", 0]
        del wf["13"]
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
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True, help="SaveImage filename_prefix，如 wdcs2_gen/icon")
    ap.add_argument("--neg", default=NEG)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=8, help="turbo 固定 8 步")
    ap.add_argument("--cfg", type=float, default=1.0, help="turbo 固定 1.0，调高会糊")
    ap.add_argument("--size", type=int, default=1024, help="正方形边长；非方图用 --width/--height")
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--denoise", type=float, default=1.0, help="图生图建议 0.5，重绘 0.75")
    ap.add_argument("--image", default="", help="图生图/重绘输入图文件名")
    ap.add_argument("--mask", default="", help="重绘遮罩文件名（白=重绘区）")
    args = ap.parse_args()

    w = args.width or args.size
    h = args.height or args.size
    wf = build_workflow(args.prompt, args.neg, args.out, args.seed, args.steps,
                        args.cfg, w, h, args.denoise, args.image, args.mask)
    pid = submit(wf)
    print("submitted", pid, "%dx%d steps=%d denoise=%.2f" % (w, h, args.steps, args.denoise), flush=True)
    status, files, elapsed = wait(pid)
    print("%s  %.0fs  %s" % (status, elapsed, files))


if __name__ == "__main__":
    main()
