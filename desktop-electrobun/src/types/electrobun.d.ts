// hutch 工具链在构建/运行期提供 electrobun（不在项目 node_modules 里），
// 这里只声明壳用到的面，保证 `tsc --noEmit` 与编辑器可用；行为以 Electrobun 2.0.2 为准。

declare module 'electrobun/bun' {
  export interface WindowFrame {
    x?: number
    y?: number
    width: number
    height: number
  }

  export interface WindowOptions {
    title?: string
    url?: string
    html?: string
    /** 内联 JS 源码（document-start 注入）；空串等价于不注入 */
    preload?: string | null
    renderer?: 'native' | 'cef'
    frame?: WindowFrame
    titleBarStyle?: string
    transparent?: boolean
    hidden?: boolean
    viewsRoot?: string | null
    navigationRules?: unknown
    sandbox?: boolean
  }

  export class BrowserWindow {
    constructor(options: WindowOptions)
    close(): void
    on(event: string, handler: (...args: unknown[]) => void): void
    /** 窗口的 webview（重载页面、执行脚本） */
    readonly webview?: {
      url: string
      loadURL(url: string): void
      executeJavascript(js: string): void
    }
    setWindowButtonPosition(x: number, y: number): void
  }

  export interface BuildConfigShape {
    channel: string
    defaultRenderer?: string
    availableRenderers?: string[]
    [key: string]: unknown
  }

  export const BuildConfig: { getSync(): BuildConfigShape }

  export const Utils: {
    quit(): void
    showNotification?(options: { title: string; body: string }): void
    /** 系统浏览器 / 默认应用程序打开外链（FFI，成功返 true） */
    openExternal(url: string): boolean
    clipboardWriteText(text: string): void
  }

  export const Tray: unknown

  export const ApplicationMenu: {
    setApplicationMenu(items: unknown[]): void
    on(event: string, handler: (event: unknown) => void): void
  }

  export const ContextMenu: {
    showContextMenu(items: unknown[]): void
    on(event: 'context-menu-clicked', handler: (event: unknown) => void): void
  }
}

declare module 'electrobun' {
  export interface ElectrobunConfig {
    app: { name: string; identifier: string; version: string }
    build: {
      mainProcess?: 'bun' | 'cottontail' | string
      bun?: { entrypoint: string }
      views?: Record<string, { entrypoint: string }>
      copy?: Record<string, string>
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}
