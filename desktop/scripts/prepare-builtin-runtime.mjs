#!/usr/bin/env node
// 打包内置运行时（wayfinder #85 第二批）：dsh 依赖树进 resources/dsh + Node sidecar 进 binaries/
// 用法: node scripts/prepare-builtin-runtime.mjs --variant latest|alpha
//       [--node-version latest-v24.x] [--skip-node] [--skip-packages]
// 产物（均 gitignore，不入库）:
//   desktop/src-tauri/resources/dsh/           dsh 依赖树（package.json + node_modules）
//   desktop/src-tauri/binaries/dsh-node-<triple>[.exe]  Node sidecar（tauri externalBin）
// CI: release.yml 矩阵（平台 × latest/alpha）各调一次；本地 tauri dev 无需跑（内置缺
// 资源时自动回退外部 dsh，见 runtime/builtin.rs）。
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, chmodSync, cpSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcTauri = resolve(scriptDir, "..");

// ── 参数 ──
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const variant = opt("--variant");
const nodeVersionTag = opt("--node-version", "latest-v24.x");
const skipNode = flag("--skip-node");
const skipPackages = flag("--skip-packages");

if (!skipPackages && !["latest", "alpha"].includes(variant)) {
  console.error("用法: prepare-builtin-runtime.mjs --variant latest|alpha [--node-version latest-v24.x] [--skip-node] [--skip-packages]");
  process.exit(2);
}

const log = (m) => console.log(`[builtin-runtime] ${m}`);
const die = (m) => { console.error(`[builtin-runtime] ${m}`); process.exit(1); };

const resourcesDsh = join(srcTauri, "resources", "dsh");
const binariesDir = join(srcTauri, "binaries");
const stage = join(srcTauri, ".builtin-stage");

// ── 1) dsh 依赖树（npm 装 → 拷进 resources/dsh）──
if (!skipPackages) {
  const distTags = JSON.parse(
    execSync("npm view @deepseek-ai/dsh dist-tags --json", { encoding: "utf8" })
  );
  const version = distTags[variant];
  if (!version) die(`npm dist-tags 里没有 ${variant}（现有：${Object.keys(distTags).join(", ")}）`);
  log(`内置 dsh ${variant} = ${version}`);

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "package.json"), JSON.stringify({ private: true }));
  execSync(`npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@${version}`, {
    cwd: stage, stdio: "inherit",
  });

  rmSync(resourcesDsh, { recursive: true, force: true });
  mkdirSync(dirname(resourcesDsh), { recursive: true });
  // verbatimSymlinks: node_modules/.bin 相对链接原样保留（#83 迁移研究同款结论）
  cpSync(join(stage, "node_modules"), resourcesDsh, { recursive: true, verbatimSymlinks: true });
  writeFileSync(
    join(resourcesDsh, "desktop-runtime.json"),
    JSON.stringify({ variant, dsh: version, node: nodeVersionTag, staged_at: new Date().toISOString() }, null, 2)
  );
  log(`dsh 依赖树已就位：${resourcesDsh}`);
}

// ── 2) Node sidecar（nodejs.org dist 下载 → binaries/dsh-node-<triple>）──
if (!skipNode) {
  const { platform, arch } = process;
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "win" : platform;
  const nodeArch = arch === "arm64" ? "arm64" : "x64";
  const ext = os === "win" ? "zip" : "tar.gz";
  const triple =
    os === "darwin"
      ? (nodeArch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
      : os === "win"
        ? "x86_64-pc-windows-msvc"
        : "x86_64-unknown-linux-gnu";

  const index = await (await fetch(`https://nodejs.org/dist/${nodeVersionTag}/`)).text();
  const re = new RegExp(`href="((?:node-)?v?[0-9][0-9.]*-${os}-${nodeArch}\\.${ext})"`);
  const m = index.match(re);
  if (!m) die(`node dist ${nodeVersionTag} 里找不到 ${os}-${nodeArch}.${ext} 的包`);
  const file = m[1];
  const url = `https://nodejs.org/dist/${nodeVersionTag}/${file}`;
  log(`下载 Node sidecar：${url}`);

  const tmp = join(srcTauri, ".builtin-stage-node");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, file);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(archive, buf);
  execSync(`tar -x${ext === "zip" ? "f" : "zf"} "${archive}" -C "${tmp}"`, { stdio: "inherit" });

  const extracted = readdirSync(tmp).find((d) => d.startsWith("node-"));
  if (!extracted) die("解压后找不到 node-v* 目录");
  const nodeBin = os === "win"
    ? join(tmp, extracted, "node.exe")
    : join(tmp, extracted, "bin", "node");

  mkdirSync(binariesDir, { recursive: true });
  const target = join(binariesDir, `dsh-node-${triple}${os === "win" ? ".exe" : ""}`);
  rmSync(target, { force: true });
  cpSync(nodeBin, target);
  if (os !== "win") chmodSync(target, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  log(`Node sidecar 已就位：${target}`);
}

log("内置运行时打包完成（resources/dsh + binaries/dsh-node-*）");
