"""本地 ComfyUI + Qwen-Image-Layered 分层出图（**原生 RGBA**，免费路线）。

这是四条本地路线里唯一**不需要后期抠底**的：VAE 解码头是 4 通道，
直出带 alpha 的 PNG，并且把画面拆成 layers+1 张分层图（背景 + 各前景层）。

用法：
    # 文生分层（默认 2 层 → 出 3 张 RGBA）
    python comfy_qwen_layered.py --prompt "一枚修仙游戏道具图标:青玉灵石" --out wdcs2_layered/lingshi
    # 图生分层（把已有图拆成透明层）
    python comfy_qwen_layered.py --prompt "拆分前景与背景" --image in.png --out x/y
    # 更多层 / 更大尺寸
    python comfy_qwen_layered.py --prompt "..." --layers 3 --size 1024 --out x/y

前置：
    1. ComfyUI 已在 http://127.0.0.1:8188 运行
    2. models/unet/qwen-image-layered-Q4_K_S.gguf（11.56GiB）
       models/vae/qwen_image_layered_vae.safetensors（**必须这个，不是 qwen_image_vae**）
       models/clip/qwen_2.5_vl_7b_fp8_scaled.safetensors
    3. 图生分层的输入图放进 F:/ai/comfui/input/（--image 只写文件名）

硬规则：
    1. VAE 必须 qwen_image_layered_vae。普通 qwen_image_vae 解码头是 3 通道，
       接上去只会出 RGB，alpha 直接丢掉。
    2. `EmptyQwenImageLayeredLatentImage` 出的是 5-D latent（第 2 维是层轴），
       必须过 `LatentCutToBatch(dim='t')` 把层切进 batch，才能一层一张解码。
       跳过它 VAEDecode 会拿到 5-D 张量。
    3. 这个模型**没有** Lightning 4 步 LoRA，官方原始档位 50 步/cfg4.0，
       模板默认 20 步/cfg2.5。640 是推荐尺寸，1024 才算高清但更慢。
"""

import argparse
import json
import time
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"

NEG = ""


def build_workflow(prompt, neg, out_prefix, seed, steps, cfg, width, height,
                   layers, image):
    """API 格式工作流，等价于官方 image_qwen_image_layered.json 的两个子图。

    UNETLoader 换成 UnetLoaderGGUF 以吃 Q4_K_S 量化权重（bf16 原版 38GB）。
    """
    wf = {
        "127": {"class_type": "UnetLoaderGGUF",
                "inputs": {"unet_name": "qwen-image-layered-Q4_K_S.gguf"}},
        "119": {"class_type": "CLIPLoader",
                "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
                           "type": "qwen_image", "device": "default"}},
        "120": {"class_type": "VAELoader",
                "inputs": {"vae_name": "qwen_image_layered_vae.safetensors"}},
        "122": {"class_type": "ModelSamplingAuraFlow",
                "inputs": {"model": ["127", 0], "shift": 1.0}},
        "125": {"class_type": "CLIPTextEncode",
                "inputs": {"text": prompt, "clip": ["119", 0]}},
        "121": {"class_type": "CLIPTextEncode",
                "inputs": {"text": neg, "clip": ["119", 0]}},
        "128": {"class_type": "EmptyQwenImageLayeredLatentImage",
                "inputs": {"width": width, "height": height,
                           "layers": layers, "batch_size": 1}},
        "126": {"class_type": "KSampler",
                "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                           "sampler_name": "euler", "scheduler": "simple",
                           "denoise": 1.0, "model": ["122", 0],
                           "positive": ["125", 0], "negative": ["121", 0],
                           "latent_image": ["128", 0]}},
        # 层轴 → batch，一层一张
        "123": {"class_type": "LatentCutToBatch",
                "inputs": {"samples": ["126", 0], "dim": "t", "slice_size": 1}},
        "124": {"class_type": "VAEDecode",
                "inputs": {"samples": ["123", 0], "vae": ["120", 0]}},
        "129": {"class_type": "SaveImage",
                "inputs": {"images": ["124", 0], "filename_prefix": out_prefix}},
    }
    if image:
        # 图生分层：输入图缩到长边 = size，latent 尺寸跟随缩放后的真实宽高
        wf["130"] = {"class_type": "LoadImage", "inputs": {"image": image}}
        wf["131"] = {"class_type": "ImageScaleToMaxDimension",
                     "inputs": {"image": ["130", 0], "upscale_method": "lanczos",
                                "largest_size": max(width, height)}}
        wf["135"] = {"class_type": "GetImageSize", "inputs": {"image": ["131", 0]}}
        wf["128"]["inputs"]["width"] = ["135", 0]
        wf["128"]["inputs"]["height"] = ["135", 1]
        wf["132"] = {"class_type": "VAEEncode",
                     "inputs": {"pixels": ["131", 0], "vae": ["120", 0]}}
        wf["133"] = {"class_type": "ReferenceLatent",
                     "inputs": {"conditioning": ["125", 0], "latent": ["132", 0]}}
        wf["134"] = {"class_type": "ReferenceLatent",
                     "inputs": {"conditioning": ["121", 0], "latent": ["132", 0]}}
        wf["126"]["inputs"]["positive"] = ["133", 0]
        wf["126"]["inputs"]["negative"] = ["134", 0]
    return wf


def submit(workflow):
    data = json.dumps({"prompt": workflow, "client_id": str(uuid.uuid4())}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    res = json.loads(urllib.request.urlopen(req).read())
    if res.get("node_errors"):
        raise SystemExit("ComfyUI 拒绝任务: %s" % res["node_errors"])
    return res["prompt_id"]


def wait(prompt_id, timeout=3600):
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
        time.sleep(5)
    raise SystemExit("等待超时: " + prompt_id)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True, help="SaveImage filename_prefix")
    ap.add_argument("--neg", default=NEG)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=20, help="模板默认 20；官方原始 50")
    ap.add_argument("--cfg", type=float, default=2.5, help="模板默认 2.5；官方原始 4.0")
    ap.add_argument("--size", type=int, default=640, help="推荐 640，高清 1024")
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--layers", type=int, default=2, help="出图张数 = layers + 1")
    ap.add_argument("--image", default="", help="图生分层的输入图文件名")
    args = ap.parse_args()

    w = args.width or args.size
    h = args.height or args.size
    wf = build_workflow(args.prompt, args.neg, args.out, args.seed, args.steps,
                        args.cfg, w, h, args.layers, args.image)
    pid = submit(wf)
    print("submitted %s %dx%d layers=%d(%d张) steps=%d cfg=%.1f"
          % (pid, w, h, args.layers, args.layers + 1, args.steps, args.cfg), flush=True)
    status, files, elapsed = wait(pid)
    print("%s  %.0fs  %s" % (status, elapsed, files))


if __name__ == "__main__":
    main()
