// 宿主进程的启动与就绪握手。
//
// 对齐官方 apps/desktop/src/host-process.ts：壳 spawn 一个私有 Host，Host 就绪后上报
// { url, injections }。官方走 Node IPC；Bun 侧骨架先用 stdout 的 `HOST-READY {json}` 行
//（#219 实证可用），把消息通道换成 IPC 是后续增量（不影响契约本身）。

import { buildChildEnv, assertChildEnv } from '../shared/child-env.ts'
import type { ShellLayout } from './runtime.ts'

export interface HostReady {
  url: string
  injections: unknown[]
}

export interface StartHostInput {
  layout: ShellLayout
  /** 用于起 dsh 的 bun 可执行文件；默认当前进程（Electrobun 自带的 Bun） */
  bunBin?: string
  /** 壳自己的版本号（注入 DSH_CLIENT_VERSION；缺它 0.2.1-alpha.2 启动致命） */
  clientVersion: string
  profile?: string
  mode?: 'existing' | 'fresh'
  onLog?: (line: string) => void
  timeoutMs?: number
}

export interface HostHandle {
  ready: HostReady
  stop: () => void
  pid: number
}

const READY_PREFIX = 'HOST-READY '
const DEFAULT_TIMEOUT_MS = 120_000

export async function startHost(input: StartHostInput): Promise<HostHandle> {
  const { layout } = input
  const profile = input.profile ?? layout.profile
  const bunBin = input.bunBin ?? process.execPath
  const onLog = input.onLog ?? (() => {})
  const env = buildChildEnv({
    base: process.env,
    clientVersion: input.clientVersion,
    profile,
    home: layout.home,
    profileDir: `${layout.home}/profiles/${profile}`,
    preloadTrees: layout.runtimeDir,
    nodePath: `${layout.runtimeDir}/node_modules`,
  })
  assertChildEnv(env)

  const args = [
    bunBin,
    '--no-install',
    '--preload',
    layout.preloadFile,
    layout.hostScript,
    layout.dshLibDir,
    profile,
    input.mode ?? 'existing',
  ]
  onLog(`[shell] spawn host: ${args.slice(1).join(' ')}`)
  const child = Bun.spawn(args, {
    cwd: layout.home, // GUI 启动时 cwd 不是家目录（CHILD_RESOURCE_CONDITIONS.cwdIsHome）
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stderrPump = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk).trimEnd()
      if (text !== '') for (const line of text.split('\n')) onLog(`[host stderr] ${line}`)
    }
  })()

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ready = await new Promise<HostReady>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`宿主 ${String(timeoutMs)}ms 内未就绪`)), timeoutMs)
    void (async () => {
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true })
          let at = buffer.indexOf('\n')
          while (at >= 0) {
            const line = buffer.slice(0, at)
            buffer = buffer.slice(at + 1)
            if (line.startsWith(READY_PREFIX)) {
              const payload = JSON.parse(line.slice(READY_PREFIX.length)) as HostReady
              clearTimeout(timer)
              resolvePromise(payload)
              return
            }
            if (line.trim() !== '') onLog(`[host] ${line}`)
            at = buffer.indexOf('\n')
          }
        }
        clearTimeout(timer)
        rejectPromise(new Error('宿主 stdout 结束，未拿到 HOST-READY'))
      } catch (error) {
        clearTimeout(timer)
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })

  return {
    ready,
    pid: child.pid,
    stop: () => {
      try {
        child.kill('SIGTERM')
      } catch {}
      void stderrPump
    },
  }
}
