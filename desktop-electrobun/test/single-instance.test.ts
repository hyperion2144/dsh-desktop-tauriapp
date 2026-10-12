// 单实例 + 启动界面（缝 ② 纯逻辑 + /__shell__/activate 的真 HTTP 用例）。
//
// 守的是什么：
//   1. 第二个壳不能再起一份宿主（旧 Tauri 壳有 tauri-plugin-single-instance，Electrobun 没有）
//      ⇒ 锁文件 + 「激活已有实例后自己退出」；锁文件里还留着死进程的 pid 时必须能接管。
//   2. 启动那 10–60 秒里要有可见进度，失败要留在屏幕上给出原因，别只转圈或干脆白屏。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startShellServer } from '../src/bun/shell-server.ts'
import {
  ACTIVATE_PATH,
  acquireInstance,
  activateUrl,
  parseInstanceRecord,
  readInstance,
  releaseInstance,
  updateInstance,
  defaultIsOurProcess,
  readBootId,
  type InstanceRecord,
} from '../src/bun/single-instance.ts'
import { SPLASH_HEIGHT, SPLASH_WIDTH, splashFailScript, splashHtml, splashStageScript } from '../src/bun/splash.ts'
import { FAILED_LABEL, SHELL_STAGES, stageLabel, stagePercent } from '../src/bun/stages.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-instance-'))
}

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: 4242,
    origin: 'http://127.0.0.1:6390',
    pageUrl: 'http://127.0.0.1:6390/tok/',
    profile: 'desktop',
    startedAt: '2026-10-11T00:00:00.000Z',
    bootId: '',
    ...overrides,
  }
}

describe('单实例锁', () => {
  test('没有锁文件时直接接管并写下自己', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    const result = acquireInstance(file, 'desktop', { identity: { pid: 111, startedAt: 'now' } })
    expect(result.acquired).toBe(true)
    expect(result.previous).toBeNull()
    expect(readInstance(file)?.pid).toBe(111)
    // 刚接管时还没起服务面：origin 为空，第二个实例这时只能提示「正在启动」
    expect(readInstance(file)?.origin).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })

  test('已有活着的实例 ⇒ 放弃并把它带回来', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record()))
    const result = acquireInstance(file, 'desktop', {
      isAlive: (pid) => pid === 4242,
      isOurProcess: () => true,
      identity: { pid: 999 },
    })
    expect(result.acquired).toBe(false)
    expect(result.previous?.pid).toBe(4242)
    expect(activateUrl(result.previous as InstanceRecord)).toBe(`http://127.0.0.1:6390${ACTIVATE_PATH}`)
    // 锁文件不能被第二个实例覆盖
    expect(readInstance(file)?.pid).toBe(4242)
    rmSync(dir, { recursive: true, force: true })
  })

  test('上次崩了留下的死 pid 能被接管（否则永远起不来）', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 4242 })))
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => false,
      identity: { pid: 777 },
    })
    expect(result.acquired).toBe(true)
    expect(result.previous?.pid).toBe(4242)
    expect(readInstance(file)?.pid).toBe(777)
    rmSync(dir, { recursive: true, force: true })
  })

  test('pid 就是自己 ⇒ 视为自己的锁（restart 路径）', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 555 })))
    const result = acquireInstance(file, 'desktop', { isAlive: () => true, identity: { pid: 555 } })
    expect(result.acquired).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('就绪后回填 origin/pageUrl，只有持有者能改', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 10, origin: '', pageUrl: null })))
    updateInstance(file, 10, { origin: 'http://127.0.0.1:6390', pageUrl: 'http://127.0.0.1:6390/t/' })
    expect(readInstance(file)?.origin).toBe('http://127.0.0.1:6390')
    // 别的进程（比如已经接管的）不许改
    updateInstance(file, 11, { origin: 'http://127.0.0.1:9999' })
    expect(readInstance(file)?.origin).toBe('http://127.0.0.1:6390')
    rmSync(dir, { recursive: true, force: true })
  })

  test('退出清位后，下一个实例能正常接管', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 10 })))
    releaseInstance(file, 10)
    // 清位就是删文件：锁文件的语义是「有文件 = 有实例」，不留假记录
    expect(readInstance(file)).toBeNull()
    const result = acquireInstance(file, 'desktop', { identity: { pid: 12 } })
    expect(result.acquired).toBe(true)
    expect(result.previous).toBeNull()
    expect(readInstance(file)?.pid).toBe(12)
    // 不是自己的记录就不许清（新实例的锁不能被旧进程顺手删掉）
    releaseInstance(file, 10)
    expect(readInstance(file)?.pid).toBe(12)
    rmSync(dir, { recursive: true, force: true })
  })

  test('锁文件已被清掉时 release 是安全的 no-op', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    releaseInstance(file, 10)
    expect(readInstance(file)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  test('坏文件/非法 pid 当没有锁（不能因为一个坏 json 起不来）', () => {
    expect(parseInstanceRecord('{ not json')).toBeNull()
    expect(parseInstanceRecord('null')).toBeNull()
    expect(parseInstanceRecord('[]')).toBeNull()
    expect(parseInstanceRecord('{"pid":0}')).toBeNull()
    expect(parseInstanceRecord('{"pid":-3}')).toBeNull()
    expect(parseInstanceRecord('{"pid":1.5}')).toBeNull()
    expect(parseInstanceRecord('{"pid":7}')?.profile).toBe('desktop')
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, '{ not json')
    expect(acquireInstance(file, 'web', { identity: { pid: 8 } }).acquired).toBe(true)
    expect(readInstance(file)?.profile).toBe('web')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('/__shell__/activate 端点', () => {
  /** 真 HTTP：壳自答端点不要求 token，但必须是 POST。 */
  async function withServer(
    onActivate: (() => void) | undefined,
    run: (origin: string) => Promise<void>,
  ): Promise<void> {
    const dist = tempDir()
    const probe = Bun.serve({ port: 0, fetch: () => new Response('upstream') })
    const port = probe.port
    if (port === undefined) throw new Error('临时端口没拿到')
    probe.stop(true)
    const server = startShellServer({
      distDir: dist,
      token: 'tok',
      cookie: 'dsh-auth-x=v1.y',
      upstreamOrigin: `http://127.0.0.1:${String(port)}`,
      port,
      bootPayload: () => null,
      ...(onActivate === undefined ? {} : { onActivate }),
    })
    try {
      await run(server.origin)
    } finally {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    }
  }

  test('POST ⇒ 204 且回调被调用一次', async () => {
    let calls = 0
    await withServer(
      () => {
        calls += 1
      },
      async (origin) => {
        const response = await fetch(`${origin}${ACTIVATE_PATH}`, { method: 'POST' })
        expect(response.status).toBe(204)
        expect(calls).toBe(1)
      },
    )
  })

  test('GET ⇒ 405（别让 <img>/预取之类误触发）', async () => {
    let calls = 0
    await withServer(
      () => {
        calls += 1
      },
      async (origin) => {
        const response = await fetch(`${origin}${ACTIVATE_PATH}`)
        expect(response.status).toBe(405)
        expect(calls).toBe(0)
      },
    )
  })

  test('无窗口宿主（serve.ts）⇒ 501', async () => {
    await withServer(undefined, async (origin) => {
      const response = await fetch(`${origin}${ACTIVATE_PATH}`, { method: 'POST' })
      expect(response.status).toBe(501)
    })
  })
})

describe('启动阶段与启动界面', () => {
  test('阶段表顺序即进度，ready 是 100', () => {
    expect(SHELL_STAGES.map((entry) => entry.stage)).toEqual([
      'instance',
      'layout',
      'ports',
      'host',
      'cookie',
      'server',
      'ready',
    ])
    expect(stagePercent('ready')).toBe(100)
    expect(stagePercent('instance')).toBe(14)
    expect(stageLabel('host')).toBe('启动 dsh 宿主')
    expect(FAILED_LABEL).toBe('启动失败')
    // 单调递增：不能出现「进度条倒退」
    const percents = SHELL_STAGES.map((entry) => stagePercent(entry.stage))
    for (let index = 1; index < percents.length; index += 1) {
      expect(percents[index] as number).toBeGreaterThan(percents[index - 1] as number)
    }
  })

  test('推阶段/失败的脚本是合法 JS 字面量（引号与换行都得转义）', () => {
    expect(splashStageScript('ready')).toBe(
      'window.__dshSplash && window.__dshSplash.stage("就绪", 100)',
    )
    const tricky = 'bad "quote"\nnewline'
    expect(splashFailScript(tricky)).toBe(
      `window.__dshSplash && window.__dshSplash.fail(${JSON.stringify(tricky)})`,
    )
  })

  test('启动界面 HTML 自带进度与失败出口', () => {
    const html = splashHtml()
    expect(html).toContain('window.__dshSplash')
    expect(html).toContain('id="stage"')
    expect(html).toContain('id="bar"')
    expect(html).toContain('id="error"')
    expect(html).toContain('~/.dsh/shell.log')
    // 失败时把进度条藏掉、红字露出来（纯 CSS，不依赖执行时机）
    expect(html).toContain('body.failed .error')
    expect(SPLASH_WIDTH).toBe(420)
    expect(SPLASH_HEIGHT).toBe(236)
    // 启动界面完全离线：不许有外部资源（起不来时就该只依赖本地）
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
  })
})

// 系统重启后 pid 会被复用（实测：pid 546 变成了 mobiletimerd）——锁文件里只有 pid 时，
// 误判「已有实例在跑」会让 App 点开就退出，用户看到的是「点了没反应」。
describe('单实例锁：重启 / pid 复用', () => {
  test('锁记录来自上一次开机（bootId 不同）时接管，不误判', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546, bootId: '1759' }))}\n`)
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => true, // 546 这个 pid 现在确实被别家进程占着
      isOurProcess: () => true, // 即使进程身份也像
      bootId: '1800', // 但是另一次开机了
      identity: { pid: 111, startedAt: 'now' },
    })
    expect(result.acquired).toBe(true)
    expect(result.record.bootId).toBe('1800')
    expect(readInstance(file)?.pid).toBe(111)
  })

  test('同一次开机但那个 pid 不是我们的壳进程 ⇒ 接管', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546, bootId: '1759' }))}\n`)
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => true,
      isOurProcess: () => false, // ps 看到的 comm 是 mobiletimerd
      bootId: '1759',
      identity: { pid: 111, startedAt: 'now' },
    })
    expect(result.acquired).toBe(true)
  })

  test('同一次开机 + 确实是我们的壳进程 ⇒ 不接管（原有行为不变）', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546, bootId: '1759' }))}\n`)
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => true,
      isOurProcess: () => true,
      bootId: '1759',
      identity: { pid: 111, startedAt: 'now' },
    })
    expect(result.acquired).toBe(false)
    expect(result.previous?.pid).toBe(546)
  })

  test('老记录（没有 bootId）靠进程身份兜底', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546 }))}\n`)
    expect(readInstance(file)?.bootId).toBe('')
    const ours = acquireInstance(file, 'desktop', { isAlive: () => true, isOurProcess: () => true, bootId: '1759' })
    expect(ours.acquired).toBe(false)
    const foreign = acquireInstance(file, 'desktop', { isAlive: () => true, isOurProcess: () => false, bootId: '1759' })
    expect(foreign.acquired).toBe(true)
  })

  test('readBootId / defaultIsOurProcess 在异常输入下不抛', () => {
    const bootId = readBootId()
    expect(typeof bootId).toBe('string')
    if (process.platform !== 'darwin') expect(bootId).toBe('')
    // 不存在的 pid ⇒ false（而不是抛）
    expect(defaultIsOurProcess(999_999_999)).toBe(false)
  })
})

describe('/__shell__/window 端点（A5 自绘窗口控制）', () => {
  function withWindowServer(
    onWindowControl: (action: 'minimize' | 'toggle-maximize' | 'close') => void,
    run: (origin: string) => Promise<void>,
  ): Promise<void> {
    const dist = tempDir()
    const probe = Bun.serve({ port: 0, fetch: () => new Response('upstream') })
    const port = probe.port
    if (port === undefined) throw new Error('临时端口没拿到')
    probe.stop(true)
    const server = startShellServer({
      distDir: dist,
      token: 'tok',
      cookie: 'dsh-auth-x=v1.y',
      upstreamOrigin: `http://127.0.0.1:${String(port)}`,
      port,
      bootPayload: () => null,
      onWindowControl,
    })
    try {
      return run(server.origin).finally(() => server.stop())
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  }

  test('POST minimize/toggle-maximize/close ⇒ 204 且动作逐次送达', async () => {
    const seen: string[] = []
    await withWindowServer((action) => void seen.push(action), async (origin) => {
      for (const action of ['minimize', 'toggle-maximize', 'close'] as const) {
        const response = await fetch(`${origin}/__shell__/window`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        expect(response.status).toBe(204)
      }
      expect(seen).toEqual(['minimize', 'toggle-maximize', 'close'])
    })
  })

  test('未知动作 ⇒ 400', async () => {
    await withWindowServer(() => undefined, async (origin) => {
      const response = await fetch(`${origin}/__shell__/window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'explode' }),
      })
      expect(response.status).toBe(400)
    })
  })

  test('GET ⇒ 405', async () => {
    await withWindowServer(() => undefined, async (origin) => {
      const response = await fetch(`${origin}/__shell__/window`)
      expect(response.status).toBe(405)
    })
  })
})
