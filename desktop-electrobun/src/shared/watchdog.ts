// D2：守护器纯逻辑（旧壳 lib.rs 守护器循环的等价物）。
// 语义（防误杀/防抖动循环，照旧壳注释）：
// - 健康 = TCP 连接成功；「运行中」连不上一次 = 服务异常，立即分流：
//   远程/外部实例只提示不代拉，本地拉起的马上自愈（无等待闸门）；
// - 自愈每轮 3 次封顶，连续健康 ≥2 分钟（24 tick）才重置计数（防无限重启循环）；
// - 同类提示 5 分钟节流（自愈/放弃的通知不节流，照旧壳）。

export const WATCHDOG_INTERVAL_MS = 5_000
export const WATCHDOG_HEALTHY_RESET_TICKS = 24
export const WATCHDOG_MAX_HEALS = 3
export const WATCHDOG_NOTIFY_THROTTLE_MS = 300_000

export interface WatchdogState {
  healthyStreak: number
  epochFailures: number
  lastNotifyAt: number
}

export function createWatchdogState(): WatchdogState {
  return { healthyStreak: 0, epochFailures: 0, lastNotifyAt: 0 }
}

export type WatchdogVerdict =
  | { kind: 'healthy'; reset: boolean }
  | { kind: 'remote-down'; notify: boolean; verbose: string }
  | { kind: 'external-down'; notify: boolean }
  | { kind: 'heal'; attempt: number }
  | { kind: 'gave-up' }

/** 单次 tick 的裁决。spawned = 本壳自己拉起的实例（compat 复用外部实例时为 false）。 */
export function tickWatchdog(
  state: WatchdogState,
  input: { up: boolean; spawned: boolean; remote: boolean; now: number },
): WatchdogVerdict {
  if (input.up) {
    state.healthyStreak += 1
    if (state.healthyStreak >= WATCHDOG_HEALTHY_RESET_TICKS && state.epochFailures > 0) {
      state.epochFailures = 0
      return { kind: 'healthy', reset: true }
    }
    return { kind: 'healthy', reset: false }
  }
  state.healthyStreak = 0
  const throttled = input.now - state.lastNotifyAt >= WATCHDOG_NOTIFY_THROTTLE_MS
  if (input.remote) {
    if (throttled) state.lastNotifyAt = input.now
    return { kind: 'remote-down', notify: throttled, verbose: '远程 dsh 连接失败' }
  }
  if (!input.spawned) {
    if (throttled) state.lastNotifyAt = input.now
    return { kind: 'external-down', notify: throttled }
  }
  state.epochFailures += 1
  if (state.epochFailures >= WATCHDOG_MAX_HEALS) {
    return { kind: 'gave-up' }
  }
  return { kind: 'heal', attempt: state.epochFailures }
}
