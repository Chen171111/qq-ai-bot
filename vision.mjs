/**
 * 本地 OCR —— 调 ocr.exe（Windows 自带 Windows.Media.Ocr 引擎）把图片里的文字读出来。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────
 * 2026-10-18/19 查清：dsh headless 链路**不会把图片送给模型**（CLI 无附件参数、
 * attachments 目录空），task 里写图片路径模型也只当字符串看。而 WB 模型目录里
 * 30+ 个模型 supportsImages 全是 true —— 瓶颈不在模型、不在 provider。
 * 所以走「bridge 自己读图，把文字塞进 prompt」这条可控的路。
 *
 * ── OCR 怎么实现 ─────────────────────────────────────────────────────────
 * 用系统自带的 Windows.Media.Ocr（零安装、零第三方依赖）：
 *     ocr.cs  → 编译成 ocr.exe（node build-ocr.mjs）
 * 中间踩了十轮坑（PowerShell 调 WinRT 的编码/BOM/类型加载/AsTask 泛型/
 * 非打包应用的文件许可限制），全部记在 ocr.cs 的注释里，别再重走。
 *
 * ── 为什么结果写文件而不是抓 stdout ──────────────────────────────────────
 * 2026-10-18 实测：本机 node 的「管道捕获输出」式 spawn 间歇 EBUSY
 * （execFileSync/管道约五成失败；stdio:'ignore' 实测 10/10 正常）。
 * 所以这里一律 stdio:'ignore' + 结果落盘再读——和 voice.mjs 的教训一致。
 *
 * ── 局限（必须如实告诉调用方和老大）─────────────────────────────────────
 * OCR 只能读出**图里的文字**，读不出画面内容。
 * 「二次元小人说拿来」这种图，能读出台词「拿来」，但读不出小人在干嘛、
 * 什么表情。纯图画（没有文字）的图会返回空串 —— 这是正确行为，不是失败。
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OCR_EXE = join(__dirname, "ocr.exe");

/**
 * OCR 中间产物目录。
 *
 * 2026-10-19 实测：**不能用系统临时目录**（os.tmpdir() → C:\Users\<user>\
 * AppData\Local\Temp）。ocr.exe 在那里写结果会「拒绝访问」，退出码 1、
 * 什么都不产出——排查了好几轮才定位到（一度误以为是 node spawn 或 WinRT 的问题）。
 * 项目内 .run/ocr 实测可写，且和图片目录同盘，读文件更快。
 */
const OCR_TMP_DIR = join(__dirname, ".run", "ocr");

/** 单张图 OCR 的超时（毫秒）。实测 20KB 表情包 0.3s 内完成，给足余量 */
const OCR_TIMEOUT_MS = 20_000;

/** 瞬时错误码：和 voice.mjs 同一套判定（本机 spawn 偶发 EBUSY 的家族） */
const TRANSIENT = /EBUSY|EACCES|EPERM|ETXTBSY|ENOENT|ENOEXEC|UNKNOWN/i;

/**
 * 清洗 OCR 原始输出。
 *
 * 2026-10-19 实测：Windows.Media.Ocr 对中文会**逐字加空格**
 * （"拿来吧你" → "拿 来 吧 你"）。所以这里要把「单个汉字之间的空格」去掉，
 * 但保留英文单词之间、以及标点后的正常空格。
 */
export function cleanOcrText(raw) {
  if (typeof raw !== "string") return "";
  let t = raw.replace(/\r\n?/g, "\n").trim();
  if (!t) return "";
  // 先把换行统一变成空格 —— 顺序很重要：必须先去换行再做汉字去空格，
  // 否则「拿 来\n吧 你」会变成「拿来 吧你」（换行处的空格漏掉）。
  // 2026-10-19 自测抓到的真 bug，别改回去。
  t = t.replace(/\n+/g, " ");
  const HAN = "\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef";
  // 汉字（含常见中文标点）之间的空格去掉
  t = t.replace(new RegExp(`([${HAN}])[ \\t]+(?=[${HAN}])`, "g"), "$1");
  // 汉字与英文/数字之间的多余空格也收掉（"是 3 个" → "是3个" 更自然）
  t = t.replace(new RegExp(`([${HAN}])[ \\t]+(?=[0-9A-Za-z])`, "g"), "$1");
  t = t.replace(new RegExp(`([0-9A-Za-z])[ \\t]+(?=[${HAN}])`, "g"), "$1");
  // 空白压缩
  t = t.replace(/[ \t]+/g, " ");
  return t.trim();
}

/**
 * 解析 ocr.exe 的输出文件内容。
 * 协议见 ocr.cs 头注释：正常 = 纯文本（可能空串）；失败 = "##ERR##<原因>"
 */
export function parseOcrOutput(raw) {
  const t = typeof raw === "string" ? raw : "";
  if (t.startsWith("##ERR##")) {
    return { ok: false, text: "", error: t.slice(7).trim() };
  }
  return { ok: true, text: cleanOcrText(t), error: null };
}

function sleepSync(ms) {
  // 同步等待（本模块是同步 API，调用方不必等 Promise）
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 忙等太久不好，用 Atomics.wait 做真正的睡眠
    try {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, end - Date.now()));
    } catch {
      break;
    }
  }
}

/**
 * 对一张本地图片做 OCR。
 *
 * @param {string} imagePath 图片绝对路径
 * @returns {{ ok: boolean, text: string, error: string|null, ms: number, cached?: boolean }}
 *   ok=true  拿到的 text 可能为空串（图里没有文字，这是正常结果）
 *   ok=false error 说明原因（找不到 ocr.exe / 超时 / 引擎报错…）
 */
export function ocrImage(imagePath) {
  const started = Date.now();
  const fail = (error) => ({ ok: false, text: "", error, ms: Date.now() - started });

  if (!existsSync(OCR_EXE)) {
    return fail(`找不到 ${OCR_EXE}（跑 node build-ocr.mjs 编译）`);
  }
  if (!existsSync(imagePath)) {
    return fail(`图片不存在: ${imagePath}`);
  }

  // 输出文件放项目内 .run/ocr（系统临时目录 ocr.exe 写不进去，见上面注释）
  let dir;
  try {
    mkdirSync(OCR_TMP_DIR, { recursive: true });
    dir = mkdtempSync(join(OCR_TMP_DIR, "job-"));
  } catch (e) {
    return fail(`建临时目录失败: ${e.message}`);
  }
  const outPath = join(dir, "out.txt");

  let lastErr = null;
  // 瞬时错误（本机 spawn 偶发 EBUSY 家族）重试 2 次，退避 300/800ms
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync(OCR_EXE, [imagePath, outPath], {
      stdio: "ignore", // ← 关键：不建管道，避开 EBUSY
      windowsHide: true,
      timeout: OCR_TIMEOUT_MS,
    });

    if (r.error && TRANSIENT.test(String(r.error.code ?? r.error.message ?? ""))) {
      lastErr = `spawn 瞬时失败(${r.error.code ?? "?"})`;
      if (attempt < 2) {
        sleepSync(attempt === 0 ? 300 : 800);
        continue;
      }
      break;
    }
    if (r.error) {
      lastErr = `spawn 失败: ${r.error.message}`;
      break;
    }
    if (r.signal) {
      lastErr = `ocr.exe 被信号 ${r.signal} 终止（可能超时）`;
      break;
    }

    // 不论退出码如何，都读输出文件——成功/失败的信息都在文件里
    if (!existsSync(outPath)) {
      lastErr = `ocr.exe 未产出结果（退出码 ${r.status}）`;
      // 退出码非 0 且没文件 → 无意义重试，直接放弃
      break;
    }
    let raw = "";
    try {
      raw = readFileSync(outPath, "utf8");
    } catch (e) {
      lastErr = `读结果文件失败: ${e.message}`;
      break;
    }
    const parsed = parseOcrOutput(raw);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    return { ...parsed, ms: Date.now() - started };
  }

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  return fail(lastErr ?? "未知失败");
}

/**
 * 批量 OCR：把多张图识别结果拼成一段给模型看的文字。
 *
 * @param {string[]} imagePaths
 * @returns {{ ok: boolean, text: string, details: Array }}
 *   text 为可直接塞进 prompt 的描述（已过滤无文字的图）
 */
export function ocrImages(imagePaths = []) {
  const details = [];
  const lines = [];
  let anyOk = false;

  for (const [i, p] of imagePaths.entries()) {
    const r = ocrImage(p);
    details.push({ path: p, ...r });
    if (r.ok) anyOk = true;
    if (!r.ok) {
      lines.push(`图${i + 1}：识别失败（${r.error}）`);
    } else if (r.text) {
      lines.push(`图${i + 1} 里的文字：「${r.text}」`);
    } else {
      lines.push(`图${i + 1}：没有识别到文字（大概是纯图画/照片）`);
    }
  }

  return { ok: anyOk, text: lines.join("\n"), details };
}

// ── 动图抽帧 ──────────────────────────────────────────────────────────────
// 2026-10-19 实测：动图（GIF / 动态 WebP）直接送给模型，**只会拿到第一帧**。
// 模型自己都说了：「你给的附件在传过来时被规范化成了 webp（400×400），
// 只保留了其中一帧」——pi-ai 适配器会把图规范化成单帧 webp。
// 所以动图必须先自己拆帧，把 N 张静态图一起送，模型才能看出「在变什么」。

/** 抽帧脚本与产物目录（都在项目内，和 OCR 同一个 .run 根） */
const ANIM_SCRIPT = join(__dirname, "anim.py");
const FRAMES_DIR = join(__dirname, ".run", "img", "frames");

/** 动图扩展名：只有这两种会尝试抽帧，其他直接当静态图 */
const ANIM_EXTS = new Set([".gif", ".webp"]);

/**
 * 找一个能跑 Pillow 的 python。
 *
 * 优先 DSH 自带的 runtime python（Pillow 12.3.0 已预装），
 * 其次环境变量 PYTHON，最后 PATH 里的 python3 / python（都要实测能 import PIL）。
 */
let pythonCache; // undefined = 还没探测过；null = 探测过但没有可用的
function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  const cands = [
    process.env.PYTHON,
    join(homedir(), ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe"),
    "python3",
    "python",
  ];
  for (const c of cands) {
    if (!c) continue;
    if (c.includes("/") || c.includes("\\")) {
      if (existsSync(c)) {
        pythonCache = c;
        return c;
      }
      continue;
    }
    // 裸命令名要在 PATH 里真能跑、且带 Pillow 才算（ECS 只有 python3，没有 python；
    // 2026-10-27 前这里直接 return "python"，抽帧整条链路在 Linux 上等于死的）
    const r = spawnSync(c, ["-c", "import PIL"], { stdio: "ignore", timeout: 8000, windowsHide: true });
    if (r.status === 0) {
      pythonCache = c;
      return c;
    }
  }
  pythonCache = null;
  return null;
}

/** 按扩展名粗判是否可能是动图（真正是否多帧由 anim.py 判定） */
export function isAnimatedExt(imagePath) {
  const m = String(imagePath || "").toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? ANIM_EXTS.has(m[0]) : false;
}

/**
 * 把一张动图拆成若干静态 PNG。
 *
 * 与 ocrImage 同一套稳妥做法：**结果的 stdout 重定向到文件**，不走管道捕获
 * （本机 node 管道式 spawn 约五成 EBUSY）。
 *
 * @param {string} imagePath 动图绝对路径
 * @param {{maxFrames?: number}} opts 最多取几帧（默认 6）
 * @returns {{ok: boolean, total: number, picked: number, frames: string[], error?: string}}
 */
export function extractFrames(imagePath, opts = {}) {
  const maxFrames = Number(opts.maxFrames) || 6;
  const empty = { ok: false, total: 0, picked: 0, frames: [] };

  if (!imagePath || !existsSync(imagePath)) {
    return { ...empty, error: "图片不存在" };
  }
  if (!isAnimatedExt(imagePath)) {
    return { ...empty, error: "扩展名不是 gif/webp" };
  }
  const py = findPython();
  if (!py) return { ...empty, error: "找不到可用的 python（需要 Pillow）" };
  if (!existsSync(ANIM_SCRIPT)) return { ...empty, error: `缺少 ${ANIM_SCRIPT}` };

  const stem = basename(imagePath).replace(/\.[^.]+$/, "");
  const outDir = join(FRAMES_DIR, stem);
  const logPath = join(FRAMES_DIR, `.anim-${stem}-${Date.now()}.log`);

  try {
    mkdirSync(FRAMES_DIR, { recursive: true });
    // 同一张图重抽时先清空旧帧，避免新旧混在一起
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

    const fd = openSync(logPath, "w");
    let r;
    try {
      r = spawnSync(py, [ANIM_SCRIPT, imagePath, outDir, String(maxFrames)], {
        stdio: ["ignore", fd, fd],
        timeout: 30_000,
        windowsHide: true,
      });
    } finally {
      closeSync(fd);
    }

    let raw = "";
    try {
      raw = readFileSync(logPath, "utf8");
    } catch {}
    try {
      unlinkSync(logPath);
    } catch {}

    // anim.py 最后一行是 JSON 结果；日志里可能有 [warn] 之类的前置输出
    const jsonLine = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();

    if (!jsonLine) {
      return { ...empty, error: `抽帧脚本无输出（rc=${r?.status}）${raw.slice(-120)}` };
    }

    const parsed = JSON.parse(jsonLine);
    return {
      ok: parsed.ok === true,
      total: Number(parsed.total) || 0,
      picked: Number(parsed.picked) || 0,
      frames: Array.isArray(parsed.frames) ? parsed.frames : [],
      ...(parsed.ok ? {} : { error: parsed.error || "抽帧失败" }),
    };
  } catch (e) {
    return { ...empty, error: `抽帧异常: ${String(e.message).slice(0, 140)}` };
  }
}

/**
 * 批量展开：把动图替换成它的多帧，静态图原样保留。
 *
 * @param {string[]} imagePaths
 * @param {{maxFrames?: number, maxTotal?: number}} opts
 * @returns {{images: string[], animations: Array}}
 */
export function expandAnimatedImages(imagePaths = [], opts = {}) {
  const maxTotal = Number(opts.maxTotal) || 10; // 一轮最多送几张图，防止视觉 token 爆掉
  const out = [];
  const animations = [];

  for (const p of imagePaths) {
    if (!isAnimatedExt(p)) {
      out.push(p);
      continue;
    }
    const r = extractFrames(p, opts);
    if (r.ok && r.frames.length > 0) {
      animations.push({ path: p, total: r.total, picked: r.picked });
      for (const f of r.frames) {
        if (out.length >= maxTotal) break;
        out.push(f);
      }
    } else {
      // 抽帧失败（不是多帧 / 没 python / 脚本报错）→ 当静态图用，别丢
      animations.push({ path: p, total: r.total, picked: 0, error: r.error });
      out.push(p);
    }
  }

  return { images: out, animations };
}

// ── 自测 ──────────────────────────────────────────────────────────────────
// node vision.mjs --selftest
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--selftest")) {
    let pass = 0;
    let total = 0;
    const check = (name, cond, detail = "") => {
      total++;
      if (cond) {
        pass++;
        console.log(`PASS  ${name}`);
      } else {
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
      }
    };

    // cleanOcrText：汉字之间的空格必须去掉
    check("cleanOcrText 去汉字间空格", cleanOcrText("拿 来 吧 你") === "拿来吧你", cleanOcrText("拿 来 吧 你"));
    check("cleanOcrText 保留英文词间空格", cleanOcrText("hello world") === "hello world", cleanOcrText("hello world"));
    check("cleanOcrText 空串", cleanOcrText("") === "");
    check("cleanOcrText 纯空白", cleanOcrText("  \n\t ") === "");
    check("cleanOcrText 多行合并", cleanOcrText("拿 来\n吧 你") === "拿来吧你", cleanOcrText("拿 来\n吧 你"));
    check("cleanOcrText 中英混排", cleanOcrText("这是 test 文字") === "这是test文字", cleanOcrText("这是 test 文字"));
    check("cleanOcrText 非字符串", cleanOcrText(null) === "");

    // parseOcrOutput：协议解析
    check("parseOcrOutput 正常文本", parseOcrOutput("拿 来 吧 你").text === "拿来吧你");
    check("parseOcrOutput 空文本 ok=true", parseOcrOutput("").ok === true);
    check("parseOcrOutput 错误标记", parseOcrOutput("##ERR##超时").ok === false);
    check("parseOcrOutput 错误原因", parseOcrOutput("##ERR##超时").error === "超时");
    check("parseOcrOutput 错误时 text 为空", parseOcrOutput("##ERR##超时").text === "");

    // ocrImage：文件不存在的失败路径（不依赖真跑 OCR）
    const miss = ocrImage("Z:\\definitely\\not\\here.png");
    check("ocrImage 图片不存在返回 ok=false", miss.ok === false);
    check("ocrImage 报图片不存在", /图片不存在/.test(miss.error), miss.error);

    // ── 动图抽帧 ──
    check("isAnimatedExt 认 gif", isAnimatedExt("a.GIF") === true);
    check("isAnimatedExt 认 webp", isAnimatedExt("b.webp") === true);
    check("isAnimatedExt 不认 png", isAnimatedExt("c.png") === false);
    check("isAnimatedExt 不认无扩展名", isAnimatedExt("d") === false);

    const noFile = extractFrames("Z:\\definitely\\not\\here.gif");
    check("extractFrames 文件不存在 ok=false", noFile.ok === false);
    check("extractFrames 报图片不存在", /图片不存在/.test(noFile.error || ""), noFile.error);

    const notAnim = extractFrames(import.meta.filename);
    check("extractFrames 非动图扩展名直接拒", notAnim.ok === false && /扩展名/.test(notAnim.error || ""), notAnim.error);

    // expandAnimatedImages：静态图原样保留、不报错
    const exp = expandAnimatedImages(["Z:\\nope\\plain.png"], { maxFrames: 3 });
    check("expand 静态图原样保留", exp.images.length === 1 && exp.images[0] === "Z:\\nope\\plain.png");
    check("expand 静态图不产生 animations", exp.animations.length === 0);

    // 坏了/不存在的动图：不能丢消息，要回退成原图
    const expBad = expandAnimatedImages(["Z:\\nope\\broken.gif"], { maxFrames: 3 });
    check("expand 抽帧失败的动图回退成原图", expBad.images.length === 1 && expBad.images[0] === "Z:\\nope\\broken.gif");
    check("expand 记录失败原因", expBad.animations.length === 1 && !!expBad.animations[0].error);

    console.log(`\n${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  }
}
