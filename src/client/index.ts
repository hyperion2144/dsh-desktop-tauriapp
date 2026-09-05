import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { installExternalLinkHandler } from './external-links.ts'
import { requestDesktopClientEnvironment } from './environment.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export { parseDesktopClientEnvironment, requestDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'theme',
  'workspaces',
]

/**
 * 把 WebView 控制台（console.* / window.onerror / unhandledrejection）镜像到桌面壳的
 * `log_console` Tauri 命令，Rust 端追加到 `~/.dsh/dsh-desktop-webview.log`。
 * 失败（无 Tauri IPC、序列化抛错）一律吞掉，不阻塞页面。运行成本：每条 console
 * 多一次 `JSON.stringify` + 一次 IPC；warn/error 还会额外镜像到 dsh-desktop-tauriapp.log
 * 便于交叉对比。装在 apply 头部，确保 dsh-desktop-tauriapp client 装载后所有插件的
 * console.* 都走这条路径（仅错过 dsh-desktop-tauriapp 装载完成前那几条启动日志，
 * 那些日志对前端 bug 定位价值不高）。
 */
function installWebviewConsoleMirror(): void {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args: unknown) => Promise<void> } }
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown, opts?: unknown) => Promise<void> }
  }
  // 两条 invoke 通道：withGlobalTauri 注入的 __TAURI__（仅 tauri:// 域）+ Tauri 2 内部 IPC
  // 通道 __TAURI_INTERNALS__（跨域也存在，capabilities 允许的命令即可）。两条都试，
  // 至少一条能通就镜像成功；都不通则 no-op（保留原 console 行为）。
  const invoke = (cmd: string, args: unknown): void => {
    const a = w.__TAURI__?.core?.invoke
    if (a) { a(cmd, args).catch(() => {}); return }
    const b = w.__TAURI_INTERNALS__?.invoke
    if (b) { b(cmd, args, undefined).catch(() => {}); return }
  }
  const fwd = (level: string, args: unknown[]): void => {
    try {
      const msg = args
        .map((a) => {
          if (a instanceof Error) return a.stack || a.message
          if (typeof a === 'object') {
            try { return JSON.stringify(a) } catch { return String(a) }
          }
          return String(a)
        })
        .join(' ')
      const url = (typeof location !== 'undefined' && location.href) || '?'
      invoke('log_console', { level, msg, pageUrl: url })
    } catch {
      // 镜像失败不影响原 console 行为
    }
  }
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
  for (const lvl of levels) {
    const orig = console[lvl].bind(console)
    console[lvl] = (...a: unknown[]) => {
      fwd(lvl, a)
      orig.apply(console, a as never)
    }
  }
  window.addEventListener('error', (e) => {
    const msg = e.error?.stack || e.message || 'Uncaught error'
    fwd('error', [msg])
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined
    fwd('error', [`Unhandled rejection: ${r?.message || String(e.reason)}`, r?.stack || ''])
  })
}

/**
 * 桌面壳 WebView 与浏览器行为对齐：macOS WKWebView 默认开启橡皮筋滚动
 * （rubber-band bounce）——页面内容未超出视口时仍能轻微拖动并自动回弹，
 * 露出 viewport 外的空白；浏览器没有该行为。用 `overscroll-behavior: none`
 * 禁用（Safari/WKWebView 16+ 支持；普通浏览器无副作用，只是禁掉"过度滚动"，
 * 正常滚动不受影响）。
 */
function installNoRubberBand(): void {
  try {
    const style = document.createElement('style')
    style.dataset.dshDesktopNoBounce = '1'
    style.textContent =
      'html{overscroll-behavior:none;-webkit-overflow-scrolling:touch;} body{overscroll-behavior:none;}'
    ;(document.head || document.documentElement).appendChild(style)
  } catch {
    /* noop */
  }
}

/**
 * 桌面壳 client 入口：仅在桌面 shell 的 webview URL 携带
 * `dsh-desktop-tauriapp-mode=advanced&dsh-desktop-tauriapp-platform=<platform>` 时激活高级布局。
 * 普通浏览器访问（无 query 标记）时不做任何改动。
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // 最早装：把 console.* 镜像到 ~/.dsh/dsh-desktop-webview.log（开发期排查前端 bug 必备）。
  // 即使非 advanced 模式（普通浏览器直访 dsh）也装，便于离线调试。
  installWebviewConsoleMirror()
  // WebView 橡皮筋滚动对齐浏览器（禁 rubber-band）
  installNoRubberBand()
  // 桌面 webview（含复用降级/无标记场景）都接管外链打开；纯浏览器无 Tauri IPC 时 no-op
  installExternalLinkHandler()
  // 桌面 chrome 激活条件 = 壳经 IPC 下发的环境为 advanced。
  // 不再用 URL 标记：token 交换的 303 会剥掉 query，标记无法与 token 同跳；
  // 模式/平台本就是壳的运行状态，由壳下发。纯浏览器无 IPC → 不激活（原语义不变）。
  void requestDesktopClientEnvironment()
    .then((environment) => {
      if (environment?.mode === 'advanced') applyAdvancedShell(ctx, environment)
    })
    .catch(() => {})
}
