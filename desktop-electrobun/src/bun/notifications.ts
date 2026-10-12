// 通知投递（旧壳 `network/notify.rs` + `notify_un.rs` 的等价物）。
//
// 分层：决策在 `src/shared/notify-policy.ts`（纯函数），这里只负责「真的弹出去 / 真的响」。
// 平台投递：
//   · 有 Electrobun 时用它的 `Utils.showNotification`（index.ts 注入 `show`）——原生横幅 + 通知中心；
//   · 没注入时按平台退到命令行（macOS `osascript`、Linux `notify-send`、Windows 只记日志）：
//     黑盒测试与服务面（不起窗口）也能看到「本该弹什么」。
// 自定义音：`$DSH_HOME/sounds/<名>`，白名单（扩展名 + 名字）过了才放行，`afplay -t 10` 截断。
//
// 不做的事（与规格一致）：通知**点击回调**（Electrobun 上游 #384 未支持）、通知中心去重。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  decide,
  hasAllowedSoundExtension,
  isValidSoundName,
  localHm,
  MAX_SOUND_BYTES,
  MAX_SOUND_SECONDS,
  soundFormatMatches,
  soundsDir,
  type NotifyDecision,
} from '../shared/notify-policy.ts'
import type { NotificationsConfig } from '../shared/settings.ts'

export interface ShowNotificationOptions {
  title: string
  body: string
  silent: boolean
}

export interface NotifierOptions {
  notifications: NotificationsConfig
  /** `$DSH_HOME`（自定义音效目录的父目录）。 */
  home: string
  /** 应用名（通知标题）。 */
  appName?: string
  /** Electrobun 的原生通知；缺省走命令行兜底。 */
  show?: (options: ShowNotificationOptions) => void
  /** 播放自定义音（测试注入）；缺省 `afplay`。 */
  playCustom?: (path: string) => void
  /** 当前是否全屏（免打扰的「全屏静默」用）；缺省 false。 */
  isFullscreen?: () => boolean
  /** 当前本地时刻；缺省 `new Date()`。 */
  now?: () => Date
  platform?: NodeJS.Platform
  onLog?: (line: string) => void
}

export interface Notifier {
  /** 按场景投递；返回决策（测试与日志都用得上）。 */
  notify: (scenarioId: string, body: string, title?: string) => NotifyDecision
  /** 只算不投（设置面板的试听/预览用）。 */
  decide: (scenarioId: string) => NotifyDecision
  /** 自定义音的绝对路径；名字非法或文件不合规时返回 null。 */
  soundPath: (name: string) => string | null
  /** 试听：能放就放（返回是否真的放了） */
  previewSound: (name: string) => boolean
}

/** 命令行兜底：把通知文本转义后交给平台工具。 */
export function shellNotificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): string[] | null {
  if (platform === 'darwin') {
    const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return ['osascript', '-e', `display notification "${escape(body)}" with title "${escape(title)}"`]
  }
  if (platform === 'linux') return ['notify-send', title, body]
  return null
}

/** `$DSH_HOME/sounds/` 下已入库的音效文件名（设置 tab 的下拉用；按名字排序）。 */
export function listSounds(home: string): string[] {
  try {
    return readdirSync(soundsDir(home))
      .filter((name) => hasAllowedSoundExtension(name))
      .filter((name) => {
        try {
          return statSync(join(soundsDir(home), name)).isFile()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    // 目录不存在＝还没有自定义音，不是错误
    return []
  }
}

/**
 * 把一个外部音频文件收进 `$DSH_HOME/sounds/`（旧壳 `sounds::import_file`）：
 * 文件名白名单 → 扩展名魔数 → 大小上限，逐关不过就抛，过了就拷贝，返回入库后的文件名。
 */
export function importSound(home: string, source: string): string {
  // basename：Windows 上用户选的是 `C:\Users\…\ding.wav`，split('/') 会把整条路径当文件名
  const name = basename(source)
  if (name === '' || !isValidSoundName(name)) throw new Error(`音效文件名不合法：${name}`)
  if (!hasAllowedSoundExtension(name)) {
    throw new Error(`不支持的音效格式（白名单：wav / mp3 / ogg）：${name}`)
  }
  let size = 0
  try {
    const info = statSync(source)
    if (!info.isFile()) throw new Error('不是普通文件')
    size = info.size
  } catch (error) {
    throw new Error(`无法读取文件：${error instanceof Error ? error.message : String(error)}`)
  }
  if (size > MAX_SOUND_BYTES) {
    throw new Error(`文件 ${String(MAX_SOUND_BYTES / 1024 / 1024)}MB 上限，当前 ${String(size)} 字节`)
  }
  const head = new Uint8Array(readFileSync(source).subarray(0, 4))
  if (!soundFormatMatches(name, head)) throw new Error('文件内容与扩展名不符（魔数校验失败）')
  const dir = soundsDir(home)
  mkdirSync(dir, { recursive: true })
  copyFileSync(source, join(dir, name))
  return name
}


/**
 * 系统默认提示音（D7，旧壳 rodio 的跨平台等价物；试听 `default` 档用）：
 * macOS afplay 播 Ping.aiff；Windows 用 PowerShell 播系统事件音（无需额外依赖）；
 * Linux 有 aplay 就播 freedesktop 主题音，没有就退 null（静默）。
 */
export function systemDefaultSoundCommand(platform: NodeJS.Platform): string[] | null {
  if (platform === 'darwin') {
    return ['afplay', '-t', String(MAX_SOUND_SECONDS), '/System/Library/Sounds/Ping.aiff']
  }
  if (platform === 'win32') {
    // PowerShell 播系统事件音（无需额外依赖；-STA 避免 COM 报错）
    return [
      'powershell',
      '-NoProfile',
      '-STA',
      '-Command',
      '[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600',
    ]
  }
  if (platform === 'linux') {
    const candidates = [
      '/usr/share/sounds/freedesktop/stereo/complete.oga',
      '/usr/share/sounds/freedesktop/stereo/bell.oga',
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return ['aplay', '-q', candidate]
      }
    }
    return null
  }
  return null
}

export function createNotifier(options: NotifierOptions): Notifier {
  const log = options.onLog ?? ((): void => {})
  const platform = options.platform ?? process.platform
  if (options.show === undefined) {
    log('[notify] 未接原生通知（服务面 / 无窗口模式，或平台没有原生通道）')
  }
  const appName = options.appName ?? 'DSH'
  const now = options.now ?? ((): Date => new Date())

  const show =
    options.show ??
    ((payload: ShowNotificationOptions): void => {
      // macOS：旧壳早已弃用 `osascript display notification`（会以「脚本编辑器」身份投递，
      // 点横幅开错应用，见旧壳 notify_un.rs 头注释）。新壳同理：没接原生投递就只落日志，
      // 由调用方去接 Electrobun 原生投递 / notify_un 桥。
      if (platform === 'darwin') {
        log(`[notify] macOS 未接原生投递，本条只落日志：${payload.title}：${payload.body}`)
        return
      }
      const command = shellNotificationCommand(platform, payload.title, payload.body)
      if (command === null) {
        log(`[notify] ${payload.title}：${payload.body}（本平台暂无投递实现）`)
        return
      }
      try {
        const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
        child.unref?.()
      } catch (error) {
        log(`[notify] 投递失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })

  const playCustom =
    options.playCustom ??
    ((path: string): void => {
      if (platform !== 'darwin') {
        log(`[notify] 自定义音只在 macOS 上播放：${path}`)
        return
      }
      try {
        const child = Bun.spawn(['afplay', '-t', String(MAX_SOUND_SECONDS), path], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        child.unref?.()
      } catch (error) {
        log(`[notify] 播放自定义音失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })

  const soundPath = (name: string): string | null => {
    if (!isValidSoundName(name)) {
      log(`[notify] 音效文件名不合法，已忽略：${name}`)
      return null
    }
    if (!hasAllowedSoundExtension(name)) {
      log(`[notify] 音效格式不在白名单（wav/mp3/ogg）：${name}`)
      return null
    }
    const path = join(soundsDir(options.home), name)
    if (!existsSync(path)) {
      log(`[notify] 音效文件不存在：${path}`)
      return null
    }
    const size = statSync(path).size
    if (size > MAX_SOUND_BYTES) {
      log(`[notify] 音效文件超过 ${String(MAX_SOUND_BYTES / 1024 / 1024)}MB，已忽略：${name}`)
      return null
    }
    return path
  }

  const decideFor = (scenarioId: string): NotifyDecision =>
    decide(options.notifications, scenarioId, localHm(now()), options.isFullscreen?.() ?? false)

  return {
    decide: decideFor,
    notify: (scenarioId: string, body: string, title?: string): NotifyDecision => {
      const decision = decideFor(scenarioId)
      if (!decision.deliver) {
        log(`[notify] ${scenarioId} 未投递（总开关或场景关闭）`)
        return decision
      }
      const heading = title ?? appName
      show({ title: heading, body, silent: decision.silent || decision.sound.kind === 'silent' })
      if (decision.sound.kind === 'custom') {
        const path = soundPath(decision.sound.name)
        if (path !== null) playCustom(path)
      }
      log(`[notify] ${scenarioId}：${body}${decision.silent ? '（静默）' : ''}`)
      return decision
    },
    soundPath,
    // 设置面板的「试听」：只放自定义音（OS 默认音由系统自己弹，试听没意义）
    previewSound: (name: string): boolean => {
      const path = soundPath(name)
      if (path === null) return false
      playCustom(path)
      log(`[notify] 试听音效：${name}`)
      return true
    },
  }
}
