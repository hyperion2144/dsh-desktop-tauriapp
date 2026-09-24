// dsh-launcher.mjs —— 桌面壳内置 dsh 启动器：直调内部 runProfile API，不经 CLI。
// 由桌面壳在启动时写出（内容随包内嵌），供内置 node 执行。
// 用法: node dsh-launcher.mjs <dshLibDir> <profile> <port> [--patch <path>]...
// 设计来源: wayfinder #85（desktop 保留字绕过 + 内置统一代码启动路径，已端到端实证）。
import { createRequire } from "node:module"
import { readdirSync } from "node:fs"
import { join, resolve as pathResolve } from "node:path"
import { pathToFileURL } from "node:url";
const [rawLibDir, profile, port, ...rest] = process.argv.slice(2);
// #123 纵深防御：Rust 侧已对 resource_dir 去 Windows verbatim 前缀；
// 此处兑底归一（\\?\D:\… → D:\…；\\?\UNC\srv → \\srv），防未来新增调用点遗漏。
const dshLibDir = rawLibDir.startsWith("\\\\?\\\\UNC\\\\")
  ? "\\\\" + rawLibDir.slice(8)
  : rawLibDir.startsWith("\\\\?\\\\")
    ? rawLibDir.slice(4)
    : rawLibDir;
if (!dshLibDir || !profile || !port) {
  console.error("usage: node dsh-launcher.mjs <dshLibDir> <profile> <port> [--patch <path>...]");
  process.exit(2);
}
const patches = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--patch" && rest[i + 1]) patches.push(rest[++i]);
}
const initFromDefault = rest.includes("--init-from-default") && profile !== "web" ? "web" : undefined;


// 0) 模块解析覆盖（anywhere-labs 式）：凡内置 node_modules 里存在的裸说明符，
// 一律解析到内置版本——存量 profile 插件的 @deepseek-ai/* peer 依赖不再被
// profile 本地旧版副本遮蔽，与运行中的 dsh 核心天然同版。
const bundledNmRoot = pathResolve(dshLibDir, "../../..")
process.env.DSH_DESKTOP_BUNDLED_MODULES = bundledNmRoot
const mod = await import("node:module")
const hooksSpec = new URL("./dsh-resolver-hooks.mjs", import.meta.url).href
if (typeof mod.registerHooks === "function") {
  mod.registerHooks(hooksSpec)
} else {
  mod.register(hooksSpec)
}
process.stdout.write(`[desktop-resolver] hooks registered (bundled=${bundledNmRoot})\n`)

// 注：Node 22.15+ 建议 registerHooks（同步立即生效），旧版回退 register。
// 1) 以 dsh 自身 bin.js 的位置解析依赖（与官方 CLI 一致的 node_modules 向上查找）
const require = createRequire(join(dshLibDir, "bin.js"));
const appBootPath = require.resolve("@deepseek-ai/dsh-app-boot");
const { loadLayeredEnv } = await import(pathToFileURL(appBootPath).href);

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
    const m = await import(pathToFileURL(c).href);
    if (typeof m.runProfile === "function") { runProfile = m.runProfile; break; }
  } catch (e) {
    // #123：真实失败原因必须浮出（此前空 catch 吞错，排障只能看到末端的 not found）
    console.error(`[dsh-launcher] import 候选失败 ${c}: ${e?.message ?? e}`);
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
