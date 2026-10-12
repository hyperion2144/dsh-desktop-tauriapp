/**
 * profile 运维的 IO 层（旧壳 `profiles.rs` 的 `profile_health_check` / `repair_profile` /
 * `pnpm_install_profile` / `migrate_profile` 与 `commands.rs` 的 `test_proxy_connectivity`）。
 *
 * 规则（名称、排除项、启动裁决）在 `src/shared/profile-ops.ts`，这里只做真动作：
 * 读文件系统判断完整性、按排除规则复制目录树（保留软链）、用内置 pnpm 重建依赖、TCP 连代理。
 *
 * 迁移的红线（照抄旧壳）：
 *   · 目标 profile 正在被本壳使用（`active`）时**拒绝**迁移；
 *   · 目标已存在时必须 `overwrite`，且先把旧目标 `rename` 成 `<dest>.bak-<秒级时间戳>`；
 *   · `node_modules` 与 `.dsh-module-fallback` 不复制，依赖用 pnpm 重建；
 *   · 副本 `package.json` 的 `name` 改成 `dsh-profile-<dest>`（不再带源名）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, delimiter, dirname, join, relative, sep } from 'node:path'
import {
  MIGRATION_SKIP_DIRS,
  migrationSkips,
  migrationSummary,
  migratedPackageName,
  PROFILE_REQUIRED_FILES,
  normalizeProxyUrl,
  type MigrationStatus,
  type StartupHealth,
  type TaskSnapshot,
  EMPTY_TASK,
  dependencyMismatch,
  pnpmFromModulesYaml,
  type ProfileDependencyRow,
} from '../shared/profile-ops.ts'
import { parseSimpleYaml } from './settings-store.ts'
import { profileDirOf } from './profile-scaffold.ts'
import { ensureNodeShim, pickInstallerErrorTail, resolvePnpmCjs, tailLines } from './runtime-install.ts'

export interface ProfileHealth extends StartupHealth {
  /** 目录在磁盘上的绝对路径（诊断/修复用）。 */
  dir: string
}

/** 必需文件的解析校验：package.json 走 JSON，其余走极简 YAML（旧壳用 serde_json / serde_yaml）。 */
function parseFailure(path: string): boolean {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return true
  }
  // 用 basename 而不是 lastIndexOf('/')：Windows 上路径分隔符是反斜杠，手抠会把整条路径当成文件名
  const name = basename(path)
  if (name === 'package.json') {
    try {
      JSON.parse(text)
      return false
    } catch {
      return true
    }
  }
  // pnpm-workspace.yaml / cordis.yml / cordis.patch.yml：能被极简 YAML 读成一行行键值即可
  try {
    parseSimpleYaml(text)
    return false
  } catch {
    return true
  }
}

export function profileHealth(home: string, profile: string): ProfileHealth {
  const dir = profileDirOf(home, profile)
  if (!existsSync(dir)) {
    return { dir, dirExists: false, missingFiles: [], nodeModulesExists: false }
  }
  const missing: string[] = []
  for (const file of PROFILE_REQUIRED_FILES) {
    const path = join(dir, file)
    if (!existsSync(path) || parseFailure(path)) missing.push(file)
  }
  return { dir, dirExists: true, missingFiles: missing, nodeModulesExists: existsSync(join(dir, 'node_modules')) }
}

export interface InstallResult {
  ok: boolean
  /** 失败时的错误尾巴（pnpm 的 ERR_* 常打 stdout，这里已择一）。 */
  error: string
}

export interface InstallProfileInput {
  home: string
  profile: string
  appSupport: string
  /** 当前生效运行时树（找 pnpm.cjs 用）。 */
  runtimeRoot?: string | null
  builtinDir?: string | null
  bunPath?: string
  env?: Record<string, string | undefined>
  /** 迁移重建用 true（lockfile 常落后于 package.json）。 */
  preferOffline?: boolean
  log?: (line: string) => void
  timeoutMs?: number
}

const INSTALL_TIMEOUT_MS = 15 * 60_000

/**
 * 在 profile 目录里跑 `bun <pnpm.cjs> install --no-frozen-lockfile`（旧壳用内置 node + 内置 pnpm，
 * 新壳的包管理器跑在我们的 Bun 上，#211 的结论）。CI=true 防交互挂起；必须显式关 frozen。
 */
export async function installProfileDependencies(input: InstallProfileInput): Promise<InstallResult> {
  const log = input.log ?? ((): void => {})
  const env = input.env ?? process.env
  const dir = profileDirOf(input.home, input.profile)
  // 新建 profile 时目录还不存在：`Bun.spawn` 的 cwd 指向不存在的目录会直接抛 ENOENT（旧壳先 mkdir）。
  mkdirSync(dir, { recursive: true })
  const pnpmCjs = resolvePnpmCjs({
    env,
    runtimeRoot: input.runtimeRoot ?? null,
    builtinDir: input.builtinDir ?? null,
    appSupport: input.appSupport,
  })
  if (pnpmCjs === null) return { ok: false, error: '找不到 pnpm.cjs（可用 DSH_SHELL_PNPM 指定内置的那份）' }
  const bunPath = input.bunPath ?? process.execPath
  // pnpm 的构建脚本会找 PATH 上叫 node 的命令（node-pty 之类）：没有 node 就放 Bun 垫片
  const shimDir = ensureNodeShim({
    appSupport: input.appSupport,
    bunPath,
    hasNode: commandExists('node', env),
    log,
  })
  const pathParts = [shimDir, dirname(bunPath)].filter((part): part is string => part !== null && part !== '')
  const existing = env.PATH ?? env.Path ?? ''
  if (existing !== '') pathParts.push(existing)
  const args = ['install', '--no-frozen-lockfile']
  if (input.preferOffline === true) args.push('--prefer-offline')
  log(`profile 依赖重建：${dir}（pnpm = ${pnpmCjs}）`)
  const started = Date.now()
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    child = Bun.spawn([bunPath, pnpmCjs, ...args], {
      cwd: dir,
      env: { ...env, CI: 'true', PATH: pathParts.join(delimiter) },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: input.timeoutMs ?? INSTALL_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, error: `pnpm 起不来：${error instanceof Error ? error.message : String(error)}` }
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code === 0) {
    log(`profile 依赖重建完成：${input.profile}（${String(Math.round((Date.now() - started) / 1000))}s）`)
    return { ok: true, error: '' }
  }
  const tail = pickInstallerErrorTail(stderr, stdout)
  const message = tail === '' ? `${tailLines(stdout + stderr, 6)}` : tail
  log(`profile 依赖重建失败：exit=${String(code)}｜${message}`)
  return { ok: false, error: `依赖重建失败（内置 pnpm install）：${message}` }
}

function commandExists(command: string, env: Record<string, string | undefined>): boolean {
  const path = env.PATH ?? env.Path ?? ''
  if (path === '') return false
  for (const part of path.split(delimiter)) {
    if (part !== '' && existsSync(join(part, command))) return true
  }
  return false
}

export interface MigrationStats {
  files: number
  dirs: number
  links: number
  skipped: number
}

export interface TaskTracker {
  status(): TaskSnapshot
  migrationStatus(): MigrationStatus
  begin(kind: string, title: string, total: number): void
  stage(text: string): void
  tick(): void
  finish(error: string | null, result: string): void
}

/** 旧壳 `task_status` / `migration_status` 的那几个原子量，这里收成一个对象（设置面板轮询用）。 */
export function createTaskTracker(): TaskTracker {
  let task: TaskSnapshot = { ...EMPTY_TASK }
  return {
    status: () => ({ ...task }),
    migrationStatus: () => ({ running: task.running, copied: task.done, total: task.total }),
    begin: (kind, title, total) => {
      task = { ...EMPTY_TASK, running: true, kind, title, total }
    },
    stage: (text) => {
      task = { ...task, stage: text }
    },
    tick: () => {
      task = { ...task, done: task.done + 1 }
    },
    finish: (error, result) => {
      task = { ...task, running: false, finished: true, error: error ?? '', result: error === null ? result : '' }
    },
  }
}

/** 预统计可复制文件数（与 copyProfileTree 同一套排除规则，供进度条）。 */
export function countCopyableFiles(root: string, cur: string = root): number {
  let total = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(cur, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const name = entry.name
    const abs = join(cur, name)
    const rel = relative(root, abs).split(sep).join('/')
    if ((MIGRATION_SKIP_DIRS as readonly string[]).includes(rel)) continue
    const isDir = entry.isDirectory()
    if (migrationSkips(rel, name, isDir)) continue
    if (entry.isSymbolicLink()) {
      total += 1
      continue
    }
    if (isDir) total += countCopyableFiles(root, abs)
    else total += 1
  }
  return total
}

/** 复制目录树：保留软链（不跟进去）、跳过排除项、每个文件回调一次进度。 */
export function copyProfileTree(
  root: string,
  dstRoot: string,
  stats: MigrationStats,
  onFile: () => void,
  cur: string = root,
): void {
  mkdirSync(dstRoot, { recursive: true })
  stats.dirs += 1
  const entries = readdirSync(cur, { withFileTypes: true })
  for (const entry of entries) {
    const name = entry.name
    const abs = join(cur, name)
    const rel = relative(root, abs).split(sep).join('/')
    if ((MIGRATION_SKIP_DIRS as readonly string[]).includes(rel)) continue
    const isDir = entry.isDirectory()
    if (migrationSkips(rel, name, isDir)) {
      stats.skipped += 1
      continue
    }
    const target = join(dstRoot, name)
    if (entry.isSymbolicLink()) {
      const link = readlinkSafe(abs)
      if (link === null) {
        stats.skipped += 1
        continue
      }
      try {
        rmSync(target, { force: true, recursive: false })
        symlinkSync(link, target)
        stats.links += 1
      } catch {
        stats.skipped += 1
      }
      continue
    }
    if (isDir) {
      copyProfileTree(root, target, stats, onFile, abs)
      continue
    }
    try {
      writeFileSync(target, readFileSync(abs))
      stats.files += 1
      onFile()
    } catch {
      stats.skipped += 1
    }
  }
}

function readlinkSafe(path: string): string | null {
  try {
    if (!statSync(path, { throwIfNoEntry: false })) return null
    return readlinkSync(path)
  } catch {
    return null
  }
}

export interface MigrateProfileInput {
  home: string
  source: string
  dest: string
  overwrite: boolean
  /** 当前被本壳使用的 profile：等于 dest 时拒绝（旧壳行为）。 */
  activeProfile: string | null
  install: () => Promise<InstallResult>
  log?: (line: string) => void
  now?: () => number
  track?: TaskTracker
}

/** 迁移 profile（旧壳 `migrate_profile_inner`）。返回给页面的一句话总结。 */
export async function migrateProfile(input: MigrateProfileInput): Promise<string> {
  const log = input.log ?? ((): void => {})
  const track = input.track
  const fail = (message: string): never => {
    track?.finish(message, '')
    throw new Error(message)
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(input.source) || !/^[A-Za-z0-9_-]{1,32}$/.test(input.dest)) {
    return fail('名称仅允许字母、数字、_ 与 -（1-32 字符）')
  }
  if (input.activeProfile !== null && input.dest === input.activeProfile) {
    return fail(`目标 profile ${input.dest} 正在使用，拒绝迁移（请先切换到其他 profile）`)
  }
  const profilesRoot = join(input.home, 'profiles')
  const srcDir = join(profilesRoot, input.source)
  const dstDir = join(profilesRoot, input.dest)
  if (!existsSync(join(srcDir, 'package.json'))) {
    return fail(`源 profile ${input.source} 不存在或缺少 package.json`)
  }
  let backup: string | null = null
  if (existsSync(dstDir)) {
    if (!input.overwrite) return fail(`目标 profile ${input.dest} 已存在（需确认覆盖）`)
    const stamp = Math.floor((input.now?.() ?? Date.now()) / 1000)
    const bak = join(profilesRoot, `${input.dest}.bak-${String(stamp)}`)
    try {
      renameSync(dstDir, bak)
    } catch (error) {
      return fail(`备份旧目标失败：${error instanceof Error ? error.message : String(error)}`)
    }
    backup = bak
  }
  const total = countCopyableFiles(srcDir)
  track?.begin('migrate', `迁移 ${input.source} → ${input.dest}`, total)
  track?.stage('统计完成，开始复制文件')
  const stats: MigrationStats = { files: 0, dirs: 0, links: 0, skipped: 0 }
  try {
    copyProfileTree(srcDir, dstDir, stats, () => track?.tick())
  } catch (error) {
    return fail(`复制失败：${error instanceof Error ? error.message : String(error)}`)
  }
  track?.stage('复制完成，重建依赖（pnpm install）')
  // 副本的包名换成目标 profile（旧壳 #90：不再携带源名）
  const manifest = join(dstDir, 'package.json')
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
      pkg.name = migratedPackageName(input.dest)
      writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
    } catch (error) {
      return fail(`写入 package.json 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const installed = await input.install()
  if (!installed.ok) return fail(installed.error)
  const summary = migrationSummary({
    source: input.source,
    dest: input.dest,
    files: stats.files,
    dirs: stats.dirs,
    links: stats.links,
    skipped: stats.skipped,
    backup,
  })
  log(`[migrate] ${summary}`)
  track?.finish(null, summary)
  return summary
}

/**
 * 代理连通性测试（旧壳 `test_proxy_connectivity`）：TCP connect，3s 超时，返回耗时 ms。
 *
 * `connectImpl` 只为单测注入（默认就是 `Bun.connect`）：超时分支在真实网络里很难稳定复现
 * （本机带 TUN 类代理时，对任意 IP 的 connect 都会秒回成功），所以必须能换成「永不完成」的桩。
 */
export async function testProxyConnectivity(
  raw: string,
  timeoutMs = 3_000,
  connectImpl: (input: { hostname: string; port: number }) => Promise<{ end: () => void }> = (input) =>
    Bun.connect({
      hostname: input.hostname,
      port: input.port,
      socket: { data: () => {}, open: () => {}, error: () => {} },
    }),
): Promise<number> {
  const parsed = normalizeProxyUrl(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  const { host, port } = parsed.target
  const started = Date.now()
  const connect = connectImpl({ hostname: host.startsWith('[') ? host.slice(1, -1) : host, port })
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`连接 ${host}:${String(port)} 超时（${String(Math.round(timeoutMs / 1000))}s）`)), timeoutMs)
  })
  try {
    const socket = await Promise.race([connect, timeout])
    socket.end()
    return Date.now() - started
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('超时')) throw error instanceof Error ? error : new Error(message)
    throw new Error(`连接 ${host}:${String(port)} 失败：${message}`)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 该 profile 的 node_modules 记录的 pnpm 版本（旧壳 `profiles::profile_recorded_pnpm`）。 */
export function readRecordedPnpm(home: string, profile: string): string | null {
  try {
    const text = readFileSync(join(profileDirOf(home, profile), 'node_modules', '.modules.yaml'), 'utf8')
    return pnpmFromModulesYaml(text)
  } catch {
    return null
  }
}

/** 内置 pnpm 的版本号（读 `pnpm.cjs` 上层 package.json；找不到回 null）。 */
export function builtinPnpmVersion(input: {
  env?: Record<string, string | undefined>
  runtimeRoot?: string | null
  builtinDir?: string | null
  appSupport: string
}): string | null {
  const pnpmCjs = resolvePnpmCjs({
    env: input.env ?? process.env,
    runtimeRoot: input.runtimeRoot ?? null,
    builtinDir: input.builtinDir ?? null,
    appSupport: input.appSupport,
  })
  if (pnpmCjs === null) return null
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(pnpmCjs)), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** `list_profile_dependency_status` 的行（旧壳只比 pnpm 大版本，小版本差异 store 同代）。 */
export function profileDependencyRows(input: {
  home: string
  profiles: readonly string[]
  builtinPnpm: string | null
  running: (profile: string) => boolean
}): ProfileDependencyRow[] {
  return input.profiles.map((profile) => {
    const recorded = readRecordedPnpm(input.home, profile)
    return {
      profile,
      recordedPnpm: recorded,
      builtinPnpm: input.builtinPnpm,
      needsRebuild: dependencyMismatch(recorded, input.builtinPnpm),
      running: input.running(profile),
    }
  })
}
