// 宿主守护器：宿主异常退出（崩溃、被 OOM 杀、被外部 kill）时按退避策略重启，
// 别让页面永远停在「转发失败」。
//
// 边界：
//   - 只在壳还活着、且不是我们主动停的时候重启（stopping 由调用方判断）
//   - 崩溃循环要挡住：窗口期内超过 maxRestarts 次就放弃，交给调用方提示用户
//   - 退避：base × 2^n，封顶 maxDelayMs
//
// 纯策略与记账分开，便于单测（缝 ②）。

export interface RestartPolicy {
  /** 窗口期内允许的重启次数上限（超过视为崩溃循环） */
  maxRestarts: number
  /** 计数窗口 */
  windowMs: number
  /** 首次退避 */
  baseDelayMs: number
  /** 退避上限 */
  maxDelayMs: number
}

export const SUPERVISOR_POLICY: RestartPolicy = {
  maxRestarts: 5,
  windowMs: 10 * 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
}

export interface RestartDecision {
  restart: boolean
  delayMs: number
  reason: string
}

/** 纯策略：给定历史重启时刻（毫秒）与现在，决定是否重启、等多久。 */
export function nextRestart(
  history: readonly number[],
  now: number,
  policy: RestartPolicy = SUPERVISOR_POLICY,
): RestartDecision {
  const recent = history.filter((at) => now - at < policy.windowMs)
  if (recent.length >= policy.maxRestarts) {
    return {
      restart: false,
      delayMs: 0,
      reason: `窗口期（${String(Math.round(policy.windowMs / 1000))}s）内已重启 ${String(recent.length)} 次，上限 ${String(policy.maxRestarts)}——停止守护`,
    }
  }
  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** recent.length)
  return { restart: true, delayMs, reason: `第 ${String(recent.length + 1)} 次重启，退避 ${String(delayMs)}ms` }
}

export interface RestartLedger {
  history: number[]
  record: (now: number) => void
  reset: () => void
  decide: (now: number) => RestartDecision
}

export function createRestartLedger(policy: RestartPolicy = SUPERVISOR_POLICY): RestartLedger {
  const history: number[] = []
  return {
    history,
    record: (now: number) => {
      history.push(now)
    },
    reset: () => {
      history.length = 0
    },
    decide: (now: number) => nextRestart(history, now, policy),
  }
}
