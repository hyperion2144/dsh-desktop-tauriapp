/**
 * 浏览器 guest 的策略与形状（#220 决策 12「guest 子 webview 保留，但收紧授权面」）。
 *
 * 旧壳实现在 `desktop/src-tauri/src/ui/browser_guests/{policy.rs,mod.rs}`（#118/#134）：
 * 侧边栏浏览器不是 iframe，而是宿主窗口里的**子 webview**——顶层导航外部站点，从根上修掉
 * macOS「永远正在打开…」。本文件把其中**纯逻辑**部分搬过来（可单测、不 import electrobun）：
 *
 *   · 导航策略（对齐 dsh 官方 Electron 桌面 `browser-guests.ts` 的边界规则）：
 *     放行外部 http(s)、`about:`；拒绝带凭证 URL（`user:pass@host`）、应用宿主（loopback 与
 *     内部 dsh 主机，guest 不得触达本机 dsh 服务）、其余 scheme 一律拒绝；
 *   · 租约与 partition：`persist:ws-<fnv64>` 按 workspace 派生（同 workspace 复用存储）；
 *   · 状态推送形状：dsh 对 `<webview>` 的 getURL/isLoading/canGoBack 是**同步拉取**，而壳→页面的
 *     IPC 是异步——所以由壳在每次状态变化后向宿主页面 eval 一条 `_receive(快照)`，client 维护镜像。
 *
 * 与旧壳的**有意差异**（Electrobun 能力面所限，见 docs/research/electrobun-capability-surface.md）：
 *   · 历史读控（canGoBack/canGoForward/goBack/goForward）不走平台原生 API，而是壳里 dlopen
 *     `libElectrobunCore.dylib` 调 `webviewCanGoBack/webviewGoBack/...`（`native-webview.ts`）；
 *   · 页面标题与加载态由注入 guest 的**上报脚本**经 `__electrobunSendToHost` 回传，而不是平台回调。
 */

/** guest 子视图的标识前缀（旧壳 `GUEST_LABEL_PREFIX`；诊断与按宿主批量回收都用它）。 */
export const GUEST_LABEL_PREFIX = 'browser-guest-'

/** 租约形状：`g` + 4 位序号 + 12 位时间戳（旧壳 `next_lease()` 逐字对齐）。 */
export const GUEST_LEASE_PATTERN = /^g[0-9a-f]{4}[0-9a-f]{12}$/

/** 初始落位：屏幕外 1×1（client 绑定元素后才 set_bounds，避免闪一下全屏白页）。 */
export const OFFSCREEN_GUEST_RECT = { x: -20000, y: -20000, width: 1, height: 1 }

/** guest 的 bootstrap 地址（历史不落地：初始 about:blank 不产生 back-forward 条目）。 */
export const GUEST_DEFAULT_URL = 'about:blank'

/** 加载看门狗（旧壳 30s：WKWebView 网络级失败不产生 Finished 回调）。 */
export const GUEST_LOAD_TIMEOUT_MS = 30_000
/** 冷分区就绪等待：CEF 自定义请求上下文首次创建时会抢跑失败（浏览器建了但没挂到 webview）。 */
export const GUEST_WARMUP_MS = 1_200

/** 矩形（CSS 像素，相对宿主窗口内容区）。 */
export interface GuestRect {
  x: number
  y: number
  width: number
  height: number
}

/** 壳侧维护的 guest 镜像状态（推送内容 = 它 + kind + lease）。 */
export interface GuestState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** 推送种类：started | finished | failed | title | gone | state。 */
export type GuestPushKind = 'started' | 'finished' | 'failed' | 'title' | 'gone' | 'state'

/** 推给页面 `__dshShellBridgeImpl._receive(...)` 的快照。 */
export interface GuestPush extends GuestState {
  lease: string
  kind: GuestPushKind
}

/** acquire 的返回（partition 只回填到 `<webview>` 标签属性，dsh 不消费语义）。 */
export interface GuestReservation {
  lease: string
  partition: string
}

export const EMPTY_GUEST_STATE: GuestState = {
  url: GUEST_DEFAULT_URL,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
}

/** FNV-1a 64（旧壳同一常数；workspace → 存储标识）。 */
export function fnv64(input: string, seed = 0xcbf29ce484222325n): bigint {
  let hash = seed
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash
}

/** 16 位小写十六进制的 fnv64（partition 名）。 */
export function fnv64Hex(input: string): string {
  return fnv64(input).toString(16).padStart(16, '0')
}

/** workspace → Electrobun partition 名（旧壳是 `persist:ws-<16 位>`）。 */
export function guestPartition(workspaceKey: string): string {
  return `persist:ws-${fnv64Hex(workspaceKey || 'default')}`
}

/** 生成一枚租约（进程内唯一即可；`nowMs` 注入便于单测）。 */
export function newGuestLease(seq: number, nowMs: number): string {
  const counter = (seq >>> 0).toString(16).padStart(4, '0').slice(-4)
  const nanos = (BigInt(Math.max(0, Math.floor(nowMs))) * 1_000_000n).toString(16).padStart(12, '0')
  return `g${counter}${nanos.slice(-12)}`
}

/** 判定视图标签是否为 guest（旧壳 `is_guest_label`）。 */
export function isGuestLabel(label: string): boolean {
  return label.startsWith(GUEST_LABEL_PREFIX)
}

/** URL 是否带内嵌凭证（`user:pass@host`）。 */
export function hasEmbeddedCredentials(url: URL): boolean {
  return url.username !== '' || url.password !== ''
}

/**
 * 主机是否为应用宿主（loopback + 我们的页面 origin + 运行时放行的远程 dsh 主机）。
 * IPv6 字面量在 `URL.hostname` 里带方括号（`[::1]`），先剥掉再比。
 */
export function isAppHost(host: string, extraHosts: readonly string[] = []): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare === '') return false
  if (bare === '127.0.0.1' || bare === '::1' || bare === 'localhost') return true
  if (bare === 'tauri.localhost' || bare === 'dshapp.localhost') return true
  return extraHosts.some((entry) => entry !== '' && entry === bare)
}

/** guest 导航策略（旧壳 `guest_navigation_policy` 的等价物）。 */
export function guestNavigationAllowed(raw: string, options: { appHosts?: readonly string[] } = {}): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return !hasEmbeddedCredentials(url) && !isAppHost(url.hostname, options.appHosts ?? [])
  }
  if (url.protocol === 'about:') return true
  return false
}

/** 历史动作（旧壳 `browser_guest_control` 的 action）。 */
export function guestControlAction(raw: string): 'back' | 'forward' | 'reload' | null {
  const value = raw.trim().toLowerCase()
  if (value === 'back' || value === 'forward' || value === 'reload') return value
  return null
}

/** 归一化 client 送来的矩形；坏值返回 null（命令报错，而不是贴到 (0,0) 全屏）。 */
export function normalizeGuestRect(value: unknown): GuestRect | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  const parts = (['x', 'y', 'width', 'height'] as const).map((key) => source[key])
  if (parts.some((part) => typeof part !== 'number' || !Number.isFinite(part))) return null
  const [x, y, width, height] = parts as [number, number, number, number]
  const clamp = (input: number, min: number, max: number): number => Math.min(max, Math.max(min, input))
  return {
    x: Math.round(clamp(x, -100_000, 100_000)),
    y: Math.round(clamp(y, -100_000, 100_000)),
    width: Math.round(clamp(width, 1, 20_000)),
    height: Math.round(clamp(height, 1, 20_000)),
  }
}

/** 组一条推送（形状与旧壳 `GuestSnapshot` 一致，client 直接吃）。 */
export function guestPush(lease: string, kind: GuestPushKind, state: GuestState): GuestPush {
  return {
    lease,
    kind,
    url: state.url,
    title: state.title,
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  }
}

/** JSON 字面量 → JS 表达式安全化（U+2028/2029 会破坏 JS 字符串字面量）。 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** 宿主页面里的状态推送脚本（旧壳 `push_snapshot` 的 eval）。 */
export function hostReceiveScript(push: GuestPush): string {
  return `window.__dshShellBridgeImpl&&window.__dshShellBridgeImpl._receive(${jsLiteral(push)})`
}

/** 宿主页面里的「新窗口请求」脚本（旧壳 `push_open_requested`）。 */
export function hostOpenRequestedScript(lease: string, url: string): string {
  return `window.__dshShellBridgeImpl&&window.__dshShellBridgeImpl._openRequested(${jsLiteral({ lease, url })})`
}

/**
 * 注入 guest 页面内部的上报脚本（幂等）。
 *
 * 为什么要它：Electrobun 的 webview 事件只回 URL（`dom-ready` / `did-navigate` 的 detail 是字符串），
 * 没有标题回调，`executeJavascript` 也拿不到返回值——所以标题/加载态只能由 guest 自己回传。
 * 回传通道用内置 preload 暴露的 `__electrobunSendToHost`（sandbox 模式下 RPC 关闭，但事件仍可用）。
 */
export function guestReporterScript(): string {
  return `(function(){
  if (window.__dshGuestReporter) return 'again';
  window.__dshGuestReporter = true;
  var send = function (kind, loading) {
    var payload = {
      __dshGuest: 1,
      kind: kind,
      url: String(location.href || ''),
      title: String(document.title || ''),
      loading: loading === true
    };
    try { window.__electrobunSendToHost(payload); } catch (error) {}
  };
  var titleOf = function () { return String(document.title || ''); };
  var lastTitle = titleOf();
  send('state', false);
  document.addEventListener('DOMContentLoaded', function () { send('started', true); });
  window.addEventListener('load', function () { send('finished', false); });
  window.addEventListener('popstate', function () { send('title', false); });
  window.addEventListener('hashchange', function () { send('title', false); });
  window.setInterval(function () {
    var title = titleOf();
    if (title !== lastTitle) { lastTitle = title; send('title', false); }
  }, 1000);
})()`
}

/** 解析 guest 上报（`host-message` 的 detail 是 JSON 解析后的对象）。 */
export function parseGuestReport(
  detail: unknown,
): { kind: GuestPushKind; url: string; title: string; loading: boolean } | null {
  if (typeof detail !== 'object' || detail === null) return null
  const source = detail as Record<string, unknown>
  if (source.__dshGuest !== 1) return null
  const kind = source.kind
  const allowed: GuestPushKind[] = ['started', 'finished', 'failed', 'title', 'state']
  if (typeof kind !== 'string' || !allowed.includes(kind as GuestPushKind)) return null
  return {
    kind: kind as GuestPushKind,
    url: typeof source.url === 'string' ? source.url : '',
    title: typeof source.title === 'string' ? source.title : '',
    loading: source.loading === true,
  }
}

/**
 * 从事件 detail 里取 URL。
 *
 * Electrobun 对导航类事件的 detail 并不统一：`dom-ready`/`did-navigate` 有时给纯 URL 字符串，
 * `will-navigate` 给的是 JSON 文本 `{"url":…,"allowed":…}`（原生侧算好的导航裁决）。
 * 这里两种都认，认不出来回空串（调用方只在非空时覆盖 state）。
 */
export function detailUrl(detail: unknown): string {
  if (typeof detail === 'string') {
    const text = detail.trim()
    if (text === '') return ''
    if (text.startsWith('{')) {
      try {
        return fieldUrl(JSON.parse(text))
      } catch {
        return ''
      }
    }
    return text
  }
  return fieldUrl(detail)
}

/**
 * `will-navigate` 的原生裁决：`allowed === false` 表示原生规则已经拦了。
 * 拿不到字段时回 null（调用方按「没拦」处理，自己的策略照旧生效）。
 */
export function nativeAllowsNavigation(detail: unknown): boolean | null {
  const source = detailObject(detail)
  if (source === null) return null
  return typeof source.allowed === 'boolean' ? source.allowed : null
}

function detailObject(detail: unknown): Record<string, unknown> | null {
  if (typeof detail === 'object' && detail !== null) return detail as Record<string, unknown>
  if (typeof detail !== 'string') return null
  const text = detail.trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function fieldUrl(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const url = (value as Record<string, unknown>).url
  return typeof url === 'string' ? url : ''
}
