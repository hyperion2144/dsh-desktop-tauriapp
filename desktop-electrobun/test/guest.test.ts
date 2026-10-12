// 浏览器 guest（#118/#134）的纯逻辑 + 管理器单测。
//
// 旧壳对应测试在 `desktop/src-tauri/src/ui/browser_guests/{policy.rs,mod.rs}` 的 `#[cfg(test)]` 里；
// 这里除了策略，还覆盖「状态推送」这条最容易悄悄坏掉的链路（dsh 对 `<webview>` 是同步拉取，
// 少了推送就是「永远正在打开…」）。

import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import {
  EMPTY_GUEST_STATE,
  GUEST_DEFAULT_URL,
  GUEST_LEASE_PATTERN,
  OFFSCREEN_GUEST_RECT,
  fnv64Hex,
  guestControlAction,
  guestNavigationAllowed,
  guestPartition,
  guestPush,
  guestReporterScript,
  hostOpenRequestedScript,
  hostReceiveScript,
  isGuestLabel,
  newGuestLease,
  detailUrl,
  nativeAllowsNavigation,
  normalizeGuestRect,
  parseGuestReport,
  type GuestPush,
} from '../src/shared/guest-policy.ts'
import { createGuestManager, type GuestViewLike } from '../src/bun/guest-manager.ts'
import { coreLibCandidates, coreLibNames, loadNativeWebviewCore, type NativeWebviewCore } from '../src/bun/native-webview.ts'
import { carrierScript } from '../src/bun/carrier.ts'

/** 假视图：记录调用，可手动发事件。 */
function fakeView(id = 7) {
  const handlers = new Map<string, Array<(event: { data?: { detail?: unknown } }) => void>>()
  const calls = { js: [] as string[], urls: [] as string[], removed: 0 }
  const view: GuestViewLike = {
    id,
    executeJavascript: (js) => void calls.js.push(js),
    loadURL: (url) => void calls.urls.push(url),
    remove: () => void (calls.removed += 1),
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
    },
  }
  return {
    view,
    calls,
    emit: (name: string, detail?: unknown): void => {
      for (const handler of handlers.get(name) ?? []) handler({ data: { detail } })
    },
  }
}

/** 假原生核：记录历史动作与几何。 */
function fakeCore(overrides: Partial<NativeWebviewCore> = {}) {
  const calls = { back: [] as number[], forward: [] as number[], reload: [] as number[], hidden: [] as Array<[number, boolean]>, resized: [] as Array<[number, unknown]> }
  const core: NativeWebviewCore = {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: (id) => void calls.back.push(id),
    goForward: (id) => void calls.forward.push(id),
    reload: (id) => void calls.reload.push(id),
    setHidden: (id, hidden) => void calls.hidden.push([id, hidden]),
    resize: (id, rect) => void calls.resized.push([id, rect]),
    ...overrides,
  }
  return { core, calls }
}

const CALLER = { label: 'profile-desktop', profile: 'desktop' }

describe('guest 导航策略（旧壳 policy.rs 的等价物）', () => {
  test('放行外部 http/https 与 about:', () => {
    expect(guestNavigationAllowed('https://www.baidu.com/')).toBe(true)
    expect(guestNavigationAllowed('http://example.org:8080/path?q=1')).toBe(true)
    expect(guestNavigationAllowed('about:blank')).toBe(true)
  })

  test('拒带凭证 URL 与应用宿主', () => {
    expect(guestNavigationAllowed('https://user:pass@example.com/')).toBe(false)
    expect(guestNavigationAllowed('https://user@example.com/')).toBe(false)
    expect(guestNavigationAllowed('http://127.0.0.1:3080/api')).toBe(false)
    expect(guestNavigationAllowed('http://localhost:3081/')).toBe(false)
    expect(guestNavigationAllowed('http://[::1]:3080/')).toBe(false)
    expect(guestNavigationAllowed('http://dshapp.localhost/assets/a.js')).toBe(false)
    // 运行时放行的远程 dsh 主机：由调用方作为额外宿主传进来
    expect(guestNavigationAllowed('http://192.168.3.90:3093/x', { appHosts: ['192.168.3.90'] })).toBe(false)
    expect(guestNavigationAllowed('http://192.168.3.90:3093/x')).toBe(true)
  })

  test('其余 scheme 一律拒（file/data/javascript/ftp/垃圾串）', () => {
    expect(guestNavigationAllowed('file:///etc/passwd')).toBe(false)
    expect(guestNavigationAllowed('data:text/html,<script>1</script>')).toBe(false)
    expect(guestNavigationAllowed('javascript:alert(1)')).toBe(false)
    expect(guestNavigationAllowed('ftp://example.com/')).toBe(false)
    expect(guestNavigationAllowed('not a url')).toBe(false)
    expect(guestNavigationAllowed('')).toBe(false)
  })
})

describe('租约 / partition / 标签', () => {
  test('租约形状与唯一性', () => {
    const first = newGuestLease(0, 1_700_000_000_000)
    const second = newGuestLease(1, 1_700_000_000_000)
    const third = newGuestLease(1, 1_700_000_000_001)
    for (const lease of [first, second, third]) expect(GUEST_LEASE_PATTERN.test(lease)).toBe(true)
    expect(new Set([first, second, third]).size).toBe(3)
  })

  test('partition 按 workspace 确定性派生', () => {
    expect(guestPartition('workspace-a')).toBe(guestPartition('workspace-a'))
    expect(guestPartition('workspace-a')).not.toBe(guestPartition('workspace-b'))
    expect(guestPartition('workspace-a')).toMatch(/^persist:ws-[0-9a-f]{16}$/)
    expect(fnv64Hex('workspace-a')).toHaveLength(16)
    expect(guestPartition('')).toBe(guestPartition('default'))
  })

  test('标签前缀判定', () => {
    expect(isGuestLabel('browser-guest-g0001abcdef0123456789ab')).toBe(true)
    expect(isGuestLabel('main')).toBe(false)
  })
})

describe('矩形 / 动作 / 推送形状', () => {
  test('矩形归一化：取整、夹取、坏值回 null', () => {
    expect(normalizeGuestRect({ x: 10.4, y: -3.6, width: 800.2, height: 600.8 })).toEqual({
      x: 10,
      y: -4,
      width: 800,
      height: 601,
    })
    expect(normalizeGuestRect({ x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(normalizeGuestRect({ x: 0, y: 0, width: 99999, height: 1 })).toEqual({ x: 0, y: 0, width: 20_000, height: 1 })
    expect(normalizeGuestRect(null)).toBeNull()
    expect(normalizeGuestRect({ x: 0, y: 0, width: Number.NaN, height: 10 })).toBeNull()
    expect(normalizeGuestRect({ x: '0', y: 0, width: 1, height: 1 })).toBeNull()
    expect(OFFSCREEN_GUEST_RECT).toEqual({ x: -20000, y: -20000, width: 1, height: 1 })
  })

  test('历史动作只认三个字面量', () => {
    expect(guestControlAction('back')).toBe('back')
    expect(guestControlAction('Forward')).toBe('forward')
    expect(guestControlAction(' reload ')).toBe('reload')
    expect(guestControlAction('stop')).toBeNull()
    expect(guestControlAction('')).toBeNull()
  })

  test('推送脚本：形状与 U+2028 转义', () => {
    const push = guestPush('g0001abc', 'finished', { ...EMPTY_GUEST_STATE, url: 'https://a.example/\u2028x', title: '标\u2029题' })
    expect(push.kind).toBe('finished')
    const script = hostReceiveScript(push)
    expect(script.startsWith('window.__dshShellBridgeImpl&&window.__dshShellBridgeImpl._receive(')).toBe(true)
    expect(script).not.toContain('\u2028')
    expect(script).toContain('\\u2028')
    expect(script).toContain('\\u2029')
    expect(hostOpenRequestedScript('g1', 'https://b.example/')).toContain('_openRequested')
  })

  test('注入 guest 的上报脚本用内置 preload 的 send', () => {
    const script = guestReporterScript()
    expect(script).toContain('__electrobunSendToHost')
    expect(script).toContain('__dshGuestReporter')
    expect(script).toContain('DOMContentLoaded')
  })

  test('解析上报：只认带标记的对象', () => {
    expect(parseGuestReport({ __dshGuest: 1, kind: 'title', url: 'https://a/', title: 'T', loading: false })).toEqual({
      kind: 'title',
      url: 'https://a/',
      title: 'T',
      loading: false,
    })
    expect(parseGuestReport({ kind: 'title' })).toBeNull()
    expect(parseGuestReport({ __dshGuest: 1, kind: 'nope' })).toBeNull()
    expect(parseGuestReport('https://a/')).toBeNull()
    expect(parseGuestReport(null)).toBeNull()
  })

  test('导航事件的 detail 两种形态都认（纯 URL 与 JSON 文本）', () => {
    expect(detailUrl('https://a.example/')).toBe('https://a.example/')
    expect(detailUrl('  https://a.example/x  ')).toBe('https://a.example/x')
    expect(detailUrl(JSON.stringify({ url: 'https://b.example/', allowed: true }))).toBe('https://b.example/')
    expect(detailUrl({ url: 'https://c.example/' })).toBe('https://c.example/')
    expect(detailUrl('')).toBe('')
    expect(detailUrl('{坏 JSON')).toBe('')
    expect(detailUrl(null)).toBe('')
    expect(detailUrl({ allowed: true })).toBe('')
    // 原生裁决：只有显式 false 才认为原生拦了
    expect(nativeAllowsNavigation(JSON.stringify({ url: 'https://a/', allowed: false }))).toBe(false)
    expect(nativeAllowsNavigation(JSON.stringify({ url: 'https://a/', allowed: true }))).toBe(true)
    expect(nativeAllowsNavigation('https://a/')).toBeNull()
  })
})

describe('原生核定位', () => {
  test('库名按平台', () => {
    expect(coreLibNames('darwin')).toEqual(['libElectrobunCore.dylib'])
    expect(coreLibNames('win32')).toEqual(['ElectrobunCore.dll'])
    expect(coreLibNames('linux')).toEqual(['libElectrobunCore.so'])
  })

  test('候选路径顺序：环境变量 → 可执行文件同目录 → Resources → 模块目录', () => {
    const candidates = coreLibCandidates(
      { execPath: '/app/Contents/MacOS/launcher', importDir: '/src/bun', env: { DSH_SHELL_CORE_LIB: '/tmp/core.dylib' } },
      'darwin',
    )
    expect(candidates[0]).toBe('/tmp/core.dylib')
    // 期望值用 join 算：Windows 上 join 产出反斜杠路径，写死 `/` 会误报
    expect(candidates[1]).toBe(join(dirname('/app/Contents/MacOS/launcher'), 'libElectrobunCore.dylib'))
    expect(candidates[2]).toBe(join('/app/Contents/Resources', 'libElectrobunCore.dylib'))
    expect(candidates).toContain(join('/src/bun', 'libElectrobunCore.dylib'))
  })

  test('找不到核：不抛，回 core:null 与原因', async () => {
    const probe = await loadNativeWebviewCore({ execPath: '/nope/launcher', importDir: '/nope/src', exists: () => false })
    expect(probe.core).toBeNull()
    expect(probe.libPath).toBeNull()
    expect(String(probe.error)).toContain('找不到原生核')
  })
})

describe('guest 管理器', () => {
  function manager(overrides: { core?: NativeWebviewCore | null; autoReady?: boolean[] } = {}) {
    const created: Array<{ lease: string; partition: string }> = []
    const views: Array<ReturnType<typeof fakeView>> = []
    const core = overrides.core === undefined ? fakeCore() : { core: overrides.core, calls: { back: [], forward: [], reload: [], hidden: [], resized: [] } }
    const pushed: string[] = []
    const logs: string[] = []
    const timers: Array<() => void> = []
    const ready = overrides.autoReady ?? []
    const table = createGuestManager({
      log: (line) => void logs.push(line),
      core: core.core,
      now: () => 1_700_000_000_000,
      // 就绪 / 超时都不要真等：冷分区预热在单测里走微任务
      sleep: async () => {},
      setTimer: (run) => {
        timers.push(run)
        return timers.length
      },
      clearTimer: () => {},
      createView: ({ lease, partition }) => {
        const index = created.length
        created.push({ lease, partition })
        const made = fakeView(index + 1)
        views.push(made)
        if (ready[index] !== false) {
          // 真窗口在导航完成时发 dom-ready；这里用一个微任务模拟（默认每个视图都就绪）
          queueMicrotask(() => made.emit('dom-ready', GUEST_DEFAULT_URL))
        }
        return made.view
      },
      pushToHost: (_caller, script) => void pushed.push(script),
    })
    return {
      table,
      // views 要等 acquire 才存在，所以用 getter（否则拿到的永远是那个空桩）
      get current() {
        return views[0] ?? fakeView()
      },
      views,
      created,
      core,
      pushed,
      logs,
      timers,
    }
  }

  const lastPush = (pushed: string[]): GuestPush => {
    const script = pushed[pushed.length - 1] ?? ''
    const json = script.slice(script.indexOf('(') + 1, script.lastIndexOf(')'))
    return JSON.parse(json) as GuestPush
  }

  test('acquire：建视图（屏幕外 + workspace partition）并回租约', async () => {
    const h = manager()
    const reservation = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    expect(GUEST_LEASE_PATTERN.test(reservation.lease)).toBe(true)
    expect(reservation.partition).toBe(guestPartition('ws-1'))
    expect(h.created[0]?.lease).toBe(reservation.lease)
    expect(h.logs.some((line) => line.includes('[guest] acquire'))).toBe(true)
    expect(h.table.count()).toBe(1)
  })

  test('窗口不在 ⇒ acquire 抛错（不静默失败）', async () => {
    const table = createGuestManager({
      log: () => {},
      core: null,
      createView: () => null,
      pushToHost: () => {},
    })
    await expect(table.acquire({ workspaceKey: 'ws' }, CALLER)).rejects.toThrow('无法创建')
  })

  test('冷分区首次创建没就绪 ⇒ 丢掉重建一次（CEF 请求上下文预热）', async () => {
    const h = manager({ autoReady: [false, true] })
    const reservation = await h.table.acquire({ workspaceKey: 'ws-cold' }, CALLER)
    expect(h.created.length).toBe(2)
    expect(h.created[0]?.partition).toBe(h.created[1]?.partition)
    expect(h.views[0]?.calls.removed).toBe(1)
    expect(h.logs.some((line) => line.includes('首次创建未就绪，重建视图'))).toBe(true)
    // 重建后的视图能收事件（租约没变）
    h.views[1]?.emit('dom-ready', 'https://a.example/')
    expect(lastPush(h.pushed)).toMatchObject({ lease: reservation.lease, kind: 'finished', url: 'https://a.example/' })
  })

  test('同一个 partition 第二次 acquire 不再等（预热过的快路径）', async () => {
    const h = manager({ autoReady: [false, true, true] })
    await h.table.acquire({ workspaceKey: 'ws-cold' }, CALLER)
    const before = h.created.length
    await h.table.acquire({ workspaceKey: 'ws-cold' }, CALLER)
    expect(h.created.length).toBe(before + 1)
    expect(h.logs.filter((line) => line.includes('重建视图')).length).toBe(1)
  })

  test('dom-ready：注入上报脚本并推 finished（带历史可用性）', async () => {
    const h = manager()
    const { lease } = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    h.current.emit('dom-ready', 'https://a.example/')
    expect(h.current.calls.js.some((js) => js.includes('__electrobunSendToHost'))).toBe(true)
    const push = lastPush(h.pushed)
    expect(push).toMatchObject({ lease, kind: 'finished', url: 'https://a.example/', loading: false, canGoBack: true, canGoForward: false })
  })

  test('did-navigate → started + 看门狗；host-message 上报 → title/finished', async () => {
    const h = manager()
    const { lease } = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    h.current.emit('did-navigate', 'https://b.example/')
    expect(lastPush(h.pushed)).toMatchObject({ lease, kind: 'started', loading: true })
    h.current.emit('host-message', { __dshGuest: 1, kind: 'title', url: 'https://b.example/', title: 'B 站', loading: true })
    expect(lastPush(h.pushed)).toMatchObject({ kind: 'title', title: 'B 站', loading: true })
    h.current.emit('host-message', { __dshGuest: 1, kind: 'finished', url: 'https://b.example/', title: 'B 站', loading: false })
    expect(lastPush(h.pushed)).toMatchObject({ kind: 'finished', loading: false })
    // 非 guest 上报被忽略（不产生推送）
    const before = h.pushed.length
    h.current.emit('host-message', { hello: 'world' })
    expect(h.pushed.length).toBe(before)
  })

  test('看门狗超时判失败（旧壳 30s 同款）', async () => {
    const h = manager()
    await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    h.current.emit('did-navigate', 'https://slow.example/')
    expect(h.timers.length).toBe(1)
    h.timers[0]?.()
    expect(lastPush(h.pushed)).toMatchObject({ kind: 'failed', loading: false })
  })

  test('will-navigate：纯 URL / JSON 文本两种 detail 都认，被拒就拉回 about:blank', async () => {
    const h = manager()
    await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    // 纯 URL 字符串（框架旧形态）
    h.current.emit('will-navigate', 'http://127.0.0.1:3080/api')
    expect(h.logs.some((line) => line.includes('导航被策略拒绝'))).toBe(true)
    // 实的原生态：JSON 文本 `{"url":…,"allowed":true}`
    h.current.emit('will-navigate', JSON.stringify({ url: 'https://ok.example/', allowed: true }))
    h.current.emit('will-navigate', JSON.stringify({ url: 'http://localhost:3081/x', allowed: true }))
    expect(h.current.calls.urls.filter((url) => url === GUEST_DEFAULT_URL)).toHaveLength(2)
  })

  test('will-navigate：原生已拦（allowed:false）就不重复拉回', async () => {
    const h = manager()
    await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    const before = h.current.calls.urls.length
    h.current.emit('will-navigate', JSON.stringify({ url: 'http://127.0.0.1:3080/api', allowed: false }))
    expect(h.current.calls.urls.length).toBe(before)
  })

  test('new-window-open ⇒ 交回 dsh 开新标签（不在应用内开窗）', async () => {
    const h = manager()
    const { lease } = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    h.current.emit('new-window-open', { url: 'https://c.example/', isCmdClick: true })
    const script = h.pushed[h.pushed.length - 1] ?? ''
    expect(script).toContain('_openRequested')
    expect(script).toContain('https://c.example/')
    expect(script).toContain(lease)
  })

  test('navigate 与 control：策略门 + 原生历史动作', async () => {
    const h = manager()
    const { lease } = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    expect(() => h.table.navigate({ lease, url: 'http://localhost:3080/' }, CALLER)).toThrow('导航被策略拒绝')
    h.table.navigate({ lease, url: 'https://d.example/' }, CALLER)
    expect(h.current.calls.urls).toContain('https://d.example/')
    const back = h.table.control({ lease, action: 'back' }, CALLER)
    expect(back.kind).toBe('title')
    expect(h.core.calls.back).toEqual([1])
    h.table.control({ lease, action: 'forward' }, CALLER)
    expect(h.core.calls.forward).toEqual([1])
    h.table.control({ lease, action: 'reload' }, CALLER)
    expect(h.core.calls.reload).toEqual([1])
    expect(() => h.table.control({ lease, action: 'stop' }, CALLER)).toThrow('未知动作')
    // 历史动作异步生效：补读的那一次推送在定时器里
    const before = h.pushed.length
    h.timers[h.timers.length - 1]?.()
    expect(h.pushed.length).toBe(before + 1)
  })

  test('setBounds/setVisible 落到原生核；坏矩形报错', async () => {
    const h = manager()
    const { lease } = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    // dsh 前端发的是平铺字段（旧壳签名）；`{rect}` 是我们自己的兼容形态
    h.table.setBounds({ lease, x: 12.6, y: 0, width: 640, height: 480 }, CALLER)
    expect(h.core.calls.resized[0]).toEqual([1, { x: 13, y: 0, width: 640, height: 480 }])
    expect(() => h.table.setBounds({ lease, rect: { x: 0 } }, CALLER)).toThrow('rect 形状不对')
    h.table.setVisible({ lease, visible: true }, CALLER)
    h.table.setVisible({ lease, visible: false }, CALLER)
    expect(h.core.calls.hidden).toEqual([
      [1, false],
      [1, true],
    ])
  })

  test('state 回快照；别人的窗口拿不到；release 推 gone 并卸视图', async () => {
    const h = manager()
    const { lease } = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    const snapshot = h.table.state({ lease }, CALLER)
    expect(snapshot).toMatchObject({ lease, kind: 'state', canGoBack: true })
    expect(() => h.table.state({ lease }, { label: 'profile-web', profile: 'web' })).toThrow('不属于这个窗口')
    h.table.release({ lease }, CALLER)
    expect(h.views[0]?.calls.removed).toBe(1)
    expect(lastPush(h.pushed)).toMatchObject({ lease, kind: 'gone' })
    expect(h.table.count()).toBe(0)
    expect(() => h.table.state({ lease }, CALLER)).toThrow('不在')
  })

  test('release_all / releaseHost 按窗口批量回收', async () => {
    const views: Array<ReturnType<typeof fakeView>> = []
    const logs: string[] = []
    let index = 0
    const table = createGuestManager({
      log: (line) => void logs.push(line),
      core: fakeCore().core,
      sleep: async () => {},
      createView: () => {
        const made = fakeView(index + 1)
        views.push(made)
        index += 1
        queueMicrotask(() => made.emit('dom-ready', GUEST_DEFAULT_URL))
        return made.view
      },
      pushToHost: () => {},
    })
    const first = await table.acquire({ workspaceKey: 'a' }, CALLER)
    await table.acquire({ workspaceKey: 'b' }, CALLER)
    const other = await table.acquire({ workspaceKey: 'c' }, { label: 'profile-web', profile: 'web' })
    expect(table.count()).toBe(3)
    const result = table.releaseAll({}, CALLER)
    expect(result).toEqual({ ok: true, released: 2 })
    expect(table.count()).toBe(1)
    expect(views[0]?.calls.removed).toBe(1)
    expect(logs.some((line) => line.includes('release_all'))).toBe(true)
    expect(table.releaseHost('profile-web')).toBe(1)
    expect(table.count()).toBe(0)
    expect(table.releaseHost('profile-web')).toBe(0)
    // 已被回收的租约不许再用
    expect(() => table.release({ lease: first.lease }, CALLER)).toThrow('不在')
    expect(() => table.state({ lease: other.lease }, { label: 'profile-web', profile: 'web' })).toThrow('不在')
  })

  test('原生核不可用：降级成一条日志，不假装成功也不崩', async () => {
    const h = manager({ core: null })
    const { lease } = await h.table.acquire({ workspaceKey: 'ws-1' }, CALLER)
    h.table.setBounds({ lease, rect: { x: 0, y: 0, width: 10, height: 10 } }, CALLER)
    h.table.setVisible({ lease, visible: true }, CALLER)
    h.table.control({ lease, action: 'back' }, CALLER)
    const degraded = h.logs.filter((line) => line.includes('原生核不可用'))
    expect(degraded).toHaveLength(1)
    expect(h.table.state({ lease }, CALLER).canGoBack).toBe(false)
  })
})

describe('dshDesktop 载体（旧壳 desktop_carrier_init_script 的等价物）', () => {
  const script = carrierScript('darwin')

  test('幂等安装 + 只在本窗口没装时装一次', () => {
    expect(script).toContain('if (globalThis.dshDesktop) return')
    expect(script).toContain('globalThis.dshDesktop = {')
    expect(script).toContain('protocolVersion: 1')
  })

  test('browser 三方法转发到 client 插件装的 __dshShellBridgeImpl', () => {
    expect(script).toContain('globalThis.__dshShellBridgeImpl')
    expect(script).toContain("acquire: browserForward('acquire')")
    expect(script).toContain("release: browserForward('release')")
    expect(script).toContain('onOpenRequested')
    // 桥没就绪时干净报错（旧壳 4s 宽限）
    expect(script).toContain("BRIDGE_WAIT = 4000")
  })

  test('键盘/快捷键桩轮询 __dshShellKeyboardImpl，超时降级不炸', () => {
    expect(script).toContain('globalThis.__dshShellKeyboardImpl')
    expect(script).toContain('KEYBOARD_WAIT = 30000')
    expect(script).toContain("closeWindow: forward('closeWindow')")
    expect(script).toContain("recording: forward('recording')")
    expect(script).toContain(".catch(() => {})")
  })

  test('平台标记写在 documentElement 上（带重试）', () => {
    expect(script).toContain('document.documentElement.dataset.platform = PLATFORM')
    expect(script).toContain('setTimeout(markPlatform, 0)')
    expect(script).toContain('PLATFORM = "darwin"')
    expect(carrierScript('win32')).toContain('PLATFORM = "win32"')
  })
})
