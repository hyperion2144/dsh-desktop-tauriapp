// 页面桥：官方 apps/desktop/src/preload-app.ts 的 `dshDesktopBoot` 等价物。
//
// 契约（官方与我们的 dist 都已内置同一段胶水）：
//   - 壳在 index.html 的 <head> 后插一行 `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`
//   - 该 promise 的 resolve 由这里暴露的 `dshDesktopBoot.ready()` 的结果喂给页面
//   - 页面拿到 { injections, streamBaseUrl } 后调用上游自带的 applyIndexInjections 逐行应用，
//     并设 `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`
//
// 载荷来源：壳自己（进程内）持有宿主上报的 rows。骨架期用壳的同源端点
// `/__shell__/boot`（宿主就绪前 503，页面会等）取回；把载体换成 Electrobun 的
// 每视图 RPC 是后续增量，契约不变（官方用 IPC handle 返回同样两个字段）。

import { carrierScript, type CarrierPlatform } from './carrier.ts'
import { chromeScript, type ShellPlatform } from './chrome.ts'
import { contextMenuScript } from './context-menu.ts'
import { externalLinksScript } from './external.ts'
import { tauriIpcScript } from './tauri-ipc.ts'

export const BOOT_ENDPOINT = '/__shell__/boot'

import { VIEW_TOKEN_HEADER } from '../shared/view-grant.ts'

export function bootPreloadScript(locale: string, platform: ShellPlatform, selfOrigin: string, viewToken: string): string {
  const carrier: CarrierPlatform = platform
  return [
    `const viewToken = ${JSON.stringify(viewToken)}`,
    // 视图 token 必须在最外层：下面的 dshDesktopBoot 在 try 块之外，拿不到 try 里的作用域。
    // 系统语言：旧壳（WKWebView）天然跟随系统，CEF 下默认 en-US，页面语言就跟着错了。
    // 这里把壳探到的系统 locale 摆在 navigator 上，页面按它选语言。
    'try {',
    `  const primary = ${JSON.stringify(locale)}`,
    `  const candidates = ${JSON.stringify([...new Set([locale, locale.split('-')[0] ?? locale, 'en-US', 'en'])])}`,
    "  Object.defineProperty(navigator, 'language', { get: () => primary })",
    "  Object.defineProperty(navigator, 'languages', { get: () => candidates })",
    '} catch {}',
    'globalThis.dshDesktopBoot = {',
    `  ready: () => fetch(${JSON.stringify(BOOT_ENDPOINT)}, { cache: 'no-store', headers: { '${VIEW_TOKEN_HEADER}': viewToken } }).then((res) => {`,
    "    if (!res.ok) throw new Error('shell boot pending: ' + res.status)",
    '    return res.json()',
    '  }),',
    '  failed: (error) => { console.error("desktop boot failed", error) },',
    '}',
    // 载体标记：dsh 前端只在 globalThis.dshDesktop 存在时才装浏览器 guest 桥（旧壳同款）
    carrierScript(carrier),
    // 窗口 chrome（骨架期）：给 macOS 红绿灯让出顶部空间 + 打平台标记
    chromeScript(platform),
    // 外链（会话里的链接、侧边栏浏览器「在系统浏览器打开」）不把壳自己的窗口带走：
    // 上游契约是 window.open，CEF 下没人接，这里改发壳端点 → Utils.openExternal。
    externalLinksScript(selfOrigin, viewToken),
    // 右键菜单：CEF 不弹菜单，页面把上下文报给主进程，由它弹原生菜单。
    contextMenuScript(viewToken),
    // 壳自己的客户端插件是照 Tauri 写的（`__TAURI_INTERNALS__.invoke`）：
    // 这里把它接到壳的 RPC 端点上，桌面 chrome（设置面板/通知/下载…）才会激活。
    tauriIpcScript(viewToken),
  ].join('\n')
}
