// Electrobun 主进程入口：CEF 断言 → 起服务面 → 建窗。
//
// 服务面（运行时就位、端口认领、起宿主、取 cookie、loopback 服务）在 service.ts 里，
// 那一层不 import electrobun；这里只做「渲染器断言」和「窗口」两件事。

import { BrowserWindow, BuildConfig, Utils } from 'electrobun/bun'
import { systemLocale } from './locale.ts'
import { bootPreloadScript } from './preload.ts'
import { startService } from './service.ts'

/** 客户端版本标识：dsh 0.2.1-alpha.2 的 telemetry/product-analytics 插件把它当必填项。 */
const CLIENT_VERSION = '0.1.0'

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
// 系统语言：CEF 默认 en-US，页面语言跟着错；旧壳（WKWebView）是天然跟随系统的。
const locale = await systemLocale()
const service = await startService({ clientVersion: CLIENT_VERSION, noWindow })
console.log(`SHELL-READY ${JSON.stringify({ ...service.state, locale })}`)

if (!noWindow) {
  // 标题栏形态与旧壳对齐：macOS 保留原生红绿灯并叠在内容上（旧壳 TitleBarStyle::Overlay），
  // Windows/Linux 隐藏原生标题栏，caption 行与窗口按钮由插件 client 自绘（旧壳 decorations:false）。
  const win = new BrowserWindow({
    title: 'DeepSeek Harness Desktop',
    url: service.state.pageUrl,
    renderer: 'cef',
    preload: bootPreloadScript(locale),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: { width: 1280, height: 860 },
  })
  void win
}

let stopping = false
const shutdown = (): void => {
  if (stopping) return
  stopping = true
  try {
    service.stop()
  } catch {}
  Utils.quit()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => {
  if (!stopping) {
    stopping = true
    try {
      service.stop()
    } catch {}
  }
})
