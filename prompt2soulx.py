#!/usr/bin/env python3
"""把 make-prompt.mjs 生成的分段提示音转成 SoulX-Singer 的 prompt metadata。"""
import json
import sys

import librosa
import numpy as np
import soundfile as sf
from pypinyin import Style, pinyin

PHONESET = ".run/research/SoulX-Singer/soulxsinger/utils/phoneme/phone_set.json"


def syl(ch: str) -> str:
    raw = pinyin(ch, style=Style.TONE3, neutral_tone_with_five=True, errors="ignore")
    return "zh_" + (raw[0][0].replace("v", "u:") if raw and raw[0] else "la5")


def main() -> None:
    wav_path, seg_path, dst = sys.argv[1:4]
    with open(seg_path, encoding="utf-8") as f:
        seg = json.load(f)
    x, sr = sf.read(wav_path)
    total = len(x) / sr

    durs, phones, pitches, types = [], [], [], []
    lead = seg["lead"]
    gap = seg["gap"]
    durs.append(lead); phones.append("<SP>"); pitches.append(0); types.append(1)
    for i, s in enumerate(seg["segments"]):
        a = int(round(s["start"] * sr))
        b = int(round((s["start"] + s["dur"]) * sr))
        clip = x[a:b]
        f0, _, _ = librosa.pyin(clip, fmin=100, fmax=800, sr=sr, frame_length=1024)
        vals = f0[np.isfinite(f0)]
        midi = int(round(float(librosa.hz_to_midi(np.median(vals))))) if len(vals) else 60
        durs.append(s["dur"]); phones.append(syl(s["char"])); pitches.append(midi); types.append(2)
        if i < len(seg["segments"]) - 1:
            durs.append(gap); phones.append("<SP>"); pitches.append(0); types.append(1)

    tail = round(total - sum(durs), 4)
    if tail > 0:
        durs.append(tail); phones.append("<SP>"); pitches.append(0); types.append(1)

    meta = {
        "index": "xiaoyu_prompt",
        "language": "Mandarin",
        "time": [0, int(round(total * 1000))],
        "duration": " ".join(f"{d:.4f}" for d in durs),
        "text": " ".join(["<SP>"] + [p for p in phones[1:]]),
        "phoneme": " ".join(phones),
        "note_pitch": " ".join(str(p) for p in pitches),
        "note_type": " ".join(str(t) for t in types),
        "f0": "",
    }
    with open(PHONESET, encoding="utf-8") as f:
        phoneset = set(json.load(f))
    missing = sorted({p for p in phones if p not in phoneset})
    if missing:
        raise SystemExit("phoneset 缺: " + " ".join(missing))
    with open(dst, "w", encoding="utf-8") as f:
        json.dump([meta], f, ensure_ascii=False, indent=1)
    print(f"wrote {dst}: {len(durs)} tokens, {total:.2f}s, sum={sum(durs):.2f}s, pitches={pitches}")


if __name__ == "__main__":
    main()
