// 端口占用清场（旧壳 `process/lifecycle.rs` 的 `port_open` / `listener_pids` /
// `stop_port_owner` 的等价物）。
//
// 旧壳用 netstat2 crate（不 shells out）；Bun 没有等价物 → 平台命令兜底
// （macOS `lsof`、Linux `ss`、Windows `netstat -ano`），**枚举失败必须降级为
// 「只看端口是否关闭」**——绝不能在拿不到 pid 时谎报已释放（旧壳同语义）。
//
// 相对旧壳的两处加固（旧壳 §8.3 点名要在移植时补的）：
// - 杀进程前排除自己（process.pid / process.ppid + 调用方补充名单）；
// - 杀进程打日志（旧壳的 stop_port_owner 完全静默，只有失败方打 error）。

import { createConnection } from 'node:net'

export interface RunResultLike {
  status: number
  stdout: string
}

export type RunImpl = (cmd: readonly string[]) => RunResultLike

const defaultRun: RunImpl = (cmd) => {
  const proc = Bun.spawnSync({ cmd: [...cmd], stdout: 'pipe', stderr: 'pipe' })
  return { status: proc.exitCode ?? 1, stdout: proc.stdout.toString() }
}

/** `port_open`：对 127.0.0.1:port 的 TCP connect（300ms 超时），连上 = 有服务在听。 */
export function portOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const done = (result: boolean): void => {
      socket.destroy()
      resolvePromise(result)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** 平台命令枚举端口的监听进程；拿不到（工具不存在 / 解析不出）回空数组 + 原因。 */
export function listenerPids(
  port: number,
  platform: NodeJS.Platform = process.platform,
  run: RunImpl = defaultRun,
): { pids: number[]; error: string | null } {
  try {
    if (platform === 'darwin') {
      const result = run(['lsof', '-ti', `tcp:${port}`, '-sTCP:LISTEN'])
      if (result.status !== 0) return { pids: [], error: 'lsof 不可用或没有监听者' }
      const pids = result.stdout
        .split('\n')
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
      return { pids: [...new Set(pids)].sort((left, right) => left - right), error: null }
    }
    if (platform === 'win32') {
      const result = run(['netstat', '-ano', '-p', 'tcp'])
      if (result.status !== 0) return { pids: [], error: 'netstat 不可用' }
      const pids: number[] = []
      for (const line of result.stdout.split('\n')) {
        const columns = line.trim().split(/\s+/)
        // 形如 TCP  127.0.0.1:3080  0.0.0.0:0  LISTENING  1234
        if (columns.length < 5 || columns[3] !== 'LISTENING') continue
        const local = columns[1] ?? ''
        if (!local.endsWith(`:${port}`)) continue
        const pid = Number.parseInt(columns[columns.length - 1] ?? '', 10)
        if (Number.isInteger(pid) && pid > 0) pids.push(pid)
      }
      return { pids: [...new Set(pids)].sort((left, right) => left - right), error: null }
    }
    const result = run(['ss', '-ltnHp', `sport = :${port}`])
    if (result.status !== 0) return { pids: [], error: 'ss 不可用' }
    const pids = [...result.stdout.matchAll(/pid=(\d+)/g)]
      .map((match) => Number.parseInt(match[1] ?? '', 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    return { pids: [...new Set(pids)].sort((left, right) => left - right), error: null }
  } catch (error) {
    return { pids: [], error: error instanceof Error ? error.message : String(error) }
  }
}

const defaultKill = (pid: number, signal: 'TERM' | 'KILL'): void => {
  if (process.platform === 'win32') {
    // Windows 没有两级强杀（旧壳 kill_process_force 就是 kill_process），只有 TerminateProcess。
    Bun.spawnSync({ cmd: ['taskkill', '/F', '/PID', String(pid)], stdout: 'ignore', stderr: 'ignore' })
    return
  }
  try {
    process.kill(pid, signal === 'TERM' ? 'SIGTERM' : 'SIGKILL')
  } catch {
    // 进程已经不在了：当作杀掉处理（端口复查会给出最终结论）。
  }
}

export interface StopPortOwnerInput {
  port: number
  run?: RunImpl
  kill?: (pid: number, signal: 'TERM' | 'KILL') => void
  portOpenFn?: (port: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  /** 额外豁免的 pid（调用方把自己的子进程树带进来）。 */
  excludePids?: readonly number[]
  platform?: NodeJS.Platform
  log?: (message: string) => void
}

/**
 * 把端口的占用者清掉：6 轮「枚举 → SIGTERM → 400ms 复查」，仍不听就补 SIGKILL 再等 2s
 * （旧壳节奏：约 2.4s 优雅 + 2s 强杀）。返回**端口是否已释放**；false = 调用方中止启动。
 */
export async function stopPortOwner(input: StopPortOwnerInput): Promise<boolean> {
  const isOpen = input.portOpenFn ?? portOpen
  const kill = input.kill ?? defaultKill
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)))
  const log = input.log ?? ((): void => {})
  const exempt = new Set<number>([process.pid, process.ppid].filter((pid): pid is number => typeof pid === 'number'))
  for (const pid of input.excludePids ?? []) exempt.add(pid)
  const seen: number[] = []
  for (let round = 0; round < 6; round += 1) {
    const { pids, error } = listenerPids(input.port, input.platform, input.run)
    const fresh = pids.filter((pid) => !seen.includes(pid) && !exempt.has(pid))
    if (fresh.length === 0) {
      if (error !== null && seen.length === 0) {
        // 枚举不出占用者：不谎报成功，只按端口是否关闭下结论（旧壳降级语义）。
        log(`[port] 无法枚举端口 ${input.port} 的占用者（${error}），按端口是否释放判定`)
        break
      }
      if (pids.length === 0) break
      break
    }
    for (const pid of fresh) {
      log(`[port] 端口 ${input.port} 占用者 pid = ${pid}，SIGTERM`)
      kill(pid, 'TERM')
      seen.push(pid)
    }
    for (let check = 0; check < 4; check += 1) {
      await sleep(100)
      if (!(await isOpen(input.port))) return true
    }
  }
  if (seen.length > 0) {
    for (const pid of seen) {
      log(`[port] 端口 ${input.port} 占用者 pid = ${pid} 未退出，SIGKILL`)
      kill(pid, 'KILL')
    }
    for (let check = 0; check < 20; check += 1) {
      await sleep(100)
      if (!(await isOpen(input.port))) return true
    }
  }
  return !(await isOpen(input.port))
}
