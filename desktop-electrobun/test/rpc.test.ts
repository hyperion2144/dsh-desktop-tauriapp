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
import { createRpcRouter, dispatchRpc, parseRpcRequest, rpcCommands, type RpcContext } from '../src/bun/rpc.ts'
import { defaultSettings, type DesktopSettings } from '../src/shared/settings.ts'
import { resolveProxyEnv } from '../src/shared/proxy-env.ts'
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
  table: Record<string, (args: Record<string, unknown>, context?: RpcContext) => unknown | Promise<unknown>>
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
      // 视觉窗口化整块删除（换壳后不需要）：载荷里不再有这个键
      expect(env).not.toHaveProperty('renderBudget')
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
      // profile 迁移已接：没注入回调时也要报出「未接」这句，而不是回到「尚未移植」
      const notPorted = await call('migrate_profile')
      expect(notPorted.ok).toBe(false)
      expect(String(notPorted.error)).toContain('壳未接迁移')
      // 运行时目录已经移植：未注入 fetchCatalog 时也要回结构完整的空目录，而不是报错
      const catalog = await call('list_runtime_catalog')
      expect(catalog.ok).toBe(true)
      const catalogValue = catalog.value as Record<string, unknown>
      expect(catalogValue.source).toBe('github')
      expect(catalogValue.catalog).toEqual([])
      // 浏览器 guest 已接：未注入 guests 时也要报「壳未接」，而不是回到「尚未移植」
      const guest = await call('browser_guest_acquire')
      expect(String(guest.error)).toContain('壳未接浏览器 guest')
      // 下载管理器也没接时：报清楚原因（接了就走真管理器，见 downloads.test.ts）
      const blob = await call('start_blob_download')
      expect(String(blob.error)).toContain('未接下载管理器')
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

  test('页面 console：按客户端契约 `{level,msg,pageUrl}` 交给 logPageConsole，不再丢字段', async () => {
    const seen: { level: string; msg: string; pageUrl: string | null }[] = []
    const h = harness({ logPageConsole: (input) => seen.push(input) })
    try {
      await h.table.log_console?.({ level: 'warn', msg: '来自页面', pageUrl: 'http://127.0.0.1:1/x' })
      expect(seen).toEqual([{ level: 'warn', msg: '来自页面', pageUrl: 'http://127.0.0.1:1/x' }])
      // 壳未接时退回老路：至少不报错、消息进壳日志
      const bare = harness()
      try {
        await bare.table.log_console?.({ level: 'error', msg: '裸壳' })
        expect(bare.calls.log.some((line) => line.includes('裸壳'))).toBe(true)
      } finally {
        bare.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  test('log_diag 进壳日志；get/export_diagnostics 未接时报清楚原因', async () => {
    const h = harness()
    try {
      await h.table.log_diag?.({ msg: '外链被拦' })
      expect(h.calls.log.some((line) => line.includes('[diag] 外链被拦'))).toBe(true)
      // 同步抛（命令表直调），所以用 toThrow 而不是 rejects
      expect(() => h.table.get_diagnostics?.({})).toThrow('壳未接诊断快照')
      expect(() => h.table.export_diagnostics?.({})).toThrow('壳未接诊断导出')
    } finally {
      h.cleanup()
    }
  })

  test('接了诊断：get 回快照、export 回路径与字节数', async () => {
    const h = harness({
      diagnostics: () => ({ summary: 'desktop · installed 0.2.1-alpha.2' }),
      exportDiagnostics: () => ({ path: '/home/.dsh/diagnostics/diag-1.json', bytes: 2048 }),
    })
    try {
      const got = (await h.table.get_diagnostics?.({})) as { diagnostics: { summary: string } }
      expect(got.diagnostics.summary).toContain('desktop')
      const exported = (await h.table.export_diagnostics?.({})) as { path: string; bytes: number }
      expect(exported).toEqual({ path: '/home/.dsh/diagnostics/diag-1.json', bytes: 2048 })
    } finally {
      h.cleanup()
    }
  })
})


describe('多窗口的数据面（列表类命令要看到别的 profile / 正在跑的运行时）', () => {
  test('list_profile_ports：行来自磁盘 profile ∪ 共享台账，自己那行用活值且排最前', async () => {
    const h = harness({
      ports: () => ({ port: 6393, lanePort: 6397 }),
      profiles: () => ['desktop', 'mobile', 'web'],
      portClaims: async () => [
        { profile: 'desktop', port: 6391, lanePort: 6398, pid: process.pid, startedAt: '2026-10-11T00:00:00.000Z' },
        { profile: 'web', port: 6391, lanePort: 6398, pid: process.pid, startedAt: '2026-10-11T00:00:00.000Z' },
        { profile: 'ghost', port: 6500, lanePort: 6501, pid: 999_999, startedAt: '2026-10-11T00:00:00.000Z' },
      ],
    })
    try {
      const rows = (await h.table.list_profile_ports?.({})) as Array<Record<string, unknown>>
      // 自己（desktop）在最前，且端口用本份服务面的活值，不是台账里的旧值
      expect(rows[0]).toEqual({ profile: 'desktop', port: 6393, lane_port: 6397, running: true })
      // 兄弟 profile 从台账里读，还活着 ⇒ running（顺序按名字，所以按 profile 查而不是按位置）
      const web = rows.find((row) => row.profile === 'web')
      expect(web).toEqual({ profile: 'web', port: 6391, lane_port: 6398, running: true })
      // 线程目录里没有的 profile 也要能被选中
      expect(rows.map((row) => row.profile)).toContain('mobile')
      // 台账里 pid 已死的照样列出来，但标成没在跑
      const ghost = rows.find((row) => row.profile === 'ghost')
      expect(ghost?.running).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('list_runtime_catalog：带上正在跑的那棵树，面板才能标「运行中」', async () => {
    const h = harness({
      runtime: () => ({
        mode: 'builtin',
        builtinVersion: null,
        activeVersion: '0.2.1-alpha.2',
        activeKind: 'override',
        activeDir: '/tmp/spike-rt/0.2.1-alpha.2',
        selected: null,
        installed: [],
        externalPath: null,
        externalVersion: null,
      }),
    })
    try {
      const value = (await h.table.list_runtime_catalog?.({})) as Record<string, unknown>
      expect(value.selected).toBeNull()
      expect(value.builtin).toBeNull()
      expect(value.running).toEqual({
        kind: 'override',
        version: '0.2.1-alpha.2',
        dir: '/tmp/spike-rt/0.2.1-alpha.2',
      })
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

// profile 运维与启动检查的命令边界（旧壳 commands.rs:252/541/711/737/758）。
// 守的是：启动弹窗拿到的是**客户端读得懂的字段名**（details 用 snake_case），迁移/重建/连接
// 都真把活派给注入的回调；报错带上能直接给用户看的句子（面板原样显示这些字符串）。
describe('profile 运维与启动检查', () => {
  test('启动检查：默认健全 ⇒ none；profile 残缺 ⇒ 三项明细用 snake_case', async () => {
    const healthy = harness()
    const broken = harness({
      profileHealth: () => ({ dirExists: true, missingFiles: ['cordis.yml'], nodeModulesExists: false }),
    })
    try {
      expect(await healthy.table['check_startup_needed']?.({})).toEqual({ action: 'none' })
      expect(await broken.table['check_startup_needed']?.({})).toEqual({
        action: 'profile-incomplete',
        profile: 'desktop',
        details: { dir_exists: true, missing_files: ['cordis.yml'], node_modules_exists: false },
      })
    } finally {
      healthy.cleanup()
      broken.cleanup()
    }
  })

  test('启动检查：存量安装且没设 active_profile ⇒ 让用户选（profiles 来自壳）', async () => {
    const h = harness({
      profiles: () => ['desktop', 'web'],
      settings: () => ({ ...defaultSettings(), activeProfile: undefined }),
    })
    try {
      expect(await h.table['check_startup_needed']?.({})).toEqual({
        action: 'profile-selection',
        profiles: ['desktop', 'web'],
      })
      // 全新安装：不弹选择（没得选）
      const fresh = harness({ freshInstall: () => true, settings: () => ({ ...defaultSettings(), activeProfile: undefined }) })
      try {
        expect(await fresh.table['check_startup_needed']?.({})).toEqual({ action: 'none' })
      } finally {
        fresh.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  test('确认启动：名字非法直接拒；合法的记「已确认」+ 写 pending + 把 repair 传下去', async () => {
    const confirmed: Array<{ profile: string; repair: boolean }> = []
    let checked = 0
    let pending: string | null = null
    const h = harness({
      markStartupChecked: () => {
        checked += 1
      },
      setPendingProfile: (profile) => {
        pending = profile
      },
      takePendingProfile: () => {
        const value = pending
        pending = null
        return value
      },
      confirmStartupProfile: async (profile, repair) => {
        confirmed.push({ profile, repair })
      },
    })
    try {
      await expect(h.table['confirm_startup_profile']?.({ name: '有中文' })).rejects.toThrow('名称仅允许')
      expect(await h.table['confirm_startup_profile']?.({ name: 'web', repair: true })).toEqual({})
      expect(confirmed).toEqual([{ profile: 'web', repair: true }])
      expect(checked).toBe(1)
      // pending 由前端取走即清（旧壳 get_pending_active_profile 同语义）
      expect(await h.table['get_pending_active_profile']?.({})).toBe('web')
      expect(await h.table['get_pending_active_profile']?.({})).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('依赖重建：该 profile 在跑 ⇒ 拒（带端口）；不在跑 ⇒ 真调重建', async () => {
    const rebuilt: string[] = []
    const running = harness({
      runningPortOfProfile: async () => 6393,
      rebuildProfile: async (profile) => {
        rebuilt.push(profile)
        return 'x'
      },
    })
    const idle = harness({
      runningPortOfProfile: async () => null,
      rebuildProfile: async (profile) => {
        rebuilt.push(profile)
        return `${profile}：依赖已重建`
      },
    })
    try {
      await expect(running.table['rebuild_profile_dependencies']?.({ profile: 'desktop' })).rejects.toThrow(
        'desktop 正在运行（端口 6393）',
      )
      expect(rebuilt).toEqual([])
      expect(await idle.table['rebuild_profile_dependencies']?.({ profile: 'desktop' })).toBe('desktop：依赖已重建')
      expect(rebuilt).toEqual(['desktop'])
    } finally {
      running.cleanup()
      idle.cleanup()
    }
  })

  test('迁移：source/dest/overwrite 原样传下去，总结原样回给面板', async () => {
    const calls: Array<[string, string, boolean]> = []
    const h = harness({
      migrateProfile: async (source, dest, overwrite) => {
        calls.push([source, dest, overwrite])
        return '已迁移 desktop → web：文件 3、目录 2、链接 0、排除 1'
      },
      migrationStatus: () => ({ running: false, copied: 3, total: 3 }),
    })
    try {
      const summary = await h.table['migrate_profile']?.({ source: 'desktop', dest: 'web', overwrite: true })
      expect(summary).toBe('已迁移 desktop → web：文件 3、目录 2、链接 0、排除 1')
      expect(calls).toEqual([['desktop', 'web', true]])
      expect(await h.table['migration_status']?.({})).toEqual({ running: false, copied: 3, total: 3 })
    } finally {
      h.cleanup()
    }
  })

  test('代理连接测试：空地址拒；其余交给注入的 IO（回耗时 ms）', async () => {
    const h = harness({ testProxy: async (url) => (url.includes('127.0.0.1') ? 12 : 0) })
    const bare = harness()
    try {
      await expect(h.table['test_proxy_connectivity']?.({ url: '' })).rejects.toThrow('代理地址为空')
      expect(await h.table['test_proxy_connectivity']?.({ url: 'http://127.0.0.1:7890' })).toBe(12)
      await expect(bare.table['test_proxy_connectivity']?.({ url: 'http://127.0.0.1:7890' })).rejects.toThrow(
        '壳未接连接测试',
      )
    } finally {
      h.cleanup()
      bare.cleanup()
    }
  })

describe('本轮补的四条命令形状（对齐旧壳，F1/F2/F3/B3）', () => {
  test('get_proxy_settings 回六字段，effective 是对象而不是字符串', () => {
    const h = harness()
    try {
      const off = h.table['get_proxy_settings']?.({}) as Record<string, unknown>
      expect(Object.keys(off).sort()).toEqual(['effective', 'no_proxy', 'proxy_mode', 'proxy_pass', 'proxy_url', 'proxy_user'])
      expect(off['proxy_user']).toBe('')
      expect(off['proxy_pass']).toBe('')
      expect(off['effective']).toBeNull()
      // 真壳里这条由 service 接（设置面板看到的 effective 就是它算的）
      h.deps.proxyEffective = () => resolveProxyEnv(h.deps.settings())
      h.deps.save({ proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:7890', proxy_user: 'u', proxy_pass: 'p' })
      const manual = h.table['get_proxy_settings']?.({}) as Record<string, unknown>
      expect(manual['effective']).toEqual({
        http: 'http://u:p@127.0.0.1:7890',
        https: 'http://u:p@127.0.0.1:7890',
        all: null,
        no_proxy: 'localhost,127.0.0.1,::1',
      })
    } finally {
      h.cleanup()
    }
  })

  test('list_profile_dependency_status 回 {profiles:[…]}（面板读的就是这个键）', async () => {
    const h = harness({
      dependencyRows: async () => [
        { profile: 'desktop', recordedPnpm: '11.16.0', builtinPnpm: '11.16.0', needsRebuild: false, running: true },
      ],
    })
    try {
      const value = (await h.table['list_profile_dependency_status']?.({})) as { profiles: unknown[] }
      expect(value.profiles).toHaveLength(1)
      expect(value.profiles[0]).toEqual({
        profile: 'desktop',
        recordedPnpm: '11.16.0',
        builtinPnpm: '11.16.0',
        needsRebuild: false,
        running: true,
      })
    } finally {
      h.cleanup()
    }
  })

  test('task_status 回九字段；壳未接时回空任务而不是 undefined', async () => {
    const bare = harness()
    const wired = harness({
      taskStatus: () => ({
        running: true,
        finished: false,
        kind: 'migrate',
        title: '迁移 profile',
        stage: '复制文件',
        done: 3,
        total: 9,
        error: '',
        result: '',
      }),
    })
    try {
      expect(await wired.table['task_status']?.({})).toMatchObject({ kind: 'migrate', done: 3, total: 9 })
      expect(await bare.table['task_status']?.({})).toEqual({
        running: false,
        finished: false,
        kind: '',
        title: '',
        stage: '',
        done: 0,
        total: 0,
        error: '',
        result: '',
      })
    } finally {
      bare.cleanup()
      wired.cleanup()
    }
  })

  test('快捷键偏好：读写透传原始文本；壳未接时读回 null、写报错', async () => {
    const writes: string[] = []
    const h = harness({
      keybindings: { read: () => '{"schemaVersion":1}', write: (raw) => writes.push(raw) },
    })
    const bare = harness()
    try {
      expect(await h.table['read_desktop_keybindings']?.({})).toBe('{"schemaVersion":1}')
      expect(await h.table['write_desktop_keybindings']?.({ raw: '{}\n' })).toEqual({})
      expect(writes).toEqual(['{}\n'])
      expect(() => h.table['write_desktop_keybindings']?.({})).toThrow('raw 必须是字符串')
      expect(await bare.table['read_desktop_keybindings']?.({})).toBeNull()
      expect(() => bare.table['write_desktop_keybindings']?.({ raw: '{}' })).toThrow('壳未接快捷键偏好')
    } finally {
      h.cleanup()
      bare.cleanup()
    }
  })

  test('F12/F13/F14：确认回填同槽转发、zoom 切换、代理保存走 save 且回 effective', async () => {
    const confirms: Array<[string, string]> = []
    let zooms = 0
    const h = harness({
      inputConfirm: (flow, value) => confirms.push([flow, value]),
      zoomToggle: () => {
        zooms += 1
      },
      proxyEffective: () => ({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', all: '', no_proxy: 'localhost' }),
    })
    try {
      expect(await h.table['ui_input_confirm']?.({ flow: 'register-cli', value: 'force' })).toEqual({ ok: true })
      expect(confirms).toEqual([['register-cli', 'force']])

      expect(await h.table['toggle_zoom']?.({})).toEqual({ ok: true })
      expect(zooms).toBe(1)
      const bareZoom = harness()
      try {
        expect(() => bareZoom.table['toggle_zoom']?.({})).toThrow('zoom 切换未就绪')
      } finally {
        bareZoom.cleanup()
      }

      const saved: Array<Record<string, unknown>> = []
      const proxy = harness({
        save: (patch) => {
          saved.push(patch)
          return proxy.deps.settings()
        },
        proxyEffective: () => null,
      })
      try {
        const result = (await proxy.table['save_proxy_settings']?.({
          proxy_mode: 'manual',
          proxy_url: 'http://127.0.0.1:7890',
          bad_field: 'x',
        })) as { ok: boolean; effective: unknown }
        expect(result.ok).toBe(true)
        expect(saved).toEqual([{ proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:7890' }])
        expect(() => proxy.table['save_proxy_settings']?.({ bad_field: 'x' })).toThrow('没有可保存的字段')
      } finally {
        proxy.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })
})
})
