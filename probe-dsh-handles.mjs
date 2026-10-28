// htrace.mjs — 只读探针：记录句柄创建点，dsh 收尾后 dump 仍存活的句柄 + 创建栈
// 用法：NODE_OPTIONS=--import=/tmp/htrace.mjs HTRACE_LOG=/tmp/htrace-1.log dsh ...
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const LOG = process.env.HTRACE_LOG || "/tmp/htrace.log";
const rec = { watch: [], watchFile: [], listen: [], connect: [], fetch: [] };
const ofetch = globalThis.fetch;
if (typeof ofetch === "function") {
  globalThis.fetch = function (input, init) {
    let url = "";
    try {
      url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    } catch {}
    const item = { target: url, stack: stackHere(1), ts: Date.now(), state: "pending", hasSignal: !!(init && init.signal) };
    push(rec.fetch, item);
    let p;
    try {
      p = ofetch.call(this, input, init);
    } catch (e) {
      item.state = "throw:" + (e && e.name);
      throw e;
    }
    return p.then(
      (r) => { item.state = "headers:" + r.status; return r; },
      (e) => { item.state = "error:" + (e && e.name) + ":" + String((e && e.message) || "").slice(0, 80); throw e; }
    );
  };
}
const MAX = 500;

function stackHere(skip) {
  return (new Error().stack || "").split("\n").slice(skip, skip + 10).join("\n");
}
function log(line) {
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
}
function push(arr, item) {
  if (arr.length < MAX) arr.push(item);
}

const ow = fs.watch;
fs.watch = function (target, ...rest) {
  const w = ow.call(this, target, ...rest);
  push(rec.watch, { target: String(target), stack: stackHere(1), obj: w });
  return w;
};
const owf = fs.watchFile;
fs.watchFile = function (target, ...rest) {
  push(rec.watchFile, { target: String(target), stack: stackHere(1) });
  return owf.call(this, target, ...rest);
};
const opw = fs.promises.watch;
if (typeof opw === "function") {
  fs.promises.watch = function (target, ...rest) {
    push(rec.watch, { target: String(target), stack: stackHere(1), obj: null });
    return opw.call(this, target, ...rest);
  };
}
const ol = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const a0 = args[0];
  const target = a0 && typeof a0 === "object" ? JSON.stringify(a0) : String(a0);
  push(rec.listen, { target, stack: stackHere(1), obj: this });
  return ol.apply(this, args);
};
const onc = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a0 = args[0];
  const target = a0 && typeof a0 === "object" ? `${a0.host ?? ""}:${a0.port ?? ""}` : String(a0);
  push(rec.connect, { target, stack: stackHere(1), obj: this });
  return onc.apply(this, args);
};
const otc = tls.connect;
tls.connect = function (...args) {
  const a0 = args[0];
  const target = a0 && typeof a0 === "object" ? `${a0.host ?? ""}:${a0.port ?? ""}` : String(a0);
  const sock = otc.apply(this, args);
  push(rec.connect, { target, stack: stackHere(1), obj: sock });
  return sock;
};

let completeAt = 0;
let dumped = false;

function aliveWatch(w) {
  if (!w.obj) return false;
  try { return !!w.obj._handle && !w.obj._closed; } catch { return false; }
}
function aliveConnect(c) {
  if (!c.obj) return false;
  try { return !c.obj.destroyed; } catch { return false; }
}

function dump(reason) {
  const counts = {};
  try {
    for (const t of process.getActiveResourcesInfo()) counts[t] = (counts[t] || 0) + 1;
  } catch {}
  log(`\n===== ${reason} | pid=${process.pid} exitCode=${process.exitCode} =====`);
  log(`activeResources: ${JSON.stringify(counts)}`);
  const wLive = rec.watch.filter(aliveWatch);
  log(`-- fs.watch 创建 ${rec.watch.length} 个，dump 时仍存活 ${wLive.length} 个`);
  for (const w of wLive) log(`[WATCH] ${w.target}\n${w.stack}\n`);
  const wfLive = rec.watchFile.length;
  if (wfLive) log(`-- fs.watchFile 调用 ${wfLive} 次（无法判断存活，仅记录）`);
  const sLive = rec.listen.filter((s) => s.obj.listening);
  log(`-- net.listen 创建 ${rec.listen.length} 个，仍监听 ${sLive.length} 个`);
  for (const s of rec.listen) {
    let addr = "";
    try { addr = JSON.stringify(s.obj.address()); } catch {}
    log(`[LISTEN ${s.obj.listening ? "活" : "已关"}] ${addr} <- ${s.target}\n${s.stack}\n`);
  }
  if (rec.watchFile.length) {
    for (const w of rec.watchFile) log(`[WATCHFILE] ${w.target}\n${w.stack}\n`);
  }
  const cLive = rec.connect.filter(aliveConnect);
  log(`-- net/tls connect 创建 ${rec.connect.length} 个，仍存活 ${cLive.length} 个`);
  for (const c of cLive) log(`[SOCK] ${c.target}\n${c.stack}\n`);
  const recentFetch = rec.fetch.slice(-14);
  log(`-- fetch 调用 ${rec.fetch.length} 次，最近 ${recentFetch.length} 条：`);
  for (const f of recentFetch) {
    log(`[FETCH ${f.state}${f.hasSignal ? " 有signal" : ""} @${new Date(f.ts).toISOString()}] ${f.target}`);
    if (f.state === "pending") log(f.stack + "\n");
  }
  try {
    const jsHandles = process._getActiveHandles ? process._getActiveHandles() : [];
    log(`-- _getActiveHandles 类型: ${JSON.stringify(jsHandles.map((h) => h && h.constructor && h.constructor.name))}`);
  } catch {}
  log(`===== dump 结束 =====`);
}

const timer = setInterval(() => {
  if (process.exitCode === undefined) return;
  if (!completeAt) completeAt = Date.now();
  if (!dumped && Date.now() - completeAt > 250) {
    dumped = true;
    dump("收尾后 250ms");
    clearInterval(timer);
  }
}, 200);
timer.unref();

log(`\n##### htrace 已注入 pid=${process.pid} cwd=${process.cwd()} #####`);
process.on("exit", (code) => {
  if (!dumped) {
    dumped = true;
    dump(`进程退出 code=${code}`);
  }
});
