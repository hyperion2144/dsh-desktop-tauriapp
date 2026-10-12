/**
 * macOS 通知原生桥的 FFI 封装（旧壳 `desktop/src-tauri/src/network/notify_un.rs` 的等价物）。
 *
 * 为什么不用 Electrobun 的 `Utils.showNotification` 一把梭：它只负责投递，**拿不到授权状态**，
 * 也不能主动申请；面板上的「已授权」此前是写死的（维护者一眼看穿）。这里直接 dlopen 我们自己
 * 编的 `libdsh-notify.dylib`（源码 `native/notify_un.m`，随包放 `runtime/`），在**本进程**里调
 * UNUserNotificationCenter：状态码用整数原子量，JS 侧只做无阻塞读取，不需要跨线程回调。
 *
 * 安全性：非 macOS、找不到动态库、dlopen 失败都退化成 `available: false`，调用方继续走
 * Electrobun 的原生投递（dev 下裸进程没有 bundle 身份，UN 会直接崩，所以**只有确认可用才调**）。
 */
import { FFIType, dlopen, ptr } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { permissionFromCode, type NotifyPermission } from '../shared/notify-permission.ts'

export const NOTIFY_LIB_NAME = 'libdsh-notify.dylib'

/** dlopen 出来的符号表（类型手写，bun:ffi 的泛型推不出具体签名）。 */
interface NotifySymbols {
  dsh_un_start: () => void
  dsh_un_status: () => number
  dsh_un_request: () => void
  dsh_un_post: (title: number, body: number, sound: number) => number
  dsh_un_last_error: () => number
}

export interface NativeNotify {
  /** 动态库加载成功且平台是 darwin：只有 true 时才允许调 UN。 */
  readonly available: boolean
  /** 库路径（诊断日志用；不可用时为 null）。 */
  readonly libPath: string | null
  /** 幂等初始化：刷一次状态，未决定就顺手申请（旧壳 setup 阶段的行为）。 */
  start(): void
  /** 只读当前状态（不发任何系统调用）。 */
  status(): NotifyPermission
  /** 主动申请授权（异步，结果由后续 status() 看到）。 */
  request(): NotifyPermission
  /** 投递一条通知；返回是否已排进原生队列。 */
  post(input: { title: string; body: string; sound: boolean }): boolean
  /** 最近一次原生错误码（0 = 无；诊断用）。 */
  lastError(): number
}

/** 找动态库：环境变量 > 打包后的 Resources/runtime > 可执行体同级 > 仓库 native/。 */
export function resolveNotifyLib(input: {
  env?: Record<string, string | undefined>
  execPath?: string
  resourcesDir?: string | null
  repoRoot?: string | null
  exists?: (path: string) => boolean
}): string | null {
  const env = input.env ?? {}
  const exists = input.exists ?? existsSync
  const candidates: string[] = []
  const override = env.DSH_SHELL_NOTIFY_LIB
  if (override !== undefined && override !== '') candidates.push(override)
  if (input.resourcesDir !== null && input.resourcesDir !== undefined) {
    candidates.push(join(input.resourcesDir, 'runtime', NOTIFY_LIB_NAME))
  }
  if (input.execPath !== undefined && input.execPath !== '') {
    // 打包/dev：<App>.app/Contents/MacOS/<exec> → build.copy 落在 Contents/Resources/app/runtime/…
    // （Electrobun 的包内根就是 Resources/app；早先只写 Resources/runtime 是错的，实机发现找不到库）
    const contents = join(dirname(input.execPath), '..')
    candidates.push(join(contents, 'Resources', 'app', 'runtime', NOTIFY_LIB_NAME))
    candidates.push(join(contents, 'Resources', 'runtime', NOTIFY_LIB_NAME))
  }
  // 开发态：库就在仓内 `desktop-electrobun/native/`（打包后仓库不在身边，靠上面的 execPath 候选）
  candidates.push(join(import.meta.dir, '..', '..', 'native', NOTIFY_LIB_NAME))
  if (input.repoRoot !== null && input.repoRoot !== undefined) {
    candidates.push(join(input.repoRoot, 'native', NOTIFY_LIB_NAME))
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

const UNKNOWN_BRIDGE = (log: (line: string) => void, reason: string): NativeNotify => {
  log(`[notify-un] 原生通知桥不可用：${reason}（通知仍走 Electrobun 原生投递）`)
  return {
    available: false,
    libPath: null,
    start: () => {},
    status: () => 'unavailable',
    request: () => 'unavailable',
    post: () => false,
    lastError: () => 0,
  }
}

export interface NativeNotifyOptions {
  log?: (line: string) => void
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  libPath?: string | null
  resourcesDir?: string | null
  repoRoot?: string | null
  execPath?: string
}

/** `.app/Contents/MacOS/…` = 由 LaunchServices 起的应用进程（才有 CFBundleIdentifier）。 */
export function hasBundleIdentity(execPath: string): boolean {
  return /\.app\/Contents\/MacOS\//.test(execPath)
}

export function createNativeNotify(options: NativeNotifyOptions = {}): NativeNotify {
  const log = options.log ?? ((): void => {})
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return UNKNOWN_BRIDGE(log, `平台 ${platform} 没有 UN 桥`)
  const execPath = options.execPath ?? process.execPath
  // 裸 bun（CI / 黑盒测试 / `bun run`）没有 CFBundleIdentifier：这时调 UN 会让 Bun 直接 panic。
  // 旧壳 `notify_un.rs` 写明「仅打包 .app 可用」，这里把那条约束前移到 JS 侧（dylib 里也有一道）。
  if (!hasBundleIdentity(execPath)) {
    return UNKNOWN_BRIDGE(log, `当前进程没有 .app 身份（${execPath}），UN 桥在裸进程里会让 Bun 崩`)
  }

  const libPath =
    options.libPath ??
    resolveNotifyLib({
      env: options.env ?? process.env,
      execPath,
      resourcesDir: options.resourcesDir ?? null,
      repoRoot: options.repoRoot ?? null,
    })
  if (libPath === null) return UNKNOWN_BRIDGE(log, `没找到 ${NOTIFY_LIB_NAME}`)

  let lib: { symbols: NotifySymbols }
  try {
    lib = dlopen(libPath, {
      dsh_un_start: { args: [], returns: FFIType.void },
      dsh_un_status: { args: [], returns: FFIType.i32 },
      dsh_un_request: { args: [], returns: FFIType.void },
      dsh_un_post: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      dsh_un_last_error: { args: [], returns: FFIType.i32 },
    }) as unknown as { symbols: NotifySymbols }
  } catch (error) {
    return UNKNOWN_BRIDGE(log, `dlopen 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const keepAlive: Buffer[] = []
  const cstring = (value: string): number => {
    const buffer = Buffer.from(`${value}\u0000`)
    keepAlive.push(buffer)
    return Number(ptr(buffer))
  }

  return {
    available: true,
    libPath,
    start: () => {
      try {
        lib.symbols.dsh_un_start()
      } catch (error) {
        log(`[notify-un] 初始化失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    status: () => {
      try {
        return permissionFromCode(Number(lib.symbols.dsh_un_status()))
      } catch {
        return 'unavailable'
      }
    },
    request: () => {
      try {
        lib.symbols.dsh_un_request()
      } catch (error) {
        log(`[notify-un] 申请授权失败：${error instanceof Error ? error.message : String(error)}`)
        return 'unavailable'
      }
      return permissionFromCode(Number(lib.symbols.dsh_un_status()))
    },
    post: (input) => {
      try {
        const queued = Number(lib.symbols.dsh_un_post(cstring(input.title), cstring(input.body), input.sound ? 1 : 0))
        // 上一批的缓冲区可以丢了（原生侧已经 strdup 过）
        keepAlive.length = 0
        return queued === 1
      } catch (error) {
        log(`[notify-un] 投递失败：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    lastError: () => {
      try {
        return Number(lib.symbols.dsh_un_last_error())
      } catch {
        return 0
      }
    },
  }
}
