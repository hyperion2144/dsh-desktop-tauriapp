// 生命周期与进程守护（缝 ② 纯逻辑 + 真进程）。
//
// 这一组用例守的是实机 bug：壳退出/崩溃后 dsh 宿主变孤儿、一直占着会话，用户得手动 kill。
// 三层防线各有用例：
//   1. 子进程侧的父进程看门狗（runtime/parent-watch.mjs）——壳被 SIGKILL 也能收掉宿主
//   2. 壳侧的停止升级（host.ts：SIGTERM → 宽限期 → SIGKILL，并等它真退出）
//   3. 台账 + 启动清扫（host-registry.ts）——上一次壳留下的孤儿只能靠这个清

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHost } from '../src/bun/host.ts'
import {
  parseHostRecords,
  removeHostRecords,
  selectStaleHosts,
  sweepStaleHosts,
  upsertHostRecord,
  type HostRecord,
} from '../src/bun/host-registry.ts'
import { createRestartLedger, nextRestart, SUPERVISOR_POLICY } from '../src/bun/supervisor.ts'
import { buildChildEnv } from '../src/shared/child-env.ts'

const bunBin = process.execPath

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-life-'))
}

function record(hostPid: number, shellPid: number): HostRecord {
  return { hostPid, shellPid, profile: 'desktop', startedAt: '2026-10-11T00:00:00.000Z' }
}

describe('宿主台账与孤儿清扫', () => {
  test('解析容错：坏 JSON / 非数组 / 缺字段一律当空', () => {
    expect(parseHostRecords('not json')).toEqual([])
    expect(parseHostRecords('{"hostPid":1}')).toEqual([])
    expect(parseHostRecords('[{"hostPid":1,"shellPid":2}]')).toEqual([])
    expect(parseHostRecords(JSON.stringify([record(1, 2)]))).toEqual([record(1, 2)])
  })

  test('upsert 去重、remove 按宿主 pid 清', () => {
    const first = upsertHostRecord([], record(100, 5))
    const second = upsertHostRecord(first, record(101, 5))
    expect(second).toHaveLength(2)
    expect(upsertHostRecord(second, record(100, 5))).toHaveLength(2)
    expect(removeHostRecords(second, 100)).toEqual([record(101, 5)])
  })

  test('selectStaleHosts：都活着不动；宿主没了只清条目；壳没了算孤儿', () => {
    const aliveBoth = selectStaleHosts([record(10, 1)], () => true)
    expect(aliveBoth).toEqual([])

    const hostGone = selectStaleHosts([record(10, 1)], (pid) => pid === 1)
    expect(hostGone).toEqual([{ record: record(10, 1), reason: 'host-gone' }])

    const shellGone = selectStaleHosts([record(10, 1)], (pid) => pid === 10)
    expect(shellGone).toEqual([{ record: record(10, 1), reason: 'shell-gone' }])
  })

  test('sweepStaleHosts：杀孤儿、清过期、留别人的活口，并写回台账', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-hosts.json')
    const orphan = record(4242, 111) // 壳 111 已不在 ⇒ 孤儿，要杀
    const expired = record(4343, 222) // 宿主自己也死了 ⇒ 只清条目
    // 注意：宿主自己也死了的条目只清条目（没东西可杀）；能杀的是「宿主活着、壳没了」那种
    const other = record(4444, 333) // 另一个壳（333 活着）在用 ⇒ 留着
    writeFileSync(file, `${JSON.stringify([orphan, expired, other])}\n`)

    const killed: number[] = []
    const result = sweepStaleHosts({
      file,
      isAlive: (pid) => pid === 4242 || pid === 4444 || pid === 333,
      kill: (pid) => killed.push(pid),
    })

    expect(killed).toEqual([4242])
    expect(result.killed).toEqual([4242])
    expect(result.pruned).toEqual([4343])
    expect(result.remaining).toEqual([other])
    expect(parseHostRecords(readFileSync(file, 'utf8'))).toEqual([other])
  })
})

describe('宿主守护器策略（退避重启 + 挡住崩溃循环）', () => {
  test('退避 1s → 2s → 4s，封顶 maxDelayMs', () => {
    const policy = { ...SUPERVISOR_POLICY, maxRestarts: 10 }
    expect(nextRestart([], 1_000, policy).delayMs).toBe(1_000)
    expect(nextRestart([1_000], 2_000, policy).delayMs).toBe(2_000)
    expect(nextRestart([1_000, 2_000], 3_000, policy).delayMs).toBe(4_000)
    const many = Array.from({ length: 8 }, (_, index) => 1_000 + index)
    expect(nextRestart(many, 9_000, policy).delayMs).toBe(30_000)
  })

  test('窗口期内超过上限就放弃（重启原因写清）', () => {
    const policy = { ...SUPERVISOR_POLICY, maxRestarts: 2, windowMs: 60_000 }
    expect(nextRestart([1_000, 2_000], 3_000, policy).restart).toBe(false)
    expect(nextRestart([1_000, 2_000], 3_000, policy).reason).toContain('停止守护')
    expect(nextRestart([1_000, 2_000], 3_000, policy).delayMs).toBe(0)
  })

  test('窗口滑出后重新允许', () => {
    const policy = { ...SUPERVISOR_POLICY, maxRestarts: 1, windowMs: 1_000 }
    expect(nextRestart([1_000], 2_500, policy).restart).toBe(true)
  })

  test('ledger 记账与重置', () => {
    const ledger = createRestartLedger({ ...SUPERVISOR_POLICY, maxRestarts: 2 })
    expect(ledger.decide(1_000).restart).toBe(true)
    ledger.record(1_000)
    ledger.record(1_100)
    expect(ledger.decide(1_200).restart).toBe(false)
    ledger.reset()
    expect(ledger.decide(1_300).restart).toBe(true)
  })
})

describe('子进程环境：看门狗要的父 pid', () => {
  const base = { base: {}, clientVersion: '0.1.0', profile: 'desktop', home: '/tmp/h' }

  test('传了就带上 DSH_SHELL_PARENT_PID', () => {
    expect(buildChildEnv({ ...base, parentPid: 321 }).DSH_SHELL_PARENT_PID).toBe('321')
  })

  test('不传就不带（手工起宿主时不需要看门狗）', () => {
    expect('DSH_SHELL_PARENT_PID' in buildChildEnv(base)).toBe(false)
  })
})

interface ParentWatchApi {
  parentWatchReason: (input: { parentPid: number; ppid: number; alive: boolean }) => string | null
  isProcessAlive: (pid: number) => boolean
  watchParent: (options: {
    parentPid?: number
    intervalMs?: number
    onDead?: (reason: string) => void
  }) => () => void
}

const parentWatchUrl = new URL('../runtime/parent-watch.mjs', import.meta.url)
const parentWatch = (await import(parentWatchUrl.href)) as unknown as ParentWatchApi

describe('父进程看门狗（壳被 SIGKILL 也收得住宿主）', () => {
  test('纯判据：pid 非法不启用、ppid 变 1 视为没了、ESRCH 视为没了', () => {
    expect(parentWatch.parentWatchReason({ parentPid: 0, ppid: 1, alive: false })).toBeNull()
    expect(parentWatch.parentWatchReason({ parentPid: 12, ppid: 1, alive: true })).toBe('reparented')
    expect(parentWatch.parentWatchReason({ parentPid: 12, ppid: 8, alive: false })).toBe('gone')
    expect(parentWatch.parentWatchReason({ parentPid: 12, ppid: 8, alive: true })).toBeNull()
  })

  test('pid 存活判定', () => {
    expect(parentWatch.isProcessAlive(process.pid)).toBe(true)
    expect(parentWatch.isProcessAlive(2 ** 30)).toBe(false)
  })

  test('真进程：父被 SIGKILL 后，子进程自己退出（不留孤儿）', async () => {
    const childScript = `
      import { watchParent } from ${JSON.stringify(parentWatchUrl.href)}
      watchParent({
        parentPid: Number(process.env.TEST_PARENT_PID),
        intervalMs: 50,
        onDead: (reason) => { console.log('DEAD ' + reason); process.exit(7) },
      })
      console.log('WATCHING')
      setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0) }, 10000)
    `
    const decoy = Bun.spawn([bunBin, '-e', 'setTimeout(() => {}, 60000)'])
    const child = Bun.spawn([bunBin, '-e', childScript], {
      env: { ...process.env, TEST_PARENT_PID: String(decoy.pid) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const decoder = new TextDecoder()
    let out = ''
    const pump = (async () => {
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) out += decoder.decode(chunk)
    })()

    // 等看门狗真的装好，再杀“父”——否则测的是启动竞态
    for (let i = 0; i < 100 && !out.includes('WATCHING'); i += 1) await Bun.sleep(20)
    expect(out).toContain('WATCHING')

    decoy.kill('SIGKILL')
    const code = await child.exited
    await pump

    expect(code).toBe(7)
    expect(out).toContain('DEAD')
    expect(out).not.toContain('STILL-ALIVE')
  }, 20_000)
})

describe('宿主停止：等到真退出，超时就升级 SIGKILL', () => {
  function fakeLayout(dir: string, hostSource: string) {
    const preloadFile = join(dir, 'noop-preload.mjs')
    const hostScript = join(dir, 'fake-host.mjs')
    writeFileSync(preloadFile, '// 测试用空 preload\n')
    writeFileSync(hostScript, hostSource)
    return {
      home: dir,
      profile: 'desktop',
      appSupport: dir,
      runtimeDir: dir,
      dshLibDir: dir,
      distDir: dir,
      preloadFile,
      hostScript,
      repoRoot: dir,
      resourcesDir: null,
      runtimeKind: 'override' as const,
      runtimeVersion: null,
      runtimeNote: null,
    }
  }

  const readyLine = (): string =>
    `console.log('HOST-READY ' + JSON.stringify({ type: 'ready', url: 'http://127.0.0.1:1/?token=t', injections: [] }))`

  test('优雅路径：SIGTERM 后被收掉，stop() 等到真的退出', async () => {
    const dir = tempDir()
    const layout = fakeLayout(
      dir,
      `process.on('SIGTERM', () => { console.log('[host] 收到 SIGTERM'); process.exit(0) })\n${readyLine()}\nsetTimeout(() => {}, 60000)\n`,
    )
    const started = await startHost({ layout, clientVersion: '0.0.0-test', env: process.env, timeoutMs: 15_000 })
    expect(started.ready.url).toBe('http://127.0.0.1:1/?token=t')
    await started.stop()
    expect(await started.exited).not.toBeNull()
    expect(parentWatch.isProcessAlive(started.pid)).toBe(false)
  }, 30_000)

  // Windows 没有 POSIX 信号语义（`kill('SIGTERM')` 即 TerminateProcess），这套「先礼后兵」的升级路径只在 POSIX 上有意义。
  test.skipIf(process.platform === 'win32')('升级路径：忽略 SIGTERM 的宿主也要被 SIGKILL 收掉（不留孤儿）', async () => {
    const dir = tempDir()
    const layout = fakeLayout(
      dir,
      `process.on('SIGTERM', () => { console.log('[host] 忽略 SIGTERM（测试升级路径）') })\n${readyLine()}\nsetTimeout(() => {}, 60000)\n`,
    )
    const started = await startHost({ layout, clientVersion: '0.0.0-test', env: process.env, timeoutMs: 15_000 })
    const began = Date.now()
    await started.stop()
    const elapsed = Date.now() - began
    expect(await started.exited).not.toBeNull()
    expect(parentWatch.isProcessAlive(started.pid)).toBe(false)
    // 宽限期（5s）内不该走 SIGKILL，所以至少要等这么久；这里是「真的等了」的证据
    expect(elapsed).toBeGreaterThanOrEqual(4_000)
  }, 40_000)
})
