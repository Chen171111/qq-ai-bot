#!/usr/bin/env node
/**
 * 给 @deepseek-ai/dsh 的启动器打「收尾后强制退出」补丁（幂等）。
 *
 * 背景（2026-10-27 实测）：
 *   dsh 的 createProcessShutdown() 在正常收尾时只做两件事：
 *       dispose()  →  complete(code)  →  process.exitCode = code
 *   然后指望事件循环自己排空、进程自己退。但插件层会残留句柄，
 *   实测挂住的进程里有 ~60 个 FSEventWrap(inotify)、3 个 TCPServerWrap、
 *   1 个到模型网关的 TLSSocket —— 任何一个 residue 都能让进程永不退出。
 *
 *   而那条「5 秒后强制退出」的定时器只在 dispose 还没结束时有用：
 *   dispose 一 resolve，completeOnce() 就先 clearExitTimeout() 把它清掉了。
 *   于是答案早就写进 stdout，进程却挂到外层 150 秒硬超时。
 *
 *   修法：completeOnce() 之后补一次 1 秒兜底强制退出。dispose 已经跑完，
 *   该关的都关过了，这 1 秒只是给剩余 stdout 写入留余量。
 *
 * 用途：dsh 升级会覆盖 node_modules，届时跑一次本脚本即可恢复。
 *   node patch-dsh-force-exit.mjs          # 打补丁（已打过则跳过）
 *   node patch-dsh-force-exit.mjs --check  # 只检查状态
 *   node patch-dsh-force-exit.mjs --revert # 从备份还原
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MARK = "dsh-force-exit";
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

function findTarget() {
  const candidates = [
    join(homedir(), ".dsh-runtime", "node_modules", "@deepseek-ai", "dsh", "lib"),
    join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib"),
  ];
  const profRoot = join(DSH_HOME, "profiles");
  if (existsSync(profRoot)) {
    for (const name of readdirSync(profRoot)) {
      candidates.push(join(profRoot, name, "node_modules", "@deepseek-ai", "dsh", "lib"));
    }
  }
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    // 文件名带内容哈希（profile-boot-C14i-8IN.js），升级会变，所以按前缀找
    const hit = readdirSync(dir).find((f) => /^profile-boot-.*\.js$/.test(f));
    if (hit) return join(dir, hit);
  }
  return null;
}

const target = findTarget();
if (!target) {
  console.error("找不到 @deepseek-ai/dsh/lib/profile-boot-*.js，dsh 可能没装在这里");
  process.exit(1);
}

const src = readFileSync(target, "utf8");
const patched = src.includes(MARK);
const bak = `${target}.bak-force-exit`;

if (process.argv.includes("--check")) {
  console.log(`目标: ${target}`);
  console.log(patched ? "状态: 已打补丁" : "状态: 未打补丁");
  console.log(`备份: ${existsSync(bak) ? bak : "（无）"}`);
  process.exit(patched ? 0 : 1);
}

if (process.argv.includes("--revert")) {
  if (!existsSync(bak)) {
    console.error(`没有备份 ${bak}，无法还原`);
    process.exit(1);
  }
  copyFileSync(bak, target);
  console.log(`已还原: ${target}`);
  process.exit(0);
}

if (patched) {
  console.log(`已打过补丁，跳过: ${target}`);
  process.exit(0);
}

// 三个锚点都必须在源码里各出现一次，否则说明 dsh 版本变了，宁可报错也不乱改
const anchors = [
  "if (pending !== void 0) return pending;",
  "forceExit(code);",
  "complete(code);",
];
for (const a of anchors) {
  const n = src.split(a).length - 1;
  if (n !== 1) {
    console.error(`锚点「${a}」在 ${target} 里出现 ${n} 次（期望 1 次），dsh 版本可能变了，停止打补丁`);
    process.exit(1);
  }
}

let out = src;
out = out.replace(
  "if (pending !== void 0) return pending;",
  'if (pending !== void 0) return pending;\n\t\tif (process.env.DSH_EXIT_TRACE === "1") process.stderr.write(`[exit-trace] 开始收尾 code=${code} force=${forceAfterDispose}\\n`);'
);
out = out.replace(
  "forceExit(code);",
  'if (process.env.DSH_EXIT_TRACE === "1") process.stderr.write(`[exit-trace] 强制退出 code=${code}\\n`);\n\t\tforceExit(code);'
);
out = out.replace(
  "complete(code);",
  [
    "complete(code);",
    `\t\t// ${MARK}（2026-10-27）：dispose 完成后只设 exitCode，靠事件循环自然排空。`,
    "\t\t// 插件残留 inotify / 监听端口 / 模型连接时永远不会退，这里兜底 1 秒后强制退出。",
    '\t\tif (process.env.DSH_EXIT_TRACE === "1") process.stderr.write(`[exit-trace] dispose 完成，设 exitCode=${code}，1 秒后强制退出\\n`);',
    "\t\tsetTimeout(() => process.exit(code), 1000);",
  ].join("\n")
);

copyFileSync(target, bak);
writeFileSync(target, out, "utf8");
console.log(`已打补丁: ${target}`);
console.log(`备份    : ${bak}`);
