/**
 * guest 的历史读控与几何：直接对 Electrobun 的原生核下 FFI。
 *
 * 为什么不用公开 API：`BrowserView` 暴露的方法里**没有** goBack/goForward/canGoBack/canGoForward，
 * 也**没有** frame/bounds setter（`frame` 只在构造与 `setOptions` 里赋值）。但原生核
 * `libElectrobunCore.dylib` 导出了这些符号（Electrobun 自己的 `<electrobun-webview>` 标签就是
 * 这么用的，见 `api/sdks/main/proc/native.ts` 的 `webviewTagCanGoBack/webviewTagGoBack/...` 与
 * `webviewTagResize`）：
 *
 *     webviewCanGoBack(u32) -> bool      webviewGoBack(u32) -> void
 *     webviewCanGoForward(u32) -> bool   webviewGoForward(u32) -> void
 *     webviewReload(u32) -> void         webviewSetHidden(u32, bool) -> void
 *     resizeWebview(u32, f64 x, f64 y, f64 w, f64 h, cstring masks) -> void
 *
 * 旧壳对应的是 `browser_guests/platform.rs`（macOS 走 objc2 msg_send 直调 WKWebView、
 * Windows 走 WebView2 COM）——那边是平台原生 API，这边是框架原生核，等价的活。
 *
 * 拿不到核时**不假装成功**：返回 `core: null` 并带上原因，调用方把几何/历史操作降级成一条日志
 * （guest 仍能创建与导航，只是按钮状态与跟随窗口尺寸失效）。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GuestRect } from '../shared/guest-policy.ts'

/** 原生核导出的方法子集（用到的就这些）。 */
export interface NativeWebviewCore {
  canGoBack(id: number): boolean
  canGoForward(id: number): boolean
  goBack(id: number): void
  goForward(id: number): void
  reload(id: number): void
  setHidden(id: number, hidden: boolean): void
  resize(id: number, rect: GuestRect): void
}

export interface NativeWebviewProbe {
  core: NativeWebviewCore | null
  libPath: string | null
  error: string | null
}

export interface NativeWebviewInput {
  /** 进程可执行文件（打包态是 `Contents/MacOS/launcher`，核就在同目录） */
  execPath?: string
  /** 模块目录（dev：源码在 src/bun 下，核在构建产物里） */
  importDir?: string
  env?: Record<string, string | undefined>
  exists?: (path: string) => boolean
}

/** 原生核的文件名（三平台）。 */
export function coreLibNames(platform: string): string[] {
  if (platform === 'win32') return ['ElectrobunCore.dll']
  if (platform === 'darwin') return ['libElectrobunCore.dylib']
  return ['libElectrobunCore.so']
}

/** 原生核的候选路径（顺序即优先级）。 */
export function coreLibCandidates(input: NativeWebviewInput, platform = process.platform): string[] {
  const env = input.env ?? {}
  const names = coreLibNames(platform)
  const candidates: string[] = []
  const override = env.DSH_SHELL_CORE_LIB
  if (typeof override === 'string' && override !== '') candidates.push(override)
  const execDir = input.execPath === undefined ? null : dirname(input.execPath)
  if (execDir !== null) {
    for (const name of names) candidates.push(join(execDir, name))
    // dev：`build/<env>-<os>-<arch>/<App>.app/Contents/MacOS/` 与 `Resources/`
    for (const name of names) candidates.push(join(execDir, '..', 'Resources', name))
  }
  if (input.importDir !== undefined) {
    for (const name of names) candidates.push(join(input.importDir, name))
    for (const name of names) candidates.push(join(input.importDir, '..', '..', name))
  }
  return candidates
}

/** 加载原生核；失败不抛（回 `core: null` + 原因）。 */
export async function loadNativeWebviewCore(input: NativeWebviewInput = {}): Promise<NativeWebviewProbe> {
  const exists = input.exists ?? existsSync
  const candidates = coreLibCandidates(input)
  const libPath = candidates.find((candidate) => exists(candidate)) ?? null
  if (libPath === null) {
    return { core: null, libPath: null, error: `找不到原生核（找过 ${candidates.length} 个路径）` }
  }
  try {
    const { dlopen, FFIType } = await import('bun:ffi')
    const lib = dlopen(libPath, {
      webviewCanGoBack: { args: [FFIType.u32], returns: FFIType.bool },
      webviewCanGoForward: { args: [FFIType.u32], returns: FFIType.bool },
      webviewGoBack: { args: [FFIType.u32], returns: FFIType.void },
      webviewGoForward: { args: [FFIType.u32], returns: FFIType.void },
      webviewReload: { args: [FFIType.u32], returns: FFIType.void },
      webviewSetHidden: { args: [FFIType.u32, FFIType.bool], returns: FFIType.void },
      resizeWebview: {
        args: [FFIType.u32, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.cstring],
        returns: FFIType.void,
      },
    })
    const symbols = lib.symbols as unknown as {
      webviewCanGoBack: (id: number) => boolean
      webviewCanGoForward: (id: number) => boolean
      webviewGoBack: (id: number) => void
      webviewGoForward: (id: number) => void
      webviewReload: (id: number) => void
      webviewSetHidden: (id: number, hidden: boolean) => void
      resizeWebview: (id: number, x: number, y: number, w: number, h: number, masks: string) => void
    }
    const core: NativeWebviewCore = {
      canGoBack: (id) => symbols.webviewCanGoBack(id) === true,
      canGoForward: (id) => symbols.webviewCanGoForward(id) === true,
      goBack: (id) => symbols.webviewGoBack(id),
      goForward: (id) => symbols.webviewGoForward(id),
      reload: (id) => symbols.webviewReload(id),
      setHidden: (id, hidden) => symbols.webviewSetHidden(id, hidden),
      resize: (id, rect) => symbols.resizeWebview(id, rect.x, rect.y, rect.width, rect.height, '[]'),
    }
    return { core, libPath, error: null }
  } catch (error) {
    return { core: null, libPath, error: error instanceof Error ? error.message : String(error) }
  }
}
