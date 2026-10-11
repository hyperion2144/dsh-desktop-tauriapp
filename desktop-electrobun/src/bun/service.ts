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
import { layout, resolveBuiltinRuntimeDir, type ShellLayout } from './runtime.ts'
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
import { createNotifier, importSound as importSoundFile, systemDefaultSoundCommand, type Notifier } from './notifications.ts'
import { createNativeNotify, type NativeNotify } from './notify-un.ts'
import { permissionHint, permissionLabel } from '../shared/notify-permission.ts'
import { NOTIFY_TYPE_SCENARIOS, SCENARIO } from '../shared/notify-policy.ts'
import { activeProfile, profileLanePort, profilePort, settingsSummary, type DesktopSettings } from '../shared/settings.ts'
import { createCommandTable, type RuntimeSnapshot } from './commands.ts'
import { createRpcRouter, dispatchRpc, type RpcRouter } from './rpc.ts'
import { updateSettings } from './settings-store.ts'
import type { RuntimeDownloadStatus } from './runtime-install.ts'
import { listProfiles } from './profiles.ts'
import { createDownloadManager } from './downloads.ts'
import type { CatalogEntry } from '../shared/runtime-catalog.ts'
import type { RuntimeSource } from '../shared/settings.ts'
import {
  externalPackageRoot,
  externalVersion,
  fetchRuntimeCatalog,
  listInstalledRuntimes,
  purgeRuntimeTrash,
  readRuntimeVersion,
  recordInstalledRuntime,
  resolveExternalRuntime,
  trashInstalledRuntime,
} from './runtime-store.ts'
import { createRuntimeDownloader, ensureNodeShim, installRuntime, resolvePnpmCjs } from './runtime-install.ts'

export interface ServiceOptions {
  /** 平台（命令表要回给页面；缺省 process.platform） */
  platform?: NodeJS.Platform
  /** 页面请求关窗（`close_current_window` / `exit_window_instance`） */
  onCloseWindow?: () => void
  clientVersion: string
  /** 这个服务面负责哪个 profile（多窗口下每 profile 一份；缺省按 DSH_PROFILE > 设置 > 默认） */
  profile?: string
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
  /** 通知权限桥（index.ts 注入同一个实例；缺省自建） */
  notifyBridge?: NativeNotify
  settings?: DesktopSettings
  /** 通知器（index.ts 注入 Electrobun 原生通道；缺省走命令行兜底） */
  notifier?: Notifier
  /** 弹原生文件选择器选音频（index.ts 注入；缺省返回 null） */
  pickSoundFile?: () => Promise<string | null>
  /** 弹目录选择器选下载位置（index.ts 注入 Electrobun 的 openFileDialog；缺省落 ~/Downloads） */
  chooseDownloadDir?: (start: string) => Promise<string | null>
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
  /** dsh 上游监听端口（旧壳 `DSH_DESKTOP_PORT`，手机访问插件靠它找上游） */
  upstreamPort: number
  /** 手机访问 lane 端口（旧壳 `DSH_MOBILE_LANE_PORT`） */
  lanePort: number
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
  // 每份服务面只服务一个 profile：profile 由 ServiceOptions.profile 在启动时给定，
  // 切换 profile ＝ 打开那份 profile 的窗口（多窗口，见 src/bun/index.ts 的 openProfileWindow）。
  /** 当前生效设置（托盘这类壳侧调用方读它） */
  settings: () => DesktopSettings
  /** 改设置：与命令表同一条写盘路径（落盘 + 刷新状态文件） */
  save: (patch: Record<string, unknown>) => DesktopSettings
  /** 运行时快照（来源 / 内置版本 / 已装列表 / 外部 dsh） */
  runtime: () => RuntimeSnapshot
  /** 拉版本目录（失败不抛，回 {entries, error}） */
  fetchCatalog: (source: RuntimeSource) => Promise<{ entries: CatalogEntry[]; error?: string }>
  /** 通知权限桥（托盘/面板共用：真实状态 + 主动申请） */
  notify: NativeNotify
  /** 下载进度（托盘与设置面板共用同一个单飞状态） */
  downloadStatus: () => RuntimeDownloadStatus
  /** 下载并安装一个运行时（单飞） */
  download: (version: string, source: RuntimeSource) => Promise<{ ok: true; version: string }>
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

  // 运行时选中：设置里的 dsh 来源（builtin/external）与偏好版本在这里生效；
  // 旧壳的 DSH_MODE / DSH_SHELL_RUNTIME_DIR 覆盖仍在 layout 内部处理。
  let paths = layout({
    env,
    profile: options.profile ?? activeProfile(settings, env),
    mode: settings.dshMode,
    preferred: settings.dshRuntime,
  })
  options.onStage?.('layout')
  log(
    `运行时 = ${paths.runtimeDir}（${paths.runtimeKind}${paths.runtimeVersion === null ? '' : ` ${paths.runtimeVersion}`}）| dist = ${paths.distDir} | profile = ${paths.profile} | home = ${paths.home}`
  )
  if (paths.runtimeNote !== null) log(`运行时回退：${paths.runtimeNote}`)
  // 回收站：上一次卸载留下的运行时目录到这时才真删（旧壳 #114：直接删会动到与运行树
  // 共享 hardlink 的 ctime，触发 dsh 插件 rebuilt → 白屏），所以只能在 spawn 之前清。
  const purgedTrash = purgeRuntimeTrash(paths.appSupport, log)
  if (purgedTrash > 0) log(`运行时回收站：清理 ${String(purgedTrash)} 项（上一次卸载的残留）`)

  // ---- 运行时下载安装：面板点「下载」→ 单飞装树（命令表只调 downloader，不自己 spawn）----
  // pnpm.cjs 随内置树分发（`prepare-builtin-runtime.mjs` 装的 pnpm@11.16.0）；包管理器跑在**我们的 Bun** 上。
  const bunPath = process.execPath
  const builtinDir = resolveBuiltinRuntimeDir(env, { repoRoot: paths.repoRoot, resourcesDir: paths.resourcesDir })
  const pnpmCjs = resolvePnpmCjs({
    env,
    runtimeRoot: paths.runtimeKind === 'external' ? null : paths.runtimeDir,
    builtinDir,
    appSupport: paths.appSupport,
  })
  if (pnpmCjs === null) log('运行时下载：没找到 pnpm.cjs（可用 DSH_SHELL_PNPM 指定），面板点下载会失败')
  const downloader = createRuntimeDownloader({
    install: async (version, onProgress) => {
      if (pnpmCjs === null) throw new Error('找不到 pnpm.cjs（可用 DSH_SHELL_PNPM 指定内置的那份）')
      const nodeShimDir = ensureNodeShim({
        appSupport: paths.appSupport,
        bunPath,
        hasNode: Bun.which('node') !== null,
        log,
      })
      await installRuntime({
        appSupport: paths.appSupport,
        version,
        bunPath,
        pnpmCjs,
        nodeShimDir,
        onProgress,
        onLog: log,
      })
    },
    record: (version, source) => {
      recordInstalledRuntime(paths.appSupport, {
        version,
        source: source === 'npm' ? 'npm' : 'github',
        installed_at: Date.now(),
      })
    },
    log,
  })

  // ---- profile 树 reconcile：空 DSH_HOME 下也把运行时树摊进 profile（#209）----
  const reconcileProfileFor = (profile: string): void => {
    const modules = `${paths.home}/profiles/${profile}/node_modules`
    mkdirSync(modules, { recursive: true })
    reconcileProfileTree({
      runtimeModules: `${paths.runtimeDir}/node_modules`,
      profileModules: modules,
      onLog: log,
    })
  }
  const reconcileProfile = (): void => reconcileProfileFor(paths.profile)
  // 已有 profile 就先摊平；空的留给 dsh 自己脚手架（它要求目标目录不存在），首启完成后再摊。
  if (existsSync(`${paths.home}/profiles/${paths.profile}/package.json`)) reconcileProfile()

  // ---- 页面 origin 端口：固定 + 被占顺延（origin 是 localStorage 的隔离键）----
  const readClaims = async (): Promise<string> => {
    try {
      return await Bun.file(claimsFile).text()
    } catch {
      return '[]'
    }
  }
  // 空闲判定必须同时试 127.0.0.1 与 0.0.0.0：手机访问插件绑的是通配地址，
  // 而 macOS 上「别人占着 *:P」时绑 127.0.0.1:P 仍会成功（实测），只试 loopback 会
  // 把已被占用的 lane 端口判成空闲，第二份服务面的宿主直接 EADDRINUSE 退出（多窗口实测）。
  const portFree = (port: number): boolean => {
    for (const hostname of ['127.0.0.1', '0.0.0.0']) {
      try {
        const probe = Bun.listen({ hostname, port, socket: { data() {}, open() {}, close() {} } })
        probe.stop(true)
      } catch {
        return false
      }
    }
    return true
  }

  // 台账是多个服务面共享的文件（每份 profile 一份服务面）：写入前重读并合并，
  // 否则后启动的那份会把先启动那份的条目当成脏数据覆盖掉。
  const isAlivePid = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return pid === process.pid
    }
  }
  let claims = pruneClaims(parseClaims(await readClaims()), isAlivePid)
  const previous = claimFor(claims, paths.profile)
  // 页面 origin 的认定 key：切 profile 不换 origin（localStorage 的隔离键就是它）
  const claimProfile = paths.profile
  const pagePort = choosePort({
    requested: Number(env.DSH_SHELL_PAGE_PORT ?? '') || undefined,
    lastClaimed: previous?.port,
    isFree: portFree,
  })
  if (pagePort === null) throw new Error('页面 origin 端口池已耗尽')
  // 上游 dsh 端口（旧壳 `port_for_profile` + `DSH_DESKTOP_PORT`）：手机访问插件靠它找上游；
  // 固定端口而不是 `--port 0`，与旧壳一致（3080 web / 3081 desktop），被占就顺延并在日志里说清楚。
  // lane 端口先算：上游顺延时不能顺手把手机 lane 要占的端口抢走（两个都绑 127.0.0.1）
  // lane 端口先算：上游顺延时不能顺手把手机 lane 要占的端口抢走（两个都绑 127.0.0.1）；
  // 多窗口下同一个 env 覆盖会让两份服务面抢同一个 lane 端口，所以也要顺延（实测 EADDRINUSE）。
  const intendedLane = profileLanePort(settings, paths.profile, env)
  const laneFree = (port: number): boolean => port !== pagePort && portFree(port)
  const pickedLane = laneFree(intendedLane)
    ? intendedLane
    : choosePort({ requested: intendedLane, base: intendedLane + 1, span: 20, isFree: laneFree })
  if (pickedLane === null) throw new Error('手机 lane 端口池已耗尽')
  const lanePort: number = pickedLane
  if (lanePort !== intendedLane) {
    log(`手机 lane 端口 ${String(intendedLane)} 被占用，顺延到 ${String(lanePort)}`)
  }
  const intendedUpstream = profilePort(settings, paths.profile, env)
  const upstreamFree = (port: number): boolean => port !== lanePort && portFree(port)
  const pickedUpstream = upstreamFree(intendedUpstream)
    ? intendedUpstream
    : choosePort({
        requested: intendedUpstream,
        base: intendedUpstream + 1,
        span: 20,
        isFree: upstreamFree,
      })
  if (pickedUpstream === null) throw new Error('dsh 上游端口池已耗尽')
  // let：切 profile 时就地换掉（守护器重启宿主时读的是这里）
  let upstreamPort: number = pickedUpstream
  log(`端口：页面 origin ${String(pagePort)} | dsh 上游 ${String(upstreamPort)} | 手机 lane ${String(lanePort)}`)
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
      const scenarioId = NOTIFY_TYPE_SCENARIOS[payload.type]
      if (scenarioId === undefined) {
        log(`通知口收到未知类型 ${payload.type}，已忽略`)
        return
      }
      notifier.notify(scenarioId, payload.body)
    },
    onLog: log,
  })
  const keepAwake = createKeepAwake({ arbiter, log })
  if (settings.preventSleep) keepAwake.start()
  else log('防休眠：设置里已关闭（prevent_sleep = false）')

  // ---- 通知：决策在 notify-policy，这里只做「场景 → 投递」与宿主事件映射 ----
  // 旧壳 70 个调用点收敛到场景 id；新壳先接已有的调用点（宿主事件 + 服务健康 + 启动受阻）。
  // 通知权限：macOS 走我们自己的 UN 桥（旧壳 notify_un.rs 的等价物）——能读真实授权状态、
  // 能主动申请；Electrobun 只暴露投递，拿不到状态（面板上那个写死的「已授权」就是这么来的）。
  const notifyBridge = options.notifyBridge ?? createNativeNotify({ log, env, execPath: process.execPath })
  const notifier =
    options.notifier ??
    createNotifier({
      notifications: settings.notifications,
      home,
      onLog: log,
      show: notifyBridge.available
        ? (payload) => {
            const ok = notifyBridge.post({ title: payload.title, body: payload.body, sound: payload.silent !== true })
            if (!ok) log(`[notify] 原生桥拒绝投递：${payload.title}`)
          }
        : undefined,
    })
  if (notifyBridge.available) {
    notifyBridge.start()
    // start() 是异步的（原生层要等系统回调），第一行日志只能报「当时快照」；
    // 1.5s 后再报一次真实状态，诊断时一眼能看出到底是未决定还是被拒。
    const announce = (): void => {
      const permission = notifyBridge.status()
      log(
        `[notify-un] 通知权限：${permissionLabel(permission)}（${permissionHint(permission, options.platform ?? process.platform)}；err=${String(notifyBridge.lastError())}）`
      )
    }
    log(`[notify-un] 原生通知桥已就绪：${String(notifyBridge.libPath)}（权限：${permissionLabel(notifyBridge.status())}）`)
    announce()
    setTimeout(announce, 1_500).unref?.()
  }
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
  let patchFiles = [staged.injectFile]
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
        upstreamPort,
        lanePort,
        notify: { port: notifyServer.port, token: notifyServer.token },
      })
    } catch (error) {
      // 首次启动：dsh 刚把 profile 脚手架（cordis.yml/package.json）落盘，但依赖树还是空的，
      // 插件会整片 failed to import。摊平 profile 树后按 existing 重试一次——只在首启发生。
      if (
        hostMode !== 'fresh' ||
        !existsSync(`${paths.home}/profiles/${paths.profile}/package.json`)
      ) {
        throw error
      }
      log('首次启动：profile 已建立但依赖树为空，摊平 profile 树后重试')
      reconcileProfile()
      host = await startHost({
        layout: paths,
        clientVersion: options.clientVersion,
        mode: 'existing',
        env: childEnv,
        onLog: log,
        patchFiles,
        upstreamPort,
        lanePort,
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
  // 壳 ↔ 页面 RPC：命令表要等 service 对象建好才能回填（restart_dsh_service 直接打它）。
  // 页面在服务就绪后才会来调，所以那时一定已装好；未装好则明确回 503。
  let rpcRouter: RpcRouter | null = null
  // 设置面板会写盘：内存里也同步一份，免得面板读回来还是旧值
  let liveSettings = settings
  // 下载管理器（旧壳 `download/{manager,transfer}.rs`）：URL 直链与页面 blob 两条管线共用一份任务表。
  // cookie 只在「下载目标就是壳对接的那个 dsh 实例」时带（旧壳 transfer.rs 同语义）；
  // 页面 origin 的请求由壳自己的反代补 cookie，所以它不需要这里带。
  const downloads = createDownloadManager({
    home,
    log,
    notify: (filename) => notifier.notify(SCENARIO.DOWNLOAD_COMPLETE, filename, '下载完成'),
    chooseDirectory: options.chooseDownloadDir,
    concurrency: liveSettings.downloadConcurrency,
    saveConcurrency: (value) => {
      liveSettings = updateSettings(home, { download_concurrency: value }, log)
    },
    cookieFor: (url) => {
      if (serverOptions.cookie === undefined || serverOptions.cookie === '') return null
      try {
        const origin = new URL(url).origin
        if (origin === serverOptions.upstreamOrigin) return serverOptions.cookie
      } catch {
        return null
      }
      return null
    },
    downloadDir: join(env.HOME ?? home, 'Downloads'),
  })
  // 命令表要的运行时快照：设置里的来源 + 当前生效的运行时 + 已装列表 + 外部 dsh 定位。
  // 每次调用都重算（面板刷新时顺带发现新装/新删的版本；旧壳同样在命令里现查）。
  const runtimeSnapshot = (): RuntimeSnapshot => {
    const mode = liveSettings.dshMode ?? 'builtin'
    // 外部来源取「能用」的那一个：PATH 上可能先撞到壳自己的垫片脚本（定位不到包根）
    const external = mode === 'external' ? resolveExternalRuntime(env, { home: env.HOME, log }) : null
    const externalBin = external?.bin ?? null
    const externalRoot = externalBin === null ? null : externalPackageRoot(externalBin)
    const builtinDir = resolveBuiltinRuntimeDir(env, { repoRoot: paths.repoRoot, resourcesDir: paths.resourcesDir })
    return {
      mode,
      builtinVersion: builtinDir === null ? null : readRuntimeVersion(builtinDir),
      activeVersion: paths.runtimeVersion,
      activeKind: paths.runtimeKind,
      activeDir: paths.runtimeDir,
      selected: liveSettings.dshRuntime ?? null,
      installed: listInstalledRuntimes(paths.appSupport),
      externalPath: externalBin,
      externalVersion: external?.version ?? (externalRoot === null ? null : externalVersion(externalRoot)),
    }
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
    onRpc: async (raw) => {
      if (rpcRouter === null) return { status: 503, body: { ok: false, error: 'shell rpc not ready' } }
      return await dispatchRpc(rpcRouter, raw)
    },
  }
  const server = startShellServer(serverOptions)
  options.onStage?.('server')
  bootPayload.injections = host.ready.injections
  const pageUrl = `${server.origin}/${token}/`

  // 写入前重读磁盘：多窗口下台账被所有服务面共享，内存副本可能是旧的（否则会覆盖掉别人的行）。
  const writeClaim = async (): Promise<void> => {
    const onDisk = pruneClaims(parseClaims(await readClaims()), isAlivePid)
    const merged = upsertClaim(onDisk, {
      profile: claimProfile,
      port: pagePort,
      lanePort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })
    claims = merged
    await Bun.write(claimsFile, `${JSON.stringify(merged, null, 2)}\n`)
  }
  await writeClaim()
  // 底部状态条轮询的 dsh 服务状态码（旧壳 0..7：2 运行中 / 4 重启中 / 5 服务异常 / 6 服务下线）。
  // 页面重载后状态条要能立刻显示真值，所以每个阶段都得维护它。
  let dshStatusCode = 2

  const state: ShellState = {
    pid: process.pid,
    origin: server.origin,
    pageUrl,
    token,
    profile: paths.profile,
    runtimeDir: paths.runtimeDir,
    distDir: paths.distDir,
    hostPid: host.pid,
    upstreamPort,
    lanePort,
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
      dshStatusCode = 5
      options.onHostGiveUp?.(state, decision.reason)
      notifier.notify(SCENARIO.STARTUP_ERROR, `dsh 服务无法恢复：${decision.reason}`)
      return
    }
    dshStatusCode = 4
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
    dshStatusCode = 2
    applyHost()
    log(`守护器已重启宿主：pid = ${String(host.pid)} | injections = ${String(bootPayload.injections.length)}`)
    notifier.notify(SCENARIO.SERVICE_HEALTH, `dsh 服务已自动重启（${paths.profile}）`)
    options.onHostRestart?.(state)
    void supervise()
  }
  registerHost()
  void supervise()
  log(`端口台账：${JSON.stringify(claims)}`)
  options.onStage?.('ready')

  // 写设置的唯一路径：命令表（设置面板）与壳侧（托盘切运行时）都走它
  const saveSettings = (patch: Record<string, unknown>): DesktopSettings => {
    liveSettings = updateSettings(home, patch, log)
    state.settings = liveSettings
    state.settingsProvenance = { created: false, migrated: false, recovered: false }
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    return liveSettings
  }
  const service: ShellService = {
    state,
    paths,
    server,
    notify: notifyBridge,
    settings: () => liveSettings,
    save: saveSettings,
    runtime: () => runtimeSnapshot(),
    fetchCatalog: (source) =>
      fetchRuntimeCatalog({ source, repo: liveSettings.runtimeGithubRepo ?? null, log }),
    downloadStatus: () => downloader.status(),
    download: (version, source) => downloader.start(version, source),
    restartHost: async () => {
      if (stopping) return
      // 设置面板切了 dsh 来源/运行时版本：这里重新解析选中项（同一个 paths 对象就地更新，
      // 服务面、状态与命令表都以它为事实源），再杀宿主——守护器会带着新运行时重启。
      const next = layout({
        env,
        profile: paths.profile,
        mode: liveSettings.dshMode,
        preferred: liveSettings.dshRuntime,
      })
      if (next.runtimeDir !== paths.runtimeDir) {
        log(
          `运行时切换：${paths.runtimeVersion ?? paths.runtimeDir} → ${next.runtimeVersion ?? next.runtimeDir}（${next.runtimeKind}）`
        )
      }
      Object.assign(paths, next)
      serverOptions.distDir = paths.distDir
      state.runtimeDir = paths.runtimeDir
      state.distDir = paths.distDir
      void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
      // 杀掉当前宿主即可：退出会唤醒守护器，由它重启并把服务面切过去
      await host.stop()
    },
    // 多窗口：不再就地换 profile（旧壳的「托盘切换 profile」在新壳里就是把那份 profile 的窗口开到前台）。
    stop: async () => {
      stopping = true
      dshStatusCode = 6
      ledger.reset()
      server.stop()
      notifyServer.stop()
      keepAwake.stop()
      arbiter.clear()
      downloads.stop()
      try {
        await host.stop()
      } catch {}
      forgetHosts()
      // 同样先重读：退出时只能摘掉自己那一行，别人的行要留着
      const next = releaseClaim(parseClaims(await readClaims()), claimProfile)
      try {
        await Bun.write(claimsFile, `${JSON.stringify(next, null, 2)}\n`)
      } catch {}
    },
  }
  // 命令表回填：页面侧的壳插件（设置面板/通知 tab/下载 tab/本地 chrome）靠它拿到壳的能力
  rpcRouter = createRpcRouter(
    createCommandTable({
      home,
      profile: () => paths.profile,
      platform: options.platform ?? process.platform,
      log,
      settings: () => liveSettings,
      save: saveSettings,
      restartService: () => service.restartHost(),
      status: () => ({ ...state }),
      ports: () => ({ port: pagePort, lanePort }),
      // 设置面板的 Profile 端口表要看到所有 profile（多窗口）：行来自共享台账 + 磁盘 profile 目录
      portClaims: async () => pruneClaims(parseClaims(await readClaims()), isAlivePid),
      profiles: () => listProfiles(home, paths.profile),
      openExternal: options.onOpenExternal,
      closeWindow: options.onCloseWindow,
      playSound: (name) => {
        notifier.previewSound(name)
      },
      playSystemSound: () => {
        const command = systemDefaultSoundCommand(options.platform ?? process.platform)
        if (command === null) {
          log('[notify] 系统默认提示音只在 macOS 上试听')
          return
        }
        try {
          const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
          child.unref?.()
          log(`[notify] 试听系统提示音：${command.join(' ')}（pid = ${String(child.pid)}）`)
        } catch (error) {
          log(`[notify] 系统音试听失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
      pickSoundFile: options.pickSoundFile,
      importSound: (path) => importSoundFile(home, path),
      notifier,
      // 通知 tab 的权限徽标 / 「申请权限」按钮：真值来自我们的 UN 桥（非 macOS 或没打包时回 unavailable）
      notifyPermission: () => notifyBridge.status(),
      notifyRequestPermission: () => notifyBridge.request(),
      dshStatus: () => dshStatusCode,
      dshVersion: () => paths.runtimeVersion ?? basename(paths.runtimeDir),
      runtime: () => runtimeSnapshot(),
      fetchCatalog: (source) =>
        fetchRuntimeCatalog({ source, repo: liveSettings.runtimeGithubRepo ?? null, log }),
      removeRuntime: async (version) => {
        trashInstalledRuntime(paths.appSupport, version, log)
      },
      downloadRuntime: (version, source) => downloader.start(version, source),
      downloadStatus: () => downloader.status(),
      downloads,
      downloadDir: join(env.HOME ?? home, 'Downloads'),
    }),
  )
  return service
}
