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
    /** D1 原生导航守卫：glob 串数组，`^` 前缀 = 阻断，最后命中赢（见 src/shared/nav-rules.ts） */
    navigationRules?: string[] | null
    sandbox?: boolean
  }

  /** 子 webview（guest）：Electrobun 的 `BrowserView`（旧壳 `add_child` 的等价物） */
  export interface BrowserViewOptions {
    url?: string | null
    html?: string | null
    preload?: string | null
    renderer?: 'native' | 'cef'
    partition?: string | null
    frame?: { x: number; y: number; width: number; height: number }
    windowId?: number
    hostWebviewId?: number
    autoResize?: boolean
    navigationRules?: string | null
    /** true＝不受信内容：不开 RPC，只保留事件 */
    sandbox?: boolean
  }

  export class BrowserView {
    constructor(options?: BrowserViewOptions)
    readonly id: number
    loadURL(url: string): void
    executeJavascript(js: string): void
    remove(): void
    on(event: string, handler: (event: unknown) => void): void
  }

  export class BrowserWindow {
    constructor(options: WindowOptions)
    /** 窗口 id（原生核里的窗口句柄号；子视图要它） */
    readonly id: number
    /** 宿主 webview id（子视图的 hostWebviewId 用它） */
    readonly webviewId: number
    close(): void
    on(event: string, handler: (...args: unknown[]) => void): void
    /** 窗口的 webview（重载页面、执行脚本） */
    readonly webview?: {
      url: string
      loadURL(url: string): void
      executeJavascript(js: string): void
    }
    setWindowButtonPosition(x: number, y: number): void
    /** 窗口带到前台（单实例激活用）：恢复最小化 / 显示 / 抢焦点 */
    show(): void
    activate(): void
    focus(): void
    unminimize(): void
    hide(): void
    isVisible(): boolean
    minimize(): void
    isMinimized(): boolean
    setAlwaysOnTop(alwaysOnTop: boolean): void
    setFrame(x: number, y: number, width: number, height: number): void
    getFrame(): { x: number; y: number; width: number; height: number }
    isFullScreen(): boolean
    setFullScreen(fullScreen: boolean): void
    maximize(): void
    isMaximized(): boolean
    unmaximize(): void
    setTitle(title: string): void
    center(): void
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
    showNotification?(options: { title: string; body?: string; subtitle?: string; silent?: boolean }): void
    /** 系统浏览器 / 默认应用程序打开外链（FFI，成功返 true） */
    openExternal(url: string): boolean
    /** 原生文件选择器（返回绝对路径数组；Electrobun `Utils.openFileDialog`） */
    openFileDialog(options: {
      startingFolder?: string
      allowedFileTypes?: string
      canChooseFiles?: boolean
      canChooseDirectory?: boolean
      allowsMultipleSelection?: boolean
    }): Promise<string[]>
    clipboardWriteText(text: string): void
  }

  export interface TrayOptions {
    title?: string
    /** 图标文件路径（views:// 或绝对路径） */
    image?: string
    /** macOS 模板图（跟随亮/暗色自动反色） */
    template?: boolean
    width?: number
    height?: number
  }

  export class Tray {
    constructor(options?: TrayOptions)
    readonly id: number
    /** 原生层没建成时为 false（此时 setMenu 是空操作） */
    readonly visible: boolean
    setTitle(title: string): void
    setImage(image: string): void
    setMenu(menu: unknown[]): void
    setVisible(visible: boolean): void
    getBounds(): { x: number; y: number; width: number; height: number }
    remove(): void
    on(name: 'tray-clicked', handler: (event: unknown) => void): void
  }

  export interface Display {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    workArea: { x: number; y: number; width: number; height: number }
    scaleFactor: number
    isPrimary: boolean
  }

  export const Screen: {
    getPrimaryDisplay(): Display
    getAllDisplays(): Display[]
  }

  /** 应用级事件（reopen = Dock 图标被点；beforeQuit 可接 response.allow=false 否决） */
  export const app: {
    on(name: string, handler: (payload: unknown) => void): () => void
    quit(): void
  }

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
