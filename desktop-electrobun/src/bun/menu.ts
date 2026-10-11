// macOS 的复制/粘贴不是渲染进程自己处理的：没有 Edit 菜单（NSMenu 里挂 copy:/paste:/
// selectAll: 这些选择器）时，Cmd+C / Cmd+V / Cmd+A 就是死的。Electrobun **默认不装菜单**，
// 所以新壳一上来就没有这些系统快捷键；旧壳（Tauri）自带一份默认菜单，那时是可用的。
//
// 这里装一份最小菜单：应用 / 编辑 / 窗口。编辑菜单用 role 走原生选择器，不自己实现剪贴板。
// 只在 macOS 装（Windows/Linux 的 Ctrl+C/V 由 CEF 渲染进程自己处理，装了反而多出一条菜单栏，
// 而那边旧壳的标题栏是自绘的）。

import { APP_NAME } from '../shared/app.ts'

export interface MenuItem {
  type?: 'normal' | 'separator' | 'divider'
  label?: string
  role?: string
  accelerator?: string
  submenu?: MenuItem[]
}

/** 应用菜单结构（纯数据，便于单测断言剪贴板角色没有丢）。 */
export function applicationMenuItems(appName = APP_NAME): MenuItem[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'showAll' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
  ]
}

/** 编辑菜单里必须存在的原生角色（缺一个，对应的系统快捷键就失效）。 */
export const REQUIRED_EDIT_ROLES = ['cut', 'copy', 'paste', 'selectAll'] as const

export function installApplicationMenu(
  applicationMenu: { setApplicationMenu(items: MenuItem[]): void },
  appName?: string,
): void {
  const items = applicationMenuItems(appName)
  applicationMenu.setApplicationMenu(items)
  console.log('[shell] 已安装应用菜单（Edit 角色：cut/copy/paste/selectAll）')
}
