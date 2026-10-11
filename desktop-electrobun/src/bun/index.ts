// Electrobun 主进程入口：CEF 断言 → 起服务面 → 建窗。
//
// 服务面（运行时就位、端口认领、起宿主、取 cookie、loopback 服务）在 service.ts 里，
// 那一层不 import electrobun；这里只做「渲染器断言」和「窗口」两件事。

import { ApplicationMenu, BrowserWindow, BuildConfig, ContextMenu, Utils } from 'electrobun/bun'
import { systemLocale } from './locale.ts'
import { installApplicationMenu } from './menu.ts'
import { bootPreloadScript } from './preload.ts'
import { startService } from './service.ts'
import { SHELL_MENU_ACTIONS, contextMenuItems } from './context-menu.ts'
import { isExternalUrl } from './external.ts'
import { APP_NAME } from '../shared/app.ts'
import { appSupportDir } from './runtime.ts'
import { acquireInstance, activateUrl, releaseInstance, updateInstance } from './single-instance.ts'
import { SPLASH_HEIGHT, SPLASH_WIDTH, splashFailScript, splashHtml, splashStageScript } from './splash.ts'
import { stageLabel, stagePercent, type ShellStage } from './stages.ts'
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

// ---- 单实例：已有实例活着就不起第二份宿主，只请它把窗口带到前台 ----
// （Electrobun 2.0.2 没有单实例 API，旧 Tauri 壳用的是 tauri-plugin-single-instance）
const instanceFile = join(appSupportDir(), 'shell-instance.json')
const instance = acquireInstance(instanceFile, process.env.DSH_PROFILE ?? 'desktop')
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
let lastStage: ShellStage = 'instance'
const pushStage = (): void => {
  if (splash === null) return
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
  // 页面还没加载完时推阶段会被丢掉：dom-ready 之后再补推一次
  splash.on('dom-ready', () => pushStage())
}
let service: Awaited<ReturnType<typeof startService>>
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
    mainWindow?.webview?.loadURL(state.pageUrl)
  },
  onHostGiveUp: (state, reason) => {
    console.error(`[shell] 宿主守护器放弃重启（${reason}）；页面停在 ${state.pageUrl}`)
  },
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[shell] 启动失败：${message}`)
  // 无窗口模式（CI/黑盒）把失败原样抛出去；有启动界面就留在屏幕上让人看见原因
  if (splash === null) throw error
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
    frame: { width: 1280, height: 860 },
  })
  mainWindow = win
  // 主窗已出画面：拆掉启动界面（页面自己也等 __DSH_BOOT_READY__，这里只负责别让两个窗口并存）
  win.on('dom-ready', () => {
    try {
      splash?.close()
    } catch {}
    splash = null
  })
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

let stopping = false
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
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
