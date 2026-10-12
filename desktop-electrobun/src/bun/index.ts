// Electrobun 主进程入口：CEF 断言 → 起服务面 → 建窗。
//
// 服务面（运行时就位、端口认领、起宿主、取 cookie、loopback 服务）在 service.ts 里，
// 那一层不 import electrobun；这里只做「渲染器断言」和「窗口」两件事。

import { ApplicationMenu, BrowserView, BrowserWindow, BuildConfig, ContextMenu, Screen, Utils, app } from 'electrobun/bun'
import { systemLocale } from './locale.ts'
import { installApplicationMenu } from './menu.ts'
import { bootPreloadScript } from './preload.ts'
import { startService, type ServiceOptions, type ShellService } from './service.ts'
import { createNativeNotify } from './notify-un.ts'
import type { RuntimeSnapshot } from './commands.ts'
import type { RuntimeDownloadStatus } from './runtime-install.ts'
import { SHELL_MENU_ACTIONS, contextMenuItems } from './context-menu.ts'
import { isExternalUrl } from './external.ts'
import { APP_NAME } from '../shared/app.ts'
import { appSupportDir, dshHome, trayImagePath } from './runtime.ts'
import { acquireInstance, activateUrl, releaseInstance, updateInstance } from './single-instance.ts'
import { createViewRegistry } from '../shared/view-grant.ts'
import { createGuestManager, type GuestViewLike } from './guest-manager.ts'
import { loadNativeWebviewCore } from './native-webview.ts'
import { GUEST_DEFAULT_URL, OFFSCREEN_GUEST_RECT } from '../shared/guest-policy.ts'
import { resolveAppVersion } from './app-version.ts'
import { SPLASH_HEIGHT, SPLASH_WIDTH, splashFailScript, splashHtml, splashStageScript } from './splash.ts'
import { stageLabel, stagePercent, type ShellStage } from './stages.ts'
import { createTray, type TrayHandle } from './tray.ts'
import { trayMenu, type TrayAction, type TrayCatalogItem, type TrayState } from './tray-menu.ts'
import { listProfiles } from './profiles.ts'
import { profileDialogHtml, type ProfileOpDialogKind } from './profile-dialog.ts'
import { confirmModalScript } from './input-modal.ts'
import { navRulesFor } from '../shared/nav-rules.ts'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  readWindowFrame,
  sanitizeFrame,
  writeWindowFrame,
  type DisplayBounds,
  type WindowFrame,
} from './window-state.ts'
import { loadSettings } from './settings-store.ts'
import { activeProfile, type DesktopSettings } from '../shared/settings.ts'
import { closeAction, offsetFrame, planWindowOpen, windowKey } from '../shared/window-targets.ts'
import type { LaneForwarder } from './lane-forwarder.ts'
import { createNotifier, type Notifier } from './notifications.ts'
import { SCENARIO } from '../shared/notify-policy.ts'
import { join } from 'node:path'
import { createRegisterCli } from './register-cli.ts'
import { registerTrayLabel } from '../shared/register-cli.ts'

/** 客户端版本标识：dsh 0.2.1-alpha.2 的 telemetry/product-analytics 插件把它当必填项。 */
const CLIENT_VERSION = '0.1.0'
/** 退出时等宿主与 CEF 子进程收尾的上限（超过就交给框架的优雅退出） */
const SHELL_STOP_DEADLINE_MS = 8_000
/** 启动失败时启动界面留在屏幕上的时长（让用户看清原因，然后自己退出） */
const SPLASH_FAILURE_HOLD_MS = 30_000

function fail(message: string, code: number): never {
  console.error(`[shell] ${message}`)
  process.exit(code)
}

// CEF 三处开关的最后一处：构建期 bundleCEF、defaultRenderer 之外，运行期还要断言
// 「这个包里真的可用 CEF」——否则 renderer:"cef" 会被静默忽略、回落系统 webview
// （macOS 上就是我们要离开的 WKWebView）。
const build = BuildConfig.getSync()
const available: string[] = build.availableRenderers ?? []
if (!available.includes('cef')) {
  fail(`availableRenderers 不含 cef（实际：${available.join(',') || '空'}）：包里没打 CEF，renderer:"cef" 会静默回落系统 webview`, 3)
}
if (build.defaultRenderer !== 'cef') {
  console.warn('[shell] defaultRenderer 不是 cef；建窗时显式传 renderer:"cef" 兜住')
}

const noWindow = process.env.DSH_SHELL_NO_WINDOW === '1'
/** 壳平台名：与旧壳 body[data-dsh-desktop-platform] 契约同名。 */
const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
// macOS 的 Cmd+C/Cmd+V 由 NSMenu 的选择器驱动（见 menu.ts），不装菜单就没有系统剪贴板快捷键。
if (platform === 'darwin') installApplicationMenu(ApplicationMenu, APP_NAME)
// 系统语言：CEF 默认 en-US，页面语言跟着错；旧壳（WKWebView）是天然跟随系统的。
const locale = await systemLocale()
// 页面外链与右键菜单都要主进程出面：CEF 不会自己弹菜单，也不接管 window.open。
// 回调注册在窗口之前，闭包里的 mainWindow 在窗口建好后才有值。
/** 每个 profile 一份窗口 + 一份服务面（旧壳 `desktop/src-tauri/src/ui/multiwin.rs` 的等价物：
 *  每 profile 至多一窗；关窗只销毁 UI、实例继续跑；主窗关窗回托盘）。 */
interface ProfileWindow {
  profile: string
  window: BrowserWindow
  /** 该窗的 CEF 浏览器就绪（dom-ready 之前 loadURL/executeJavascript 会打到空 ref） */
  ready: boolean
}
const windows = new Map<string, ProfileWindow>()
const services = new Map<string, ShellService>()
/** F8：正在「退出（停止实例）」的 profile——will-close 对它们放行真关窗 */
const stoppingProfiles = new Set<string>()
/** D5：首次关窗回托盘提示过一次的 profile（进程生命周期内一次） */
const trayHintShown = new Set<string>()
/** 最近聚焦的窗口 profile；托盘「显示/隐藏窗口」作用在它身上（旧壳 focused_window_label）。 */
let focusedProfile: string | null = null
let mainWindow: BrowserWindow | null = null
/** 主窗的 CEF 浏览器就绪（dom-ready）之前，`loadURL` 与 `executeJavascript` 都会打到空 ref 上 */
let mainWindowReady = false

// ---- 托盘 + 窗口几何：关窗回托盘、Dock 再激活、位置尺寸记忆 ----
// 旧 Tauri 壳用 tauri-plugin-window-state + tauri-plugin-single-instance；Electrobun 两样都没有。
const windowStateFile = join(appSupportDir(), 'window.json')
// 实例锁与托盘都要 profile：DSH_PROFILE > 设置 > 默认。
// 设置文件可能还不存在（首启），读失败就按默认——真正的落盘由 service 那一步做。
const bootSettings: DesktopSettings = loadSettings({ home: dshHome() }).settings
const instanceProfile = activeProfile(bootSettings, process.env)
let tray: TrayHandle | null = null
// 每视图授权台账（#220 决策 12）：每个窗口一枚 token，页面桥带回来，壳按视图种类放行命令。
const views = createViewRegistry()
// 浏览器 guest（#118/#134）：侧边栏浏览器 / 远程窗口的子 webview。
// 历史（canGoBack/goBack…）与几何（bounds）走框架原生核：公开的 BrowserView API 里没有这两样。
const nativeCore = await loadNativeWebviewCore({
  execPath: process.execPath,
  importDir: import.meta.dir,
  env: process.env,
})
console.log(
  nativeCore.core === null
    ? `[guest] 原生核不可用：${nativeCore.error ?? '未知原因'}`
    : `[guest] 原生核就绪：${nativeCore.libPath}`
)
const guests = createGuestManager({
  log: (line) => console.log(line),
  core: nativeCore.core,
  // guest 挂在发起调用的那个窗口上（多窗口下天然跟随宿主窗口）。
  createView: ({ partition, caller }) => {
    const hit = windows.get(caller.profile)
    if (hit === undefined) return null
    const view = new BrowserView({
      url: GUEST_DEFAULT_URL,
      renderer: 'cef',
      partition,
      frame: { ...OFFSCREEN_GUEST_RECT },
      windowId: hit.window.id,
      hostWebviewId: hit.window.webviewId,
      // 不可信内容：不开 RPC，只保留事件（Electrobun 自己给远程 URL 的建议档位）
      sandbox: true,
      autoResize: false,
    })
    return view as unknown as GuestViewLike
  },
  // 状态推送：dsh 对 <webview> 是同步拉取，所以壳把快照 eval 回宿主页面（旧壳同款）。
  pushToHost: (caller, script) => {
    const hit = windows.get(caller.profile)
    if (hit === undefined || !hit.ready) return
    try {
      hit.window.webview?.executeJavascript(script)
    } catch (error) {
      console.warn(`[guest] 状态推送失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
let windowVisible = false
let quitting = false
/** 关窗后是否只是隐藏：没有托盘（原生层没建成）时隐藏就叫不回来了，那时关窗等于退出。 */
const closeToTray = (): boolean => tray !== null

function displayBounds(): DisplayBounds[] {
  try {
    return Screen.getAllDisplays().map((display) => display.bounds)
  } catch (error) {
    console.warn(`[shell] 取显示器信息失败，窗口用默认尺寸：${String(error)}`)
    return []
  }
}

/** 落盘几何 → 可用几何；越界/太小/坏数据一律回默认（外接屏拔掉后不能把窗口丢在屏幕外）。 */
/** D3：每窗几何记忆——主窗沿用 window.json，其余 profile 各存 window-<profile>.json */
function windowStateFileOf(profile: string): string {
  return profile === instanceProfile ? windowStateFile : join(appSupportDir(), `window-${profile}.json`)
}

function restoreWindowFrame(profile: string = instanceProfile): WindowFrame {
  const saved = sanitizeFrame(readWindowFrame(windowStateFileOf(profile)), displayBounds())
  if (saved === null) return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, x: 0, y: 0 }
  console.log(`[shell] 还原窗口位置：${String(saved.x)},${String(saved.y)} ${String(saved.width)}×${String(saved.height)}`)
  return saved
}

/** 拖动/缩放会连续触发：合并 400ms 只写一次（D3：按 profile 各写各的文件） */
const frameSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleFrameSave(win: BrowserWindow, profile: string): void {
  const existing = frameSaveTimers.get(profile)
  if (existing !== undefined) clearTimeout(existing)
  frameSaveTimers.set(
    profile,
    setTimeout(() => {
      frameSaveTimers.delete(profile)
      try {
        const frame = win.getFrame()
        writeWindowFrame(windowStateFileOf(profile), {
          x: Math.round(frame.x),
          y: Math.round(frame.y),
          width: Math.round(frame.width),
          height: Math.round(frame.height),
        })
      } catch (error) {
        console.warn(`[shell] 窗口几何落盘失败：${String(error)}`)
      }
    }, 400),
  )
}

/** 版本目录缓存：托盘子菜单用它渲染「↓ 下载并切换」，但不该每刷一次托盘就打网络（旧壳也拿缓存）。 */
const TRAY_CATALOG_TTL_MS = 10 * 60_000
let catalogCache: { at: number; entries: TrayCatalogItem[] } | null = null
let catalogPending = false

function ensureCatalog(): void {
  if (catalogPending) return
  if (catalogCache !== null && Date.now() - catalogCache.at < TRAY_CATALOG_TTL_MS) return
  catalogPending = true
  void uiService()
    .fetchCatalog(uiService().settings().runtimeSource ?? 'github')
    .then((result) => {
      if (result.error === undefined) catalogCache = { at: Date.now(), entries: result.entries }
      else console.warn(`[shell] 拉运行时版本目录失败：${result.error}`)
    })
    .catch((error: unknown) => {
      console.warn(`[shell] 拉运行时版本目录失败：${String(error)}`)
    })
    .finally(() => {
      catalogPending = false
      tray?.setState(trayState())
    })
}

/** 下载状态在运行时管理器里；壳侧只读它——取不到就当作不在下载。 */
function downloadStatusSafe(): RuntimeDownloadStatus {
  try {
    return uiService().downloadStatus()
  } catch {
    return { active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '' }
  }
}

/** 运行时的展示名：外部 CLI / 已下载版本 / 随包内置三档，旧壳 `运行时：<label>` 同一口径。 */
function runtimeLabelOf(snapshot: RuntimeSnapshot): string {
  if (snapshot.mode === 'external') {
    return snapshot.externalVersion === null ? '外部 dsh（未找到）' : `外部 dsh ${snapshot.externalVersion}`
  }
  if (snapshot.activeVersion !== null && snapshot.activeVersion !== snapshot.builtinVersion) {
    return `${snapshot.activeVersion}（已下载）`
  }
  return snapshot.activeVersion === null ? '内置（版本未知）' : `内置 ${snapshot.activeVersion}`
}

/** 面向托盘与设置面板的那份服务面：最近聚焦窗口的；没有就退回启动 profile 的。 */
function uiService(): ShellService {
  const focused = focusedProfile === null ? undefined : services.get(focusedProfile)
  return focused ?? service
}

function trayState(): TrayState {
  const settings = uiService().settings()
  const snapshot = uiService().runtime()
  const download = downloadStatusSafe()
  return {
    // 可见性是「当前那个窗口」的：多窗口下托盘的显示/隐藏只动一个
    windowVisible: focusedWindow()?.isVisible() ?? windowVisible,
    profile: uiService().paths.profile,
    // 多 profile：菜单按 home 下的 profile 目录列，点了开/聚焦那一份窗口
    profiles: listProfiles(dshHome(), instanceProfile),
    openWindows: [...windows.keys()],
    profileRows: listProfiles(dshHome(), instanceProfile).map((profile) => {
      const svc = services.get(profile)
      const origin = svc?.state.origin ?? ''
      const port = Number(origin.split(':').pop() ?? '') || null
      return {
        profile,
        open: windows.has(profile),
        running: (svc?.state.hostPid ?? 0) > 0,
        port,
        focused: focusedProfile === profile,
      }
    }),
    hostRunning: uiService().state.hostPid > 0,
    runtimeLabel: runtimeLabelOf(snapshot),
    mode: settings.dshMode ?? 'builtin',
    builtinVersion: snapshot.builtinVersion,
    runningVersion: snapshot.activeVersion,
    selected: settings.dshRuntime ?? null,
    installed: snapshot.installed.map((entry) => entry.version),
    catalog: catalogCache?.entries ?? [],
    externalAvailable: snapshot.externalPath !== null,
    downloading: download.active && download.version !== '' ? download.version : null,
    remoteAddr: settings.remoteAddr ?? null,
    remoteList: settings.remoteList,
    registerLabel: registerTrayLabel(registerCli.cached()),
  }
}

function refreshTray(): void {
  if (tray === null) return
  tray.setState(trayState())
  // 顺带把「有哪些版本可下载」拿回来（有缓存/正在拉就跳过，不阻塞窗口操作）
  ensureCatalog()
  // 注册状态同理：TTL 内直接用缓存，绝不在菜单构建里同步 spawn 登录 shell
  void registerCli.refresh().then(() => {
    if (tray !== null) tray.setState(trayState())
  })
}

function showMainWindow(): void {
  const win = focusedWindow()
  if (win === null) return
  win.unminimize()
  win.show()
  win.activate()
  windowVisible = true
  refreshTray()
}

function hideMainWindow(): void {
  const win = focusedWindow()
  if (win === null) return
  win.hide()
  windowVisible = false
  refreshTray()
}

// ---- 多窗口：每 profile 一份服务面 + 一个窗口（旧壳 `ui/multiwin.rs` 的等价物）----

/** 当前那个窗口：最近聚焦的；没焦点记录就回主窗。 */
function focusedWindow(): BrowserWindow | null {
  if (focusedProfile !== null) {
    const hit = windows.get(focusedProfile)
    if (hit !== undefined) return hit.window
  }
  return mainWindow
}

/** 起/profile 复用一份服务面：每份服务面 = 一个 dsh 宿主 + 一个 loopback origin。 */
async function ensureService(profile: string): Promise<ShellService> {
  const existing = services.get(profile)
  if (existing !== undefined) return existing
  console.log(`[shell] 起服务面：profile = ${profile}`)
  const started = await startService(serviceOptionsFor(profile))
  services.set(profile, started)
  return started
}

/** 服务面选项：除了 profile 与状态文件，其余回调全是壳侧共用的那几个。 */
function serviceOptionsFor(profile: string): ServiceOptions {
  const home = dshHome()
  return {
    profile,
    clientVersion: CLIENT_VERSION,
    noWindow,
    // 一个 profile 一份状态文件（诊断脚本按 profile 找）；启动 profile 保留旧路径
    env:
      profile === instanceProfile
        ? process.env
        : { ...process.env, DSH_SHELL_STATE_FILE: join(home, `shell-state-${profile}.json`) },
    onOpenExternal: (url) => {
      if (!Utils.openExternal(url)) console.warn(`[shell] 系统浏览器没接住外链：${url}`)
    },
    onContextMenu: (request) => {
      const linkIsExternal =
        request.linkUrl !== null && isExternalUrl(request.linkUrl, originOf(profile))
      const items = contextMenuItems(request, linkIsExternal)
      // 「挂不上也要出声」：菜单内容进日志，实机排查时能看出是哪一档
      console.log(`[shell] 右键菜单：${items.map((item) => item.label ?? item.role ?? item.type ?? '?').join(' | ')}`)
      ContextMenu.showContextMenu(items as unknown[])
    },
    onStage: (stage) => {
      lastStage = stage
      console.log(`[shell] 启动阶段：${stageLabel(stage)}（${String(stagePercent(stage))}%）`)
      pushStage()
    },
    onActivate: () => {
      // 第二个壳点了一次图标：把当前窗口带到前台（恢复最小化、显示、抢焦点）
      console.log('[shell] 收到激活请求：窗口带到前台')
      showMainWindow()
    },
    onWindowControl: (action) => {
      const win = focusedWindow()
      if (win === null) return
      if (action === 'minimize') {
        win.minimize()
      } else if (action === 'toggle-maximize') {
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
      } else {
        win.close()
      }
    },
    onProfileOpApplied: (op, profile) => {
      // F9：创建成功直接开那扇窗（ensureService 会装依赖并拉宿主）；迁移完成刷新托盘。
      if (op === 'create') {
        void openProfileWindow(profile)
          .then(() => refreshTray())
          .catch((error) => console.error(`[shell] 打开新 profile 窗口失败：${String(error)}`))
      } else {
        void refreshTray()
      }
    },
    onZoomToggle: () => {
      const win = focusedWindow()
      if (win === null) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    onInputConfirm: (flow, value) => {
      if (pendingInput?.flow === flow) {
        pendingInput.resolve(value)
        pendingInput = null
      }
    },
    onHostRestart: (state) => {
      // 宿主被守护器拉起来了：把对应窗口刷回同一个页面 origin（token/端口都没变）
      console.log(`[shell] 宿主已重启，页面重载：${state.pageUrl}`)
      reloadWindow(state.profile, state.pageUrl)
    },
    onHostGiveUp: (state, reason) => {
      console.error(`[shell] 宿主守护器放弃重启（${reason}）；页面停在 ${state.pageUrl}`)
    },
    notifier,
    // 同一个 UN 桥实例（状态与投递都走它；面板的权限徽标也从这里读）
    notifyBridge,
    views,
    guests,
    appVersion: resolveAppVersion(),
    locale,
    pickSoundFile: pickSoundFileImpl,
    chooseDownloadDir: pickDownloadDirImpl,
    // 页面请求关窗（`close_current_window` / `exit_window_instance`）：关它自己那个窗口
    onCloseWindow: () => {
      windows.get(profile)?.window.close()
    },
    // 启动确认选了别的 profile：#82 的旧行为是「用它重启」；新壳每 profile 一份服务面，所以是开它那份窗口
    onOpenProfileWindow: async (target) => {
      if (target === profile) return
      await openProfileWindow(target)
    },
  }
}

function originOf(profile: string): string {
  return services.get(profile)?.state.origin ?? ''
}

/**
 * 下载的「保存位置」：Electrobun 只暴露 openFileDialog（没有 NSSavePanel 封装），所以让用户选**目录**、
 * 文件名由壳按建议名自动起（撞车时退成 `名字 (1).ext`）——与旧壳的保存框语义等价，只是不能连带改名。
 */
async function pickDownloadDirImpl(start: string): Promise<string | null> {
  const picked = await Utils.openFileDialog({
    startingFolder: start,
    allowedFileTypes: '*',
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  })
  const dir = picked[0] ?? null
  return dir === '' ? null : dir
}

/** 「桌面通知」tab 的「自定义文件…」：Electrobun 原生文件选择器（旧壳 tauri-plugin-dialog 的等价物）。 */
async function pickSoundFileImpl(): Promise<string | null> {
  const picked = await Utils.openFileDialog({
    startingFolder: '~/',
    allowedFileTypes: 'wav,mp3,ogg',
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  })
  return picked[0] ?? null
}

/** 宿主重启后把对应窗口刷回同一个页面 origin。 */
function reloadWindow(profile: string, url: string): void {
  const hit = windows.get(profile)
  if (hit === undefined || !hit.ready) return
  hit.window.webview?.loadURL(url)
}

/** 建一个 profile 窗口并接上壳侧语义（关窗、聚焦、几何）；DOM 事件与旧单窗实现同一套。 */
function createProfileWindow(profile: string, svc: ShellService): BrowserWindow {
  const isBoot = profile === instanceProfile
  const index = windows.size
  const frame = index === 0 ? restoreWindowFrame(profile) : offsetFrame(restoreWindowFrame(profile), index)
  const win = new BrowserWindow({
    // D1：原生层同步评估的导航守卫——白名单页面 origin，其余导航被拦（外链交给 open_external）
    navigationRules: navRulesFor({ origin: svc.state.origin }),
    title: isBoot ? APP_NAME : `${APP_NAME} · ${profile}` ,
    url: svc.state.pageUrl,
    renderer: 'cef',
    preload: bootPreloadScript(locale, platform, svc.state.origin, views.issue('shell', profile, windowKey(profile)).token),
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame,
  })
  windows.set(profile, { profile, window: win, ready: false })
  focusedProfile = profile
  if (isBoot) mainWindow = win
  console.log(`[shell] 建窗：${windowKey(profile)}（${svc.state.pageUrl}）`)
  win.on('dom-ready', () => {
    const hit = windows.get(profile)
    if (hit !== undefined) hit.ready = true
    if (isBoot) {
      // 主窗已出画面：拆掉启动界面（页面自己也等 __DSH_BOOT_READY__，这里只负责别让两个窗口并存）
      try {
        splash?.close()
      } catch {}
      splash = null
      mainWindowReady = true
    }
    windowVisible = true
    refreshTray()
  })
  win.on('focus', () => {
    focusedProfile = profile
    // lane 稳定接入点跟随焦点（旧壳 forwarder.rs：新连接落焦点实例，存量不动）
    // lane 稳定接入点跟随焦点（旧壳 forwarder.rs：新连接落焦点实例，存量不动）。
    // 转发器挂在先起的那份服务面上，这里找到它再指目标。
    focusedLaneForwarder()?.setTarget(services.get(profile)?.state.lanePort ?? 0)
    refreshTray()
  })
  // 关窗回托盘：原生层会先问 `will-close`，回 response.allow=false 就不关（旧 Tauri 壳同行为）。
  // 没有托盘时不能隐藏（隐藏后没有入口再叫回来），直接走真退出（仅主窗）。
  win.on('will-close', (event) => {
    if (quitting) return
    // F8：「退出（停止实例）」主动销毁窗口时不拦截（stoppingProfiles 由 stopProfileFromTray 置位）
    if (stoppingProfiles.has(profile)) return
    if (closeAction(profile, instanceProfile) === 'hide-to-tray' && closeToTray()) {
    // D5：首次关窗回托盘时提示一次（旧壳关窗提示的等价物；用户知道了就不再弹）
    if (closeAction(profile, instanceProfile) === 'hide-to-tray' && closeToTray() && !trayHintShown.has(profile)) {
      trayHintShown.add(profile)
      notifier.notify(SCENARIO.WINDOW_LIFECYCLE, '窗口已最小化到托盘，点托盘图标可找回。')
    }
      ;(event as { response?: unknown }).response = { allow: false }
      console.log(`[shell] 关窗回托盘（${profile} 窗口隐藏，进程继续）`)
      win.hide()
      windowVisible = false
      refreshTray()
      return
    }
    if (!closeToTray() && profile === instanceProfile) {
      console.log('[shell] 关窗（无托盘）：直接退出')
      void shutdown()
      return
    }
    console.log(`[shell] 关窗（${profile}）：只销毁窗口，实例继续跑`)
  })
  win.on('close', () => {
    windows.delete(profile)
    // 窗口没了就撤销它的视图 token（旧壳的 capability 是静态文件，这里跟着窗口走）
    views.revokeLabel(windowKey(profile))
    // 窗口里的 guest 子 webview 跟着窗口一起回收（否则会留在窗口之外无法关闭）
    const released = guests.releaseHost(windowKey(profile))
    if (released > 0) console.log(`[shell] 随窗口回收 guest：${released} 个（${profile}）`)
    if (focusedProfile === profile) {
      focusedProfile = null
      focusedLaneForwarder()?.setTarget(0)
    }
    refreshTray()
  })
  // D3：每窗各自记几何（windowStateFileOf 按 profile 分文件；scheduleFrameSave 带目标文件）
  win.on('resize', () => scheduleFrameSave(win, profile))
  win.on('move', () => scheduleFrameSave(win, profile))
  return win
}

/** 托盘「PROFILE 窗口」：已开就聚焦，没开就起一份服务面再开窗（旧壳 open_profile_window）。 */
async function openProfileWindow(profile: string): Promise<void> {
  const existing = windows.get(profile)
  if (existing !== undefined && planWindowOpen(profile, [...windows.keys()]) === 'focus') {
    existing.window.unminimize()
    existing.window.show()
    existing.window.activate()
    focusedProfile = profile
    refreshTray()
    return
  }
  console.log(`[shell] 打开 profile 窗口：${profile}`)
  try {
    const svc = await ensureService(profile)
    createProfileWindow(profile, svc)
    refreshTray()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[shell] 打开 profile 窗口失败（${profile}）：${message}`)
    notifier.notify(SCENARIO.INSTANCE_LIFECYCLE, `打开 ${profile} 窗口失败：${message}`)
  }
}

/** 托盘「重启 dsh 服务」：杀掉宿主，守护器带着同一份运行时把它拉起来。 */
async function restartServiceFromTray(): Promise<void> {
  console.log('[shell] 托盘：重启 dsh 服务')
  try {
    await uiService().restartHost()
  } catch (error) {
    console.error(`[shell] 重启 dsh 服务失败：${String(error)}`)
  }
  refreshTray()
}


/** 托盘「运行时版本」：内置 / 外部 dsh / 某个已下载版本（写设置 + 杀宿主让守护器重起）。 */
async function switchRuntimeFromTray(action: TrayAction): Promise<void> {
  const patch: Record<string, unknown> =
    action.mode === 'external'
      ? { dsh_mode: 'external' }
      : action.version === undefined
        ? { dsh_mode: 'builtin', dsh_runtime: null }
        : { dsh_mode: 'builtin', dsh_runtime: action.version }
  console.log(`[shell] 托盘：切换运行时 ${JSON.stringify(patch)}`)
  uiService().save(patch)
  refreshTray()
  try {
    // 运行时是壳级设置：把所有已起的服务面都重启一遍（各自守护器带走新运行时）
    await Promise.all(
      [...services.values()].map(async (svc) => {
        try {
          await svc.restartHost()
        } catch (error) {
          console.error(`[shell] 重启服务面失败（${svc.paths.profile}）：${String(error)}`)
        }
      })
    )
  } catch (error) {
    console.error(`[shell] 切换运行时失败：${String(error)}`)
  }
  refreshTray()
}

/**
 * 下载中的托盘刷新：**事件驱动**——只在「在下载 / 下载完」这类状态跳变时下发菜单，
 * 不每秒重建（菜单开着时反复 setMenu 会把它顶掉，用户口径明确要求不要定时刷新）。
 */
let downloadTimer: ReturnType<typeof setInterval> | null = null
function downloadTrayKey(): string {
  const status = downloadStatusSafe()
  return `${status.active ? '1' : '0'}|${status.version}`
}
function pollDownload(): void {
  if (downloadTimer !== null) return
  let lastKey = downloadTrayKey()
  downloadTimer = setInterval(() => {
    const key = downloadTrayKey()
    if (key !== lastKey) {
      lastKey = key
      refreshTray()
    }
    if (!downloadStatusSafe().active && downloadTimer !== null) {
      clearInterval(downloadTimer)
      downloadTimer = null
    }
  }, 1_000)
}

/** 托盘「↓ 下载并切换 <v>」：装完直接切过去（旧壳 runtime-fetch-<v> 同语义）。 */
async function downloadRuntimeFromTray(version: string): Promise<void> {
  if (version === '') return
  console.log(`[shell] 托盘：下载运行时 ${version}`)
  pollDownload()
  try {
    await uiService().download(version, uiService().settings().runtimeSource ?? 'github')
  } catch (error) {
    console.error(`[shell] 下载运行时 ${version} 失败：${String(error)}`)
    notifier.notify(SCENARIO.STARTUP_ERROR, `下载运行时 ${version} 失败`)
    refreshTray()
    return
  }
  console.log(`[shell] 运行时 ${version} 装好了，切过去`)
  // 装完的版本要从「↓ 下载并切换」那一栏挪进「已装」：缓存作废，重新拉一份
  catalogCache = null
  await switchRuntimeFromTray({ kind: 'switch-runtime', version })
}

function onTrayAction(action: TrayAction): void {
  switch (action.kind) {
    case 'toggle-window':
      if (windowVisible) hideMainWindow()
      else showMainWindow()
      return
    case 'quit':
      console.log('[shell] 托盘：退出')
      void shutdown()
      return
    case 'restart-service':
      void restartServiceFromTray()
      return
    case 'open-window':
      if (action.profile !== undefined) void openProfileWindow(action.profile)
      return
    case 'switch-runtime':
      void switchRuntimeFromTray(action)
      return
    case 'download-runtime':
      void downloadRuntimeFromTray(action.version ?? '')
      return
    case 'register-cli':
      void registerDshCliFromTray()
      return
    case 'remote-source': {
      // 「dsh 服务地址」（旧壳 #136）：本地/远程同层单选；选完立即按目标重启 dsh。
      // 远程不可用（token 失效 401）时也能从这里一键切回本地。
      const svc = uiService()
      const current = svc.settings()
      const target = action.addrIndex === undefined ? '' : current.remoteList[action.addrIndex] ?? ''
      if ((current.remoteAddr ?? '') === target) return
      svc.save({ remote_addr: target })
      void svc
        .restartHost()
        .then(() => refreshTray())
        .catch((error) => console.error(`[shell] 切换 dsh 服务地址失败：${String(error)}`))
      return
    }
    case 'stop-profile':
      if (action.profile !== undefined) void stopProfileFromTray(action.profile)
      return
    case 'new-profile':
      void openProfileOpDialog('create')
      return
    case 'migrate-profile':
      void openProfileOpDialog('migrate')
      return
  }
}

/** F8：托盘「退出（停止实例）」——销毁那扇窗、停那份额服务面（旧壳 tray.rs:63-73） */
async function stopProfileFromTray(profile: string): Promise<void> {
  const svc = services.get(profile)
  if (svc === undefined) {
    console.log(`[shell] 退出实例：${profile} 没有在跑的服务面，忽略`)
    return
  }
  console.log(`[shell] 退出实例：停止 ${profile} 的 dsh 与服务面`)
  stoppingProfiles.add(profile)
  try {
    windows.get(profile)?.window.close()
    await svc.stop()
  } finally {
    stoppingProfiles.delete(profile)
    void refreshTray()
  }
}

/** F9：托盘「新建 / 迁移 Profile…」——弹一张小表单窗，提交给服务面的 /profile-op */
function openProfileOpDialog(kind: ProfileOpDialogKind): void {
  const dialog = new BrowserWindow({
    title: kind === 'create' ? '新建 Profile' : '迁移 Profile',
    html: profileDialogHtml(kind, listProfiles(dshHome(), instanceProfile)),
    renderer: 'cef',
    titleBarStyle: 'hidden',
    frame: { width: 460, height: kind === 'create' ? 240 : 330 },
  })
  dialog.on('closed', () => void refreshTray())
}
/** F12：页面内确认弹窗（旧壳 register/confirm_modal 的等价物）：注入 JS，等 POST 回填，180s 超时。 */
let pendingInput: { flow: string; resolve: (value: string) => void } | null = null
const INPUT_CONFIRM_TIMEOUT_MS = 180_000

async function confirmModal(flow: string, title: string, body: string): Promise<boolean> {
  const win = focusedWindow() ?? mainWindow
  if (win === null || !mainWindowReady) {
    console.log('[input] 主窗口不可用，确认弹窗直接按取消处理')
    return false
  }
  const promise = new Promise<string>((resolve) => {
    pendingInput = { flow, resolve }
  })
  showMainWindow()
  try {
    win.webview?.executeJavascript(confirmModalScript({ flow, title, body }))
  } catch (error) {
    console.log(`[input] 确认弹窗注入失败：${String(error)}`)
    pendingInput = null
    return false
  }
  const value = await Promise.race([
    promise,
    Bun.sleep(INPUT_CONFIRM_TIMEOUT_MS).then(() => ''),
  ])
  if (pendingInput?.flow === flow) pendingInput = null
  return value === 'force'
}

/** 托盘「注册 dsh 命令」：冲突时弹确认（旧壳 confirm_modal），确认才强制覆盖。 */
async function registerDshCliFromTray(): Promise<void> {
  const state = registerCli.cached()
  let force = false
  if (state.kind === 'conflict') {
    const target = state.resolved ?? '未知目标'
    const confirmed = await confirmModal(
      'register-cli',
      '检测到 dsh 命令冲突',
      `当前系统里的 dsh 指向：\n${target}\n\n注册会把 /usr/local/bin/dsh 指到本壳的垫片，原目标会先备份。`,
    )
    if (!confirmed) {
      console.log('[register] 用户取消覆盖，注册未完成')
      return
    }
    force = true
  }
  const result = await registerCli.register({ force })
  console.log(`[register] ${result.ok ? '注册成功' : '注册未完成'}：${result.message}`)
  refreshTray()
}

// ---- 单实例：已有实例活着就不起第二份宿主，只请它把窗口带到前台 ----
// （Electrobun 2.0.2 没有单实例 API，旧 Tauri 壳用的是 tauri-plugin-single-instance）
// P2 测试钩子（旧壳 lib.rs:742-757）：DSH_DESKTOP_NO_SINGLETON=1 跳过单实例互斥（并行探针用）
const instanceFile = join(appSupportDir(), 'shell-instance.json')
const instance = acquireInstance(instanceFile, instanceProfile)
const skipSingleton = (process.env.DSH_DESKTOP_NO_SINGLETON ?? '') !== ''
if (!instance.acquired && !skipSingleton) {
  const previous = instance.previous
  if (previous !== null && previous.origin !== '') {
    try {
      await fetch(activateUrl(previous), { method: 'POST' })
      console.log(`[shell] 已有实例在运行（pid = ${String(previous.pid)}），已请求激活后退出`)
    } catch (error) {
      console.error(`[shell] 激活已有实例失败：${String(error)}`)
    }
  } else {
    console.log(`[shell] 已有实例正在启动（pid = ${String(previous?.pid ?? '?')}），本次不再起宿主`)
  }
  // 第二个实例不做任何服务面工作，直接退出（不起宿主、不抢端口、不写台账）
  process.exit(0)
}

// ---- 启动界面：起宿主那几十秒里给用户看的东西（无窗口模式跳过）----
let splash: BrowserWindow | null = null
/**
 * 启动界面的 CEF 浏览器要到 `dom-ready` 才真存在。在那之前调 `executeJavascript` 会打到
 * 空的 `scoped_refptr<CefBrowser>` 上，**原生层直接 FATAL 记账退出**（实测：`Check failed: ptr_.`
 * in `cef_scoped_refptr.h`，栈在 `-[CEFWebViewImpl evaluateJavaScriptWithNoCompletion:]`）——
 * 那是 abort，JS 的 try/catch 拦不住。所以先只记阶段，等 dom-ready 再补推。
 */
let splashReady = false
let lastStage: ShellStage = 'instance'
const pushStage = (): void => {
  if (splash === null || !splashReady) return
  try {
    splash.webview?.executeJavascript(splashStageScript(lastStage))
  } catch {}
}

if (!noWindow) {
  splash = new BrowserWindow({
    title: APP_NAME,
    html: splashHtml(),
    renderer: 'cef',
    titleBarStyle: 'hidden',
    frame: { width: SPLASH_WIDTH, height: SPLASH_HEIGHT },
  })
  // 页面还没加载完时推阶段会被丢掉：dom-ready 之后再补推一次（也是浏览器对象可用的信号）
  splash.on('dom-ready', () => {
    splashReady = true
    pushStage()
  })
}

// dsh 系统命令注册（旧壳 `register/`）：shim 指向当前运行时，探测走用户真实登录 shell，
// 状态缓存起来供托盘用（菜单重建很频繁，**绝不在这里同步 spawn shell**）。
const registerCli = createRegisterCli({
  log: (message) => console.log(message),
  appSupport: appSupportDir(),
  shellCommand: () => {
    const paths = uiService().paths
    return [process.execPath, '--no-install', '--preload', paths.preloadFile, join(paths.dshLibDir, 'bin.js')]
  },
})

// 通知：决策在壳里（notify-policy）；macOS 上投递走我们自己的 UN 桥（旧壳 `notify_un.rs` 的路子：
// 进程自己就有 bundle 身份、状态可查、授权可申请），桥不可用或投递失败再退回 Electrobun 的原生通道。
// 裸 dev 进程没有 bundle id，UN 会硬崩——所以只在 available 时才调。
const notifyBridge = createNativeNotify({ log: (line) => console.log(line) })
const notifier: Notifier = createNotifier({
  notifications: bootSettings.notifications,
  home: dshHome(),
  appName: APP_NAME,
  show: (options) => {
    if (
      notifyBridge.available &&
      notifyBridge.post({ title: options.title, body: options.body ?? '', sound: options.silent !== true })
    ) {
      return
    }
    Utils.showNotification?.(options)
  },
  isFullscreen: () => mainWindow?.isFullScreen() ?? false,
  onLog: (line) => console.log(line),
})
let service: ShellService
/** 找到持有 lane 转发器的那份服务面（多实例下只有先起的那份非 null）。 */
const focusedLaneForwarder = (): LaneForwarder | null => {
  for (const svc of services.values()) {
    if (svc.laneForwarder !== null) return svc.laneForwarder
  }
  return null
}
try {
  service = await ensureService(instanceProfile)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[shell] 启动失败：${message}`)
  notifier.notify(SCENARIO.STARTUP_ERROR, `桌面壳启动失败：${message}`)
  // 无窗口模式（CI/黑盒）把失败原样抛出去；有启动界面就留在屏幕上让人看见原因
  // 启动界面还没到 dom-ready 时不能推 JS（原生层会 FATAL）：那就只留日志
  if (splash === null || !splashReady) throw error
  try {
    splash.webview?.executeJavascript(splashFailScript(message))
  } catch {}
  await Bun.sleep(SPLASH_FAILURE_HOLD_MS)
  Utils.quit()
  throw error
}
console.log(`SHELL-READY ${JSON.stringify({ ...service.state, locale })}`)
// 服务面就绪：把 origin/页面 URL 回填给实例锁，第二个壳才能激活这个窗口
updateInstance(instanceFile, process.pid, { origin: service.state.origin, pageUrl: service.state.pageUrl })
// P2 测试钩子（旧壳 lib.rs:744 _AUTO_QUIT）：服务面就绪后延迟自动退出，给 CI/探针一个干净的结束信号
if ((process.env.DSH_DESKTOP_AUTO_QUIT ?? '') !== '') {
  const delayMs = Number(process.env.DSH_DESKTOP_AUTO_QUIT) > 0 ? Number(process.env.DSH_DESKTOP_AUTO_QUIT) : 3_000
  setTimeout(() => {
    console.log('[shell] DSH_DESKTOP_AUTO_QUIT 触发自动退出')
    void shutdown()
  }, delayMs).unref?.()
}

let startupBlocked = false
if (!noWindow) {
  // 兼容/高级模式弹框（旧壳：端口被外部实例占用时先问再动）：启动界面里问，选完再建主窗。
  if (service.state.blocked !== undefined) {
    splash?.webview?.executeJavascript(splashFailScript(service.state.blocked))
    setTimeout(() => { void shutdown() }, SPLASH_FAILURE_HOLD_MS)
    startupBlocked = true
  }
  if (!startupBlocked && service.modePromptNeeded()) {
    const { profile, port } = { profile: service.state.profile, port: service.state.upstreamPort }
    const origin = service.state.origin
    const modeUi = `(function(){var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;background:rgba(16,20,24,0.95);display:flex;flex-direction:column;gap:10px;padding:18px;font:13px/1.5 system-ui;color:#d7dde6;z-index:9';d.innerHTML='<b style=\"font-size:14px\">检测到已有 dsh 服务（外部实例）</b><span>端口 ${port} 上已有 dsh 在跑。兼容模式直接复用它（标准布局）；高级模式会停掉它并由壳重新拉起（桌面界面）。</span><input id=\"tk\" placeholder=\"可选：粘贴 dsh web 打印的完整 URL（含 token）\" style=\"padding:6px 8px;border-radius:6px;border:1px solid #3a4453;background:#0b0e12;color:#d7dde6\"/><div style=\"display:flex;gap:8px;justify-content:flex-end\"><button id=\"c\" style=\"padding:6px 12px;border-radius:6px\">兼容模式（标准布局）</button><button id=\"a\" style=\"padding:6px 12px;border-radius:6px;background:#3b82f6;color:#fff;border:0\">高级模式（桌面界面）</button></div><span id=\"m\" style=\"color:#8b95a3\"></span>';document.body.appendChild(d);var post=async function(mode){document.getElementById('m').textContent=mode==='compat'?'正在进入兼容模式…':'正在停用外部服务并以高级模式启动…';try{var r=await fetch('${origin}/__shell__/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:mode,tokenUrl:document.getElementById('tk').value})});var j=await r.json();if(j.needsToken){document.getElementById('m').textContent='请粘贴带 token 的完整 URL 后再点兼容模式';return}d.remove()}catch(e){document.getElementById('m').textContent=String(e)}};document.getElementById('c').onclick=function(){post('compat')};document.getElementById('a').onclick=function(){post('advanced')}})()`
    splash?.webview?.executeJavascript(modeUi)
    await service.modeChosen
  }
  // 标题栏形态与旧壳对齐：macOS 保留原生红绿灯并叠在内容上（旧壳 TitleBarStyle::Overlay），
  // Windows/Linux 隐藏原生标题栏，caption 行与窗口按钮由插件 client 自绘（旧壳 decorations:false）。
  if (!startupBlocked) createProfileWindow(instanceProfile, service)
  // 右键菜单里我们自己那几项（原生 role 由系统处理，不会回到这里）；
  // 多窗口下作用在「最近聚焦」那个窗口上。
  ContextMenu.on('context-menu-clicked', (event) => {
    const detail = (event as { data?: { action?: string; data?: { url?: string } } }).data
    const action = detail?.action ?? ''
    const url = detail?.data?.url
    if (action === SHELL_MENU_ACTIONS.reload) {
      focusedWindow()?.webview?.loadURL(uiService().state.pageUrl)
      return
    }
    if (action === SHELL_MENU_ACTIONS.openExternal && url !== undefined) {
      if (!Utils.openExternal(url)) console.warn(`[shell] 系统浏览器没接住外链：${url}`)
      return
    }
    if (action === SHELL_MENU_ACTIONS.copyLink && url !== undefined) {
      Utils.clipboardWriteText(url)
    }
  })
  // 测试钩子：启动时把这些 profile 的窗口一并开出来（多窗口的实机/CI 验证用，逗号分隔）
  const extraProfiles = (process.env.DSH_SHELL_OPEN_PROFILES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== instanceProfile)
  for (const profile of extraProfiles) void openProfileWindow(profile)
}

// ---- 托盘：显示/隐藏、profile、运行时来源、退出 ----
// 无窗口模式（CI/黑盒）不建托盘——那里没有窗口可隐藏，托盘只会碍事。
if (!noWindow) {
  const image = trayImagePath()
  if (image === null) {
    console.warn('[shell] 找不到托盘图标（resources/tray.png / runtime/tray.png），本次不建托盘')
  } else {
    tray = createTray({
      image,
      state: trayState(),
      onAction: onTrayAction,
      onEmptyClick: () => {
        // P8（旧壳 tray.rs:265-285，#181）：左键单击托盘 = 聚焦最后活跃窗口；没有就开主 profile 的窗
        const win = focusedWindow()
        if (win !== null && win !== undefined) {
          win.unminimize?.()
          win.show()
          win.activate()
        } else {
          void openProfileWindow(instanceProfile)
        }
      },
      log: (line) => console.log(line)
    })
    refreshTray()
  }
  // macOS Dock 图标被点（无可见窗口时）：把主窗带回来
  app.on('reopen', () => {
    console.log('[shell] Dock 再激活：显示主窗')
    showMainWindow()
  })
}

let stopping = false
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  quitting = true
  // 托盘先摘：否则退出过程中它还会响菜单（点了就是另一个 shutdown）
  tray?.destroy()
  tray = null
  for (const timer of frameSaveTimers.values()) clearTimeout(timer)
  frameSaveTimers.clear()
  try {
    // 先摘服务面与宿主（SIGTERM → 宽限期 → SIGKILL，并等它真退出）再让框架退出；
    // 不能像以前那样发完信号就走——壳一退，宿主就被 launchd 收养，变成占着会话的孤儿。
    const stops = [...services.values()].map(async (svc) => {
      try {
        await svc.stop()
      } catch (error) {
        console.error(`[shell] 停止服务面失败（${svc.paths.profile}）：${String(error)}`)
      }
    })
    await Promise.race([Promise.all(stops), Bun.sleep(SHELL_STOP_DEADLINE_MS)])
  } catch (error) {
    console.error(`[shell] 停止服务面失败：${String(error)}`)
  }
  releaseInstance(instanceFile, process.pid)
  Utils.quit()
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('exit', () => {
  if (!stopping) {
    stopping = true
    try {
      for (const svc of services.values()) {
        void svc.stop()
      }
    } catch {}
  }
})
