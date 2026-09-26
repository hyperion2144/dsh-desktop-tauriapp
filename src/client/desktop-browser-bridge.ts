/**
 * 侧边栏浏览器 guest 载体桥（#118/#134）。
 *
 * 壳 Rust 侧在本地 loopback 窗口注入了 `globalThis.dshDesktop`（protocolVersion 1）
 * 的惰性标记（见 desktop/src-tauri/src/ui/browser_guests/mod.rs 的
 * DESKTOP_CARRIER_INIT_SCRIPT）；dsh 的 ui-sidebar-browser 探测到载体后即切换为
 * guest 模式（ElectronWebviewImpl + <webview> 标签）。本文件提供标记背后的
 * 真实实现（`__dshShellBridgeImpl`）：
 *
 * - 桥三方法：acquire / release / onOpenRequested（Rust 命令的薄封装）；
 * - 状态镜像：dsh 对 webview 元素的 getURL/getTitle/isLoading/canGoBack/
 *   canGoForward 是同步拉取，而 IPC 是异步——由 Rust 在每次状态变化后 eval
 *   `__dshShellBridgeImpl._receive(快照)` 推送，本层更新镜像并合成对应的
 *   Electron webview DOM 事件（dom-ready / did-navigate / did-start-loading…）；
 * - 矩形同步：原生子 webview 永远浮在 dsh 内容之上，必须用 ResizeObserver
 *   把 webview 标签的 getBoundingClientRect 实时同步给 Rust（CSS px = 窗口
 *   逻辑坐标），rect 归零（切 tab/收侧栏）或 [role=dialog] 弹层与标签相交
 *   时隐藏 guest。
 *
 * 纯浏览器 / 远程窗口（无 dshDesktop 标记）不安装任何东西，行为不变。
 */

interface Internals {
  invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
}

function internals(): Internals | undefined {
  const w = window as unknown as { __TAURI_INTERNALS__?: Internals }
  return w.__TAURI_INTERNALS__
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const i = internals()
  if (!i?.invoke) return Promise.reject(new Error('no-tauri-ipc'))
  return i.invoke(cmd, args, undefined) as Promise<T>
}

/** Rust 推送的 guest 快照（browser_guest_state / _receive 载荷）。 */
interface GuestPush {
  lease: string
  kind: 'started' | 'finished' | 'failed' | 'title' | 'gone' | 'state'
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** dsh 侧 acquire 返回的预约。 */
interface GuestReservation {
  lease: string
  partition: string
}

/** Electron webview 元素兼容面（dsh ElectronWebViewImpl 调用集）。 */
interface WebviewElementLike extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  clearHistory(): void
  stop(): void
}

interface GuestMirror {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  el: WebviewElementLike | undefined
  /** 已对 Rust 可见（避免重复 show/hide 抖动）。 */
  shown: boolean
  /** 弹层遮挡中（[role=dialog] 与标签矩形相交）。 */
  overlayHidden: boolean
  rectPending: boolean
}

const mirrors = new Map<string, GuestMirror>()
const openListeners = new Map<string, (url: string) => void>()
/** 每个已绑定 guest 的矩形调度器（lease → scheduleRect），供共享轮询兑底。 */
const rectSchedulers = new Map<string, () => void>()
let rectPollTimer: number | undefined
/**
 * 矩形同步兑底轮询：不同引擎的 ResizeObserver 对 display:none 转换不触发
 * （实测某 Chromium），切 tab/收侧栏等隐藏机制也不能全靠 RO；400ms 共享轮询
 * 兑底（调度本身 rAF 合并，几乎无额外开销）。
 */
function ensureRectPoll(): void {
  if (rectPollTimer !== undefined) return
  rectPollTimer = window.setInterval(() => {
    for (const [lease, schedule] of rectSchedulers) {
      if (!mirrors.has(lease)) {
        rectSchedulers.delete(lease)
        continue
      }
      schedule()
    }
  }, 400)
}

function mirrorOf(lease: string): GuestMirror {
  let m = mirrors.get(lease)
  if (!m) {
    m = {
      url: `about:blank#${lease}`,
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      el: undefined,
      shown: false,
      overlayHidden: false,
      rectPending: false,
    }
    mirrors.set(lease, m)
  }
  return m
}

/** Electron webview 事件对象（属性直接挂在 event 上，detail 不参与）。 */
function makeEvent(type: string, props?: Record<string, unknown>): Event {
  const ev = new Event(type)
  if (props) Object.assign(ev, props)
  return ev
}

function applyPush(push: GuestPush): void {
  const m = mirrors.get(push.lease)
  if (!m) return
  m.url = push.url
  m.title = push.title
  m.loading = push.loading
  m.canGoBack = push.canGoBack
  m.canGoForward = push.canGoForward
  const el = m.el
  if (!el) return
  switch (push.kind) {
    case 'started':
      el.dispatchEvent(makeEvent('did-start-navigation', { isMainFrame: true }))
      el.dispatchEvent(makeEvent('did-start-loading'))
      break
    case 'finished':
      el.dispatchEvent(makeEvent('did-stop-loading'))
      el.dispatchEvent(makeEvent('did-navigate'))
      break
    case 'failed':
      el.dispatchEvent(makeEvent('did-stop-loading'))
      // errorCode 留空：dsh 显示通用「页面加载失败」条（Rust 看门狗超时判失败）
      el.dispatchEvent(makeEvent('did-fail-load', { isMainFrame: true }))
      break
    case 'title':
      el.dispatchEvent(makeEvent('page-title-updated'))
      break
    case 'gone':
      el.dispatchEvent(makeEvent('render-process-gone'))
      break
    default:
      break
  }
}

// ── webview 标签兼容层 ─────────────────────────────────────

function patchElement(el: WebviewElementLike, lease: string, m: GuestMirror): void {
  const fireAndForget = (cmd: string, args: Record<string, unknown>): void => {
    void invoke(cmd, args).catch((e) => {
      console.error('[desktop-browser-bridge] 命令失败', cmd, e)
    })
  }
  el.loadURL = (url: string): Promise<void> =>
    invoke('browser_guest_navigate', { lease, url }).then(
      () => undefined,
      (e) => {
        // dsh 仅忽略 ERR_ABORTED；其余 rejection 走 commandFailed 显示失败条
        throw e
      },
    )
  el.getURL = (): string => m.url
  el.getTitle = (): string => m.title
  el.isLoading = (): boolean => m.loading
  el.canGoBack = (): boolean => m.canGoBack
  el.canGoForward = (): boolean => m.canGoForward
  el.goBack = (): void => fireAndForget('browser_guest_control', { lease, action: 'back' })
  el.goForward = (): void => fireAndForget('browser_guest_control', { lease, action: 'forward' })
  el.reload = (): void => fireAndForget('browser_guest_control', { lease, action: 'reload' })
  // bootstrap 历史不落地策略：初始 about:blank 不产生 back-forward 条目（Rust 侧
  // 不为其导航），WKWebView/WebView2 均无需真实清历史
  el.clearHistory = (): void => {}
  el.stop = (): void => {}
}

function rectsIntersect(a: DOMRectReadOnly, b: DOMRectReadOnly): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function isWebviewTag(node: Node): node is WebviewElementLike {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as HTMLElement
  // 不用 instanceof HTMLUnknownElement：不同引擎对未注册标签的构造器不统一
  // （实测某 Chromium 下 webview 非 HTMLUnknownElement）；tagName + dsh 自有的
  // dataset 稳定标记已足够判定
  return (
    el.tagName.toLowerCase() === 'webview' &&
    el.dataset?.sidebarBrowserFrame === 'webview' &&
    typeof el.getAttribute('name') === 'string'
  )
}

function installTagObserver(): void {
  const bind = (el: WebviewElementLike): void => {
    const lease = el.getAttribute('name') as string
    const m = mirrorOf(lease)
    if (m.el === el) return
    m.el = el
    patchElement(el, lease, m)

    // 矩形同步：rAF 合并；rect 归零或弹层相交即隐藏
    const applyRect = (): void => {
      m.rectPending = false
      const r = el.getBoundingClientRect()
      const rectVisible = r.width > 1 && r.height > 1
      const shouldShow = rectVisible && !m.overlayHidden
      if (rectVisible) {
        void invoke('browser_guest_set_bounds', {
          lease,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        }).catch(() => {})
      }
      if (shouldShow !== m.shown) {
        m.shown = shouldShow
        void invoke('browser_guest_set_visible', { lease, visible: shouldShow }).catch(() => {})
      }
    }
    const scheduleRect = (): void => {
      if (m.rectPending) return
      m.rectPending = true
      requestAnimationFrame(applyRect)
    }
    rectSchedulers.set(lease, scheduleRect)
    ensureRectPoll()
    const recomputeOverlay = (): void => {
      const el2 = m.el
      if (!el2) return
      let hidden = false
      const r = el2.getBoundingClientRect()
      for (const dlg of document.querySelectorAll('[role=dialog]')) {
        const dr = dlg.getBoundingClientRect()
        if (dr.width > 0 && rectsIntersect(r, dr)) {
          hidden = true
          break
        }
      }
      m.overlayHidden = hidden
      scheduleRect()
    }
    const ro = new ResizeObserver(scheduleRect)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    window.addEventListener('resize', scheduleRect)
    const dialogMo = new MutationObserver(recomputeOverlay)
    dialogMo.observe(document.body, { childList: true, subtree: true })

    // 初始同步 + dom-ready（dsh 收到后置 ready 并 loadPending）
    void invoke<GuestPush>('browser_guest_state', { lease })
      .then((snap) => {
        m.url = snap.url
        m.title = snap.title
        m.loading = snap.loading
        m.canGoBack = snap.canGoBack
        m.canGoForward = snap.canGoForward
      })
      .catch(() => {})
      .finally(() => {
        scheduleRect()
        recomputeOverlay()
        el.dispatchEvent(makeEvent('dom-ready'))
      })
  }

  const mo = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && isWebviewTag(node)) bind(node)
      }
    }
  })
  mo.observe(document.documentElement, { childList: true, subtree: true })
}

// ── 桥实现安装 ─────────────────────────────────────────────

interface BridgeImpl {
  acquire(workspace: unknown): Promise<GuestReservation>
  release(lease: string): Promise<void>
  onOpenRequested(lease: string, listener: (url: string) => void): () => void
  _receive(push: GuestPush): void
  _openRequested(payload: { lease: string; url: string }): void
}

/**
 * 安装桌面壳浏览器 guest 桥（幂等）。
 * 仅当壳 Rust 侧已注入 `globalThis.dshDesktop` 标记（本地 loopback 窗口）时生效。
 */
export function installDesktopBrowserBridge(): void {
  const g = globalThis as unknown as { dshDesktop?: unknown; __dshShellBridgeImpl?: BridgeImpl }
  if (!g.dshDesktop || g.__dshShellBridgeImpl) return
  const impl: BridgeImpl = {
    acquire(workspace: unknown): Promise<GuestReservation> {
      const key = typeof workspace === 'string' ? workspace : String(workspace ?? '')
      return invoke<GuestReservation>('browser_guest_acquire', { workspaceKey: key }).then(
        (res) => {
          mirrorOf(res.lease)
          return res
        },
      )
    },
    release(lease: string): Promise<void> {
      const m = mirrors.get(lease)
      if (m) {
        m.el = undefined
        m.shown = false
        mirrors.delete(lease)
      }
      openListeners.delete(lease)
      return invoke('browser_guest_release', { lease }).then(
        () => undefined,
        (e) => {
          console.error('[desktop-browser-bridge] guest release 失败', e)
        },
      )
    },
    onOpenRequested(lease: string, listener: (url: string) => void): () => void {
      openListeners.set(lease, listener)
      return () => {
        if (openListeners.get(lease) === listener) openListeners.delete(lease)
      }
    },
    _receive(push: GuestPush): void {
      applyPush(push)
    },
    _openRequested(payload: { lease: string; url: string }): void {
      openListeners.get(payload.lease)?.(payload.url)
    },
  }
  g.__dshShellBridgeImpl = impl
  installTagObserver()
  // 页面卸载（dsh 重启/切换 profile 重导航）兜底释放 guest，防原生 webview 泄漏
  window.addEventListener('pagehide', () => {
    void invoke('browser_guest_release_all', {}).catch(() => {})
  })
}
