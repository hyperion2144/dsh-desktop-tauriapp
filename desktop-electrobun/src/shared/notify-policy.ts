// 通知投递决策（旧壳 `network/notify_policy.rs` 的等价物，纯函数、无 IO）。
//
// 唯一决策缝：给定（notifications 配置、场景 id、当前时刻、是否全屏）判「投不投、静不静、用哪个声音」。
// 调用点只传场景 id，策略全部收口在这里——否则 70 个调用点会各写一套免打扰判断。
//
// 三分声音语义（旧壳 ADR-0001）：
//   · `default`        → OS 通知渠道默认音（macOS 通知中心默认声）
//   · `none`           → 静默
//   · `custom:<文件名>` → 应用侧播放 `$DSH_HOME/sounds/<文件名>`（白名单校验在下面）

import { NOTIFICATION_SCENARIOS, type NotificationsConfig, type ScenarioMeta } from './settings.ts'
import { join } from 'node:path'

/** 场景 id 常量（与 settings 里的表一一对应；调用点写常量，避免手打错字符串）。 */
export const SCENARIO = {
  STARTUP_ERROR: 'startup.error',
  RUNTIME_SWITCH: 'runtime.switch',
  RUNTIME_DOWNLOAD: 'runtime.download',
  SERVICE_HEALTH: 'service.health',
  WINDOW_LIFECYCLE: 'window.lifecycle',
  INSTANCE_LIFECYCLE: 'instance.lifecycle',
  PROFILE_OP: 'profile.op',
  PROFILE_ERROR: 'profile.error',
  DOWNLOAD_COMPLETE: 'download.complete',
  TASK_COMPLETE: 'task.complete',
  CONFIG_ERROR: 'config.error',
  CONFIG_INFO: 'config.info',
  DSH_APPROVAL: 'dsh.approval',
  DSH_ERROR: 'dsh.error',
} as const

export type ScenarioId = (typeof SCENARIO)[keyof typeof SCENARIO]

/** `/notify` 载荷类型 → 场景 id（宿主事件桥那三种）。 */
export const NOTIFY_TYPE_SCENARIOS: Readonly<Record<string, string>> = {
  'task-complete': SCENARIO.TASK_COMPLETE,
  'dsh-approval': SCENARIO.DSH_APPROVAL,
  'dsh-error': SCENARIO.DSH_ERROR,
}

/** 音效文件白名单（旧壳 T5 决议：wav / mp3 / ogg，aac/m4a 不进）。 */
export const SOUND_EXTENSIONS = ['wav', 'mp3', 'ogg'] as const
/** 单文件大小上限（T5：5MB）。 */
export const MAX_SOUND_BYTES = 5 * 1024 * 1024
/** 单次播放时长上限（T5：10s 截断，防长音频当通知音）。 */
export const MAX_SOUND_SECONDS = 10

export type SoundChoice =
  | { kind: 'os-default' }
  | { kind: 'silent' }
  | { kind: 'custom'; name: string }

export interface NotifyDecision {
  /** false = 整体不投递（总开关关 / 场景关） */
  deliver: boolean
  /** true = 投递但无声（免打扰命中 / 全屏静默）——仍进系统通知中心 */
  silent: boolean
  sound: SoundChoice
}

export function scenarioMetaOf(id: string): ScenarioMeta | undefined {
  return NOTIFICATION_SCENARIOS.find((meta) => meta.id === id)
}

/** 场景默认配置；未知场景按旧壳口径回退「开 + 系统默认音」。 */
export function defaultScenarioConfig(id: string): { enabled: boolean; sound: string } {
  const meta = scenarioMetaOf(id)
  return { enabled: meta?.defaultOn ?? true, sound: 'default' }
}

/** 解析 `HH:MM`；非法输入返回 null。 */
export function parseHm(value: string): { hour: number; minute: number } | null {
  const parts = value.split(':')
  if (parts.length !== 2) return null
  const hour = Number(parts[0]?.trim())
  const minute = Number(parts[1]?.trim())
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * 时刻是否落在 `[from, to)` 免打扰窗内（支持跨午夜，如 22:00–08:00）。
 * `from === to` 视为未配置（零长度窗），与旧壳一致。
 */
export function inDndWindow(now: { hour: number; minute: number }, from: string, to: string): boolean {
  const f = parseHm(from)
  const t = parseHm(to)
  if (f === null || t === null) return false
  const current = now.hour * 60 + now.minute
  const start = f.hour * 60 + f.minute
  const end = t.hour * 60 + t.minute
  if (start === end) return false
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

/** 声音档位解析：`none` → 静默，`custom:名` → 自定义（空名当静默），其余 → 系统默认音。 */
export function soundChoice(raw: string): SoundChoice {
  if (raw.startsWith('custom:')) {
    const name = raw.slice('custom:'.length)
    return name === '' ? { kind: 'silent' } : { kind: 'custom', name }
  }
  if (raw === 'none') return { kind: 'silent' }
  return { kind: 'os-default' }
}

/**
 * 投递决策（纯函数，旧壳 `decide()` 逐条对齐）：
 *   · 总开关关 / 场景关            → 不投递
 *   · 免打扰开且命中时段，或全屏静默开且正在全屏 → 投递但静默
 *   · 声音：静默命中 → silent；否则按场景档位
 */
export function decide(
  config: NotificationsConfig,
  scenarioId: string,
  now: { hour: number; minute: number },
  fullscreen: boolean,
): NotifyDecision {
  if (!config.enabled) {
    return { deliver: false, silent: false, sound: { kind: 'silent' } }
  }
  const scenario = config.scenarios[scenarioId] ?? defaultScenarioConfig(scenarioId)
  if (!scenario.enabled) {
    return { deliver: false, silent: false, sound: { kind: 'silent' } }
  }
  const dnd = config.dnd
  const dndHit = dnd.on && inDndWindow(now, dnd.from, dnd.to)
  const fullscreenHit = dnd.suppressFullscreen && fullscreen
  const silent = dndHit || fullscreenHit
  return {
    deliver: true,
    silent,
    sound: silent ? { kind: 'silent' } : soundChoice(scenario.sound),
  }
}

/** 本地时刻拆成 `{hour, minute}`（决策用；调用方也可以自己传，测试就不必碰时钟）。 */
export function localHm(date: Date): { hour: number; minute: number } {
  return { hour: date.getHours(), minute: date.getMinutes() }
}

/**
 * 音效文件名白名单（旧壳 `validate_name`）：禁止路径分隔符与 `..`，
 * 只允许字母/数字（含中日韩）/点/下划线/连字符/空格/括号。
 */
export function isValidSoundName(name: string): boolean {
  if (name === '' || name.length > 255) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return [...name].every(
    (ch) => /[\p{L}\p{N}]/u.test(ch) || ['.', '_', '-', ' ', '(', ')', '[', ']'].includes(ch),
  )
}

/** 扩展名是否在白名单里（大小写不敏感）。 */
export function hasAllowedSoundExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = name.slice(dot + 1).toLowerCase()
  return (SOUND_EXTENSIONS as readonly string[]).includes(ext)
}

/** 白名单扩展名 → 允许的文件头魔数（旧壳 `sounds::ALLOWED`，逐条对齐）。 */
export const SOUND_FORMATS: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<number>>]> = [
  ['wav', [[0x52, 0x49, 0x46, 0x46]]], // RIFF
  [
    'mp3',
    [
      [0x49, 0x44, 0x33], // ID3
      [0xff, 0xfb],
      [0xff, 0xf3],
      [0xff, 0xfa],
      [0xff, 0xf2],
    ],
  ],
  ['ogg', [[0x4f, 0x67, 0x67, 0x53]]], // OggS
]

/**
 * 文件头魔数是否与扩展名相符（旧壳 `validate_format`）：扩展名不在白名单、或头几个字节
 * 对不上任何魔数都算不合格——防「改个后缀当音效」与坏文件。
 */
export function soundFormatMatches(name: string, head: Uint8Array): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = name.slice(dot + 1).toLowerCase()
  const entry = SOUND_FORMATS.find(([candidate]) => candidate === ext)
  if (entry === undefined) return false
  return entry[1].some((magic) => magic.every((byte, index) => head[index] === byte))
}

/** 音效目录：`$DSH_HOME/sounds/`（旧壳 `sounds_dir()`）。 */
export function soundsDir(home: string): string {
  // 用 join 而不是模板拼接：Windows 上路径分隔符是反斜杠，拼出来的混搭分隔符在断言/日志里很难认
  return join(home, 'sounds')
}
