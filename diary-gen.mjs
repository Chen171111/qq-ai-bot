#!/usr/bin/env node
/**
 * 把 diary/*.md 渲染成 diary/index.html —— 用浏览器看，比在 QQ 里翻长文舒服。
 *
 * 用法：
 *   node diary-gen.mjs          # 生成/更新 index.html
 *   之后双击 diary\index.html 就能看（不需要起服务、不联网）
 *
 * 每次写完日记会自动调一次（见 bridge.mjs 的 runDiary）。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "diary");
const OUT = join(DIR, "index.html");

/** 极简 Markdown → HTML（只处理我们自己写的这几种结构，不引依赖） */
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let para = [];

  const flush = () => {
    if (para.length) {
      out.push(`<p>${esc(para.join("")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (/^---+$/.test(line)) {
      flush();
      out.push(`<div class="divider" aria-hidden="true">＊</div>`);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      out.push(`<h2>${esc(line.replace(/^#{1,6}\s+/, ""))}</h2>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join("\n");
}

function prettyDate(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return name;
  const [, y, mo, d] = m;
  const week = ["日", "一", "二", "三", "四", "五", "六"][new Date(`${y}-${mo}-${d}T00:00:00`).getDay()];
  return { y, mo: String(Number(mo)), d: String(Number(d)), week };
}

function render() {
  if (!existsSync(DIR)) {
    console.log("diary/ 不存在，先写一篇日记吧");
    return;
  }
  const files = readdirSync(DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse(); // 新的在上面

  if (files.length === 0) {
    console.log("diary/ 里还没有日记");
    return;
  }

  const cards = files
    .map((f) => {
      const name = f.replace(/\.md$/, "");
      const info = prettyDate(name);
      const body = mdToHtml(readFileSync(join(DIR, f), "utf8").replace(/^#\s+.*$/m, ""));
      const dateStr = info.y
        ? `<span class="num">${info.mo}</span><span class="sep">/</span><span class="num">${info.d}</span>`
        : `<span class="num">${name}</span>`;
      return `
    <article class="entry">
      <header>
        <div class="date">${dateStr}</div>
        <div class="meta">${info.week ? `${info.y} 年 · 星期${info.week}` : ""}</div>
      </header>
      <div class="body">${body}</div>
    </article>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小玉的日记</title>
<style>
  :root{
    --paper:#f4efe4; --card:#fffdf7; --ink:#3a352c; --ink-soft:#8a8172;
    --line:#e2d9c6; --accent:#b0714f;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font-family:"Noto Serif SC","Source Han Serif SC",Georgia,"Songti SC","SimSun",serif;
    line-height:1.9; -webkit-font-smoothing:antialiased;
    background-image:radial-gradient(circle at 1px 1px, rgba(0,0,0,.035) 1px, transparent 0);
    background-size:22px 22px;
  }
  .wrap{max-width:680px; margin:0 auto; padding:56px 24px 96px}
  .title{
    text-align:center; margin:0 0 8px; font-size:26px; font-weight:500;
    letter-spacing:.28em; text-indent:.28em;
  }
  .subtitle{text-align:center; color:var(--ink-soft); font-size:13px; letter-spacing:.12em; margin-bottom:48px}
  .entry{
    background:var(--card); border:1px solid var(--line); border-radius:2px;
    padding:34px 34px 30px; margin-bottom:28px;
    box-shadow:0 1px 0 rgba(0,0,0,.02), 0 10px 28px -24px rgba(60,45,20,.5);
  }
  .entry header{display:flex; align-items:baseline; gap:14px; margin-bottom:22px; padding-bottom:16px; border-bottom:1px solid var(--line)}
  .date{display:flex; align-items:baseline; gap:2px; font-size:15px; color:var(--accent)}
  .date .num{font-size:23px; font-weight:600; letter-spacing:.02em}
  .date .sep{opacity:.55; font-size:13px; margin:0 1px}
  .meta{color:var(--ink-soft); font-size:12px; letter-spacing:.08em}
  .body p{margin:0 0 1.05em; text-align:justify; text-indent:2em; font-size:15.5px}
  .body p:last-child{margin-bottom:0}
  .divider{text-align:center; color:var(--line); margin:20px 0; letter-spacing:.4em; font-size:12px}
  footer{text-align:center; color:var(--ink-soft); font-size:12px; letter-spacing:.1em; margin-top:40px}
  @media (max-width:520px){
    .wrap{padding:32px 16px 64px}
    .entry{padding:24px 20px}
    .body p{font-size:15px}
  }
  @media print{
    body{background:#fff} .entry{box-shadow:none; break-inside:avoid}
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">小玉的日记</h1>
    <div class="subtitle">${files.length} 篇 · 最近更新 ${files[0].replace(/\.md$/, "")}</div>
${cards}
    <footer>— 完 —</footer>
  </div>
</body>
</html>`;

  writeFileSync(OUT, html, "utf8");
  console.log(`已生成 ${OUT}（${files.length} 篇）`);
  return OUT;
}

const isMain = process.argv[1] && process.argv[1].endsWith("diary-gen.mjs");
if (isMain) render();

export default render;
