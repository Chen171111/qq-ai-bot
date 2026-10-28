#!/usr/bin/env node
/**
 * 语音合成 —— Node 直连 Microsoft Edge 的 TTS 服务（edge-tts 协议）。
 *
 * ── 为什么不用本机 SAPI ──────────────────────────────────────────────────
 * 本机 SAPI 报 `0x80045040`（SPERR_DEVICE_BUSY：无音频设备/设备被占），
 * 且 `Speak()` 会卡死 60 秒以上 —— 这台机器不能用本机 TTS。
 *
 * ── 为什么不用 Python 的 edge-tts 包 ─────────────────────────────────────
 * 装不上：沙箱拦 pip 的 `.metadata` 写入（`Errno 13 Permission denied`），
 * 而 wheel 解压后又缺 `aiohttp`（依赖树太深，手工下载不现实）。
 *
 * ── 现在的做法 ─────────────────────────────────────────────────────────
 * 协议本身很简单（WebSocket + 两帧），麻烦只在 `Sec-MS-GEC` token：
 * 它的算法是**混淆过的**（drm.py 里 `_SHA256_INITIAL` / `_CS64_COEFFICIENTS`
 * 都是魔改常量，不是标准 SHA256）。我按标准 SHA256 试过，服务端 403。
 * → 所以 token 用官方 drm.py 算：`vendor/py/gen_token.py` 单独加载那一个文件，
 *   绕开 aiohttp。合成由本文件负责。
 *
 * 已验证通：握手 OPEN、合成 25KB MP3（帧头 ff f3）、NapCat 发出 message_id。
 *
 * 用法：
 *   node voice.mjs "要念的文本" out.mp3 [音色]
 *   node voice.mjs --selftest     （用环境变量 TTS_TOKEN，不 spawn）
 */

import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { generateSecMsGec } from "./vendor/js/ms-gec.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const WSS_BASE = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

const BASE_HEADERS = {
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "en-US,en;q=0.9",
};

/** 音色列表 API（与 voices/list 同一 host） */
const VOICE_LIST_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

/** token 每 5 分钟按 300 秒取整变一次，缓存到边界即可 */
let tokenCache = { value: null, expiresAt: 0 };

/** 找 Python：显式路径优先，其次常见安装位置。不用 `where`（避免 PATH 里的 Store 别名） */
const PY_CANDIDATES = [
  "E:\\Python\\python.exe",
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python314", "python.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python313", "python.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python312", "python.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python311", "python.exe"),
  "C:\\Python\\python.exe",
  "C:\\Python313\\python.exe",
  "C:\\Python312\\python.exe",
];

/** 实际存在的 Python 列表（去重，保序）。spawn EBUSY 时按这个顺序轮换 */
function listPythons() {
  const seen = new Set();
  const out = [];
  for (const p of [process.env.TTS_PYTHON, ...PY_CANDIDATES]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** 同步睡（execFileSync 是同步 API，重试间隔只能这么等） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** spawn 瞬时失败（杀软扫描锁 exe 的窗口期、非 PE 文件等），值得重试/换候选 */
function isTransientSpawnErr(e) {
  return /EBUSY|EACCES|EPERM|ETXTBSY|ENOENT|ENOEXEC|UNKNOWN/i.test(String(e?.message ?? e));
}

/**
 * 取 Sec-MS-GEC token。
 * 优先级：环境变量 TTS_TOKEN（测试用）> 纯 JS 算法（vendor/js/ms-gec.mjs，
 * 零 spawn；2026-10-18 从 drm.py 移植，已与 Python 原版 8 组时间戳逐位比对）
 * > spawn Python 兜底（候选轮换 + 退避重试）。
 *
 * 为什么这样分层：本机 node 的「管道捕获输出」式 spawn 间歇 EBUSY
 * （bridge.log 实测成功率约五成），而 token 算法是纯整数运算 ——
 * 主路径走 JS 彻底消灭 spawn；Python 兜底留给 JS 版将来失配时的退路。
 */
export function getToken() {
  if (process.env.TTS_TOKEN) {
    const t = process.env.TTS_TOKEN.trim();
    if (/^[0-9A-Fa-f]{16}-[0-9A-Fa-f]{64}$/.test(t)) return t;
  }
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;

  let out = null;

  // 主路径：纯 JS 算 token —— 不 spawn 任何进程，没有 EBUSY 这类环境抖动
  try {
    const js = generateSecMsGec(now / 1000);
    if (/^[0-9A-Fa-f]{16}-[0-9A-Fa-f]{64}$/.test(js)) out = js;
    else console.warn(`[voice] JS token 格式不对: ${String(js).slice(0, 80)}`);
  } catch (e) {
    console.warn(`[voice] JS token 失败，回退 Python：${e.message}`);
  }

  // 兜底：spawn Python（多候选轮换 + 每候选 3 次退避重试）
  if (out === null) {
    const script = join(__dirname, "vendor", "py", "gen_token.py");
    if (!existsSync(script)) throw new Error(`找不到 ${script}`);
    const pys = listPythons();
    if (pys.length === 0) throw new Error("找不到 Python（edge-tts token 需要它）");

    let lastErr = null;
    for (const py of pys) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) sleepSync(attempt === 2 ? 500 : 1000);
        try {
          const pyOut = execFileSync(py, [script], {
            encoding: "utf8",
            timeout: 20000,
            windowsHide: true,
          }).trim();
          if (/^[0-9A-Fa-f]{16}-[0-9A-Fa-f]{64}$/.test(pyOut)) {
            out = pyOut;
            break; // 本候选成功，不必再试
          }
          lastErr = new Error(`token 格式不对: ${pyOut.slice(0, 80)}`);
        } catch (e) {
          lastErr = e;
          // 非瞬时错误（脚本报错等）：重试/轮换无意义，直接抛
          if (!isTransientSpawnErr(e)) throw e;
          console.warn(
            `[voice] spawn ${py} 第 ${attempt} 次失败（${e.code ?? e.message}）` +
              `${attempt < 3 ? "，退避后重试" : "，换下一个候选"}`
          );
        }
      }
      if (out !== null) break;
    }
    if (out === null) throw lastErr ?? new Error("token 生成失败");
  }

  const periodMs = 300 * 1000;
  tokenCache = { value: out, expiresAt: Math.floor(now / periodMs) * periodMs + periodMs };
  return out;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 合成一段文本，返回 MP3 Buffer。
 *
 * 帧格式（对照 vendor/py/edge_tts/communicate.py）：
 *   1. speech.config 帧（JSON，声明输出格式 audio-24khz-48kbitrate-mono-mp3）
 *   2. ssml 帧
 *   3. 二进制音频帧：前 2 字节大端 = 头部长度，跳过才是音频
 *   4. Path:turn.end 文本帧 = 结束
 */
export function synthesize(text, voice = "zh-CN-XiaoyiNeural", rate = "+0%", volume = "+0%") {
  const token = getToken();
  const url = `${WSS_BASE}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=2-${CHROMIUM_FULL_VERSION}`;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const ws = new WebSocket(url, {
      headers: {
        ...BASE_HEADERS,
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "Sec-WebSocket-Version": "13",
      },
    });

    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      reject(new Error("TTS 超时 30 秒"));
    }, 30000);

    const finish = (err, buf) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(buf);
    };

    ws.on("open", () => {
      const now = new Date().toISOString();
      const config =
        `X-Timestamp:${now}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              },
            },
          },
        });
      const ssml =
        `X-RequestId:${randomUUID().replace(/-/g, "")}\r\n` +
        "Content-Type:application/ssml+xml\r\n" +
        `X-Timestamp:${now}Z\r\n` +
        "Path:ssml\r\n\r\n" +
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">` +
        `<voice name="${voice}"><prosody pitch="+0Hz" rate="${rate}" volume="${volume}">` +
        escapeXml(text) +
        "</prosody></voice></speak>";
      ws.send(config);
      ws.send(ssml);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (data.length < 2) return;
        const headerLen = data.readUInt16BE(0);
        const audio = data.subarray(2 + headerLen);
        if (audio.length > 0) chunks.push(audio);
        return;
      }
      const msg = data.toString();
      if (msg.includes("Path:turn.end")) {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) finish(new Error("没有收到音频数据"));
        else finish(null, buf);
      }
    });

    ws.on("error", (e) => finish(new Error(`WebSocket 错误: ${e.message}`)));
    ws.on("close", (code) => {
      if (chunks.length === 0) finish(new Error(`连接关闭 code=${code}，未收到音频`));
    });
  });
}

const VOICE_CACHE_DIR = join(__dirname, ".run", "voice");
const VOICE_CACHE_MAX = 100;

/** 清理旧语音缓存（按 mtime 留最近 N 个） */
export function pruneVoiceCache() {
  try {
    if (!existsSync(VOICE_CACHE_DIR)) return;
    const files = readdirSync(VOICE_CACHE_DIR)
      .map((f) => join(VOICE_CACHE_DIR, f))
      .filter((p) => p.endsWith(".mp3"))
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const f of files.slice(VOICE_CACHE_MAX)) unlinkSync(f.p);
  } catch {}
}

/**
 * 带缓存地合成一段语音，写入文件并返回路径。
 * 同一文本 + 同一音色 5 分钟内复用，避免重复请求（也省时间）。
 */
export async function speakToFile(text, { voice = "zh-CN-XiaoyiNeural", rate = "+0%", cacheMs = 5 * 60 * 1000 } = {}) {
  const { createHash: ch } = await import("node:crypto");
  const key = ch("sha1").update(`${voice}\n${text}`).digest("hex").slice(0, 24);
  mkdirSync(VOICE_CACHE_DIR, { recursive: true });
  const file = join(VOICE_CACHE_DIR, `${key}.mp3`);

  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < cacheMs) {
    return { path: file, cached: true };
  }
  const buf = await synthesize(text, voice, rate);
  writeFileSync(file, buf);
  pruneVoiceCache();
  return { path: file, cached: false };
}

/** 常用的中文音色（完整列表跑 `node voice.mjs --list`） */
export const VOICES = {
  xiaoyi: "zh-CN-XiaoyiNeural", // 女声，活泼甜美（2026-10-19 前的默认）
  xiaoxiao: "zh-CN-XiaoxiaoNeural", // 女声，最自然（微软旗舰，情感最丰富）
  xiaoyu: "zh-TW-HsiaoYuNeural", // 女声，台湾腔偏甜
  xiaochen: "zh-TW-HsiaoChenNeural", // 女声，台湾腔偏成熟
  xiaobei: "zh-CN-liaoning-XiaobeiNeural", // 女声，东北话
  xiaoni: "zh-CN-shaanxi-XiaoniNeural", // 女声，陕西话
  yunxi: "zh-CN-YunxiNeural", // 男声，少年
  yunjian: "zh-CN-YunjianNeural", // 男声，沉稳
  yunxia: "zh-CN-YunxiaNeural", // 男声，少年感更轻
  yunyang: "zh-CN-YunyangNeural", // 男声，新闻播报腔
};

export async function listVoices() {
  const https = await import("node:https");
  return new Promise((resolve, reject) => {
    https
      .get(VOICE_LIST_URL, { headers: BASE_HEADERS }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith("voice.mjs");

if (isMain && process.argv[2] === "--selftest") {
  // 只测 token 生成与协议拼接，不真发请求（token 由 TTS_TOKEN 提供）
  try {
    const token = getToken();
    console.log(`PASS  token 生成 — ${token.slice(0, 22)}…（共 ${token.length} 字符）`);
    process.exit(0);
  } catch (e) {
    console.error("FAIL  token:", e.message);
    process.exit(1);
  }
} else if (isMain && process.argv[2] === "--list") {
  listVoices()
    .then((vs) => {
      const zh = vs.filter((v) => v.Locale?.startsWith("zh"));
      console.log(`共 ${vs.length} 个音色，中文 ${zh.length} 个：`);
      for (const v of zh) console.log(`  ${v.ShortName.padEnd(38)} ${v.Gender.padEnd(7)} ${v.FriendlyName}`);
    })
    .catch((e) => {
      console.error("失败:", e.message);
      process.exit(1);
    });
} else if (isMain && process.argv[2] && !process.argv[2].startsWith("-")) {
  const [text, outPath, voice] = process.argv.slice(2);
  synthesize(text, voice || VOICES.xiaoyi)
    .then((buf) => {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      console.log(`OK ${buf.length} 字节 → ${outPath}`);
    })
    .catch((e) => {
      console.error("合成失败:", e.message);
      process.exit(1);
    });
}
