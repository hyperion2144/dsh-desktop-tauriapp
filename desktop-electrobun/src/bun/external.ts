// 「在系统浏览器打开」：页面里的外链不该把壳自己的窗口带走。
//
// 上游 dsh 的契约就一条：**外部打开 = `window.open(url, "_blank", "noopener,noreferrer")`**
// （`dsh-client-ui-chat` 的 `openExternalLink`：设成应用内侧边栏就走侧边栏浏览器，否则 window.open；
// `dsh-client-ui-sidebar-browser` 的「在系统浏览器打开」也是同一句）。旧壳（WKWebView + Tauri）
// 靠 `on_new_window` / nav_guard 把它转成系统浏览器；CEF 这边没人接，所以点了没反应。
//
// 这里在页面里补一层拦截，规则：
//   - 只拦外链（http/https/mailto/tel 且 origin ≠ 壳自己的 loopback origin）；
//   - `window.open` 一律改走壳端点；`target="_blank"` 的锚点同理；
//   - 点击/中键在 **冒泡阶段** 且 `defaultPrevented === false` 时才处理——dsh 自己处理过的链接
//     （会话内的 open-in-app / 侧边栏浏览器）原样放行，不然会把上游行为顶掉；
//   - 同一 origin 的链接不动（应用内导航照旧）。
//
// 端点在 shell-server 里，最终调用 Electrobun 的 `Utils.openExternal`（主进程 API）。

export const OPEN_EXTERNAL_ENDPOINT = '/__shell__/open-external'

import { VIEW_TOKEN_HEADER } from '../shared/view-grant.ts'

/** 能交给系统打开的协议。 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** 这个 URL 该不该交给系统浏览器。 */
export function isExternalUrl(raw: string, selfOrigin: string): boolean {
  let url: URL
  try {
    url = new URL(raw, selfOrigin)
  } catch {
    return false
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin !== selfOrigin
  return true
}

/**
 * document-start 注入的外链拦截脚本。
 * `selfOrigin` 是壳自己的 loopback origin（同源链接保持应用内行为）。
 */
export function externalLinksScript(selfOrigin: string, viewToken: string): string {
  return [
    ';(() => {',
    `  const ENDPOINT = ${JSON.stringify(OPEN_EXTERNAL_ENDPOINT)}`,
    `  const SELF_ORIGIN = ${JSON.stringify(selfOrigin)}`,
    `  const VIEW_TOKEN = ${JSON.stringify(viewToken)}`,
    `  const PROTOCOLS = ${JSON.stringify([...EXTERNAL_PROTOCOLS])}`,
    '  const log = (msg) => console.info("[external] " + msg)',
    '  const isExternal = (raw) => {',
    '    let url',
    '    try { url = new URL(raw, location.href) } catch { return false }',
    '    if (!PROTOCOLS.includes(url.protocol)) return false',
    '    if (url.protocol === "http:" || url.protocol === "https:") return url.origin !== SELF_ORIGIN',
    '    return true',
    '  }',
    '  const openExternal = (raw) => {',
    '    if (!isExternal(raw)) return false',
    '    const url = new URL(raw, location.href).href',
    '    try {',
    '      void fetch(ENDPOINT, {',
    '        method: "POST",',
    `        headers: { "content-type": "application/json", ${JSON.stringify(VIEW_TOKEN_HEADER)}: VIEW_TOKEN },`,
    '        body: JSON.stringify({ url }),',
    '        keepalive: true,',
    '      }).then((res) => { if (!res.ok) log("壳拒绝了外链：" + url + " (" + res.status + ")") })',
    '    } catch (error) { log("外链请求失败：" + String(error)) }',
    '    log("转系统浏览器：" + url)',
    '    return true',
    '  }',
    '  globalThis.__dshOpenExternal = openExternal',
    // window.open：上游「系统浏览器打开」就是这一句
    '  const nativeOpen = globalThis.open',
    '  globalThis.open = function (url, name, features) {',
    '    if (typeof url === "string" && openExternal(url)) return null',
    '    return nativeOpen.call(globalThis, url, name, features)',
    '  }',
    // 普通点击 / 中键：dsh 已处理过的（defaultPrevented）放行
    '  const CLICK_BUTTONS = [0, 1]',
    '  const onPointer = (event) => {',
    '    if (!CLICK_BUTTONS.includes(event.button)) return',
    '    if (event.defaultPrevented) return',
    '    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null',
    '    if (!anchor) return',
    '    const href = anchor.getAttribute("href")',
    '    if (!href || href.startsWith("#")) return',
    '    if (!openExternal(href)) return',
    '    event.preventDefault()',
    '    event.stopPropagation()',
    '  }',
    '  document.addEventListener("click", onPointer, false)',
    '  document.addEventListener("auxclick", onPointer, false)',
    '})()',
  ].join('\n')
}
