// 壳的「服务面」：运行时就位 → 认领端口 → 起宿主 → 取 cookie → 起 loopback 服务。
//
// 这一层**不 import electrobun**，所以缝 ① 的黑盒测试与「无窗口启动契约」可以直接用
// 普通 bun 跑（无显示器、无 CEF 的 CI 也能跑），窗口是 index.ts 的事。

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { choosePort, claimFor, parseClaims, pruneClaims, releaseClaim, upsertClaim } from '../shared/ports.ts'
import { startHost } from './host.ts'
import { readLoginShellEnvironment, resolveLoginShellTimeoutMs } from './login-shell-env.ts'
import type { ShellStage } from './stages.ts'
import { reconcileProfileTree } from './profile-tree.ts'
import { layout, type ShellLayout } from './runtime.ts'
import { startShellServer, type BootPayload, type ShellServer, type ShellServerOptions } from './shell-server.ts'
import { readHostRecords, sweepStaleHosts, upsertHostRecord, writeHostRecords } from './host-registry.ts'
import { createRestartLedger } from './supervisor.ts'
import type { ContextMenuRequest } from './context-menu.ts'
import { loadSettings } from './settings-store.ts'
import { scaffoldProfile } from './profile-scaffold.ts'
import { stagePlugins } from './plugin-staging.ts'
import { createArbiter } from '../shared/power-arbiter.ts'
import { createKeepAwake } from './keep-awake.ts'
import { startNotifyServer } from './notify-server.ts'
import { activeProfile, settingsSummary, type DesktopSettings } from '../shared/settings.ts'

export interface ServiceOptions {
  clientVersion: string
  /** 覆盖 DSH_HOME 等；默认读 process.env */
  env?: Record<string, string | undefined>
  noWindow?: boolean
  /** 页面外链转系统浏览器（主进程实现；无窗口宿主可不给） */
  onOpenExternal?: (url: string) => void
  /** 页面右键菜单（主进程实现） */
  onContextMenu?: (request: ContextMenuRequest) => void
  /** 宿主被守护器重启成功（主进程用它把页面刷回来） */
  onHostRestart?: (state: ShellState) => void
  /** 宿主反复退出，守护器放弃（不再重启） */
  onHostGiveUp?: (state: ShellState, reason: string) => void
  /** 启动阶段变化（启动界面据此报进度；无窗口模式也会调） */
  onStage?: (stage: ShellStage) => void
  /** 第二个实例请求把窗口带到前台（单实例激活） */
  onActivate?: () => void
  onLog?: (line: string) => void
  /** 直接给定设置（测试/多窗口复用；缺省从磁盘读） */
  settings?: DesktopSettings
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
  /** 通知口端口（忙状态/通知上报；0 = 未起） */
  notifyPort: number
  injections: number
  noWindow: boolean
  /** 壳设置（loadSettings 的结果，可供托盘/设置面板/防休眠等复用） */
  settings: DesktopSettings
  /** 设置文件的读取过程（首启/迁移/损坏重建） */
  settingsProvenance: { created: boolean; migrated: boolean; recovered: boolean }
}

export interface ShellService {
  state: ShellState
  paths: ShellLayout
  server: ShellServer
  /** 停止：摘服务、SIGTERM→SIGKILL 停宿主、上台账与端口回收 */
  stop: () => Promise<void>
  /** 手动重启宿主（守护器会接住退出并把服务面切到新宿主） */
  restartHost: () => Promise<void>
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

  // ---- 设置：壳自己的一份（desktop-settings.json，旧壳的 settings.yaml 只读迁移一次）----
  const loaded = loadSettings({ home, log })
  const settings = options.settings ?? loaded.settings
  const provenance = [
    loaded.created ? '首次启动已落盘' : '',
    loaded.migrated ? '已从 settings.yaml 迁移' : '',
    loaded.recovered ? '原文件损坏，已备份重建' : '',
  ].filter((entry) => entry !== '')
  log(`设置：${settingsSummary(settings)}${provenance.length > 0 ? `（${provenance.join('；')}）` : ''}`)

  const paths = layout({ env, profile: activeProfile(settings, env) })
  options.onStage?.('layout')
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
  options.onStage?.('ports')
  const token = `tok-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

  // ---- 启动清扫：上一次壳留下的孤儿宿主 ----
  // 本次壳起的宿主有看门狗（runtime/parent-watch.mjs）兜底；上一次壳被 SIGKILL/崩溃后留下的
  // 孤儿只能靠台账在启动时清掉——它会一直占着会话（实机复现过）。
  const hostRegistryFile = env.DSH_SHELL_HOST_REGISTRY ?? join(home, 'shell-hosts.json')
  const swept = sweepStaleHosts({ file: hostRegistryFile, log })
  if (swept.killed.length > 0 || swept.pruned.length > 0) {
    log(`宿主台账清扫：杀掉孤儿 ${String(swept.killed.length)} 个、清理过期条目 ${String(swept.pruned.length)} 个`)
  }
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

  /** 选中运行时的版本号（目录名，如 0.2.1-alpha.2）：决定 connection 的两代 inject 契约 */
  const runtimeVersion = basename(paths.runtimeDir)
  // ---- profile 脚手架 + 插件 staging（都必须在起宿主之前，这次 spawn 就要能看到）----
  // ① profile：上游 `loadProfile()` 只认「目录里已有 package.json」的 profile，缺了就报
  //    `dsh: profile "desktop" does not exist`——全新 DSH_HOME 能起壳就是因为这一步。
  const scaffold = scaffoldProfile(home, paths.profile)
  if (scaffold.created.length > 0) {
    log(`profile 脚手架：写入 ${scaffold.created.join('、')}（${paths.profile}）`)
  }
  // 新 profile 的依赖树：dsh 自己不会装（它只组合 bundles），所以按 #209 的做法把
  // 运行时树的模块摊进 profile——否则首启后插件会整片 failed to import。
  if (scaffold.created.includes('package.json')) {
    reconcileProfile()
    log(`profile 依赖树：已按运行时树摊平（${paths.profile}）`)
  }

  // ---- 防休眠（#186）：纯裁决 + tick 循环；忙状态由宿主插件 POST /notify 上报 ----
  // 旧壳把通知口跑在独立随机端口上（notify.rs），端口与令牌经环境变量交给 dsh 侧插件；
  // 插件缺 env 时静默降级（不是关键路径）——这里保持同一契约。
  const arbiter = createArbiter({ enabled: settings.preventSleep })
  // 令牌缺省每启动随机；`DSH_SHELL_NOTIFY_TOKEN` 是探针/黑盒测试用的覆盖口（与其它 DSH_SHELL_* 同性质）。
  const notifyTokenOverride = (env.DSH_SHELL_NOTIFY_TOKEN ?? '').trim()
  const notifyServer = startNotifyServer({
    ...(notifyTokenOverride === '' ? {} : { token: notifyTokenOverride }),
    onBusy: (profile, busy) => {
      const changed = arbiter.setBusy(profile, busy, Date.now())
      if (changed) {
        log(`防休眠：${profile} ${busy ? '开始' : '结束'}跑会话 → ${arbiter.shouldHold() ? '持有断言' : '可释放'}`)
      }
    },
    onNotify: (payload) => {
      // 通知轮次接；现在只留痕，确保「壳收得到」这件事可诊断。
      log(`通知口收到 ${payload.type}：${payload.body.slice(0, 60)}`)
    },
    onLog: log,
  })
  const keepAwake = createKeepAwake({ arbiter, log })
  if (settings.preventSleep) keepAwake.start()
  else log('防休眠：设置里已关闭（prevent_sleep = false）')
  // ② 插件：把桌面壳插件（+ 手机侧，若在）挂进 profile 模块池，并写 `--patch` 注入清单。
  const staged = stagePlugins({
    home,
    profile: paths.profile,
    appSupport: paths.appSupport,
    paths: { repoRoot: paths.repoRoot, resourcesDir: paths.resourcesDir },
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    muxHeartbeatMs: settings.muxHeartbeatMs,
    desktopLayoutOnPhones: settings.desktopLayoutOnPhones,
    env,
    log,
  })
  const patchFiles = [staged.injectFile]
  let host!: Awaited<ReturnType<typeof startHost>>
  let cookie = ''
  // 起宿主 + 取 cookie。守护器重启时重复调这个（同一个 cookie 变量与服务面 options）。
  const connect = async (): Promise<void> => {
    try {
      host = await startHost({
        layout: paths,
        clientVersion: options.clientVersion,
        mode: hostMode,
        env: childEnv,
        onLog: log,
        patchFiles,
        notify: { port: notifyServer.port, token: notifyServer.token },
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
        patchFiles,
        notify: { port: notifyServer.port, token: notifyServer.token },
      })
    }
    log(`host ready | dsh = ${new URL(host.ready.url).origin} | injections = ${String(host.ready.injections.length)}`)

    // ---- 取 cookie：303 + set-cookie（官方 authenticateWebHost 语义，不解析 stdout 的 token 行）----
    const auth = await fetch(host.ready.url, { redirect: 'manual' })
    const setCookies = (auth.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    cookie = setCookies[0]?.split(';')[0] ?? ''
    log(`auth: ${String(auth.status)} ${auth.headers.get('location') ?? ''} | cookie = ${cookie === '' ? '(none)' : `${cookie.slice(0, 18)}…`}`)
    if (cookie === '') {
      await host.stop()
      throw new Error('没拿到 dsh 会话 cookie（303 + set-cookie 流程失败）')
    }
  }
  await connect()
  options.onStage?.('cookie')

  // ---- loopback 服务 ----
  // boot 载荷与上游可换：守护器重启宿主后要指向新的 url/cookie（同一个 options 对象）。
  let bootPayload: BootPayload = {
    injections: [],
    streamBaseUrl: `http://127.0.0.1:${String(pagePort)}`,
  }
  const serverOptions: ShellServerOptions = {
    distDir: paths.distDir,
    token,
    cookie,
    upstreamOrigin: new URL(host.ready.url).origin,
    port: pagePort,
    bootPayload: () => bootPayload,
    onOpenExternal: options.onOpenExternal,
    onContextMenu: options.onContextMenu,
    onActivate: options.onActivate,
    onLog: log,
  }
  const server = startShellServer(serverOptions)
  options.onStage?.('server')
  bootPayload.injections = host.ready.injections
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
    notifyPort: notifyServer.port,
    injections: bootPayload.injections.length,
    noWindow: options.noWindow ?? false,
    settings,
    settingsProvenance: { created: loaded.created, migrated: loaded.migrated, recovered: loaded.recovered },
  }
  await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)

  // ---- 宿主守护器：异常退出就退避重启，并把服务面切到新宿主（页面不再停在转发失败） ----
  const ledger = createRestartLedger()
  let stopping = false
  const registerHost = (): void => {
    const records = upsertHostRecord(readHostRecords(hostRegistryFile), {
      hostPid: host.pid,
      shellPid: process.pid,
      profile: paths.profile,
      startedAt: new Date().toISOString(),
    })
    writeHostRecords(hostRegistryFile, records)
  }
  const forgetHosts = (): void => {
    writeHostRecords(
      hostRegistryFile,
      readHostRecords(hostRegistryFile).filter((entry) => entry.shellPid !== process.pid),
    )
  }
  const applyHost = (): void => {
    bootPayload.injections = host.ready.injections
    serverOptions.cookie = cookie
    serverOptions.upstreamOrigin = new URL(host.ready.url).origin
    state.hostPid = host.pid
    state.injections = bootPayload.injections.length
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }
  const supervise = async (): Promise<void> => {
    registerHost()
    const code = await host.exited
    if (stopping) return
    // 旧实例没了 = 它的忙租约不再会被刷新：先摘干净再决定要不要重启。
    arbiter.clear()
    keepAwake.tick()
    const decision = ledger.decide(Date.now())
    log(`宿主 ${String(host.pid)} 意外退出（code = ${String(code)}）：${decision.reason}`)
    if (!decision.restart) {
      options.onHostGiveUp?.(state, decision.reason)
      return
    }
    ledger.record(Date.now())
    await Bun.sleep(decision.delayMs)
    if (stopping) return
    try {
      await connect()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log(`守护器重启宿主失败：${reason}`)
      options.onHostGiveUp?.(state, reason)
      return
    }
    applyHost()
    log(`守护器已重启宿主：pid = ${String(host.pid)} | injections = ${String(bootPayload.injections.length)}`)
    options.onHostRestart?.(state)
    void supervise()
  }
  registerHost()
  void supervise()
  log(`端口台账：${JSON.stringify(claims)}`)
  options.onStage?.('ready')

  return {
    state,
    paths,
    server,
    restartHost: async () => {
      if (stopping) return
      // 杀掉当前宿主即可：退出会唤醒守护器，由它重启并把服务面切过去
      await host.stop()
    },
    stop: async () => {
      stopping = true
      ledger.reset()
      server.stop()
      notifyServer.stop()
      keepAwake.stop()
      arbiter.clear()
      try {
        await host.stop()
      } catch {}
      forgetHosts()
      const next = releaseClaim(parseClaims(JSON.stringify(claims)), paths.profile)
      try {
        await Bun.write(claimsFile, `${JSON.stringify(next, null, 2)}\n`)
      } catch {}
    },
  }
}
