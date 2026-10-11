// 运行时定位（骨架期：只用「当前生效运行时」，与本机已装的 App 布局对齐）。
//
// 现状 Rust 壳的 runtime/registry.rs 负责「下载/切换运行时」，那部分属迁移清单里的
// 「重写」项，本骨架先按目录约定定位，并把入口做成可注入的，便于缝 ① 用临时 DSH_HOME 起壳。

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const APP_SUPPORT = 'Library/Application Support/com.arcreel.dsh-desktop-tauriapp'

export interface ShellLayout {
  /** ~/.dsh 或 DSH_HOME */
  home: string
  profile: string
  /** 应用支持目录（运行时树所在） */
  appSupport: string
  /** 当前生效运行时目录，如 .../runtimes/0.2.1-alpha.2 */
  runtimeDir: string
  /** dsh 包的 lib 目录（宿主脚本的入参） */
  dshLibDir: string
  /** 前端 dist（本地文档与静态资产的来源） */
  distDir: string
  /** Bun 兼容层（preload 补丁），单一来源在 desktop/src-tauri/resources/dsh/bun-preload.mjs */
  preloadFile: string
  /** 宿主脚本 */
  hostScript: string
}

export interface LayoutInput {
  env?: Record<string, string | undefined>
  /** 覆盖运行时目录（测试/多运行时用） */
  runtimeDir?: string
}

export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME
  if (home !== undefined && home !== '') return home
  return join(homedir(), '.dsh')
}

export function appSupportDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.DSH_SHELL_APP_SUPPORT
  if (override !== undefined && override !== '') return override
  return join(homedir(), APP_SUPPORT)
}

/** 生效运行时的判定：显式 DSH_SHELL_RUNTIME_DIR > app support 下按版本名排序的最大者。 */
export function resolveRuntimeDir(input: LayoutInput = {}): string {
  const env = input.env ?? process.env
  if (input.runtimeDir !== undefined && input.runtimeDir !== '') return resolve(input.runtimeDir)
  const explicit = env.DSH_SHELL_RUNTIME_DIR
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const root = join(appSupportDir(env), 'runtimes')
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const latest = versions.at(-1)
  if (latest === undefined) throw new Error(`运行时目录里没有可用版本：${root}`)
  return join(root, latest)
}

/** 从某目录往上找带 `runtime/dsh-host.mjs` + `package.json` 的项目根（最多 8 层）。 */
function findProjectRoot(startDir: string): string | null {
  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'runtime', 'dsh-host.mjs')) && existsSync(join(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
  return null
}

export function layout(input: LayoutInput = {}): ShellLayout {
  const env = input.env ?? process.env
  const home = dshHome(env)
  const profile = env.DSH_PROFILE !== undefined && env.DSH_PROFILE !== '' ? env.DSH_PROFILE : 'desktop'
  const runtimeDir = resolveRuntimeDir({ ...input, env })
  const dshLibDir = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  const distDir = env.DSH_SHELL_DIST ?? join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
  // 项目根：开发时是 desktop-electrobun/（源码里的 import.meta.dir 往上找）；
  // dev 包在 build/dev-macos-arm64/… 里，往上也能找到同一标记。打包后的包找不到时必须用 env 指定。
  const projectRoot = env.DSH_SHELL_PROJECT ?? findProjectRoot(import.meta.dir) ?? resolve(import.meta.dir, '..', '..')
  const repoRoot = resolve(projectRoot, '..')
  // Bun 兼容层是仓内单一来源（desktop/src-tauri/resources/dsh/bun-preload.mjs）；
  // 打包时由构建期物化进包内，开发与 CI 直接用仓库路径（见 README）。
  const preloadFile = env.DSH_SHELL_PRELOAD ?? join(repoRoot, 'desktop', 'src-tauri', 'resources', 'dsh', 'bun-preload.mjs')
  const hostScript = env.DSH_SHELL_HOST_SCRIPT ?? join(projectRoot, 'runtime', 'dsh-host.mjs')
  const result: ShellLayout = { home, profile, appSupport: appSupportDir(env), runtimeDir, dshLibDir, distDir, preloadFile, hostScript }
  const missing = [
    ['dsh lib', dshLibDir],
    ['前端 dist', distDir],
    ['Bun 兼容层', preloadFile],
    ['宿主脚本', hostScript],
  ].filter(([, path]) => !existsSync(path as string))
  if (missing.length > 0) {
    throw new Error(`壳布局不完整：${missing.map(([label, path]) => `${label}=${String(path)}`).join(' | ')}`)
  }
  return result
}
