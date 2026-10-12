#!/usr/bin/env bun
/**
 * 编 macOS 通知桥：`native/notify_un.m` → `native/libdsh-notify.dylib`。
 *
 * 为什么需要它：Bun 主进程拿不到 UNUserNotificationCenter 的异步 block 回调（实测 completion
 * 永不触发），所以照旧壳 `desktop/src-tauri/src/network/notify_un.rs` 的路子，把 UN 调用放进
 * 我们自己的原生代码里，用真 block + 后台串行队列承接，结果写进原子量供 JS 无阻塞读取。
 *
 * 非 macOS 直接跳过（Windows/Linux 旧壳也是走 Electrobun/插件那条通道，不用这个库）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const projectRoot = dirname(import.meta.dir)
const source = join(projectRoot, 'native', 'notify_un.m')
const output = join(projectRoot, 'native', 'libdsh-notify.dylib')

if (process.platform !== 'darwin') {
  console.log(`[build-native] 非 macOS（${process.platform}），跳过通知桥`)
  process.exit(0)
}
if (!existsSync(source)) {
  console.error(`[build-native] 找不到源码：${source}`)
  process.exit(1)
}

mkdirSync(dirname(output), { recursive: true })
const args = [
  '-dynamiclib',
  '-fobjc-arc',
  '-O2',
  '-framework',
  'Foundation',
  '-framework',
  'UserNotifications',
  source,
  '-o',
  output,
]
const result = spawnSync('clang', args, { stdio: 'inherit' })
if (result.error !== undefined && result.error !== null) {
  console.error(`[build-native] clang 起不来：${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[build-native] clang 失败（exit ${String(result.status)}）`)
  process.exit(1)
}
if (!existsSync(output)) {
  console.error(`[build-native] clang 退出成功但没产出 ${output}`)
  process.exit(1)
}
console.log(`[build-native] 已生成 ${output}`)
