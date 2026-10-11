// 壳命令表：把旧壳的 Tauri 命令（`desktop/src-tauri/src/commands.rs`，62 个）逐步搬到 Bun。
//
// 本轮只接「桌面 chrome + 设置面板 + 通知 tab」真正会调的那些；其余命令**显式**回
// 「尚未移植」而不是静默成功——面板会把它显示成一条失败提示，比转圈或假装保存好。
// 命令实现全部只依赖注入的 deps，方便单测（不 import electrobun）。

import type { DesktopSettings, DshMode, RuntimeSource } from '../shared/settings.ts'
import type { RuntimeDownloadStatus } from './runtime-install.ts'
import type { CatalogEntry, InstalledRuntime } from '../shared/runtime-catalog.ts'
import { serializeSettings } from '../shared/settings.ts'
import { argNumber, argString, type RpcHandler } from './rpc.ts'
import type { Notifier } from './notifications.ts'

export interface CommandDeps {
  home: string
  profile: string
  /** 'darwin' | 'win32' | 'linux'（旧壳 `desktop_platform_tag()`） */
  platform: string
  log: (line: string) => void
  /** 当前生效的设置（读自磁盘；服务面持有的是同一份文件的读写者） */
  settings: () => DesktopSettings
  /** 读改写设置（走 settings-store 的原子写） */
  save: (patch: Record<string, unknown>) => DesktopSettings
  /** dsh 服务面：重启宿主（设置面板切 dsh 来源 / profile 后调它） */
  restartService?: () => Promise<void>
  /** dsh 服务面状态快照（`get_dsh_status`） */
  status?: () => Record<string, unknown>
  /** 壳当前占用的端口（`list_profile_ports` 用） */
  ports?: () => { port: number; lanePort: number } | undefined
  /** dsh 服务状态码（旧壳 get_dsh_status 的 0..7 枚举；缺省当作「运行中」） */
  dshStatus?: () => number
  /** 运行中的 dsh 版本（内置＝运行时目录名，外部＝CLI 版本） */
  dshVersion?: () => string
  openExternal?: (url: string) => void
  closeWindow?: () => void
  /** 试听音效（设置面板的「试听」；缺省不响，但要回一条可诊断的话） */
  playSound?: (name: string) => void
  notifier?: Notifier
  /** 运行时快照：来源 / 内置版本 / 已装列表 / 外部 dsh 路径（命令表不自己碰文件系统） */
  runtime?: () => RuntimeSnapshot
  /** 拉取版本目录（github / npm；失败不抛，回 {entries, error}） */
  fetchCatalog?: (source: RuntimeSource) => Promise<{ entries: CatalogEntry[]; error?: string }>
  /** 删除一个已下载运行时（先移回收站，清单摘除） */
  removeRuntime?: (version: string) => Promise<void>
  /** 下载并安装一个运行时（单飞；已有任务在跑时抛「已有运行时下载任务」） */
  downloadRuntime?: (version: string, source: RuntimeSource) => Promise<{ ok: true; version: string }>
  /** 下载进度（面板每 600ms 轮询；旧壳 runtime_download_status 同形状） */
  downloadStatus?: () => RuntimeDownloadStatus
}

/** 上游端口：状态条与「dsh 来源」卡都要它（壳状态快照里的 upstreamPort） */
function runningPort(deps: CommandDeps): number {
  const running = deps.status?.() ?? {}
  return typeof running.upstreamPort === 'number' ? running.upstreamPort : 0
}

export interface RuntimeSnapshot {
  mode: DshMode
  /** 随包内置版本（读内置树 package.json） */
  builtinVersion: string | null
  /** 当前生效运行时的真实版本 */
  activeVersion: string | null
  /** override | external | installed | builtin */
  activeKind: string
  /** 面板 select 的当前值：设置里的 dshRuntime（外部模式下不生效） */
  selected: string | null
  installed: InstalledRuntime[]
  externalPath: string | null
  externalVersion: string | null
}


/** 已实现命令里，明确「还没搬过来」的那几条：报清楚原因，UI 才能给人看。 */
const NOT_PORTED: Record<string, string> = {
  rebuild_profile_dependencies: 'profile 依赖重建尚未移植',
  migrate_profile: 'profile 迁移尚未移植',
  migration_status: 'profile 迁移尚未移植',
  check_startup_needed: '启动 profile 确认流程尚未移植',
  confirm_startup_profile: '启动 profile 确认流程尚未移植',
  get_pending_active_profile: '启动 profile 确认流程尚未移植',
  test_proxy_connectivity: '代理连通性测试尚未移植',
  choose_notification_sound: '音效文件选择器尚未移植',
  import_notification_sound: '音效导入尚未移植',
  start_blob_download: '下载管理器尚未移植',
  save_blob_chunk: '下载管理器尚未移植',
  finish_blob_download: '下载管理器尚未移植',
  browser_guest_state: '浏览器 guest 尚未移植',
  browser_guest_acquire: '浏览器 guest 尚未移植',
  browser_guest_navigate: '浏览器 guest 尚未移植',
  browser_guest_set_bounds: '浏览器 guest 尚未移植',
  browser_guest_set_visible: '浏览器 guest 尚未移植',
  browser_guest_release: '浏览器 guest 尚未移植',
  browser_guest_release_all: '浏览器 guest 尚未移植',
}

export function createCommandTable(deps: CommandDeps): Record<string, RpcHandler> {
  const handlers: Record<string, RpcHandler> = {
    // ---- 渲染环境：客户端插件的第一步；回 undefined 会让整片桌面 chrome 不激活 ----
    get_desktop_client_environment: () => {
      const settings = deps.settings()
      return {
        // 旧壳有 compatibility / advanced 两档；新壳只有 advanced（自绘 chrome 是唯一形态）
        mode: 'advanced',
        platform: deps.platform,
        profile: deps.profile,
        // 视觉窗口化已整块删除（#200 收尾），恒 false，别让面板把它当开关回填成「开」
        renderBudget: false,
        dshMode: settings.dshMode ?? 'builtin',
      }
    },

    // ---- 设置面板：读侧一次给全（旧壳 get_desktop_settings_data 的等价物 + settings 段） ----
    get_desktop_settings_data: () => {
      const settings = deps.settings()
      const running = deps.status?.() ?? {}
      const origin = typeof running.origin === 'string' ? running.origin : ''
      const upstreamPort = typeof running.upstreamPort === 'number' ? running.upstreamPort : 0
      return {
        remote_addr: settings.remoteAddr ?? null,
        remote_list: settings.remoteList,
        mux_heartbeat_ms: settings.muxHeartbeatMs ?? null,
        desktop_layout_on_phones: settings.desktopLayoutOnPhones ?? null,
        prevent_sleep: settings.preventSleep ?? null,
        port: upstreamPort,
        origin,
        profiles: [
          { name: deps.profile, active: true, selectable: true },
        ],
        // 面板的 nsGet() 读这一段（旧壳只回吐扁平键，那段其实是死的）
        settings: serializeSettings(settings),
      }
    },

    save_desktop_settings: (args) => {
      const patch = args.patch
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new Error('save_desktop_settings: patch 必须是对象')
      }
      const next = deps.save(patch as Record<string, unknown>)
      deps.log(`[rpc] 保存设置：${Object.keys(patch as Record<string, unknown>).join('、')}`)
      return { settings: serializeSettings(next) }
    },

    get_proxy_settings: () => {
      const settings = deps.settings()
      return {
        proxy_mode: settings.proxyMode ?? 'off',
        proxy_url: settings.proxyUrl ?? '',
        no_proxy: settings.noProxy ?? '',
        effective: settings.proxyMode === 'manual' ? settings.proxyUrl ?? '' : '',
      }
    },

    // 底部状态条的轮询口（每 5s 一次）：旧壳的 0..7 枚举，缺了它状态永远是默认文案
    get_dsh_status: () => ({
      status: deps.dshStatus?.() ?? 2,
      mode: deps.settings().dshMode ?? 'builtin',
      origin: 'shell',
      port: runningPort(deps),
    }),

    // 设置面板的「dsh 来源」卡：形状对齐 DshSourceState（running.origin 是标签，不是 URL）
    get_dsh_source: () => {
      const snapshot = deps.runtime?.()
      const mode = snapshot?.mode ?? deps.settings().dshMode ?? 'builtin'
      const running = deps.status?.() ?? null
      const runningVersion = snapshot?.activeVersion ?? deps.dshVersion?.() ?? ''
      return {
        mode,
        builtin: snapshot?.builtinVersion == null ? null : { dsh_version: snapshot.builtinVersion },
        external:
          snapshot?.externalPath == null
            ? null
            : { dsh_version: snapshot.externalVersion ?? '', path: snapshot.externalPath },
        running:
          running === null
            ? null
            : { mode, origin: 'shell', port: runningPort(deps), version: runningVersion },
      }
    },

    // ---- 运行时管理（旧壳 runtime/registry.rs 的命令面）----
    // 版本目录：远端拉不到不算失败（回 error 标记，面板降级显示本地已装；旧壳 #107）
    list_runtime_catalog: async (args) => {
      const snapshot = deps.runtime?.()
      const requested = argString(args, 'source') ?? deps.settings().runtimeSource ?? ''
      const source = (requested === '' ? 'github' : requested) as RuntimeSource
      const fetched = (await deps.fetchCatalog?.(source)) ?? { entries: [] }
      const body: Record<string, unknown> = {
        source,
        mode: snapshot?.mode ?? 'builtin',
        builtin: snapshot?.builtinVersion ?? null,
        // 外部 CLI 不占本地运行时树：此时「当前使用」不指向任何已下载版本（旧壳 #135）
        selected: (snapshot?.mode ?? 'builtin') === 'external' ? null : (snapshot?.selected ?? null),
        installed: snapshot?.installed ?? [],
        catalog: fetched.entries,
      }
      if (fetched.error !== undefined) body.error = fetched.error
      return body
    },

    runtime_download_status: () =>
      deps.downloadStatus?.() ?? { active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '' },

    // 下载安装：单飞（已有任务在跑时由 deps.downloadRuntime 抛「已有运行时下载任务」）
    download_runtime: async (args) => {
      const version = argString(args, 'version')
      if (version === undefined || version === '') throw new Error('download_runtime: version 不能为空')
      if (deps.downloadRuntime === undefined) throw new Error('download_runtime: 运行时下载不可用')
      // 页面不传 / 传空串都按默认来源（旧壳 source 参数缺省即 github）
      const rawSource = argString(args, 'source')
      const source = (rawSource === undefined || rawSource === '' ? 'github' : rawSource) as RuntimeSource
      return deps.downloadRuntime(version, source)
    },

    // 卸载：正在用 / 内置的不允许删（旧壳同款守卫；外置模式下不占本地树，故不拦）
    remove_runtime: async (args) => {
      const version = argString(args, 'version')
      if (version === undefined || version === '') throw new Error('remove_runtime: version 不能为空')
      if (deps.removeRuntime === undefined) throw new Error('remove_runtime: 运行时管理不可用')
      const snapshot = deps.runtime?.()
      if (snapshot !== undefined) {
        if (snapshot.mode === 'builtin' && snapshot.selected === version) {
          throw new Error(`${version} 正在使用，请先切换到其他版本`)
        }
        if (snapshot.builtinVersion === version) throw new Error(`${version} 是内置版本，不可删除`)
      }
      await deps.removeRuntime(version)
      deps.log(`[rpc] 卸载运行时 dsh ${version}`)
      return { ok: true, version }
    },

    // 设置面板切 dsh 来源 / profile 后的动作：重启宿主，页面由守护器回调自动重载
    restart_dsh_service: async () => {
      if (deps.restartService === undefined) throw new Error('restart_dsh_service: 服务面不可用')
      deps.log('[rpc] 收到重启 dsh 服务请求')
      await deps.restartService()
      return {}
    },

    list_profile_ports: () => {
      const ports = deps.ports?.()
      const settings = deps.settings()
      return [
        {
          profile: deps.profile,
          port: ports?.port ?? 0,
          lane_port: ports?.lanePort ?? 0,
          running: true,
        },
      ]
    },

    list_profile_dependency_status: () => {
      return [{ profile: deps.profile, ready: true, note: '依赖树来自当前运行时（#209 reconcile）' }]
    },

    // ---- 下载 tab：管理器本体还没移植，但先给空列表而不是报错 ----
    list_downloads: () => [],
    get_download_settings: () => ({
      concurrency: deps.settings().downloadConcurrency ?? 3,
      download_dir: deps.home,
    }),
    set_download_concurrency: (args) => {
      const value = argNumber(args, 'value')
      if (value === undefined) throw new Error('set_download_concurrency: value 必须是数字')
      deps.save({ download_concurrency: value })
      return {}
    },

    // ---- 通知 tab ----
    get_notifications_state: () => ({
      config: deps.settings().notifications,
      permission: 'granted',
    }),
    set_notifications_config: (args) => {
      const config = args.config
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('set_notifications_config: config 必须是对象')
      }
      const next = deps.save({ notifications: config })
      return { config: next.notifications }
    },
    request_notification_permission_cmd: () => ({ granted: true }),
    preview_notification_sound: (args) => {
      const name = argString(args, 'name')
      if (name !== '') {
        deps.playSound?.(name)
        return { played: name }
      }
      return { played: null }
    },

    // ---- 杂项：诊断与外链 ----
    log_console: (args) => {
      deps.log(`[page] ${argString(args, 'message', '(empty)')}`)
      return {}
    },
    log_diag: (args) => {
      deps.log(`[diag] ${argString(args, 'msg', '(empty)')}`)
      return {}
    },
    open_external: (args) => {
      const url = argString(args, 'url')
      if (url === '') throw new Error('open_external: url 不能为空')
      deps.openExternal?.(url)
      return {}
    },
    close_current_window: () => {
      deps.closeWindow?.()
      return {}
    },
    exit_window_instance: () => {
      deps.closeWindow?.()
      return {}
    },
  }

  for (const [name, reason] of Object.entries(NOT_PORTED)) {
    if (handlers[name] !== undefined) continue
    handlers[name] = () => {
      throw new Error(`${name}：${reason}`)
    }
  }

  return handlers
}
