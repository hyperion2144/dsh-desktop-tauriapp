// 桌面壳设置：schema、默认值与归一化（纯逻辑，不碰 IO ⇒ 缝 ② 直接断言）。
//
// 与旧 Tauri 壳**逐字段对齐**（`desktop/src-tauri/src/settings.rs` 的 `DesktopSettings`，27 项），
// 文件是同一个 `<DSH_HOME>/desktop-settings.json`：换壳不该让用户的设置从头再来，
// 也不该让新旧壳对同一个键理解不同。归一层集中在这里，别处一律用归一化后的值。
//
// 归一化的三条规矩（对齐旧壳）：
//   1. 类型不对就当没有（不猜、不抛）——配置文件是用户手改得动的，坏值不该让壳起不来；
//   2. 数值一律夹取到有意义区间（并发 1..32、心跳 1s..600s），而不是原样接受；
//   3. 枚举只认白名单（代理模式、dsh 来源、运行时下载源），其余回落到"没设置"。

/** 下载管理器并发上限（旧壳 `configured_download_concurrency`：默认 3，夹在 1..=32）。 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 3
export const DOWNLOAD_CONCURRENCY_MIN = 1
export const DOWNLOAD_CONCURRENCY_MAX = 32

/** 网关 WS 心跳覆盖（旧壳 `DEFAULT_MUX_HEARTBEAT_MS`：默认 30s，夹在 1s..600s）。 */
export const DEFAULT_MUX_HEARTBEAT_MS = 30_000
export const MUX_HEARTBEAT_MIN = 1_000
export const MUX_HEARTBEAT_MAX = 600_000

export const PROXY_MODES = ['off', 'system', 'manual'] as const
export type ProxyMode = (typeof PROXY_MODES)[number]

export const DSH_MODES = ['builtin', 'external'] as const
export type DshMode = (typeof DSH_MODES)[number]

export const RUNTIME_SOURCES = ['github', 'npm'] as const
export type RuntimeSource = (typeof RUNTIME_SOURCES)[number]

/** 默认 profile（旧壳 `FRESH_DEFAULT_PROFILE`）。 */
export const DEFAULT_PROFILE = 'desktop'
/** web profile 的默认端口（旧壳注释：web 3080、desktop 3081）。 */
export const DEFAULT_PROFILE_PORTS: Readonly<Record<string, number>> = { web: 3080, desktop: 3081 }
/** 手机访问 lane 的默认端口（旧壳 #94 后的口径：lane 整体 +1 → web 3092、desktop 3093，腾 3091 给壳转发器）。 */
export const DEFAULT_PROFILE_LANE_PORTS: Readonly<Record<string, number>> = { web: 3092, desktop: 3093 }
/** 非 web/desktop 的上游端口散列基点（旧壳 settings.rs:291 `PORT_BASE_OTHER`）。 */
export const PORT_BASE_OTHER = 3082
/** 非 web/desktop 的 lane 端口散列基点（旧壳 settings.rs:293 `LANE_BASE_OTHER`）。 */
export const LANE_BASE_OTHER = 3094
/** 端口避让窗口 [base, base+1023]，溢出回绕（旧壳 assign_port_avoiding）。 */
export const PORT_AVOID_SPAN = 1_024

export interface NotificationScenarioConfig {
  enabled: boolean
  /** `default` | `none` | `custom:<sounds 目录下文件名>` */
  sound: string
}

export interface NotificationDndConfig {
  on: boolean
  from: string
  to: string
  suppressFullscreen: boolean
}

export interface NotificationsConfig {
  enabled: boolean
  dnd: NotificationDndConfig
  scenarios: Record<string, NotificationScenarioConfig>
}

export interface DesktopSettings {
  port?: number
  activeProfile?: string
  remoteAddr?: string
  remoteList: string[]
  remoteSession?: string
  lanePort?: number
  cloudflaredBin?: string
  proxyMode?: ProxyMode
  proxyUrl?: string
  noProxy?: string
  proxyUser?: string
  proxyPass?: string
  downloadConcurrency?: number
  muxHeartbeatMs?: number
  desktopLayoutOnPhones?: boolean
  /** 已废弃：视觉窗口化在换壳时整块删掉了（#200 收尾）。保留只为旧配置原样往返。 */
  desktopRenderBudget?: boolean
  preventSleep?: boolean
  profilePorts?: Record<string, number>
  profileLanePorts?: Record<string, number>
  dshMode?: DshMode
  dshRuntime?: string
  runtimeSource?: RuntimeSource
  runtimeGithubRepo?: string
  tunnelUrl?: string
  wsKeepaliveMs?: number
  wsPongTimeoutMs?: number
  notifications: NotificationsConfig
}

/**
 * 落盘用的 JSON（**下划线键名**，与旧 Tauri 壳的 serde 字段名逐字一致）。
 * 为什么不让它跟我一样用驼峰：这是新旧壳**共用**的文件，旧壳读 camelCase 会全部当没设置，
 * 用户一旦回退到 v0.12.0 就等于设置清零。读的时候两种都认，写的时候只写下划线。
 * `undefined` 的项不写（旧壳 serde 缺字段 = None，语义相同）。
 */
export function serializeSettings(settings: DesktopSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value
  }
  put('port', settings.port)
  put('active_profile', settings.activeProfile)
  put('remote_addr', settings.remoteAddr)
  if (settings.remoteList.length > 0) out.remote_list = settings.remoteList
  put('remote_session', settings.remoteSession)
  put('lane_port', settings.lanePort)
  put('cloudflared_bin', settings.cloudflaredBin)
  put('proxy_mode', settings.proxyMode)
  put('proxy_url', settings.proxyUrl)
  put('no_proxy', settings.noProxy)
  put('proxy_user', settings.proxyUser)
  put('proxy_pass', settings.proxyPass)
  put('download_concurrency', settings.downloadConcurrency)
  put('mux_heartbeat_ms', settings.muxHeartbeatMs)
  put('desktop_layout_on_phones', settings.desktopLayoutOnPhones)
  put('desktop_render_budget', settings.desktopRenderBudget)
  put('prevent_sleep', settings.preventSleep)
  put('profile_ports', settings.profilePorts)
  put('profile_lane_ports', settings.profileLanePorts)
  put('dsh_mode', settings.dshMode)
  put('dsh_runtime', settings.dshRuntime)
  put('runtime_source', settings.runtimeSource)
  put('runtime_github_repo', settings.runtimeGithubRepo)
  put('tunnel_url', settings.tunnelUrl)
  put('ws_keepalive_ms', settings.wsKeepaliveMs)
  put('ws_pong_timeout_ms', settings.wsPongTimeoutMs)
  out.notifications = {
    enabled: settings.notifications.enabled,
    dnd: {
      on: settings.notifications.dnd.on,
      from: settings.notifications.dnd.from,
      to: settings.notifications.dnd.to,
      suppress_fullscreen: settings.notifications.dnd.suppressFullscreen,
    },
    scenarios: Object.fromEntries(
      Object.entries(settings.notifications.scenarios).map(([id, entry]) => [id, { enabled: entry.enabled, sound: entry.sound }]),
    ),
  }
  return out
}

export interface ScenarioMeta {
  id: string
  group: string
  name: string
  desc: string
  defaultOn: boolean
}

/** 场景展示分组（顺序即设置页里出现的顺序）。 */
export const NOTIFICATION_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['g-run', '启动与服务'],
  ['g-win', '窗口与实例'],
  ['g-prof', 'Profile'],
  ['g-dl', '下载'],
  ['g-task', '任务'],
  ['g-cfg', '配置'],
]

/** 14 个通知场景（旧壳 `notify_policy::SCENARIOS` 的唯一事实源，逐条对齐）。 */
export const NOTIFICATION_SCENARIOS: readonly ScenarioMeta[] = [
  { id: 'startup.error', group: 'g-run', name: '启动受阻', desc: 'spawn 失败 · 自愈封顶', defaultOn: true },
  { id: 'runtime.switch', group: 'g-run', name: '运行时切换', desc: '内置 / 外部 dsh 切换结果', defaultOn: true },
  { id: 'runtime.download', group: 'g-run', name: '运行时下载', desc: '运行时下载开始 / 失败', defaultOn: true },
  { id: 'service.health', group: 'g-run', name: '服务健康', desc: '不可达 · 自动重启', defaultOn: true },
  { id: 'window.lifecycle', group: 'g-win', name: '窗口生命周期', desc: '窗口恢复 / 异常', defaultOn: false },
  { id: 'instance.lifecycle', group: 'g-win', name: '实例生命周期', desc: '端口认领冲突 / 归属提示', defaultOn: false },
  { id: 'profile.op', group: 'g-prof', name: 'Profile 操作', desc: '新建 / 迁移完成', defaultOn: true },
  { id: 'profile.error', group: 'g-prof', name: 'Profile 错误', desc: '启动失败 / 修复失败', defaultOn: true },
  { id: 'download.complete', group: 'g-dl', name: '下载完成', desc: '文件下载结束', defaultOn: true },
  { id: 'task.complete', group: 'g-task', name: '任务完成', desc: '失焦时提醒回来看看', defaultOn: true },
  { id: 'config.error', group: 'g-cfg', name: '配置错误', desc: 'token 无法识别等', defaultOn: true },
  { id: 'config.info', group: 'g-cfg', name: '配置提示', desc: '端口保存等低危信息', defaultOn: false },
  { id: 'dsh.approval', group: 'g-task', name: '等待审批', desc: 'dsh 会话等待你的审批确认', defaultOn: true },
  { id: 'dsh.error', group: 'g-task', name: '会话错误', desc: 'dsh 会话运行出错', defaultOn: true },
]

export function defaultNotifications(): NotificationsConfig {
  const scenarios: Record<string, NotificationScenarioConfig> = {}
  for (const meta of NOTIFICATION_SCENARIOS) {
    scenarios[meta.id] = { enabled: meta.defaultOn, sound: 'default' }
  }
  return {
    enabled: true,
    dnd: { on: false, from: '22:00', to: '08:00', suppressFullscreen: true },
    scenarios,
  }
}

export function defaultSettings(): DesktopSettings {
  return {
    activeProfile: DEFAULT_PROFILE,
    remoteList: [],
    downloadConcurrency: DEFAULT_DOWNLOAD_CONCURRENCY,
    muxHeartbeatMs: DEFAULT_MUX_HEARTBEAT_MS,
    desktopLayoutOnPhones: false,
    preventSleep: true,
    dshMode: 'builtin',
    runtimeSource: 'github',
    proxyMode: 'off',
    wsKeepaliveMs: 15_000,
    wsPongTimeoutMs: 10_000,
    notifications: defaultNotifications(),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 非空字符串；其余（含空串、空白串）当作"没设置"。 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 数字（含环境变量那种数字字符串）；非数字返回 undefined。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

function int(value: unknown, min: number, max: number): number | undefined {
  const numeric = toNumber(value)
  if (numeric === undefined) return undefined
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/** 端口：越界就当没设置（夹到 65535 没有意义），而不是静默改成一个奇怪的端口。 */
function port(value: unknown): number | undefined {
  const numeric = toNumber(value)
  if (numeric === undefined) return undefined
  const rounded = Math.round(numeric)
  return rounded < 1 || rounded > 65_535 ? undefined : rounded
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => text(entry)).filter((entry): entry is string => entry !== undefined)
}

function portMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim()
    const parsed = port(raw)
    if (name !== '' && parsed !== undefined) result[name] = parsed
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const parsed = text(value)
  return parsed !== undefined && (allowed as readonly string[]).includes(parsed) ? (parsed as T) : undefined
}

/** 通知配置：逐场景合并到 14 条默认表上——用户多写的键丢掉、少写的键补默认。 */
function notifications(value: unknown): NotificationsConfig {
  const fallback = defaultNotifications()
  if (!isRecord(value)) return fallback
  const dndRaw = isRecord(value.dnd) ? value.dnd : {}
  const scenariosRaw = isRecord(value.scenarios) ? value.scenarios : {}
  const scenarios: Record<string, NotificationScenarioConfig> = {}
  for (const meta of NOTIFICATION_SCENARIOS) {
    const entry = isRecord(scenariosRaw[meta.id]) ? (scenariosRaw[meta.id] as Record<string, unknown>) : {}
    scenarios[meta.id] = {
      enabled: bool(entry.enabled) ?? meta.defaultOn,
      sound: text(entry.sound) ?? 'default',
    }
  }
  return {
    enabled: bool(value.enabled) ?? fallback.enabled,
    dnd: {
      on: bool(dndRaw.on) ?? fallback.dnd.on,
      from: text(dndRaw.from) ?? fallback.dnd.from,
      to: text(dndRaw.to) ?? fallback.dnd.to,
      suppressFullscreen: bool(dndRaw.suppressFullscreen) ?? fallback.dnd.suppressFullscreen,
    },
    scenarios,
  }
}

/**
 * 任意 JSON → 可信设置。字段名同时接受驼峰（本仓）与下划线（旧壳 `desktop-settings.json`
 * 的 serde 命名）两种写法：同一份文件新旧壳都要读得懂。
 */
export function normalizeSettings(raw: unknown): DesktopSettings {
  if (!isRecord(raw)) return defaultSettings()
  const pick = (...names: string[]): unknown => {
    for (const name of names) {
      if (raw[name] !== undefined) return raw[name]
    }
    return undefined
  }
  const base = defaultSettings()
  const settings: DesktopSettings = {
    activeProfile: text(pick('activeProfile', 'active_profile')) ?? base.activeProfile,
    remoteList: stringList(pick('remoteList', 'remote_list')),
    downloadConcurrency: int(pick('downloadConcurrency', 'download_concurrency'), DOWNLOAD_CONCURRENCY_MIN, DOWNLOAD_CONCURRENCY_MAX) ?? base.downloadConcurrency,
    muxHeartbeatMs: int(pick('muxHeartbeatMs', 'mux_heartbeat_ms'), MUX_HEARTBEAT_MIN, MUX_HEARTBEAT_MAX) ?? base.muxHeartbeatMs,
    desktopLayoutOnPhones: bool(pick('desktopLayoutOnPhones', 'desktop_layout_on_phones')) ?? base.desktopLayoutOnPhones,
    preventSleep: bool(pick('preventSleep', 'prevent_sleep')) ?? base.preventSleep,
    dshMode: oneOf(pick('dshMode', 'dsh_mode'), DSH_MODES) ?? base.dshMode,
    runtimeSource: oneOf(pick('runtimeSource', 'runtime_source'), RUNTIME_SOURCES) ?? base.runtimeSource,
    proxyMode: oneOf(pick('proxyMode', 'proxy_mode'), PROXY_MODES) ?? base.proxyMode,
    wsKeepaliveMs: int(pick('wsKeepaliveMs', 'ws_keepalive_ms'), 0, 600_000) ?? base.wsKeepaliveMs,
    wsPongTimeoutMs: int(pick('wsPongTimeoutMs', 'ws_pong_timeout_ms'), 0, 600_000) ?? base.wsPongTimeoutMs,
    notifications: notifications(pick('notifications')),
  }
  const optionalText: Array<[keyof DesktopSettings, string[]]> = [
    ['remoteAddr', ['remoteAddr', 'remote_addr']],
    ['remoteSession', ['remoteSession', 'remote_session']],
    ['cloudflaredBin', ['cloudflaredBin', 'cloudflared_bin']],
    ['proxyUrl', ['proxyUrl', 'proxy_url']],
    ['noProxy', ['noProxy', 'no_proxy']],
    ['proxyUser', ['proxyUser', 'proxy_user']],
    ['proxyPass', ['proxyPass', 'proxy_pass']],
    ['dshRuntime', ['dshRuntime', 'dsh_runtime']],
    ['runtimeGithubRepo', ['runtimeGithubRepo', 'runtime_github_repo']],
    ['tunnelUrl', ['tunnelUrl', 'tunnel_url']],
  ]
  for (const [key, names] of optionalText) {
    const value = text(pick(...names))
    if (value !== undefined) (settings as unknown as Record<string, unknown>)[key] = value
  }
  const numberFields: Array<[keyof DesktopSettings, string[]]> = [
    ['port', ['port']],
    ['lanePort', ['lanePort', 'lane_port']],
  ]
  for (const [key, names] of numberFields) {
    const value = port(pick(...names))
    if (value !== undefined) (settings as unknown as Record<string, unknown>)[key] = value
  }
  const renderBudget = bool(pick('desktopRenderBudget', 'desktop_render_budget'))
  if (renderBudget !== undefined) settings.desktopRenderBudget = renderBudget
  const profilePorts = portMap(pick('profilePorts', 'profile_ports'))
  if (profilePorts !== undefined) settings.profilePorts = profilePorts
  const profileLanePorts = portMap(pick('profileLanePorts', 'profile_lane_ports'))
  if (profileLanePorts !== undefined) settings.profileLanePorts = profileLanePorts
  return settings
}

/** 生效 profile：环境变量 > 设置 > 默认（旧壳同优先级）。 */
export function activeProfile(settings: DesktopSettings, env: Record<string, string | undefined> = {}): string {
  const fromEnv = text(env.DSH_PROFILE)
  if (fromEnv !== undefined) return fromEnv
  return settings.activeProfile ?? DEFAULT_PROFILE
}

/** FNV-1a 64（旧壳 settings.rs:296-303：offset basis `0xcbf29ce484222325`、prime `0x100000001b3`，按 UTF-8 字节）。 */
export function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash
}

/** 默认上游端口（旧壳 default_port_for_profile：web 3080 / desktop 3081 / 其余 3082+散列%512）。 */
export function defaultPortForProfile(profile: string): number {
  if (profile === 'web') return 3080
  if (profile === 'desktop') return 3081
  return PORT_BASE_OTHER + Number(fnv1a64(profile) % 512n)
}

/** 默认 lane 端口（旧壳 default_lane_port_for_profile：web 3092 / desktop 3093 / 其余 3094+散列%512）。 */
export function defaultLanePortForProfile(profile: string): number {
  if (profile === 'web') return 3092
  if (profile === 'desktop') return 3093
  return LANE_BASE_OTHER + Number(fnv1a64(profile) % 512n)
}

/** 在 [base, base+1023] 里找第一个不在 taken 里的端口，溢出回绕（旧壳 assign_port_avoiding）。 */
export function assignPortAvoiding(base: number, taken: ReadonlySet<number> | readonly number[]): number {
  const used = taken instanceof Set ? taken : new Set(taken)
  for (let offset = 0; offset < PORT_AVOID_SPAN; offset += 1) {
    const candidate = base + offset
    if (!used.has(candidate)) return candidate
  }
  return base
}

/**
 * dsh 上游端口（旧壳 port_for_profile 的口径）：env > 用户配置的 profile_ports >（web 的遗留 `port`）
 * > 默认公式。给 `taken`（本会话已占端口）时非 web/desktop 会做 [base, base+1023] 避让——结果只活在
 * 会话内存（调用方自己记），不落盘：靠 FNV 确定性保证下次启动算出同一个值。
 */
export function profilePort(
  settings: DesktopSettings,
  profile: string,
  env: Record<string, string | undefined> = {},
  taken?: ReadonlySet<number>,
): number {
  const fromEnv = port(env.DSH_DESKTOP_PORT)
  if (fromEnv !== undefined) return fromEnv
  const perProfile = settings.profilePorts?.[profile]
  if (perProfile !== undefined) return perProfile
  if (profile === 'web' && settings.port !== undefined) return settings.port
  const base = defaultPortForProfile(profile)
  if (taken === undefined || profile === 'web' || profile === 'desktop') return base
  return assignPortAvoiding(base, taken)
}

/**
 * 手机访问 lane 端口（旧壳 lane_port_for_profile 的口径）：env > profile 专属 >（web 的遗留
 * `lane_port`）> 默认公式；`taken` 避让同上，同样不落盘。
 */
export function profileLanePort(
  settings: DesktopSettings,
  profile: string,
  env: Record<string, string | undefined> = {},
  taken?: ReadonlySet<number>,
): number {
  const fromEnv = port(env.DSH_MOBILE_LANE_PORT)
  if (fromEnv !== undefined) return fromEnv
  const perProfile = settings.profileLanePorts?.[profile]
  if (perProfile !== undefined) return perProfile
  if (profile === 'web' && settings.lanePort !== undefined) return settings.lanePort
  const base = defaultLanePortForProfile(profile)
  if (taken === undefined || profile === 'web' || profile === 'desktop') return base
  return assignPortAvoiding(base, taken)
}

/** `~` 前缀展开（旧壳 `expand_home`：DSH_HOME 带 `~` 时若不展开，壳与 dsh 会各写各的目录）。 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${home}/${path.slice(2)}`
  return path
}

/** 日志用的一行摘要：只报「非默认」的项，方便实机上确认设置真的被读到了。 */
export function settingsSummary(settings: DesktopSettings): string {
  const base = defaultSettings()
  const parts: string[] = []
  const push = (label: string, value: unknown, fallback: unknown): void => {
    if (value !== undefined && value !== fallback) parts.push(`${label}=${JSON.stringify(value)}`)
  }

/** 数字（含环境变量那种数字字符串）；非数字返回 undefined。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

function int(value: unknown, min: number, max: number): number | undefined {
  const numeric = toNumber(value)
  if (numeric === undefined) return undefined
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/** 端口：越界就当没设置（夹到 65535 没有意义），而不是静默改成一个奇怪的端口。 */
function port(value: unknown): number | undefined {
  const numeric = toNumber(value)
  if (numeric === undefined) return undefined
  const rounded = Math.round(numeric)
  return rounded < 1 || rounded > 65_535 ? undefined : rounded
}

  push('profile', settings.activeProfile, base.activeProfile)
  push('port', settings.port, undefined)
  push('lanePort', settings.lanePort, undefined)
  push('dshMode', settings.dshMode, base.dshMode)
  push('runtimeSource', settings.runtimeSource, base.runtimeSource)
  push('dshRuntime', settings.dshRuntime, undefined)
  push('proxyMode', settings.proxyMode, base.proxyMode)
  push('proxyUrl', settings.proxyUrl, undefined)
  push('downloadConcurrency', settings.downloadConcurrency, base.downloadConcurrency)
  push('muxHeartbeatMs', settings.muxHeartbeatMs, base.muxHeartbeatMs)
  push('preventSleep', settings.preventSleep, base.preventSleep)
  push('desktopLayoutOnPhones', settings.desktopLayoutOnPhones, base.desktopLayoutOnPhones)
  push('remoteAddr', settings.remoteAddr, undefined)
  if (settings.remoteList.length > 0) parts.push(`remoteList=${String(settings.remoteList.length)} 条`)
  if (settings.profilePorts !== undefined) parts.push(`profilePorts=${JSON.stringify(settings.profilePorts)}`)
  if (!settings.notifications.enabled) parts.push('notifications=off')
  const offScenarios = NOTIFICATION_SCENARIOS.filter(
    (meta) => (settings.notifications.scenarios[meta.id]?.enabled ?? meta.defaultOn) !== meta.defaultOn,
  )
  if (offScenarios.length > 0) parts.push(`通知场景改动=${String(offScenarios.length)}`)
  return parts.length === 0 ? '全默认' : parts.join(' ')
}
