"""把 FrameBaker 内置动作的逐帧部件变换合成成精灵表 + GIF（验证几何 / 出图）。

用法：
    # 先在 FrameBaker 仓库里烘出逐帧变换（脚本已随本目录固化一份）
    bun build_binding_and_bake.ts <parts目录> motion-original-preset-walk 8 > poses.json
    python render_poses.py poses.json out.png [parts_dir]

parts_dir 里若有 <role>.png 就用真实分件，否则用带角色名的彩色占位块（缺件不冒充）。
输出 out.png（横向精灵表）+ 同名 .gif（按 clip duration 循环）。
"""
import json
import sys
from PIL import Image, ImageDraw

COLORS = {
    "head": (232, 205, 160), "torso": (96, 132, 176), "pelvis": (88, 96, 120),
    "upper-arm-left": (140, 180, 220), "forearm-left": (170, 200, 235),
    "upper-arm-right": (70, 100, 140), "forearm-right": (95, 125, 165),
    "thigh-left": (120, 110, 150), "shin-left": (145, 135, 175),
    "thigh-right": (80, 72, 105), "shin-right": (100, 92, 128),
}

def render(poses, parts_dir=None):
    xs, ys = [], []
    for f in poses["frames"]:
        for p in f["parts"]:
            r = max(p["w"], p["h"])
            xs += [p["x"] - r, p["x"] + r]
            ys += [-p["y"] - r, -p["y"] + r]   # FrameBaker y 向上，画布 y 向下
    pad = 8
    x0, x1 = int(min(xs)) - pad, int(max(xs)) + pad
    y0, y1 = int(min(ys)) - pad, int(max(ys)) + pad
    cw, ch = x1 - x0, y1 - y0

    cache = {}
    frames = []
    for f in poses["frames"]:
        cell = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        for p in f["parts"]:
            w, h = max(1, round(p["w"])), max(1, round(p["h"]))
            key = (p["role"], w, h)
            if key not in cache:
                src = None
                if parts_dir:
                    try:
                        raw = Image.open("%s/%s.png" % (parts_dir, p["role"])).convert("RGBA")
                        # 自动绑定的 size 是启发式框；按高度贴合并保留原始宽高比，避免部件被压扁
                        scale = h / raw.height
                        src = raw.resize((max(1, round(raw.width * scale)), h), Image.LANCZOS)
                    except OSError:
                        # 给了真实分件目录时，缺失 role 直接跳过，不用占位块冒充
                        src = False
                if src is False:
                    cache[key] = None
                    continue
                if src is None:
                    src = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                    d = ImageDraw.Draw(src)
                    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=max(2, min(w, h) // 4),
                                        fill=COLORS.get(p["role"], (200, 200, 200)) + (255,),
                                        outline=(20, 20, 26, 255), width=2)
                cache[key] = src
            src = cache[key]
            if src is None:
                continue
            # 自动绑定已把「抵消骨骼朝向」烘进 attachment.rest，故 angle 就是贴图自身旋转；
            # 数学系 y 向上、逆时针为正，翻到画布 y 向下后等价于顺时针，PIL rotate 是逆时针，故取负。
            rot = src.rotate(-(p["angle"] * 57.29577951308232), expand=True, resample=Image.BICUBIC)
            px = round(p["x"] - x0 - rot.width / 2)
            py = round(-p["y"] - y0 - rot.height / 2)
            cell.alpha_composite(rot, (px, py))
        frames.append(cell)
    return frames, cw, ch

def main():
    poses = json.load(open(sys.argv[1], encoding="utf-8"))
    out = sys.argv[2]
    parts_dir = sys.argv[3] if len(sys.argv) > 3 else None
    frames, cw, ch = render(poses, parts_dir)
    cols = len(frames)
    sheet = Image.new("RGBA", (cw * cols, ch), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.alpha_composite(f, (i * cw, 0))
    sheet.save(out)
    frames[0].save(out.replace(".png", ".gif"), save_all=True, append_images=frames[1:],
                   duration=int(poses["duration"] * 1000 / len(frames)), loop=0, disposal=2)
    print("sheet %dx%d  cell %dx%d  frames %d  -> %s" % (sheet.width, sheet.height, cw, ch, cols, out))

if __name__ == "__main__":
    main()
