#!/usr/bin/env python3
"""把 .run/scores/*.json 的逐字谱转成 SoulX-Singer 的 target metadata。

用法：python score2soulx.py .run/scores/daoxiang.json out/daoxiang.meta.json
"""
import json
import sys

from pypinyin import Style, pinyin

PHONESET = ".run/research/SoulX-Singer/soulxsinger/utils/phoneme/phone_set.json"


def syllable(ch: str) -> str:
    raw = pinyin(ch, style=Style.TONE3, neutral_tone_with_five=True, errors="ignore")
    if not raw or not raw[0]:
        return "zh_la5"
    s = raw[0][0].replace("v", "u:")
    return "zh_" + s


def build(score: dict) -> dict:
    beat = 60.0 / float(score["bpm"])
    chars = [c for c in score["lyrics"] if "\u4e00" <= c <= "\u9fa5"]
    notes = score["notes"]
    if len(chars) != len(notes):
        raise SystemExit(f"歌词 {len(chars)} 字与音符 {len(notes)} 个不相等")

    lead = 0.30
    tail = 0.20
    durations = [lead]
    phonemes = ["<SP>"]
    pitches = [0]
    types = [1]
    texts = ["<SP>"]
    prev = None
    for ch, n in zip(chars, notes):
        dur = float(n["beats"]) * beat
        durations.append(dur)
        phonemes.append(syllable(ch))
        pitches.append(int(n["midi"]))
        types.append(2)
        texts.append(ch)
        prev = ch
    durations.append(tail)
    phonemes.append("<SP>")
    pitches.append(0)
    types.append(1)
    texts.append("<SP>")

    total_ms = int(round((sum(durations) + 0.2) * 1000))
    return {
        "index": score.get("title", "score"),
        "language": "Mandarin",
        "time": [0, total_ms],
        "duration": " ".join(f"{d:.3f}" for d in durations),
        "text": " ".join(texts),
        "phoneme": " ".join(phonemes),
        "note_pitch": " ".join(str(p) for p in pitches),
        "note_type": " ".join(str(t) for t in types),
        "f0": "",
    }


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as f:
        score = json.load(f)
    meta = build(score)
    with open(PHONESET, encoding="utf-8") as f:
        phoneset = set(json.load(f))
    missing = sorted({p for p in meta["phoneme"].split() if p not in phoneset})
    if missing:
        raise SystemExit("phoneset 缺这些音素: " + " ".join(missing))
    with open(dst, "w", encoding="utf-8") as f:
        json.dump([meta], f, ensure_ascii=False, indent=1)
    n = len(meta["duration"].split())
    print(f"wrote {dst}: {n} tokens, {meta['time'][1] / 1000:.2f}s")


if __name__ == "__main__":
    main()
