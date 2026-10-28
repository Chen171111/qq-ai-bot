#!/usr/bin/env node
/**
 * 一次性验收脚本：用假 NapCat 驱动 bridge.mjs 的「指令 / 模型配置」路径。
 *
 * 只测不烧积分、不依赖 dsh 的部分：
 *   #模型 → #模型 workbuddy-ai:hy3 → #状态 → #模型 auto
 * 每条都要看到 bridge 真的回发 send_private_msg，并且 model.json 真的变了。
 *
 * 跑法：node test-bridge-cmds.mjs
 * 监听 3999，不会碰正在跑的 3001。
 */

import { WebSocketServer } from "ws";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3999);
const FAKE_SELF = 10000001;
const FAKE_USER = 20000002;
const MODEL_CFG = join(__dirname, "model.json");

const wss = new WebSocketServer({ port: PORT });
console.log(`[test] mock NapCat 监听 ws://127.0.0.1:${PORT}`);

const sent = [];

wss.on("connection", (ws) => {
  console.log("[test] bridge 已连接");

  setTimeout(() => {
    ws.send(
      JSON.stringify({
        post_type: "meta_event",
        meta_event_type: "lifecycle",
        sub_type: "connect",
        time: Math.floor(Date.now() / 1000),
        self_id: FAKE_SELF,
      })
    );
  }, 300);

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.action === "send_private_msg") {
      const text = msg.params.message;
      sent.push(text);
      console.log("\n===== bridge 回发 =====");
      console.log(text);
      console.log("=======================\n");
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: msg.echo }));
    }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function push(ws, text) {
  ws.send(
    JSON.stringify({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      time: Math.floor(Date.now() / 1000),
      self_id: FAKE_SELF,
      user_id: FAKE_USER,
      message_id: Math.floor(Math.random() * 1e6),
      message: [{ type: "text", data: { text } }],
      raw_message: text,
      font: 0,
      sender: { user_id: FAKE_USER, nickname: "测试", sex: "unknown" },
    })
  );
  console.log(`[test] 发送：${text}`);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function readCfg() {
  try {
    return JSON.parse(readFileSync(MODEL_CFG, "utf8"));
  } catch {
    return null;
  }
}

wss.on("connection", async (ws) => {
  await sleep(1500);
  const before = readCfg();

  // 1. #模型 —— 应该列出当前模型，且不调用 dsh
  const n0 = sent.length;
  push(ws, "#模型");
  await sleep(3000);
  check("收到 #模型 的回复", sent.length > n0, `回发 ${sent.length - n0} 条`);
  check("#模型 回复里带当前模型", /当前[:：]/.test(sent[sent.length - 1] ?? ""), (sent[sent.length - 1] ?? "").slice(0, 40));

  // 2. 切换
  push(ws, "#模型 workbuddy-ai:hy3");
  await sleep(3000);
  const after = readCfg();
  check(
    "切换后 model.json 变成 workbuddy-ai/hy3",
    after?.provider === "workbuddy-ai" && after?.model === "hy3",
    JSON.stringify(after)
  );
  check("切换回复里报倍率", /x0\.00|免费/.test(sent[sent.length - 1] ?? ""), (sent[sent.length - 1] ?? "").slice(0, 60));

  // 3. #状态
  push(ws, "#状态");
  await sleep(2500);
  check("#状态 回复里带降级链", /降级链/.test(sent[sent.length - 1] ?? ""), (sent[sent.length - 1] ?? "").slice(0, 60));

  // 4. 坏名字要被拒
  push(ws, "#模型 不存在的模型xyz");
  await sleep(2500);
  check("坏模型名被拒绝", /没找到/.test(sent[sent.length - 1] ?? ""), (sent[sent.length - 1] ?? "").slice(0, 60));

  // 4.5 档位：先切回主模型（它支持 low/high/max），再调 max
  push(ws, "#模型 workbuddy:deepseek-v4.1-flash");
  await sleep(2500);
  push(ws, "#模型 effort max");
  await sleep(2500);
  const effCfg = readCfg();
  check(
    "支持 max 的模型能调成 max",
    effCfg?.reasoningEffort === "max" && effCfg?.model === "deepseek-v4.1-flash",
    JSON.stringify(effCfg)
  );

  // 4.6 档位：非法值要被拒
  push(ws, "#模型 effort 乱写");
  await sleep(2000);
  check("非法档位被拒绝", /档位只能是/.test(sent[sent.length - 1] ?? ""), (sent[sent.length - 1] ?? "").slice(0, 50));

  // 4.7 不支持的档位要被拒（space-bunny 声明了全档位，hy4-preview 只支持 high）
  push(ws, "#模型 workbuddy:hy4-preview");
  await sleep(2500);
  push(ws, "#模型 effort low");
  await sleep(2500);
  check(
    "hy4-preview 拒绝 low 档",
    /不支持 low/.test(sent[sent.length - 1] ?? ""),
    (sent[sent.length - 1] ?? "").slice(0, 60)
  );

  // 4.8 没声明档位的模型：要「写入 + 明确警告」，不能假装成功
  push(ws, "#模型 workbuddy:hy3");
  await sleep(2500);
  const nBefore = sent.length;
  push(ws, "#模型 effort low");
  await sleep(3000);
  const newMsgs = sent.slice(nBefore).join("\n");
  check(
    "未声明档位的模型会明确警告",
    /没有声明支持的档位/.test(newMsgs),
    newMsgs.slice(0, 80)
  );

  // 5. auto 恢复
  push(ws, "#模型 auto");
  await sleep(3000);
  const restored = readCfg();
  check(
    "auto 恢复默认（含档位）",
    restored?.provider === before?.provider &&
      restored?.model === before?.model &&
      restored?.reasoningEffort === "low",
    JSON.stringify(restored)
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[test] ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) console.log("[test] 失败项：", failed.map((f) => f.name).join("；"));

  wss.close();
  process.exit(failed.length ? 1 : 0);
});

setTimeout(() => {
  console.log("[test] 超时退出");
  process.exit(2);
}, 60000);
