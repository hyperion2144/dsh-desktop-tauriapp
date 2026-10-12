// 设置文件的读写（唯一 IO 缝）：`<DSH_HOME>/desktop-settings.json`，与旧 Tauri 壳同一个文件。
//
// 旧壳的规矩照搬，理由是它们都是实机踩出来的：
//   · **单写者**：只有壳写这个文件（dsh 完全不碰），所以不需要锁；
//   · **原子写**：先写 `*.json.tmp` 再 rename —— 直接覆写的话，断电/崩溃会留下半个 JSON，
//     下次启动就成了「设置全丢」，用户会以为是壳吃掉了他的配置；
//   · **坏了就备份重建**：解析失败时把原文件改名成 `*.json.corrupt` 再回默认，
//     而不是静默覆盖（用户还能自己把内容捞回来）；
//   · **一次性迁移**：私有文件不存在时，从旧 `settings.yaml` 的 `dsh-desktop-tauriapp:`
//     块读一遍（只读，永不写入 yaml），迁完立刻落成 JSON。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { type DesktopSettings, defaultSettings, normalizeSettings, serializeSettings } from '../shared/settings.ts'

export const SETTINGS_FILE = 'desktop-settings.json'
export const LEGACY_SETTINGS_FILE = 'settings.yaml'

export function settingsPath(home: string): string {
  return join(home, SETTINGS_FILE)
}

export function legacySettingsPath(home: string): string {
  return join(home, LEGACY_SETTINGS_FILE)
}

export interface SettingsLogger {
  (line: string): void
}

/**
 * 极简 YAML 读取：只认「映射 + 标量叶子」，够读旧壳块。
 * 刻意不引 YAML 依赖——为一个只用一次的迁移拉进解析器不划算；
 * 列表（`- x`）与多行标量直接忽略，旧壳设置里它们只出现在 `remote_list`（可由用户在设置页重加）。
 */
export function parseSimpleYaml(text: string): Record<string, unknown> | null {
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; node: Record<string, unknown> }> = [{ indent: -1, node: root }]
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    if (line.startsWith('- ') || line === '-') continue // 列表项：跳过（见上）
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const rest = line.slice(colon + 1).trim()
    while (stack.length > 1 && indent <= (stack[stack.length - 1] as { indent: number }).indent) stack.pop()
    const parent = (stack[stack.length - 1] as { node: Record<string, unknown> }).node
    if (rest === '') {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, node: child })
      continue
    }
    parent[key] = scalar(rest)
  }
  return Object.keys(root).length === 0 ? null : root
}

function scalar(raw: string): unknown {
  const value = raw.replace(/^["']|["']$/g, '')
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

/** 旧 `settings.yaml` → 壳设置块（`dsh-desktop-tauriapp:` 优先，退回老的 `desktop:`）。 */
export function migrateFromLegacyYaml(text: string): DesktopSettings {
  const parsed = parseSimpleYaml(text)
  if (parsed === null) return defaultSettings()
  const block = parsed['dsh-desktop-tauriapp'] ?? parsed['desktop'] ?? parsed
  return normalizeSettings(block)
}

export interface LoadedSettings {
  settings: DesktopSettings
  path: string
  /** 本次是否是「文件不存在 ⇒ 迁移/新建」 */
  created: boolean
  /** 本次是否从旧的 settings.yaml 迁移而来 */
  migrated: boolean
  /** 本次是否是坏文件备份后重建 */
  recovered: boolean
}

export interface LoadSettingsInput {
  home: string
  log?: SettingsLogger
}

export function loadSettings(input: LoadSettingsInput): LoadedSettings {
  const log = input.log ?? ((): void => {})
  const path = settingsPath(input.home)
  if (existsSync(path)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return { settings: normalizeSettings(raw), path, created: false, migrated: false, recovered: false }
    } catch {
      const backup = `${path}.corrupt`
      try {
        renameSync(path, backup)
        log(`[settings] 设置文件损坏，已备份到 ${backup}，本次用默认值重建`)
      } catch (error) {
        log(`[settings] 设置文件损坏且备份失败：${String(error)}`)
      }
      const settings = legacyOrDefaults(input.home, log)
      saveSettings(input.home, settings.settings)
      return { settings: settings.settings, path, created: true, migrated: settings.migrated, recovered: true }
    }
  }
  const migrated = legacyOrDefaults(input.home, log)
  saveSettings(input.home, migrated.settings)
  log(migrated.migrated ? '[settings] 已从旧 settings.yaml 迁移到 desktop-settings.json' : `[settings] 新建 ${path}`)
  return { settings: migrated.settings, path, created: true, migrated: migrated.migrated, recovered: false }
}

function legacyOrDefaults(home: string, log: SettingsLogger): { settings: DesktopSettings; migrated: boolean } {
  const legacy = legacySettingsPath(home)
  if (!existsSync(legacy)) return { settings: defaultSettings(), migrated: false }
  try {
    const migrated = migrateFromLegacyYaml(readFileSync(legacy, 'utf8'))
    log(`[settings] 读到旧 ${legacy}（只读迁移，不改动它）`)
    return { settings: migrated, migrated: true }
  } catch (error) {
    log(`[settings] 旧 settings.yaml 读取失败：${String(error)}`)
    return { settings: defaultSettings(), migrated: false }
  }
}

export function saveSettings(home: string, settings: DesktopSettings): void {
  const path = settingsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(serializeSettings(settings), null, 2)}\n`)
  renameSync(tmp, path)
}

/** 读改写：给「设置页改一项」「托盘切一项」用。 */
export function updateSettings(home: string, patch: Record<string, unknown>, log?: SettingsLogger): DesktopSettings {
  const { settings } = loadSettings({ home, log })
  // patch 可能来自页面（设置面板按旧壳习惯下 snake_case）或壳内部（camelCase）。先落成
  // snake 再合，两种写法都能被 normalizeSettings 认出来，不会静默丢掉。
  const next = normalizeSettings({ ...serializeSettings(settings), ...patch })
  saveSettings(home, next)
  return next
}

/** 测试/诊断用：删掉设置文件（不删备份）。 */
export function removeSettings(home: string): void {
  rmSync(settingsPath(home), { force: true })
}
