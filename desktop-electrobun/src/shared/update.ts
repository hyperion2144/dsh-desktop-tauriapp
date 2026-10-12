/**
 * 应用更新（#220 决策 11：「应用内自动更新是**新增能力**，用框架更新器」）。
 *
 * 旧 Tauri 壳**没有**这个功能（`desktop/src-tauri/Cargo.toml` 里没有 `tauri-plugin-updater`，
 * `src/client` 里也没有任何 update 命令）——所以这不是「搬旧壳」，而是把 Electrobun 自带的
 * `Updater` 接上：它按 `<baseUrl>/<buildEnvironment>-<os>-<arch>-update.json` 取清单，再按
 * 「补丁链优先、失败回落整包」的方式换掉整个 `.app`，最后重启新版本。
 *
 * 本文件只有**纯逻辑**（可单测、不 import electrobun）：把 Electrobun 的状态机翻译成壳自己的
 * 视图模型（中文标签、进度、可点性），以及版本比较与清单 URL 的拼法。真正的 IO 在
 * `src/bun/updater.ts`。
 *
 * 两个刻意的边界：
 *   · **不自己实现下载与替换**——框架那套带事务、回滚与 Windows 计划任务，重写没有意义；
 *   · **不静默降级**：拿不到更新源（dev 构建、`baseUrl` 为空、被开关关掉）时视图里写清楚
 *     「为什么不可用」，而不是显示一个永远转圈的「检查更新」。
 */

/** 默认更新源：GitHub Releases 的 `latest/download` 别名（每个资产名稳定指向最新一版）。 */
export const DEFAULT_UPDATE_BASE_URL =
  'https://github.com/hyperion2144/dsh-desktop-tauriapp/releases/latest/download'

/** 覆盖更新源（本地起一个静态目录就能验更新流程，不必真发版）。 */
export const UPDATE_BASE_URL_ENV = 'DSH_SHELL_UPDATE_BASE_URL'

/** 完全关掉更新（离线环境 / 排障）。 */
export const UPDATE_DISABLE_ENV = 'DSH_SHELL_DISABLE_UPDATER'

/** 壳视图里的更新阶段（比 Electrobun 的 29 个状态粗，够 UI 用）。 */
export type UpdatePhase =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'preparing'
  | 'ready'
  | 'error'

export const UPDATE_PHASE_LABELS: Record<UpdatePhase, string> = {
  unavailable: '不可用',
  idle: '未检查',
  checking: '正在检查…',
  'up-to-date': '已是最新',
  available: '有新版本',
  downloading: '正在下载…',
  preparing: '正在安装…',
  ready: '已就绪（重启后生效）',
  error: '更新失败',
}

/** 壳侧视图（客户端卡片直接渲染这个结构）。 */
export interface UpdateView {
  available: boolean
  reason: string
  phase: UpdatePhase
  label: string
  status: string
  message: string
  current: string
  latest: string
  channel: string
  baseUrl: string
  feedUrl: string
  updateAvailable: boolean
  updateReady: boolean
  progress: number | null
  bytesDownloaded: number | null
  totalBytes: number | null
  error: string
  /** 状态最后一次变化的时刻（毫秒；没变化过为 0）。 */
  at: number
}

export interface LocalUpdateLike {
  version?: string
  hash?: string
  channel?: string
  baseUrl?: string
  identifier?: string
}

export interface RemoteUpdateLike {
  version?: string
  hash?: string
  updateAvailable?: boolean
  updateReady?: boolean
  error?: string
}

export interface StatusLike {
  status?: string
  message?: string
  timestamp?: number
  details?: {
    progress?: number
    bytesDownloaded?: number
    totalBytes?: number
    errorMessage?: string
  }
}

/** Electrobun 的平台前缀：`<buildEnvironment>-<os>-<arch>`（见 `shared/naming.ts:84`）。 */
export function platformPrefixOf(input: {
  buildEnv: string
  os: string
  arch: string
}): string {
  return `${input.buildEnv}-${input.os}-${input.arch}`
}

export function feedFileName(prefix: string): string {
  return `${prefix}-update.json`
}

/** 去掉尾斜杠再拼清单名（`baseUrl` 允许写成带或不带尾斜杠两种）。 */
export function feedUrl(baseUrl: string, prefix: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed === '') return ''
  return `${trimmed}/${feedFileName(prefix)}`
}

/** 版本比较：数字段按数值，预发布段比正式版小（`0.2.1-alpha.2` < `0.2.1`）。 */
export function compareVersions(a: string, b: string): number {
  const parse = (raw: string): { core: number[]; pre: string[] } => {
    const [core = '', pre = ''] = raw.trim().replace(/^v/, '').split('-', 2)
    return {
      core: core.split('.').map((part) => {
        const value = Number.parseInt(part, 10)
        return Number.isFinite(value) ? value : 0
      }),
      pre: pre === '' ? [] : pre.split('.'),
    }
  }
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const preLength = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < preLength; index += 1) {
    const leftPart = left.pre[index]
    const rightPart = right.pre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = Number.parseInt(leftPart, 10)
    const rightNumber = Number.parseInt(rightPart, 10)
    const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    if (bothNumeric) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1
      continue
    }
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export function isNewerVersion(latest: string, current: string): boolean {
  if (latest === '' || current === '') return false
  return compareVersions(latest, current) > 0
}

/** Electrobun 的状态 → 壳的粗阶段（`patch-failed` 会回落整包，所以算「还在下载」）。 */
export function phaseOfStatus(status: string): UpdatePhase {
  switch (status) {
    case 'idle':
      return 'idle'
    case 'checking':
    case 'check-complete':
      return 'checking'
    case 'no-update':
      return 'up-to-date'
    case 'update-available':
      return 'available'
    case 'download-starting':
    case 'downloading':
    case 'checking-local-tar':
    case 'local-tar-found':
    case 'local-tar-missing':
    case 'fetching-patch':
    case 'patch-found':
    case 'patch-not-found':
    case 'downloading-patch':
    case 'downloading-full-bundle':
    case 'download-progress':
    case 'download-complete':
    case 'patch-failed':
      return 'downloading'
    case 'applying-patch':
    case 'patch-applied':
    case 'patch-chain-complete':
    case 'extracting-version':
    case 'decompressing':
    case 'applying':
    case 'extracting':
    case 'replacing-app':
      return 'preparing'
    case 'launching-new-version':
    case 'complete':
      return 'ready'
    case 'error':
      return 'error'
    default:
      return status === '' ? 'idle' : 'checking'
  }
}

/** 进度百分比（Electrobun 的 `progress` 是 0..1；缺字节数时返回 null 让 UI 显示不确定动画）。 */
export function progressOf(details: StatusLike['details']): number | null {
  if (details === undefined) return null
  const { progress, bytesDownloaded, totalBytes } = details
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    const clamped = Math.max(0, Math.min(1, progress))
    return Math.round(clamped * 100)
  }
  if (
    typeof bytesDownloaded === 'number' &&
    typeof totalBytes === 'number' &&
    Number.isFinite(bytesDownloaded) &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0
  ) {
    return Math.round(Math.max(0, Math.min(1, bytesDownloaded / totalBytes)) * 100)
  }
  return null
}

/** 人类可读字节（卡片里显示 `12.3 MB` 这种）。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function updatePhaseLabel(phase: UpdatePhase): string {
  return UPDATE_PHASE_LABELS[phase]
}

/** 把「本地版本 + 远端清单 + 最近一条状态」合成一个视图（纯函数，卡片与测试共用）。 */
export function updateView(input: {
  available: boolean
  reason?: string
  prefix: string
  local: LocalUpdateLike
  remote?: RemoteUpdateLike
  status?: StatusLike
  error?: string
}): UpdateView {
  const local = input.local
  const remote = input.remote ?? {}
  const status = input.status ?? {}
  const baseUrl = local.baseUrl ?? ''
  const statusName = status.status ?? ''
  const errorText = input.error ?? status.details?.errorMessage ?? remote.error ?? ''
  let phase = phaseOfStatus(statusName)
  if (!input.available) phase = 'unavailable'
  else if (errorText !== '' && (phase === 'idle' || phase === 'up-to-date')) phase = 'error'
  // 状态是历史遗留的 error、但此刻没有错误文本 ⇒ 当成「还没检查」，不要挂着红字
  else if (phase === 'error' && errorText === '') phase = 'idle'
  const current = local.version ?? ''
  const latest = remote.version ?? ''
  const updateAvailable =
    remote.updateAvailable === true ||
    (input.available && phase !== 'unavailable' && isNewerVersion(latest, current))
  const updateReady = remote.updateReady === true || phase === 'ready'
  return {
    available: input.available,
    reason: input.reason ?? '',
    phase,
    label: updatePhaseLabel(phase),
    status: statusName,
    message: status.message ?? '',
    current,
    latest,
    channel: local.channel ?? '',
    baseUrl,
    feedUrl: feedUrl(baseUrl, input.prefix),
    updateAvailable,
    updateReady,
    progress: progressOf(status.details),
    bytesDownloaded: status.details?.bytesDownloaded ?? null,
    totalBytes: status.details?.totalBytes ?? null,
    error: errorText,
    at: status.timestamp ?? 0,
  }
}

/** 三个按钮各自能不能点，外加一句「为什么不能点」。 */
export interface UpdateActions {
  canCheck: boolean
  canDownload: boolean
  canApply: boolean
  hint: string
}

export function updateActions(view: UpdateView): UpdateActions {
  if (!view.available) {
    return { canCheck: false, canDownload: false, canApply: false, hint: view.reason }
  }
  const busy = view.phase === 'checking' || view.phase === 'downloading' || view.phase === 'preparing'
  const canCheck = !busy
  const canDownload = !busy && (view.phase === 'available' || view.phase === 'error')
  const canApply = !busy && view.updateReady
  let hint = ''
  if (busy) hint = view.label
  else if (canApply) hint = '重启后由新版本接管，当前会话不受影响'
  else if (view.phase === 'up-to-date') hint = `${view.current} 已经是最新`
  else if (view.phase === 'available') hint = `可下载 ${view.latest}`
  else if (view.phase === 'error') hint = view.error === '' ? '上次更新失败，可重试' : view.error
  return { canCheck, canDownload, canApply, hint }
}
