// 页面交互的两条补丁：外链转系统浏览器 + 右键菜单。
//
// 这两条都是「换掉旧壳后丢掉的能力」——旧壳（WKWebView + Tauri）自带右键菜单、并由
// nav_guard/webRequest 把 window.open 转给系统浏览器；CEF 两样都不做，不自己补就表现为
// 「点链接把窗口带走」「右键没有任何菜单」。
import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_MENU_ENDPOINT,
  SHELL_MENU_ACTIONS,
  contextMenuItems,
  contextMenuScript,
  type ShellMenuItem,
} from '../src/bun/context-menu.ts'
import { OPEN_EXTERNAL_ENDPOINT, externalLinksScript, isExternalUrl } from '../src/bun/external.ts'
import { VIEW_TOKEN_HEADER } from '../src/shared/view-grant.ts'

const SELF = 'http://127.0.0.1:6391'

describe('外链：判定与拦截脚本', () => {
  test('同源链接留给应用内，别的一律交系统浏览器', () => {
    expect(isExternalUrl('https://example.com/a', SELF)).toBe(true)
    expect(isExternalUrl(`${SELF}/tok-1/`, SELF)).toBe(false)
    // 相对路径按 selfOrigin 解析，等于自己
    expect(isExternalUrl('/tok-1/settings', SELF)).toBe(false)
    expect(isExternalUrl('mailto:a@b.c', SELF)).toBe(true)
    expect(isExternalUrl('tel:+8613800000000', SELF)).toBe(true)
    // 别的 scheme 不接（html 里可能出现的 javascript: / file: / blob:）
    expect(isExternalUrl('javascript:alert(1)', SELF)).toBe(false)
    expect(isExternalUrl('file:///etc/passwd', SELF)).toBe(false)
    // 解析不了的字符串按相对路径落到自己 origin 上，当同源处理
    expect(isExternalUrl('not a url', SELF)).toBe(false)
  })

  test('window.open 被改写：上游「在系统浏览器打开」就是这一句', () => {
    const script = externalLinksScript(SELF, 'tok-a')
    expect(script).toContain(OPEN_EXTERNAL_ENDPOINT)
    expect(script).toContain(JSON.stringify(SELF))
    expect(script).toContain('globalThis.open = function')
    expect(script).toContain(VIEW_TOKEN_HEADER)
    expect(script).toContain('nativeOpen.call')
  })

  test('点击与中键都要拦，且放行页面自己处理过的链接', () => {
    const script = externalLinksScript(SELF, 'tok-a')
    expect(script).toContain('addEventListener("click"')
    // 中键：不拦就会在实例里打开新页面，把壳带走（用户报的那条）
    expect(script).toContain('addEventListener("auxclick"')
    expect(script).toContain('event.defaultPrevented')
    expect(script).toContain('a[href]')
    // 锚点内部跳转不碰
    expect(script).toContain('startsWith("#")')
  })
})

describe('右键菜单：结构', () => {
  const none = { linkUrl: null, hasSelection: false, editable: false }
  /** 只取 role 项——我们自己的 action 项（刷新/外链/复制链接）没有 role。 */
  const roles = (items: ShellMenuItem[]): (string | undefined)[] =>
    items.filter((item) => item.role !== undefined).map((item) => item.role)

  test('空白处只有「刷新页面」——旧壳那份菜单里我们最需要的就这一项', () => {
    const items = contextMenuItems(none, false)
    expect(items).toEqual([{ label: '刷新页面', action: SHELL_MENU_ACTIONS.reload }])
  })

  test('外链上多出「在系统浏览器打开」与「复制链接地址」', () => {
    const items = contextMenuItems({ ...none, linkUrl: 'https://example.com/a' }, true)
    expect(items[0]).toMatchObject({ action: SHELL_MENU_ACTIONS.openExternal, data: { url: 'https://example.com/a' } })
    expect(items[1]).toMatchObject({ action: SHELL_MENU_ACTIONS.copyLink })
    expect(items.map((item) => item.label)).toContain('刷新页面')
  })

  test('应用内链接不给「在系统浏览器打开」（同源没必要绕出去）', () => {
    const labels = contextMenuItems({ ...none, linkUrl: `${SELF}/tok/a` }, false).map((item) => item.label)
    expect(labels).toContain('复制链接地址')
    expect(labels).not.toContain('在系统浏览器打开链接')
  })

  test('输入框给剪切/粘贴，普通选区只给复制', () => {
    const editable = contextMenuItems({ linkUrl: null, hasSelection: true, editable: true }, false)
    expect(roles(editable)).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    const selected = contextMenuItems({ linkUrl: null, hasSelection: true, editable: false }, false)
    expect(roles(selected)).toEqual(['copy', 'selectAll'])
  })

  test('没有选区时剪切/复制置灰，但粘贴可用', () => {
    const items = contextMenuItems({ linkUrl: null, hasSelection: false, editable: true }, false)
    expect(items.find((item) => item.role === 'cut')?.enabled).toBe(false)
    expect(items.find((item) => item.role === 'copy')?.enabled).toBe(false)
    expect(items.find((item) => item.role === 'paste')?.enabled).toBeUndefined()
  })
})

describe('右键菜单：注入脚本', () => {
  test('把上下文报给壳端点，并带上坐标以外的三个判据', () => {
    const script = contextMenuScript('tok-a')
    expect(script).toContain(CONTEXT_MENU_ENDPOINT)
    expect(script).toContain('addEventListener("contextmenu"')
    expect(script).toContain('linkUrl')
    expect(script).toContain('hasSelection')
    expect(script).toContain('isContentEditable')
  })

  test('页面自己接管过右键就不插手', () => {
    expect(contextMenuScript('tok-a')).toContain('if (event.defaultPrevented) return')
  })
})
