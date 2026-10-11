// `--patch` 注入清单（旧壳的 `desktop-plugin-inject.yml`）。
//
// 迁移自旧壳 `desktop/src-tauri/src/process/plugin.rs`（`desktop_plugin_patch_path` 及其
// 两个块构造函数 `gateway_patch_block` / `mobile_layout_insert_block`，:78-198）。
// 这份文件交给 dsh 的 `--patch` 覆盖层，做三件事：
//   1. 给 connection 行补 inject —— 上游 web profile 的 connection 条目缺注入时，
//      `rpc.handle` 注册的 channel 不会挂到 HTTP 路由（浏览器侧 transport failure）；
//   2. 覆盖网关 mux 心跳 —— dsh 默认 2s Ping + 连丢 2 次 terminate，移动端切后台/弱网
//      数秒就被判死（页面常常收不到 close，表现为「能发消息、收不到新消息」）；
//   3. 插入壳自己的插件行（桌面壳插件 + 手机访问 [+ 移动布局]）。
//
// 纯逻辑：路径与写盘在 `src/bun/plugin-staging.ts`。

/** dsh 网关心跳的默认覆盖值（旧壳 `settings.rs` 同值）。0/未设 = 不覆盖。 */
export const DEFAULT_MUX_HEARTBEAT_MS = 30_000

/** 上游从这一版起移除 `webRuntime` 服务（dsh-web-app 改读 `webStartup`）。 */
export const WEB_STARTUP_MIN = '0.2.1-alpha.2'

interface Parsed {
  core: [number, number, number]
  pre: string[]
}

/** 解析 `x.y.z[-pre]`；多段 core、非数字段一律失败（与旧壳同样保守）。 */
function parseVersion(value: string): Parsed | null {
  const trimmed = value.trim().replace(/^v/, '')
  if (trimmed === '') return null
  const dash = trimmed.indexOf('-')
  const coreText = dash === -1 ? trimmed : trimmed.slice(0, dash)
  const preText = dash === -1 ? '' : trimmed.slice(dash + 1)
  const parts = coreText.split('.')
  if (parts.length !== 3) return null
  const core: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    core.push(Number(part))
  }
  return {
    core: [core[0] ?? 0, core[1] ?? 0, core[2] ?? 0],
    pre: preText === '' ? [] : preText.split('.'),
  }
}

/** 预发布段点分比较：纯数字段按数值，其余按字符串（`alpha.10 > alpha.2`）。 */
function preSegmentsAtLeast(value: string[], min: string[]): boolean {
  const key = (part: string | undefined): [number, string] =>
    part === undefined ? [0, ''] : /^\d+$/.test(part) ? [Number(part), ''] : [0, part]
  const length = Math.max(value.length, min.length)
  for (let index = 0; index < length; index += 1) {
    const left = key(value[index])
    const right = key(min[index])
    if (left[0] !== right[0] || left[1] !== right[1]) {
      return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1]
    }
  }
  return true
}

/** `version >= min`：core 三段数字比较，相等时比预发布段；解析失败一律判否。 */
export function versionAtLeast(version: string, min: string): boolean {
  const left = parseVersion(version)
  const right = parseVersion(min)
  if (left === null || right === null) return false
  for (let index = 0; index < 3; index += 1) {
    const a = left.core[index] ?? 0
    const b = right.core[index] ?? 0
    if (a !== b) return a > b
  }
  if (left.pre.length === 0) return true
  if (right.pre.length === 0) return false
  return preSegmentsAtLeast(left.pre, right.pre)
}

/**
 * connection 行的 inject 列表，随运行时版本切换两代契约。
 * 版本未知（空串/解析失败）保守回旧契约，与旧壳行为一致。
 */
export function connectionInjectList(runtimeVersion: string | undefined): string {
  return versionAtLeast(runtimeVersion ?? '', WEB_STARTUP_MIN)
    ? '[webStartup, webServer]'
    : '[webRuntime, webServer]'
}

/** 网关心跳覆盖块；`undefined` / `0` 表示不覆盖（dsh 用自己的默认值）。 */
export function gatewayPatchBlock(heartbeatMs: number | undefined): string {
  if (heartbeatMs === undefined || heartbeatMs <= 0) return ''
  return `\n- id: typert-gateway\n  config:\n    websocketHeartbeatIntervalMs: ${String(heartbeatMs)}\n`
}

/** 移动布局插件的包名（上游 v2.3.0 起由 `@dsh-external/dsh-mobile-nav` 改名）。 */
export const MOBILE_LAYOUT_PACKAGE = 'dsh-web-mobile'

export interface InsertRow {
  id: string
  name: string
}

export interface InjectYmlInput {
  /** 选中运行时的版本号（决定 connection 两代契约） */
  runtimeVersion?: string
  /** 网关 mux 心跳覆盖（毫秒）；0/undefined = 不覆盖 */
  muxHeartbeatMs?: number
  /** 要插入的插件行；只放**真的物化过**的包，缺包不写行（否则 dsh 会解析失败） */
  rows: InsertRow[]
}

/**
 * 整份注入清单。`rows` 的顺序即插入顺序：桌面壳插件在前、手机访问次之、移动布局最后。
 * 一个 row 都没有时仍然写 connection 与心跳覆盖——那两件与插件无关。
 */
export function injectYml(input: InjectYmlInput): string {
  const inject = connectionInjectList(input.runtimeVersion)
  const gateway = gatewayPatchBlock(input.muxHeartbeatMs)
  const rows = input.rows.map((row) => `    - id: ${row.id}\n      name: ${row.name}\n`).join('')
  const head = `- id: connection\n  inject: ${inject}\n${gateway}`
  return rows === '' ? head : `${head}- insert:\n${rows}`
}

/** 依据「手机布局」设置决定最终的行序（含移动布局时排在最后）。 */
export function insertRows(input: {
  desktopPlugin?: string
  mobileAccess?: string
  mobileLayout?: string
  desktopLayoutOnPhones?: boolean
}): InsertRow[] {
  const rows: InsertRow[] = []
  if (input.desktopPlugin !== undefined) rows.push({ id: input.desktopPlugin, name: input.desktopPlugin })
  if (input.mobileAccess !== undefined) rows.push({ id: input.mobileAccess, name: input.mobileAccess })
  if (input.mobileLayout !== undefined && input.desktopLayoutOnPhones !== true) {
    rows.push({ id: input.mobileLayout, name: input.mobileLayout })
  }
  return rows
}
