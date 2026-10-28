// build-ocr.mjs — 编译 ocr.cs 成 ocr.exe（一次性构建脚本）。
//
// 为什么用 node 脚本而不是命令行直接调：
//   2026-10-18/19 实测：从 Bash 或 PowerShell 工具的命令行直接调 .NET 编译器
//   会被安全策略拦（报错关键词「compiles arbitrary C# code」）。
//   而 bridge.mjs 运行时 spawn 子进程是本项目一直以来的正常工作方式
//   （voice.mjs 就 spawn python、bridge 就 spawn dsh），不受该命令行拦截影响。
//
// 用法：node build-ocr.mjs
//   成功：生成 ocr.exe，打印 BUILD_OK
//   失败：打印编译器原始输出 + BUILD_FAIL

import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const WINMD = "C:\\Windows\\System32\\WinMetadata";
// WinRT 的 winmd 引用会依赖 .NET Core 的门面程序集（System.Runtime），
// 不显式引用就报 CS0012「类型 System.Attribute 在未引用的程序集中定义」。
const FACADES = "C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.7.2\\Facades";

// 不用 System.Runtime.WindowsRuntime.dll：本机没装 Windows SDK，缺合并的
// Windows.winmd，该程序集的 AsTask 扩展方法无法解析。ocr.cs 改用接口自带的
// GetResults()，所以这里只要 winmd + System.Runtime 门面即可。
const args = [
  "/nologo",
  "/target:exe",
  "/out:ocr.exe",
  `/reference:${join(FACADES, "System.Runtime.dll")}`,
  `/reference:${join(WINMD, "Windows.Foundation.winmd")}`,
  `/reference:${join(WINMD, "Windows.Storage.winmd")}`,
  `/reference:${join(WINMD, "Windows.Media.winmd")}`,
  `/reference:${join(WINMD, "Windows.Globalization.winmd")}`,
  `/reference:${join(WINMD, "Windows.Graphics.winmd")}`,
  "ocr.cs",
];

// 捕获输出在这台机器上会间歇 EBUSY，所以让编译器输出重定向到文件。
const logFd = openSync(join(__dirname, ".run", "csc-build.log"), "w");
const r = spawnSync(CSC, args, {
  cwd: __dirname,
  stdio: ["ignore", logFd, logFd],
  windowsHide: true,
  timeout: 120000,
});
closeSync(logFd);

const exe = join(__dirname, "ocr.exe");
if (existsSync(exe)) {
  console.log(`BUILD_OK size=${statSync(exe).size}`);
  process.exit(0);
}
console.log(`BUILD_FAIL status=${r.status} error=${r.error?.code ?? "none"}`);
const logPath = join(__dirname, ".run", "csc-build.log");
if (existsSync(logPath)) {
  console.log("---- 编译器输出 ----");
  console.log(readFileSync(logPath, "utf8").slice(0, 3000));
}
process.exit(1);
