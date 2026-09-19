// dsh-launcher.mjs —— 桌面壳内置 dsh 启动器：直调内部 runProfile API，不经 CLI。
// 由桌面壳在启动时写出（内容随包内嵌），供内置 node 执行。
// 用法: node dsh-launcher.mjs <dshLibDir> <profile> <port> [--patch <path>]...
// 设计来源: wayfinder #85（desktop 保留字绕过 + 内置统一代码启动路径，已端到端实证）。
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const [dshLibDir, profile, port, ...rest] = process.argv.slice(2);
if (!dshLibDir || !profile || !port) {
  console.error("usage: node dsh-launcher.mjs <dshLibDir> <profile> <port> [--patch <path>...]");
  process.exit(2);
}
const patches = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--patch" && rest[i + 1]) patches.push(rest[++i]);
}
const initFromDefault = rest.includes("--init-from-default") ? "web" : undefined;

// 1) 以 dsh 自身 bin.js 的位置解析依赖（与官方 CLI 一致的 node_modules 向上查找）
const require = createRequire(join(dshLibDir, "bin.js"));
const appBootPath = require.resolve("@deepseek-ai/dsh-app-boot");
const { loadLayeredEnv } = await import(appBootPath);

// 2) 定位 runProfile：稳定名 profile-boot.js 优先，散列名 profile-boot-*.js 回退
const candidates = [join(dshLibDir, "profile-boot.js")];
try {
  for (const f of readdirSync(dshLibDir)) {
    if (/^profile-boot-.*\.js$/.test(f)) candidates.push(join(dshLibDir, f));
  }
} catch {}
let runProfile = null;
for (const c of candidates) {
  try {
    const m = await import(c);
    if (typeof m.runProfile === "function") { runProfile = m.runProfile; break; }
  } catch {}
}
if (!runProfile) throw new Error(`dsh-launcher: runProfile not found in ${dshLibDir}`);

// 3) 与 dsh CLI bin.js case "profile" 完全一致的调用契约
await runProfile({
  environment: loadLayeredEnv("dsh"),
  profile,
  fromDefaultProfile: initFromDefault,
  patchFiles: patches,
  args: ["--no-open", "--host", "127.0.0.1", "--port", port],
});
