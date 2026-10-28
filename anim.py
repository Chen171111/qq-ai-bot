"""GIF / 动态 WebP 抽帧：把动图拆成若干静态 PNG，供视觉模型逐帧看。

用法：
    python anim.py <动图路径> <输出目录> [最多帧数]

输出：最后一行打印 JSON（供 node 侧解析）
    {"ok":true,"total":3,"picked":3,"frames":["...png",...]}
    {"ok":false,"error":"...","total":0,"picked":0,"frames":[]}

设计要点：
- 动图直传模型时只会拿到第一帧（pi-ai 会把它规范化成 webp 单帧），
  所以必须自己抽帧，把多张静态图一起送过去。
- 帧数上限默认 6：既能表达动作变化，又不会把视觉 token 撑爆。
- 每帧最长边压到 512：多帧同送时按像素预算算更安全。
- 抽帧是等间隔的，首尾帧必取（表情包的关键信息常在首尾）。
"""

import json
import sys
import os

MAX_SIDE = 512


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: anim.py <file> <outdir> [maxFrames]", "total": 0, "picked": 0, "frames": []}))
        return 2

    src = sys.argv[1]
    outdir = sys.argv[2]
    max_frames = int(sys.argv[3]) if len(sys.argv) > 3 else 6

    try:
        from PIL import Image, ImageSequence
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Pillow 不可用: {e}", "total": 0, "picked": 0, "frames": []}))
        return 2

    if not os.path.exists(src):
        print(json.dumps({"ok": False, "error": f"文件不存在: {src}", "total": 0, "picked": 0, "frames": []}))
        return 2

    try:
        im = Image.open(src)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"打不开: {e}", "total": 0, "picked": 0, "frames": []}))
        return 2

    n_frames = getattr(im, "n_frames", 1)
    if n_frames <= 1:
        print(json.dumps({"ok": False, "error": "不是多帧动图", "total": n_frames, "picked": 0, "frames": []}))
        return 0

    # 等间隔取帧，首尾必含
    if n_frames <= max_frames:
        picks = list(range(n_frames))
    else:
        step = (n_frames - 1) / (max_frames - 1)
        picks = sorted({int(round(i * step)) for i in range(max_frames)})
        picks[-1] = n_frames - 1

    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(src))[0]
    written = []

    for seq, idx in enumerate(picks, start=1):
        try:
            im.seek(idx)
            frame = im.convert("RGBA")
            # 白底合成，避免透明区域变黑或被模型误读
            if frame.mode == "RGBA":
                bg = Image.new("RGB", frame.size, (255, 255, 255))
                bg.paste(frame, mask=frame.split()[-1])
                rgb = bg
            else:
                rgb = frame.convert("RGB")
            w, h = rgb.size
            scale = min(1.0, MAX_SIDE / max(w, h))
            if scale < 1.0:
                rgb = rgb.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
            dest = os.path.join(outdir, f"{base}-f{seq:02d}.png")
            rgb.save(dest, "PNG")
            written.append(dest)
        except Exception as e:
            print(f"[warn] 第 {idx} 帧失败: {e}", file=sys.stderr)

    print(json.dumps({"ok": bool(written), "total": n_frames, "picked": len(written), "frames": written}, ensure_ascii=False))
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
