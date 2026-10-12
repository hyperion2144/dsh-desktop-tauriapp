// 宿主进程的启动与就绪握手。
//
// 对齐官方 apps/desktop/src/host-process.ts：壳 spawn 一个私有 Host，Host 就绪后上报
// { url, injections }。官方走 Node IPC；Bun 侧骨架先用 stdout 的 `HOST-READY {json}` 行
//（#219 实证可用），把消息通道换成 IPC 是后续增量（不影响契约本身）。

import { buildChildEnv, assertChildEnv } from '../shared/child-env.ts'
import type { ShellLayout } from './runtime.ts'
import type { ProxyEnv } from '../shared/proxy-env.ts'

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
  /** dsh 子进程的环境；缺省用壳继承的 process.env（GUI 启动时是 launchd 的最小集） */
  env?: Record<string, string | undefined>
  onLog?: (line: string) => void
  timeoutMs?: number
  /** `--patch` 注入清单（插件 staging 的产物；缺省不注入） */
  patchFiles?: string[]
  /** 通知口（壳的通知服务）：缺省不给，宿主插件静默降级 */
  notify?: { port: number; token: string } | undefined
  /** dsh web 监听端口（旧壳 `DSH_DESKTOP_PORT`）；缺省让 dsh 自己挑（--port 0） */
  upstreamPort?: number | undefined
  /** 手机访问 lane 端口（旧壳 `DSH_MOBILE_LANE_PORT`） */
  lanePort?: number | undefined
  /** 代理注入（旧壳 `resolved_proxy_env`）；null/缺省 = 不注入 */
  proxy?: ProxyEnv | null
  /** cloudflared 可执行文件路径（旧壳 `DSH_CLOUDFLARED_BIN`，#164 隧道） */
  cloudflaredBin?: string | undefined
}

export interface HostHandle {
  ready: HostReady
  /** 优雅停止：SIGTERM → 宽限期 → SIGKILL，并等到真的退出（不留孤儿） */
  stop: () => Promise<void>
  pid: number
  /** 宿主退出（含守护器观察到的异常退出）；解析为退出码 */
  exited: Promise<number>
}

const READY_PREFIX = 'HOST-READY '
const DEFAULT_TIMEOUT_MS = 120_000
/** 优雅退出等待：SIGTERM 后多久升级到 SIGKILL（壳退出不能拖住进程） */
const STOP_GRACE_MS = 5_000
/** 升级后最多再等多久 */
const STOP_KILL_WAIT_MS = 2_000

export async function startHost(input: StartHostInput): Promise<HostHandle> {
  const { layout } = input
  const profile = input.profile ?? layout.profile
  const bunBin = input.bunBin ?? process.execPath
  const onLog = input.onLog ?? (() => {})
  const env = buildChildEnv({
    base: input.env ?? process.env,
    clientVersion: input.clientVersion,
    profile,
    home: layout.home,
    profileDir: `${layout.home}/profiles/${profile}`,
    preloadTrees: layout.runtimeDir,
    nodePath: `${layout.runtimeDir}/node_modules`,
    parentPid: process.pid,
    patchFiles: input.patchFiles,
    notify: input.notify,
    upstreamPort: input.upstreamPort,
    lanePort: input.lanePort,
    proxy: input.proxy,
    cloudflaredBin: input.cloudflaredBin,
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

  // 退出信号：守护器（supervisor）与 stop() 都盯着它；这里只记一条日志。
  const exited = child.exited.then((code) => {
    onLog(`[shell] 宿主退出：pid = ${String(child.pid)} code = ${String(code)}`)
    return code
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
    exited,
    stop: async () => {
      if (child.exitCode !== null) return
      try {
        child.kill('SIGTERM')
      } catch {}
      const escalation = setTimeout(() => {
        onLog(`[shell] 宿主 ${String(STOP_GRACE_MS)}ms 未退出，升级 SIGKILL`)
        try {
          child.kill('SIGKILL')
        } catch {}
      }, STOP_GRACE_MS)
      try {
        await Promise.race([exited, Bun.sleep(STOP_GRACE_MS + STOP_KILL_WAIT_MS)])
      } finally {
        clearTimeout(escalation)
      }
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      await stderrPump.catch(() => {})
    },
  }
}
