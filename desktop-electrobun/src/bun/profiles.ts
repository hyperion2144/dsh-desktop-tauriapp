// profile 列表（纯 fs，缝 ② 可测）。
//
// dsh 的 profile 就是 `<DSH_HOME>/profiles/<name>` 目录（旧 Tauri 壳的托盘「切换 Profile」
// 子菜单读的是同一处）。这里只做「列出 + 保证当前 profile 在里面」，
// 真正开多窗口/切换属「多 profile 窗口」那一轮。

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'

export function profilesDir(home: string): string {
  return join(home, 'profiles')
}

export function listProfiles(home: string, current: string): string[] {
  const dir = profilesDir(home)
  if (!existsSync(dir)) return [current]
  try {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
    return names.includes(current) ? names : [current, ...names]
  } catch {
    return [current]
  }
}

/** 运行时来源标签：本轮只有「内置运行时」，外部 CLI / 下载运行时在运行时管理那一轮接上。 */
export function runtimeLabel(runtimeDir: string): string {
  // basename 而不是 split('/')：Windows 上运行时目录是反斜杠路径
  const version = basename(runtimeDir)
  return `内置 ${version}`
}
