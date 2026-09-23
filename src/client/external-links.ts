/**
 * 桌面壳外链处理：把 webview 里指向外部网页/协议（http/https/mailto/tel）的链接
 * 统一交给系统默认浏览器/应用打开（对话内、设置页等任意位置）。
 * 只在 Tauri IPC 存在时接管：
 *  - 左键 / 中键 / 修饰键(Cmd/Ctrl/Shift/Alt + 左键) 点击外部 <a>；
 *  - window.open 外部 URL（"在新窗口打开链接"、代码内 open）。
 * 纯浏览器（无 Tauri IPC）不做任何拦截，保留浏览器原生行为。
 * 拦截/成功/失败都会经 log_diag 上报到桌面应用日志，便于排查「点击无反应」。
 * #109：拦截前尊重 dsh 的「网页链接默认打开方式」（ui-chat.linkOpening，默认 sidebar）：
 * sidebar 且右栏浏览器 tab 可用 → 在侧边栏浏览器内打开（仅 desktop profile 有该 tab；
 * web profile/手机布局无 tab 自动回退系统打开）。无 dsh 设置表单（0.1.6）/非 sidebar/
 * mailto/tel → 维持系统打开。判定每次点击实时执行（dsh 服务可能晚于壳 client 就绪）。
 */

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** 尽可能拿到 Tauri 调用入口（withGlobalTauri 的 __TAURI__，或内部 __TAURI_INTERNALS__）。 */
function tauriInvoke(): TauriInvoke | undefined {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: TauriInvoke } }
    __TAURI_INTERNALS__?: {
      invoke?: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>
    }
  }
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__.core.invoke
  if (w.__TAURI_INTERNALS__?.invoke) {
    const inner = w.__TAURI_INTERNALS__.invoke
    return (cmd, args) => inner(cmd, args ?? {}, undefined)
  }
  return undefined
}

/** 诊断上报：有 Tauri 时才写，避免在纯浏览器里报错。 */
function diag(msg: string): void {
  const invoke = tauriInvoke()
  if (!invoke) return
  invoke('log_diag', { msg }).catch(() => { /* ignore */ })
}

/** 解析外部目标：非外链返回 undefined；同 host 视为站内路由交给 dsh。 */
function externalUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined
  let url: URL
  try {
    url = new URL(href, window.location.href)
  } catch {
    return undefined
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol)) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.href
    if (url.host !== window.location.host) return url.href
  }
  return undefined
}

type DshClientContext = {
  configForms?: {
    get?: (ns: string) =>
      | { getSnapshot?: () => { value?: { linkOpening?: string } } }
      | undefined
  }
  sidebarRight?: { openTab?: (id: string, params: Record<string, unknown>) => void }
  get?: (id: string) => unknown
}

/**
 * #109：外链路由分流。返回 'sidebar' = 在 dsh 右栏浏览器内打开；'system' = 转系统。
 * 判定（每次点击实时执行，dsh 服务可能晚于壳 client 就绪）：
 * 1) 仅 http/https 可进侧边栏（mailto/tel 恒系统）；
 * 2) 需 dsh 的 ui-chat 设置表单存在（0.1.6 无 → 回退系统，维持现状）；
 * 3) linkOpening === 'sidebar'（dsh 默认）；
 * 4) 右栏浏览器 tab 真实存在（仅 desktop profile 有；web profile/手机布局无 tab 自动回退）。
 */
function decideSidebarRoute(ctx: unknown, url: string): 'sidebar' | 'system' {
  let web = false
  try {
    web = /^https?:$/.test(new URL(url).protocol)
  } catch {
    return 'system'
  }
  if (!web || ctx === undefined || ctx === null) return 'system'
  const c = ctx as DshClientContext
  const form = c.configForms?.get?.('ui-chat')
  if (!form || typeof form.getSnapshot !== 'function') return 'system'
  if ((form.getSnapshot()?.value?.linkOpening ?? 'sidebar') !== 'sidebar') return 'system'
  const tabs = (typeof c.get === 'function' ? c.get('sidebarRightTabs') : undefined) as
    | { get?: (id: string) => unknown }
    | undefined
  if (typeof tabs?.get !== 'function' || !tabs.get('browser')) return 'system'
  if (typeof c.sidebarRight?.openTab !== 'function') return 'system'
  return 'sidebar'
}

/** 侧边栏打开（调用前已由 decideSidebarRoute 确认可用）。 */
function openInSidebar(ctx: unknown, url: string): void {
  ;(ctx as DshClientContext).sidebarRight?.openTab?.('browser', { params: { url } })
}

function openInSystem(url: string): void {
  const invoke = tauriInvoke()
  if (invoke) {
    invoke('open_external', { url })
      .then(() => {
        diag('已转交系统打开: ' + url)
        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          console.debug('[dsh-desktop-tauriapp] 已转交系统打开：', url)
        }
      })
      .catch((e: unknown) => {
        diag('open_external 调用失败: ' + String(e) + ' | ' + url)
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-desktop-tauriapp] open_external 调用失败：', e, url)
        }
        try {
          window.open(url, '_blank', 'noopener')
        } catch {
          /* ignore */
        }
      })
  } else {
    try {
      window.open(url, '_blank', 'noopener')
    } catch {
      /* ignore */
    }
  }
}

/** 安装全局外链拦截器（点击 + 中键 + window.open 覆盖）；返回卸载函数（页面存活期保持）。 */
export function installExternalLinkHandler(ctx?: unknown): () => void {
  const onClick = (event: MouseEvent): void => {
    // 每次点击实时探测 Tauri，避免安装时早于注入导致永久失效
    if (!tauriInvoke()) return
    if (event.defaultPrevented) return
    // 左键(0)/中键(1)；右键(2)放行（保留原生右键菜单）
    if (event.button !== 0 && event.button !== 1) return
    const el = event.target as Element | null
    const anchor = el?.closest?.('a') as HTMLAnchorElement | null
    if (!anchor) return
    const url = externalUrl(anchor.getAttribute('href'))
    if (!url) return
    event.preventDefault()
    // #109：sidebar 模式且右栏浏览器可用 → 侧边栏内打开（desktop profile）；否则系统打开
    if (decideSidebarRoute(ctx, url) === 'sidebar') {
      event.preventDefault()
      event.stopPropagation()
      diag('外链转侧边栏浏览器: ' + url)
      openInSidebar(ctx, url)
      return
    }
    event.stopPropagation()
    diag('拦截到外链: ' + url)
    openInSystem(url)
  }
  const onAuxClick = (event: MouseEvent): void => onClick(event)

  const originalOpen = window.open.bind(window)
  const openOverride: typeof window.open = (url, target, features) => {
    const external = externalUrl(typeof url === 'string' ? url : url?.href)
    if (external && tauriInvoke()) {
      diag('window.open 外链: ' + external)
      if (decideSidebarRoute(ctx, external) === 'sidebar') {
        diag('window.open 外链转侧边栏浏览器: ' + external)
        openInSidebar(ctx, external)
        return null
      }
      openInSystem(external)
      return null
    }
    return originalOpen(typeof url === 'string' ? url : url, target, features)
  }

  document.addEventListener('click', onClick, true)
  document.addEventListener('auxclick', onAuxClick, true)
  window.open = openOverride
  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('auxclick', onAuxClick, true)
    if (window.open === openOverride) window.open = originalOpen
  }
}
