// 托盘菜单模型（纯逻辑，不 import electrobun ⇒ 缝 ② 直接断言）。
import { sortRuntimeVersionsDesc } from '../shared/runtime-catalog.ts'
import { remoteDisplay } from '../shared/remote.ts'
//
// 为什么单独一层：菜单项文案、勾选状态、以及「点了哪一项要干什么」是产品语义，
// 而 `Tray` 类只是把它交给原生层。分开之后无显示器/无 CEF 也能测。
//
// 旧 Tauri 壳的托盘能力（`docs/research/shell-capability-inventory.md` 第 6 节）在这里逐项对齐：
// 显示/隐藏窗口、profile 切换、重启 dsh 服务、运行时来源切换（内置 / 外部 dsh / 已装版本 /
// 目录里点一下就下载并切换）、退出。
// 还没做的项不摆假入口——宁可菜单短，也不要点了没反应的项。

/** 「PROFILE 窗口」子菜单的每 profile 行（旧壳 tray.rs:63-73） */
export interface ProfileRow {
  profile: string
  /** 窗口开着 */
  open: boolean
  /** dsh 宿主在跑 */
  running: boolean
  /** 页面 origin 端口（运行中才有） */
  port: number | null
  /** 是当前聚焦窗口 */
  focused: boolean
}

/** 托盘菜单里的动作 id；前缀 `tray:` 便于和右键菜单的 action 区分。 */
export const TRAY_MENU_ACTIONS = {
  toggleWindow: 'tray:toggle-window',
  quit: 'tray:quit',
  restartService: 'tray:restart-service',
  remoteLocal: 'tray:remote:local',
  remoteAddrPrefix: 'tray:remote:addr:',
  windowPrefix: 'tray:window:',
  runtimeBuiltin: 'tray:runtime:builtin',
  runtimeExternal: 'tray:runtime:external',
  runtimeVersionPrefix: 'tray:runtime:version:',
  runtimeFetchPrefix: 'tray:runtime:fetch:',
  registerCli: 'tray:register-cli',
  stopProfile: 'tray:profile:stop:',
  newProfile: 'tray:profile:new',
  migrateProfile: 'tray:profile:migrate',
} as const
export type TrayActionKind =
  | 'toggle-window'
  | 'quit'
  | 'restart-service'
  | 'open-window'
  | 'switch-runtime'
  | 'download-runtime'
  | 'register-cli'
  | 'remote-source'
  | 'stop-profile'
  | 'new-profile'
  | 'migrate-profile'

export interface TrayAction {
  kind: TrayActionKind
  /** kind === 'open-window' 时是目标 profile */
  profile?: string
  /** kind === 'switch-runtime'：'builtin' 是内置树，'external' 是系统装的 dsh CLI；
   *  已下载版本用同样的 kind 加 version 表示 */
  mode?: 'builtin' | 'external'
  /** kind === 'switch-runtime'（目标版本）或 'download-runtime'（要下的版本） */
  version?: string
  /** kind === 'remote-source'：选中的远程地址在 remoteList 里的下标；undefined = 切回本地 */
  addrIndex?: number
  /** kind === 'stop-profile' 时是目标 profile */
}

export interface TrayState {
  /** 主窗当前是否可见（隐藏 = 关到了托盘） */
  windowVisible: boolean
  /** 当前 profile */
  profile: string
  /** 可用 profile（当前的在最前，其余按字典序） */
  profiles: readonly string[]
  /** 已经开着窗口的 profile（菜单里标「已开窗」，点了是聚焦不是新开） */
  openWindows: readonly string[]
  /** 每 profile 运行行（F8，旧壳 tray.rs「● name · port（聚焦中）」数据源）；空 = 退回旧行为 */
  profileRows?: readonly ProfileRow[]
  /** dsh 宿主是否在跑（守护器重启期间会短暂为 false） */
  hostRunning: boolean
  /** 运行时来源的人类可读标签，例如 `内置 0.2.1-alpha.2` */
  runtimeLabel: string
  /** dsh 来源：内置树 / 系统装的 dsh CLI */
  mode: 'builtin' | 'external'
  /** 随包内置树的版本（拿不到时 null，菜单文案会退成「版本未知」） */
  builtinVersion: string | null
  /** 当前真正在跑的运行时版本（内置 / 本地 override / 已下载都算；外部 dsh 模式下是外部那版的版本） */
  runningVersion: string | null
  /** 当前选中的已下载版本；null = 用内置树 */
  selected: string | null
  /** 已下载的版本（菜单里会跳过与内置同号的） */
  installed: readonly string[]
  /** 版本目录里还没装的项（托盘最多列 5 条，带渠道标签） */
  catalog: readonly TrayCatalogItem[]
  /** 系统里能找到外部 dsh（DSH_BIN / PATH）才列那一项 */
  externalAvailable: boolean
  /** 正在下载的版本；非 null 时那条标「（下载中…）」 */
  downloading: string | null
  /** 「dsh 服务地址」：当前生效的远程地址（null = 本地）与可选远程列表（旧壳 #136） */
  remoteAddr: string | null
  remoteList: readonly string[]
  /** 「注册 dsh 命令」项的文案；null = 已注册或还没探出 ⇒ 不摆这一项（旧壳 #175 三态） */
  registerLabel: string | null
}

/** 版本目录里的一项（与 shared/runtime-catalog.ts 的 CatalogEntry 同名，这里只取菜单要用的两个字段）。 */
export interface TrayCatalogItem {
  version: string
  channel: string
}

/** 与 Electrobun 的 MenuItemConfig 对齐（只声明我们用到的字段）。 */
export type TrayMenuItem =
  | { type: 'divider' }
  | {
      type: 'normal'
      label: string
      action?: string
      enabled?: boolean
      checked?: boolean
      submenu?: TrayMenuItem[]
    }

export function windowAction(profile: string): string {
  return `${TRAY_MENU_ACTIONS.windowPrefix}${profile}`
}

/** 菜单点击 → 语义动作；未知 action 返回 null（原生 role 之类不该被我们处理）。 */
export function parseTrayAction(action: string | undefined | null): TrayAction | null {
  if (action === undefined || action === null) return null
  if (action === TRAY_MENU_ACTIONS.toggleWindow) return { kind: 'toggle-window' }
  if (action === TRAY_MENU_ACTIONS.quit) return { kind: 'quit' }
  if (action.startsWith(TRAY_MENU_ACTIONS.windowPrefix)) {
    const profile = action.slice(TRAY_MENU_ACTIONS.windowPrefix.length)
    if (profile === '') return null
    return { kind: 'open-window', profile }
  }
  if (action === TRAY_MENU_ACTIONS.registerCli) return { kind: 'register-cli' }
  if (action === TRAY_MENU_ACTIONS.restartService) return { kind: 'restart-service' }
  if (action === TRAY_MENU_ACTIONS.runtimeBuiltin) return { kind: 'switch-runtime', mode: 'builtin' }
  if (action === TRAY_MENU_ACTIONS.runtimeExternal) return { kind: 'switch-runtime', mode: 'external' }
  if (action.startsWith(TRAY_MENU_ACTIONS.runtimeVersionPrefix)) {
    const version = action.slice(TRAY_MENU_ACTIONS.runtimeVersionPrefix.length)
    if (version === '') return null
    return { kind: 'switch-runtime', version }
  }
  if (action.startsWith(TRAY_MENU_ACTIONS.runtimeFetchPrefix)) {
    const version = action.slice(TRAY_MENU_ACTIONS.runtimeFetchPrefix.length)
    if (version === '') return null
    return { kind: 'download-runtime', version }
  }
  if (action === TRAY_MENU_ACTIONS.remoteLocal) return { kind: 'remote-source' }
  if (action.startsWith(TRAY_MENU_ACTIONS.remoteAddrPrefix)) {
    const raw = action.slice(TRAY_MENU_ACTIONS.remoteAddrPrefix.length)
    const addrIndex = Number(raw)
    if (raw === '' || !Number.isInteger(addrIndex) || addrIndex < 0) return null
    return { kind: 'remote-source', addrIndex }
  }
  if (action === TRAY_MENU_ACTIONS.newProfile) return { kind: 'new-profile' }
  if (action === TRAY_MENU_ACTIONS.migrateProfile) return { kind: 'migrate-profile' }
  if (action.startsWith(TRAY_MENU_ACTIONS.stopProfile)) {
    const profile = action.slice(TRAY_MENU_ACTIONS.stopProfile.length)
    if (profile === '') return null
    return { kind: 'stop-profile', profile }
  }
  return null
}

/** 当前 profile 排最前、其余去重后字典序——菜单顺序稳定，不随发现顺序抖。 */
export function orderedProfiles(state: Pick<TrayState, 'profile' | 'profiles'>): string[] {
  const rest = [...new Set(state.profiles)].filter((entry) => entry !== state.profile).sort()
  return [state.profile, ...rest]
}

/** 托盘最多列几条「目录里还没装」的版本（旧壳同口径）。 */
export const TRAY_RUNTIME_FETCH_LIMIT = 5

function channelSuffix(channel: string): string {
  return channel === '' ? '' : `（${channel}）`
}

/**
 * 运行时版本子菜单（旧壳 `runtime_menu_items` 的等价物）。
 * 内置 / 外部 dsh / 某个已下载版本三者互斥，勾选状态交给原生 checkmark 画；
 * 目录里还没装的版本列成「↓ 下载并切换」（至多 5 条）——点了先下再切，旧壳同一套。
 */
export function runtimeMenuItems(state: TrayState): TrayMenuItem[] {
  const externalOn = state.mode === 'external'
  // 内置树的版本：优先 `builtinVersion`；拿不到时（dev 下用 DSH_SHELL_RUNTIME_DIR 指了本地树）
  // 退成「正在跑的版本」——否则菜单既勾不出内置，又把自己正跑的那版列成「可下载切换」。
  const builtinLabel = state.builtinVersion ?? (externalOn ? null : state.runningVersion)
  const builtinOn =
    !externalOn && (state.selected === null || state.selected === state.builtinVersion)
  /** 版本号与正在跑的一致、但那一行没打勾时标一下（打勾本身已经说明「就是它」） */
  const runningTag = (version: string | null, checked: boolean): string =>
    !checked && version !== null && version === state.runningVersion ? '（当前运行）' : ''
  // 外部 dsh 模式下「正在跑」的是外部那版，不该标到内置行上
  const builtinSuffix =
    runningTag(builtinLabel, builtinOn || externalOn) === '' ? '' : ' · 当前运行'
  const items: TrayMenuItem[] = [
    {
      type: 'normal',
      label:
        builtinLabel === null
          ? '内置（随安装包，版本未知）'
          : `内置 ${builtinLabel}（随安装包${builtinSuffix}）`,
      action: TRAY_MENU_ACTIONS.runtimeBuiltin,
      checked: builtinOn,
    },
  ]
  if (state.externalAvailable) {
    items.push({
      type: 'normal',
      label: '外部 dsh（DSH_BIN / PATH）',
      action: TRAY_MENU_ACTIONS.runtimeExternal,
      checked: externalOn,
    })
  }
  const installing = state.downloading
  // 下载中但还没进已装列表的版本也得有一行，否则点完菜单看不到任何反馈
  const installed = sortRuntimeVersionsDesc(
    [...new Set([...state.installed, ...(installing === null ? [] : [installing])])].filter(
      (version) => version !== builtinLabel
    )
  )
  for (const version of installed) {
    items.push({
      type: 'normal',
      label:
        installing === version
          ? `${version}（下载中…）`
          : `${version}${runningTag(version, !externalOn && state.selected === version)}`,
      action: `${TRAY_MENU_ACTIONS.runtimeVersionPrefix}${version}`,
      checked: !externalOn && state.selected === version,
      enabled: installing !== version,
    })
  }
  const pending = state.catalog
    .filter(
      (entry) =>
        !installed.includes(entry.version) &&
        entry.version !== builtinLabel &&
        !(externalOn && entry.version === state.runningVersion)
    )
    .slice(0, TRAY_RUNTIME_FETCH_LIMIT)
  if (pending.length > 0) items.push({ type: 'divider' })
  for (const entry of pending) {
    items.push({
      type: 'normal',
      label: `↓ 下载并切换 ${entry.version}${channelSuffix(entry.channel)}`,
      action: `${TRAY_MENU_ACTIONS.runtimeFetchPrefix}${entry.version}`,
      enabled: installing === null,
    })
  }
  return items
}

/**
 * 「dsh 服务地址」子菜单（旧壳 `remote_menu_items` 的等价物，#136）：本地/远程同层单选，
 * ● 当前生效 / ○ 可选；标签用 remoteDisplay（host[:port]，不含 token）。远程不可用
 * （token 失效 401 等）时也能从托盘一键切回本地，不用手改配置文件。
 */
export function remoteMenuItems(
  state: Pick<TrayState, 'remoteAddr' | 'remoteList'>,
): TrayMenuItem[] {
  const localMark = state.remoteAddr === null ? '●' : '○'
  const items: TrayMenuItem[] = [
    {
      type: 'normal',
      label: `${localMark} 本地（127.0.0.1）`,
      action: TRAY_MENU_ACTIONS.remoteLocal,
      checked: state.remoteAddr === null,
    },
  ]
  state.remoteList.forEach((addr, index) => {
    const mark = addr === state.remoteAddr ? '●' : '○'
    items.push({
      type: 'normal',
      label: `${mark} ${remoteDisplay(addr)}`,
      action: `${TRAY_MENU_ACTIONS.remoteAddrPrefix}${String(index)}`,
      checked: addr === state.remoteAddr,
    })
  })
  return items
}


/**
 * 托盘菜单限宽（目标 A6）：Electrobun 的菜单项没有 width 概念，超长 label 会把菜单
 * 拉到很宽（运行时路径/远程地址/冲突路径都可能很长）。按码点截断加省略号，
 * 保留动作语义（action 不变）；子菜单 label 同样处理。
 */
export const TRAY_LABEL_MAX = 48
export function truncateTrayLabel(label: string, max = TRAY_LABEL_MAX): string {
  const chars = Array.from(label)
  if (chars.length <= max) return label
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** 菜单树遍历：对每个普通项的 label 限宽；子菜单递归。 */
function truncateMenu(items: TrayMenuItem[]): TrayMenuItem[] {
  return items.map((item) => {
    if (item.type !== 'normal') return item
    const next: TrayMenuItem = { ...item, label: truncateTrayLabel(item.label) }
    if ('submenu' in item && item.submenu !== undefined) {
      ;(next as { submenu?: TrayMenuItem[] }).submenu = truncateMenu(item.submenu)
    }
    return next
  })
}
export function trayMenu(state: TrayState): TrayMenuItem[] {
  const profiles = orderedProfiles(state)
  const items: TrayMenuItem[] = [
    {
      type: 'normal',
      label: state.windowVisible ? '隐藏窗口' : '显示窗口',
      action: TRAY_MENU_ACTIONS.toggleWindow,
    },
    { type: 'divider' },
  ]
  // 「PROFILE 窗口」（旧壳 tray.rs:63-73 的等价物）：每 profile 一层子菜单，头部
  // `● name · port（聚焦中）` / `name · port（运行中）` / 未运行裸名；里面是「聚焦窗口」
  // （未运行时「在新窗口打开 <name>」）+ 运行中的「退出（停止实例）」。末尾挂「新建 Profile…」
  // 与「迁移 Profile…」两个顶层入口（F9 的 UI 门面，表单窗由壳进程弹出）。
  const rows =
    state.profileRows ??
    profiles.map((profile) => ({
      profile,
      open: state.openWindows.includes(profile),
      running: profile === state.profile && state.hostRunning,
      port: null as number | null,
      focused: profile === state.profile,
    }))
  const windowItems: TrayMenuItem[] = rows.map((row) => {
    const portPart = row.port !== null ? ` · ${row.port}` : ''
    const head = row.running
      ? `${row.focused ? '● ' : ''}${row.profile}${portPart}（${row.focused ? '聚焦中' : '运行中'}）`
      : row.profile
    const sub: TrayMenuItem[] = [
      {
        type: 'normal',
        label: row.open ? '聚焦窗口' : `在新窗口打开 ${row.profile}`,
        action: windowAction(row.profile),
        checked: row.focused,
      },
    ]
    if (row.running) {
      sub.push({ type: 'divider' })
      sub.push({
        type: 'normal',
        label: '退出（停止实例）',
        action: `${TRAY_MENU_ACTIONS.stopProfile}${row.profile}`,
      })
    }
    return { type: 'normal' as const, label: head, submenu: sub }
  })
  windowItems.push(
    { type: 'divider' },
    { type: 'normal', label: '新建 Profile…', action: TRAY_MENU_ACTIONS.newProfile },
    { type: 'normal', label: '迁移 Profile…', action: TRAY_MENU_ACTIONS.migrateProfile },
  )
  items.push({
    type: 'normal',
    label: 'PROFILE 窗口',
    submenu: windowItems,
  })
  items.push(
    // 运行时来源：只读一行看当前，真正的切换在子菜单里（旧壳的 `运行时版本` 子菜单同形）
    { type: 'normal', label: `运行时：${state.runtimeLabel}`, enabled: false },
    {
      type: 'normal',
      label: '运行时版本',
      submenu: runtimeMenuItems(state),
    },
    {
      type: 'normal',
      label: 'dsh 服务地址',
      submenu: remoteMenuItems(state),
    },
    {
      type: 'normal',
      label: state.hostRunning ? '状态：运行中' : '状态：宿主未运行',
      enabled: false,
    },
    { type: 'normal', label: '重启 dsh 服务', action: TRAY_MENU_ACTIONS.restartService },
    // 「注册 dsh 命令」（旧壳 #175 条件项）：只在未注册/冲突时出现，已注册或还没探出就不摆
    ...(state.registerLabel === null
      ? []
      : [
          {
            type: 'normal' as const,
            label: state.registerLabel,
            action: TRAY_MENU_ACTIONS.registerCli,
          },
        ]),
    { type: 'divider' },
    { type: 'normal', label: '退出', action: TRAY_MENU_ACTIONS.quit },
  )
  return truncateMenu(items)
}

/** 托盘图标的悬停/无障碍标题：一眼能看出「哪个 profile」 */
export function trayTitle(state: Pick<TrayState, 'profile'>): string {
  return `DSH · ${state.profile}`
}
