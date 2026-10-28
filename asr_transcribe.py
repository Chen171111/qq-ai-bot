#!/usr/bin/env python
"""语音转文字：本地 whisper-base，CPU 推理，输出单行 JSON。

用法：
    python asr_transcribe.py --input voice.mp3
    python asr_transcribe.py --input voice.mp3 --out result.json

输出（stdout 最后一行）：
    {"ok": true, "text": "你好", "seconds": 3, "audioSeconds": 2.4}
    {"ok": false, "error": "..."}

设计要点：
- 服务器没有 GPU/ASR，笔记本兜底；模型已离线，不联网。
- QQ 语音常是 amr/silk/m4a，统一先用 imageio-ffmpeg 转 16k 单声道 wav。
- whisper-base 对静音容易产幻（「请不吝点赞…」），按块能量跳过静音，并过滤常见幻听句。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import numpy as np
import soundfile as sf
import torch
from transformers import WhisperForConditionalGeneration, WhisperProcessor

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(
    ROOT,
    "pretrained_models",
    "hf-cache",
    "hub",
    "models--openai--whisper-base",
    "snapshots",
    "main",
)

CHUNK_SEC = 30
MAX_AUDIO_SEC = 300
SILENCE_RMS = 0.003

# whisper 在静音/噪声上常见的幻听句，直接整句丢弃
PHANTOM = re.compile(
    r"(请不吝点赞|订阅|转发|打赏|明镜|点点栏目|字幕由|字幕提供|Amara\.org|"
    r"谢谢观看|感谢观看|优优独播剧场|中文字幕|字幕组)"
)


def ffmpeg_exe():
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def to_wav16k(src, dst):
    subprocess.run(
        [ffmpeg_exe(), "-y", "-i", src, "-ac", "1", "-ar", "16000", "-vn", dst],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
    )


def clean_text(s):
    s = str(s or "").strip()
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"(.)\1{4,}", r"\1\1", s)  # 拉长的「啊啊啊啊啊」
    if not s:
        return ""
    s = PHANTOM.sub("", s)
    s = re.sub(r"[，,、]+$", "", s)
    # 只剩标点/符号视为空
    if not re.search(r"[\w\u4e00-\u9fff]", s):
        return ""
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--model", default=os.environ.get("WHISPER_DIR") or DEFAULT_MODEL)
    ap.add_argument("--out", default="")
    ap.add_argument("--threads", type=int, default=int(os.environ.get("ASR_THREADS") or 4))
    args = ap.parse_args()

    started = time.time()
    result = {"ok": False, "error": "unknown"}

    try:
        if not os.path.isfile(args.input):
            raise FileNotFoundError(f"找不到音频 {args.input}")
        if not os.path.isdir(args.model):
            raise FileNotFoundError(f"找不到模型 {args.model}")

        torch.set_num_threads(max(1, args.threads))

        with tempfile.TemporaryDirectory(prefix="asr-") as td:
            wav = os.path.join(td, "in.wav")
            to_wav16k(args.input, wav)
            audio, sr = sf.read(wav, dtype="float32", always_2d=False)

        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if audio.size == 0:
            raise ValueError("音频是空的")

        audio = audio[: sr * MAX_AUDIO_SEC]
        processor = WhisperProcessor.from_pretrained(args.model)
        model = WhisperForConditionalGeneration.from_pretrained(args.model)
        model.eval()

        parts = []
        step = CHUNK_SEC * sr
        for start in range(0, audio.size, step):
            chunk = audio[start : start + step]
            if chunk.size < sr // 4:
                continue
            rms = float(np.sqrt(np.mean(np.square(chunk))))
            if rms < SILENCE_RMS:
                continue
            feats = processor(chunk, sampling_rate=16000, return_tensors="pt").input_features
            with torch.inference_mode():
                ids = model.generate(
                    feats,
                    language="zh",
                    task="transcribe",
                    max_new_tokens=256,
                    condition_on_prev_tokens=False,
                )
            text = clean_text(processor.batch_decode(ids, skip_special_tokens=True)[0])
            if text:
                parts.append(text)

        result = {
            "ok": True,
            "text": "".join(parts).strip(),
            "seconds": round(time.time() - started, 1),
            "audioSeconds": round(audio.size / sr, 1),
        }
    except Exception as e:  # noqa: BLE001 - CLI 边界，必须回 JSON 给 watcher
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"[:400]}

    line = json.dumps(result, ensure_ascii=False)
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass
    print(line, flush=True)
    if not result.get("ok"):
        print(f"[asr] {result.get('error')}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
