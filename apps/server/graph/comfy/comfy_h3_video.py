"""本地 ComfyUI + MiniMax H3 出角色动作视频（免费路线，替代 Maker 积分）。

用法：
    python comfy_h3_video.py --image wdcs2_03_daozhang.png --action idle --out wdcs2/03_idle
    python comfy_h3_video.py --image wdcs2_03_daozhang.png --action attack --attack "太极推手" --out wdcs2/03_attack

前置：
    1. ComfyUI 已在 http://127.0.0.1:8188 运行
    2. 输入图已放进 F:/ai/comfui/input/（1:1 方形白/黑/绿底首帧，见 SKILL.md 步骤 2）

硬规则：first_frame 与 last_frame 必须都喂同一张图，否则 attack 会袖子炸开出画。
"""

import argparse
import json
import time
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"

# 四个坏习惯压制前缀；{BG} 三选一，必须与首帧合成底色一致
PREFIX = (
    "固定机位,镜头绝对静止,焦距锁定,严禁任何推拉/缩放/平移/变焦,画面构图从第一帧到最后一帧完全不变。"
    "角色在画面中的大小、位置、占比自始至终保持和首帧完全一致,不许拉近也不许拉远。"
    "{BG}背景自始至终保持{BG}不变,无阴影无渐变无地面无任何背景元素。"
    "角色身份严格锁定:{IDENTITY}。脸型/发型/服饰/配饰/配色自始至终完全一致。"
    "身体轮廓与四肢比例始终保持正常不变形,衣袖不夸张膨胀不拉长。"
    "全身(头顶到双脚)始终完整显示在画面内不被裁切,任何部位不超出画面边缘。"
    "二次元国漫插画风格,干净线稿平涂上色。"
)

NO_FX = "禁止任何特效粒子光效速度线残影。"

ACTIONS = {
    "idle": NO_FX + "动作:原地站立,仅身体极轻微上下呼吸起伏,衣摆/长须随呼吸极轻微飘动,幅度极小。",
    "walk": NO_FX + "动作:原地踏步行走循环,双腿在原地明显交替抬起落下迈步,膝盖抬高,不做整体位移、身体始终停在画面正中央,"
                    "下摆随步伐明显左右摆动,双臂前后摆动,最后一帧自然循环回第一帧。",
    # attack 由 --attack 填具体出手语义；幅度必须写「克制」，否则 H3 会过冲出画
    "attack": "动作幅度适中克制:{ATTACK},身体重心几乎不动、双脚原地不移动,动作结束缓慢收回恢复起始姿态。"
              "不做大幅转身不做跳跃不甩袖。",
    "talk": NO_FX + "动作:嘴部自然小幅开合,头部轻微点头,长须随之轻晃,身体站立不动。",
    "greet": NO_FX + "动作:双手胸前合拢作揖再放回,躬身微前倾不移位,长须随躬身前垂。",
    "cast": "动作:双手胸前掐诀结印,掌心极淡青色灵光贴掌不扩散不漂浮,身体站立不动。",
}

BG_TEXT = {"white": "纯白色", "black": "纯黑色", "green": "纯绿色#00FF00"}


def build_prompt_text(action, bg, identity, attack_desc):
    body = ACTIONS[action]
    if action == "attack":
        if not attack_desc:
            raise SystemExit("--action attack 必须同时给 --attack «出手描述»")
        body = body.replace("{ATTACK}", attack_desc)
    return PREFIX.replace("{BG}", BG_TEXT[bg]).replace("{IDENTITY}", identity) + body


def build_workflow(image, prompt_text, out_prefix, seed, size, length):
    """API 格式工作流，等价于官方 MiniMax-H3 turbo i2v 模板（4 步 LoRA）。"""
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                         "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly",
              "inputs": {"model": ["1", 0],
                         "lora_name": "minimax_h3_fl2v_turbo_4step_v0.1.safetensors",
                         "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                         "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader",
              "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "10": {"class_type": "LoadImage", "inputs": {"image": image}},
        # first_frame + last_frame 同图 = 锁镜头锁构图，缺 last_frame 会炸
        "5": {"class_type": "MiniMaxH3ImageToVideo",
              "inputs": {"clip": ["3", 0], "vae": ["4", 0], "prompt": prompt_text,
                         "width": size, "height": size, "length": length,
                         "first_frame": ["10", 0], "last_frame": ["10", 0]}},
        "6": {"class_type": "BasicGuider", "inputs": {"model": ["2", 0], "conditioning": ["5", 0]}},
        "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "8": {"class_type": "BasicScheduler",
              "inputs": {"model": ["2", 0], "scheduler": "simple", "steps": 4, "denoise": 1.0}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "11": {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["9", 0], "guider": ["6", 0], "sampler": ["7", 0],
                          "sigmas": ["8", 0], "latent_image": ["5", 1]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "13": {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "fps": 24}},
        "14": {"class_type": "SaveVideo",
               "inputs": {"video": ["13", 0], "filename_prefix": out_prefix,
                          "format": "auto", "codec": "auto"}},
    }


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
        time.sleep(5)
    raise SystemExit("等待超时: " + prompt_id)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="F:/ai/comfui/input/ 下的文件名")
    ap.add_argument("--action", required=True, choices=sorted(ACTIONS))
    ap.add_argument("--out", required=True, help="SaveVideo filename_prefix，如 wdcs2/03_idle")
    ap.add_argument("--attack", default="", help="attack 的出手描述，见 SKILL.md 六角色表")
    ap.add_argument("--identity", default="白发白须太极道长,发髻阴阳鱼发饰,青灰道袍,胸前阴阳玉佩,绿色流苏,黑色布鞋")
    ap.add_argument("--bg", default="white", choices=sorted(BG_TEXT))
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=640, help="8GB 显存实测 640 稳；再大易 OOM")
    ap.add_argument("--length", type=int, default=73, help="73 帧 @24fps = 3.04s")
    args = ap.parse_args()

    text = build_prompt_text(args.action, args.bg, args.identity, args.attack)
    pid = submit(build_workflow(args.image, text, args.out, args.seed, args.size, args.length))
    print("submitted", pid, flush=True)
    status, files, elapsed = wait(pid)
    print("%s  %.0fs  %s" % (status, elapsed, files))


if __name__ == "__main__":
    main()
