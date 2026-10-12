// 缝 ①：进程级黑盒——起真壳（无窗口入口 serve.ts）+ 临时 DSH_HOME，然后用真 HTTP/WS 打它。
//
// CI 门禁（规格 Testing Decisions）：`bun test` + 本文件。没有运行时树时整体跳过，
// 用 DSH_SHELL_TEST_RUNTIME 指向一份运行时（CI 里由 prepare 步骤铺好）：
//
//   DSH_SHELL_TEST_RUNTIME=/path/to/runtimes/0.2.1-alpha.2 bun test
//
// 覆盖：启动握手、token 闸门、本地文档与静态资产、boot 载荷、数据面反代、WS 隧道、
// 协议层不变量（源映射 204 / 穿越 404 / 跨站 403 / 插件资产 no-store）。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtime = process.env.DSH_SHELL_TEST_RUNTIME ?? ''
const projectRoot = join(import.meta.dir, '..')
const repoPreload = join(projectRoot, '..', 'desktop', 'src-tauri', 'resources', 'dsh', 'bun-preload.mjs')
const runnable = runtime !== '' && existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'))

interface ShellState {
  origin: string
  pageUrl: string
  token: string
  hostPid: number
  injections: number
}

const suite = runnable ? describe : describe.skip
let home = ''
let proc: ReturnType<typeof Bun.spawn> | undefined
let state: ShellState = { origin: '', pageUrl: '', token: '', hostPid: 0, injections: 0 }

function waitForReady(child: ReturnType<typeof Bun.spawn>): Promise<ShellState> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('壳 180s 内未打印 SHELL-READY')), 180_000)
    void (async () => {
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let at = buffer.indexOf('\n')
        while (at >= 0) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          const hit = line.indexOf('SHELL-READY ')
          if (hit >= 0) {
            clearTimeout(timer)
            resolvePromise(JSON.parse(line.slice(hit + 'SHELL-READY '.length)) as ShellState)
            return
          }
          at = buffer.indexOf('\n')
        }
      }
      clearTimeout(timer)
      rejectPromise(new Error('壳进程 stdout 结束，未拿到 SHELL-READY'))
    })()
  })
}

suite('缝 ①：壳的 loopback 面（真进程 + 真 HTTP/WS）', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-shell-blackbox-'))
    const preload = join(home, 'bun-preload.mjs')
    copyFileSync(repoPreload, preload)
    proc = Bun.spawn([process.execPath, 'run', join(projectRoot, 'src', 'bun', 'serve.ts')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_SHELL_RUNTIME_DIR: runtime,
        DSH_SHELL_PRELOAD: preload,
        DSH_SHELL_PROFILE_MODE: 'fresh',
        DSH_SHELL_PAGE_PORT: '6397',
        DSH_SHELL_LOG: join(home, 'shell.log'),
        // 上游/lane 端口也固定在测试自己的段里：开发者机器上往往还跑着一个真实壳（它占 3080/3091），
        // 让测试与它抢端口会得到 EADDRINUSE 而不是被测行为。
        DSH_DESKTOP_PORT: '6398',
        DSH_MOBILE_LANE_PORT: '6399',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    state = await waitForReady(proc)
  }, 200_000)

  afterAll(() => {
    try {
      proc?.kill('SIGTERM')
    } catch {}
    if (home !== '') rmSync(home, { recursive: true, force: true })
  })

  test('启动握手：拿到 origin/token，注射行数为正，宿主 pid 与壳不同', () => {
    expect(state.origin).toStartWith('http://127.0.0.1:6397')
    expect(state.token).toStartWith('tok-')
    expect(state.pageUrl).toBe(`${state.origin}/${state.token}/`)
    expect(state.injections).toBeGreaterThan(0)
    expect(state.hostPid).toBeGreaterThan(0)
  })

  test('壳自答端点：health 报出注入行数与上游', async () => {
    const res = await fetch(`${state.origin}/__shell__/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; bootReady: boolean; upstream: string; injections: number }
    expect(body.ok).toBe(true)
    expect(body.bootReady).toBe(true)
    expect(body.upstream).toStartWith('http://127.0.0.1:')
    expect(body.injections).toBe(state.injections)
  })

  test('文档：带 token 拿到注入过的 index.html，注入行只出现一次', async () => {
    const res = await fetch(`${state.origin}/${state.token}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('__DSH_BOOT_READY__')
    expect(html.split('__DSH_BOOT_READY__').length - 1).toBe(1)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('静态资产：带 token 出本地 dist，且带 no-store', async () => {
    const res = await fetch(`${state.origin}/${state.token}/manifest.webmanifest`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('源映射按协议不变量走 204（带 token 与不带 token 都是）', async () => {
    expect((await fetch(`${state.origin}/${state.token}/assets/index.js.map`)).status).toBe(204)
    expect((await fetch(`${state.origin}/assets/index.js.map`)).status).toBe(204)
  })

  test('路径穿越一律 404，不落到上游也不落到 dist 之外', async () => {
    expect((await fetch(`${state.origin}/${state.token}/../../etc/passwd`)).status).toBe(404)
    expect((await fetch(`${state.origin}/${state.token}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404)
  })

  test('跨站被拒：Origin 不在白名单上直接 403', async () => {
    const res = await fetch(`${state.origin}/__shell__/health`, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
  })

  test('boot 载荷：injections 是数组，streamBaseUrl 指向壳自己', async () => {
    const res = await fetch(`${state.origin}/__shell__/boot`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { injections: unknown[]; streamBaseUrl: string }
    expect(Array.isArray(payload.injections)).toBe(true)
    expect(payload.injections.length).toBe(state.injections)
    expect(payload.streamBaseUrl).toBe(state.origin)
  })

  test('数据面反代：/api/* 打到上游而不是壳自答（不是 502）', async () => {
    const res = await fetch(`${state.origin}/api/session/modelCatalog`, { method: 'POST', body: '{}' })
    expect([200, 400, 401, 404, 405, 415]).toContain(res.status)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('WS 隧道：/api/remote.mux 能升级', async () => {
    const code = await new Promise<number>((resolvePromise) => {
      const ws = new WebSocket(`ws://127.0.0.1:6397/api/remote.mux`)
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {}
        resolvePromise(-1)
      }, 10_000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        ws.close()
        resolvePromise(101)
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        resolvePromise(0)
      })
    })
    expect(code).toBe(101)
  }, 20_000)
})
