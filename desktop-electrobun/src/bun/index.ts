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

/** 客户端版本标识：dsh 0.2.1-alpha.2 的 telemetry/product-analytics 插件把它当必填项。 */
const CLIENT_VERSION = '0.1.0'
/** 退出时等宿主与 CEF 子进程收尾的上限（超过就交给框架的优雅退出） */
const SHELL_STOP_DEADLINE_MS = 8_000

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
const service = await startService({
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
  onHostRestart: (state) => {
    // 宿主被守护器拉起来了：把窗口刷回同一个页面 origin（token/端口都没变）
    console.log(`[shell] 宿主已重启，页面重载：${state.pageUrl}`)
    mainWindow?.webview?.loadURL(state.pageUrl)
  },
  onHostGiveUp: (state, reason) => {
    console.error(`[shell] 宿主守护器放弃重启（${reason}）；页面停在 ${state.pageUrl}`)
  },
})
console.log(`SHELL-READY ${JSON.stringify({ ...service.state, locale })}`)

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
