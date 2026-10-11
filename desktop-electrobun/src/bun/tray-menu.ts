// 托盘菜单模型（纯逻辑，不 import electrobun ⇒ 缝 ② 直接断言）。
import { sortRuntimeVersionsDesc } from '../shared/runtime-catalog.ts'
//
// 为什么单独一层：菜单项文案、勾选状态、以及「点了哪一项要干什么」是产品语义，
// 而 `Tray` 类只是把它交给原生层。分开之后无显示器/无 CEF 也能测。
//
// 旧 Tauri 壳的托盘能力（`docs/research/shell-capability-inventory.md` 第 6 节）在这里逐项对齐：
// 显示/隐藏窗口、profile 切换、重启 dsh 服务、运行时来源切换（内置 / 外部 dsh / 已装版本 /
// 目录里点一下就下载并切换）、退出。
// 还没做的项不摆假入口——宁可菜单短，也不要点了没反应的项。

/** 托盘菜单里的动作 id；前缀 `tray:` 便于和右键菜单的 action 区分。 */
export const TRAY_MENU_ACTIONS = {
  toggleWindow: 'tray:toggle-window',
  quit: 'tray:quit',
  restartService: 'tray:restart-service',
  windowPrefix: 'tray:window:',
  runtimeBuiltin: 'tray:runtime:builtin',
  runtimeExternal: 'tray:runtime:external',
  runtimeVersionPrefix: 'tray:runtime:version:',
  runtimeFetchPrefix: 'tray:runtime:fetch:',
} as const

export type TrayActionKind =
  | 'toggle-window'
  | 'quit'
  | 'restart-service'
  | 'open-window'
  | 'switch-runtime'
  | 'download-runtime'

export interface TrayAction {
  kind: TrayActionKind
  /** kind === 'select-profile' 时是目标 profile */
  profile?: string
  /** kind === 'switch-runtime'：'builtin' 是内置树，'external' 是系统装的 dsh CLI；
   *  已下载版本用同样的 kind 加 version 表示 */
  mode?: 'builtin' | 'external'
  /** kind === 'switch-runtime'（目标版本）或 'download-runtime'（要下的版本） */
  version?: string
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
  // 多 profile：菜单按 home 下的 profile 目录列，点了开/聚焦那一份窗口（旧壳「PROFILE 窗口」分组）
  items.push({
    type: 'normal',
    label: 'PROFILE 窗口',
    submenu: profiles.map((profile) => ({
      type: 'normal',
      label: state.openWindows.includes(profile) ? `${profile}（已开窗）` : profile,
      action: windowAction(profile),
      checked: profile === state.profile,
    })),
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
      label: state.hostRunning ? '状态：运行中' : '状态：宿主未运行',
      enabled: false,
    },
    { type: 'normal', label: '重启 dsh 服务', action: TRAY_MENU_ACTIONS.restartService },
    { type: 'divider' },
    { type: 'normal', label: '退出', action: TRAY_MENU_ACTIONS.quit },
  )
  return items
}

/** 托盘图标的悬停/无障碍标题：一眼能看出「哪个 profile」 */
export function trayTitle(state: Pick<TrayState, 'profile'>): string {
  return `DSH · ${state.profile}`
}
