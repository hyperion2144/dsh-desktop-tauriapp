import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TRAY_MENU_ACTIONS,
  TRAY_RUNTIME_FETCH_LIMIT,
  type TrayMenuItem,
  type TrayState,
  orderedProfiles,
  parseTrayAction,
  remoteMenuItems,
  windowAction,
  runtimeMenuItems,
  trayMenu,
  trayTitle,
} from '../src/bun/tray-menu.ts'
import { TRAY_LABEL_MAX, truncateTrayLabel } from '../src/bun/tray-menu.ts'
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
  openWindows: [],
  hostRunning: true,
  runtimeLabel: '内置 0.2.1-alpha.2',
  mode: 'builtin',
  builtinVersion: '0.2.1-alpha.2',
  runningVersion: '0.2.1-alpha.2',
  selected: null,
  installed: [],
  catalog: [],
  externalAvailable: false,
  downloading: null,
  remoteAddr: null,
  remoteList: [],
  registerLabel: null,
  ...overrides,
})

describe('trayMenu', () => {

  test('「注册 dsh 命令」条件项：未注册/冲突时出现，已注册或未探出就不摆', () => {
    expect(labels(trayMenu(baseState()).slice(-4))).toContain('重启 dsh 服务')
    expect(findItem(trayMenu(baseState()), '注册 dsh 为系统命令')).toBeUndefined()

    const missing = trayMenu(baseState({ registerLabel: '注册 dsh 为系统命令' }))
    expect(findItem(missing, '注册 dsh 为系统命令')?.action).toBe('tray:register-cli')

    const conflict = trayMenu(baseState({ registerLabel: '注册 dsh 为系统命令（检测到冲突：/opt/homebrew/bin/dsh）' }))
    expect(findItem(conflict, '注册 dsh 为系统命令（检测到冲突：/opt/homebrew/bin/dsh）')).toBeDefined()
  })

  test('窗口可见时给「隐藏窗口」，隐藏时给「显示窗口」', () => {
    const shown = labels(trayMenu(baseState({ windowVisible: true })))
    const hidden = labels(trayMenu(baseState({ windowVisible: false })))
    expect(shown[0]).toBe('隐藏窗口')
    expect(hidden[0]).toBe('显示窗口')
  })

  test('PROFILE 窗口子菜单：未运行裸名 + 「在新窗口打开」，末尾挂新建/迁移入口', () => {
    const items = trayMenu(baseState({ openWindows: ['desktop'] }))
    const group = findItem(items, 'PROFILE 窗口')
    const submenu = group?.submenu ?? []
    expect(submenu[0]?.type).toBe('normal')
    expect((submenu[0] as NormalItem).label).toBe('● desktop（聚焦中）')
    const nested = (submenu[0] as NormalItem).submenu ?? []
    expect((nested[0] as NormalItem).label).toBe('聚焦窗口')
    expect((nested[0] as NormalItem).action).toBe(windowAction('desktop'))
    const tail = submenu.slice(-3)
    expect((tail[0] as { type?: string }).type).toBe('divider')
    expect((tail[1] as NormalItem).label).toBe('新建 Profile…')
    expect(parseTrayAction((tail[1] as NormalItem).action)).toEqual({ kind: 'new-profile' })
    expect((tail[2] as NormalItem).label).toBe('迁移 Profile…')
    expect(parseTrayAction((tail[2] as NormalItem).action)).toEqual({ kind: 'migrate-profile' })
  })

  test('多个 profile：当前项打勾且排第一位，没开窗的不带后缀', () => {
    const items = trayMenu(
      baseState({
        profile: 'web',
        profiles: ['desktop', 'web', 'mobile'],
        openWindows: ['web'],
        profileRows: [
          { profile: 'web', open: true, running: true, port: 6393, focused: true },
          { profile: 'desktop', open: false, running: false, port: null, focused: false },
          { profile: 'mobile', open: false, running: false, port: null, focused: false },
        ],
      })
    )
    const submenu = findItem(items, 'PROFILE 窗口')?.submenu
    expect(submenu !== undefined).toBe(true)
    const webHead = (submenu ?? [])[0] as NormalItem
    expect(webHead.label).toBe('● web · 6393（聚焦中）')
    const webSub = webHead.submenu ?? []
    expect((webSub[0] as NormalItem).label).toBe('聚焦窗口')
    expect((webSub[0] as NormalItem).action).toBe(windowAction('web'))
    expect((webSub[webSub.length - 1] as NormalItem).label).toBe('退出（停止实例）')
    expect(parseTrayAction((webSub[webSub.length - 1] as NormalItem).action)).toEqual({
      kind: 'stop-profile',
      profile: 'web',
    })
    expect(((submenu ?? [])[1] as NormalItem).label).toBe('desktop')
    expect(((submenu ?? [])[2] as NormalItem).label).toBe('mobile')
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
    // 子菜单父项只挂 submenu、不带 action；真正可点的顶层动作只有三个
    expect(actionable.map((item) => item.label).sort()).toEqual(['退出', '隐藏窗口', '重启 dsh 服务'].sort())
  })
})

describe('parseTrayAction', () => {
  test('解析三条动作', () => {
    expect(parseTrayAction(TRAY_MENU_ACTIONS.toggleWindow)).toEqual({ kind: 'toggle-window' })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.quit)).toEqual({ kind: 'quit' })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.restartService)).toEqual({ kind: 'restart-service' })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.runtimeBuiltin)).toEqual({
      kind: 'switch-runtime',
      mode: 'builtin',
    })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.runtimeExternal)).toEqual({
      kind: 'switch-runtime',
      mode: 'external',
    })
    expect(parseTrayAction(`${TRAY_MENU_ACTIONS.runtimeVersionPrefix}0.2.1-alpha.1`)).toEqual({
      kind: 'switch-runtime',
      version: '0.2.1-alpha.1',
    })
    expect(parseTrayAction(`${TRAY_MENU_ACTIONS.runtimeFetchPrefix}0.2.0-rc.2`)).toEqual({
      kind: 'download-runtime',
      version: '0.2.0-rc.2',
    })
    expect(parseTrayAction(windowAction('web'))).toEqual({ kind: 'open-window', profile: 'web' })
  })

describe('remoteMenuItems（托盘「dsh 服务地址」，旧壳 #136）', () => {
  test('本地生效：本地 ●、远程 ○，标签不含 token', () => {
    const items = remoteMenuItems({
      remoteAddr: null,
      remoteList: ['http://192.168.1.10:3080/?token=secret123', 'dsh.example.cn'],
    })
    expect(items.length).toBe(3)
    expect((items[0] as NormalItem).label).toBe('● 本地（127.0.0.1）')
    expect((items[0] as NormalItem).action).toBe(TRAY_MENU_ACTIONS.remoteLocal)
    expect((items[1] as NormalItem).label).toBe('○ 192.168.1.10:3080')
    expect(((items[1] as NormalItem).label ?? '')).not.toContain('secret123')
    expect((items[2] as NormalItem).label).toBe('○ dsh.example.cn')
  })

  test('远程生效：选中项 ● 且 id 按列表序稳定', () => {
    const list = ['http://192.168.1.10:3080/?token=abc', 'dsh.example.cn']
    const items = remoteMenuItems({ remoteAddr: list[0] ?? null, remoteList: list })
    expect((items[0] as NormalItem).label).toBe('○ 本地（127.0.0.1）')
    expect((items[1] as NormalItem).label).toBe('● 192.168.1.10:3080')
    expect(parseTrayAction((items[1] as NormalItem).action)).toEqual({ kind: 'remote-source', addrIndex: 0 })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.remoteLocal)).toEqual({ kind: 'remote-source' })
  })

  test('trayMenu 里有「dsh 服务地址」子菜单且空列表只留本地一行', () => {
    const menu = trayMenu(baseState())
    const group = findItem(menu, 'dsh 服务地址')
    expect(group?.submenu?.length).toBe(1)
    expect(((group?.submenu?.[0] ?? {}) as NormalItem).label).toContain('本地')
  })
})
})

describe('parseTrayAction 的前缀边界', () => {
  test('前缀后面什么都没有就回 null，不造出空版本', () => {
    expect(parseTrayAction(TRAY_MENU_ACTIONS.runtimeVersionPrefix)).toBeNull()
    expect(parseTrayAction(TRAY_MENU_ACTIONS.runtimeFetchPrefix)).toBeNull()
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

describe('runtimeMenuItems（托盘里的运行时来源切换）', () => {
  test('默认只用内置树：内置打勾，不列外部也不列已装版本', () => {
    expect(labels(runtimeMenuItems(baseState()))).toEqual(['✓ 内置 0.2.1-alpha.2（随安装包）'])
  })

  test('内置版本拿不到时，退成「正在跑的版本」（不再显示版本未知）', () => {
    const items = runtimeMenuItems(baseState({ builtinVersion: null }))
    expect(findItem(items, '内置 0.2.1-alpha.2（随安装包）')?.checked).toBe(true)
  })

  test('内置版本与正在跑的版本都拿不到时；才写「版本未知」', () => {
    const items = runtimeMenuItems(baseState({ builtinVersion: null, runningVersion: null }))
    expect(findItem(items, '内置（随安装包，版本未知）')?.checked).toBe(true)
  })

  test('目录里与正在跑同号的版本不再列成「下载并切换」', () => {
    const catalog = [
      { version: '0.2.1-alpha.2', channel: 'alpha' },
      { version: '0.2.1-alpha.1', channel: 'alpha' },
    ]
    const items = runtimeMenuItems(baseState({ builtinVersion: null, catalog }))
    expect(labels(items).filter((label) => label.startsWith('↓ 下载并切换'))).toEqual([
      '↓ 下载并切换 0.2.1-alpha.1（alpha）',
    ])
  })

  test('已装版本与正在跑的不一致时，那一行标「（当前运行）」', () => {
    const items = runtimeMenuItems(
      baseState({ installed: ['0.2.1-alpha.1'], runningVersion: '0.2.1-alpha.1' })
    )
    expect(labels(items)).toContain('0.2.1-alpha.1（当前运行）')
  })

  test('外部 dsh 只在系统里真能找到时才列', () => {
    expect(findItem(runtimeMenuItems(baseState()), '外部 dsh（DSH_BIN / PATH）')).toBeUndefined()
    const items = runtimeMenuItems(baseState({ externalAvailable: true }))
    expect(findItem(items, '外部 dsh（DSH_BIN / PATH）')?.action).toBe(TRAY_MENU_ACTIONS.runtimeExternal)
  })

  test('mode=external 时外部打勾、内置不打勾', () => {
    const items = runtimeMenuItems(baseState({ mode: 'external', externalAvailable: true }))
    expect(findItem(items, '外部 dsh（DSH_BIN / PATH）')?.checked).toBe(true)
    expect(findItem(items, '内置 0.2.1-alpha.2（随安装包）')?.checked).toBe(false)
  })

  test('已下载版本按版本号倒序，且跳过与内置同号的', () => {
    const items = runtimeMenuItems(
      baseState({ installed: ['0.2.1-alpha.1', '0.2.0-rc.2', '0.2.1-alpha.2'] })
    )
    expect(labels(items)).toEqual(['✓ 内置 0.2.1-alpha.2（随安装包）', '0.2.1-alpha.1', '0.2.0-rc.2'])
    expect(findItem(items, '0.2.1-alpha.1')?.action).toBe(
      `${TRAY_MENU_ACTIONS.runtimeVersionPrefix}0.2.1-alpha.1`
    )
  })

  test('选中已下载版本：那一行打勾、内置不再打勾', () => {
    const items = runtimeMenuItems(
      baseState({
        installed: ['0.2.1-alpha.1'],
        selected: '0.2.1-alpha.1',
        runningVersion: '0.2.1-alpha.1',
      })
    )
    expect(findItem(items, '0.2.1-alpha.1')?.checked).toBe(true)
    expect(findItem(items, '内置 0.2.1-alpha.2（随安装包）')?.checked).toBe(false)
  })

  test('目录里未装的列成「↓ 下载并切换」，最多 5 条且不与已装重复', () => {
    // 目录是壳按版本倒序给的；这里照同一个顺序摆
    const catalog = [
      { version: '0.2.1-alpha.1', channel: 'alpha' },
      { version: '0.2.0', channel: 'latest' },
      { version: '0.1.9', channel: 'latest' },
      { version: '0.1.8', channel: 'latest' },
      { version: '0.1.7', channel: 'latest' },
      { version: '0.1.6', channel: 'latest' },
      { version: '0.1.5', channel: 'latest' },
    ]
    const items = runtimeMenuItems(baseState({ installed: ['0.2.0'], catalog }))
    const fetchRows = labels(items).filter((label) => label.startsWith('↓ 下载并切换'))
    expect(fetchRows.length).toBe(TRAY_RUNTIME_FETCH_LIMIT)
    expect(fetchRows).not.toContain('↓ 下载并切换 0.2.0（latest）')
    expect(findItem(items, '↓ 下载并切换 0.2.1-alpha.1（alpha）')?.action).toBe(
      `${TRAY_MENU_ACTIONS.runtimeFetchPrefix}0.2.1-alpha.1`
    )
  })

  test('下载中：那一条带「（下载中…）」且不可点，目录项全部禁用', () => {
    const items = runtimeMenuItems(
      baseState({ downloading: '0.2.1-alpha.1', catalog: [{ version: '0.2.0', channel: 'latest' }] })
    )
    const row = findItem(items, '0.2.1-alpha.1（下载中…）')
    expect(row?.enabled).toBe(false)
    expect(findItem(items, '↓ 下载并切换 0.2.0（latest）')?.enabled).toBe(false)
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

describe('托盘菜单限宽（A6）', () => {
  test('短 label 原样返回', () => {
    expect(truncateTrayLabel('退出')).toBe('退出')
  })
  test('超长 label 截断加省略号，长度不超过 max', () => {
    const long = '/Users/mutou/Library/Application Support/com.arcreel.dsh-desktop-tauriapp/runtimes/0.2.1-alpha.2'
    const out = truncateTrayLabel(long)
    expect(Array.from(out).length).toBeLessThanOrEqual(TRAY_LABEL_MAX)
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('/Users/mutou')).toBe(true)
  })
  test('CJK 按码点计数不劈开代理对', () => {
    const emoji = '🚀'.repeat(60)
    const out = truncateTrayLabel(emoji)
    expect(Array.from(out).length).toBe(TRAY_LABEL_MAX)
  })
  test('自定义上限', () => {
    expect(truncateTrayLabel('abcdef', 3)).toBe('ab…')
  })
  test('菜单树整体限宽：长 label 项被截断且 action 保留', () => {
    const state = baseState({ runtimeLabel: 'x'.repeat(80) })
    const menu = trayMenu(state)
    const runtime = menu.find((item) => item.type === 'normal' && item.label.startsWith('运行时：'))
    expect(runtime).toBeDefined()
    if (runtime?.type !== 'normal') throw new Error('unreachable')
    expect(Array.from(runtime.label).length).toBeLessThanOrEqual(TRAY_LABEL_MAX)
    expect(runtime.enabled).toBe(false)
  })
})
