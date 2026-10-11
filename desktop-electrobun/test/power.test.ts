// 防休眠与通知口（缝 ② 纯逻辑 + 真 HTTP/真进程）。
//
// 守的是旧壳 `power/mod.rs` + `network/notify.rs` 的语义（#186 用户拍板口径）：
//   只挡系统空闲休眠；「会话在跑」由宿主插件的 busy-state 上报决定，等审批/等回答不算；
//   心跳超时**不释放**（误释放比多持更糟）——这些是行为契约，不是实现细节。
// 平台断言用注入的假 spawn 断言调用形状；macOS 上另有一例真 `caffeinate` 落地验证。

import { describe, expect, test } from 'bun:test'
import { createKeepAwake, ES_CONTINUOUS, ES_SYSTEM_REQUIRED, TICK_MS } from '../src/bun/keep-awake.ts'
import {
  bearerToken,
  classifyNotify,
  MAX_NOTIFY_BYTES,
  startNotifyServer,
} from '../src/bun/notify-server.ts'
import { buildChildEnv } from '../src/shared/child-env.ts'
import {
  BUSY_HEARTBEAT_MS,
  createArbiter,
  LEASE_STALE_MS,
  normalizeProfileName,
  parseBusyReport,
  UNKNOWN_PROFILE,
} from '../src/shared/power-arbiter.ts'

describe('power-arbiter（纯裁决）', () => {
  test('缺省开关为开；没有忙实例就不持有', () => {
    const arbiter = createArbiter()
    expect(arbiter.isEnabled()).toBe(true)
    expect(arbiter.shouldHold()).toBe(false)
    expect(arbiter.profiles()).toEqual([])
  })

  test('开关关掉时，忙实例再多也不持有（用户拍板：设置优先）', () => {
    const arbiter = createArbiter({ enabled: false })
    arbiter.setBusy('desktop', true, 1_000)
    expect(arbiter.profiles()).toEqual(['desktop'])
    expect(arbiter.shouldHold()).toBe(false)
    arbiter.setEnabled(true)
    expect(arbiter.shouldHold()).toBe(true)
  })

  test('setBusy 只在租约集合真的变化时返回 true（日志据此去重）', () => {
    const arbiter = createArbiter()
    expect(arbiter.setBusy('desktop', true, 1_000)).toBe(true)
    expect(arbiter.setBusy('desktop', true, 11_000)).toBe(false)
    expect(arbiter.setBusy('desktop', false, 12_000)).toBe(true)
    expect(arbiter.setBusy('desktop', false, 13_000)).toBe(false)
    expect(arbiter.shouldHold()).toBe(false)
  })

  test('多 profile：任一在跑就持有；forget 摘掉单个', () => {
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, 1_000)
    arbiter.setBusy('web', true, 1_000)
    expect(arbiter.profiles()).toEqual(['desktop', 'web'])
    expect(arbiter.forget('desktop')).toBe(true)
    expect(arbiter.shouldHold()).toBe(true)
    expect(arbiter.forget('desktop')).toBe(false)
    arbiter.clear()
    expect(arbiter.shouldHold()).toBe(false)
  })

  test('缺 profile 名落到 UNKNOWN_PROFILE（旧壳同义）', () => {
    expect(normalizeProfileName(undefined)).toBe(UNKNOWN_PROFILE)
    expect(normalizeProfileName('   ')).toBe(UNKNOWN_PROFILE)
    expect(normalizeProfileName(' desktop ')).toBe('desktop')
    const arbiter = createArbiter()
    arbiter.setBusy('', true, 1_000)
    expect(arbiter.profiles()).toEqual([UNKNOWN_PROFILE])
  })

  test('心跳刷新租约；陈旧只诊断、不释放（#185 补充第 6 条）', () => {
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, 1_000)
    // 心跳 10s 一次，60s 内不算陈旧
    arbiter.setBusy('desktop', true, 1_000 + BUSY_HEARTBEAT_MS)
    expect(arbiter.stale(1_000 + LEASE_STALE_MS)).toEqual([])
    // 边界取严：恰好 60s 就算陈旧
    expect(arbiter.stale(1_000 + BUSY_HEARTBEAT_MS + LEASE_STALE_MS)).toEqual(['desktop'])
    // 陈旧归陈旧，裁决不变
    expect(arbiter.shouldHold()).toBe(true)
  })
})

describe('busy-state 载荷解析', () => {
  test('只认 { type: "busy-state", busy: boolean }', () => {
    expect(parseBusyReport({ type: 'busy-state', profile: 'desktop', busy: true })).toEqual({
      profile: 'desktop',
      busy: true,
    })
    expect(parseBusyReport({ type: 'busy-state', busy: false })).toEqual({
      profile: UNKNOWN_PROFILE,
      busy: false,
    })
    expect(parseBusyReport({ type: 'busy-state' })).toBeNull()
    expect(parseBusyReport({ type: 'busy-state', busy: 'yes' })).toBeNull()
    expect(parseBusyReport({ type: 'task-complete', body: 'x' })).toBeNull()
    expect(parseBusyReport(null)).toBeNull()
    expect(parseBusyReport(['busy-state'])).toBeNull()
  })

  test('classifyNotify 把忙状态与通知分开（通知轮次接后者）', () => {
    expect(classifyNotify({ type: 'busy-state', profile: 'web', busy: true })).toEqual({
      kind: 'busy',
      profile: 'web',
      busy: true,
    })
    expect(classifyNotify({ type: 'task-complete', body: '任务已完成' })).toEqual({
      kind: 'notify',
      payload: { type: 'task-complete', body: '任务已完成' },
    })
    expect(classifyNotify({ type: 'dsh-approval' })).toEqual({
      kind: 'notify',
      payload: { type: 'dsh-approval', body: '' },
    })
    expect(classifyNotify({ type: 'nope' })).toEqual({ kind: 'unknown' })
    expect(classifyNotify('busy-state')).toEqual({ kind: 'unknown' })
  })

  test('Authorization 解析容忍大小写与空格，但只要 Bearer', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer   abc  ')).toBe('abc')
    expect(bearerToken('Basic abc')).toBe('')
    expect(bearerToken(null)).toBe('')
  })
})

describe('通知口（真 HTTP，缝 ①）', () => {
  test('令牌闸门：无 token 401、坏 token 401、方法不符 405、路径不符 404、坏 JSON 400', async () => {
    const seen: string[] = []
    const server = startNotifyServer({ onBusy: (profile, busy) => seen.push(`${profile}:${String(busy)}`) })
    const url = `${server.origin}/notify`
    try {
      expect((await fetch(url, { method: 'POST' })).status).toBe(401)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { authorization: 'Bearer wrong' },
            body: '{}',
          })
        ).status,
      ).toBe(401)
      expect(
        (
          await fetch(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${server.token}` },
          })
        ).status,
      ).toBe(405)
      expect((await fetch(`${server.origin}/other`)).status).toBe(404)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${server.token}` },
            body: '{oops',
          })
        ).status,
      ).toBe(400)
    } finally {
      server.stop()
    }
    expect(seen).toEqual([])
  })

  test('合法忙状态上报：204 且回调拿到 profile/busy；通知类走另一条回调', async () => {
    const busy: string[] = []
    const notes: string[] = []
    const server = startNotifyServer({
      onBusy: (profile, isBusy) => busy.push(`${profile}:${String(isBusy)}`),
      onNotify: (payload) => notes.push(`${payload.type}:${payload.body}`),
    })
    const post = (body: unknown): Promise<Response> =>
      fetch(`${server.origin}/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    try {
      expect((await post({ type: 'busy-state', profile: 'desktop', busy: true })).status).toBe(204)
      expect((await post({ type: 'busy-state', profile: 'desktop', busy: false })).status).toBe(204)
      expect((await post({ type: 'task-complete', body: '任务已完成' })).status).toBe(204)
      expect((await post({ type: 'unknown-type' })).status).toBe(204)
    } finally {
      server.stop()
    }
    expect(busy).toEqual(['desktop:true', 'desktop:false'])
    expect(notes).toEqual(['task-complete:任务已完成'])
  })

  test('载荷上限 64 KiB（超了 413，不打爆壳）', async () => {
    const server = startNotifyServer({})
    try {
      const huge = 'x'.repeat(MAX_NOTIFY_BYTES + 1)
      const response = await fetch(`${server.origin}/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'task-complete', body: huge }),
      })
      expect(response.status).toBe(413)
    } finally {
      server.stop()
    }
  })
})

describe('keep-awake（平台断言，注入假 spawn）', () => {
  interface FakeChild {
    pid: number
    killed: boolean
  }

  function fakeAwake(): { spawns: string[][]; children: FakeChild[]; spawnCommand: (command: string[]) => { pid: number; kill: () => void } } {
    const spawns: string[][] = []
    const children: FakeChild[] = []
    return {
      spawns,
      children,
      spawnCommand: (command: string[]) => {
        spawns.push(command)
        const child: FakeChild = { pid: 4_000 + spawns.length, killed: false }
        children.push(child)
        return { pid: child.pid, kill: (): void => void (child.killed = true) }
      },
    }
  }

  test('macOS：忙了才起 caffeinate（-i -w 壳 pid），闲了杀掉，重复 tick 不重复起', () => {
    const logs: string[] = []
    const arbiter = createArbiter()
    const fake = fakeAwake()
    const awake = createKeepAwake({
      arbiter,
      platform: 'darwin',
      pid: 9_999,
      log: (line) => logs.push(line),
      spawnCommand: fake.spawnCommand,
    })

    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toEqual([])

    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toEqual([['caffeinate', '-i', '-w', '9999']])
    expect(fake.children).toHaveLength(1)
    expect(fake.children[0]?.killed).toBe(false)

    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    expect(fake.children[0]?.killed).toBe(true)
    expect(logs.some((line) => line.includes('释放断言'))).toBe(true)
    expect(logs.some((line) => line.includes('持有断言'))).toBe(true)
  })

  test('开关关掉时不起断言；打开后下一次 tick 生效', () => {
    const arbiter = createArbiter({ enabled: false })
    const fake = fakeAwake()
    const awake = createKeepAwake({ arbiter, platform: 'darwin', pid: 1, spawnCommand: fake.spawnCommand })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toEqual([])
    arbiter.setEnabled(true)
    expect(awake.tick()).toBe(true)
    expect(fake.spawns).toHaveLength(1)
    awake.stop()
    expect(fake.children[0]?.killed).toBe(true)
  })

  test('start 幂等（只挂一个定时器），stop 释放断言并停表', () => {
    const ticks: Array<() => void> = []
    let cleared = 0
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, Date.now())
    const fake = fakeAwake()
    const awake = createKeepAwake({
      arbiter,
      platform: 'darwin',
      pid: 7,
      spawnCommand: fake.spawnCommand,
      setIntervalFn: (fn) => {
        ticks.push(fn)
        return ticks.length
      },
      clearIntervalFn: () => {
        cleared += 1
      },
    })
    awake.start()
    awake.start()
    expect(ticks).toHaveLength(1)
    expect(fake.spawns).toHaveLength(1)
    expect(TICK_MS).toBe(1_000)
    awake.stop()
    expect(cleared).toBe(1)
    expect(fake.children[0]?.killed).toBe(true)
  })

  test('Windows：注入的 SetThreadExecutionState 收到 ES_CONTINUOUS|ES_SYSTEM_REQUIRED，释放只留 ES_CONTINUOUS', () => {
    const flags: number[] = []
    const arbiter = createArbiter()
    const awake = createKeepAwake({
      arbiter,
      platform: 'win32',
      setThreadExecutionState: (value) => {
        flags.push(value)
        return true
      },
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(true)
    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    expect(flags).toEqual([ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS])
  })

  test('Linux：不动平台、只留一条说明日志（旧壳同样没实现）', () => {
    const logs: string[] = []
    const arbiter = createArbiter()
    const fake = fakeAwake()
    const awake = createKeepAwake({
      arbiter,
      platform: 'linux',
      log: (line) => logs.push(line),
      spawnCommand: fake.spawnCommand,
    })
    arbiter.setBusy('desktop', true, Date.now())
    expect(awake.tick()).toBe(false)
    expect(awake.tick()).toBe(false)
    expect(fake.spawns).toEqual([])
    expect(logs.filter((line) => line.includes('本平台'))).toHaveLength(1)
  })

  test('macOS 真进程：caffeinate 真的起来了，释放后真的没了', async () => {
    if (process.platform !== 'darwin') return
    const arbiter = createArbiter()
    arbiter.setBusy('desktop', true, Date.now())
    const awake = createKeepAwake({ arbiter, pid: process.pid })
    expect(awake.tick()).toBe(true)
    // 断言进程活着（signal 0 只探活）
    const listed = Bun.spawnSync(['pgrep', '-f', `caffeinate -i -w ${String(process.pid)}`])
    expect(new TextDecoder().decode(listed.stdout).trim().length).toBeGreaterThan(0)
    arbiter.setBusy('desktop', false, Date.now())
    expect(awake.tick()).toBe(false)
    await Bun.sleep(200)
    const after = Bun.spawnSync(['pgrep', '-f', `caffeinate -i -w ${String(process.pid)}`])
    expect(new TextDecoder().decode(after.stdout).trim()).toBe('')
  })
})

describe('子进程环境：通知口契约', () => {
  const base = { HOME: '/tmp/home' }

  test('给了通知口就注入三项（插件据此回报忙状态）', () => {
    const env = buildChildEnv({
      base,
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
      notify: { port: 51_234, token: 'tok-abc' },
    })
    expect(env.DSH_DESKTOP_NOTIFY_PORT).toBe('51234')
    expect(env.DSH_DESKTOP_NOTIFY_TOKEN).toBe('tok-abc')
    expect(env.DSH_DESKTOP_PROFILE).toBe('desktop')
  })

  test('没给通知口就不留残留（继承环境里同名的键也会被清掉）', () => {
    const env = buildChildEnv({
      base: { ...base, DSH_DESKTOP_NOTIFY_PORT: '1', DSH_DESKTOP_NOTIFY_TOKEN: 'x', DSH_DESKTOP_PROFILE: 'y' },
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
    })
    expect(env.DSH_DESKTOP_NOTIFY_PORT).toBeUndefined()
    expect(env.DSH_DESKTOP_NOTIFY_TOKEN).toBeUndefined()
    expect(env.DSH_DESKTOP_PROFILE).toBeUndefined()
  })

  test('端口为 0 或令牌为空视为没给（插件那边就是静默降级）', () => {
    const env = buildChildEnv({
      base,
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
      notify: { port: 0, token: 'tok' },
    })
    expect(env.DSH_DESKTOP_NOTIFY_PORT).toBeUndefined()
    const env2 = buildChildEnv({
      base,
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home/.dsh',
      notify: { port: 5_000, token: '' },
    })
    expect(env2.DSH_DESKTOP_NOTIFY_TOKEN).toBeUndefined()
  })
})
