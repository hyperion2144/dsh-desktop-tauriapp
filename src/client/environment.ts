/** Desktop renderer modes accepted from the desktop-owned page URL. */
export type DesktopClientMode = 'compatibility' | 'advanced'

/** Host platforms whose native chrome has a desktop presentation. */
export type DesktopClientPlatform = 'darwin' | 'win32' | 'linux'

/** Validated renderer environment supplied by the desktop Host (Tauri shell). */
export interface DesktopClientEnvironment {
  /** Active shell mode for this window lifetime. */
  mode: DesktopClientMode
  /** Host platform used for native spacing and drag regions. */
  platform: DesktopClientPlatform
}

const MODES = new Set<DesktopClientMode>(['compatibility', 'advanced'])
const PLATFORMS = new Set<DesktopClientPlatform>(['darwin', 'win32', 'linux'])

/**
 * Validate the desktop-owned query marker before any desktop client effects run.
 * @param search - URL search string, including or omitting the leading question mark.
 * @returns the validated desktop renderer environment, or undefined outside the desktop shell.
 */
export function parseDesktopClientEnvironment(search: string): DesktopClientEnvironment | undefined {
  const params = new URLSearchParams(search)
  const mode = params.get('dsh-desktop-tauriapp-mode')
  const platform = params.get('dsh-desktop-tauriapp-platform')
  if (mode === null && platform === null) return undefined
  if (!MODES.has(mode as DesktopClientMode)) {
    throw new Error(`dsh-desktop-tauriapp: invalid or missing dsh-desktop-tauriapp-mode ${JSON.stringify(mode)}`)
  }
  if (!PLATFORMS.has(platform as DesktopClientPlatform)) {
    throw new Error(`dsh-desktop-tauriapp: invalid or missing dsh-desktop-tauriapp-platform ${JSON.stringify(platform)}`)
  }
  return { mode: mode as DesktopClientMode, platform: platform as DesktopClientPlatform }
}

/**
 * 从桌面壳查询渲染环境（IPC）。替代 URL 标记：token 交换的 303 重定向会剥掉
 * 全部 query 参数，URL 标记无法与 token 同跳；而模式/平台本就是壳的运行状态，
 * 由壳直接下发最可靠。纯浏览器（无 Tauri IPC）或查询失败时返回 undefined，
 * client 据此不激活桌面 chrome。
 */
export async function requestDesktopClientEnvironment(): Promise<DesktopClientEnvironment | undefined> {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> } }
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown, opts?: unknown) => Promise<unknown> }
  }
  let raw: unknown
  try {
    if (w.__TAURI_INTERNALS__?.invoke) {
      raw = await w.__TAURI_INTERNALS__.invoke('get_desktop_client_environment', undefined)
    } else if (w.__TAURI__?.core?.invoke) {
      raw = await w.__TAURI__.core.invoke('get_desktop_client_environment', {})
    } else {
      return undefined
    }
  } catch {
    return undefined
  }
  const env = raw as Partial<DesktopClientEnvironment> | null | undefined
  if (!env) return undefined
  if (env.mode !== 'compatibility' && env.mode !== 'advanced') return undefined
  if (env.platform !== 'darwin' && env.platform !== 'win32' && env.platform !== 'linux') return undefined
  return { mode: env.mode, platform: env.platform }
}
