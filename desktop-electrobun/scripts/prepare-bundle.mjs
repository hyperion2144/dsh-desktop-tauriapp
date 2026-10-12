#!/usr/bin/env bun
// 构建期准备：
//  1) 把 Bun 兼容层物化进 desktop-electrobun/runtime/，供 electrobun.config.ts 的 build.copy
//     打进包内（打包后仓库不在身边，runtime.ts 的 layout() 会退到这份副本）。
//  2) 从仓库里的 Tauri 图标生成 icon.iconset（Electrobun 只吃 .iconset / .icon）。
//
// 单一来源仍是 desktop/src-tauri/ 下的资源（Tauri 壳与新壳共用），这里只做转换/拷贝 ——
// 不要在这里改内容，否则两条壳路径会漂移。
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(projectRoot, '..')

// ── 1. Bun 兼容层 ────────────────────────────────────────────────────────────
const preloadSource = resolve(repoRoot, 'desktop', 'src-tauri', 'resources', 'dsh', 'bun-preload.mjs')
const preloadTarget = join(projectRoot, 'runtime', 'bun-preload.mjs')

if (!existsSync(preloadSource)) {
  console.error(`[prepare-bundle] 找不到 Bun 兼容层单一来源：${preloadSource}`)
  process.exit(1)
}
mkdirSync(dirname(preloadTarget), { recursive: true })
copyFileSync(preloadSource, preloadTarget)
const sha256 = createHash('sha256').update(readFileSync(preloadTarget)).digest('hex')
console.log(`[prepare-bundle] ${preloadSource}`)
console.log(`            → ${preloadTarget}`)
console.log(`            sha256=${sha256}`)

// ── 2. 应用图标 ──────────────────────────────────────────────────────────────
const iconSource = resolve(repoRoot, 'desktop', 'src-tauri', 'icons', 'icon.icns')
const iconTarget = join(projectRoot, 'icon.iconset')

if (existsSync(iconSource)) {
  rmSync(iconTarget, { recursive: true, force: true })
  const converted = spawnSync('iconutil', ['-c', 'iconset', iconSource, '-o', iconTarget], { stdio: 'inherit' })
  if (converted.status === 0 && existsSync(iconTarget)) {
    console.log(`[prepare-bundle] ${iconSource}`)
    console.log(`            → ${iconTarget}（iconutil）`)
  } else {
    console.warn(`[prepare-bundle] iconutil 转换失败（status=${String(converted.status)}），本次构建将使用默认图标`)
  }
} else {
  console.warn(`[prepare-bundle] 找不到图标来源：${iconSource}，本次构建将使用默认图标`)
}

// ── 3. 托盘图标 ───────────────────────────────────────────────────────────────
// 旧的 Tauri 壳用同一份 32x32.png 做托盘；这里拷成 resources/tray.png，
// 再由 build.copy 落进包内 runtime/tray.png（runtime.ts 的 trayImagePath 按这两处找）。
const traySource = resolve(repoRoot, 'desktop', 'src-tauri', 'icons', '32x32.png')
const trayTarget = join(projectRoot, 'resources', 'tray.png')
if (existsSync(traySource)) {
  mkdirSync(dirname(trayTarget), { recursive: true })
  copyFileSync(traySource, trayTarget)
  console.log(`[prepare-bundle] ${traySource}`)
  console.log(`            → ${trayTarget}`)
} else {
  console.warn(`[prepare-bundle] 找不到托盘图标：${traySource}，本次构建不建托盘`)
}

// ── 4. 内置 dsh 运行时（随包发出）───────────────────────────────────────
// 为什么必须随包：ADR 0004 的页面资产取自「当前生效运行时」的 dist。以前新壳只有
// “下载的运行时”，干净机器上首次启动直接报「找不到可用的 dsh 运行时」（实测），
// 内置树随包后才有兜底（与旧 Tauri 壳的 resources/dsh 同语义）。
//
// 来源优先级：DSH_SHELL_BUILTIN_SOURCE > 仓内 Tauri 树 > 本机已下载运行时（开发便利）。
// 找不到就只警告：CI 上由工作流先准备好 Tauri 树，本地开发可以只测壳。
const builtinTarget = join(projectRoot, 'builtin-runtime')
const binMarker = (dir) => join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const isRuntimeTree = (dir) => existsSync(binMarker(dir))

function newestDownloadedRuntime() {
  const roots = [
    process.env.DSH_HOME === undefined ? null : join(process.env.DSH_HOME, 'runtimes'),
    join(homedir(), 'Library', 'Application Support', 'com.hyperion.dsh-desktop-bun', 'runtimes'),
  ].filter((entry) => entry !== null)
  for (const root of roots) {
    if (!existsSync(root)) continue
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
    for (const version of versions.reverse()) {
      const candidate = join(root, version)
      if (isRuntimeTree(candidate)) return candidate
    }
  }
  return null
}

const builtinSource = (() => {
  const explicit = process.env.DSH_SHELL_BUILTIN_SOURCE
  if (explicit !== undefined && explicit !== '' && isRuntimeTree(explicit)) return explicit
  const repoTree = resolve(repoRoot, 'desktop', 'src-tauri', 'resources', 'dsh')
  if (isRuntimeTree(repoTree)) return repoTree
  return newestDownloadedRuntime()
})()

if (builtinSource === null) {
  rmSync(builtinTarget, { recursive: true, force: true })
  console.warn('[prepare-bundle] 没有可用的内置运行时树（DSH_SHELL_BUILTIN_SOURCE / 仓内 Tauri 树 / 已下载运行时都没有），本次构建不带内置 dsh')
} else {
  rmSync(builtinTarget, { recursive: true, force: true })
  cpSync(builtinSource, builtinTarget, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop() ?? ''
      return name !== '.DS_Store' && !name.startsWith('._') && name !== '.git'
    },
  })
  const version = (() => {
    try {
      const raw = JSON.parse(readFileSync(join(builtinTarget, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
      return typeof raw.version === 'string' ? raw.version : 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  const counted = spawnSync('sh', ['-c', `find ${JSON.stringify(builtinTarget)} -type f | wc -l`], { encoding: 'utf8' })
  const files = (counted.stdout ?? '').trim()
  writeFileSync(join(builtinTarget, '.builtin-runtime.json'), `${JSON.stringify({ version, source: builtinSource, files: Number(files) || 0 }, null, 2)}\n`)
  console.log(`[prepare-bundle] ${builtinSource}`)
  console.log(`            → ${builtinTarget}（内置 dsh ${version}，${files} 个文件）`)
}
