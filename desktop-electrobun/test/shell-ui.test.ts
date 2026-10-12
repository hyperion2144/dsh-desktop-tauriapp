// 壳自带的窗口 chrome（红绿灯让位）与应用菜单（系统剪贴板快捷键）的单测。
// 这两条都不是「可选项」：#200 的教训是「挂不上也要出声」，剪贴板则是没菜单就整个失效。
import { describe, expect, test } from 'bun:test'
import {
  CHROME_STYLE_ID,
  PLATFORM_MARK,
  SIDEBAR_MARK,
  TOP_INSET,
  chromeScript,
  chromeStyleText,
} from '../src/bun/chrome.ts'
import {
  REQUIRED_EDIT_ROLES,
  applicationMenuItems,
  installApplicationMenu,
  type MenuItem,
} from '../src/bun/menu.ts'

describe('窗口 chrome：红绿灯让位', () => {
  test('让位高度与旧壳 STRIP_HEIGHT 一致（darwin 28 / win 32 / linux 32）', () => {
    expect(TOP_INSET.darwin).toBe(28)
    expect(TOP_INSET.win32).toBe(32)
    expect(TOP_INSET.linux).toBe(32)
  })

  test('样式规则用平台标记 + 自己打的侧栏标记，不靠 hash 类名', () => {
    const css = chromeStyleText('darwin')
    expect(css).toContain(`body[${PLATFORM_MARK}="darwin"] [${SIDEBAR_MARK}]`)
    expect(css).toContain('padding-top: 28px')
    // 折叠/展开过渡会让侧栏宽度动画和我们的覆盖互相重启，旧壳同样禁用
    expect(css).toContain(`[${SIDEBAR_MARK}] { transition: none; }`)
  })

  test('注入脚本按 ui-layout 稳定标记定位侧栏，并对重渲染有兜底', () => {
    const script = chromeScript('darwin')
    expect(script).toContain('[data-shell-overlay]')
    expect(script).toContain(CHROME_STYLE_ID)
    expect(script).toContain(SIDEBAR_MARK)
    expect(script).toContain('MutationObserver')
    // 挂上留 info、找不到留 warn —— 不留无痕 no-op
    expect(script).toContain('console.info("[chrome] 侧栏顶部让位')
    expect(script).toContain('console.warn("[chrome] 没找到 ui-layout 侧栏')
  })

  test('脚本按平台生成：win32 的让位高度不同', () => {
    expect(chromeScript('win32')).toContain('const INSET = 32')
    expect(chromeScript('darwin')).toContain('const INSET = 28')
  })
})

describe('应用菜单：系统剪贴板快捷键', () => {
  test('编辑菜单带齐原生角色（少一个就少一组快捷键）', () => {
    const items = applicationMenuItems()
    const edit = items.find((item) => item.label === 'Edit')
    expect(edit).toBeDefined()
    const roles = (edit?.submenu ?? []).map((item) => item.role).filter(Boolean) as string[]
    for (const role of REQUIRED_EDIT_ROLES) expect(roles).toContain(role)
    expect(roles).toContain('undo')
    expect(roles).toContain('redo')
  })

  test('应用菜单与窗口菜单覆盖旧壳默认菜单那几项', () => {
    const items = applicationMenuItems('DeepSeek Harness Desktop')
    const app = items.find((item) => item.label === 'DeepSeek Harness Desktop')
    const appRoles = (app?.submenu ?? []).map((item) => item.role)
    expect(appRoles).toContain('quit')
    expect(appRoles).toContain('hide')
    expect(appRoles).toContain('about')
    const win = items.find((item) => item.label === 'Window')
    expect((win?.submenu ?? []).map((item) => item.role)).toContain('close')
  })

  test('安装时把同一份结构交给原生层，并留日志', () => {
    const seen: MenuItem[][] = []
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }
    try {
      installApplicationMenu({ setApplicationMenu: (items) => { seen.push(items) } })
    } finally {
      console.log = original
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(applicationMenuItems())
    expect(logs.join('\n')).toContain('已安装应用菜单')
  })
})
