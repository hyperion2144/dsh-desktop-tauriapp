#!/usr/bin/env node
// 打包后的 ad-hoc 封装签名（#220 补：通知授权要一份「绑了 Info.plist」的签名）。
//
// 为什么必须有这一步：Electrobun 产出的 .app 里，可执行体是 linker-signed 的 `launcher`，
// `codesign -dv` 会报 `Identifier=launcher` + `Info.plist=not bound`。macOS 的
// UNUserNotificationCenter 因此拿不到稳定的 app 身份，`requestAuthorization` 直接回
// `UNErrorDomain Code=1`，Electrobun 只能回落到 legacy API（macOS 26+ 上是空操作）——
// 现象就是「回合跑完了，没有任何系统通知」（实测日志：
// `Notification authorization error: … - falling back to legacy API`）。
//
// 用 ad-hoc 重签把 Info.plist 绑进签名就够了：不需要 Developer ID、不做公证，
// 规格 #220 的「代码签名与公证」仍在 Out of Scope（这只是本机封装层的一致性）。
//
// 用法：node scripts/sign-app.mjs [app 路径]      （不给就找 build/ 下最新的 .app）

import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

/** 深度受限地找 .app（Electrobun 的产物层级不固定：build/<channel>-<平台>/<名字>.app）。 */
function findApps(dir, depth = 0) {
  if (depth > 3) return []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const hits = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (entry.name.endsWith('.app')) hits.push(full)
    else hits.push(...findApps(full, depth + 1))
  }
  return hits
}

function newestApp() {
  const buildDir = join(projectRoot, 'build')
  const apps = findApps(buildDir)
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
  return apps[0]?.path ?? null
}

const target = process.argv[2] ?? process.env.DSH_SHELL_SIGN_APP ?? newestApp()
if (target === null || target === undefined) {
  console.error('[sign-app] 没找到要签的 .app（先跑 hutch electrobun build，或把路径当参数传进来）')
  process.exit(1)
}
if (process.platform !== 'darwin') {
  console.log(`[sign-app] 非 macOS（${process.platform}），跳过封装签名：${target}`)
  process.exit(0)
}

console.log(`[sign-app] ad-hoc 重签：${target}`)
// P10：带上旧壳同款 entitlements（CEF/V8 初始化需要 JIT 豁免，缺了会 Fatal OOM）
const entitlements = join(projectRoot, 'resources', 'entitlements.plist')
const signArgs = ['--force', '--deep', '--sign', '-']
try {
  statSync(entitlements)
  signArgs.push('--entitlements', entitlements)
} catch {}
execFileSync('codesign', [...signArgs, target], { stdio: 'inherit' })

// 读回签名：`codesign -dv` 把详情写在 **stderr**（stdout 是空的），所以两路都要收
const check = spawnSync('codesign', ['-dv', target], { encoding: 'utf8' })
const detail = `${check.stdout ?? ''}${check.stderr ?? ''}`
const identifier = /Identifier=(\S+)/.exec(detail)?.[1] ?? '(未知)'
const plistEntries = /Info\.plist entries=(\d+)/.exec(detail)?.[1] ?? '0'
console.log(`[sign-app] Identifier=${identifier}  Info.plist entries=${plistEntries}`)
if (plistEntries === '0') {
  console.error('[sign-app] Info.plist 没被绑进签名（通知授权仍会失败）；检查 .app 结构')
  process.exit(1)
}
