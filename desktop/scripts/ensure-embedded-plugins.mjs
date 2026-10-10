#!/usr/bin/env node
/**
 * ensure-embedded-plugins.mjs —— 桌面打包前的「内嵌插件就绪」守卫（#212）。
 *
 * 背景：build.rs 把三个插件包 stage 进 src-tauri/embedded/，再由 tauri.conf.json 的
 * bundle.resources 打进 `.app/Contents/Resources/plugins/<name>`。其中 dsh-web-mobile 的源
 * 是 git 子模块 mobile/dsh-mobile-nav —— `git worktree add` 出来的工作树里子模块目录是
 * **空目录**，而 build.rs 原先对复制失败只打 `cargo:warning` 就继续：0.12.0 的安装包就是
 * 这样缺了 dsh-web-mobile（运行期只剩一条 WARN，用户无感）。
 *
 * 现在两道闸：
 *   ① 本脚本（在 tauri dev/build 之前跑）先把缺件说清楚并给出补救命令；
 *   ② build.rs 在 staging 缺件时直接 panic，构建中止（防止再产出缺插件的安装包）。
 * 两侧的清单必须一致 —— ensure-embedded-plugins.test.mjs 会拿 build.rs 源码做一致性断言。
 *
 * 用法：node scripts/ensure-embedded-plugins.mjs [仓库根]
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 与 desktop/src-tauri/build.rs 的 `packages` 表一致（顺序也一致，测试会比对）。 */
export const EMBEDDED_PLUGINS = [
  {
    name: 'dsh-desktop-tauriapp',
    rel: '.',
    files: ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    dirs: ['lib'],
  },
  {
    name: 'dsh-mobile-access',
    rel: 'mobile/dsh-mobile-access',
    files: ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    dirs: ['lib', 'client'],
  },
  {
    name: 'dsh-web-mobile',
    rel: 'mobile/dsh-mobile-nav',
    files: ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    dirs: ['lib'],
  },
]

const SUBMODULE_REMEDY =
  'mobile/dsh-mobile-nav 是 git 子模块（worktree / 浅检出里可能是空目录）。请先执行：\n' +
  '  git submodule update --init --recursive\n' +
  '再重新打包；否则会产出缺插件的安装包（手机端移动布局不生效）。'

/**
 * 返回缺件清单（空数组 = 就绪）。纯函数：只读文件系统，不打印、不退出。
 * @param {string} repoRoot 仓库根绝对路径
 * @param {typeof EMBEDDED_PLUGINS} [plugins] 清单（测试可注入）
 */
export function findMissingPlugins(repoRoot, plugins = EMBEDDED_PLUGINS) {
  const issues = []
  for (const plugin of plugins) {
    const srcRoot = resolve(repoRoot, plugin.rel)
    const missing = []
    for (const file of plugin.files) {
      if (!existsSync(join(srcRoot, file))) missing.push(file)
    }
    for (const dir of plugin.dirs) {
      const full = join(srcRoot, dir)
      if (!existsSync(full) || !statSync(full).isDirectory()) missing.push(`${dir}/`)
      else if (readdirSync(full).length === 0) missing.push(`${dir}/（空目录）`)
    }
    if (missing.length > 0) issues.push({ name: plugin.name, srcRoot, missing })
  }
  return issues
}

/** 人类可读的失败报告（缺件时非 null）。 */
export function formatIssues(issues, repoRoot) {
  if (issues.length === 0) return null
  const lines = issues.map(
    (issue) =>
      `  - ${issue.name}：源 ${issue.srcRoot} 缺 ${issue.missing.length} 项 —— ${issue.missing.join('、')}`,
  )
  const hint = existsSync(join(repoRoot, 'mobile/dsh-mobile-nav/package.json'))
    ? ''
    : `\n提示：${SUBMODULE_REMEDY}`
  return `[ensure-embedded-plugins] 内嵌插件缺件，已阻止打包（否则会产出缺插件的安装包）：\n${lines.join('\n')}${hint}`
}

// 直接执行（非 import）时才退出进程
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(process.argv[2] ?? join(here, '..', '..'))
  const report = formatIssues(findMissingPlugins(repoRoot), repoRoot)
  if (report !== null) {
    console.error(report)
    process.exit(1)
  }
  console.log(
    `[ensure-embedded-plugins] 内嵌插件源就绪：${EMBEDDED_PLUGINS.map((p) => p.name).join(' / ')}`,
  )
}
