/**
 * profile 运维与代理连通性的纯逻辑（旧壳 `profiles.rs` / `network/proxy.rs` / `commands.rs` 的等价物）。
 *
 * 这里只放**不碰文件系统、不起进程**的判断：名称合法性、迁移排除规则、代理 URL 规范化、
 * 启动检查的裁决。真正的复制/安装/连接在 `src/bun/profile-manager.ts`。
 *
 * 为什么要有这一层：设置面板的「Profile 端口 / 迁移 Profile / 依赖重建 / 测试连接」与启动时的
 * profile 选择弹窗都靠这几个判断，规则写错会直接毁用户的 profile（迁移会覆盖目标目录），所以
 * 规则必须能被单测钉住。
 */

/** 旧壳 `valid_profile_name`：字母/数字/`_`/`-`，1–32 字符。 */
export function validProfileName(name: string): boolean {
  if (name.length === 0 || name.length > 32) return false
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/** profile 完整性的四个必需文件（旧壳 `profile_health_check` 逐项验的就是这四个）。 */
export const PROFILE_REQUIRED_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'cordis.yml',
  'cordis.patch.yml',
] as const

/**
 * 迁移时跳过的条目（旧壳 `migration_skips`）：锁/临时/编辑器残留、`cordis.yml`（启动即重写）、
 * `.plugin-manager/logs`（诊断日志）、绝对符号链接目录。
 */
export function migrationSkips(rel: string, fileName: string, isDir: boolean): boolean {
  if (fileName === '.DS_Store' || fileName === 'cordis.yml' || fileName.startsWith('._')) return true
  for (const suffix of ['.lock', '.pid', '.tmp', '.swp']) {
    if (fileName.endsWith(suffix)) return true
  }
  if (rel.startsWith('.plugin-manager/logs')) return true
  if (isDir && fileName === '.cache' && rel.startsWith('node_modules')) return true
  return false
}

/** 迁移时整目录不进的（旧壳 `copy_dir_filtered` 的两条硬排除）。 */
export const MIGRATION_SKIP_DIRS = ['node_modules', '.dsh-module-fallback'] as const

export interface ProxyTarget {
  /** 规范化后的 URL：`<scheme>://<host>:<port>`（socks 统一写成 socks5）。 */
  url: string
  /** 供 TCP connect 用：host（IPv6 带方括号）。 */
  host: string
  port: number
}

/**
 * 规范化代理 URL（旧壳 `normalize_proxy_url` + `proxy_url_from_authority`）：
 * 只认 http/https/socks5/socks；多粘贴的路径/查询/锚点丢掉；端口缺省按 scheme 补
 * （https 443 / socks 1080 / http 80）；裸 IPv6 补方括号。
 */
export function normalizeProxyUrl(raw: string): { ok: true; target: ProxyTarget } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: '代理地址为空' }
  const split = trimmed.indexOf('://')
  if (split < 0) return { ok: false, error: `代理 URL 非法（需 http/https/socks5://host:port）：${raw}` }
  const rawScheme = trimmed.slice(0, split).toLowerCase()
  if (!['http', 'https', 'socks5', 'socks'].includes(rawScheme)) {
    return { ok: false, error: `代理 URL 非法（需 http/https/socks5://host:port）：${raw}` }
  }
  const scheme = rawScheme === 'socks' ? 'socks5' : rawScheme
  const rest = trimmed.slice(split + 3)
  const authorityRaw = rest.split(/[/?#]/)[0] ?? ''
  // 有些来源会把 scheme 再写一遍（http://http://host:8080）
  const authority = (authorityRaw.includes('://') ? authorityRaw.slice(authorityRaw.indexOf('://') + 3) : authorityRaw).trim()
  if (authority === '') return { ok: false, error: `代理 URL 缺少主机：${raw}` }
  const { host, portText } = splitAuthority(authority)
  if (host === '') return { ok: false, error: `代理 URL 缺少主机：${raw}` }
  const defaultPort = scheme === 'https' ? '443' : scheme === 'socks5' ? '1080' : '80'
  const portValue = portText === null || portText === '' ? defaultPort : portText
  const port = Number.parseInt(portValue, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `代理 URL 端口非法：${portValue}` }
  }
  // 裸 IPv6（`::1`）补方括号；同一位置出现冒号但不是 IP 字面量的（`:8080`、`host:abc`）直接判非法
  if (host.includes(':') && !host.startsWith('[')) {
    const colons = host.split(':').length - 1
    if (colons < 2 || !/^[0-9A-Fa-f:.]+$/.test(host)) return { ok: false, error: `代理 URL 主机非法：${raw}` }
  }
  const hostForConnect = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return { ok: true, target: { url: `${scheme}://${hostForConnect}:${String(port)}`, host: hostForConnect, port } }
}

/** 拆 authority（旧壳 `split_authority`）：支持 `[::1]:8080` 与 `host:8080`，端口必须是纯数字。 */
export function splitAuthority(authority: string): { host: string; portText: string | null } {
  const close = authority.indexOf(']')
  if (close >= 0) {
    const host = authority.slice(0, close + 1)
    const rest = authority.slice(close + 1)
    return { host, portText: rest.startsWith(':') ? rest.slice(1) : null }
  }
  const at = authority.lastIndexOf(':')
  if (at > 0) {
    const host = authority.slice(0, at)
    const port = authority.slice(at + 1)
    // 末段是纯数字才算端口；host 可以是裸 IPv6（`::1:8080`），但不能是空或只剩冒号
    const hostOk = host.includes(':') ? host.replace(/:/g, '') !== '' : host !== ''
    if (hostOk && port !== '' && /^[0-9]+$/.test(port)) return { host, portText: port }
  }
  return { host: authority, portText: null }
}

/** 旧的 `task_status` / `migration_status` 共用的形状（设置面板的任务卡轮询它）。 */
export interface TaskSnapshot {
  running: boolean
  finished: boolean
  kind: string
  title: string
  stage: string
  done: number
  total: number
  error: string
  result: string
}

export const EMPTY_TASK: TaskSnapshot = {
  running: false,
  finished: false,
  kind: '',
  title: '',
  stage: '',
  done: 0,
  total: 0,
  error: '',
  result: '',
}

/** 迁移进度（旧壳 `migration_status` 只回这三个字段）。 */
export interface MigrationStatus {
  running: boolean
  copied: number
  total: number
}

export interface StartupHealth {
  dirExists: boolean
  missingFiles: readonly string[]
  nodeModulesExists: boolean
}

export interface StartupInput {
  /** 已经确认过（旧壳的 `skip_startup_check`）。 */
  skipCheck: boolean
  /** 全新安装（旧壳看 `settings_path().exists()`）。 */
  freshInstall: boolean
  activeProfile: string | null
  profiles: readonly string[]
  health: StartupHealth
  /** 当前实际要检查的 profile（旧壳 `configured_profile()`）。 */
  profile: string
}

export type StartupDecision =
  | { action: 'none' }
  | { action: 'profile-selection'; profiles: string[] }
  | { action: 'profile-incomplete'; profile: string; details: StartupHealth }

/**
 * 启动检查的裁决（旧壳 `check_startup_needed`）：
 * ① 已确认过 → none；② 存量安装且没设 active_profile → 让用户选 profile；
 * ③ 当前 profile 缺目录/缺文件/没 node_modules → 让用户确认修复。
 */
export function startupAction(input: StartupInput): StartupDecision {
  if (input.skipCheck) return { action: 'none' }
  const active = input.activeProfile
  if (!input.freshInstall && (active === null || active === '')) {
    return { action: 'profile-selection', profiles: [...input.profiles] }
  }
  const health = input.health
  if (!health.dirExists || health.missingFiles.length > 0 || !health.nodeModulesExists) {
    return {
      action: 'profile-incomplete',
      profile: input.profile,
      details: { dirExists: health.dirExists, missingFiles: [...health.missingFiles], nodeModulesExists: health.nodeModulesExists },
    }
  }
  return { action: 'none' }
}

/** 迁移结果的一句话总结（旧壳的 summary 文案，字段顺序照抄）。 */
export function migrationSummary(input: {
  source: string
  dest: string
  files: number
  dirs: number
  links: number
  skipped: number
  backup: string | null
}): string {
  return `已迁移 ${input.source} → ${input.dest}：文件 ${String(input.files)}、目录 ${String(input.dirs)}、链接 ${String(input.links)}、排除 ${String(input.skipped)}${input.backup === null ? '' : `；旧目标已备份为 ${input.backup}`}`
}

/** 迁移后目标 profile 的包名（旧壳把副本 package.json 的 name 改成这个，不再带源名）。 */
export function migratedPackageName(dest: string): string {
  return `dsh-profile-${dest}`
}

/** 从 `.modules.yaml` 里抠出 pnpm 版本（旧壳 `profiles::profile_recorded_pnpm` 的行级判据）。 */
export function pnpmFromModulesYaml(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const rest = trimmed.startsWith('"packageManager":')
      ? trimmed.slice('"packageManager":'.length)
      : trimmed.startsWith('packageManager:')
        ? trimmed.slice('packageManager:'.length)
        : null
    if (rest === null) continue
    const raw = rest.trim().replace(/,$/, '').trim().replace(/^"/, '').replace(/"$/, '')
    if (raw.startsWith('pnpm@')) return raw.slice('pnpm@'.length)
  }
  return null
}

/** pnpm 大版本（旧壳 #124：只比 major，小版本差异 store 同代、不触发 UNEXPECTED_STORE）。 */
export function pnpmMajor(version: string): string {
  const [head] = version.split('.')
  return head === undefined || head === '' ? version : head
}

/** 依赖树是否与内置 pnpm 不同代（任一侧读不到就不判不一致）。 */
export function dependencyMismatch(recorded: string | null, builtin: string | null): boolean {
  if (recorded === null || builtin === null) return false
  return pnpmMajor(recorded) !== pnpmMajor(builtin)
}

/** `list_profile_dependency_status` 的一行（设置面板的依赖卡逐行渲染它）。 */
export interface ProfileDependencyRow {
  profile: string
  recordedPnpm: string | null
  builtinPnpm: string | null
  needsRebuild: boolean
  running: boolean
}
