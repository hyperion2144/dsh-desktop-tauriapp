/**
 * 浏览器 guest 管理器（旧壳 `desktop/src-tauri/src/ui/browser_guests/mod.rs` 的等价物）。
 *
 * 一个 guest = 挂宿主窗口上的一枚子 webview（Electrobun `BrowserView`，`sandbox: true`：
 * 不可信内容不开 RPC，只保留事件），由壳在这里维护租约台账、把状态**推**回宿主页面。
 *
 * 为什么是「推」：dsh 对 `<webview>` 的 getURL/isLoading/canGoBack 是**同步拉取**，而壳↔页面的
 * IPC 是异步的——client 端维护一份镜像，壳在每次状态变化后 eval 一条
 * `__dshShellBridgeImpl._receive(快照)`（旧壳同款做法，见其模块头注释）。
 *
 * 本文件**不 import electrobun**：视图由 `createView` 注入（index.ts 里给真 `BrowserView`，
 * 单测里给假视图），历史与几何走 `native-webview.ts` 的原生核。
 */

import {
  EMPTY_GUEST_STATE,
  GUEST_DEFAULT_URL,
  GUEST_LOAD_TIMEOUT_MS,
  GUEST_WARMUP_MS,
  detailUrl,
  guestControlAction,
  nativeAllowsNavigation,
  guestNavigationAllowed,
  guestPartition,
  guestPush,
  guestReporterScript,
  hostOpenRequestedScript,
  hostReceiveScript,
  newGuestLease,
  normalizeGuestRect,
  parseGuestReport,
  type GuestPush,
  type GuestPushKind,
  type GuestReservation,
  type GuestState,
} from '../shared/guest-policy.ts'
import type { NativeWebviewCore } from './native-webview.ts'

/** 视图事件的最小形状（Electrobun 的 `BrowserView.on`）。 */
export interface GuestViewLike {
  id: number
  executeJavascript(js: string): void
  loadURL(url: string): void
  remove(): void
  on(name: string, handler: (event: { data?: { detail?: unknown } }) => void): void
}

/** 调用方（哪个窗口发的命令；view token 台账里有 label 与 profile）。 */
export interface GuestCaller {
  label: string
  profile: string
}

export interface GuestManagerOptions {
  log: (line: string) => void
  /** 原生核；null = 拿不到（几何与历史降级成一条日志，guest 仍可创建/导航） */
  core: NativeWebviewCore | null
  /** 建视图；窗口不在了返回 null */
  createView: (input: { lease: string; partition: string; caller: GuestCaller }) => GuestViewLike | null
  /** 把脚本推给宿主页面（该 caller 所在窗口） */
  pushToHost: (caller: GuestCaller, script: string) => void
  /** 策略里额外的应用宿主（运行时放行的远程 dsh 主机） */
  appHosts?: () => readonly string[]
  now?: () => number
  loadTimeoutMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 冷分区首次创建后的就绪等待上限（CEF 请求上下文预热，默认 1200ms） */
  warmupMs?: number
  /** 等待用（测试注入空实现就能跳过真实计时） */
  sleep?: (ms: number) => Promise<void>
}

interface GuestEntry {
  lease: string
  caller: GuestCaller
  partition: string
  view: GuestViewLike
  state: GuestState
  bounds: { x: number; y: number; width: number; height: number } | null
  visible: boolean
  loadToken: number
  timer: unknown
  /** 已经发过 dom-ready / did-navigate（冷分区预热的判据） */
  ready: boolean
  settleReady: (() => void) | null
}

export interface GuestCommands {
  acquire(args: Record<string, unknown>, caller: GuestCaller): Promise<GuestReservation>
  release(args: Record<string, unknown>, caller: GuestCaller): Record<string, unknown>
  navigate(args: Record<string, unknown>, caller: GuestCaller): Record<string, unknown>
  control(args: Record<string, unknown>, caller: GuestCaller): GuestPush
  setBounds(args: Record<string, unknown>, caller: GuestCaller): Record<string, unknown>
  setVisible(args: Record<string, unknown>, caller: GuestCaller): Record<string, unknown>
  state(args: Record<string, unknown>, caller: GuestCaller): GuestPush
  releaseAll(args: Record<string, unknown>, caller: GuestCaller): Record<string, unknown>
  /** 关窗/退出时按宿主标签批量回收（返回回收条数） */
  releaseHost(label: string): number
  count(): number
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

/** 创建 guest 管理器。 */
export function createGuestManager(options: GuestManagerOptions): GuestCommands {
  const entries = new Map<string, GuestEntry>()
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const loadTimeoutMs = options.loadTimeoutMs ?? GUEST_LOAD_TIMEOUT_MS
  const warmupMs = options.warmupMs ?? GUEST_WARMUP_MS
  /** 已经预热过的分区：只有冷分区才需要等就绪（CEF 请求上下文首次创建会抢跑失败） */
  const warmPartitions = new Set<string>()
  let seq = 0
  let degradedLogged = false

  const degrade = (what: string): void => {
    if (degradedLogged) return
    degradedLogged = true
    options.log(`[guest] ${what}：原生核不可用，几何与历史按钮降级（其余功能不受影响）`)
  }

  const refreshHistory = (entry: GuestEntry): void => {
    if (options.core === null) {
      degrade('读历史')
      entry.state.canGoBack = entry.state.url !== '' && entry.state.url !== GUEST_DEFAULT_URL
      return
    }
    try {
      entry.state.canGoBack = options.core.canGoBack(entry.view.id)
      entry.state.canGoForward = options.core.canGoForward(entry.view.id)
    } catch (error) {
      options.log(`[guest] 读历史失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 冷分区预热：视图发过 dom-ready / did-navigate 就算就绪。 */
  const settleReady = (entry: GuestEntry): void => {
    entry.ready = true
    const settle = entry.settleReady
    entry.settleReady = null
    settle?.()
  }

  const waitReady = async (entry: GuestEntry): Promise<boolean> => {
    const already = entry.ready
    if (already) return true
    const ready = new Promise<boolean>((resolve) => {
      entry.settleReady = () => resolve(true)
    })
    const timedOut = (options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(warmupMs).then(() => false)
    const ok = await Promise.race([ready, timedOut])
    entry.settleReady = null
    return ok
  }

  const push = (entry: GuestEntry, kind: GuestPushKind): void => {
    options.pushToHost(entry.caller, hostReceiveScript(guestPush(entry.lease, kind, entry.state)))
  }

  const armWatchdog = (entry: GuestEntry): void => {
    entry.loadToken += 1
    const token = entry.loadToken
    if (entry.timer !== null) clearTimer(entry.timer)
    entry.timer = setTimer(() => {
      const live = entries.get(entry.lease)
      if (live === undefined) return
      if (!live.state.loading || live.loadToken !== token) return
      live.state.loading = false
      options.log(`[guest] 加载超时判失败：${live.lease}`)
      push(live, 'failed')
    }, loadTimeoutMs)
  }

  const applyReport = (entry: GuestEntry, detail: unknown): void => {
    const report = parseGuestReport(detail)
    if (report === null) return
    entry.state.url = report.url === '' ? entry.state.url : report.url
    entry.state.title = report.title
    entry.state.loading = report.loading
    if (report.kind === 'finished') refreshHistory(entry)
    push(entry, report.kind)
  }

  const attach = (entry: GuestEntry): void => {
    const view = entry.view
    view.on('dom-ready', (event) => {
      const url = detailUrl(event.data?.detail)
      if (url !== '') entry.state.url = url
      entry.state.loading = false
      refreshHistory(entry)
      view.executeJavascript(guestReporterScript())
      push(entry, 'finished')
      settleReady(entry)
    })
    view.on('did-navigate', (event) => {
      const url = detailUrl(event.data?.detail)
      if (url !== '') entry.state.url = url
      entry.state.loading = true
      armWatchdog(entry)
      push(entry, 'started')
      settleReady(entry)
    })
    view.on('did-navigate-in-page', (event) => {
      const url = detailUrl(event.data?.detail)
      if (url !== '') entry.state.url = url
      refreshHistory(entry)
      push(entry, 'title')
    })
    view.on('will-navigate', (event) => {
      const detail = event.data?.detail
      const url = detailUrl(detail)
      if (url === '') return
      if (nativeAllowsNavigation(detail) === false) return
      if (guestNavigationAllowed(url, { appHosts: options.appHosts?.() ?? [] })) return
      options.log(`[guest] 导航被策略拒绝：${url}`)
      view.loadURL(GUEST_DEFAULT_URL)
    })
    view.on('new-window-open', (event) => {
      const detail = event.data?.detail
      const url =
        typeof detail === 'string'
          ? detail
          : typeof detail === 'object' && detail !== null && typeof (detail as { url?: unknown }).url === 'string'
            ? String((detail as { url: string }).url)
            : ''
      if (url === '') return
      options.log(`[guest] 新窗口请求交回 dsh：${url}`)
      options.pushToHost(entry.caller, hostOpenRequestedScript(entry.lease, url))
    })
    view.on('host-message', (event) => {
      applyReport(entry, event.data?.detail)
    })
    view.on('download-started', () => {
      options.log('[guest] guest 内下载请求（旧壳一律拒绝；Electrobun 无取消 API，仅记录）')
    })
  }

  const requireEntry = (args: Record<string, unknown>, caller: GuestCaller): GuestEntry => {
    const lease = stringArg(args, 'lease')
    const entry = entries.get(lease)
    if (entry === undefined) throw new Error(`浏览器 guest 不在（lease=${lease || '空'}）`)
    if (entry.caller.label !== caller.label) {
      throw new Error('浏览器 guest 不属于这个窗口')
    }
    return entry
  }

  const drop = (entry: GuestEntry, kind: GuestPushKind): void => {
    if (entry.timer !== null) clearTimer(entry.timer)
    try {
      entry.view.remove()
    } catch (error) {
      options.log(`[guest] 移除视图失败：${error instanceof Error ? error.message : String(error)}`)
    }
    push(entry, kind)
    entries.delete(entry.lease)
  }

  return {
    async acquire(args, caller) {
      const workspaceKey = stringArg(args, 'workspaceKey') || caller.profile
      const lease = newGuestLease(seq, now())
      seq += 1
      const partition = guestPartition(workspaceKey)
      const cold = !warmPartitions.has(partition)
      const build = (): GuestEntry => {
        const view = options.createView({ lease, partition, caller })
        if (view === null) throw new Error(`浏览器 guest 无法创建：窗口不在（${caller.label}）`)
        const built: GuestEntry = {
          lease,
          caller,
          partition,
          view,
          state: { ...EMPTY_GUEST_STATE },
          bounds: null,
          visible: false,
          loadToken: 0,
          timer: null,
          ready: false,
          settleReady: null,
        }
        entries.set(lease, built)
        attach(built)
        return built
      }
      let entry = build()
      if (cold) {
        // 实测：某个 partition 的首次创建会让 CEF 抢跑（`CreateBrowserSync` 返回 null、浏览器没挂到
        // webview，也没有 `cef mapping` 行）——之后同一 partition 再建就正常。所以冷分区等一个就绪信号，
        // 等不到就丢掉重建一次（视图还没显示过，不必推 gone）。
        const ready = await waitReady(entry)
        if (!ready) {
          options.log(`[guest] 分区 ${partition} 首次创建未就绪，重建视图（CEF 请求上下文预热）`)
          if (entry.timer !== null) clearTimer(entry.timer)
          try {
            entry.view.remove()
          } catch (error) {
            options.log(`[guest] 丢弃未就绪视图失败：${error instanceof Error ? error.message : String(error)}`)
          }
          entries.delete(entry.lease)
          entry = build()
          await waitReady(entry)
        }
        warmPartitions.add(partition)
      }
      options.log(`[guest] acquire：lease=${lease} workspace=${workspaceKey} view=${entry.view.id} partition=${partition}`)
      return { lease, partition }
    },
    release(args, caller) {
      const entry = requireEntry(args, caller)
      drop(entry, 'gone')
      options.log(`[guest] release：lease=${entry.lease}`)
      return { ok: true }
    },
    navigate(args, caller) {
      const entry = requireEntry(args, caller)
      const url = stringArg(args, 'url')
      if (url === '') throw new Error('browser_guest_navigate: url 不能为空')
      if (!guestNavigationAllowed(url, { appHosts: options.appHosts?.() ?? [] })) {
        throw new Error(`导航被策略拒绝：${url}`)
      }
      entry.state.loading = true
      entry.view.loadURL(url)
      return { ok: true, url }
    },
    control(args, caller) {
      const entry = requireEntry(args, caller)
      const action = guestControlAction(stringArg(args, 'action'))
      if (action === null) throw new Error(`browser_guest_control: 未知动作（${stringArg(args, 'action')}）`)
      if (options.core === null) {
        degrade('历史动作')
      } else if (action === 'back') {
        options.core.goBack(entry.view.id)
      } else if (action === 'forward') {
        options.core.goForward(entry.view.id)
      } else {
        options.core.reload(entry.view.id)
        entry.state.loading = true
      }
      // 历史动作是异步生效的：稍后补读一次可用性，再推快照（旧壳是 Finished 后补读）。
      setTimer(() => {
        const live = entries.get(entry.lease)
        if (live === undefined) return
        refreshHistory(live)
        push(live, 'title')
      }, 150)
      refreshHistory(entry)
      return guestPush(entry.lease, 'title', entry.state)
    },
    setBounds(args, caller) {
      const entry = requireEntry(args, caller)
      // dsh 前端按旧壳命令签名发的是**平铺**字段 `{lease,x,y,width,height}`（见 client 的
      // desktop-browser-bridge `browser_guest_set_bounds`）——也兼容 `{rect}` 形态。
      const source = typeof args.rect === 'object' && args.rect !== null ? (args.rect as Record<string, unknown>) : args
      const rect = normalizeGuestRect(source)
      if (rect === null) throw new Error('browser_guest_set_bounds: rect 形状不对')
      entry.bounds = rect
      if (options.core === null) {
        degrade('设置几何')
      } else {
        options.core.resize(entry.view.id, rect)
      }
      return { ok: true, rect }
    },
    setVisible(args, caller) {
      const entry = requireEntry(args, caller)
      const visible = args.visible === true
      entry.visible = visible
      if (options.core === null) {
        degrade('显隐')
      } else {
        options.core.setHidden(entry.view.id, !visible)
      }
      return { ok: true, visible }
    },
    state(args, caller) {
      const entry = requireEntry(args, caller)
      refreshHistory(entry)
      return guestPush(entry.lease, 'state', entry.state)
    },
    releaseAll(_args, caller) {
      let released = 0
      for (const entry of [...entries.values()]) {
        if (entry.caller.label !== caller.label) continue
        drop(entry, 'gone')
        released += 1
      }
      options.log(`[guest] release_all：${caller.label} 回收 ${released} 个`)
      return { ok: true, released }
    },
    releaseHost(label) {
      let released = 0
      for (const entry of [...entries.values()]) {
        if (entry.caller.label !== label) continue
        drop(entry, 'gone')
        released += 1
      }
      return released
    },
    count() {
      return entries.size
    },
  }
}
