// Electrobun 主进程入口：CEF 断言 → 起服务面 → 建窗。
//
// 服务面（运行时就位、端口认领、起宿主、取 cookie、loopback 服务）在 service.ts 里，
// 那一层不 import electrobun；这里只做「渲染器断言」和「窗口」两件事。

import { ApplicationMenu, BrowserWindow, BuildConfig, ContextMenu, Screen, Utils, app } from 'electrobun/bun'
import { systemLocale } from './locale.ts'
import { installApplicationMenu } from './menu.ts'
import { bootPreloadScript } from './preload.ts'
import { startService } from './service.ts'
import { SHELL_MENU_ACTIONS, contextMenuItems } from './context-menu.ts'
import { isExternalUrl } from './external.ts'
import { APP_NAME } from '../shared/app.ts'
import { appSupportDir, dshHome, trayImagePath } from './runtime.ts'
import { acquireInstance, activateUrl, releaseInstance, updateInstance } from './single-instance.ts'
import { SPLASH_HEIGHT, SPLASH_WIDTH, splashFailScript, splashHtml, splashStageScript } from './splash.ts'
import { stageLabel, stagePercent, type ShellStage } from './stages.ts'
import { createTray, type TrayHandle } from './tray.ts'
import { trayMenu, type TrayAction, type TrayState } from './tray-menu.ts'
import { listProfiles, runtimeLabel } from './profiles.ts'
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
import { createNotifier, type Notifier } from './notifications.ts'
import { SCENARIO } from '../shared/notify-policy.ts'
import { join } from 'node:path'

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
function restoreWindowFrame(): WindowFrame {
  const saved = sanitizeFrame(readWindowFrame(windowStateFile), displayBounds())
  if (saved === null) return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, x: 0, y: 0 }
  console.log(`[shell] 还原窗口位置：${String(saved.x)},${String(saved.y)} ${String(saved.width)}×${String(saved.height)}`)
  return saved
}

/** 拖动/缩放会连续触发：合并 400ms 只写一次。 */
let saveFrameTimer: ReturnType<typeof setTimeout> | null = null
function scheduleFrameSave(win: BrowserWindow): void {
  if (saveFrameTimer !== null) clearTimeout(saveFrameTimer)
  saveFrameTimer = setTimeout(() => {
    saveFrameTimer = null
    try {
      const frame = win.getFrame()
      writeWindowFrame(windowStateFile, { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) })
    } catch (error) {
      console.warn(`[shell] 窗口几何落盘失败：${String(error)}`)
    }
  }, 400)
}

function trayState(): TrayState {
  return {
    windowVisible,
    profile: instanceProfile,
    // 多 profile 窗口还没做：菜单只列当前这一个，别摆一个点了不切的子菜单
    profiles: [instanceProfile],
    hostRunning: service !== null,
    runtimeLabel: runtimeLabel(service?.state.runtimeDir ?? ''),
  }
}

function refreshTray(): void {
  tray?.setState(trayState())
}

function showMainWindow(): void {
  if (mainWindow === null) return
  mainWindow.unminimize()
  mainWindow.show()
  mainWindow.activate()
  windowVisible = true
  refreshTray()
}

function hideMainWindow(): void {
  if (mainWindow === null) return
  mainWindow.hide()
  windowVisible = false
  refreshTray()
}

function onTrayAction(action: TrayAction): void {
  if (action.kind === 'toggle-window') {
    if (windowVisible) hideMainWindow()
    else showMainWindow()
    return
  }
  if (action.kind === 'quit') {
    console.log('[shell] 托盘：退出')
    void shutdown()
    return
  }
  console.log(`[shell] 托盘请求切换 profile：${String(action.profile)}（多 profile 窗口未实现，本轮不切）`)
}

// ---- 单实例：已有实例活着就不起第二份宿主，只请它把窗口带到前台 ----
// （Electrobun 2.0.2 没有单实例 API，旧 Tauri 壳用的是 tauri-plugin-single-instance）
const instanceFile = join(appSupportDir(), 'shell-instance.json')
const instance = acquireInstance(instanceFile, instanceProfile)
if (!instance.acquired) {
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

// 通知：决策在壳里（notify-policy），投递交给 Electrobun 的原生通道（无窗口时退到命令行）。
const notifier: Notifier = createNotifier({
  notifications: bootSettings.notifications,
  home: dshHome(),
  appName: APP_NAME,
  show: (options) => Utils.showNotification?.(options),
  isFullscreen: () => mainWindow?.isFullScreen() ?? false,
  onLog: (line) => console.log(line),
})
let service: Awaited<ReturnType<typeof startService>>
// 通知：决策在壳里（notify-policy），投递交给 Electrobun 的原生通道（无窗口时退到命令行）。
try {
  service = await startService({
  clientVersion: CLIENT_VERSION,
  noWindow,
  onOpenExternal: (url) => {
    if (!Utils.openExternal(url)) console.warn(`[shell] 系统浏览器没接住外链：${url}`)
  },
  onContextMenu: (request) => {
    const linkIsExternal = request.linkUrl !== null && isExternalUrl(request.linkUrl, service.state.origin)
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
    // 第二个壳点了一次图标：把已有窗口带到前台（恢复最小化、显示、抢焦点）
    console.log('[shell] 收到激活请求：窗口带到前台')
    if (mainWindow !== null) {
      mainWindow.unminimize()
      mainWindow.show()
      mainWindow.activate()
    }
  },
  onHostRestart: (state) => {
    // 宿主被守护器拉起来了：把窗口刷回同一个页面 origin（token/端口都没变）
    console.log(`[shell] 宿主已重启，页面重载：${state.pageUrl}`)
    if (mainWindowReady) mainWindow?.webview?.loadURL(state.pageUrl)
  },
  onHostGiveUp: (state, reason) => {
    console.error(`[shell] 宿主守护器放弃重启（${reason}）；页面停在 ${state.pageUrl}`)
  },
  notifier,
  })
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

if (!noWindow) {
  // 标题栏形态与旧壳对齐：macOS 保留原生红绿灯并叠在内容上（旧壳 TitleBarStyle::Overlay），
  // Windows/Linux 隐藏原生标题栏，caption 行与窗口按钮由插件 client 自绘（旧壳 decorations:false）。
  const win = new BrowserWindow({
    title: APP_NAME,
    url: service.state.pageUrl,
    renderer: 'cef',
    preload: bootPreloadScript(locale, platform, service.state.origin),
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: restoreWindowFrame(),
  })
  mainWindow = win
  // 主窗已出画面：拆掉启动界面（页面自己也等 __DSH_BOOT_READY__，这里只负责别让两个窗口并存）
  win.on('dom-ready', () => {
    try {
      splash?.close()
    } catch {}
    splash = null
    windowVisible = true
    refreshTray()
    mainWindowReady = true
  })
  // 关窗回托盘：原生层会先问 `will-close`，回 response.allow=false 就不关（旧 Tauri 壳同行为）。
  // 没有托盘时不能隐藏（隐藏后没有入口再叫回来），直接走真退出。
  win.on('will-close', (event) => {
    if (quitting) return
    if (!closeToTray()) {
      console.log('[shell] 关窗（无托盘）：直接退出')
      void shutdown()
      return
    }
    ;(event as { response?: unknown }).response = { allow: false }
    console.log('[shell] 关窗回托盘（窗口隐藏，进程继续）')
    hideMainWindow()
  })
  // 位置/尺寸记忆：拖动与缩放都会触发，合并落盘（旧 Tauri 壳是 tauri-plugin-window-state）
  win.on('resize', () => scheduleFrameSave(win))
  win.on('move', () => scheduleFrameSave(win))
  // 右键菜单里我们自己那几项（原生 role 由系统处理，不会回到这里）
  ContextMenu.on('context-menu-clicked', (event) => {
    const detail = (event as { data?: { action?: string; data?: { url?: string } } }).data
    const action = detail?.action ?? ''
    const url = detail?.data?.url
    if (action === SHELL_MENU_ACTIONS.reload) {
      win.webview?.loadURL(service.state.pageUrl)
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
}

// ---- 托盘：显示/隐藏、profile、运行时来源、退出 ----
// 无窗口模式（CI/黑盒）不建托盘——那里没有窗口可隐藏，托盘只会碍事。
if (!noWindow) {
  const image = trayImagePath()
  if (image === null) {
    console.warn('[shell] 找不到托盘图标（resources/tray.png / runtime/tray.png），本次不建托盘')
  } else {
    tray = createTray({ image, state: trayState(), onAction: onTrayAction, log: (line) => console.log(line) })
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
  if (saveFrameTimer !== null) {
    clearTimeout(saveFrameTimer)
    saveFrameTimer = null
  }
  try {
    // 先摘服务面与宿主（SIGTERM → 宽限期 → SIGKILL，并等它真退出）再让框架退出；
    // 不能像以前那样发完信号就走——壳一退，宿主就被 launchd 收养，变成占着会话的孤儿。
    await Promise.race([service.stop(), Bun.sleep(SHELL_STOP_DEADLINE_MS)])
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
      void service.stop()
    } catch {}
  }
})
