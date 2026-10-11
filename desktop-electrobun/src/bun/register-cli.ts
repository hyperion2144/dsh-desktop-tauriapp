// dsh 系统命令注册的 IO 外壳（旧壳 `desktop/src-tauri/src/register/` 的等价物）。
//
// 三件事：
//   1. 维护 shim：`<appSupport>/runtime/bin-dsh/dsh[.cmd]`，内容永远指向**当前**运行时的 dsh 入口
//      （运行时切了要重写；内容不是我们写的（foreign）就不动）；
//   2. 探测：spawn 用户**真实登录 shell** 解析 `dsh`（GUI 进程的 PATH 不等于终端 PATH），
//      与本壳 shim 比 realpath 得三态；超时/失败就是「没探出来」，保持旧缓存；
//   3. 注册：macOS 走 `osascript … with administrator privileges` 提权 `ln -sfn`（冲突要 force）。
//
// 缓存与并发：菜单重建很频繁，所以状态缓存起来（`CACHE_TTL_MS`），刷新在后台跑且
// 同一时刻只跑一个——**调用方绝不能同步等探测**。
import {
  CACHE_TTL_MS,
  CONFLICT_MARKER,
  DETECT_COMMAND,
  DETECT_ENV,
  DETECT_TIMEOUT_MS,
  appleEscape,
  classifyResolution,
  classifyShim,
  describeRegisterState,
  extractLastNonEmptyLine,
  parseUserShell,
  registrationScript,
  shimPathOf,
  shimScript,
  type RegisterKind,
  type RegisterState,
  type ShimVerdict,
} from '../shared/register-cli.ts'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export type RunImpl = (argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }) => RunResult

export interface RegisterCliOptions {
  log: (message: string) => void
  appSupport: string
  /** 当前运行时的 dsh 启动命令（可执行 + 参数）；运行时切换后 shim 会按它重写 */
  shellCommand: () => readonly string[] | null
  platform?: string
  env?: Record<string, string | undefined>
  run?: RunImpl
  readText?: (path: string) => string | null
  writeText?: (path: string, text: string, mode?: number) => void
  exists?: (path: string) => boolean
  realpath?: (path: string) => string | null
  home?: string
  username?: string
  now?: () => number
}

export interface RegisterResult {
  ok: boolean
  /** canceled = 用户在系统授权弹窗点了取消（中性结果，系统未改动） */
  code?: 'canceled' | 'conflict' | 'unsupported' | 'error'
  message: string
}

export interface RegisterCli {
  cached: () => RegisterState
  /** 异步探测（带 in-flight 去重 + TTL）；返回最新缓存 */
  refresh: (options?: { force?: boolean }) => Promise<RegisterState>
  /** 物化/维护 shim，返回路径与判词 */
  ensureShim: () => { path: string; verdict: ShimVerdict }
  register: (options?: { force?: boolean }) => Promise<RegisterResult>
  describe: () => string
}

const EMPTY_STATE: RegisterState = { kind: 'unknown', resolved: null, shimReady: false, at: 0 }

export function createRegisterCli(options: RegisterCliOptions): RegisterCli {
  const platform = options.platform ?? process.platform
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const now = options.now ?? Date.now
  const shimPath = shimPathOf(options.appSupport, platform)
  const run = options.run ?? defaultRun
  const readText = options.readText ?? defaultReadText
  const writeText = options.writeText ?? defaultWriteText
  const exists = options.exists ?? defaultExists
  const realpath = options.realpath ?? defaultRealpath

  let cached: RegisterState = { ...EMPTY_STATE }
  let inflight: Promise<RegisterState> | null = null
  let lastAt = 0

  function ensureShim(): { path: string; verdict: ShimVerdict } {
    const argv = options.shellCommand()
    if (argv === null || argv.length === 0) return { path: shimPath, verdict: 'absent' }
    const expected = shimScript(platform, argv)
    const verdict = classifyShim(readText(shimPath), expected)
    if (verdict === 'ours') return { path: shimPath, verdict }
    if (verdict === 'foreign') {
      options.log(`[register] shim 位置被别的程序占着，不覆盖：${shimPath}`)
      return { path: shimPath, verdict }
    }
    try {
      writeText(shimPath, expected, 0o755)
      options.log(`[register] shim 已${verdict === 'stale' ? '更新' : '写入'}：${shimPath} → ${argv.join(' ')}`)
      return { path: shimPath, verdict: verdict === 'stale' ? 'stale' : 'ours' }
    } catch (error) {
      options.log(`[register] shim 写入失败：${String(error)}`)
      return { path: shimPath, verdict: 'absent' }
    }
  }

  /** 用户真实登录 shell（macOS 用 dscl 问系统，回落到 $SHELL，再回落 /bin/zsh）。 */
  function userShell(): string {
    if (platform === 'darwin') {
      const username = options.username ?? env.USER ?? ''
      if (username !== '') {
        const out = run(['/usr/bin/dscl', '.', '-read', `/Users/${username}`, 'UserShell'], { timeoutMs: 4_000 })
        const parsed = out.status === 0 ? parseUserShell(out.stdout) : null
        if (parsed !== null) return parsed
      }
    }
    return env.SHELL ?? (platform === 'win32' ? 'cmd.exe' : '/bin/zsh')
  }

  /** 解析用户环境里的 dsh；`undefined` = 探测不确定（超时/失败），调用方保持旧缓存。 */
  function resolveInUserEnv(): string | null | undefined {
    if (platform === 'win32') {
      const out = run(['where', 'dsh'], { timeoutMs: DETECT_TIMEOUT_MS })
      if (out.status !== 0 && out.stdout.trim() === '') return null
      const first = out.stdout.split(/\r?\n/).find((line) => line.trim() !== '')
      return first === undefined ? null : first.trim()
    }
    const shell = userShell()
    const out = run([shell, '-ilc', DETECT_COMMAND], { env: DETECT_ENV, timeoutMs: DETECT_TIMEOUT_MS })
    // 超时/起不来：`-ilc` 正常返回非零是「没找到」，这里用 124 之类区分不开 ⇒ 用信号判据
    if (out.status === 124 || out.status === 137) return undefined
    const line = extractLastNonEmptyLine(out.stdout)
    if (line === null || line === '') return null
    // 非 '/' 开头 = alias/function 命中：不是可执行文件路径，但仍算「解析到了别人」
    return line
  }

  function classify(): RegisterState {
    const shim = ensureShim()
    const shimReady = shim.verdict !== 'absent' && exists(shimPath)
    const resolved = resolveInUserEnv()
    if (resolved === undefined) {
      // 探测不确定：保留旧结论，只更新时间戳
      return { ...cached, at: now() }
    }
    const normalizedResolved = resolved === null ? null : (realpath(resolved) ?? resolved)
    const normalizedShim = realpath(shimPath) ?? shimPath
    const kind: RegisterKind = classifyResolution({
      shimPath: normalizedShim,
      shimReady,
      resolved: normalizedResolved,
      platform,
    })
    return { kind, resolved: normalizedResolved, shimReady, at: now() }
  }

  async function refresh(refreshOptions: { force?: boolean } = {}): Promise<RegisterState> {
    const fresh = refreshOptions.force !== true && now() - lastAt < CACHE_TTL_MS && cached.kind !== 'unknown'
    if (fresh) return cached
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const next = classify()
        lastAt = now()
        const changed = next.kind !== cached.kind || next.resolved !== cached.resolved
        cached = next
        if (changed) options.log(`[register] 注册状态：${describeRegisterState(next)}`)
        return cached
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  async function register(registerOptions: { force?: boolean } = {}): Promise<RegisterResult> {
    const shim = ensureShim()
    if (shim.verdict === 'absent') {
      return { ok: false, code: 'error', message: `shim 没写成功：${shimPath}` }
    }
    if (platform !== 'darwin') {
      return {
        ok: false,
        code: 'unsupported',
        message: `这个平台还没接注册执行（${platform}）：shim 在 ${shimPath}，可手动加进 PATH`,
      }
    }
    const script = registrationScript({ shim: shimPath, force: registerOptions.force === true })
    const out = run(
      ['/usr/bin/osascript', '-e', `do shell script "${appleEscape(script)}" with administrator privileges`],
      { timeoutMs: 120_000 },
    )
    void refresh({ force: true })
    if (out.status === 0) {
      return { ok: true, message: `已注册：/usr/local/bin/dsh → ${shimPath}` }
    }
    const stderr = out.stderr
    if (stderr.includes('-128') || stderr.includes('User canceled') || stderr.includes('用户已取消')) {
      return { ok: false, code: 'canceled', message: '你取消了系统授权，没有改动' }
    }
    if (stderr.includes(CONFLICT_MARKER)) {
      return {
        ok: false,
        code: 'conflict',
        message: '/usr/local/bin/dsh 已存在且不是本壳入口——再点一次会强制覆盖（原来的会带时间戳备份）',
      }
    }
    return { ok: false, code: 'error', message: `提权执行失败：${stderr.trim() || `exit ${String(out.status)}`}` }
  }

  return {
    cached: () => cached,
    refresh,
    ensureShim,
    register,
    describe: () => describeRegisterState(cached),
  }
}

const defaultRun: RunImpl = (argv, runOptions = {}) => {
  const result = Bun.spawnSync({
    cmd: argv,
    env: { ...process.env, ...(runOptions.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: runOptions.timeoutMs ?? DETECT_TIMEOUT_MS,
  })
  return {
    status: result.exitCode ?? 124,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultWriteText(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

function defaultExists(path: string): boolean {
  return existsSync(path)
}

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
