// 托盘：把 tray-menu.ts 的菜单模型交给 Electrobun 的原生托盘（这一层才 import electrobun）。
//
// 旧 Tauri 壳的托盘（`desktop/src-tauri/src/ui/tray.rs`）是自己拼菜单 + 回调；
// Electrobun 自带 `Tray`，但**没有 tooltip**，所以状态信息只能进菜单项与标题文字。
//
// 原生层起不来的情况（Linux 某些桌面环境）不让它拖垮整个壳：返回 null，调用方只记一条日志。

import { Tray } from 'electrobun/bun'
import { parseTrayAction, trayMenu, trayTitle, type TrayAction, type TrayState } from './tray-menu.ts'

export interface TrayHandle {
  setState: (state: TrayState) => void
  destroy: () => void
}

export interface CreateTrayOptions {
  /** 托盘图标文件路径（打包后是包内 runtime/tray.png） */
  image: string
  state: TrayState
  onAction: (action: TrayAction) => void
  /** 左键单击托盘图标（不带菜单动作）：旧壳 focus_last_or_main（tray.rs:265-285，#181）——聚焦最后活跃窗口 */
  onEmptyClick?: () => void
  log?: (line: string) => void
}

/** 托盘图标按 18pt 渲染（Retina 上原生层会取 2x；给太小会糊）。 */
const TRAY_ICON_SIZE = 18

export function createTray(options: CreateTrayOptions): TrayHandle | null {
  const log = options.log ?? ((): void => {})
  let tray: Tray
  try {
    tray = new Tray({ image: options.image, template: false, width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE })
  } catch (error) {
    log(`[shell] 托盘创建失败（继续无托盘运行）：${String(error)}`)
    return null
  }
  if (!tray.visible) {
    log('[shell] 托盘不可用（原生层没建成），继续无托盘运行')
    return null
  }

  // 菜单更新一律走 setMenu，**不重建托盘**；内容没变就不重复下发——菜单正开着时
  // 反复 setMenu 会把它顶掉（用户口径：刷新要事件驱动，别让菜单消失）。
  let lastMenu = ''
  const apply = (state: TrayState): void => {
    try {
      const menu = trayMenu(state)
      const serialized = JSON.stringify(menu)
      if (serialized === lastMenu) return
      lastMenu = serialized
      tray.setMenu(menu)
    } catch (error) {
      log(`[shell] 托盘菜单更新失败：${String(error)}`)
    }
  }

  tray.on('tray-clicked', (event) => {
    const rawAction = (event as { data?: { action?: string } }).data?.action
    if ((rawAction ?? '') === '') {
      // 左键单击：聚焦窗口（不弹菜单也没反应就太傻了）
      options.onEmptyClick?.()
      return
    }
    const action = parseTrayAction(rawAction)
    if (action === null) return
    options.onAction(action)
  })

  apply(options.state)
  log(`[shell] 托盘已就绪（${trayTitle(options.state)}）`)

  return {
    setState: apply,
    destroy: () => {
      try {
        tray.remove()
      } catch {}
    },
  }
}
