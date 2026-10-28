#!/usr/bin/env node
/**
 * 给 @deepseek-ai/dsh-headless 打「视觉直传」补丁（幂等）。
 *
 * 背景（2026-10-19 实测）：
 *   dsh 全链路本来就能送图 —— 下游 pi-ai 适配器完整实现了 image 内容块
 *   （contentHasImage / userContent 的 image 分支 / offloadRequestImagesWithPolicy），
 *   唯一缺口是 headless 这个一次性驱动把 prompt 写死成纯文本块：
 *       content: [{ type: "text", text: task }]
 *   所以无论传什么，模型永远只收到文字。改这 3 处即可打通：
 *       ① 引入 fs/path
 *       ② 新增 buildContent()：读 DSH_EXP_IMAGES 清单 + [[img:路径]] 标记，
 *          经 ctx.attachments.admitPromptContent() 转成持久附件引用
 *       ③ followup 的 content 换成 await buildContent(ctx, task)
 *
 * 用途：dsh 升级会覆盖 node_modules，届时跑一次本脚本即可恢复。
 *   node patch-headless-vision.mjs          # 打补丁（已打过则跳过）
 *   node patch-headless-vision.mjs --check  # 只检查状态
 *   node patch-headless-vision.mjs --revert # 从备份还原
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const MARK = "[EXP] vision";
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

function findTarget() {
  // profile 里的 node_modules 优先（实际加载的就是它）
  const candidates = [
    join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh-headless", "lib", "index.js"),
    // dsh 全局安装时 bundle 实体在 runtime 里（profile 里的 node_modules 可能只是指向旧 .pnpm 的悬空链接）
    join(homedir(), ".dsh-runtime", "node_modules", "@deepseek-ai", "dsh-headless", "lib", "index.js"),
  ];
  // 兜底：profiles/*/node_modules 下逐个找
  const profRoot = join(DSH_HOME, "profiles");
  if (existsSync(profRoot)) {
    for (const name of readdirSync(profRoot)) {
      candidates.push(join(profRoot, name, "node_modules", "@deepseek-ai", "dsh-headless", "lib", "index.js"));
    }
  }

  // 2026-10-23 补：dsh-headless 现在由 pnpm 装在 .dsh-runtime/.pnpm 里，
  // 上面两条路径都找不到它 —— 表现为「--check 说找不到」，
  // 而实际加载的是 .pnpm 里那份（未打补丁 ⇒ 视觉直传失效 ⇒ 模型只看到 [图片] 文字）。
  // 这里把 pnpm 的虚拟存储也扫一遍。
  const pnpmRoots = [
    join(homedir(), ".dsh-runtime", "node_modules", ".pnpm"),
    join(DSH_HOME, "profiles", ".pnpm"),
  ];
  for (const root of pnpmRoots) {
    if (!existsSync(root)) continue;
    try {
      for (const dir of readdirSync(root)) {
        if (!dir.startsWith("@deepseek-ai+dsh-headless@")) continue;
        candidates.push(join(root, dir, "node_modules", "@deepseek-ai", "dsh-headless", "lib", "index.js"));
      }
    } catch {
      /* 读不了就跳过 */
    }
  }

  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

const IMPORT_OLD = `import { randomUUID } from "node:crypto";`;
const IMPORT_NEW = `import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";`;

const BUILD_CONTENT = `/**
 * ${MARK}: turn image references into admitted image content parts.
 * Sources, in order: the [[img:<abs path>]] markers inside the task text, then
 * the JSON array of absolute paths named by DSH_EXP_IMAGES. The marker and the
 * list keep paths off the shell command line, which on Windows is the only
 * reliable way to pass them.
 */
const IMG_MARKER = /\\[\\[img:([^\\]]+)\\]\\]/g;
const MEDIA_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

async function buildContent(ctx, task) {
	const paths = [...task.matchAll(IMG_MARKER)].map((m) => m[1].trim());
	const listFile = process.env.DSH_EXP_IMAGES;
	if (listFile !== void 0 && listFile !== "") {
		try {
			const fromFile = JSON.parse(readFileSync(listFile, "utf8"));
			if (Array.isArray(fromFile)) for (const p of fromFile) if (typeof p === "string" && p.trim() !== "") paths.push(p.trim());
		} catch (e) {
			process.stderr.write(\`${MARK}: cannot read DSH_EXP_IMAGES (\${listFile}): \${String(e && e.message)}\\n\`);
		}
	}
	const text = task.replace(IMG_MARKER, "").trim();
	const parts = [];
	if (paths.length > 0) {
		const store = ctx.get("attachments");
		if (store === void 0) throw new Error("${MARK}: attachments service unavailable");
		const encoded = paths.map((p) => {
			const mediaType = MEDIA_BY_EXT[extname(p).toLowerCase()];
			if (mediaType === void 0) throw new Error(\`${MARK}: unsupported image extension: \${p}\`);
			return { type: "image", mediaType, data: readFileSync(p).toString("base64"), name: basename(p) };
		});
		const admitted = await store.admitPromptContent(encoded);
		parts.push(...admitted);
	}
	if (text !== "") parts.push({ type: "text", text });
	if (parts.length === 0) parts.push({ type: "text", text: "" });
	return parts;
}
/**
* Run one task through a freshly created Agent and request process exit.`;

const RUN_OLD = `		agent.followup(createUserMessage({
			content: [{
				type: "text",
				text: task
			}],
			source: { kind: "user" }
		}));`;
const RUN_NEW = `		agent.followup(createUserMessage({
			content: await buildContent(ctx, task),
			source: { kind: "user" }
		}));`;

function status(src) {
  return {
    imported: src.includes('from "node:fs";') && src.includes('from "node:path";'),
    hasBuild: src.includes("async function buildContent(ctx, task)"),
    wired: src.includes("content: await buildContent(ctx, task)"),
  };
}

const arg = process.argv[2] || "";
const target = findTarget();
if (!target) {
  console.error("找不到 dsh-headless/lib/index.js —— DSH_HOME 是否正确？", DSH_HOME);
  process.exit(2);
}

let src = readFileSync(target, "utf8");
const st = status(src);
const done = st.imported && st.hasBuild && st.wired;

if (arg === "--check") {
  console.log(`目标: ${target}`);
  console.log(`  import   : ${st.imported ? "已打" : "未打"}`);
  console.log(`  buildContent: ${st.hasBuild ? "已打" : "未打"}`);
  console.log(`  接线     : ${st.wired ? "已打" : "未打"}`);
  console.log(done ? "=> 视觉直传已就绪" : "=> 需要打补丁：node patch-headless-vision.mjs");
  process.exit(done ? 0 : 1);
}

const bak = `${target}.bak-vision`;
if (arg === "--revert") {
  if (!existsSync(bak)) {
    console.error(`没有备份文件：${bak}`);
    process.exit(2);
  }
  copyFileSync(bak, target);
  console.log(`已还原：${target}`);
  process.exit(0);
}

if (done) {
  console.log(`已是打好状态，跳过。\n目标: ${target}`);
  process.exit(0);
}

// 备份（只在第一次备份时写，避免用已打补丁的版本覆盖 pristine 备份）
if (!existsSync(bak)) {
  copyFileSync(target, bak);
  console.log(`已备份 → ${bak}`);
}

const failures = [];
if (!st.imported) {
  if (!src.includes(IMPORT_OLD)) failures.push("import 锚点未找到");
  else src = src.replace(IMPORT_OLD, IMPORT_NEW);
}
if (!st.hasBuild) {
  // 2026-10-23 修：锚点原来写死 `/**\n* Run one task through a freshly created Agent...`，
  // 但 dsh 0.2.1-rc.2 里这句注释改成了「Run one task through one Agent」，于是永远失配。
  // 现在用宽松正则：找 `/**` + 含 "Run one task through" 的 JSDoc 块开头，把 BUILD_CONTENT 插在它前面。
  const anchorRe = /\/\*\*\s*\n\*\s*Run one task through[^\n]*\n/;
  const m = src.match(anchorRe);
  if (!m) {
    failures.push("buildContent 插入锚点未找到");
  } else {
    const at = m.index;
    src = src.slice(0, at) + BUILD_CONTENT + "\n" + src.slice(at);
  }
}
if (!st.wired) {
  // 2026-10-23 修：原来靠精确字符串（含缩进/换行）匹配，dsh 升级后缩进或空白一变就失配。
  // 改成正则：只锚定「agent.followup(createUserMessage({ ... content: [{ type:"text", text: task }] ... }))」
  // 这段结构，允许任意缩进与空白，且只替换 content 那一行。
  const wireRe =
    /(agent\.followup\(createUserMessage\(\{\s*\n\s*)content:\s*\[\s*\{\s*\n\s*type:\s*"text",\s*\n\s*text:\s*task\s*\n\s*\}\s*\],/;
  if (!wireRe.test(src)) {
    failures.push("followup 接线锚点未找到");
  } else {
    src = src.replace(wireRe, "$1content: await buildContent(ctx, task),");
  }
}

if (failures.length > 0) {
  console.error("补丁失败（dsh 版本可能已变，需人工核对）：");
  for (const f of failures) console.error("  - " + f);
  console.error(`目标文件: ${target}`);
  process.exit(3);
}

writeFileSync(target, src, "utf8");
const after = status(src);
if (!(after.imported && after.hasBuild && after.wired)) {
  console.error("写入后自检未通过，请检查文件");
  process.exit(4);
}
console.log(`补丁完成：${target}`);
console.log("验证：node bridge.mjs --selftest");
