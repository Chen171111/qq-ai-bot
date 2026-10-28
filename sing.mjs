#!/usr/bin/env node
/**
 * 唱歌 —— 两条路，靠 SING_PROVIDER 切。
 *
 *   volc （默认）  火山引擎 MemeSong 歌唱合成：模板曲 + 中文歌词，≤15 秒，真唱歌。
 *                  接口：POST https://sami.bytedance.com/api/v1/invoke?version=v4&...
 *                  要 VOLC_SING_APPKEY / VOLC_SING_TOKEN，控制台开通「歌唱合成」后才有。
 *   local（备用）  用 Edge TTS 逐字合成她的声音，再按音符重采样移调。
 *                  不用任何外部账号，但是「带音高的说话」，不是真唱。
 *
 * 为什么默认 volc：2026-10-24 老大定的——先用火山三个月（1000 次免费额度），
 * 之后把 SING_PROVIDER 改回 local 即可，代码不用动。
 *
 * 本地移调的两个依赖是**懒加载**的：只用 volc 时不需要装，
 * 所以服务器现在不装也不影响（到切换那天再 npm i 这两个纯 JS 包）。
 */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, ".run", "sing");
const SCORE_DIR = join(__dirname, ".run", "scores");
const CACHE_MS = 7 * 864e5;

export const SING_PROVIDER = (process.env.SING_PROVIDER || "volc").toLowerCase();

/** 火山控制台里「歌唱合成」页面的 AppID / Access Token */
const VOLC_APPKEY = process.env.VOLC_SING_APPKEY || "";
const VOLC_TOKEN = process.env.VOLC_SING_TOKEN || "";
const VOLC_VERSION = process.env.VOLC_SING_VERSION || "v4";
const VOLC_URL = "https://sami.bytedance.com/api/v1/invoke";

/** 官方附录（2026-10-24 抓取）：三个发音人、七首模板曲 */
export const SINGERS = {
  qingxin: { id: "zh_female_sing_qingxin", name: "清新女声" },
  huoli: { id: "zh_male_sing_huoli", name: "活力男声" },
  soprano: { id: "zh_female_sing_soprano", name: "女高音" },
};

export const SONGS = {
  zhaopengyou: "找朋友",
  naoxinnian: "闹新年",
  xinnianhao_f: "新年好",
  "salut_damour-5": "爱的礼赞",
  susanna: "Susanna",
  queen_of_night: "夜后的咏叹调",
  bear_dance: "洋娃娃和小熊跳舞",
};

export const SONG_IDS = Object.keys(SONGS);

/** 模板曲都在 15 秒以内，歌词超过这个长度会被截断 */
export const MAX_LYRICS = 40;

export function volcConfigured() {
  return Boolean(VOLC_APPKEY && VOLC_TOKEN);
}

/**
 * 拼 MemeSong 的请求体。
 *
 * 注意是**两层 JSON**：外层 {"payload":"<json 字符串>"}，
 * 不能直接把 speaker 平铺在外层——官方示例就是嵌套的，平铺会报参数错。
 */
export function buildVolcBody({ speaker, song, text, format = "mp3", sampleRate = 24000 }) {
  return JSON.stringify({
    payload: JSON.stringify({
      speaker,
      song_name: song,
      text,
      audio_config: { format, sample_rate: sampleRate },
    }),
  });
}

export function volcUrl({ appkey = VOLC_APPKEY, token = VOLC_TOKEN, version = VOLC_VERSION } = {}) {
  const q = new URLSearchParams({
    version,
    token,
    appkey,
    namespace: "MemeSong",
  });
  return `${VOLC_URL}?${q.toString()}`;
}

/** 调 MemeSong，返回音频 Buffer。失败抛错（带 status_code / status_text）。 */
export async function singVolc(text, { singer = SINGERS.qingxin.id, song = "zhaopengyou", format = "mp3", timeoutMs = 60000 } = {}) {
  if (!volcConfigured()) throw new Error("没配 VOLC_SING_APPKEY / VOLC_SING_TOKEN");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(volcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildVolcBody({ speaker: singer, song, text, format }),
      signal: ac.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);

    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new Error(`返回不是 JSON: ${raw.slice(0, 200)}`);
    }
    if (j.status_code !== 0 && j.status_code !== 20000000 && j.status_code != null) {
      throw new Error(`status_code=${j.status_code} ${j.status_text ?? ""} ${String(j.payload ?? "").slice(0, 160)}`);
    }
    if (!j.data) throw new Error(`没有音频数据 ${String(j.payload ?? "").slice(0, 160)}`);
    return Buffer.from(j.data, "base64");
  } finally {
    clearTimeout(timer);
  }
}

// ── 本地移调（三个月后的备用线）──────────────────────────────────────────

const LOCAL_SR = 24000;
/** 估计失败时的兜底基频（实测 Xiaoyi「啊」约 310Hz） */
const BASE_F0 = 309;

/**
 * 测一段 PCM 的中位基频（自相关 + 抛物线插值，与 check-pitch.py 同口径）。
 *
 * 为什么要测而不是写死：Edge 对不同字给出的自然音高不同
 * （「啊」≈310Hz、「啦」≈313.6Hz），写死 309 会让所有音符系统性偏高
 * 0.6 半音左右。逐字测出实际基频再算移调比，音程才准。
 * 估计不可靠（静音 / 超出人声范围）时返回 null，由调用方回落 BASE_F0。
 */
export function estimateF0(pcm, sr = LOCAL_SR) {
  const W = Math.round(0.05 * sr);
  const H = Math.round(0.02 * sr);
  const lo = Math.round(sr / 1000);
  const hi = Math.round(sr / 70);
  const vals = [];
  for (let s = 0; s + W <= pcm.length; s += H) {
    let energy = 0;
    for (let i = 0; i < W; i++) energy += pcm[s + i] * pcm[s + i];
    if (Math.sqrt(energy / W) < 0.01) continue;

    let mean = 0;
    for (let i = 0; i < W; i++) mean += pcm[s + i];
    mean /= W;

    let ac0 = 0;
    for (let i = 0; i < W; i++) ac0 += (pcm[s + i] - mean) ** 2;
    if (ac0 <= 0) continue;

    const hiLag = Math.min(hi + 1, W - 1);
    const ac = new Float64Array(hiLag + 1);
    for (let lag = Math.max(0, lo - 1); lag <= hiLag; lag++) {
      let sum = 0;
      for (let i = 0; i < W - lag; i++) sum += (pcm[s + i] - mean) * (pcm[s + i + lag] - mean);
      ac[lag] = sum;
    }

    let best = lo;
    for (let lag = lo; lag <= Math.min(hi, W - 1); lag++) if (ac[lag] > ac[best]) best = lag;
    const conf = ac[best] / ac0;
    if (conf < 0.35) continue;
    let lag = best;
    if (lag > 0 && lag < W - 1) {
      const y0 = ac[lag - 1], y1 = ac[lag], y2 = ac[lag + 1];
      const den = 2 * (y0 - 2 * y1 + y2);
      if (Math.abs(den) > 1e-12) lag += (y0 - y2) / den;
    }
    const f = sr / lag;
    if (f >= 120 && f <= 700) vals.push(f);
  }
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

/** 歌单：音符用相对主音的半音数表示。歌词按字一一对应，多出来的音哼「啦」。 */
export const TUNES = {
  xiaoxingxing: { name: "小星星", tonic: 294, notes: [0, 0, 7, 7, 9, 9, 7, 5, 5, 4, 4, 2, 2, 0] },
};

/**
 * 重采样移调（r>1 升调、r<1 降调）。
 *
 * 用加窗 sinc 插值，而不是「盒式滤波 + 线性插值」：后者在 r>1 时阻带衰减只有
 * 十几 dB，语音的高频会折叠回可听带 → 金属感/电流声。这里 r>1 时把滤波器截止
 * 压到 1/r 先抗混叠，再逐样本卷积。
 */
function shiftPcm(pcm, r) {
  if (Math.abs(r - 1) < 1e-4) return pcm.slice();
  const n = Math.floor(pcm.length / r);
  const out = new Float32Array(n);
  const TAPS = 16;
  const cutoff = r > 1 ? 1 / r : 1;
  const fc = Math.PI * cutoff;
  for (let i = 0; i < n; i++) {
    const x = i * r;
    const i0 = Math.floor(x);
    let acc = 0;
    let wsum = 0;
    for (let k = -TAPS + 1; k <= TAPS; k++) {
      const idx = i0 + k;
      if (idx < 0 || idx >= pcm.length) continue;
      const t = x - idx;
      const u = t / TAPS;
      if (Math.abs(u) >= 1) continue;
      const sinc = t === 0 ? 1 : Math.sin(fc * t) / (fc * t);
      const win = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const c = sinc * win;
      acc += pcm[idx] * c;
      wsum += c;
    }
    out[i] = wsum > 1e-6 ? acc / wsum : 0;
  }
  return out;
}

function noteSegment(src, r, durSec) {
  const sh = shiftPcm(src, r);
  const need = Math.round(durSec * LOCAL_SR);
  const skip = Math.round(0.02 * LOCAL_SR);
  const out = new Float32Array(need);
  for (let i = 0; i < need; i++) {
    const j = skip + i;
    out[i] = j < sh.length ? sh[j] : 0;
  }
  const fade = Math.round(0.012 * LOCAL_SR);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[need - 1 - i] *= i / fade;
  }
  return out;
}

/**
 * 本地移调：逐字合成她的声音 → 按音符移调 → 定长裁剪 → 拼接 → MP3。
 * 依赖 mpg123-decoder（解码）和 @breezystack/lamejs（编码），懒加载。
 */
export async function singLocal(text, { tune = "xiaoxingxing" } = {}) {
  const t = TUNES[tune];
  if (!t) throw new Error(`没有这首：${tune}`);

  let MPEGDecoder, Mp3Encoder;
  ({ MPEGDecoder, Mp3Encoder } = await loadAudioDeps());

  const { synthesize } = await import("./voice.mjs");
  const dec = new MPEGDecoder();
  await dec.ready;
  try {
    const chars = [...String(text || "")].filter((c) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c));
    const slots = t.notes.map((_, i) => chars[i] ?? "啦");
    const cache = new Map();
    for (const ch of new Set(slots)) {
      const mp3 = await synthesize(ch, "zh-CN-XiaoyiNeural");
      const { channelData } = await dec.decode(mp3);
      const pcm = channelData[0];
      // 逐字测基频：不同字的自然音高不同，写死常数会系统性跑调
      cache.set(ch, { pcm, f0: estimateF0(pcm) ?? BASE_F0 });
    }

    const gap = new Float32Array(Math.round(0.03 * LOCAL_SR));
    const parts = [];
    t.notes.forEach((semi, i) => {
      const target = t.tonic * Math.pow(2, semi / 12);
      const { pcm, f0 } = cache.get(slots[i]);
      parts.push(noteSegment(pcm, target / f0, 0.42));
      parts.push(gap);
    });

    const total = parts.reduce((a, p) => a + p.length, 0);
    const mix = new Float32Array(total);
    let off = 0;
    for (const p of parts) { mix.set(p, off); off += p.length; }

    return encodeMp3(mix, Mp3Encoder);
  } finally {
    await dec.free();
  }
}

// ── 按谱唱：谱子（JSON / MIDI）→ 逐字移调 + 时长拉伸 → 成品 ─────────────

/** 按谱唱最多多少字：一整段副歌够用，防止一次合成几百字拖死进程 */
export const MAX_SCORE_LYRICS = 300;
/** 单份谱最长秒数，超过直接拒绝 */
const MAX_SCORE_SEC = 180;
const LYRIC_RE = /[\u4e00-\u9fa5A-Za-z0-9]/;

function decodeMidiText(bytes) {
  const u = new TextDecoder("utf-8").decode(bytes);
  if (!u.includes("\uFFFD")) return u;
  try {
    return new TextDecoder("gbk").decode(bytes);
  } catch {
    return u;
  }
}

function readVlq(buf, p) {
  let v = 0;
  let b;
  do {
    b = buf[p++];
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80);
  return [v, p];
}

function parseTrack(buf, start, end, tempos) {
  let q = start;
  let tick = 0;
  let running = 0;
  const open = new Map();
  const notes = [];
  const lyrics = [];
  let name = "";
  while (q < end) {
    let dt;
    [dt, q] = readVlq(buf, q);
    tick += dt;
    if (q >= end) break;
    let status = buf[q];
    if (status & 0x80) {
      q++;
      if (status < 0xf0) running = status;
    } else {
      status = running;
    }
    if (!status) throw new Error("MIDI 事件流损坏（缺运行状态）");

    if (status === 0xff) {
      const type = buf[q++];
      let len;
      [len, q] = readVlq(buf, q);
      const d = q;
      q += len;
      if (type === 0x51 && len === 3) {
        tempos.push({ tick, us: (buf[d] << 16) | (buf[d + 1] << 8) | buf[d + 2] });
      } else if (type === 0x05) {
        lyrics.push({ tick, text: decodeMidiText(buf.subarray(d, d + len)) });
      } else if (type === 0x03 && !name) {
        name = decodeMidiText(buf.subarray(d, d + len)).trim();
      }
      if (type === 0x2f) break;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      let len;
      [len, q] = readVlq(buf, q);
      q += len;
      continue;
    }

    const hi = status & 0xf0;
    const ch = status & 0x0f;
    if (hi === 0x90 || hi === 0x80) {
      const note = buf[q];
      const vel = buf[q + 1];
      q += 2;
      if (hi === 0x90 && vel > 0) {
        if (!open.has(note)) open.set(note, []);
        open.get(note).push(tick);
      } else {
        const st = open.get(note);
        if (st && st.length) notes.push({ start: st.pop(), end: tick, midi: note, ch });
      }
    } else if (hi === 0xc0 || hi === 0xd0) {
      q += 1;
    } else {
      q += 2;
    }
  }
  for (const [midi, st] of open) for (const s of st) notes.push({ start: s, end: tick, midi, ch: 0 });
  return { notes, lyrics, name };
}

function tickToMs(tempos, division) {
  const list = [];
  for (const t of tempos.sort((a, b) => a.tick - b.tick)) {
    if (list.length && list[list.length - 1].tick === t.tick) list[list.length - 1] = t;
    else list.push(t);
  }
  if (!list.length || list[0].tick > 0) list.unshift({ tick: 0, us: 500000 });
  const segs = [{ tick: list[0].tick, ms: 0, us: list[0].us }];
  let ms = 0;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    ms += ((list[i].tick - prev.tick) / division) * (prev.us / 1000);
    segs.push({ tick: list[i].tick, ms, us: list[i].us });
  }
  return (tick) => {
    let s = segs[0];
    for (const x of segs) {
      if (x.tick <= tick) s = x;
      else break;
    }
    return s.ms + ((tick - s.tick) / division) * (s.us / 1000);
  };
}

/** 解析标准 MIDI：取音符最多的一轨当主旋律，忽略打击乐通道，合并成单音 */
export function parseMidi(buf) {
  if (buf.length < 14 || buf.toString("ascii", 0, 4) !== "MThd") throw new Error("不是 MIDI（缺 MThd 头）");
  const hlen = buf.readUInt32BE(4);
  const ntrks = buf.readUInt16BE(10);
  const division = buf.readInt16BE(12);
  if (division <= 0) throw new Error("不支持 SMPTE 时基的 MIDI");

  const tracks = [];
  const tempos = [];
  let p = 8 + hlen;
  let guard = 0;
  while (p + 8 <= buf.length && tracks.length < ntrks && guard++ < 4096) {
    const type = buf.toString("ascii", p, p + 4);
    const len = buf.readUInt32BE(p + 4);
    const body = p + 8;
    const end = body + len;
    if (end > buf.length) break;
    if (type === "MTrk") tracks.push(parseTrack(buf, body, end, tempos));
    p = end;
  }
  if (!tracks.length) throw new Error("MIDI 里没有轨道");

  const scoreOf = (t) => t.notes.filter((n) => n.ch !== 9);
  const pool = tracks.filter((t) => scoreOf(t).length > 0);
  if (!pool.length) throw new Error("MIDI 里没有音符");
  const melody = pool.reduce((a, b) => (scoreOf(b).length > scoreOf(a).length ? b : a));
  const toMs = tickToMs(tempos, division);

  const raw = scoreOf(melody).map((n) => ({
    midi: n.midi,
    startMs: toMs(n.start),
    endMs: toMs(Math.max(n.end, n.start + 1)),
  }));
  raw.sort((a, b) => a.startMs - b.startMs || b.midi - a.midi);

  const events = [];
  for (const n of raw) {
    const last = events[events.length - 1];
    if (last && n.startMs < last.startMs + last.durMs - 1) {
      if (n.midi > last.midi) {
        last.durMs = Math.max(20, n.startMs - last.startMs);
        events.push({ startMs: n.startMs, durMs: Math.max(20, n.endMs - n.startMs), midi: n.midi });
      }
    } else {
      events.push({ startMs: n.startMs, durMs: Math.max(20, n.endMs - n.startMs), midi: n.midi });
    }
  }

  const lyricPool = [];
  for (const t of tracks) for (const l of t.lyrics) lyricPool.push(l);
  lyricPool.sort((a, b) => a.tick - b.tick);
  const lyrics = lyricPool
    .map((l) => [...l.text].filter((c) => LYRIC_RE.test(c)).join(""))
    .filter(Boolean)
    .join("");

  const totalMs = events.reduce((m, e) => Math.max(m, e.startMs + e.durMs), 0);
  return { title: melody.name || "", lyrics, events, totalMs };
}

function parseJsonScore(raw, id) {
  const s = JSON.parse(raw);
  const notes = Array.isArray(s) ? s : s.notes;
  if (!Array.isArray(notes) || !notes.length) throw new Error("谱里没有 notes");
  const beatMs = Number(s.beatMs) || 60000 / (Number(s.bpm) || 100);
  const events = [];
  let t = 0;
  for (const n of notes) {
    const durMs = Number(n.beats ?? n.beat ?? 1) * beatMs;
    const midi = Number(n.midi ?? n.note);
    if (!n.rest && Number.isFinite(midi)) events.push({ startMs: t, durMs, midi });
    t += durMs;
  }
  return { title: String(s.title || id), lyrics: String(s.lyrics || ""), events, totalMs: t };
}

export function listScores() {
  if (!existsSync(SCORE_DIR)) return [];
  const out = [];
  for (const f of readdirSync(SCORE_DIR)) {
    const ext = extname(f).toLowerCase();
    if (![".json", ".mid", ".midi"].includes(ext)) continue;
    const id = basename(f, ext);
    const file = join(SCORE_DIR, f);
    let title = id;
    if (ext === ".json") {
      try {
        const j = JSON.parse(readFileSync(file, "utf8"));
        if (j.title) title = String(j.title);
      } catch {}
    }
    out.push({ id, title, ext, file, mtime: statSync(file).mtimeMs });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

/** 按文件名或标题找谱，「稻香」「daoxiang」「《稻香》」都能命中 */
export function findScore(name) {
  const q = String(name || "").replace(/[《》\s]/g, "").toLowerCase();
  if (!q) return null;
  const all = listScores();
  const norm = (s) => s.replace(/[《》\s]/g, "").toLowerCase();
  return (
    all.find((s) => norm(s.id) === q) ||
    all.find((s) => norm(s.title) === q) ||
    all.find((s) => norm(s.title).includes(q) || norm(s.id).includes(q)) ||
    null
  );
}

export function loadScore(name) {
  const s = findScore(name);
  if (!s) throw new Error(`没有这份谱：${name}`);
  const raw = readFileSync(s.file);
  const score = s.ext === ".json" ? parseJsonScore(raw.toString("utf8"), s.id) : parseMidi(raw);
  score.id = s.id;
  score.file = s.file;
  score.mtime = s.mtime;
  if (!score.title) score.title = s.title;
  if (!score.events.length) throw new Error("谱里没有音符");
  if (score.totalMs > MAX_SCORE_SEC * 1000) throw new Error(`谱太长（${Math.round(score.totalMs / 1000)} 秒）`);
  return score;
}

/** 掐掉字音首尾的静音，否则每个音都会带一段空白、拉长后听起来一顿一顿 */
function trimSilence(pcm, thresh = 0.008) {
  const W = Math.round(0.01 * LOCAL_SR);
  if (pcm.length < W * 3) return pcm;
  const loud = (i) => {
    let e = 0;
    for (let k = 0; k < W; k++) {
      const v = pcm[i + k] || 0;
      e += v * v;
    }
    return Math.sqrt(e / W) > thresh;
  };
  let a = 0;
  let b = pcm.length;
  while (a + W < pcm.length && !loud(a)) a += W;
  while (b - W > a && !loud(b - W)) b -= W;
  const pad = Math.round(0.01 * LOCAL_SR);
  a = Math.max(0, a - pad);
  b = Math.min(pcm.length, b + pad);
  return a < b ? pcm.subarray(a, b) : pcm;
}

/**
 * WSOLA 时长拉伸：Hann 窗、50% 重叠、窗和恒为 1，不改音高。
 *
 * 固定步长的 OLA 在长音上帧间相位错开，叠出来是嗡嗡的金属声；这里每帧前做
 * ±256 样本（约 10ms）的相似度搜索，挑和上一帧自然延续最像的位置再叠。
 */
function timeStretch(x, factor) {
  if (!Number.isFinite(factor) || factor <= 0) return x.slice();
  if (Math.abs(factor - 1) < 1e-3) return x.slice();
  const N = 1024;
  const H = N >> 1;
  const Ha = H / factor;
  const tol = 256;
  const outLen = Math.max(1, Math.round(x.length * factor));
  const out = new Float32Array(outLen + N);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const at = (i) => (i >= 0 && i < x.length ? x[i] : 0);
  let prev = 0;
  for (let hs = 0, k = 0; hs < outLen + N; hs += H, k++) {
    const nominal = Math.round(k * Ha);
    if (nominal >= x.length) break;
    let a = nominal;
    if (k > 0) {
      const want = Math.round(prev + Ha);
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 4) {
        const c = nominal + d;
        if (c < 0) continue;
        let s = 0;
        for (let i = 0; i < H; i += 2) s += at(c + i) * at(want + i);
        if (s > bestScore) {
          bestScore = s;
          a = c;
        }
      }
    }
    prev = a;
    for (let i = 0; i < N; i++) out[hs + i] += at(a + i) * w[i];
  }
  return out.subarray(0, outLen).slice();
}

/** 每段音统一响度，避免个别字特别冲、个别字听不见 */
function normalizeRms(x, target = 0.1) {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  const rms = Math.sqrt(e / Math.max(1, x.length));
  if (rms < 1e-4) return x;
  const g = target / rms;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function scoredSegment(pcm, r, durSec) {
  const src = trimSilence(pcm);
  const shifted = shiftPcm(src, r);
  const want = Math.max(1, Math.round(durSec * LOCAL_SR));
  const out = timeStretch(shifted, want / shifted.length);
  const res = new Float32Array(want);
  res.set(out.subarray(0, Math.min(want, out.length)));
  normalizeRms(res);
  const fade = Math.min(Math.round(0.012 * LOCAL_SR), Math.floor(want / 4));
  for (let i = 0; i < fade; i++) {
    res[i] *= i / fade;
    res[want - 1 - i] *= i / fade;
  }
  return res;
}

async function loadAudioDeps() {
  try {
    const { MPEGDecoder } = await import("mpg123-decoder");
    const { Mp3Encoder } = await import("@breezystack/lamejs");
    return { MPEGDecoder, Mp3Encoder };
  } catch {
    throw new Error("本地移调缺依赖：npm i mpg123-decoder @breezystack/lamejs");
  }
}

function encodeMp3(mix, Mp3Encoder) {
  const enc = new Mp3Encoder(1, LOCAL_SR, 64);
  const pcm16 = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i++) {
    pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767)));
  }
  const blocks = [];
  for (let i = 0; i < pcm16.length; i += 1152) {
    const b = enc.encodeBuffer(pcm16.subarray(i, Math.min(i + 1152, pcm16.length)));
    if (b.length) blocks.push(Buffer.from(b));
  }
  blocks.push(Buffer.from(enc.flush()));
  return Buffer.concat(blocks);
}

/** 按谱唱：每个音单独取字、移到目标音高、拉到音符长度，再按起始时间叠进整轨 */
export async function singScore(text, score) {
  const { MPEGDecoder, Mp3Encoder } = await loadAudioDeps();
  const { synthesize } = await import("./voice.mjs");
  const dec = new MPEGDecoder();
  await dec.ready;
  try {
    const given = [...String(text || score.lyrics || "")].filter((c) => LYRIC_RE.test(c));
    const slots = score.events.map((_, i) => given[i] ?? "啦");
    const cache = new Map();
    for (const ch of new Set(slots)) {
      const mp3 = await synthesize(ch, "zh-CN-XiaoyiNeural");
      const { channelData } = await dec.decode(mp3);
      const pcm = channelData[0];
      cache.set(ch, { pcm, f0: estimateF0(pcm) ?? BASE_F0 });
    }

    const total = Math.ceil((score.totalMs / 1000) * LOCAL_SR) + Math.round(0.2 * LOCAL_SR);
    const mix = new Float32Array(total);
    // 整首按整八度平移进她本来的音区：移调比例越接近 1，共振峰被拉得越少。
    // 《稻香》副歌落在 E5，直接唱要把每个字升高近一个八度 → 共振峰翻倍，就是变声器音。
    const f0s = [...cache.values()].map((v) => v.f0).sort((a, b) => a - b);
    const voiceF0 = f0s[Math.floor(f0s.length / 2)] || BASE_F0;
    const mids = score.events.map((e) => e.midi).sort((a, b) => a - b);
    const midMed = mids[Math.floor(mids.length / 2)];
    const oct = Math.round((69 + 12 * Math.log2(voiceF0 / 440) - midMed) / 12);
    const semis = 12 * oct;
    score.events.forEach((ev, i) => {
      const { pcm, f0 } = cache.get(slots[i]);
      const target = 440 * Math.pow(2, (ev.midi + semis - 69) / 12);
      const dur = Math.max(0.08, ev.durMs / 1000 - 0.02);
      const seg = scoredSegment(pcm, target / f0, dur);
      const off = Math.round((ev.startMs / 1000) * LOCAL_SR);
      for (let k = 0; k < seg.length && off + k < mix.length; k++) mix[off + k] += seg[k];
    });
    return encodeMp3(mix, Mp3Encoder);
  } finally {
    await dec.free();
  }
}

// ── 统一入口 + 缓存 ─────────────────────────────────────────────────────

/** 本地移调算法版本：改了算法就 +1，避免 7 天缓存继续供应旧音频 */
const LOCAL_ALGO = 3;

/** 缓存 key：谱 id / mtime / 歌词任何一项变了都会换 key，离线渲染脚本也用它对齐 */
export function cacheKeyFor({ provider, singer = "", song = "", tune = "", score = null, lyrics = "" }) {
  return createHash("sha1")
    .update(
      [
        provider,
        singer,
        song,
        tune,
        provider === "local" || score ? LOCAL_ALGO : "",
        score ? `${score.id}@${score.mtime}` : "",
        lyrics,
      ].join("\n")
    )
    .digest("hex")
    .slice(0, 24);
}

/** 同一段词 + 同一首歌 7 天内复用，避免重复消耗火山额度 */
export async function sing(text, opts = {}) {
  const provider = (opts.provider || SING_PROVIDER).toLowerCase();
  const score = opts.score ? loadScore(opts.score) : null;
  const limit = score ? MAX_SCORE_LYRICS : MAX_LYRICS;
  const lyrics = [...String(text || score?.lyrics || "")].slice(0, limit).join("");
  const key = cacheKeyFor({
    provider,
    singer: opts.singer ?? "",
    song: opts.song ?? "",
    tune: opts.tune ?? "",
    score,
    lyrics,
  });
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${key}.mp3`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < CACHE_MS) {
    return { path: file, cached: true, provider, lyrics, score: score?.id };
  }
  const buf = score
    ? await singScore(lyrics, score)
    : provider === "local"
      ? await singLocal(lyrics, opts)
      : await singVolc(lyrics, opts);
  writeFileSync(file, buf);
  return { path: file, cached: false, provider, lyrics, bytes: buf.length, score: score?.id, title: score?.title };
}

// ── CLI ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith("sing.mjs");

if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    const all = listScores();
    console.log(
      all.length ? all.map((s, i) => `${i + 1}. 《${s.title}》 (${s.id} · ${s.ext})`).join("\n") : "还没有谱子：把 .json / .mid 放进 .run/scores/"
    );
  } else {
    const si = args.indexOf("--score");
    const scoreId = si >= 0 ? args[si + 1] : null;
    const text = args.filter((_, i) => i !== si && i !== si + 1).join(" ");
    sing(text, scoreId ? { score: scoreId } : {})
      .then((r) => console.log(`OK ${r.provider} ${r.score ? `谱=${r.score} ` : ""}${r.bytes ?? "cache"} 字节 → ${r.path}`))
      .catch((e) => {
        console.error("失败:", e.message);
        process.exit(1);
      });
  }
}
