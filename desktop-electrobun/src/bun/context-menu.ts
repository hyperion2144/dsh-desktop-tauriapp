// 页面右键菜单：CEF 默认不弹菜单（Electrobun 用自己的 CefContextMenuHandler 接管），
// 旧壳（WKWebView）自带的那份里「刷新页面」等项在换壳后就没了。
//
// 做法：页面在 `contextmenu` 时把上下文（有没有点到链接、是否可编辑、有没有选中）报给壳端点，
// 由**主进程**用 Electrobun 的 `ContextMenu.showContextMenu` 弹原生菜单——复制/剪切/粘贴/全选
// 走原生 role（macOS 上才有意义，Windows/Linux 由 CEF 自己处理 Ctrl 系快捷键）；「刷新页面」
// 「在系统浏览器打开链接」「复制链接地址」是我们自己的 action，回到主进程执行。
//
// 这里是纯逻辑部分（菜单结构 + 注入脚本），执行部分在 index.ts。

export const CONTEXT_MENU_ENDPOINT = '/__shell__/context-menu'

import { VIEW_TOKEN_HEADER } from '../shared/view-grant.ts'

export interface ContextMenuRequest {
  /** 右键点到的链接（没有则 null）。 */
  linkUrl: string | null
  /** 当前是否有选区。 */
  hasSelection: boolean
  /** 是否点在可编辑元素上（输入框 / contenteditable）。 */
  editable: boolean
}

export interface ShellMenuItem {
  type?: 'normal' | 'separator' | 'divider'
  label?: string
  role?: string
  action?: string
  data?: unknown
  enabled?: boolean
}

export const SHELL_MENU_ACTIONS = {
  reload: 'shell:reload',
  openExternal: 'shell:open-external-link',
  copyLink: 'shell:copy-link',
} as const

/**
 * 原生菜单结构。`externalLink` 判定由调用方给（壳知道自己的 origin），
 * 返回的项里 `data` 带上执行时需要的参数。
 */
export function contextMenuItems(request: ContextMenuRequest, linkIsExternal: boolean): ShellMenuItem[] {
  const items: ShellMenuItem[] = []
  if (request.linkUrl !== null && request.linkUrl !== '') {
    if (linkIsExternal) {
      items.push({ label: '在系统浏览器打开链接', action: SHELL_MENU_ACTIONS.openExternal, data: { url: request.linkUrl } })
    }
    items.push({ label: '复制链接地址', action: SHELL_MENU_ACTIONS.copyLink, data: { url: request.linkUrl } })
    items.push({ type: 'separator' })
  }
  items.push({ label: '刷新页面', action: SHELL_MENU_ACTIONS.reload })
  if (request.editable || request.hasSelection) {
    items.push({ type: 'separator' })
    if (request.editable) {
      items.push({ role: 'cut', enabled: request.hasSelection })
      items.push({ role: 'copy', enabled: request.hasSelection })
      items.push({ role: 'paste' })
    } else {
      items.push({ role: 'copy' })
    }
    items.push({ role: 'selectAll' })
  }
  return items
}

/** document-start 注入：右键时把上下文报给壳，交给原生菜单。 */
export function contextMenuScript(viewToken: string): string {
  return [
    ';(() => {',
    `  const ENDPOINT = ${JSON.stringify(CONTEXT_MENU_ENDPOINT)}`,
    `  const VIEW_TOKEN = ${JSON.stringify(viewToken)}`,
    '  const log = (msg) => console.info("[context-menu] " + msg)',
    '  document.addEventListener("contextmenu", (event) => {',
    '    const target = event.target',
    '    const anchor = target && target.closest ? target.closest("a[href]") : null',
    '    const href = anchor ? anchor.href : null',
    '    const selection = String(globalThis.getSelection ? globalThis.getSelection() : "")',
    '    const editable = !!(target && (target.isContentEditable || /^(input|textarea)$/i.test(target.tagName || "")))',
    '    // 页面自己接管了右键（例如 dsh 的富文本区域）就不插手',
    '    if (event.defaultPrevented) return',
    '    event.preventDefault()',
    '    try {',
    '      void fetch(ENDPOINT, {',
    '        method: "POST",',
    `        headers: { "content-type": "application/json", ${JSON.stringify(VIEW_TOKEN_HEADER)}: VIEW_TOKEN },`,
    '        body: JSON.stringify({ linkUrl: href, hasSelection: selection.length > 0, editable, x: event.clientX, y: event.clientY }),',
    '        keepalive: true,',
    '      })',
    '    } catch (error) { log("右键菜单请求失败：" + String(error)) }',
    '  })',
    '})()',
  ].join('\n')
}
