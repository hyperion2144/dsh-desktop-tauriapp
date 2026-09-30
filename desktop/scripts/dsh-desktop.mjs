#!/usr/bin/env node
// 在 **desktop profile** 上跑 dsh —— 绕过官方 CLI「Electron 专属」的拦截。
//
// 为什么需要它（实测 + 读源码，2026-09-30）：
//   官方 CLI（含我们内置运行时 `runtime/bin-dsh/dsh`，0.2.0-rc.2）在**启动器的参数解析**里硬拦：
//     function rejectElectronProfile(program, profile) {
//       if (profile.toLowerCase() === "desktop") program.error('error: profile "desktop" is managed exclusively by the Electron application');
//     }
//   这个名字判断**没有环境变量开关**，所以 `dsh --profile desktop …` 一律被拒。
//   但拦截只发生在解析阶段，真正的执行入口是内部的 runProfile / runPlugin：
//     - **plugin 动作有官方开关**：`if (!manageDesktopProfile) rejectElectronProfile(...)`，
//       即 runCli({ manageDesktopProfile: true }) 即可管理 desktop profile 的插件（不需要打补丁）；
//     - **profile 启动没有开关**（该处无条件拦截）→ 直接调 lib/profile-boot.js 的 runProfile，
//       这正是桌面壳自己拉起 desktop profile 的方式（所以我们注入的那个 dsh 从不受此限）。
//
// 用法：
//   dsh-desktop plugin <pnpm 参数…>       # 例如 add @scope/pkg / list / why pkg
//   dsh-desktop boot [应用参数…]           # 相当于以 desktop profile 启动（壳同款内部路径）
//   dsh-desktop runtime                    # 打印实际使用的运行时目录
// 环境变量：
//   DSH_DESKTOP_RUNTIME=<dsh 包目录>       # 指定运行时（默认取应用资源里版本最高的那份）
//   DSH_HOME=<目录>                        # 照 dsh 惯例（默认 ~/.dsh）
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 应用资源里各版本运行时所在目录（壳按版本下载/内置到这里）。 */
const RUNTIMES_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'com.arcreel.dsh-desktop-tauriapp',
  'runtimes',
);

/** 版本目录名比较：按数字段排序（0.2.0-rc.2 > 0.1.7-rc.2）。 */
function compareVersions(a, b) {
  const parts = (v) => v.split(/[.\-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

/** 找到要用的 dsh 包目录（`…/@deepseek-ai/dsh`，其下要有 lib/bin.js）。 */
function resolveRuntime() {
  const explicit = process.env.DSH_DESKTOP_RUNTIME;
  if (explicit) {
    const pkg = explicit.endsWith('@deepseek-ai/dsh') ? explicit : join(explicit, 'node_modules', '@deepseek-ai', 'dsh');
    if (!existsSync(join(pkg, 'lib', 'bin.js'))) {
      throw new Error(`DSH_DESKTOP_RUNTIME 指向的目录里没有 lib/bin.js：${pkg}`);
    }
    return pkg;
  }
  if (!existsSync(RUNTIMES_DIR)) throw new Error(`找不到运行时目录：${RUNTIMES_DIR}`);
  const versions = readdirSync(RUNTIMES_DIR).filter((v) => {
    try {
      return statSync(join(RUNTIMES_DIR, v)).isDirectory();
    } catch {
      return false;
    }
  });
  versions.sort(compareVersions);
  for (const v of versions.reverse()) {
    const pkg = join(RUNTIMES_DIR, v, 'node_modules', '@deepseek-ai', 'dsh');
    if (existsSync(join(pkg, 'lib', 'bin.js'))) return pkg;
  }
  throw new Error(`运行时目录里没有可用的 @deepseek-ai/dsh：${RUNTIMES_DIR}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === undefined || command === '-h' || command === '--help') {
  console.log(`用法：
  dsh-desktop plugin <pnpm 参数…>   在 desktop profile 上跑 pnpm（add/list/why…）
  dsh-desktop boot [应用参数…]       以 desktop profile 启动（壳同款内部路径）
  dsh-desktop runtime                打印实际使用的运行时目录`);
  process.exit(command === undefined ? 1 : 0);
}

const pkgDir = resolveRuntime();
if (command === 'runtime') {
  console.log(pkgDir);
  process.exit(0);
}

const libUrl = (file) => pathToFileURL(join(pkgDir, 'lib', file)).href;

if (command === 'plugin') {
  // 官方开关：manageDesktopProfile=true 时跳过 rejectElectronProfile（见 lib/bin.js 的 plugin 动作）。
  process.argv = ['node', 'dsh', 'plugin', '--profile', 'desktop', ...rest];
  const { runCli } = await import(libUrl('bin.js'));
  await runCli({ manageDesktopProfile: true });
} else if (command === 'boot') {
  // 启动没有开关 → 直接走内部入口（桌面壳就是这么拉起 desktop profile 的）。
  const { runProfile } = await import(libUrl('profile-boot.js'));
  const { loadLayeredEnv } = await import(
    pathToFileURL(join(pkgDir, '..', 'dsh-app-boot', 'lib', 'index.js')).href
  );
  await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    patchFiles: [],
    args: rest,
  });
} else {
  console.error(`dsh-desktop: 不认识的命令 ${JSON.stringify(command)}（用 -h 看用法）`);
  process.exit(1);
}
