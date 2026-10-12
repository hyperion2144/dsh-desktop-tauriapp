// 防休眠裁决（#186 语义，规格第 6 条「防休眠自写」）：**纯逻辑**，不碰平台 API、不做 IO。
//
// 语义（旧壳 `desktop/src-tauri/src/power/mod.rs` 的用户拍板口径，逐条照搬）：
//   只阻止**系统空闲休眠**——屏幕该熄就熄、合盖不挡；
//   「会话在跑」由宿主插件经 `/notify` 上报的 `busy-state` 决定，
//   **等待审批 / 等待用户输入不算在跑**（DOM 探针是通用 spinner，20+ 处复用，不能当忙判据）。
//
// 裁决 = 用户开关（`settings.preventSleep`，缺省开）× 至少一个实例持有忙租约。
// 心跳超时**不作为释放条件**（熄屏/隐藏窗口时前端定时器是否被节流未证实，「误释放」比
// 「多持」更糟）——陈旧租约只用于诊断日志，间隔与旧壳一致（宿主心跳 10s，正常不会触发）。

/** 上报里没带 profile 名时的兜底键（正常路径由 `DSH_DESKTOP_PROFILE` 给出）。 */
export const UNKNOWN_PROFILE = 'default'

/** 租约「陈旧」只用于诊断的上报间隔（旧壳 `LEASE_STALE`）。 */
export const LEASE_STALE_MS = 60_000

/** 宿主插件的忙状态心跳间隔（壳侧只用于文档与诊断阈值）。 */
export const BUSY_HEARTBEAT_MS = 10_000

/** 一次忙状态上报（壳解析 `/notify` 载荷的结果）。 */
export interface BusyReport {
  profile: string
  busy: boolean
}

export interface Arbiter {
  /** 是否应持有平台断言：开关开着，且至少一个实例在跑。 */
  shouldHold: () => boolean
  isEnabled: () => boolean
  /** 设置开关（立即影响下一次裁决）。 */
  setEnabled: (enabled: boolean) => void
  /** 某实例的忙状态；返回租约集合是否真的变了（避免每秒重复打日志）。 */
  setBusy: (profile: string, busy: boolean, now: number) => boolean
  /** 实例停/重启/被销毁：摘掉它的租约（进程没了就不会再有上报）。 */
  forget: (profile: string) => boolean
  /** 全部摘掉（壳在重启宿主、退出时用）。 */
  clear: () => void
  /** 当前持租约的 profile（排序稳定，供日志与测试）。 */
  profiles: () => string[]
  /** 超过 `staleMs` 没收到心跳的实例（诊断用，不参与裁决）。 */
  stale: (now: number, staleMs?: number) => string[]
}

/** profile 名归一：空串/非字符串落到 `UNKNOWN_PROFILE`（旧壳 `UNKNOWN_PROFILE` 同义）。 */
export function normalizeProfileName(raw: unknown): string {
  if (typeof raw !== 'string') return UNKNOWN_PROFILE
  const trimmed = raw.trim()
  return trimmed === '' ? UNKNOWN_PROFILE : trimmed
}

/**
 * 解析 `/notify` 的忙状态载荷：`{ type: 'busy-state', profile, busy }`。
 * 只认这一个类型——通知类载荷（`task-complete` / `dsh-approval`）由通知轮次消费，
 * 这里返回 null 让调用方走「忽略」分支，避免把两件事混在一个函数里。
 */
export function parseBusyReport(payload: unknown): BusyReport | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.type !== 'busy-state') return null
  if (typeof record.busy !== 'boolean') return null
  return { profile: normalizeProfileName(record.profile), busy: record.busy }
}

export function createArbiter(options: { enabled?: boolean } = {}): Arbiter {
  let enabled = options.enabled ?? true
  const busy = new Map<string, number>()

  return {
    shouldHold: (): boolean => enabled && busy.size > 0,
    isEnabled: (): boolean => enabled,
    setEnabled: (next: boolean): void => {
      enabled = next
    },
    setBusy: (profile: string, next: boolean, now: number): boolean => {
      const key = normalizeProfileName(profile)
      if (next) {
        const changed = !busy.has(key)
        busy.set(key, now)
        return changed
      }
      return busy.delete(key)
    },
    forget: (profile: string): boolean => busy.delete(normalizeProfileName(profile)),
    clear: (): void => {
      busy.clear()
    },
    profiles: (): string[] => [...busy.keys()].sort(),
    stale: (now: number, staleMs: number = LEASE_STALE_MS): string[] =>
      [...busy.entries()]
        .filter(([, at]) => now - at >= staleMs)
        .map(([profile]) => profile)
        .sort(),
  }
}
