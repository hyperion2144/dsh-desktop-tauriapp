/**
 * 应用更新的 IO 层：把 Electrobun 自带的 `Updater` 包成壳自己的小接口（#220 决策 11）。
 *
 * 分工：`src/shared/update.ts` 管纯逻辑（阶段翻译、版本比较、可点性），本文件只管
 * 「拿框架的本地信息 / 订阅状态 / 调三个动作」，并且**在任何一种失败里都不抛**——更新是
 * 锦上添花的功能，它坏了不能连带把设置面板或启动流程拖垮。
 *
 * 不可用的两种正当理由，都会原样写进视图让用户看见：
 *   · 这个构建没有更新源（dev 构建、`release.baseUrl` 没配）；
 *   · 被 `DSH_SHELL_DISABLE_UPDATER=1` 关掉。
 * 此外 `DSH_SHELL_UPDATE_BASE_URL` 可以盖掉清单源——本地起一个静态目录就能把「检查→下载→
 * 安装→重启」整条链路走一遍，不必真发版。
 */

import {
  DEFAULT_UPDATE_BASE_URL,
  UPDATE_BASE_URL_ENV,
  UPDATE_DISABLE_ENV,
  platformPrefixOf,
  updateView,
  type LocalUpdateLike,
  type RemoteUpdateLike,
  type StatusLike,
  type UpdateView,
  updateActions,
  type UpdateActions,
} from '../shared/update.ts'

/** 我们用到的框架面（只声明用到的部分，便于测试注入假实现）。 */
export interface UpdaterLike {
  getLocalInfo(): Promise<LocalUpdateLike>
  checkForUpdate(): Promise<RemoteUpdateLike>
  downloadUpdate(): Promise<void>
  applyUpdate(): Promise<void>
  updateInfo(): RemoteUpdateLike
  onStatusChange(callback: ((entry: StatusLike) => void) | null): void
}

export interface UpdaterSnapshot {
  available: boolean
  reason: string
  view: UpdateView
  /** 三个按钮能不能点，以及一句「为什么不能点」（客户端直接照这个渲染） */
  actions: UpdateActions
}

export interface ShellUpdater {
  available: boolean
  reason: string
  snapshot(): UpdaterSnapshot
  check(): Promise<UpdaterSnapshot>
  download(): Promise<UpdaterSnapshot>
  apply(): Promise<UpdaterSnapshot>
  /** 订阅框架状态（幂等）。 */
  start(): void
  /** 退订（壳退出时调，避免回调打到已拆的窗口上）。 */
  stop(): void
}

export interface UpdaterOptions {
  log: (message: string) => void
  env?: Record<string, string | undefined>
  os?: string
  arch?: string
  buildEnv?: string
  /** 测试缝：注入假的 Updater（返回 null 表示 import 失败）。 */
  importUpdater?: () => Promise<UpdaterLike | null>
  now?: () => number
}

/** `1`/`true`/`yes`/`on` 才算开（`0`/`false`/空串都不算）。 */
export function isFlagOn(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

async function defaultImport(): Promise<UpdaterLike | null> {
  try {
    const mod = (await import('electrobun/bun')) as { Updater?: UpdaterLike }
    return mod.Updater ?? null
  } catch {
    return null
  }
}

export function createUpdater(options: UpdaterOptions): ShellUpdater {
  const env = options.env ?? process.env
  const log = options.log
  const now = options.now ?? (() => Date.now())
  const os = options.os ?? process.platform
  const arch = options.arch ?? process.arch
  const buildEnv = options.buildEnv ?? env.DSH_SHELL_BUILD_ENV ?? ''
  // 前缀影响的是**显示出来**的清单 URL（真正抓取的是框架自己）；拿不到构建环境时按
  // version.json 的 channel 推（dev 构建 channel='dev'），实在没有才回落到 'stable'。
  let prefix = platformPrefixOf({
    buildEnv: buildEnv === '' ? 'stable' : buildEnv,
    os: osName(os),
    arch: archName(arch),
  })

  let updater: UpdaterLike | null = null
  let ready = false
  let subscribed = false
  let local: LocalUpdateLike = {}
  let remote: RemoteUpdateLike = {}
  let status: StatusLike | undefined
  let failure = ''
  let reason = ''
  let available = false

  function snapshot(): UpdaterSnapshot {
    const view = updateView({
      available,
      reason,
      prefix,
      local,
      remote,
      status,
      error: failure,
    })
    return { available, reason, view, actions: updateActions(view) }
  }

  function remember(message: string): void {
    failure = message
    log(`[update] ${message}`)
  }

  async function load(): Promise<void> {
    if (ready) return
    ready = true
    if (isFlagOn(env[UPDATE_DISABLE_ENV])) {
      reason = `更新被 ${UPDATE_DISABLE_ENV} 关掉了`
      log(`[update] ${reason}`)
      return
    }
    const importer = options.importUpdater ?? defaultImport
    try {
      updater = await importer()
    } catch (error) {
      reason = `加载框架更新器失败：${String(error)}`
      log(`[update] ${reason}`)
      return
    }
    if (updater === null) {
      reason = '这个构建里没有框架更新器（不是打包运行？）'
      log(`[update] ${reason}`)
      return
    }
    try {
      local = await updater.getLocalInfo()
    } catch (error) {
      reason = `读不到本地版本信息：${String(error)}`
      log(`[update] ${reason}`)
      return
    }
    if (buildEnv === '' && (local.channel ?? '') !== '') {
      prefix = platformPrefixOf({
        buildEnv: local.channel as string,
        os: osName(os),
        arch: archName(arch),
      })
    }
    const override = env[UPDATE_BASE_URL_ENV]
    const baseUrl = override !== undefined && override !== '' ? override : (local.baseUrl ?? '')
    local = { ...local, baseUrl }
    if (baseUrl === '') {
      reason = `当前构建没有更新源（release.baseUrl 未配置；默认源是 ${DEFAULT_UPDATE_BASE_URL}）`
      log(`[update] ${reason}`)
      return
    }
    available = true
    log(
      `[update] 更新源就绪：${local.version ?? '?'}（channel=${local.channel ?? '?'}）→ ${baseUrl}` +
        (override !== undefined && override !== '' ? `（由 ${UPDATE_BASE_URL_ENV} 覆盖）` : '')
    )
  }

  function ensureSubscribed(): void {
    if (subscribed || updater === null) return
    subscribed = true
    updater.onStatusChange((entry) => {
      status = { ...entry, timestamp: entry.timestamp ?? now() }
    })
  }

  async function run(
    action: 'check' | 'download' | 'apply',
    call: (target: UpdaterLike) => Promise<unknown>
  ): Promise<UpdaterSnapshot> {
    await load()
    if (!available || updater === null) return snapshot()
    ensureSubscribed()
    try {
      await call(updater)
      failure = ''
      remote = updater.updateInfo() ?? {}
      log(`[update] ${action} 完成：${remote.version ?? '?'}（available=${String(remote.updateAvailable)}, ready=${String(remote.updateReady)}）`)
    } catch (error) {
      remember(`${action} 失败：${String(error)}`)
      try {
        remote = updater.updateInfo() ?? {}
      } catch {}
    }
    return snapshot()
  }

  return {
    get available() {
      return available
    },
    get reason() {
      return reason
    },
    snapshot,
    check: () => run('check', (target) => target.checkForUpdate()),
    download: () => run('download', (target) => target.downloadUpdate()),
    apply: () => run('apply', (target) => target.applyUpdate()),
    start: () => {
      void load().then(() => {
        ensureSubscribed()
        const current = snapshot()
        log(`[update] 状态：${current.view.label}（${current.view.current || '版本未知'}）`)
      })
    },
    stop: () => {
      if (updater !== null && subscribed) updater.onStatusChange(null)
      subscribed = false
    },
  }
}

/** 框架用的 os 名是 `macos`/`win`/`linux`（`process.platform` 是 `darwin`/`win32`/`linux`）。 */
function osName(platform: string): string {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'win'
  return platform
}

function archName(arch: string): string {
  if (arch === 'x64') return 'x64'
  if (arch === 'arm64') return 'arm64'
  return arch
}
