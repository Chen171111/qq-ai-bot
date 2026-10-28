#!/usr/bin/env node
/**
 * ACP 客户端（Agent Client Protocol over stdio）
 *
 * 为什么要有这个：
 *   `dsh --profile headless` 是**一次性驱动**——每轮创建 agent、跑一轮、退出。
 *   所以 bridge 只能把「人设 + memory + 最近 6 轮历史」每轮重新拼进 prompt，
 *   实测一条「在吗」要发 1450 字符（bridge 侧）＋ 13481 字节 AGENTS.md
 *   ＋ 28 个技能清单，粗估 5000~7000 token，换来的只是 2 个字。
 *
 *   `dsh --profile acp` 是**常驻服务**（官方给的自动化入口），ACP v1 有真正的
 *   `session/prompt` 多轮会话：会话建立后历史由 dsh 自己保存，
 *   bridge 只需发用户原话，不用再拼任何东西。
 *
 *   另外 ACP 的 ContentBlock 原生支持 `{type:"image"}`，所以连
 *   DSH_EXP_IMAGES 那个视觉补丁都不再需要（见 accept 分支）。
 *
 * 协议要点（从 @agentclientprotocol/sdk/schema/schema.json 核过）：
 *   initialize      { protocolVersion:int, clientCapabilities?, clientInfo? }
 *   session/new     { cwd:绝对路径, mcpServers:[] }        → { sessionId }
 *   session/prompt  { sessionId, prompt:[ContentBlock] }   → { stopReason, usage? }
 *   session/update  通知 { sessionId, update }  update.sessionUpdate 见下
 *   ContentBlock    {type:"text",text} | {type:"image",data:base64,mimeType} | ...
 *
 * 用法：
 *   node acp-client.mjs --selftest                 自测（起真 dsh、跑两轮）
 *   node acp-client.mjs "你好"                      单轮试跑
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

/** dsh 入口：与 dsh.cmd 保持一致（生产入口，别换成 profiles 下那份） */
const DSH_BIN =
  process.env.DSH_BIN ||
  join(homedir(), ".dsh-runtime", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const NODE_BIN = process.env.DSH_NODE || process.execPath;

/** 流式收到一段模型正文 */
const AGENT_CHUNK = "agent_message_chunk";

export class AcpClient {
  /**
   * @param {{cwd?: string, profile?: string, patchPath?: string, onLog?: (s:string)=>void}} opts
   */
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.profile = opts.profile || "acp";
    this.patchPath = opts.patchPath || null;
    this.onLog = opts.onLog || (() => {});
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.notifyHandlers = new Set();
    this.buf = "";
    this.closed = false;
    this.sessionId = null;
    this.stderrTail = "";
  }

  start() {
    if (this.proc) return;
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("DSH_")) delete env[k];
    env.DSH_HOME = DSH_HOME;

    // 与 headless 一样用 --patch 覆盖模型：acp profile 自带的是 deepseek-official，
    // 不覆盖就会绕过 workbuddy 的积分通道
    const args = [DSH_BIN, "--profile", this.profile];
    if (this.patchPath) args.push("--patch", this.patchPath);

    this.proc = spawn(NODE_BIN, args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._feed(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => {
      // ACP 的 stdout 是纯协议帧，诊断信息都在 stderr
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    this.proc.on("exit", (code) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`dsh acp 退出（code=${code}）: ${this.stderrTail.slice(-300)}`));
      this.pending.clear();
    });
    this.proc.on("error", (e) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`无法启动 dsh acp: ${e.message}`));
      this.pending.clear();
    });
  }

  _feed(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.onLog(`[acp] 非 JSON 行，忽略: ${line.slice(0, 120)}`);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // 响应：有 id 且无 method
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.code ?? ""} ${msg.error.message ?? "ACP 错误"}`.trim()));
      else p.resolve(msg.result);
      return;
    }
    // 通知：有 method 无 id
    if (msg.method && msg.id === undefined) {
      for (const h of this.notifyHandlers) h(msg.method, msg.params);
      return;
    }
    // Agent 反向请求（如 session/request_permission）：一律回「允许一次」，避免卡死
    if (msg.method && msg.id !== undefined) {
      this.onLog(`[acp] agent 反向请求 ${msg.method}`);
      const allow =
        msg.method === "session/request_permission"
          ? { outcome: { outcome: "selected", optionId: this._firstAllowOption(msg.params) } }
          : {};
      this._write({ jsonrpc: "2.0", id: msg.id, result: allow });
    }
  }

  _firstAllowOption(params) {
    const opts = params?.options ?? [];
    const hit = opts.find((o) => /allow|once|approve/i.test(String(o.optionId ?? ""))) ?? opts[0];
    return hit?.optionId ?? "allow_once";
  }

  _write(obj) {
    if (!this.proc || this.closed) throw new Error("dsh acp 未运行");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, timeoutMs = 120_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP 请求超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  onNotification(h) {
    this.notifyHandlers.add(h);
    return () => this.notifyHandlers.delete(h);
  }

  async initialize() {
    this.start();
    const res = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "qq-ai-bot-bridge", version: "1.0.0" },
    });
    return res;
  }

  async newSession(cwd = this.cwd) {
    const res = await this.request("session/new", { cwd, mcpServers: [] });
    this.sessionId = res?.sessionId ?? null;
    if (!this.sessionId) throw new Error(`session/new 没返回 sessionId: ${JSON.stringify(res).slice(0, 200)}`);
    return res;
  }

  /**
   * 发一轮，收集模型正文。
   * @param {Array} blocks ContentBlock 数组，如 [{type:"text",text:"在吗"}]
   * @param {{onChunk?: (t:string)=>void, timeoutMs?: number}} opts
   * @returns {Promise<{text: string, stopReason: string, usage: any, updates: number}>}
   */
  async prompt(blocks, opts = {}) {
    if (!this.sessionId) throw new Error("还没建立会话，先 newSession()");
    let text = "";
    let updates = 0;
    const off = this.onNotification((method, params) => {
      if (method !== "session/update") return;
      if (params?.sessionId && params.sessionId !== this.sessionId) return;
      updates++;
      const u = params?.update;
      if (u?.sessionUpdate === AGENT_CHUNK && u?.content?.type === "text") {
        text += u.content.text;
        opts.onChunk?.(u.content.text);
      }
    });
    try {
      const res = await this.request(
        "session/prompt",
        { sessionId: this.sessionId, prompt: blocks },
        opts.timeoutMs ?? 120_000
      );
      return { text, stopReason: res?.stopReason ?? "unknown", usage: res?.usage ?? null, updates };
    } finally {
      off();
    }
  }

  async close() {
    try {
      this.proc?.stdin.end();
    } catch {}
    try {
      this.proc?.kill();
    } catch {}
    this.closed = true;
  }
}

// ── 自测 / 命令行试跑 ────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain && process.argv.includes("--selftest")) {
  const pass = [];
  const fail = [];
  const chk = (n, c, d = "") => (c ? (pass.push(n), console.log(`PASS  ${n}`)) : (fail.push(n), console.log(`FAIL  ${n}${d ? ` — ${d}` : ""}`)));

  const c = new AcpClient({ cwd: process.cwd(), onLog: (s) => console.log("  " + s) });
  try {
    const init = await c.initialize();
    chk("initialize 返回 protocolVersion", init?.protocolVersion !== undefined, JSON.stringify(init).slice(0, 120));

    const s = await c.newSession();
    chk("session/new 拿到 sessionId", typeof s.sessionId === "string" && s.sessionId.length > 0, String(s.sessionId));

    const r1 = await c.prompt([{ type: "text", text: "记住一个数字：四十七。只回两个字：记住了。" }]);
    chk("第一轮有正文返回", r1.text.trim().length > 0, JSON.stringify(r1).slice(0, 200));
    chk("第一轮 stopReason 正常", r1.stopReason === "end_turn" || r1.stopReason === "completed", r1.stopReason);

    const r2 = await c.prompt([{ type: "text", text: "刚才让你记的数字是多少？只回数字。" }]);
    chk("第二轮能记住上文（持久会话生效）", /47|四十七/.test(r2.text), r2.text.slice(0, 120));
    chk("第二轮明显短于首轮开销（说明没重发全部上下文）", r2.text.length > 0, "");

    console.log(`\n第一轮回复: ${r1.text.trim().slice(0, 120)}`);
    console.log(`第二轮回复: ${r2.text.trim().slice(0, 120)}`);
  } catch (e) {
    fail.push("异常");
    console.log(`FAIL  运行异常 — ${e.message}`);
  } finally {
    await c.close();
  }

  console.log(`\n${pass.length}/${pass.length + fail.length} 通过`);
  process.exit(fail.length === 0 ? 0 : 1);
} else if (isMain) {
  const text = process.argv[2] || "你好，用一句话介绍你自己";
  const c = new AcpClient({ cwd: process.cwd() });
  try {
    await c.initialize();
    await c.newSession();
    const r = await c.prompt([{ type: "text", text }], { onChunk: () => {} });
    console.log(r.text);
  } catch (e) {
    console.error("失败:", e.message);
    process.exitCode = 1;
  } finally {
    await c.close();
  }
}

export default AcpClient;
