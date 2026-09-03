"""把 See-through 的语义部件层映射成 FrameBaker 人形骨段素材。

为什么不能一对一：
    See-through V3 标签是**服装语义**（topwear=整件外袍、handwear=整只袖子含手、
    footwear=双脚一层），FrameBaker 要的是**骨段语义**（chest/pelvis/上臂/前臂/小腿）。
    这里把服装语义重组成骨段语义，并绕开 See-through 深度序的两个坑（见下）。

关键决策（都是踩坑后定的，改前先读 SKILL「FrameBaker 骨骼动画」章）：
    1. 头部**不信 See-through depth**，按固定解剖学序 HEAD_ORDER 叠放。
       眼白/眼珠 depth 常只差 ~0.002，深度噪声一翻转就把眼白盖到眼珠上 → 「左眼缺珠」。
    2. **脑后发单独拆成 hair-back 部件**，绑头骨但画在躯干背后。否则它垂到肩颈的部分
       随整块 head 画在最上层，糊在脖子/衣领上 → 「头发显示在脖子上」。
    3. **袖子整片挂肩不切**（宽袍大袖）。横切会在胸口留直线黑缝，前臂骨摆幅还会把下半片甩出身体。
       窄袖角色可加 --split-sleeve 在肘部切两段。
    4. **pelvis = 腰线以下全部布料层合成一块**，不是只取外袍下摆。女角色内层裙是独立
       bottomwear 层，漏掉它下半身会整块缺失。
    5. 侧视图加 --single-foot：两脚在轮廓里前后重叠成单块，硬按 x 中线劈会把同一只鞋
       切两半、被左右踝骨反向旋转甩「转圈」。整块并进 pelvis 随裙摆同步摆，脚永不脱离；
       迈步感交给引擎平移（方案 A）。正面双脚左右并列，才按 x 中线劈成左右小腿。

用法：
    python map_seethrough_to_framebaker.py <body前缀> <out目录> \
        [--out-root F:/ai/comfui/output] [--head-prefix <前缀>] [--split-sleeve] [--single-foot]
    # body 取躯干干净的那次；--head-prefix 可指定 face/眼睛层非空的另一次种子结果
    # 前缀 = layers.json 文件名去掉末尾 "layers.json"（含下划线），如 06_hd_20260825_..._4cbc6f25_

输出：out目录/<role>.png + layout.json（canvas 尺寸 + 每部件在原画布的 bbox/中心），
      供 build_binding_and_bake.ts 反解 FrameBaker attachment rest。
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageFilter

# 头部固定解剖学叠放序（从后往前），绕开 See-through depth 噪声。back hair 不在此列——单独拆。
HEAD_ORDER = ["face", "ears-l", "ears-r", "earwear", "nose",
              "eyebrow-l", "eyebrow-r",
              "eyewhite-l", "eyewhite-r", "irides-l", "irides-r",
              "eyelash-l", "eyelash-r", "mouth",
              "headwear", "eyewear", "front hair"]

# 袖子在肘部的纵向切分比例（含手的一段更长）
ELBOW_RATIO = 0.42
# 外袍在腰线的纵向切分比例
WAIST_RATIO = 0.38


def load_manifest(out_root, prefix):
    with open(os.path.join(out_root, prefix + "layers.json"), encoding="utf-8") as fp:
        return json.load(fp)


def layer_full(out_root, prefix, layer, size):
    """把可能是小裁剪的层贴回整画布，返回去噪后的 RGBA ndarray。"""
    im = np.array(Image.open(os.path.join(out_root, prefix + layer["name"] + ".png")).convert("RGBA"))
    if im.shape[:2] != (size, size):
        full = np.zeros((size, size, 4), np.uint8)
        h, w = im.shape[:2]
        full[layer["top"]:layer["top"] + h, layer["left"]:layer["left"] + w] = im
        im = full
    return denoise(im)


def has_content(rgba):
    return int((rgba[..., 3] > 128).sum()) >= 20


def denoise(rgba):
    """See-through 空/弱层带 alpha 37-39 的全画布噪声；直接按 >0 取 bbox 会拿到整张画布。

    做法：alpha>100 取实体核，MaxFilter 膨胀保住边缘羽化，核外 alpha 归零。
    """
    alpha = Image.fromarray(rgba[..., 3])
    solid = alpha.point(lambda v: 255 if v > 100 else 0)
    keep = np.array(solid.filter(ImageFilter.MaxFilter(5))) > 0
    out = rgba.copy()
    out[..., 3] = np.where(keep, rgba[..., 3], 0)
    return out


def compose_lower_body(out_root, prefix, body, body_layers, size, cut, include_footwear):
    """腰线以下的布料层按清单前后序合成一块 pelvis。include_footwear 决定是否并入鞋（侧视单脚用）。"""
    tags = ("footwear", "legwear", "bottomwear", "topwear") if include_footwear \
        else ("legwear", "bottomwear", "topwear")
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    painted = False
    for layer in body["layers"]:  # 清单即后→前绘制序
        name = layer["name"]
        if name not in tags:
            continue
        rgba = denoise(layer_full(out_root, prefix, body_layers[name], size))
        if not has_content(rgba):
            continue
        if name == "topwear" and cut is not None:
            rgba = rgba.copy()
            rgba[:cut] = 0  # 只取腰线以下
        canvas.alpha_composite(Image.fromarray(rgba))
        painted = True
    return np.array(canvas) if painted else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("body_prefix")
    ap.add_argument("out_dir")
    ap.add_argument("--out-root", default="F:/ai/comfui/output",
                    help="See-through 产物根目录（含 <prefix>layers.json 与各层 png）")
    ap.add_argument("--head-prefix", default=None, help="face/眼睛层非空的那一次；缺省与 body 相同")
    ap.add_argument("--split-sleeve", action="store_true",
                    help="把袖子在肘部切两段（窄袖角色用）；宽袍大袖默认整片挂肩不切")
    ap.add_argument("--single-foot", action="store_true",
                    help="侧视图用：两脚重叠成单块，整块并进裙摆不劈；正面（默认）按 x 中线劈左右小腿")
    args = ap.parse_args()
    head_prefix = args.head_prefix or args.body_prefix
    root = args.out_root

    body = load_manifest(root, args.body_prefix)
    head = load_manifest(root, head_prefix)
    size = body["width"]
    os.makedirs(args.out_dir, exist_ok=True)

    body_layers = {l["name"]: l for l in body["layers"]}
    head_layers = {l["name"]: l for l in head["layers"]}

    # 1) 头部：固定解剖序合成正面头（不含脑后发）
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    used = []
    for name in HEAD_ORDER:
        if name not in head_layers:
            continue
        rgba = layer_full(root, head_prefix, head_layers[name], size)
        if not has_content(rgba):
            continue
        canvas.alpha_composite(Image.fromarray(rgba))
        used.append(name)
    parts = {"head": np.array(canvas)}
    print("head 合成自 %d 层: %s" % (len(used), " ".join(used)))

    # 脑后发单独成部件，绑头骨、画在躯干背后
    if "back hair" in head_layers:
        rgba = layer_full(root, head_prefix, head_layers["back hair"], size)
        if has_content(rgba):
            parts["hair-back"] = rgba

    # 2) 袖子：宽袍大袖整片挂肩，不在肘部切
    for side, tag in (("left", "handwear-l"), ("right", "handwear-r")):
        if tag not in body_layers:
            continue
        rgba = layer_full(root, args.body_prefix, body_layers[tag], size)
        if not has_content(rgba):
            continue
        if args.split_sleeve:
            ys = np.where(rgba[..., 3] > 128)[0]
            elbow = int(ys.min() + (ys.max() - ys.min()) * ELBOW_RATIO)
            upper, fore = rgba.copy(), rgba.copy()
            upper[elbow:] = 0
            fore[:elbow] = 0
            parts["upper-arm-" + side] = upper
            parts["forearm-" + side] = fore
        else:
            parts["upper-arm-" + side] = rgba

    # 3) 外袍腰线以上为 torso
    cut = None
    if "topwear" in body_layers:
        rgba = layer_full(root, args.body_prefix, body_layers["topwear"], size)
        ys = np.where(rgba[..., 3] > 128)[0]
        cut = int(ys.min() + (ys.max() - ys.min()) * WAIST_RATIO)
        torso = rgba.copy()
        torso[cut:] = 0
        parts["torso"] = torso

    # 4) 下半身 pelvis / 脚
    if args.single_foot:
        skirt = compose_lower_body(root, args.body_prefix, body, body_layers, size, cut, include_footwear=True)
    else:
        skirt = compose_lower_body(root, args.body_prefix, body, body_layers, size, cut, include_footwear=False)
        if "footwear" in body_layers:
            foot = layer_full(root, args.body_prefix, body_layers["footwear"], size)
            xs = np.where(foot[..., 3] > 128)[1]
            if xs.size:
                mid = int((xs.min() + xs.max()) / 2)
                left, right = foot.copy(), foot.copy()
                left[:, :mid] = 0
                right[:, mid:] = 0
                parts["shin-left"] = left
                parts["shin-right"] = right
    if skirt is not None:
        parts["pelvis"] = skirt

    layout = {}
    for role, rgba in parts.items():
        if not has_content(rgba):
            print("  跳过空部件", role)
            continue
        img = Image.fromarray(denoise(rgba))
        box = img.getbbox()
        img = img.crop(box)
        img.save(os.path.join(args.out_dir, role + ".png"))
        layout[role] = {"left": box[0], "top": box[1], "width": img.width, "height": img.height,
                        "cx": (box[0] + box[2]) / 2, "cy": (box[1] + box[3]) / 2}
        print("  %-16s %dx%d @(%d,%d)  %d px" % (role, img.width, img.height, box[0], box[1],
                                                 int((np.array(img)[..., 3] > 128).sum())))

    with open(os.path.join(args.out_dir, "layout.json"), "w", encoding="utf-8") as fp:
        json.dump({"canvas": size, "parts": layout}, fp, ensure_ascii=False, indent=1)
    print("layout.json 写入 %d 个部件" % len(layout))


if __name__ == "__main__":
    main()
