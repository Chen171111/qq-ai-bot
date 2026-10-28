/**
 * 给表情包库打标签：让视觉模型看每张图，生成名字 + 关键词，写进 stickers/index.json。
 *
 * 为什么需要：模型要「在合适的时候发合适的表情包」，就得知道每张图是什么情绪。
 * 文件名不可靠（QQ 存下来叫 1792336726259_xxx.jpg），必须看图打标。
 *
 * 用法：
 *   node tag-stickers.mjs              # 只处理还没标签的
 *   node tag-stickers.mjs --all        # 全部重打
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const DIR = join(process.cwd(), "stickers");
const INDEX = join(DIR, "index.json");
const TMP_DIR = join(process.cwd(), ".run", "stickers-tmp");
const DSH_BIN = join(homedir(), ".dsh-runtime", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const IMG_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;

const PROMPT = (p) =>
  `[[img:${p}]] 这是一张 QQ 表情包。看画面，只输出一行 JSON（不要代码块、不要解释）：\n` +
  `{"name":"四个字以内的名字","keywords":["3到5个能触发它使用的中文词"],"vibe":"一句话说这是什么情绪/场景"}`;

function listImages() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => IMG_EXT.test(f))
    .map((f) => join(DIR, f));
}

/**
 * 从模型输出里取出第一个可用的 JSON。
 *
 * 为什么不能直接 /{[\s\S]*?}/ 或贪婪匹配：2026-10-28 批量打 22 张时，
 * 有 6 张（27%）的模型输出里 JSON 出现了两遍，或者把 prompt 的格式要求
 * 原样复述在中间（「不要代码块，直接一行。」+ 又一段 JSON）。
 * 任何单次正则都会把两段和中间杂文一起抓进来 → JSON.parse 必失败。
 * 所以先逐行试完整对象，跨行时再按括号配平截取。
 */
function extractJson(text) {
  const s = String(text ?? "");
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (j && typeof j === "object" && !Array.isArray(j)) return j;
    } catch {}
  }

  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const j = JSON.parse(s.slice(start, i + 1));
          return j && typeof j === "object" && !Array.isArray(j) ? j : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 文件没被改过就跳过。不能比 mtimeMs 严格相等：index 里存的是精确浮点，
 *  文件系统返回的是毫秒截断值（1792336726454.5212 vs 1792336726000），
 *  严格比较恒为 false，每次都会把所有图白打一遍。 */
function stampUnchanged(entry, filePath) {
  if (!entry || typeof entry.mtimeMs !== "number") return false;
  try {
    return Math.abs(entry.mtimeMs - statSync(filePath).mtimeMs) < 1000;
  } catch {
    return false;
  }
}

function tagOne(p) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("DSH_")) delete env[k];
  env.DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

  // 本机 node 的「管道捕获输出」式 spawn 会间歇 EBUSY（voice/OCR 都踩过），
  // 所以把 stdout/stderr 重定向到文件再读，不走管道。
  mkdirSync(TMP_DIR, { recursive: true });
  const outFile = join(TMP_DIR, `tag-${Date.now()}.log`);
  const fd = openSync(outFile, "w");
  let r;
  try {
    r = spawnSync(process.execPath, [DSH_BIN, "--profile", "headless", PROMPT(p)], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", fd, fd],
      timeout: 120_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }

  let out = "";
  try {
    out = readFileSync(outFile, "utf8").trim();
  } catch {}
  try {
    unlinkSync(outFile);
  } catch {}

  if (r.error) return { ok: false, error: `spawn 失败: ${r.error.message}` };
  if (!out) return { ok: false, error: `无输出（退出码 ${r.status}）` };

  const j = extractJson(out);
  if (!j) return { ok: false, error: `模型没给出可用 JSON（退出码 ${r.status}）: ${out.slice(-160)}` };
  if (!Array.isArray(j.keywords) || j.keywords.length === 0) {
    return { ok: false, error: `keywords 为空 — 原文 ${JSON.stringify(j).slice(0, 160)}` };
  }
  return { ok: true, data: j };
}

if (process.argv.includes("--selfcheck")) {
  const cases = [
    ["单个 JSON", '{"name":"a","keywords":["x"],"vibe":"y"}', "a"],
    ["两遍 JSON", '{"name":"a","keywords":["x"]}\n{"name":"b","keywords":["y"]}', "a"],
    [
      "JSON + prompt 复述 + JSON",
      '{"name":"a","keywords":["x"]}\n\n不要代码块，直接一行。\n{"name":"b","keywords":["y"]}',
      "a",
    ],
    ["JSON 跨行", '前置说明\n{\n  "name": "a",\n  "keywords": ["x"]\n}\n后置', "a"],
    ["vibe 里含大括号", '{"name":"a","keywords":["x"],"vibe":"{笑}哈哈"}', "a"],
    ["字符串里有转义引号", '{"name":"a","keywords":["x"],"vibe":"他说\\"好\\""}', "a"],
    ["只有说明没有 JSON", "抱歉我看不出来", null],
    ["空输入", "", null],
    ["JSON 语法错", '{"name":"a",,}', null],
  ];
  let ok = 0;
  for (const [label, input, want] of cases) {
    const got = extractJson(input)?.name ?? null;
    const pass = got === want;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label} — 期望 ${want} 实得 ${got}`);
    if (pass) ok++;
  }
  console.log(`\n${ok}/${cases.length} 通过`);
  process.exit(ok === cases.length ? 0 : 1);
}

const forceAll = process.argv.includes("--all");
mkdirSync(DIR, { recursive: true });

let index = {};
if (existsSync(INDEX)) {
  try {
    index = JSON.parse(readFileSync(INDEX, "utf8"));
  } catch {
    index = {};
  }
}

const files = listImages();
if (files.length === 0) {
  console.log(`stickers/ 里没有图片。把表情包丢进 ${DIR} 再跑一次。`);
  process.exit(0);
}

console.log(`共 ${files.length} 张图，开始打标签…\n`);
let done = 0;
let fail = 0;
for (const p of files) {
  const key = basename(p);
  const old = index[key];
  if (!forceAll && stampUnchanged(old, p)) {
    console.log(`跳过 ${key}（已打过）`);
    continue;
  }
  const t0 = Date.now();
  const r = tagOne(p);
  if (r.ok) {
    index[key] = {
      name: r.data.name,
      keywords: r.data.keywords,
      vibe: r.data.vibe,
      mtimeMs: statSync(p).mtimeMs,
      taggedAt: new Date().toISOString(),
    };
    console.log(`✓ ${key} → ${r.data.name} [${r.data.keywords.join("/")}] ${Date.now() - t0}ms`);
    done++;
  } else {
    console.log(`✗ ${key} → ${r.error}`);
    fail++;
  }
}

writeFileSync(INDEX, JSON.stringify(index, null, 2), "utf8");
console.log(`\n完成：${done} 张新打标，${fail} 张失败，索引共 ${Object.keys(index).length} 条 → ${INDEX}`);
