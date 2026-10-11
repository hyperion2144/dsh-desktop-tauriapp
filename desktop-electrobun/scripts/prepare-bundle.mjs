#!/usr/bin/env bun
// 构建期准备：
//  1) 把 Bun 兼容层物化进 desktop-electrobun/runtime/，供 electrobun.config.ts 的 build.copy
//     打进包内（打包后仓库不在身边，runtime.ts 的 layout() 会退到这份副本）。
//  2) 从仓库里的 Tauri 图标生成 icon.iconset（Electrobun 只吃 .iconset / .icon）。
//
// 单一来源仍是 desktop/src-tauri/ 下的资源（Tauri 壳与新壳共用），这里只做转换/拷贝 ——
// 不要在这里改内容，否则两条壳路径会漂移。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
