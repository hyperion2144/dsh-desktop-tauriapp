// 多窗口的纯逻辑（不 import electrobun ⇒ 缝 ② 直接断言）。
//
// 旧 Tauri 壳的定稿在 `desktop/src-tauri/src/ui/multiwin.rs` 头注释里：
// 托盘「PROFILE 窗口」分组——运行中点击聚焦窗口，未运行点击开新窗（每 profile 至多一窗）；
// 激活 profile 的窗口就是主窗；任意窗口关闭 = 只销毁窗口 UI、实例保留（关窗 ≠ 停实例）；
// 主窗关闭 = 隐藏回托盘。
//
// 与旧壳的差异（有意为之，写在这里免得以后当成漏做）：旧壳一个 profile 一份 dsh 实例是
// 「端口台账 + 令牌交换」撑起来的，新壳每 profile 起一份 `ShellService`（各自一个 loopback
// origin 与宿主），所以「就地切换 profile」这件事不存在了——「切换」就是开/聚焦那份窗口。

/** 窗口与 profile 的绑定键（日志与状态文件用；Electrobun 的窗口 id 由框架给，不在这里）。 */
export function windowKey(profile: string): string {
  return `profile-${profile}`
}

export type WindowOpenPlan = 'focus' | 'create'

/** 点托盘里的 profile：已经开着就聚焦，没开就建窗。 */
export function planWindowOpen(profile: string, open: readonly string[]): WindowOpenPlan {
  return open.includes(profile) ? 'focus' : 'create'
}

export type WindowCloseAction = 'hide-to-tray' | 'destroy'

/** 关窗语义：主窗（启动 profile）隐藏回托盘，其余窗口只销毁 UI（实例继续跑）。 */
export function closeAction(profile: string, bootProfile: string): WindowCloseAction {
  return profile === bootProfile ? 'hide-to-tray' : 'destroy'
}

/**
 * 第 N 个窗口的初始位置：主窗用记下来的几何，其余每次右下偏移 26pt——
 * 都落在同一个坐标上会看起来「只开了一个窗口」（旧壳按 profile 各记一份几何，这里不做）。
 */
export function offsetFrame<T extends { x: number; y: number; width: number; height: number }>(
  frame: T,
  index: number
): T {
  if (index <= 0) return frame
  const step = 26 * index
  return { ...frame, x: frame.x + step, y: frame.y + step }
}
