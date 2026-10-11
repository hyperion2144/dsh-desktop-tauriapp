import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TRAY_MENU_ACTIONS,
  type TrayMenuItem,
  type TrayState,
  orderedProfiles,
  parseTrayAction,
  profileAction,
  trayMenu,
  trayTitle,
} from '../src/bun/tray-menu.ts'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_VISIBLE_EDGE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type DisplayBounds,
  type WindowFrame,
  clearWindowFrame,
  isFrameVisible,
  parseWindowFrame,
  readWindowFrame,
  sanitizeFrame,
  writeWindowFrame,
} from '../src/bun/window-state.ts'

const labels = (items: TrayMenuItem[]): string[] =>
  items.map((item) => (item.type === 'divider' ? '---' : `${item.checked === true ? '✓ ' : ''}${item.label}`))

type NormalItem = Extract<TrayMenuItem, { type: 'normal' }>

const isNormal = (item: TrayMenuItem): item is NormalItem => item.type === 'normal'

const findItem = (items: TrayMenuItem[], label: string): NormalItem | undefined =>
  items.find((item): item is NormalItem => isNormal(item) && item.label === label)

const baseState = (overrides: Partial<TrayState> = {}): TrayState => ({
  windowVisible: true,
  profile: 'desktop',
  profiles: ['desktop'],
  hostRunning: true,
  runtimeLabel: '内置 0.2.1-alpha.2',
  ...overrides,
})

describe('trayMenu', () => {
  test('窗口可见时给「隐藏窗口」，隐藏时给「显示窗口」', () => {
    const shown = labels(trayMenu(baseState({ windowVisible: true })))
    const hidden = labels(trayMenu(baseState({ windowVisible: false })))
    expect(shown[0]).toBe('隐藏窗口')
    expect(hidden[0]).toBe('显示窗口')
  })

  test('单个 profile 时不给子菜单，只给禁用的当前 profile 行', () => {
    const items = trayMenu(baseState())
    const profile = findItem(items, 'Profile：desktop')
    expect(profile).toBeDefined()
    expect(profile?.enabled).toBe(false)
    expect(profile?.submenu).toBeUndefined()
  })

  test('多个 profile 时给子菜单，当前项打勾且排在第一位', () => {
    const items = trayMenu(baseState({ profile: 'web', profiles: ['desktop', 'web', 'mobile'] }))
    const submenu = findItem(items, '切换 Profile（当前 web）')?.submenu
    expect(submenu !== undefined).toBe(true)
    expect(labels(submenu ?? [])).toEqual(['✓ web', 'desktop', 'mobile'])
    expect(findItem(submenu ?? [], 'desktop')?.action).toBe(profileAction('desktop'))
  })

  test('运行时与宿主状态是只读行，退出永远在最后', () => {
    const items = trayMenu(baseState({ hostRunning: false }))
    expect(findItem(items, '运行时：内置 0.2.1-alpha.2')?.enabled).toBe(false)
    expect(findItem(items, '状态：宿主未运行')?.enabled).toBe(false)
    const last = [...items].reverse().find(isNormal)
    expect(last?.label).toBe('退出')
    expect(last?.action).toBe(TRAY_MENU_ACTIONS.quit)
  })

  test('标题带当前 profile', () => {
    expect(trayTitle(baseState({ profile: 'web' }))).toBe('DSH · web')
  })

  test('菜单结构稳定：两条分隔线，动作行只有三处', () => {
    const items = trayMenu(baseState({ profile: 'web', profiles: ['web', 'app'] }))
    expect(items.filter((item) => item.type === 'divider').length).toBe(2)
    const actionable = items.filter((item): item is NormalItem => isNormal(item) && item.action !== undefined)
    // 子菜单父项只挂 submenu、不带 action；真正可点的顶层动作只有两个
    expect(actionable.map((item) => item.label).sort()).toEqual(['退出', '隐藏窗口'].sort())
  })
})

describe('parseTrayAction', () => {
  test('解析三条动作', () => {
    expect(parseTrayAction(TRAY_MENU_ACTIONS.toggleWindow)).toEqual({ kind: 'toggle-window' })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.quit)).toEqual({ kind: 'quit' })
    expect(parseTrayAction(profileAction('web'))).toEqual({ kind: 'select-profile', profile: 'web' })
  })

  test('未知动作与空 profile 都返回 null', () => {
    expect(parseTrayAction(undefined)).toBeNull()
    expect(parseTrayAction(null)).toBeNull()
    expect(parseTrayAction('')).toBeNull()
    expect(parseTrayAction('tray:other')).toBeNull()
    expect(parseTrayAction(TRAY_MENU_ACTIONS.profilePrefix)).toBeNull()
  })
})

describe('orderedProfiles', () => {
  test('当前在最前，其余去重排序', () => {
    expect(orderedProfiles({ profile: 'desktop', profiles: ['web', 'desktop', 'web', 'app'] })).toEqual([
      'desktop',
      'app',
      'web',
    ])
  })

  test('当前不在列表里也补上', () => {
    expect(orderedProfiles({ profile: 'desktop', profiles: [] })).toEqual(['desktop'])
  })
})

describe('window-state', () => {
  const display: DisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 }
  const ok: WindowFrame = { x: 100, y: 60, width: 1280, height: 860 }

  test('parseWindowFrame 拒绝坏 JSON、缺字段与过小的框', () => {
    expect(parseWindowFrame('')).toBeNull()
    expect(parseWindowFrame('{ 坏')).toBeNull()
    expect(parseWindowFrame('null')).toBeNull()
    expect(parseWindowFrame('{"x":0,"y":0}')).toBeNull()
    expect(parseWindowFrame(JSON.stringify({ x: 0, y: 0, width: MIN_WINDOW_WIDTH - 1, height: 860 }))).toBeNull()
    expect(parseWindowFrame(JSON.stringify({ x: 0, y: 0, width: 1280, height: MIN_WINDOW_HEIGHT - 1 }))).toBeNull()
  })

  test('parseWindowFrame 取整并接受合法框', () => {
    expect(parseWindowFrame(JSON.stringify({ x: 10.6, y: 20.2, width: 1280.4, height: 860.9 }))).toEqual({
      x: 11,
      y: 20,
      width: 1280,
      height: 861,
    })
  })

  test('完全在屏外的框判为不可见（含只剩一条边）', () => {
    const offscreen: WindowFrame = { x: display.width, y: 0, width: 1280, height: 860 }
    expect(isFrameVisible(offscreen, [display])).toBe(false)
    expect(sanitizeFrame(offscreen, [display])).toBeNull()
    const sliver: WindowFrame = { x: display.width - MIN_VISIBLE_EDGE + 1, y: 0, width: 1280, height: 860 }
    expect(isFrameVisible(sliver, [display])).toBe(false)
  })

  test('没有屏幕信息时不做还原（宁可居中开）', () => {
    expect(sanitizeFrame(ok, [])).toBeNull()
    expect(isFrameVisible(ok, [])).toBe(false)
  })

  test('尺寸超出主屏时按主屏夹取', () => {
    const tooBig: WindowFrame = { x: 0, y: 0, width: 3000, height: 2000 }
    expect(sanitizeFrame(tooBig, [display])).toEqual({
      x: 0,
      y: 0,
      width: display.width,
      height: display.height,
    })
  })

  test('屏内但比最小尺寸小的框按最小尺寸放大', () => {
    const tiny: WindowFrame = { x: 40, y: 40, width: 100, height: 100 }
    expect(sanitizeFrame(tiny, [display])).toEqual({
      x: 40,
      y: 40,
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
    })
  })

  test('读不到/坏文件都退回 null，写出后可原样读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-window-'))
    const file = join(dir, 'window.json')
    expect(readWindowFrame(file)).toBeNull()
    writeFileSync(file, '{ 坏 json')
    expect(readWindowFrame(file)).toBeNull()
    writeWindowFrame(file, ok)
    expect(readWindowFrame(file)).toEqual(ok)
    clearWindowFrame(file)
    expect(readWindowFrame(file)).toBeNull()
  })

  test('默认尺寸仍然大于最小尺寸', () => {
    expect(DEFAULT_WINDOW_WIDTH).toBeGreaterThan(MIN_WINDOW_WIDTH)
    expect(DEFAULT_WINDOW_HEIGHT).toBeGreaterThan(MIN_WINDOW_HEIGHT)
  })
})
