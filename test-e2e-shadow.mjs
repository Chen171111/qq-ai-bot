#!/usr/bin/env node
/**
 * 端到端影子测试（2026-10-21 审计新增）。
 *
 * 为什么不用 test-bridge-cmds.mjs 的方式（原地起第二个 bridge 连 3999）：
 *   1. 单实例锁不允许第二个实例；停生产 bridge 才能跑，跑完还得记得拉回来。
 *   2. 原地跑会读写**真** model.json / .run/* —— 测试中途挂了配置就留在脏状态。
 *
 * 做法：把 bridge 运行所需文件拷到临时「影子目录」，在影子里起 bridge，
 * 全程不碰生产实例与生产配置。mock NapCat 监听 3998。
 *
 * 覆盖场景（全部不烧积分——只走指令路径，不进 LLM）：
 *   S1  #语音 状态查询有回复
 *   S2  #语音 关 → 回复 + .run/voice-mute.json 落盘含该用户
 *   S3  杀掉 bridge 重开 → #语音 仍显示静音（跨重启持久化，2026-10-21 主 bug 的回归测试）
 *   S4  #语音 开 → 恢复
 *   S5  同一 message_id 重投 → 只回一次（一级去重）
 *   S6  3 秒内同文本重发（不同 message_id）→ 只回一次（二级去重）
 *   S7  非白名单用户发指令 → 完全不回
 *   S8  #模型 坏名字 → 拒绝且 model.json 不变
 *   S9  影子目录内双开 → 第二实例拿锁失败退出（单实例锁）
 *   S10 自己给自己发的消息（user_id === self_id）被忽略
 *
 * 跑法：node test-e2e-shadow.mjs
 */

import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import {
  mkdtempSync, cpSync, copyFileSync, readFileSync, existsSync, rmSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3998);
const FAKE_SELF = 10000001;
const ADMIN = 20000002;
const STRANGER = 33333333;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 搭影子目录 ──────────────────────────────────────────────────────────
const shadow = mkdtempSync(join(tmpdir(), "qqbot-e2e-"));
for (const f of ["bridge.mjs", "vision.mjs", "voice.mjs", "diary-gen.mjs", "acp-client.mjs", "model.json", "memory.md"]) {
  if (existsSync(join(__dirname, f))) copyFileSync(join(__dirname, f), join(shadow, f));
}
mkdirSync(join(shadow, "node_modules"), { recursive: true });
cpSync(join(__dirname, "node_modules", "ws"), join(shadow, "node_modules", "ws"), { recursive: true });
cpSync(join(__dirname, "vendor"), join(shadow, "vendor"), { recursive: true });
mkdirSync(join(shadow, "stickers"), { recursive: true });
if (existsSync(join(__dirname, "stickers", "index.json"))) {
  copyFileSync(join(__dirname, "stickers", "index.json"), join(shadow, "stickers", "index.json"));
}
console.log(`[e2e] 影子目录：${shadow}`);

// ── mock NapCat ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
const sent = []; // bridge 回发的 send_private_msg 文本
let bridgeWs = null;

wss.on("connection", (ws) => {
  bridgeWs = ws;
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.action === "send_private_msg") {
      sent.push({ user_id: msg.params?.user_id, text: String(msg.params?.message ?? "") });
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: msg.echo }));
    } else if (msg.action) {
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: {}, echo: msg.echo }));
    }
  });
});

function pushMsg(userId, text, messageId) {
  bridgeWs.send(JSON.stringify({
    post_type: "message", message_type: "private", sub_type: "friend",
    time: Math.floor(Date.now() / 1000), self_id: FAKE_SELF, user_id: userId,
    message_id: messageId ?? Math.floor(Math.random() * 1e9),
    message: [{ type: "text", data: { text } }], raw_message: text, font: 0,
    sender: { user_id: userId, nickname: "测试", sex: "unknown" },
  }));
}

// ── bridge 生命周期 ─────────────────────────────────────────────────────
let child = null;
function startBridge() {
  child = spawn(process.execPath, [join(shadow, "bridge.mjs")], {
    cwd: shadow,
    env: {
      ...process.env,
      NAPCAT_WS: `ws://127.0.0.1:${PORT}`,
      ALLOW_FROM: String(ADMIN),
      SELFCHECK: "0",
      VOICE_AUTO: "0",          // 不开自动语音，避免真调 TTS
      PROACTIVE_ENABLED: "0",
      QZONE_ENABLED: "0",
      DIARY_ENABLED: "0",
      MIN_GAP_MS: "50",         // 测试节奏快，把节流调小
      HISTORY_RESTORE: "0",
      DIARY_IN_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => console.log(`[bridge-err] ${String(d).trim().slice(0, 120)}`));
}

async function waitConnected(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (bridgeWs && bridgeWs.readyState === 1) return true;
    await sleep(200);
  }
  return false;
}

async function killBridge() {
  if (!child) return;
  const pid = child.pid;
  child = null;
  bridgeWs = null;
  try { process.kill(pid); } catch {}
  await sleep(800);
}

async function waitReplies(n, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sent.length >= n) return true;
    await sleep(150);
  }
  return false;
}

async function main() {
  startBridge();
  if (!(await waitConnected())) {
    check("影子 bridge 连上 mock NapCat", false, "15 秒未连接");
    return finish(1);
  }
  check("影子 bridge 连上 mock NapCat", true);
  await sleep(500);

  // S1 #语音 状态
  pushMsg(ADMIN, "#语音");
  await waitReplies(1);
  check("S1 #语音 有回复", sent.length >= 1, sent[0]?.text.slice(0, 30));
  check("S1 回复里是语音状态", /自动语音/.test(sent[0]?.text ?? ""), sent[0]?.text?.split("\n")[0]);

  // S2 #语音 关 → 落盘
  pushMsg(ADMIN, "#语音 关");
  await waitReplies(2);
  await sleep(400);
  const muteFile = join(shadow, ".run", "voice-mute.json");
  let muteOk = false;
  try {
    const v = JSON.parse(readFileSync(muteFile, "utf8"));
    const arr = Array.isArray(v) ? v : v.muted ?? [];
    muteOk = arr.map(String).includes(String(ADMIN));
  } catch {}
  check("S2 #语音 关 有确认回复", /已静音/.test(sent[1]?.text ?? ""), sent[1]?.text?.slice(0, 30));
  check("S2 静音落盘含该用户", muteOk, existsSync(muteFile) ? readFileSync(muteFile, "utf8").slice(0, 80) : "文件不存在");

  // S3 跨重启持久化：杀掉重开
  await killBridge();
  startBridge();
  if (!(await waitConnected())) {
    check("S3 重启后重连", false);
    return finish(1);
  }
  await sleep(500);
  const nBefore = sent.length;
  pushMsg(ADMIN, "#语音");
  await waitReplies(nBefore + 1);
  const afterReboot = sent[sent.length - 1]?.text ?? "";
  check("S3 重启后 #语音 仍显示静音中", /静音中/.test(afterReboot), afterReboot.split("\n")[0]);

  // S4 #语音 开
  pushMsg(ADMIN, "#语音 开");
  await waitReplies(sent.length + 1);
  check("S4 #语音 开 有确认回复", /已恢复/.test(sent[sent.length - 1]?.text ?? ""), sent[sent.length - 1]?.text?.slice(0, 30));
  let muteCleared = true;
  try {
    const v = JSON.parse(readFileSync(muteFile, "utf8"));
    const arr = Array.isArray(v) ? v : v.muted ?? [];
    muteCleared = !arr.map(String).includes(String(ADMIN));
  } catch {}
  check("S4 落盘里该用户已移除", muteCleared);

  // S5 同一 message_id 重投（一级去重）
  await sleep(3200); // 先避开二级去重窗口
  const dupId = 987654321;
  const n5 = sent.length;
  pushMsg(ADMIN, "#状态", dupId);
  pushMsg(ADMIN, "#状态", dupId); // 同 id 重投
  await waitReplies(n5 + 1);
  await sleep(2500); // 等一个「如果漏防会多出来」的回复
  const s5got = sent.length - n5;
  check("S5 同一 message_id 重投只回一次", s5got === 1, `回了 ${s5got} 条`);

  // S6 3 秒内同文本（不同 id）重发（二级去重）
  const n6 = sent.length;
  pushMsg(ADMIN, "#帮助");
  pushMsg(ADMIN, "#帮助");
  await waitReplies(n6 + 1);
  await sleep(2500);
  const s6got = sent.length - n6;
  check("S6 3 秒内同文本重发只回一次", s6got === 1, `回了 ${s6got} 条`);

  // S7 非白名单
  await sleep(3200);
  const n7 = sent.length;
  pushMsg(STRANGER, "#状态");
  pushMsg(STRANGER, "在吗");
  await sleep(2500);
  check("S7 非白名单完全不回", sent.length === n7, `新增 ${sent.length - n7} 条`);

  // S8 坏模型名被拒，model.json 不变
  const modelBefore = readFileSync(join(shadow, "model.json"), "utf8");
  pushMsg(ADMIN, "#模型 不存在的模型xyz");
  await waitReplies(sent.length + 1);
  check("S8 坏模型名被拒绝", /没找到/.test(sent[sent.length - 1]?.text ?? ""), sent[sent.length - 1]?.text?.slice(0, 30));
  check("S8 model.json 未被改", readFileSync(join(shadow, "model.json"), "utf8") === modelBefore);

  // S9 影子内双开：第二个实例应自己退出
  const second = spawn(process.execPath, [join(shadow, "bridge.mjs")], {
    cwd: shadow,
    env: { ...process.env, NAPCAT_WS: `ws://127.0.0.1:${PORT}`, ALLOW_FROM: String(ADMIN), SELFCHECK: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let secondErr = "";
  second.stderr.on("data", (d) => (secondErr += d));
  const secondExit = await new Promise((r) => {
    const to = setTimeout(() => r(null), 10000);
    second.on("exit", (code) => { clearTimeout(to); r(code); });
  });
  check("S9 第二实例拿锁失败自己退出", secondExit === 1, `exit=${secondExit} ${/已有一个 bridge/.test(secondErr) ? "（有 FATAL 提示）" : ""}`);

  // S10 自发消息忽略（user_id === self_id）
  await sleep(3200);
  const n10 = sent.length;
  pushMsg(FAKE_SELF, "#状态");
  await sleep(2000);
  check("S10 user_id==self_id 被忽略", sent.length === n10);

  return finish(checks.some((c) => !c.ok) ? 1 : 0);
}

function finish(code) {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e] ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) console.log("[e2e] 失败项：" + failed.map((f) => f.name).join("；"));
  try { child?.kill(); } catch {}
  try { wss.close(); } catch {}
  try { rmSync(shadow, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => finish(2));
setTimeout(() => { console.log("[e2e] 总超时退出"); finish(2); }, 120000);

main().catch((e) => { console.log("[e2e] 异常：", e.message); finish(1); });
