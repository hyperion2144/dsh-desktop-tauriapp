// 壳的「服务面」：运行时就位 → 认领端口 → 起宿主 → 取 cookie → 起 loopback 服务。
//
// 这一层**不 import electrobun**，所以缝 ① 的黑盒测试与「无窗口启动契约」可以直接用
// 普通 bun 跑（无显示器、无 CEF 的 CI 也能跑），窗口是 index.ts 的事。

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { choosePort, claimFor, parseClaims, pruneClaims, releaseClaim, upsertClaim } from '../shared/ports.ts'
import { decideClaim, extractTokenFromUrl } from '../shared/port-claim.ts'
import { startLaneForwarder, type LaneForwarder } from './lane-forwarder.ts'
import { normalizeRemoteUrl, remoteDisplay, remoteHostPort, remoteOrigin } from '../shared/remote.ts'
import { createWatchdogState, tickWatchdog, WATCHDOG_INTERVAL_MS } from '../shared/watchdog.ts'
import { portOpen, stopPortOwner } from './port-owner.ts'
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
import { isValidProfileName, isSelfMigrate } from './profile-dialog.ts'
import type { ProfileOpRequest, ProfileOpResult } from './profile-dialog.ts'
export type { ProfileOpRequest, ProfileOpResult } from './profile-dialog.ts'
import { cleanupStagedPlugins, stagePlugins } from './plugin-staging.ts'
import { createArbiter } from '../shared/power-arbiter.ts'
import { resolveProxyEnv } from '../shared/proxy-env.ts'
import { detectSystemProxy } from './system-proxy.ts'
import type { ProxyEnv } from '../shared/proxy-env.ts'
import { createKeepAwake } from './keep-awake.ts'
import { startNotifyServer } from './notify-server.ts'
import { createNotifier, importSound as importSoundFile, systemDefaultSoundCommand, type Notifier } from './notifications.ts'
import { createNativeNotify, type NativeNotify } from './notify-un.ts'
import type { ViewRegistry } from '../shared/view-grant.ts'
import type { GuestCommands } from './guest-manager.ts'
import { createUpdater, type ShellUpdater } from './updater.ts'
import { permissionHint, permissionLabel } from '../shared/notify-permission.ts'
import { NOTIFY_TYPE_SCENARIOS, SCENARIO } from '../shared/notify-policy.ts'
import { activeProfile, profileLanePort, profilePort, settingsSummary, type DesktopSettings } from '../shared/settings.ts'
import { createCommandTable, type RuntimeSnapshot } from './commands.ts'
import { createRpcRouter, dispatchRpc, type RpcRouter } from './rpc.ts'
import { updateSettings } from './settings-store.ts'
import type { RuntimeDownloadStatus } from './runtime-install.ts'
import { listProfiles } from './profiles.ts'
import { createDownloadManager } from './downloads.ts'
import { createLogSink, describeLogFile } from './log-sink.ts'
import { buildDiagnostics, DIAG_TAIL_LINES, type DiagnosticsInput } from '../shared/diagnostics.ts'
import { exportDiagnostics } from './diagnostics.ts'
import { classifyLevel, mirrorToShellLog, pageLogLines } from '../shared/log-file.ts'
import { revealPath } from './downloads.ts'
import { release as osRelease, cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from 'node:os'
import { builtinPnpmVersion, createTaskTracker, installProfileDependencies, migrateProfile, profileDependencyRows, profileHealth, testProxyConnectivity } from './profile-manager.ts'
import { readKeybindings, writeKeybindings } from './keybindings.ts'
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
  /** 打开另一个 profile 的窗口（启动确认选了别的 profile 时用；多窗口见 index.ts） */
  onOpenProfileWindow?: (profile: string) => Promise<void>
  /** F13：窗口⇄最大化切换（index.ts 操作 focusedWindow） */
  onZoomToggle?: () => void
  /** 页面右键菜单（主进程实现） */
  onContextMenu?: (request: ContextMenuRequest) => void
  /** 宿主被守护器重启成功（主进程用它把页面刷回来） */
  onHostRestart?: (state: ShellState) => void
  /** 宿主反复退出，守护器放弃（不再重启） */
  onHostGiveUp?: (state: ShellState, reason: string) => void
  /** F9：托盘弹框的 profile 新建/迁移落地后（create → 开窗，migrate → 刷新托盘） */
  onProfileOpApplied?: (op: 'create' | 'migrate', profile: string) => void
  /** F12：页面内确认弹窗的回填（壳主进程的 pending-input 单槽） */
  onInputConfirm?: (flow: string, value: string) => void
  /** 启动阶段变化（启动界面据此报进度；无窗口模式也会调） */
  onStage?: (stage: ShellStage) => void
  /** 第二个实例请求把窗口带到前台（单实例激活） */
  onActivate?: () => void
  /** 自绘窗口控制（A5）：页面三键 → 主进程操作 BrowserWindow */
  onWindowControl?: (action: 'minimize' | 'toggle-maximize' | 'close') => void
  onLog?: (line: string) => void
  /** 通知权限桥（index.ts 注入同一个实例；缺省自建） */
  notifyBridge?: NativeNotify
  /** 应用更新（index.ts 可注入同一个实例；缺省自建；单测可注入假实现） */
  updater?: ShellUpdater
  settings?: DesktopSettings
  /** 通知器（index.ts 注入 Electrobun 原生通道；缺省走命令行兜底） */
  notifier?: Notifier
  /** 弹原生文件选择器选音频（index.ts 注入；缺省返回 null） */
  pickSoundFile?: () => Promise<string | null>
  /** 弹目录选择器选下载位置（index.ts 注入 Electrobun 的 openFileDialog；缺省落 ~/Downloads） */
  chooseDownloadDir?: (start: string) => Promise<string | null>
  views?: ViewRegistry
  /** 浏览器 guest 命令（guest 挂在发起调用的窗口上，所以由窗口层实现并注入） */
  guests?: GuestCommands
  /** 应用版本（诊断快照里报；index.ts 注入壳自己的版本号） */
  appVersion?: string
  /** 页面语言（诊断快照里报） */
  locale?: string
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
  /** 接入模式（旧壳 DshState.mode 的内存态：compat 复用外部实例、advanced 壳自拉） */
  mode: 'advanced' | 'compat'
  /** 启动被阻塞的原因（旧壳 ForeignUnknown：端口被陌生程序占用，只报错不代杀）；未阻塞时无此字段 */
  blocked?: string
}

export interface ShellService {
  state: ShellState
  paths: ShellLayout
  server: ShellServer
  /** 手机稳定接入点（遗留 lane 端口 → 本实例 lane）；多实例下只有先起的服务面持有（其余 null） */
  laneForwarder: LaneForwarder | null
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
  /** 兼容/高级模式弹框当前是否在等用户选（旧壳 get_mode_prompt_needed） */
  modePromptNeeded: () => boolean
  /** 选模式（旧壳 choose_desktop_mode）：compat 复用外部实例（可带 tokenUrl），advanced 清场后壳自拉 */
  chooseDesktopMode: (mode: string, tokenUrl?: string) => Promise<{ ok: true; needsToken: boolean }>
  /** 等待用户选完模式；无弹框时启动即已定（advanced），立即 resolve */
  modeChosen: Promise<'advanced' | 'compat'>
  /** 新建 / 迁移 profile（F9：托盘弹框的落点；结果回给弹框展示） */
  profileOp: (request: ProfileOpRequest) => Promise<ProfileOpResult>
  /** profileOp 落地后的回调（create → 开窗，migrate → 刷新托盘）；测试可注入 */
  onProfileOpApplied: (op: 'create' | 'migrate', profile: string) => void
}

export async function startService(options: ServiceOptions): Promise<ShellService> {
  const env = options.env ?? process.env
  const home = env.DSH_HOME ?? join(env.HOME ?? '.', '.dsh')
  const logFile = env.DSH_SHELL_LOG ?? join(home, 'shell.log')
  const webviewLogFile = join(home, 'dsh-desktop-webview.log')
  const stateFile = env.DSH_SHELL_STATE_FILE ?? join(home, 'shell-state.json')
  const claimsFile = env.DSH_SHELL_PORT_CLAIMS ?? join(home, 'shell-ports.json')
  mkdirSync(home, { recursive: true })

  // 壳日志：本地时区时间戳 + 有界轮转（10 MB × 5 份；旧壳 KeepAll 实测堆了 90+ 份）。
  const shellLog = createLogSink({
    file: logFile,
    stdout: (line) => console.log(line),
    onRotate: ({ moved, deleted }) => console.log(`[shell] 日志轮转：搬 ${String(moved)} 份、删 ${String(deleted)} 份`),
  })
  // 页面控制台另写一份（旧壳路径 `$DSH_HOME/dsh-desktop-webview.log`，不镜像到 stdout）。
  const pageLog = createLogSink({ file: webviewLogFile })

  const log = (line: string): void => {
    shellLog.line(line)
    options.onLog?.(line)
  }
  /** D6：运行时回退提示先记着，notifier 建好后补发（回退发生在 notifier 创建之前） */
  let pendingRuntimeNote: string | null = null

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
  if (paths.runtimeNote !== null) {
    log(`运行时回退：${paths.runtimeNote}`)
    // D6：notifier 在下面才建好，先记下，建好后补发
    pendingRuntimeNote = paths.runtimeNote
  }
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
  // 上游/lane 固定端口（旧壳公式，用户口径：不做随机端口与顺延）：
  //   上游 = env DSH_DESKTOP_PORT > profile_ports >（web 的遗留 port）> 3080/3081/3082+fnv%512
  //   lane = env DSH_MOBILE_LANE_PORT > profile_lane_ports >（web 的遗留 lane_port）> 3092/3093/3094+fnv%512
  // 跨进程的端口冲突不做静默顺延：启动前判定（见下方 decideClaim），弹「兼容/高级」或明确报错。
  // 同进程多窗口的互相避让用 taken（含其它服务面已占的端口与页面端口），只在会话内存里记。
  const taken = new Set<number>([pagePort])
  for (const claim of claims) {
    taken.add(claim.port)
    if (claim.dataPort !== undefined) taken.add(claim.dataPort)
    if (claim.lanePort !== undefined) taken.add(claim.lanePort)
  }
  const lanePort: number = profileLanePort(settings, paths.profile, env, taken)
  taken.add(lanePort)
  const upstreamPort: number = profilePort(settings, paths.profile, env, taken)
  taken.add(upstreamPort)
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

  /**
   * 选中运行时的版本号：优先用运行时树自报的 package.json 版本，目录名只当兜底。
   *
   * 为什么不能只看目录名：内置树落在 `<Resources>/app/dsh`（目录名就是 `dsh`），
   * 目录名当版本号会让 `versionAtLeast('dsh', …)` 判否 ⇒ 注入清单退回旧的 `webRuntime`
   * 契约 ⇒ 宿主报 `connection (required) webRuntime` 而启动失败（实测）。
   */
  const runtimeVersion = paths.runtimeVersion ?? basename(paths.runtimeDir)
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
  if (pendingRuntimeNote !== null) {
    notifier.notify(SCENARIO.CONFIG_ERROR, `运行时回退：${pendingRuntimeNote}`)
    pendingRuntimeNote = null
  }
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
  // ②b 应用更新（#220 决策 11）：旧壳没有这个能力，是新增件——包住框架 Updater。
  // 拿不到更新源（dev 构建 / 未配 release.baseUrl）时只记日志，面板里显示「为什么不可用」。
  const updater = options.updater ?? createUpdater({ log, env })
  updater.start()
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
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  let hostOrigin = ''
  let hostInjections: readonly unknown[] = []
  let cookie = ''
  // 起宿主 + 取 cookie。守护器重启时重复调这个（同一个 cookie 变量与服务面 options）。
  // 设置面板会写盘：内存里也同步一份，免得面板读回来还是旧值（必须先于 connect：connect 里会读）
  let liveSettings = settings
  // 远程 dsh 地址（旧壳 select_remote）：设置里存了就进入远程模式——本地文档 + 远程数据面，
  // 不 spawn 宿主（「远程只是少了启动 dsh 这一步」）。restartHost 会重算。
  let remoteAddr: string | null = normalizeRemoteUrl(liveSettings.remoteAddr ?? '')
  /**
   * 代理注入（旧壳 `resolved_proxy_env` + `system_proxy_env`）：manual 用设置里的 URL，
   * system 问系统（macOS `scutil` / Windows 注册表 / 其余环境变量），off 不注入。
   * 每次 spawn 现算——面板改完代理重启服务面就生效。
   */
  const childProxy = (): ProxyEnv | null =>
    resolveProxyEnv(liveSettings, detectSystemProxy({ platform: process.platform, env: childEnv, log }))
  const connect = async (): Promise<void> => {
    if (remoteAddr !== null) {
      // ---- 远程模式（旧壳 navigate_remote / startup 远程短路）：不 spawn 宿主，数据面指向远程。
      // URL 里的 token 换会话 cookie；拿不到照常起服务面，由 dsh 自行展示鉴权错误页（旧壳同口径）。
      host = undefined
      hostInjections = []
      const upstream = remoteOrigin(remoteAddr)
      const token = extractTokenFromUrl(remoteAddr)
      cookie = ''
      if (token !== null) {
        try {
          const auth = await fetch(`${upstream}/?token=${token}`, { redirect: 'manual' })
          const setCookies = (auth.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
          cookie = setCookies[0]?.split(';')[0] ?? ''
          log(`[remote] 换 cookie：auth ${String(auth.status)} | cookie = ${cookie === '' ? '(none)' : `${cookie.slice(0, 18)}…`}`)
        } catch (error) {
          log(`[remote] 换 cookie 失败（照常继续，由 dsh 展示鉴权页）：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        log('[remote] 地址里没有 ?token=（旧格式 host:port），按老版 dsh 直连（新版会 401）')
      }
      hostOrigin = upstream
      log(`[remote] 数据面上游 = ${remoteDisplay(remoteAddr)} | 页面文档仍由本机 dist 出`)
      return
    }
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
        proxy: childProxy(),
        cloudflaredBin: liveSettings.cloudflaredBin,
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
        proxy: childProxy(),
        cloudflaredBin: liveSettings.cloudflaredBin,
        notify: { port: notifyServer.port, token: notifyServer.token },
      })
    }
    hostOrigin = new URL(host.ready.url).origin
    hostInjections = host.ready.injections
    log(`host ready | dsh = ${hostOrigin} | injections = ${String(hostInjections.length)}`)

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
  // ---- 端口认领判定（旧壳 decide_claim：启动前判定，free 才自动拉起）----
  const upstreamOpen = await portOpen(upstreamPort)
  const oursAlive = readHostRecords(hostRegistryFile).some(
    (record) => record.profile === paths.profile && isAlivePid(record.hostPid),
  )
  const decision = decideClaim({
    profile: paths.profile,
    port: upstreamPort,
    portOpen: upstreamOpen,
    claims: oursAlive ? [{ profile: paths.profile, port: upstreamPort, alive: true }] : [],
    legacyWebPort: profilePort(settings, 'web', env),
  })
  // 接入模式与弹框状态（旧壳 DshState：内存态，不落盘、重启后端口仍被占会再问）
  let shellMode: 'advanced' | 'compat' = 'advanced'
  let modePromptNeeded = false
  let resolveModeChoice!: (mode: 'advanced' | 'compat') => void
  const modeChosen = new Promise<'advanced' | 'compat'>((resolvePromise) => {
    resolveModeChoice = resolvePromise
  })
  let blockedMessage: string | undefined
  // 远程模式跳过本地端口认领（旧壳 startup 远程短路：根本不走本地 spawn 链）
  if (remoteAddr !== null || decision === 'free') {
    await connect()
  } else if (decision === 'foreign-unknown') {
    blockedMessage = `端口 ${String(upstreamPort)} 被其他实例或程序占用（profile=${paths.profile}），已停止自动拉起；可在设置中调整该 profile 的端口后重试`
    log(`[shell] ${blockedMessage}`)
  } else if (remoteAddr === null) {
    modePromptNeeded = true
    log(`[shell] 127.0.0.1:${String(upstreamPort)} 已有${decision === 'ours' ? '本壳拉起过的' : '外部'} dsh 实例在监听，等待选择「兼容 / 高级」接入模式`)
  }
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
  // 启动检查的进程内状态（旧壳 DshState：skip_startup_check 与 pending_active_profile 都不落盘）
  let startupChecked = false
  let pendingProfile: string | null = null
  // 迁移/依赖重建的进度（设置面板 300ms 轮询 migration_status）
  const taskTracker = createTaskTracker()
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
    upstreamOrigin: hostOrigin !== '' ? hostOrigin : `http://127.0.0.1:${String(upstreamPort)}`,
    port: pagePort,
    bootPayload: () => bootPayload,
    onOpenExternal: options.onOpenExternal,
    onContextMenu: options.onContextMenu,
    onActivate: options.onActivate,
    onWindowControl: options.onWindowControl,
    onProfileOp: (request) => service.profileOp(request),
    onInputConfirm: options.onInputConfirm,
    getModePrompt: () => ({ needed: modePromptNeeded, profile: paths.profile, port: upstreamPort }),
    chooseMode: (mode, tokenUrl) => chooseDesktopMode(mode, tokenUrl),
    views: options.views,
    onLog: log,
    onRpc: async (raw, grant) => {
      if (rpcRouter === null) return { status: 503, body: { ok: false, error: 'shell rpc not ready' } }
      return await dispatchRpc(
        rpcRouter,
        raw,
        grant === null ? {} : { caller: { kind: grant.kind, profile: grant.profile, label: grant.label } },
      )
    },
  }
  const server = startShellServer(serverOptions)
  options.onStage?.('server')
  bootPayload.injections = [...hostInjections]
  // 手机稳定接入点（旧壳 forwarder.rs #94）：监听遗留 lane 端口（settings.lanePort，默认 3091），
  // 新连接落本实例的 lane；外部 dsh 占了端口时退场（手机直连它即可）。多实例下只有先起的那份
  // 服务面拿得到转发器（同端口第二绑定必失败），index.ts 的焦点切换会找到它更新目标。
  const forwarder = startLaneForwarder({ port: settings.lanePort ?? 3091, log })
  forwarder?.setTarget(lanePort)
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
    hostPid: host?.pid ?? 0,
    upstreamPort,
    lanePort,
    notifyPort: notifyServer.port,
    injections: bootPayload.injections.length,
    noWindow: options.noWindow ?? false,
    settings,
    settingsProvenance: { created: loaded.created, migrated: loaded.migrated, recovered: loaded.recovered },
    mode: shellMode,
    ...(blockedMessage === undefined ? {} : { blocked: blockedMessage }),
  }
  await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)

  // ---- 兼容 / 高级模式（旧壳 choose_desktop_mode + get_mode_prompt_needed）----
  const chooseDesktopMode = async (mode: string, tokenUrl?: string): Promise<{ ok: true; needsToken: boolean }> => {
    if (mode !== 'compat' && mode !== 'advanced') throw new Error(`未知的桌面接入模式：${mode}`)
    modePromptNeeded = false
    if (mode === 'compat') {
      const raw = (tokenUrl ?? '').trim()
      const token = extractTokenFromUrl(raw)
      if (raw !== '' && token === null) log('[mode] 未能识别 token：输入里没有 ?token= 参数，将按老版 dsh 直连（新版会 401）')
      shellMode = 'compat'
      if (token !== null) {
        try {
          const auth = await fetch(`http://127.0.0.1:${String(upstreamPort)}/?token=${token}`, { redirect: 'manual' })
          const setCookies = (auth.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
          cookie = setCookies[0]?.split(';')[0] ?? ''
          serverOptions.cookie = cookie
          log(`[mode] 兼容模式：auth ${String(auth.status)} | cookie = ${cookie === '' ? '(none)' : `${cookie.slice(0, 18)}…`}`)
        } catch (error) {
          log(`[mode] 兼容模式换 cookie 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      state.pageUrl = token !== null ? `http://127.0.0.1:${String(upstreamPort)}/?token=${token}` : `http://127.0.0.1:${String(upstreamPort)}/`
      state.mode = 'compat'
      void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
      resolveModeChoice('compat')
      return { ok: true, needsToken: raw === '' }
    }
    // 高级：清场后由壳自己拉起
    const freed = await stopPortOwner({ port: upstreamPort, log })
    if (!freed) throw new Error('等待本地服务就绪超时，请查看下方日志输出并重试。')
    await connect()
    shellMode = 'advanced'
    applyHost()
    state.pageUrl = `${server.origin}/${token}/`
    state.mode = 'advanced'
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    resolveModeChoice('advanced')
    return { ok: true, needsToken: false }
  }

  // ---- 诊断快照（#220 日志与诊断）：一个 JSON 回答「哪版、哪个 profile、端口/pod、日志在哪」----
  const startedAt = new Date().toISOString()
  const pageLogPath = webviewLogFile
  const diagnosticsInput = (): DiagnosticsInput => ({
    appVersion: options.appVersion ?? 'unknown',
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - Date.parse(startedAt),
    noWindow: state.noWindow,
    locale: options.locale ?? 'zh-CN',
    profile: paths.profile,
    origin: state.origin,
    pageUrl: state.pageUrl,
    pagePort,
    upstreamPort: state.upstreamPort,
    lanePort: state.lanePort,
    hostPid: state.hostPid,
    hostRunning: state.hostPid > 0,
    runtimeKind: paths.runtimeKind,
    runtimeVersion: paths.runtimeVersion,
    runtimeDir: paths.runtimeDir,
    distDir: paths.distDir,
    injections: state.injections,
    settingsSummary: settingsSummary(settings),
    settingsPath: join(home, 'desktop-settings.json'),
    settingsProvenance: state.settingsProvenance,
    views: (options.views?.list() ?? []).map((grant) => ({ kind: grant.kind, profile: grant.profile, label: grant.label })),
    downloads: {
      tasks: downloads.list().length,
      active: downloads.list().filter((task) => task.status === 'downloading' || task.status === 'queued').length,
      concurrency: downloads.concurrency(),
    },
    notify: {
      available: notifyBridge.available,
      permission: notifyBridge.available ? notifyBridge.status() : 'unavailable',
      port: state.notifyPort,
    },
    logs: {
      shell: describeLogFile(logFile),
      webview: describeLogFile(pageLogPath),
      tail: shellLog.tail(DIAG_TAIL_LINES),
    },
    process: {
      platform: options.platform ?? process.platform,
      arch: process.arch,
      osRelease: osRelease(),
      bun: Bun.version,
      ...(process.versions.node === undefined ? {} : { node: process.versions.node }),
      cpus: osCpus().length,
      totalMemBytes: osTotalmem(),
      freeMemBytes: osFreemem(),
    },
  })
  const diagnosticsSnapshot = (): Record<string, unknown> => buildDiagnostics(diagnosticsInput(), new Date())

  /** 页面控制台一条消息：写 `dsh-desktop-webview.log`；warn/error 另镜像一份到壳日志（旧壳同口径） */
  const logPageConsole = (input: { level: string; msg: string; pageUrl: string | null }): void => {
    const level = classifyLevel(input.level)
    for (const line of pageLogLines({ level, msg: input.msg, pageUrl: input.pageUrl })) pageLog.write(`${line}\n`)
    if (mirrorToShellLog(level)) log(`[page.${level}] ${input.msg.split('\n')[0] ?? ''}`)
  }

  // ---- 宿主守护器：异常退出就退避重启，并把服务面切到新宿主（页面不再停在转发失败） ----
  const ledger = createRestartLedger()
  let stopping = false
  const registerHost = (): void => {
    const records = upsertHostRecord(readHostRecords(hostRegistryFile), {
      hostPid: host?.pid ?? 0,
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
    bootPayload.injections = [...hostInjections]
    serverOptions.cookie = cookie
    state.hostPid = host?.pid ?? 0
    state.injections = bootPayload.injections.length
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }
  const supervise = async (): Promise<void> => {
    registerHost()
    const code = await host?.exited
    if (stopping) return
    // 旧实例没了 = 它的忙租约不再会被刷新：先摘干净再决定要不要重启。
    arbiter.clear()
    keepAwake.tick()
    const decision = ledger.decide(Date.now())
    log(`宿主 ${String(host?.pid ?? 0)} 意外退出（code = ${String(code)}）：${decision.reason}`)
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
    log(`守护器已重启宿主：pid = ${String(host?.pid ?? 0)} | injections = ${String(bootPayload.injections.length)}`)
    notifier.notify(SCENARIO.SERVICE_HEALTH, `dsh 服务已自动重启（${paths.profile}）`)
    options.onHostRestart?.(state)
    void supervise()
  }
  if (host !== undefined) {
    registerHost()
    void supervise()
  } else {
    log('端口被外部实例占用：等用户选完「兼容 / 高级」再拉起（弹框期间不 spawn 宿主）')
  }
  log(`端口台账：${JSON.stringify(claims)}`)
  options.onStage?.('ready')

  // ---- D2 守护器：周期 TCP 判活（旧壳 lib.rs 守护器的等价物，语义照旧壳）----
  // 只管「运行中」：readyOnce 之前（启动/重启期/等选模式）归 spawn 与守护器退出事件管。
  let readyOnce = remoteAddr !== null || decision === 'free'
  const watchdog = createWatchdogState()
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  const probePort = (): number => {
    if (remoteAddr !== null) {
      const port = Number(remoteHostPort(remoteAddr).split(':').pop() ?? '')
      if (Number.isInteger(port) && port > 0) return port
    }
    return upstreamPort
  }
  const watchdogTick = async (): Promise<void> => {
    if (stopping || !readyOnce) return
    const up = await portOpen(probePort())
    const verdict = tickWatchdog(watchdog, {
      up,
      spawned: host !== undefined,
      remote: remoteAddr !== null,
      now: Date.now(),
    })
    if (verdict.kind === 'healthy') {
      if (verdict.reset) log('[watchdog] 连续健康 ≥2 分钟，自愈计数已重置')
      return
    }
    if (verdict.kind === 'remote-down') {
      if (verdict.notify) notifier.notify(SCENARIO.SERVICE_HEALTH, `远程 dsh 不可达：${verdict.verbose}`)
      return
    }
    if (verdict.kind === 'external-down') {
      log(`[watchdog] 外部 dsh 实例不可达，未自动重启（那是用户的实例）`)
      if (verdict.notify) notifier.notify(SCENARIO.SERVICE_HEALTH, '复用的外部 dsh 实例已停止，请手动重启服务')
      return
    }
    if (verdict.kind === 'gave-up') {
      log('[watchdog] 连续自动恢复失败 3 次，停止自愈')
      notifier.notify(SCENARIO.SERVICE_HEALTH, 'dsh 服务异常：连续自动恢复失败，请手动重启')
      return
    }
    log(`[watchdog] dsh 不可达（TCP 探测失败），自动重启（第 ${String(verdict.attempt)} 次）`)
    notifier.notify(SCENARIO.SERVICE_HEALTH, `dsh 服务异常，正在自动重启（第 ${String(verdict.attempt)} 次）`)
    if (host !== undefined) {
      // 交给退出事件那条路：守护器杀旧拉新，watchdog 的封顶比它的退避更严
      void host.stop().catch(() => {})
    } else if (remoteAddr !== null) {
      try {
        await connect()
        serverOptions.upstreamOrigin = hostOrigin !== '' ? hostOrigin : serverOptions.upstreamOrigin
        applyHost()
      } catch (error) {
        log(`[watchdog] 远程重连失败：${String(error)}`)
      }
    }
  }
  watchdogTimer = setInterval(() => { void watchdogTick() }, WATCHDOG_INTERVAL_MS)

  // 写设置的唯一路径：命令表（设置面板）与壳侧（托盘切运行时）都走它
  const saveSettings = (patch: Record<string, unknown>): DesktopSettings => {
    liveSettings = updateSettings(home, patch, log)
    state.settings = liveSettings
    state.settingsProvenance = { created: false, migrated: false, recovered: false }
    void Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    return liveSettings
  }

  /** profile 依赖重建（旧壳 profiles.rs 的 pnpm_install_profile）：内置 pnpm install --no-frozen-lockfile */
  const rebuildProfileDependencies = async (profile: string): Promise<string> => {
    // 新 profile 先落四份模板（没有 package.json 时 pnpm install 直接报错）——旧壳在 repair 前也会先补模板。
    scaffoldProfile(home, profile)
    const result = await installProfileDependencies({
      home,
      profile,
      appSupport: paths.appSupport,
      runtimeRoot: paths.runtimeDir,
      env: childEnv,
      log,
    })
    if (!result.ok) throw new Error(result.error)
    return `${profile}：依赖已重建`
  }
  const service: ShellService = {
    state,
    paths,
    server,
    laneForwarder: forwarder,
    notify: notifyBridge,
    settings: () => liveSettings,
    save: saveSettings,
    runtime: () => runtimeSnapshot(),
    fetchCatalog: (source) =>
      fetchRuntimeCatalog({ source, repo: liveSettings.runtimeGithubRepo ?? null, log }),
    downloadStatus: () => downloader.status(),
    download: (version, source) => downloader.start(version, source),
    modePromptNeeded: () => modePromptNeeded,
    chooseDesktopMode: chooseDesktopMode,
    modeChosen,
    profileOp: async (request) => {
      if (request.op === 'create') {
        const name = request.target ?? ''
        if (!isValidProfileName(name)) {
          return { ok: false, message: '名称仅允许小写字母、数字与连字符（1-64 字符）' }
        }
        const result = scaffoldProfile(home, name)
        const message = result.created
          ? `profile ${name} 已创建；开窗时会自动装依赖树并拉起 dsh。`
          : `profile ${name} 已存在，直接打开即可。`
        options.onProfileOpApplied?.('create', name)
        return { ok: true, message, profile: name }
      }
      // migrate：校验后交给命令表同一条迁移路径（复制依赖树 + pnpm install，长任务）
      const source = request.source ?? ''
      const target = request.target ?? ''
      if (!isValidProfileName(target)) {
        return { ok: false, message: '目标名称仅允许小写字母、数字与连字符（1-64 字符）' }
      }
      if (isSelfMigrate(source, target)) {
        return { ok: false, message: '源与目标相同，无需迁移。' }
      }
      try {
        const summary = await migrateProfile({
          home,
          source,
          dest: target,
          overwrite: request.overwrite === true,
          activeProfile: paths.profile,
          install: () =>
            installProfileDependencies({
              home,
              profile: target,
              appSupport: paths.appSupport,
              runtimeRoot: paths.runtimeDir,
              env: childEnv,
              preferOffline: true,
              log,
            }),
          log,
          track: taskTracker,
        })
        options.onProfileOpApplied?.('migrate', target)
        return { ok: true, message: summary, profile: target }
      } catch (error) {
        return { ok: false, message: String(error) }
      }
    },
    onProfileOpApplied: (op, profile) => {
      log(`[profile-op] ${op} ${profile} 完成`)
    },
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
      // 远程/本地互切：先重算 remoteAddr（设置面板 nsSave 已落盘），再分流——
      // 远程模式没有宿主可杀，直接把服务面切过去；从远程切回本地时也没有宿主，立即拉起。
      // 其余（本地→本地）杀掉宿主即可：退出会唤醒守护器，由它重启并把服务面切过去。
      remoteAddr = normalizeRemoteUrl(liveSettings.remoteAddr ?? '')
      await host?.stop()
      if (remoteAddr !== null || host === undefined) {
        await connect()
        serverOptions.upstreamOrigin = hostOrigin !== '' ? hostOrigin : `http://127.0.0.1:${String(upstreamPort)}`
        applyHost()
      }
    },
    // 多窗口：不再就地换 profile（旧壳的「托盘切换 profile」在新壳里就是把那份 profile 的窗口开到前台）。
    stop: async () => {
      stopping = true
      if (watchdogTimer !== null) clearInterval(watchdogTimer)
      dshStatusCode = 6
      ledger.reset()
      server.stop()
      notifyServer.stop()
      forwarder?.stop()
      keepAwake.stop()
      arbiter.clear()
      downloads.stop()
      updater.stop()
      // 插件链接要拆掉（item 9，旧壳 cleanup_desktop_plugin_links 的等价物）：
      // 不拆的话，用户回头用旧壳/别的安装时 profile 池里会留一份悬空 symlink。
      try {
        cleanupStagedPlugins(staged.staged, log)
      } catch (error) {
        log(`[exit] 清理插件链接失败：${String(error)}`)
      }
      try {
        await host?.stop()
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
      modePrompt: () => modePromptNeeded,
      chooseMode: (mode: string, tokenUrl?: string) => chooseDesktopMode(mode, tokenUrl),
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
      logPageConsole,
      diagnostics: () => diagnosticsSnapshot(),
      exportDiagnostics: (snapshot) =>
        exportDiagnostics({
          home,
          snapshot,
          now: new Date(),
          reveal: (path) => revealPath(path, log),
          log,
        }),
      downloadDir: join(env.HOME ?? home, 'Downloads'),
      // ---- profile 运维与启动检查（旧壳 commands.rs 的对应命令）----
      startupChecked: () => startupChecked,
      markStartupChecked: () => {
        startupChecked = true
      },
      freshInstall: () => loaded.created,
      profileHealth: (profile) => profileHealth(home, profile),
      setPendingProfile: (profile) => {
        pendingProfile = profile
      },
      takePendingProfile: () => {
        const pending = pendingProfile
        pendingProfile = null
        return pending
      },
      confirmStartupProfile: async (profile, repair) => {
        // 旧壳顺序：先按需修复，再把该 profile 交给服务面（pending 由前端取回后自己落盘）
        if (repair) await rebuildProfileDependencies(profile)
        saveSettings({ active_profile: profile })
        if (profile !== paths.profile) await options.onOpenProfileWindow?.(profile)
      },
      runningPortOfProfile: async (profile) => {
        const claims = pruneClaims(parseClaims(await readClaims()), isAlivePid)
        const hit = claimFor(claims, profile)
        return hit === undefined ? null : hit.port
      },
      rebuildProfile: rebuildProfileDependencies,
      migrateProfile: async (source, dest, overwrite) => {
        const next = await migrateProfile({
          home,
          source,
          dest,
          overwrite,
          activeProfile: paths.profile,
          install: () =>
            installProfileDependencies({
              home,
              profile: dest,
              appSupport: paths.appSupport,
              runtimeRoot: paths.runtimeDir,
              env: childEnv,
              preferOffline: true,
              log,
            }),
          log,
          track: taskTracker,
        })
        return next
      },
      migrationStatus: () => taskTracker.migrationStatus(),
      testProxy: (url) => testProxyConnectivity(url),
      guests: options.guests,
      updater,
      dependencyRows: async () => {
        const builtinPnpm = builtinPnpmVersion({
          env: childEnv,
          runtimeRoot: paths.runtimeDir,
          appSupport: paths.appSupport,
        })
        const claimed = pruneClaims(parseClaims(await readClaims()), isAlivePid)
        return profileDependencyRows({
          home,
          profiles: listProfiles(home, paths.profile),
          builtinPnpm,
          running: (name) => claimFor(claimed, name) !== undefined,
        })
      },
      taskStatus: () => taskTracker.status(),
      zoomToggle: () => options.onZoomToggle?.(),
      inputConfirm: (flow, value) => options.onInputConfirm?.(flow, value),
      keybindings: {
        read: () => readKeybindings(home),
        write: (raw) => writeKeybindings(home, raw),
      },
      // 面板展示与真实注入同源：一样走 scutil / 注册表 / 环境变量三级检测。
      proxyEffective: () => resolveProxyEnv(liveSettings, detectSystemProxy({ platform: process.platform, env: childEnv, log })),
    }),
  )
  return service
}
