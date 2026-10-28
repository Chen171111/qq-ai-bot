#!/usr/bin/env python3
"""原曲 → 小玉翻唱：人声分离 → 逐帧 f0 → SoulX-Singer-SVC → 混回伴奏。

用法（在项目根目录执行）：
    .venv-soulx/Scripts/python.exe svc_song.py --input song.mp3 --out out.wav
    .venv-soulx/Scripts/python.exe svc_song.py --input song.mp3 --out out.wav --no-sep
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
REPO = ROOT / ".run" / "research" / "SoulX-Singer"
SVC_MODEL = ROOT / "pretrained_models" / "SoulX-Singer" / "model-svc.pt"
SR = 24000


def load_mono(path, sr=SR):
    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="原曲音频（wav/mp3/flac…）")
    ap.add_argument("--out", required=True, help="输出 wav")
    ap.add_argument("--prompt", default=str(ROOT / ".run/soulx/xiaoyu_orca_prompt.wav"))
    ap.add_argument("--prompt-f0", default=str(ROOT / ".run/soulx/xiaoyu_orca_prompt_f0.npy"))
    ap.add_argument("--work", default=str(ROOT / ".run/soulx/work"))
    ap.add_argument("--no-sep", action="store_true", help="跳过人声分离，直接拿原音频当人声")
    ap.add_argument("--pitch-shift", type=int, default=0)
    ap.add_argument("--auto-shift", action="store_true")
    ap.add_argument("--vocal-gain", type=float, default=1.0)
    ap.add_argument("--acc-gain", type=float, default=0.7)
    ap.add_argument("--min-voiced-ratio", type=float, default=0.30, help="浊音帧占比下限")
    ap.add_argument("--min-audible-ratio", type=float, default=0.20, help="人声可闻帧占比下限")
    ap.add_argument("--audible-dbfs", type=float, default=-50.0, help="可闻帧的 dBFS 阈值")
    ap.add_argument("--check-only", action="store_true", help="只做人声检测，不跑 SVC")
    args = ap.parse_args()

    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    prompt = Path(args.prompt).resolve()
    prompt_f0 = Path(args.prompt_f0).resolve()
    input_path = Path(args.input).resolve()
    sys.path.insert(0, str(REPO))

    vocal_path = work / "vocal.wav"
    acc = None
    if args.no_sep:
        y = load_mono(input_path)
        sf.write(vocal_path, y, SR)
        print(f"[1/4] 未分离，直接使用原音频：{len(y)/SR:.2f}s")
    else:
        from preprocess.tools.vocal_separation.model import VocalSeparator

        pre = ROOT / "pretrained_models" / "SoulX-Singer-Preprocess"
        sep = VocalSeparator(
            sep_model_path=str(pre / "mel-band-roformer-karaoke/mel_band_roformer_karaoke_becruily.ckpt"),
            sep_config_path=str(pre / "mel-band-roformer-karaoke/config_karaoke_becruily.yaml"),
            der_model_path=str(pre / "dereverb_mel_band_roformer/dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"),
            der_config_path=str(pre / "dereverb_mel_band_roformer/dereverb_mel_band_roformer_anvuew.yaml"),
            device="cuda",
            use_der=False,
            verbose=False,
        )
        res = sep.process(str(input_path))
        voc = res.vocals_dereverbed
        acc_audio = res.accompaniment
        if voc.ndim > 1:
            voc = voc.mean(axis=0)
        if acc_audio.ndim > 1:
            acc_audio = acc_audio.mean(axis=0)
        sf.write(vocal_path, voc, res.sample_rate)
        sf.write(work / "acc.wav", acc_audio, res.sample_rate)
        acc = librosa.resample(
            acc_audio.astype(np.float32), orig_sr=res.sample_rate, target_sr=SR
        )
        print(f"[1/4] 分离完成：人声 {len(voc)/res.sample_rate:.2f}s，伴奏 {len(acc)/SR:.2f}s")
        # 分离模型仍占着显存；SVC 是独立子进程，不先释放会在 8 GB 卡上撞 OOM
        import gc

        import torch

        del sep
        gc.collect()
        torch.cuda.empty_cache()

    f0_path = work / "vocal_f0.npy"
    if not f0_path.exists() or f0_path.stat().st_mtime < vocal_path.stat().st_mtime:
        from preprocess.tools.f0_extraction import F0Extractor

        F0Extractor(
            str(ROOT / "pretrained_models/SoulX-Singer/rmvpe.pt"), device="cuda", verbose=False
        ).process(str(vocal_path), f0_path=str(f0_path))
    f0 = np.asarray(np.load(f0_path)).reshape(-1)
    voiced_frames = int((f0 > 0).sum())
    voiced_ratio = float(voiced_frames / len(f0)) if len(f0) else 0.0
    median_f0 = float(np.median(f0[f0 > 0])) if voiced_frames else 0.0
    print(f"[2/4] f0：{len(f0)} 帧，浊音 {voiced_frames}，中位 {median_f0:.1f}Hz")

    voc_audio, voc_sr = sf.read(vocal_path, dtype="float32")
    if voc_audio.ndim > 1:
        voc_audio = voc_audio.mean(axis=1)
    if voc_audio.size:
        rms = float(np.sqrt(np.mean(voc_audio**2)))
        rms_db = float(20 * np.log10(max(rms, 1e-9)))
        frame_len = max(1, int(voc_sr * 0.05))
        nframes = voc_audio.size // frame_len
        if nframes:
            frames = voc_audio[: nframes * frame_len].reshape(nframes, frame_len)
            frame_rms = np.sqrt(np.mean(frames**2, axis=1))
            audible_ratio = float((frame_rms > 10 ** (args.audible_dbfs / 20)).mean())
        else:
            audible_ratio = 0.0
    else:
        rms_db = -120.0
        audible_ratio = 0.0

    gate_failed = voiced_ratio < args.min_voiced_ratio or audible_ratio < args.min_audible_ratio
    stats = {
        "duration": round(float(voc_audio.size) / voc_sr, 3) if voc_sr else 0.0,
        "frames": len(f0),
        "voicedFrames": voiced_frames,
        "voicedRatio": round(voiced_ratio, 4),
        "audibleRatio": round(audible_ratio, 4),
        "rmsDbfs": round(rms_db, 2),
        "medianF0": round(median_f0, 1),
        "thresholds": {
            "minVoicedRatio": args.min_voiced_ratio,
            "minAudibleRatio": args.min_audible_ratio,
            "audibleDbfs": args.audible_dbfs,
        },
        "pass": not gate_failed,
    }
    stats_path = work / "vocal-stats.json"
    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"[GATE] 浊音 {voiced_ratio * 100:.1f}%（阈值 {args.min_voiced_ratio * 100:.0f}%），"
        f"人声可闻 {audible_ratio * 100:.1f}%（阈值 {args.min_audible_ratio * 100:.0f}%），"
        f"RMS {rms_db:.1f} dBFS → {'不通过' if gate_failed else '通过'}"
    )
    if gate_failed:
        print(f"[GATE] 判定人声不足，跳过 SVC：{stats_path}")
        return 42
    if args.check_only:
        print("[GATE] --check-only，跳过 SVC")
        return 0

    outdir = work / "svc"
    outdir.mkdir(exist_ok=True)
    cmd = [
        sys.executable, "-m", "cli.inference_svc",
        "--device", "cuda",
        "--model_path", str(SVC_MODEL),
        "--config", "soulxsinger/config/soulxsinger.yaml",
        "--prompt_wav_path", str(prompt),
        "--target_wav_path", str(vocal_path),
        "--prompt_f0_path", str(prompt_f0),
        "--target_f0_path", str(f0_path),
        "--save_dir", str(outdir),
        "--pitch_shift", str(args.pitch_shift),
        "--fp16",
    ]
    if args.auto_shift:
        cmd.append("--auto_shift")
    env = dict(
        os.environ,
        PYTHONPATH=str(REPO),
        HF_HOME=str(ROOT / "pretrained_models" / "hf-cache"),
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
    )
    subprocess.run(cmd, cwd=str(REPO), env=env, check=True)
    gen = load_mono(outdir / "generated.wav")
    print(f"[3/4] SVC 完成：{len(gen)/SR:.2f}s")

    if acc is not None:
        n = min(len(gen), len(acc))
        mix = gen[:n] * args.vocal_gain + acc[:n] * args.acc_gain
    else:
        mix = gen
    peak = float(np.abs(mix).max())
    if peak > 0:
        mix = mix * (0.9 / peak)
    sf.write(out_path, mix.astype(np.float32), SR, subtype="PCM_16")
    print(f"[4/4] 写出 {out_path}：{len(mix)/SR:.2f}s，峰值归一 {peak:.3f} → 0.900")
    return 0


if __name__ == "__main__":
    sys.exit(main())
