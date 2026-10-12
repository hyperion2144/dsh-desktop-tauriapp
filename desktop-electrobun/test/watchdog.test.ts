import { describe, expect, test } from 'bun:test'
import {
  createWatchdogState,
  tickWatchdog,
  WATCHDOG_HEALTHY_RESET_TICKS,
  WATCHDOG_MAX_HEALS,
} from '../src/shared/watchdog.ts'

const T0 = 1_000_000

describe('tickWatchdog（D2，旧壳守护器语义）', () => {
  test('健康：累计到 24 tick 重置自愈计数（防抖动循环）', () => {
    const s = createWatchdogState()
    s.epochFailures = 2
    let reset = false
    for (let i = 0; i < WATCHDOG_HEALTHY_RESET_TICKS; i += 1) {
      const verdict = tickWatchdog(s, { up: true, spawned: true, remote: false, now: T0 + i })
      if (verdict.kind === 'healthy' && verdict.reset) reset = true
    }
    expect(reset).toBe(true)
    expect(s.epochFailures).toBe(0)
  })
  test('本地实例连不上：自愈 1、2 次放行，第 3 次封顶不再自愈', () => {
    const s = createWatchdogState()
    const v1 = tickWatchdog(s, { up: false, spawned: true, remote: false, now: T0 })
    const v2 = tickWatchdog(s, { up: false, spawned: true, remote: false, now: T0 + 1 })
    const v3 = tickWatchdog(s, { up: false, spawned: true, remote: false, now: T0 + 2 })
    expect(v1).toEqual({ kind: 'heal', attempt: 1 })
    expect(v2).toEqual({ kind: 'heal', attempt: 2 })
    expect(v3).toEqual({ kind: 'gave-up' })
    expect(WATCHDOG_MAX_HEALS).toBe(3)
  })
  test('远程模式：只提示不代拉，同类提示 5 分钟节流', () => {
    const s = createWatchdogState()
    const first = tickWatchdog(s, { up: false, spawned: true, remote: true, now: T0 })
    const soon = tickWatchdog(s, { up: false, spawned: true, remote: true, now: T0 + 1_000 })
    const later = tickWatchdog(s, { up: false, spawned: true, remote: true, now: T0 + 301_000 })
    expect(first).toEqual({ kind: 'remote-down', notify: true, verbose: '远程 dsh 连接失败' })
    expect(soon).toMatchObject({ kind: 'remote-down', notify: false })
    expect(later).toMatchObject({ kind: 'remote-down', notify: true })
    expect(s.epochFailures).toBe(0)
  })
  test('复用外部实例：只提示，不自愈', () => {
    const s = createWatchdogState()
    const verdict = tickWatchdog(s, { up: false, spawned: false, remote: false, now: T0 })
    expect(verdict).toEqual({ kind: 'external-down', notify: true })
    expect(s.epochFailures).toBe(0)
  })
  test('一次失败打断健康连击（防把抖动算成持续健康）', () => {
    const s = createWatchdogState()
    s.epochFailures = 1
    for (let i = 0; i < 20; i += 1) tickWatchdog(s, { up: true, spawned: true, remote: false, now: T0 + i })
    tickWatchdog(s, { up: false, spawned: true, remote: false, now: T0 + 100 })
    for (let i = 0; i < 10; i += 1) tickWatchdog(s, { up: true, spawned: true, remote: false, now: T0 + 200 + i })
    expect(s.epochFailures).toBe(2)
  })
})
