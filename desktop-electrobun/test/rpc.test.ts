// 壳 ↔ 页面 RPC（缝 ② 纯逻辑 + 真 HTTP 用例）。
//
// 守的是什么：壳自己的客户端插件（设置面板、通知 tab、下载 tab、本地 chrome）是照 Tauri
// 写的，全经 `__TAURI_INTERNALS__.invoke(cmd, args)`。新壳没有 Tauri，也没有真实的 IPC——
// 这一层必须把 41 个命令里的每一个都给出**明确**答复：能做的做，做不了的报清楚原因；
// 绝不能出现「resolve 了 undefined」这种让插件静默失效、面板永远转圈的情况。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startShellServer } from '../src/bun/shell-server.ts'
import { createCommandTable, type CommandDeps } from '../src/bun/commands.ts'
import { createRpcRouter, dispatchRpc, parseRpcRequest, rpcCommands } from '../src/bun/rpc.ts'
import { defaultSettings, type DesktopSettings } from '../src/shared/settings.ts'
import { loadSettings, saveSettings, updateSettings } from '../src/bun/settings-store.ts'

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rpc-'))
  saveSettings(home, defaultSettings())
  return home
}

/** 真命令表 + 真设置文件（写盘走 settings-store），只把「壳侧动作」换成探针。 */
function harness(overrides: Partial<CommandDeps> = {}): {
  deps: CommandDeps
  home: string
  table: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>
  calls: { log: string[]; external: string[]; restarts: number; closed: number; sounds: string[] }
  cleanup: () => void
} {
  const home = tempHome()
  let settings: DesktopSettings = loadSettings({ home }).settings
  const calls = { log: [] as string[], external: [] as string[], restarts: 0, closed: 0, sounds: [] as string[] }
  const deps: CommandDeps = {
    home,
    profile: 'desktop',
    platform: 'darwin',
    log: (line) => calls.log.push(line),
    settings: () => settings,
    save: (patch) => {
      settings = updateSettings(home, patch)
      return settings
    },
    restartService: async () => {
      calls.restarts += 1
    },
    status: () => ({ origin: 'http://127.0.0.1:6390', pageUrl: 'http://127.0.0.1:6390/tok/', upstreamPort: 3081 }),
    ports: () => ({ port: 6390, lanePort: 3092 }),
    openExternal: (url) => calls.external.push(url),
    closeWindow: () => {
      calls.closed += 1
    },
    playSound: (name) => calls.sounds.push(name),
    ...overrides,
  }
  return {
    deps,
    home,
    table: createCommandTable(deps),
    calls,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('请求解析', () => {
  test('正常请求：cmd + args', () => {
    expect(parseRpcRequest('{"cmd":"get_dsh_status","args":{"a":1}}')).toEqual({
      cmd: 'get_dsh_status',
      args: { a: 1 },
    })
  })

  test('缺 args 补成空对象（Tauri 允许 invoke(cmd) 省略第二个参数）', () => {
    expect(parseRpcRequest('{"cmd":"open_external"}')).toEqual({ cmd: 'open_external', args: {} })
  })

  test('坏 JSON / 非对象 / 空 cmd / args 不是对象 ⇒ null', () => {
    expect(parseRpcRequest('not json')).toBeNull()
    expect(parseRpcRequest('[1,2]')).toBeNull()
    expect(parseRpcRequest('"cmd"')).toBeNull()
    expect(parseRpcRequest('{"cmd":""}')).toBeNull()
    expect(parseRpcRequest('{"cmd":"x","args":[]}')).toBeNull()
  })
})

describe('派发语义', () => {
  const router = createRpcRouter({
    ok: (args) => ({ echo: args.value ?? null }),
    nothing: () => undefined,
    boom: () => {
      throw new Error('炸了')
    },
    async_ok: async () => ({ slow: true }),
  })

  test('成功 ⇒ 200 + ok:true + value（undefined 变 null，别 resolve 成 undefined）', async () => {
    expect(await dispatchRpc(router, '{"cmd":"ok","args":{"value":7}}')).toEqual({
      status: 200,
      body: { ok: true, value: { echo: 7 } },
    })
    expect(await dispatchRpc(router, '{"cmd":"nothing"}')).toEqual({
      status: 200,
      body: { ok: true, value: null },
    })
  })

  test('异步命令照常 await', async () => {
    expect(await dispatchRpc(router, '{"cmd":"async_ok"}')).toEqual({
      status: 200,
      body: { ok: true, value: { slow: true } },
    })
  })

  test('命令抛错 ⇒ 200 + ok:false（不是 500：页面要的是可读原因）', async () => {
    expect(await dispatchRpc(router, '{"cmd":"boom"}')).toEqual({
      status: 200,
      body: { ok: false, error: '炸了' },
    })
  })

  test('未知命令 ⇒ ok:false 且带上命令名', async () => {
    const result = await dispatchRpc(router, '{"cmd":"browser_guest_acquire"}')
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(false)
    expect(String(result.body.error)).toContain('browser_guest_acquire')
  })

  test('坏请求 400、超限 413', async () => {
    expect((await dispatchRpc(router, 'nope')).status).toBe(400)
    expect((await dispatchRpc(router, `{"cmd":"ok","args":{"value":"${'x'.repeat(1024 * 1024)}"}}`)).status).toBe(413)
  })

  test('命令表可枚举（诊断用）', () => {
    expect(rpcCommands(router)).toEqual(['async_ok', 'boom', 'nothing', 'ok'])
  })
})

describe('命令表', () => {
  test('渲染环境：客户端插件的第一步（缺了它整片桌面 chrome 不激活）', async () => {
    const h = harness()
    try {
      const env = (await h.table.get_desktop_client_environment?.({})) as Record<string, unknown>
      expect(env.mode).toBe('advanced')
      expect(env.platform).toBe('darwin')
      expect(env.profile).toBe('desktop')
      expect(env.renderBudget).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('设置面板读侧：扁平键（旧壳契约）+ settings 段', async () => {
    const h = harness()
    try {
      const data = (await h.table.get_desktop_settings_data?.({})) as Record<string, unknown>
      expect(data.port).toBe(3081)
      expect(data.origin).toBe('http://127.0.0.1:6390')
      expect(Array.isArray(data.profiles)).toBe(true)
      const settings = data.settings as Record<string, unknown>
      // serializeSettings 写下划线键（旧壳 serde 只认这个，回退到 v0.12.0 时设置不清零）
      expect(settings.prevent_sleep).toBe(true)
      expect(settings.download_concurrency).toBe(3)
    } finally {
      h.cleanup()
    }
  })

  test('保存设置：落到 desktop-settings.json 并能读回来', async () => {
    const h = harness()
    try {
      const result = (await h.table.save_desktop_settings?.({
        patch: { prevent_sleep: false, download_concurrency: 8 },
      })) as Record<string, unknown>
      expect((result.settings as Record<string, unknown>).prevent_sleep).toBe(false)
      const onDisk = loadSettings({ home: h.home }).settings
      expect(onDisk.preventSleep).toBe(false)
      expect(onDisk.downloadConcurrency).toBe(8)
    } finally {
      h.cleanup()
    }
  })

  test('保存设置：patch 不是对象 ⇒ ok:false（不能把整份设置覆盖成垃圾）', async () => {
    const h = harness()
    try {
      const router = createRpcRouter(h.table)
      const bad = await dispatchRpc(router, JSON.stringify({ cmd: 'save_desktop_settings', args: { patch: 'x' } }))
      expect(bad.status).toBe(200)
      expect(bad.body.ok).toBe(false)
      expect(String(bad.body.error)).toContain('patch 必须是对象')
      const missing = await dispatchRpc(router, JSON.stringify({ cmd: 'save_desktop_settings', args: {} }))
      expect(missing.body.ok).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('下载与通知：写设置、并把并发夹到合法区间', async () => {
    const h = harness()
    try {
      await h.table.set_download_concurrency?.({ value: 999 })
      expect(loadSettings({ home: h.home }).settings.downloadConcurrency).toBe(32)
      const state = (await h.table.get_notifications_state?.({})) as Record<string, unknown>
      expect(typeof state.config).toBe('object')
      const config = state.config as { enabled?: boolean }
      config.enabled = false
      await h.table.set_notifications_config?.({ config })
      expect(loadSettings({ home: h.home }).settings.notifications.enabled).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('通知试听：把名字交给壳侧播放器', async () => {
    const h = harness()
    try {
      await h.table.preview_notification_sound?.({ name: 'done.wav' })
      expect(h.calls.sounds).toEqual(['done.wav'])
    } finally {
      h.cleanup()
    }
  })

  test('重启 dsh 服务：打到服务面的 restartHost', async () => {
    const h = harness()
    try {
      await h.table.restart_dsh_service?.({})
      expect(h.calls.restarts).toBe(1)
    } finally {
      h.cleanup()
    }
  })

  test('尚未移植的命令：报清楚原因，而不是假装成功', async () => {
    const h = harness()
    try {
      const router = createRpcRouter(h.table)
      const call = async (cmd: string): Promise<Record<string, unknown>> => {
        const result = await dispatchRpc(router, JSON.stringify({ cmd, args: {} }))
        return result.body
      }
      // 真实路径是 dispatch：命令抛错 ⇒ ok:false + 可读原因（面板显示它，不是永远转圈）
      const notPorted = await call('migrate_profile')
      expect(notPorted.ok).toBe(false)
      expect(String(notPorted.error)).toContain('尚未移植')
      // 运行时目录已经移植：未注入 fetchCatalog 时也要回结构完整的空目录，而不是报错
      const catalog = await call('list_runtime_catalog')
      expect(catalog.ok).toBe(true)
      const catalogValue = catalog.value as Record<string, unknown>
      expect(catalogValue.source).toBe('github')
      expect(catalogValue.catalog).toEqual([])
      const guest = await call('browser_guest_acquire')
      expect(String(guest.error)).toContain('尚未移植')
      const blob = await call('start_blob_download')
      expect(String(blob.error)).toContain('尚未移植')
      // 下载列表先给空数组：tab 不该因为管理器未移植而炸
      const downloads = await call('list_downloads')
      expect(downloads).toEqual({ ok: true, value: [] })
    } finally {
      h.cleanup()
    }
  })

  test('运行时下载：命令走依赖、状态从状态机读（面板轮询那条路）', async () => {
    const started: Array<{ version: string; source: string }> = []
    const h = harness({
      downloadRuntime: async (version, source) => {
        started.push({ version, source })
        return { ok: true as const, version }
      },
      downloadStatus: () => ({ active: true, version: '9.9.9', resolved: 12, downloaded: 3, added: 1, error: '' }),
    })
    try {
      await expect(h.table.download_runtime?.({ version: '9.9.9' })).resolves.toEqual({ ok: true, version: '9.9.9' })
      expect(started).toEqual([{ version: '9.9.9', source: 'github' }])
      await h.table.download_runtime?.({ version: '9.9.9', source: 'npm' })
      expect(started[1]?.source).toBe('npm')
      // 面板每 600ms 轮询这个命令：必须回状态机里的真值，而不是写死的空闲态
      expect(await h.table.runtime_download_status?.({})).toEqual({
        active: true,
        version: '9.9.9',
        resolved: 12,
        downloaded: 3,
        added: 1,
        error: '',
      })
      // 没注入依赖时（旧调用方）仍要回一个结构完整的空闲态，别让面板炸
      const bare = harness()
      try {
        expect(await bare.table.runtime_download_status?.({})).toEqual({
          active: false,
          version: '',
          resolved: 0,
          downloaded: 0,
          added: 0,
          error: '',
        })
        await expect(bare.table.download_runtime?.({ version: '1.0.0' })).rejects.toThrow('运行时下载不可用')
      } finally {
        bare.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  test('外链与关窗：交给主进程实现', async () => {
    const h = harness()
    try {
      await h.table.open_external?.({ url: 'https://example.com' })
      expect(h.calls.external).toEqual(['https://example.com'])
      await h.table.close_current_window?.({})
      await h.table.exit_window_instance?.({})
      expect(h.calls.closed).toBe(2)
    } finally {
      h.cleanup()
    }
  })

  test('诊断日志：页面 console 走壳日志，不乱弹', async () => {
    const h = harness()
    try {
      await h.table.log_console?.({ message: '来自页面' })
      expect(h.calls.log.some((line) => line.includes('来自页面'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})

describe('/__shell__/rpc 端点', () => {
  /**
   * 拿两个互不相同的空闲端口：一个当上游（起完就放掉，保持不可达），一个给壳。
   * 早先版本让壳绑在上游端口上，于是「转发」其实打回了壳自己——测出来的 200 是自环，
   * 掩盖了真契约：壳自答端点只在**根绝对路径**（见 src/shared/admission.ts 的 SHELL_PREFIX）。
   */
  function takePorts(count: number): number[] {
    const probes = Array.from({ length: count }, () =>
      Bun.serve({ port: 0, fetch: () => new Response('probe') }),
    )
    const ports = probes.map((probe) => {
      const port = probe.port
      if (port === undefined) throw new Error('临时端口没拿到')
      return port
    })
    for (const probe of probes) probe.stop(true)
    return ports
  }

  async function withServer(run: (origin: string, token: string) => Promise<void>): Promise<void> {
    const dist = mkdtempSync(join(tmpdir(), 'dsh-rpc-dist-'))
    const ports = takePorts(2)
    const upstreamPort = ports[0] ?? 0
    const port = ports[1] ?? 0
    const router = createRpcRouter({
      get_desktop_client_environment: () => ({ mode: 'advanced', platform: 'darwin', profile: 'desktop' }),
      boom: () => {
        throw new Error('命令炸了')
      },
    })
    const server = startShellServer({
      distDir: dist,
      token: 'tok',
      cookie: 'dsh-auth-x=v1.y',
      upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
      port,
      bootPayload: () => null,
      onRpc: (raw) => dispatchRpc(router, raw),
    })
    try {
      await run(server.origin, 'tok')
    } finally {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    }
  }

  test('POST 根路径 ⇒ 命令结果原样回给页面', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/__shell__/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: 'get_desktop_client_environment', args: {} }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const payload = (await response.json()) as { ok: boolean; value: { mode: string } }
      expect(payload.ok).toBe(true)
      expect(payload.value.mode).toBe('advanced')
    })
  })

  test('带 token 前缀的同一个路径**不是** RPC（文档类，转发给上游）', async () => {
    await withServer(async (origin, token) => {
      const response = await fetch(`${origin}/${token}/__shell__/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: 'get_desktop_client_environment', args: {} }),
      })
      // 上游不可达 ⇒ 502；关键是它没被当成 RPC 处理
      expect(response.status).toBe(502)
      expect(await response.text()).toBe('upstream unreachable')
    })
  })

  test('命令抛错 ⇒ 200 + ok:false（面板显示原因，不是永远转圈）', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/__shell__/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: 'boom', args: {} }),
      })
      expect(response.status).toBe(200)
      const payload = (await response.json()) as { ok: boolean; error: string }
      expect(payload.ok).toBe(false)
      expect(payload.error).toBe('命令炸了')
    })
  })

  test('GET ⇒ 405（RPC 只收 POST）', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/__shell__/rpc`)
      expect(response.status).toBe(405)
    })
  })
})
