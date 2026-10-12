// 壳命令表：把旧壳的 Tauri 命令（`desktop/src-tauri/src/commands.rs`，62 个）逐步搬到 Bun。
//
// 本轮只接「桌面 chrome + 设置面板 + 通知 tab」真正会调的那些；其余命令**显式**回
// 「尚未移植」而不是静默成功——面板会把它显示成一条失败提示，比转圈或假装保存好。
// 命令实现全部只依赖注入的 deps，方便单测（不 import electrobun）。

import type { DesktopSettings, DshMode, RuntimeSource } from '../shared/settings.ts'
import type { DownloadManager } from './downloads.ts'
import type { RuntimeDownloadStatus } from './runtime-install.ts'
import type { CatalogEntry, InstalledRuntime } from '../shared/runtime-catalog.ts'
import { NOTIFICATION_GROUPS, NOTIFICATION_SCENARIOS, serializeSettings } from '../shared/settings.ts'
import { argNumber, argString, type RpcContext, type RpcHandler } from './rpc.ts'
import type { GuestCommands } from './guest-manager.ts'
import type { GuestPush } from '../shared/guest-policy.ts'
import { listSounds, type Notifier } from './notifications.ts'
import { permissionHint, type NotifyPermission } from '../shared/notify-permission.ts'
import type { PortClaim } from '../shared/ports.ts'
import { EMPTY_TASK, startupAction, validProfileName, type MigrationStatus, type ProfileDependencyRow, type StartupHealth, type TaskSnapshot } from '../shared/profile-ops.ts'
import type { ShellUpdater } from './updater.ts'
import type { ProxyEnv } from '../shared/proxy-env.ts'

export interface CommandDeps {
  home: string
  /** 当前 profile；可以是取值函数——壳里切了 profile 之后面板得看到新的那个 */
  profile: string | (() => string)
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
  /** 共享端口台账（多窗口：每份 profile 的服务面都往同一个文件里记自己那行） */
  portClaims?: () => Promise<PortClaim[]>
  /** 磁盘上已知的 profile 名（`list_profile_ports` 的行来源之一） */
  profiles?: () => string[]
  /** dsh 服务状态码（旧壳 get_dsh_status 的 0..7 枚举；缺省当作「运行中」） */
  dshStatus?: () => number
  /** 运行中的 dsh 版本（内置＝运行时目录名，外部＝CLI 版本） */
  dshVersion?: () => string
  /** 兼容/高级模式弹框（旧壳 get_mode_prompt_needed / choose_desktop_mode） */
  modePrompt?: () => boolean
  chooseMode?: (mode: string, tokenUrl?: string) => Promise<{ ok: true; needsToken: boolean }>
  openExternal?: (url: string) => void
  closeWindow?: () => void
  /** 试听音效（设置面板的「试听」；缺省不响，但要回一条可诊断的话） */
  playSound?: (name: string) => void
  /** 系统默认提示音的试听（旧壳 `preview_notification_sound("default")`） */
  playSystemSound?: () => void
  /** 弹原生文件选择器选音频（返回绝对路径或 null；旧壳 tauri-plugin-dialog） */
  pickSoundFile?: () => Promise<string | null>
  /** 把音频文件收进 `$DSH_HOME/sounds/`，返回入库文件名（旧壳 sounds::import_file） */
  importSound?: (path: string) => string
  notifier?: Notifier
  /** 系统通知授权状态（真实值，来自 notify-un 桥；缺省 unavailable） */
  notifyPermission?: () => NotifyPermission
  /** 主动申请通知授权（返回申请后的状态） */
  notifyRequestPermission?: () => NotifyPermission
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
  /** 默认下载目录（`~/Downloads`；`get_download_settings.download_dir` 用） */
  downloadDir?: string
  /** 下载管理器（`src/bun/downloads.ts`）；无窗口单测可以不接 */
  downloads?: DownloadManager | (() => DownloadManager | undefined)
  /** 页面控制台一条消息（`log_console` 的客户端契约 `{level,msg,pageUrl}`；壳侧写 webview 日志） */
  logPageConsole?: (input: { level: string; msg: string; pageUrl: string | null }) => void
  /** 诊断快照（`get_diagnostics`；无窗口单测可不接） */
  diagnostics?: () => Record<string, unknown>
  /** 把诊断快照写到文件（`export_diagnostics`） */
  exportDiagnostics?: (snapshot: Record<string, unknown>) => { path: string; bytes: number }
  /** 启动检查是否已确认过（旧壳 DshState.skip_startup_check，仅进程内） */
  startupChecked?: () => boolean
  /** 确认过启动检查（旧壳在 confirm_startup_profile 里置位） */
  markStartupChecked?: () => void
  /** 全新安装（旧壳看 settings 文件此前存不存在） */
  freshInstall?: () => boolean
  /** profile 完整性（缺哪些必需文件 / 有没有 node_modules） */
  profileHealth?: (profile: string) => StartupHealth
  /** 待生效的 profile：确认启动时写入，前端取走即清（旧壳 get_pending_active_profile） */
  setPendingProfile?: (profile: string) => void
  takePendingProfile?: () => string | null
  /** 用指定 profile 起服务面（repair 时先重建依赖） */
  confirmStartupProfile?: (profile: string, repair: boolean) => Promise<void>
  /** 该 profile 是否正在跑（回它在监听的端口；用于「先停再重建」的门） */
  runningPortOfProfile?: (profile: string) => Promise<number | null>
  /** 用内置 pnpm 重建该 profile 的依赖（阻塞数分钟） */
  rebuildProfile?: (profile: string) => Promise<string>
  /** 迁移 profile；目标已存在且 !overwrite 时抛「需确认覆盖」 */
  migrateProfile?: (source: string, dest: string, overwrite: boolean) => Promise<string>
  /** 迁移进度（面板 300ms 轮询） */
  migrationStatus?: () => MigrationStatus
  /** 浏览器 guest（侧边栏浏览器 / 远程窗口的子 webview）；无窗口单测可以不接 */
  guests?: GuestCommands
  /** TCP 连一次代理，返回耗时 ms（旧壳 test_proxy_connectivity） */
  testProxy?: (url: string) => Promise<number>
  /** 应用更新（`src/bun/updater.ts` 包住的框架 Updater）；无窗口单测可以不接 */
  updater?: ShellUpdater
  /** 桌面档快捷键偏好（旧壳 `shortcuts.rs`；壳只做上限 + 原子写，不解析 JSON） */
  keybindings?: { read: () => string | null; write: (raw: string) => void }
  /** 各 profile 的依赖状态（`list_profile_dependency_status`；旧壳比 pnpm 大版本） */
  dependencyRows?: () => Promise<ProfileDependencyRow[]>
  /** 任务快照（`task_status`；迁移/重建的进度卡轮询它） */
  taskStatus?: () => TaskSnapshot
  /** 当前生效的代理注入预览（`get_proxy_settings.effective`） */
  proxyEffective?: () => ProxyEnv | null
  /** F13：窗口⇄最大化切换（壳主进程操作 focusedWindow） */
  zoomToggle?: () => void
  /** F12：确认弹窗回填的同槽转发（旧壳 ui_input_confirm） */
  inputConfirm?: (flow: string, value: string) => void
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
  /** 当前生效运行时目录（面板显示「运行中」时用得上） */
  activeDir: string | null
  /** 面板 select 的当前值：设置里的 dshRuntime（外部模式下不生效） */
  selected: string | null
  installed: InstalledRuntime[]
  externalPath: string | null
  externalVersion: string | null
}


/** 已实现命令里，明确「还没搬过来」的那几条：报清楚原因，UI 才能给人看。 */
const NOT_PORTED: Record<string, string> = {
}

/** profile 可以是静态值（单测）或取值函数（壳里跟着托盘切 profile 变） */
function profileOf(deps: CommandDeps): string {
  return typeof deps.profile === 'function' ? deps.profile() : deps.profile
}


/** 台账里的 pid 还活着吗（权限不足也算活着：`EPERM` 说明进程存在） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return pid === process.pid
  }
}

/** 命令的调用方（每视图授权台账里的 label/profile）；无台账时按「当前 profile 的主窗」兜底。 */
function callerOf(context: RpcContext | undefined, deps: CommandDeps): { label: string; profile: string } {
  const caller = context?.caller
  if (caller !== undefined) return { label: caller.label, profile: caller.profile }
  const profile = profileOf(deps)
  return { label: `profile-${profile}`, profile }
}

export function createCommandTable(deps: CommandDeps): Record<string, RpcHandler> {
  /** 下载管理器（无窗口单测里可以不接） */
  const downloads = (): DownloadManager | undefined =>
    typeof deps.downloads === 'function' ? deps.downloads() : deps.downloads

  const handlers: Record<string, RpcHandler> = {
    // ---- 渲染环境：客户端插件的第一步；回 undefined 会让整片桌面 chrome 不激活 ----
    get_desktop_client_environment: () => {
      const settings = deps.settings()
      return {
        // 旧壳有 compatibility / advanced 两档；新壳只有 advanced（自绘 chrome 是唯一形态）
        mode: 'advanced',
        platform: deps.platform,
        profile: profileOf(deps),
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
          { name: profileOf(deps), active: true, selectable: true },
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

    // 代理设置回显（旧壳 get_proxy_settings 的六字段）：凭据单独回吐（F3），effective 是对象
    get_proxy_settings: () => {
      const settings = deps.settings()
      return {
        proxy_mode: settings.proxyMode ?? 'off',
        proxy_url: settings.proxyUrl ?? '',
        no_proxy: settings.noProxy ?? '',
        proxy_user: settings.proxyUser ?? '',
        proxy_pass: settings.proxyPass ?? '',
        effective: deps.proxyEffective?.() ?? null,
      }
    },

    // F14：旧壳独立代理窗的保存口（新壳由设置面板承担，命令面保留对齐）
    save_proxy_settings: async (args: Record<string, unknown>) => {
      const patch: Record<string, unknown> = {}
      for (const key of ['proxy_mode', 'proxy_url', 'no_proxy', 'proxy_user', 'proxy_pass'] as const) {
        const value = args[key]
        if (typeof value === 'string') patch[key] = value
      }
      if (Object.keys(patch).length === 0) throw new Error('save_proxy_settings：没有可保存的字段')
      deps.save(patch)
      return { ok: true, effective: deps.proxyEffective?.() ?? null }
    },

    // F13：旧壳 toggle_zoom（窗口⇄工作区）；Electrobun 无 workArea API，
    // 用 maximize/unmaximize 等价实现（原生会记住恢复几何）
    toggle_zoom: () => {
      if (deps.zoomToggle === undefined) throw new Error('zoom 切换未就绪（壳还在启动）')
      deps.zoomToggle()
      return { ok: true }
    },

    // F12：页面内确认弹窗回填（旧壳命令名；新壳页面走 /__shell__/input-confirm，
    // 这里为命令面对齐保留，同槽转发）
    ui_input_confirm: (args: Record<string, unknown>) => {
      const flow = typeof args['flow'] === 'string' ? args['flow'] : ''
      const value = typeof args['value'] === 'string' ? args['value'] : ''
      if (deps.inputConfirm === undefined) throw new Error('没有等待中的输入请求')
      deps.inputConfirm(flow, value)
      return { ok: true }
    },

    // 兼容/高级模式（旧壳 get_mode_prompt_needed / choose_desktop_mode）
    get_mode_prompt_needed: () => deps.modePrompt?.() ?? false,
    choose_desktop_mode: async (args: Record<string, unknown>) => {
      const mode = typeof args['mode'] === 'string' ? args['mode'] : ''
      const tokenUrl = typeof args['tokenUrl'] === 'string' ? args['tokenUrl'] : undefined
      if (deps.chooseMode === undefined) throw new Error('接入模式选择器未就绪（壳还在启动）')
      return await deps.chooseMode(mode, tokenUrl)
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
        // 当前真正在跑的那棵树：面板要能把它标成「运行中」，
        // 并且不再把正在跑的版本当成「可下载」（dev 用 DSH_SHELL_RUNTIME_DIR 时内置树可能压根不在）
        running: {
          kind: snapshot?.activeKind ?? 'builtin',
          version: snapshot?.activeVersion ?? null,
          dir: snapshot?.activeDir ?? null,
        },
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

    // 多窗口：设置面板每份窗口各问一次壳，但端口表要覆盖所有 profile。
    // 行来源＝磁盘上已知的 profile 名 ∪ 共享台账里的行；自己那行用本份服务面的活值。
    list_profile_ports: async () => {
      const local = profileOf(deps)
      const ports = deps.ports?.()
      const claims = (await deps.portClaims?.()) ?? []
      const names = deps.profiles?.() ?? [local]
      const rows = new Map<string, { profile: string; port: number; lane_port: number; running: boolean }>()
      for (const profile of names) rows.set(profile, { profile, port: 0, lane_port: 0, running: false })
      for (const claim of claims) {
        const alive = pidAlive(claim.pid)
        const existing = rows.get(claim.profile)
        if (existing === undefined) {
          rows.set(claim.profile, {
            profile: claim.profile,
            port: claim.port,
            lane_port: claim.lanePort ?? 0,
            running: alive,
          })
        } else {
          existing.port = claim.port
          existing.lane_port = claim.lanePort ?? 0
          existing.running = alive
        }
      }
      const own = rows.get(local)
      if (own !== undefined) {
        own.port = ports?.port ?? own.port
        own.lane_port = ports?.lanePort ?? own.lane_port
        own.running = true
      }
      // 本 profile 最靠前，其余按名字：面板里一眼能看出自己与兄弟窗口
      return [...rows.values()].sort((left, right) => {
        if (left.profile === local) return -1
        if (right.profile === local) return 1
        return left.profile.localeCompare(right.profile)
      })
    },

    // 各 profile 的依赖状态（旧壳回 `{profiles:[…]}`；此前回的是裸数组 ⇒ 面板读到 undefined）
    list_profile_dependency_status: async () => ({
      profiles: (await deps.dependencyRows?.()) ?? [],
    }),

    // 迁移/重建的进度卡（旧壳 profiles::task_status 的九字段）
    task_status: () => deps.taskStatus?.() ?? { ...EMPTY_TASK },

    // 桌面档快捷键偏好（#187）：壳只做上限 + 原子写，页面侧解析与序列化
    read_desktop_keybindings: () => deps.keybindings?.read() ?? null,
    write_desktop_keybindings: (args) => {
      const raw = args['raw']
      if (typeof raw !== 'string') throw new Error('write_desktop_keybindings: raw 必须是字符串')
      if (deps.keybindings === undefined) throw new Error('write_desktop_keybindings：壳未接快捷键偏好')
      deps.keybindings.write(raw)
      return {}
    },

    // ---- 下载 tab（管理器在 src/bun/downloads.ts；旧壳 download/{manager,transfer}.rs 的等价物）----
    list_downloads: () => downloads()?.list() ?? [],
    get_download_settings: () => ({
      concurrency: downloads()?.concurrency() ?? deps.settings().downloadConcurrency ?? 3,
      download_dir: deps.downloadDir ?? deps.home,
    }),
    set_download_concurrency: (args) => {
      const value = argNumber(args, 'value')
      if (value === undefined) throw new Error('set_download_concurrency: value 必须是数字')
      // 管理器在时由它夹取并回写设置；不在时（无窗口单测）退回直接写设置
      const manager = downloads()
      if (manager === undefined) {
        deps.save({ download_concurrency: value })
        return {}
      }
      return { concurrency: manager.setConcurrency(value) }
    },
    pause_download: (args) => {
      const id = argNumber(args, 'id')
      if (id === undefined) throw new Error('pause_download: id 必须是数字')
      downloads()?.pause(id)
      return {}
    },
    resume_download: (args) => {
      const id = argNumber(args, 'id')
      if (id === undefined) throw new Error('resume_download: id 必须是数字')
      downloads()?.resume(id)
      return {}
    },
    cancel_download: (args) => {
      const id = argNumber(args, 'id')
      if (id === undefined) throw new Error('cancel_download: id 必须是数字')
      downloads()?.cancel(id)
      return {}
    },
    clear_finished_downloads: () => ({ removed: downloads()?.clearFinished() ?? 0 }),
    reveal_download: (args) => {
      const id = argNumber(args, 'id')
      if (id === undefined) return false
      return downloads()?.reveal(id) ?? false
    },
    // 页面拦截到 blob:/data: 下载后的三步（旧壳 start_blob_download / save_blob_chunk / finish_blob_download）
    start_blob_download: async (args) => {
      const manager = downloads()
      if (manager === undefined) throw new Error('start_blob_download: 壳未接下载管理器')
      const filename = argString(args, 'filename', 'download')
      const total = argNumber(args, 'total') ?? null
      return await manager.startBlob(filename, total)
    },
    save_blob_chunk: (args) => {
      const id = argNumber(args, 'id')
      const chunk = argString(args, 'chunk')
      if (id === undefined || chunk === '') return false
      return downloads()?.saveChunk(id, chunk) ?? false
    },
    finish_blob_download: (args) => {
      const id = argNumber(args, 'id')
      if (id === undefined) return false
      return downloads()?.finishBlob(id) ?? false
    },
    // http(s) 直链：旧壳靠 wry 的 on_download 转交，新壳由页面拦截后调这条（见 download-intercept.ts）
    start_url_download: async (args) => {
      const manager = downloads()
      if (manager === undefined) throw new Error('start_url_download: 壳未接下载管理器')
      const url = argString(args, 'url')
      if (url === '') throw new Error('start_url_download: url 不能为空')
      const filename = argString(args, 'filename')
      return await manager.startUrl(url, filename)
    },

    // ---- 通知 tab ----
    get_notifications_state: () => {
      const config = deps.settings().notifications
      const chosen = config.scenarios ?? {}
      return {
        // 旧壳在 macOS 上问 UNUserNotificationCenter 要授权状态（notify_un.rs 的 permission_state）；
        // 新壳走我们自己的 UN 桥（native/notify_un.m），这里的值是**真读出来的**，不再是写死的 granted。
        permission: deps.notifyPermission?.() ?? 'unavailable',
        config,
        // 14 条场景的元数据（唯一事实源＝shared/settings.ts 的 NOTIFICATION_SCENARIOS）
        scenarios: NOTIFICATION_SCENARIOS.map((meta) => ({
          id: meta.id,
          group: meta.group,
          name: meta.name,
          desc: meta.desc,
          defaultOn: meta.defaultOn,
          config: chosen[meta.id] ?? null,
        })),
        groups: NOTIFICATION_GROUPS,
        sounds: listSounds(deps.home),
      }
    },
    set_notifications_config: (args) => {
      const config = args.config
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('set_notifications_config: config 必须是对象')
      }
      const next = deps.save({ notifications: config })
      return { config: next.notifications }
    },
    request_notification_permission_cmd: () => {
      const request = deps.notifyRequestPermission
      if (request === undefined) {
        // 没有桥（非 macOS / 没打包 / 库缺失）：如实说，不让面板以为我们申请过
        deps.log('[notify] 本平台没有可用的授权申请通道（面板只显示状态）')
        return { granted: false, permission: deps.notifyPermission?.() ?? 'unavailable', prompted: false }
      }
      const before = deps.notifyPermission?.() ?? 'unavailable'
      const permission = request()
      deps.log(`[notify] 申请通知权限：${before} → ${permission}（${permissionHint(permission)}）`)
      return { granted: permission === 'granted', permission, prompted: permission !== before || permission === 'not_determined' }
    },
    // `custom:<名>`（或裸名）播 `$DSH_HOME/sounds/<名>`；客户端传的是 `{ sound }`。
    preview_notification_sound: (args) => {
      const raw = argString(args, 'sound') || argString(args, 'name')
      const sound = raw.startsWith('custom:') ? raw.slice('custom:'.length) : raw
      deps.log(`[notify] 试听请求：sound = ${sound === '' ? '(空)' : sound}`)
      if (sound === '' || sound === 'none') {
        deps.log('[notify] 试听：none/空 ⇒ 不响')
        return { played: null, sound }
      }
      if (sound === 'default') {
        deps.playSystemSound?.()
        return { played: 'default', sound }
      }
      deps.playSound?.(sound)
      return { played: sound, sound }
    },
    // 选文件（返回路径，由 import_notification_sound 收进 sounds/）
    choose_notification_sound: async () => (await deps.pickSoundFile?.()) ?? null,
    import_notification_sound: (args) => {
      const path = argString(args, 'path')
      if (path === '') throw new Error('import_notification_sound: path 不能为空')
      if (deps.importSound === undefined) {
        throw new Error('import_notification_sound: 壳未接音效导入')
      }
      return deps.importSound(path)
    },

    // ---- 杂项：诊断与外链 ----
    // 客户端契约是 `{ level, msg, pageUrl }`（旧壳 `commands.rs:139`）：写
    // `$DSH_HOME/dsh-desktop-webview.log`，warn/error 另镜像到壳日志。
    log_console: (args) => {
      const level = argString(args, 'level', 'log')
      const msg = argString(args, 'msg', '')
      const pageUrl = argString(args, 'pageUrl', '')
      if (deps.logPageConsole !== undefined) deps.logPageConsole({ level, msg, pageUrl })
      else deps.log(`[page.${level}] ${msg}`)
      return {}
    },
    log_diag: (args) => {
      deps.log(`[diag] ${argString(args, 'msg', '(empty)')}`)
      return {}
    },
    // 诊断快照 / 导出（#220「日志与诊断」）：一个 JSON 回答「哪版、哪个 profile、端口/pid、日志在哪」
    get_diagnostics: () => {
      const snapshot = deps.diagnostics?.() ?? null
      if (snapshot === null) throw new Error('壳未接诊断快照')
      return { diagnostics: snapshot }
    },
    export_diagnostics: () => {
      const snapshot = deps.diagnostics?.() ?? null
      if (snapshot === null || deps.exportDiagnostics === undefined) throw new Error('壳未接诊断导出')
      const result = deps.exportDiagnostics(snapshot)
      return { path: result.path, bytes: result.bytes }
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

    // ---- profile 运维与启动检查（旧壳 commands.rs:252/541/711/737/758） ----
    // 存量安装且没设 active_profile ⇒ 让用户选；profile 残缺 ⇒ 让用户确认修复。
    check_startup_needed: () => {
      const decision = startupAction({
        skipCheck: deps.startupChecked?.() ?? false,
        freshInstall: deps.freshInstall?.() ?? false,
        activeProfile: deps.settings().activeProfile ?? null,
        profiles: deps.profiles?.() ?? [profileOf(deps)],
        health: deps.profileHealth?.(profileOf(deps)) ?? { dirExists: true, missingFiles: [], nodeModulesExists: true },
        profile: profileOf(deps),
      })
      if (decision.action === 'none') return { action: 'none' }
      if (decision.action === 'profile-selection') return { action: 'profile-selection', profiles: decision.profiles }
      return {
        action: 'profile-incomplete',
        profile: decision.profile,
        // 客户端读的是 snake_case（desktop-settings.tsx 的 details.missing_files / node_modules_exists）
        details: {
          dir_exists: decision.details.dirExists,
          missing_files: [...decision.details.missingFiles],
          node_modules_exists: decision.details.nodeModulesExists,
        },
      }
    },
    confirm_startup_profile: async (args) => {
      const name = argString(args, 'name')
      if (!validProfileName(name)) throw new Error('profile 名称仅允许字母、数字、_ 与 -（1-32 字符）')
      if (deps.confirmStartupProfile === undefined) throw new Error('confirm_startup_profile：壳未接启动确认')
      deps.markStartupChecked?.()
      deps.setPendingProfile?.(name)
      await deps.confirmStartupProfile(name, args['repair'] === true)
      return {}
    },
    // 前端激活时取回启动时选的 profile，再由它自己 save_desktop_settings 持久化（旧壳同序）
    get_pending_active_profile: () => deps.takePendingProfile?.() ?? null,
    rebuild_profile_dependencies: async (args) => {
      const profile = argString(args, 'profile') || profileOf(deps)
      if (!validProfileName(profile)) throw new Error('profile 名称仅允许字母、数字、_ 与 -（1-32 字符）')
      const port = (await deps.runningPortOfProfile?.(profile)) ?? null
      if (port !== null) throw new Error(`${profile} 正在运行（端口 ${String(port)}），请先停止该 profile 再重建`)
      if (deps.rebuildProfile === undefined) throw new Error('rebuild_profile_dependencies：壳未接依赖重建')
      return deps.rebuildProfile(profile)
    },
    migrate_profile: async (args) => {
      const source = argString(args, 'source')
      const dest = argString(args, 'dest')
      if (deps.migrateProfile === undefined) throw new Error('migrate_profile：壳未接迁移')
      return deps.migrateProfile(source, dest, args['overwrite'] === true)
    },
    migration_status: () => deps.migrationStatus?.() ?? { running: false, copied: 0, total: 0 },
    test_proxy_connectivity: async (args) => {
      const url = argString(args, 'url')
      if (url === '') throw new Error('代理地址为空')
      if (deps.testProxy === undefined) throw new Error('test_proxy_connectivity：壳未接连接测试')
      return deps.testProxy(url)
    },
    // 浏览器 guest（旧壳 desktop/src-tauri/src/ui/browser_guests/mod.rs 的 8 条命令）。
    // guest 挂在**发起调用的那个窗口**上，所以调用方从 RPC 上下文里取（每视图授权台账）。
    browser_guest_acquire: async (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_acquire：壳未接浏览器 guest')
      return await guests.acquire(args, callerOf(context, deps))
    },
    browser_guest_release: (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_release：壳未接浏览器 guest')
      return guests.release(args, callerOf(context, deps))
    },
    browser_guest_navigate: (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_navigate：壳未接浏览器 guest')
      return guests.navigate(args, callerOf(context, deps))
    },
    browser_guest_control: (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_control：壳未接浏览器 guest')
      return guests.control(args, callerOf(context, deps))
    },
    browser_guest_set_bounds: (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_set_bounds：壳未接浏览器 guest')
      return guests.setBounds(args, callerOf(context, deps))
    },
    browser_guest_set_visible: (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_set_visible：壳未接浏览器 guest')
      return guests.setVisible(args, callerOf(context, deps))
    },
    browser_guest_state: (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_state：壳未接浏览器 guest')
      return guests.state(args, callerOf(context, deps)) satisfies GuestPush
    },
    browser_guest_release_all: (args, context) => {
      const guests = deps.guests
      if (guests === undefined) throw new Error('browser_guest_release_all：壳未接浏览器 guest')
      return guests.releaseAll(args, callerOf(context, deps))
    },

    // ---- 应用更新（#220 决策 11：旧壳没有这个能力，是新增件）----
    // 拿不到更新源（dev 构建、没配 release.baseUrl）时不报错，而是回一个带 reason 的视图：
    // 面板把「为什么不能点」直接显示出来，比一个永远转圈的按钮好。
    get_update_state: () => {
      const updater = deps.updater
      if (updater === undefined) throw new Error('get_update_state：壳未接应用更新')
      return updater.snapshot()
    },
    check_update: async () => {
      const updater = deps.updater
      if (updater === undefined) throw new Error('check_update：壳未接应用更新')
      return updater.check()
    },
    download_update: async () => {
      const updater = deps.updater
      if (updater === undefined) throw new Error('download_update：壳未接应用更新')
      return updater.download()
    },
    apply_update: async () => {
      const updater = deps.updater
      if (updater === undefined) throw new Error('apply_update：壳未接应用更新')
      return updater.apply()
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
