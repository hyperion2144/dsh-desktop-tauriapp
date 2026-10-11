// 壳的「服务面」：运行时就位 → 认领端口 → 起宿主 → 取 cookie → 起 loopback 服务。
//
// 这一层**不 import electrobun**，所以缝 ① 的黑盒测试与「无窗口启动契约」可以直接用
// 普通 bun 跑（无显示器、无 CEF 的 CI 也能跑），窗口是 index.ts 的事。

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { choosePort, claimFor, parseClaims, pruneClaims, releaseClaim, upsertClaim } from '../shared/ports.ts'
import { startHost } from './host.ts'
import { readLoginShellEnvironment, resolveLoginShellTimeoutMs } from './login-shell-env.ts'
import { reconcileProfileTree } from './profile-tree.ts'
import { layout, type ShellLayout } from './runtime.ts'
import { startShellServer, type BootPayload, type ShellServer } from './shell-server.ts'
import type { ContextMenuRequest } from './context-menu.ts'

export interface ServiceOptions {
  clientVersion: string
  /** 覆盖 DSH_HOME 等；默认读 process.env */
  env?: Record<string, string | undefined>
  noWindow?: boolean
  /** 页面外链转系统浏览器（主进程实现；无窗口宿主可不给） */
  onOpenExternal?: (url: string) => void
  /** 页面右键菜单（主进程实现） */
  onContextMenu?: (request: ContextMenuRequest) => void
  onLog?: (line: string) => void
}

export interface ShellState {
  pid: number
  origin: string
  pageUrl: string
  token: string
  profile: string
  runtimeDir: string
  distDir: string
  hostPid: number
  injections: number
  noWindow: boolean
}

export interface ShellService {
  state: ShellState
  paths: ShellLayout
  server: ShellServer
  stop: () => void
}

export async function startService(options: ServiceOptions): Promise<ShellService> {
  const env = options.env ?? process.env
  const home = env.DSH_HOME ?? join(env.HOME ?? '.', '.dsh')
  const logFile = env.DSH_SHELL_LOG ?? join(home, 'shell.log')
  const stateFile = env.DSH_SHELL_STATE_FILE ?? join(home, 'shell-state.json')
  const claimsFile = env.DSH_SHELL_PORT_CLAIMS ?? join(home, 'shell-ports.json')
  mkdirSync(home, { recursive: true })
  mkdirSync(dirname(logFile), { recursive: true })

  const log = (line: string): void => {
    const stamped = `[shell ${new Date().toISOString()}] ${line}`
    console.log(stamped)
    try {
      appendFileSync(logFile, `${stamped}\n`)
    } catch {}
    options.onLog?.(stamped)
  }

  const paths = layout({ env })
  log(`运行时 = ${paths.runtimeDir} | dist = ${paths.distDir} | profile = ${paths.profile} | home = ${paths.home}`)

  // ---- profile 树 reconcile：空 DSH_HOME 下也把运行时树摊进 profile（#209）----
  const profileDir = `${paths.home}/profiles/${paths.profile}`
  const profileModules = `${profileDir}/node_modules`
  const reconcileProfile = (): void => {
    mkdirSync(profileModules, { recursive: true })
    reconcileProfileTree({ runtimeModules: `${paths.runtimeDir}/node_modules`, profileModules, onLog: log })
  }
  // 已有 profile 就先摊平；空的留给 dsh 自己脚手架（它要求目标目录不存在），首启完成后再摊。
  if (existsSync(`${profileDir}/package.json`)) reconcileProfile()

  // ---- 页面 origin 端口：固定 + 被占顺延（origin 是 localStorage 的隔离键）----
  const readClaims = async (): Promise<string> => {
    try {
      return await Bun.file(claimsFile).text()
    } catch {
      return '[]'
    }
  }
  const portFree = (port: number): boolean => {
    try {
      const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {}, open() {}, close() {} } })
      probe.stop(true)
      return true
    } catch {
      return false
    }
  }

  let claims = pruneClaims(parseClaims(await readClaims()), (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return pid === process.pid
    }
  })
  const previous = claimFor(claims, paths.profile)
  const pagePort = choosePort({
    requested: Number(env.DSH_SHELL_PAGE_PORT ?? '') || undefined,
    lastClaimed: previous?.port,
    isFree: portFree,
  })
  if (pagePort === null) throw new Error('页面 origin 端口池已耗尽')
  const token = `tok-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

  // ---- 宿主：Bun 起 dsh，自己拿端口并上报 { url, injections } ----
  // GUI（Finder/LaunchServices）启动只继承 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
  // 于是 dsh 子进程里 gh / bun / node / pnpm 全部找不到。官方 Electron 桌面为此读回登录 shell
  // 的环境；这里同语义做一遍，并把结果也落到壳自己的 process.env（后续 spawn 都受益）。
  const loginShell = await readLoginShellEnvironment(env, { timeoutMs: resolveLoginShellTimeoutMs(env) })
  if (loginShell.failures.length > 0) {
    log(`登录 shell 环境读取失败：${loginShell.failures.map((failure) => `${failure.shell}(${failure.reason})`).join('、')}——沿用继承环境`)
  }
  log(`PATH = ${loginShell.environment.PATH ?? '(空)'}`)
  for (const [key, value] of Object.entries(loginShell.environment)) process.env[key] = value
  const childEnv = loginShell.environment

  const hostMode = env.DSH_SHELL_PROFILE_MODE === 'fresh' ? 'fresh' : 'existing'
  let host: Awaited<ReturnType<typeof startHost>>
  try {
    host = await startHost({
      layout: paths,
      clientVersion: options.clientVersion,
      mode: hostMode,
      env: childEnv,
      onLog: log,
    })
  } catch (error) {
    // 首次启动：dsh 刚把 profile 脚手架（cordis.yml/package.json）落盘，但依赖树还是空的，
    // 插件会整片 failed to import。摊平 profile 树后按 existing 重试一次——只在首启发生。
    if (hostMode !== 'fresh' || !existsSync(`${profileDir}/package.json`)) throw error
    log('首次启动：profile 已建立但依赖树为空，摊平 profile 树后重试')
    reconcileProfile()
    host = await startHost({
      layout: paths,
      clientVersion: options.clientVersion,
      mode: 'existing',
      env: childEnv,
      onLog: log,
    })
  }
  log(`host ready | dsh = ${new URL(host.ready.url).origin} | injections = ${host.ready.injections.length}`)

  // ---- 取 cookie：303 + set-cookie（官方 authenticateWebHost 语义，不解析 stdout 的 token 行）----
  const auth = await fetch(host.ready.url, { redirect: 'manual' })
  const setCookies = (auth.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const cookie = setCookies[0]?.split(';')[0] ?? ''
  log(`auth: ${String(auth.status)} ${auth.headers.get('location') ?? ''} | cookie = ${cookie === '' ? '(none)' : `${cookie.slice(0, 18)}…`}`)
  if (cookie === '') {
    host.stop()
    throw new Error('没拿到 dsh 会话 cookie（303 + set-cookie 流程失败）')
  }

  // ---- loopback 服务 ----
  const bootPayload: BootPayload = {
    injections: host.ready.injections,
    streamBaseUrl: `http://127.0.0.1:${String(pagePort)}`,
  }
  const server = startShellServer({
    distDir: paths.distDir,
    token,
    cookie,
    upstreamOrigin: new URL(host.ready.url).origin,
    port: pagePort,
    bootPayload: () => bootPayload,
    onOpenExternal: options.onOpenExternal,
    onContextMenu: options.onContextMenu,
    onLog: log,
  })
  const pageUrl = `${server.origin}/${token}/`

  claims = upsertClaim(claims, {
    profile: paths.profile,
    port: pagePort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })
  await Bun.write(claimsFile, `${JSON.stringify(claims, null, 2)}\n`)

  const state: ShellState = {
    pid: process.pid,
    origin: server.origin,
    pageUrl,
    token,
    profile: paths.profile,
    runtimeDir: paths.runtimeDir,
    distDir: paths.distDir,
    hostPid: host.pid,
    injections: bootPayload.injections.length,
    noWindow: options.noWindow ?? false,
  }
  await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  log(`端口台账：${JSON.stringify(claims)}`)

  return {
    state,
    paths,
    server,
    stop: () => {
      server.stop()
      host.stop()
      const next = releaseClaim(parseClaims(JSON.stringify(claims)), paths.profile)
      try {
        Bun.write(claimsFile, `${JSON.stringify(next, null, 2)}\n`)
      } catch {}
    },
  }
}
