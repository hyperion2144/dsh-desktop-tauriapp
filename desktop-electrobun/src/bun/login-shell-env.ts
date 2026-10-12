// 登录 shell 环境：从 Finder / LaunchServices 启动的进程只继承 launchd 的最小环境
// （PATH=/usr/bin:/bin:/usr/sbin:/sbin），于是 dsh 子进程里 `gh`、`bun`、`node`、pnpm 这些装在
// Homebrew / ~/.bun / pnpm 目录里的工具全部「找不到」——旧 Tauri 壳也会遇到，官方 Electron 桌面
// 为此跑一次登录 shell 读回环境（apps/desktop/src/login-shell-environment.ts）。
//
// 与官方同语义的四条：
//  ① 候选顺序 = 账号记录里的登录 shell（不是 $SHELL）→ /bin/zsh → /bin/bash → /bin/sh；
//  ② 探针用 `-ilc`（登录 + 交互）跑，stdin 关掉（rc 里的提示读到 EOF 而不是挂住），并设
//     DISABLE_AUTO_UPDATE / ZSH_TMUX_AUTOSTART* 免得 oh-my-zsh 自更新、tmux 自启把读取卡住；
//  ③ 只认两个分隔符之间的 `env -0` 输出（rc 打印的欢迎语一律忽略），且**读到第二个分隔符就结束**：
//     rc 拉起的后台进程会一直握着 stdout，等进程退出会白等到超时；
//  ④ 合并时 shell 的值赢，但探针自身的会话键（PWD/OLDPWD/SHLVL/_/探针环境）与壳自己的
//     DSH_* / ELECTROBUN_* 保持继承值——壳已经在这些键上做了决定，别被 rc 覆盖。
// Windows 不做这件事（官方同样直接返回继承环境）。

import { homedir, userInfo } from 'node:os'

const DELIMITER = '_DSH_SHELL_ENV_DELIMITER_'
const MARKER = `\0${DELIMITER}\0`
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const
const PROBE_ENVIRONMENT = { DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false' } as const
const SHELL_SESSION_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', ...Object.keys(PROBE_ENVIRONMENT)])
const LAUNCHER_OWNED_PREFIXES = ['DSH_', 'ELECTROBUN_'] as const

export const LOGIN_SHELL_TIMEOUT_ENV = 'DSH_SHELL_LOGIN_SHELL_TIMEOUT_MS'
export const DEFAULT_LOGIN_SHELL_TIMEOUT_MS = 10_000

export interface LoginShellFailure {
  shell: string
  /** `exit <code>` / 信号名 / spawn 错误 / `timeout` / `aborted` / `unparsed` */
  reason: string
}

export interface LoginShellResult {
  /** base 叠加第一个成功的 shell 的变量；一个都没成功就是 base 本身。 */
  environment: Record<string, string>
  failures: LoginShellFailure[]
}

export interface LoginShellReadOptions {
  platform?: NodeJS.Platform
  shells?: readonly string[]
  timeoutMs?: number
  cwd?: string
  signal?: AbortSignal
}

function clean(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value
  return out
}

/** 候选 shell：账号记录优先，再退回固定的系统 shell。 */
export function loginShellCandidates(): readonly string[] {
  let account: string | null = null
  try {
    account = userInfo().shell
  } catch {
    // 这个 uid 没有账号记录：只用固定候选
  }
  return [...new Set([...(account === null || account === '' ? [] : [account]), ...FALLBACK_SHELLS])]
}

export function resolveLoginShellTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env[LOGIN_SHELL_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return DEFAULT_LOGIN_SHELL_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LOGIN_SHELL_TIMEOUT_MS
}

/** 取两个分隔符之间的键值；分隔符不成对（rc 直接把 shell 弄挂了）返回 undefined。 */
export function parseLoginShellOutput(stdout: string): Record<string, string> | undefined {
  const first = stdout.indexOf(MARKER)
  if (first === -1) return undefined
  const start = first + MARKER.length
  const second = stdout.indexOf(MARKER, start)
  if (second === -1) return undefined
  const vars: Record<string, string> = {}
  for (const entry of stdout.slice(start, second).split('\0')) {
    if (entry === '') continue
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    vars[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return vars
}

/** shell 的值叠加到继承环境上；探针会话键与壳自己的 DSH_* / ELECTROBUN_* 保持继承值。 */
export function mergeLoginShellEnvironment(
  base: Record<string, string | undefined>,
  shell: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged = clean(base)
  for (const [key, value] of Object.entries(shell)) {
    if (SHELL_SESSION_KEYS.has(key)) continue
    if (LAUNCHER_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    merged[key] = value
  }
  return merged
}

function countMarkers(text: string): number {
  let count = 0
  for (let index = text.indexOf(MARKER); index !== -1; index = text.indexOf(MARKER, index + MARKER.length)) count += 1
  return count
}

async function readShell(
  shell: string,
  base: Record<string, string | undefined>,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Record<string, string> | string> {
  if (signal?.aborted === true) return 'aborted'
  let child: Bun.Subprocess<'ignore', 'pipe', 'ignore'>
  try {
    child = Bun.spawn([shell, '-ilc', DUMP], {
      cwd,
      env: { ...clean(base), ...PROBE_ENVIRONMENT },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
  } catch (error) {
    return String(error)
  }

  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  const collect = (async (): Promise<Record<string, string> | string> => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      // 读到第二个分隔符就收工：rc 拉起的后台进程会一直握着 stdout
      if (countMarkers(Buffer.concat(chunks).toString('latin1')) >= 2) {
        return parseLoginShellOutput(Buffer.concat(chunks).toString('utf8')) ?? 'unparsed'
      }
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const parsed = parseLoginShellOutput(text)
    if (parsed !== undefined) return parsed
    const code = await child.exited
    return code === 0 ? 'unparsed' : `exit ${String(code)}`
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => { resolve('timeout') }, timeoutMs)
  })
  const aborted = new Promise<string>((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => { resolve('aborted') }, { once: true })
  })

  const result = await Promise.race([collect, timeout, aborted])
  if (timer !== undefined) clearTimeout(timer)
  if (typeof result === 'string') {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退出了
    }
    try {
      await reader.cancel()
    } catch {
      // 同上
    }
  }
  return result
}

/**
 * 读回登录 shell 的环境。任何候选都读不到时返回继承环境本身（调用方照常启动，
 * 只是子进程里找不到 Homebrew 那批工具）。
 */
export async function readLoginShellEnvironment(
  base: Record<string, string | undefined>,
  options: LoginShellReadOptions = {},
): Promise<LoginShellResult> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return { environment: clean(base), failures: [] }
  const shells = options.shells ?? loginShellCandidates()
  const failures: LoginShellFailure[] = []
  for (const shell of shells) {
    const result = await readShell(shell, base, options.cwd ?? homedir(), options.timeoutMs ?? DEFAULT_LOGIN_SHELL_TIMEOUT_MS, options.signal)
    if (typeof result !== 'string') return { environment: mergeLoginShellEnvironment(base, result), failures }
    failures.push({ shell, reason: result })
    if (result === 'aborted') break
  }
  return { environment: clean(base), failures }
}
