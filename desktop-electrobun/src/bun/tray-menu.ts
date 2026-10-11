// 托盘菜单模型（纯逻辑，不 import electrobun ⇒ 缝 ② 直接断言）。
//
// 为什么单独一层：菜单项文案、勾选状态、以及「点了哪一项要干什么」是产品语义，
// 而 `Tray` 类只是把它交给原生层。分开之后无显示器/无 CEF 也能测。
//
// 旧 Tauri 壳的托盘能力（`docs/research/shell-capability-inventory.md` 第 6 节）在这里逐项对齐：
// 显示/隐藏窗口、profile 切换、运行时来源（只读展示，切换在运行时管理那一轮）、退出。
// 还没做的项不摆假入口——宁可菜单短，也不要点了没反应的项。

/** 托盘菜单里的动作 id；前缀 `tray:` 便于和右键菜单的 action 区分。 */
export const TRAY_MENU_ACTIONS = {
  toggleWindow: 'tray:toggle-window',
  quit: 'tray:quit',
  profilePrefix: 'tray:profile:',
} as const

export type TrayActionKind = 'toggle-window' | 'quit' | 'select-profile'

export interface TrayAction {
  kind: TrayActionKind
  /** kind === 'select-profile' 时是目标 profile */
  profile?: string
}

export interface TrayState {
  /** 主窗当前是否可见（隐藏 = 关到了托盘） */
  windowVisible: boolean
  /** 当前 profile */
  profile: string
  /** 可用 profile（当前的在最前，其余按字典序） */
  profiles: readonly string[]
  /** dsh 宿主是否在跑（守护器重启期间会短暂为 false） */
  hostRunning: boolean
  /** 运行时来源的人类可读标签，例如 `内置 0.2.1-alpha.2` */
  runtimeLabel: string
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

export function profileAction(profile: string): string {
  return `${TRAY_MENU_ACTIONS.profilePrefix}${profile}`
}

/** 菜单点击 → 语义动作；未知 action 返回 null（原生 role 之类不该被我们处理）。 */
export function parseTrayAction(action: string | undefined | null): TrayAction | null {
  if (action === undefined || action === null) return null
  if (action === TRAY_MENU_ACTIONS.toggleWindow) return { kind: 'toggle-window' }
  if (action === TRAY_MENU_ACTIONS.quit) return { kind: 'quit' }
  if (action.startsWith(TRAY_MENU_ACTIONS.profilePrefix)) {
    const profile = action.slice(TRAY_MENU_ACTIONS.profilePrefix.length)
    if (profile === '') return null
    return { kind: 'select-profile', profile }
  }
  return null
}

/** 当前 profile 排最前、其余去重后字典序——菜单顺序稳定，不随发现顺序抖。 */
export function orderedProfiles(state: Pick<TrayState, 'profile' | 'profiles'>): string[] {
  const rest = [...new Set(state.profiles)].filter((entry) => entry !== state.profile).sort()
  return [state.profile, ...rest]
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
  if (profiles.length > 1) {
    items.push({
      type: 'normal',
      label: `切换 Profile（当前 ${state.profile}）`,
      submenu: profiles.map((profile) => ({
        type: 'normal',
        label: profile,
        action: profileAction(profile),
        checked: profile === state.profile,
      })),
    })
  } else {
    items.push({ type: 'normal', label: `Profile：${state.profile}`, enabled: false })
  }
  items.push(
    // 运行时来源只读展示：真正能切的那一轮（运行时管理）再把它变成子菜单
    { type: 'normal', label: `运行时：${state.runtimeLabel}`, enabled: false },
    {
      type: 'normal',
      label: state.hostRunning ? '状态：运行中' : '状态：宿主未运行',
      enabled: false,
    },
    { type: 'divider' },
    { type: 'normal', label: '退出', action: TRAY_MENU_ACTIONS.quit },
  )
  return items
}

/** 托盘图标的悬停/无障碍标题：一眼能看出「哪个 profile」 */
export function trayTitle(state: Pick<TrayState, 'profile'>): string {
  return `DSH · ${state.profile}`
}
