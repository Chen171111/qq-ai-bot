#!/usr/bin/env node
/**
 * 给 dsh-providers-hub 的 OpenAI SSE 消费器补「收尾时取消响应体」（幂等）。
 *
 * 背景（2026-10-27 实测）：
 *   openai-compat.js 的 SSE 读取循环收到 `data: [DONE]` 后直接 break，
 *   finally 里只 reader.releaseLock()，没有 reader.cancel()。
 *   releaseLock() 不关闭响应体 —— 上游若在 [DONE] 后仍保持连接，
 *   undici 会把这条 keep-alive 连接一直挂在事件循环上（ref'd TCPSocketWrap），
 *   dsh 收尾后进程永不退出。
 *
 *   实测（未修）：34 次里挂死 6 次（~18%）；确定性用例显示 [DONE] 后 bodyCancel=false。
 *   修复后：同一用例 bodyCancel=true，隔离环境 15/15 自然退出。
 *
 * 用途：profile 依赖重装会覆盖本文件，届时跑一次即可恢复。
 *   node patch-dsh-sse-cancel.mjs          # 打补丁（已打过则跳过）
 *   node patch-dsh-sse-cancel.mjs --check  # 只检查状态
 *   node patch-dsh-sse-cancel.mjs --revert # 从备份还原
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MARK = "dsh-sse-body-cancel";
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

function findTargets() {
  const out = [];
  const profRoot = join(DSH_HOME, "profiles");
  if (existsSync(profRoot)) {
    for (const name of readdirSync(profRoot)) {
      const p = join(profRoot, name, "node_modules", "dsh-providers-hub", "lib", "openai-compat.js");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

const targets = findTargets();
if (targets.length === 0) {
  console.error("找不到 dsh-providers-hub/lib/openai-compat.js，providers-hub 可能没装");
  process.exit(1);
}

const ANCHOR = "    finally {\n        reader.releaseLock();\n    }";
const PATCHED = [
  "    finally {",
  `        // ${MARK}（2026-10-27）：收到 [DONE] 提前退出时，仅 releaseLock() 不会关闭响应体；`,
  "        // 上游若不断开，undici 会把这条 keep-alive 连接挂在事件循环上，导致进程收尾后永不退出。",
  "        // 对已读完的流 cancel() 是无害空操作。",
  "        await reader.cancel().catch(() => { });",
  "        reader.releaseLock();",
  "    }",
].join("\n");

let code = 0;
for (const target of targets) {
  const src = readFileSync(target, "utf8");
  const patched = src.includes(MARK);
  const bak = `${target}.bak-sse-cancel`;

  if (process.argv.includes("--check")) {
    console.log(`${target}: ${patched ? "已打补丁" : "未打补丁"}`);
    if (!patched) code = 1;
    continue;
  }
  if (process.argv.includes("--revert")) {
    if (!existsSync(bak)) {
      console.error(`${target}: 没有备份 ${bak}，无法还原`);
      code = 1;
      continue;
    }
    copyFileSync(bak, target);
    console.log(`已还原: ${target}`);
    continue;
  }
  if (patched) {
    console.log(`已打过补丁，跳过: ${target}`);
    continue;
  }
  const n = src.split(ANCHOR).length - 1;
  if (n !== 1) {
    console.error(`锚点在 ${target} 里出现 ${n} 次（期望 1 次），版本可能变了，停止打补丁`);
    code = 1;
    continue;
  }
  copyFileSync(target, bak);
  writeFileSync(target, src.replace(ANCHOR, PATCHED), "utf8");
  console.log(`已打补丁: ${target}`);
  console.log(`备份    : ${bak}`);
}
process.exit(code);
