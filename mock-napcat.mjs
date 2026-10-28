#!/usr/bin/env node
/**
 * 假 NapCat：模拟 OneBot 11 正向 WebSocket 服务端
 * 用途：在没有 QQ 登录的情况下验证 bridge.mjs 的收发逻辑是否真的通
 *
 * 跑法：
 *   node mock-napcat.mjs          # 监听 3001，等 bridge 连上
 *   另开窗口：node bridge.mjs
 *   本脚本会推一条私聊消息，并打印 bridge 回发的 send_private_msg
 */

import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3001);
const FAKE_SELF = 10000001; // 假机器人 QQ
const FAKE_USER = 20000002; // 假好友 QQ

const wss = new WebSocketServer({ port: PORT });
console.log(`[mock] 监听 ws://127.0.0.1:${PORT}`);

wss.on("connection", (ws) => {
  console.log("[mock] bridge 已连接");

  // 1. 先发生命周期事件，告诉它机器人 QQ 号
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
    console.log("[mock] 已发送 lifecycle 事件");
  }, 300);

  // 2. 推一条私聊消息
  setTimeout(() => {
    const evt = {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      time: Math.floor(Date.now() / 1000),
      self_id: FAKE_SELF,
      user_id: FAKE_USER,
      message_id: 9001,
      message: [{ type: "text", data: { text: "在吗？说句话我听听" } }],
      raw_message: "在吗？说句话我听听",
      font: 0,
      sender: { user_id: FAKE_USER, nickname: "测试好友", sex: "unknown" },
    };
    ws.send(JSON.stringify(evt));
    console.log(`[mock] 已推送私聊消息: ${evt.raw_message}`);
  }, 6000);

  // 3. 收 bridge 的 API 调用
  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.action === "send_private_msg") {
      console.log("\n===== 收到 bridge 的回发 =====");
      console.log("action :", msg.action);
      console.log("user_id:", msg.params.user_id);
      console.log("message:\n" + msg.params.message);
      console.log("==============================\n");
      // 回执，让 bridge 的 Promise resolve
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 9002 }, echo: msg.echo }));
      setTimeout(() => {
        console.log("[mock] 测试完成，退出");
        process.exit(0);
      }, 500);
    }
  });
});

// 兜底超时
setTimeout(() => {
  console.log("[mock] 120 秒内没收到回发，超时退出");
  process.exit(1);
}, 120000);
