// 平台防休眠断言（旧壳 `desktop/src-tauri/src/power/mod.rs` 的等价物，规格第 6 条「防休眠自写」）。
//
// 结构照搬旧壳：**纯裁决**（`src/shared/power-arbiter.ts`）+ 常驻 tick 循环，
// tick 是唯一调用平台断言的地方——Windows 的 `SetThreadExecutionState` 是**线程级**的，
// 断言必须与调用它的线程同生共死；macOS 的断言随进程退出自动释放。
//
// 平台实现：
//   · macOS：`caffeinate -i -w <壳 pid>`（`-i` = PreventUserIdleSystemSleep，即旧壳的
//     `IOPMAssertionCreateWithName("PreventUserIdleSystemSleep")`；`-w` 让断言在壳消失时
//     自动收摊，不必依赖我们的清理路径跑完）。释放 = 杀掉这个子进程。
//   · Windows：`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` / 清位
//     `ES_CONTINUOUS`（经 bun:ffi 调 kernel32）。**未在 Windows 实测**——留给 Windows CI。
//   · Linux：旧壳同样没有实现（`power/mod.rs` 只覆盖 macOS/Windows），这里只留一次日志。

import { dlopen, FFIType } from 'bun:ffi'
import type { Arbiter } from '../shared/power-arbiter.ts'
import { LEASE_STALE_MS } from '../shared/power-arbiter.ts'

/** tick 周期：开关/忙状态变化到断言落地的最坏延迟（旧壳同值）。 */
export const TICK_MS = 1_000

/** 断言名（macOS 进程名/Windows 无对应物，仅用于日志）。 */
export const ASSERTION_NAME = 'dsh-desktop-tauriapp: session running'

/** Windows 的 `SetThreadExecutionState` 位。 */
export const ES_CONTINUOUS = 0x8000_0000
export const ES_SYSTEM_REQUIRED = 0x0000_0001

/** Windows 断言：可注入（macOS 上只能靠类型与日志保真，Windows CI 上真跑）。 */
export type WindowsAssert = (flags: number) => boolean

export interface AwakeChild {
  pid: number
  kill: () => void
}

export interface KeepAwakeOptions {
  arbiter: Arbiter
  platform?: NodeJS.Platform
  log?: (line: string) => void
  tickMs?: number
  /** 壳自己的 pid（macOS `caffeinate -w` 用；缺省 `process.pid`）。 */
  pid?: number
  /** 起断言进程（测试注入；缺省 `Bun.spawn`）。 */
  spawnCommand?: (command: string[]) => AwakeChild
  /** Windows 断言（测试注入；缺省懒加载 bun:ffi）。 */
  setThreadExecutionState?: WindowsAssert
  /** 定时器注入（测试用假时钟）。 */
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
  now?: () => number
}

export interface KeepAwake {
  start: () => void
  stop: () => void
  /** 走一次裁决并落地（返回本次 tick 后的持有状态；测试直接调它）。 */
  tick: () => boolean
  isHolding: () => boolean
  arbiter: Arbiter
}

function defaultSpawn(command: string[]): AwakeChild {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  return { pid: child.pid, kill: (): void => void child.kill() }
}

let windowsSymbol: ((flags: number) => number) | null | undefined

function defaultWindowsAssert(): WindowsAssert {
  // 懒加载：dlopen 只在真调用的平台上发生（非 Windows 上 kernel32 必失败）。
  if (windowsSymbol === undefined) {
    try {
      const lib = dlopen('kernel32.dll', {
        SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
      })
      windowsSymbol = (flags: number): number => lib.symbols.SetThreadExecutionState(flags)
    } catch {
      windowsSymbol = null
    }
  }
  const symbol = windowsSymbol
  if (symbol === null) return (): boolean => false
  return (flags: number): boolean => symbol(flags) !== 0
}

/**
 * 创建防休眠循环：`start()` 起 tick（幂等），`stop()` 收摊并把断言释放掉。
 * 关闭开关或忙实例清零时，下一次 tick 就把断言放掉（最坏 1s 延迟，与旧壳一致）。
 */
export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const arbiter = options.arbiter
  const platform = options.platform ?? process.platform
  const log = options.log ?? ((): void => {})
  const tickMs = options.tickMs ?? TICK_MS
  const pid = options.pid ?? process.pid
  const now = options.now ?? ((): number => Date.now())
  const spawnCommand = options.spawnCommand ?? defaultSpawn
  const setIntervalFn =
    options.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>))

  let child: AwakeChild | null = null
  let windowsHeld = false
  let timer: unknown = null
  let warnedPlatform = false
  let lastStale: string[] = []

  const applyWindows = (hold: boolean): void => {
    if (platform !== 'win32') return
    const assert = options.setThreadExecutionState ?? defaultWindowsAssert()
    const flags = hold ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS
    const ok = assert(flags)
    if (!ok) log('[keepawake] SetThreadExecutionState 失败（Windows 上未实测过这条路径）')
  }

  const hold = (): void => {
    if (platform === 'darwin') {
      if (child !== null) return
      // `-i` 只挡系统空闲休眠；`-w <pid>` 让断言随壳进程消失自动释放。
      child = spawnCommand(['caffeinate', '-i', '-w', String(pid)])
      log(`[keepawake] 持有断言（${ASSERTION_NAME}）：caffeinate pid = ${String(child.pid)}`)
      return
    }
    if (platform === 'win32') {
      windowsHeld = true
      applyWindows(true)
      log(`[keepawake] 持有断言（${ASSERTION_NAME}）：SetThreadExecutionState`)
      return
    }
    if (!warnedPlatform) {
      warnedPlatform = true
      log(`[keepawake] 本平台（${platform}）暂无防休眠实现——旧壳同样只覆盖 macOS/Windows`)
    }
  }

  const release = (): void => {
    if (child !== null) {
      const dying = child
      child = null
      try {
        dying.kill()
      } catch {}
      log('[keepawake] 释放断言')
    }
    if (windowsHeld) {
      windowsHeld = false
      applyWindows(false)
    }
  }

  const tick = (): boolean => {
    const desired = arbiter.shouldHold()
    const holding = child !== null || windowsHeld
    if (desired !== holding) {
      if (desired) hold()
      else release()
    }
    const stale = arbiter.stale(now(), LEASE_STALE_MS)
    if (stale.join(',') !== lastStale.join(',')) {
      lastStale = stale
      if (stale.length > 0) {
        log(`[keepawake] 租约陈旧（心跳 ${String(LEASE_STALE_MS / 1000)}s 未到，仍按旧壳口径继续持有）：${stale.join('、')}`)
      }
    }
    return child !== null || windowsHeld
  }

  return {
    start: (): void => {
      if (timer !== null) return
      timer = setIntervalFn(() => {
        tick()
      }, tickMs)
      tick()
    },
    stop: (): void => {
      if (timer !== null) {
        clearIntervalFn(timer)
        timer = null
      }
      release()
    },
    tick,
    isHolding: (): boolean => child !== null || windowsHeld,
    arbiter,
  }
}
