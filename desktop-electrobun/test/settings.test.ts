import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_MUX_HEARTBEAT_MS,
  DEFAULT_PROFILE,
  NOTIFICATION_SCENARIOS,
  activeProfile,
  defaultSettings,
  expandHome,
  normalizeSettings,
  profilePort,
  profileLanePort,
  serializeSettings,
  settingsSummary,
  defaultLanePortForProfile,
  defaultPortForProfile,
} from '../src/shared/settings.ts'
import {
  loadSettings,
  migrateFromLegacyYaml,
  parseSimpleYaml,
  saveSettings,
  settingsPath,
  updateSettings,
} from '../src/bun/settings-store.ts'
import { layout } from '../src/bun/runtime.ts'

const tempHome = (): string => mkdtempSync(join(tmpdir(), 'dsh-settings-'))

describe('normalizeSettings', () => {
  test('空/坏输入回默认值', () => {
    expect(normalizeSettings(null).activeProfile).toBe(DEFAULT_PROFILE)
    expect(normalizeSettings('nope').downloadConcurrency).toBe(DEFAULT_DOWNLOAD_CONCURRENCY)
    expect(normalizeSettings([]).muxHeartbeatMs).toBe(DEFAULT_MUX_HEARTBEAT_MS)
  })

  test('同时认驼峰与旧壳的下划线键名', () => {
    const camel = normalizeSettings({ activeProfile: 'web', downloadConcurrency: 8 })
    const snake = normalizeSettings({ active_profile: 'web', download_concurrency: 8 })
    expect(camel.activeProfile).toBe('web')
    expect(snake.activeProfile).toBe('web')
    expect(snake.downloadConcurrency).toBe(8)
    expect(camel.downloadConcurrency).toBe(8)
  })

  test('数值夹取到区间，坏类型当没设置', () => {
    expect(normalizeSettings({ download_concurrency: 999 }).downloadConcurrency).toBe(32)
    expect(normalizeSettings({ download_concurrency: 0 }).downloadConcurrency).toBe(1)
    expect(normalizeSettings({ download_concurrency: 'many' }).downloadConcurrency).toBe(DEFAULT_DOWNLOAD_CONCURRENCY)
    expect(normalizeSettings({ mux_heartbeat_ms: 10 }).muxHeartbeatMs).toBe(1_000)
    expect(normalizeSettings({ mux_heartbeat_ms: 10_000_000 }).muxHeartbeatMs).toBe(600_000)
    expect(normalizeSettings({ port: 70_000 }).port).toBeUndefined()
    expect(normalizeSettings({ port: 3081 }).port).toBe(3081)
  })

  test('枚举只认白名单', () => {
    expect(normalizeSettings({ proxy_mode: 'manual' }).proxyMode).toBe('manual')
    expect(normalizeSettings({ proxy_mode: 'socks' }).proxyMode).toBe('off')
    expect(normalizeSettings({ dsh_mode: 'external' }).dshMode).toBe('external')
    expect(normalizeSettings({ runtime_source: 'npm' }).runtimeSource).toBe('npm')
    expect(normalizeSettings({ runtime_source: 'ftp' }).runtimeSource).toBe('github')
  })

  test('空白字符串等于没设置（用户手改配置常见）', () => {
    expect(normalizeSettings({ active_profile: '   ' }).activeProfile).toBe(DEFAULT_PROFILE)
    expect(normalizeSettings({ remote_addr: '' }).remoteAddr).toBeUndefined()
  })

  test('profile 端口表丢掉坏条目', () => {
    const settings = normalizeSettings({ profile_ports: { web: 3080, bad: 'x', '': 3000 } })
    expect(settings.profilePorts).toEqual({ web: 3080 })
    expect(normalizeSettings({ profile_ports: {} }).profilePorts).toBeUndefined()
  })

  test('通知：14 条场景补齐，用户改动保留，多余键丢掉', () => {
    const settings = normalizeSettings({
      notifications: {
        enabled: false,
        dnd: { on: true, from: '23:30', to: '07:00' },
        scenarios: { 'task.complete': { enabled: false }, 'nope.nope': { enabled: true } },
      },
    })
    expect(settings.notifications.enabled).toBe(false)
    expect(settings.notifications.dnd).toEqual({ on: true, from: '23:30', to: '07:00', suppressFullscreen: true })
    expect(Object.keys(settings.notifications.scenarios).sort()).toEqual(
      NOTIFICATION_SCENARIOS.map((meta) => meta.id).sort(),
    )
    expect(settings.notifications.scenarios['task.complete']).toEqual({ enabled: false, sound: 'default' })
    expect(settings.notifications.scenarios['dsh.error']?.enabled).toBe(true)
  })

  test('通知缺失时全部按场景默认（含默认关的两条）', () => {
    const settings = normalizeSettings({})
    expect(settings.notifications.scenarios['window.lifecycle']?.enabled).toBe(false)
    expect(settings.notifications.scenarios['config.info']?.enabled).toBe(false)
    expect(settings.notifications.scenarios['startup.error']?.enabled).toBe(true)
  })
})

describe('serializeSettings', () => {
  test('写出去的是旧壳的下划线键名，坏键不存在', () => {
    const json = serializeSettings(normalizeSettings({ activeProfile: 'web', downloadConcurrency: 7, remoteAddr: 'x' }))
    expect(json.active_profile).toBe('web')
    expect(json.download_concurrency).toBe(7)
    expect(json.remote_addr).toBe('x')
    expect(json.activeProfile).toBeUndefined()
    expect(json.remote_list).toBeUndefined()
  })

  test('往返一次不丢信息', () => {
    const original = normalizeSettings({
      active_profile: 'web',
      port: 3080,
      profile_ports: { web: 3080, desktop: 3081 },
      proxy_mode: 'manual',
      proxy_url: 'socks5://127.0.0.1:1080',
      notifications: { dnd: { on: true } },
      prevent_sleep: false,
    })
    const round = normalizeSettings(JSON.parse(JSON.stringify(serializeSettings(original))))
    expect(round.activeProfile).toBe('web')
    expect(round.profilePorts).toEqual({ web: 3080, desktop: 3081 })
    expect(round.proxyUrl).toBe('socks5://127.0.0.1:1080')
    expect(round.preventSleep).toBe(false)
    expect(round.notifications.dnd.on).toBe(true)
    expect(round.notifications.scenarios['task.complete']).toEqual({ enabled: true, sound: 'default' })
  })

  test('通知的 dnd 用旧壳的 suppress_fullscreen 键', () => {
    const json = serializeSettings(defaultSettings()) as { notifications: { dnd: Record<string, unknown> } }
    expect(json.notifications.dnd.suppress_fullscreen).toBe(true)
    expect(json.notifications.dnd.suppressFullscreen).toBeUndefined()
  })
})

describe('activeProfile / profilePort / expandHome', () => {
  test('环境变量优先级高于设置文件', () => {
    const settings = normalizeSettings({ active_profile: 'web' })
    expect(activeProfile(settings, {})).toBe('web')
    expect(activeProfile(settings, { DSH_PROFILE: 'app' })).toBe('app')
  })

  test('端口优先级：环境变量 > profile 覆盖 > 默认表', () => {
    const settings = normalizeSettings({ profile_ports: { desktop: 4081 } })
    expect(profilePort(settings, 'desktop', {})).toBe(4081)
    expect(profilePort(settings, 'web', {})).toBe(3080)
    expect(profilePort(settings, 'other', {})).toBe(defaultPortForProfile('other'))
    expect(profilePort(settings, 'desktop', { DSH_DESKTOP_PORT: '5081' })).toBe(5081)
  })

  test('手机 lane 端口：环境变量 > profile 覆盖 > web 的 lane_port > 默认表（desktop 3093，lane 整体 +1）', () => {
    expect(profileLanePort(defaultSettings(), 'desktop', {})).toBe(3093)
    expect(profileLanePort(defaultSettings(), 'web', {})).toBe(3092)
    expect(profileLanePort(defaultSettings(), 'other', {})).toBe(defaultLanePortForProfile('other'))
    expect(profileLanePort(normalizeSettings({ lane_port: 4091 }), 'web', {})).toBe(4091)
    expect(profileLanePort(normalizeSettings({ lane_port: 4091 }), 'desktop', {})).toBe(3093)
    const perProfile = normalizeSettings({ profile_lane_ports: { desktop: 4092 } })
    expect(profileLanePort(perProfile, 'desktop', {})).toBe(4092)
    expect(profileLanePort(perProfile, 'desktop', { DSH_MOBILE_LANE_PORT: '6092' })).toBe(6092)
    // 坏值不下发（同 profilePort：非法 env 值当作没给）
    expect(profileLanePort(perProfile, 'desktop', { DSH_MOBILE_LANE_PORT: '0' })).toBe(4092)
  })

  test('~ 展开（DSH_HOME 带 ~ 时壳与 dsh 必须指向同一目录）', () => {
    expect(expandHome('~/.dsh', '/Users/x')).toBe('/Users/x/.dsh')
    expect(expandHome('~', '/Users/x')).toBe('/Users/x')
    expect(expandHome('/abs/path', '/Users/x')).toBe('/abs/path')
  })
})

describe('settingsSummary', () => {
  test('全默认时只有一句话，非默认项才报', () => {
    expect(settingsSummary(defaultSettings())).toBe('全默认')
    const summary = settingsSummary(normalizeSettings({ active_profile: 'web', download_concurrency: 9 }))
    expect(summary).toContain('profile="web"')
    expect(summary).toContain('downloadConcurrency=9')
  })
})

describe('parseSimpleYaml / migrateFromLegacyYaml', () => {
  test('读得懂映射与标量，列表跳过', () => {
    const parsed = parseSimpleYaml(
      [
        'dsh-desktop-tauriapp:',
        '  port: 3081',
        '  active_profile: web',
        '  prevent_sleep: false',
        '  remote_list:',
        '    - a.example.com',
        '  proxy_mode: manual',
      ].join('\n'),
    )
    expect(parsed?.['dsh-desktop-tauriapp']).toEqual({
      port: 3081,
      active_profile: 'web',
      prevent_sleep: false,
      remote_list: {},
      proxy_mode: 'manual',
    })
  })

  test('坏 YAML 回默认值，不抛', () => {
    expect(parseSimpleYaml(':::')).toBeNull()
    expect(migrateFromLegacyYaml(':::').activeProfile).toBe(DEFAULT_PROFILE)
  })

  test('优先读 dsh-desktop-tauriapp 块，退回 desktop 块', () => {
    const migrated = migrateFromLegacyYaml(['dsh-desktop-tauriapp:', '  active_profile: app'].join('\n'))
    expect(migrated.activeProfile).toBe('app')
    const legacy = migrateFromLegacyYaml(['desktop:', '  active_profile: web'].join('\n'))
    expect(legacy.activeProfile).toBe('web')
  })
})

describe('loadSettings / saveSettings', () => {
  test('首次启动：没有私有文件也没有旧 yaml ⇒ 落一份默认值', () => {
    const home = tempHome()
    const lines: string[] = []
    const loaded = loadSettings({ home, log: (line) => lines.push(line) })
    expect(loaded.created).toBe(true)
    expect(loaded.migrated).toBe(false)
    expect(existsSync(settingsPath(home))).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath(home), 'utf8')).active_profile).toBe(DEFAULT_PROFILE)
    expect(lines.join('\n')).toContain('新建')
  })

  test('旧 settings.yaml 只读迁移一次，yaml 不被改写', () => {
    const home = tempHome()
    const yaml = join(home, 'settings.yaml')
    const text = ['dsh-desktop-tauriapp:', '  active_profile: web', '  download_concurrency: 6'].join('\n')
    writeFileSync(yaml, text)
    const loaded = loadSettings({ home })
    expect(loaded.migrated).toBe(true)
    expect(loaded.settings.activeProfile).toBe('web')
    expect(loaded.settings.downloadConcurrency).toBe(6)
    expect(readFileSync(yaml, 'utf8')).toBe(text)
    // 第二次读就走私有 JSON，不再看 yaml
    writeFileSync(yaml, 'dsh-desktop-tauriapp:\n  active_profile: app\n')
    expect(loadSettings({ home }).settings.activeProfile).toBe('web')
  })

  test('坏 JSON：备份成 .corrupt 再用默认值重建', () => {
    const home = tempHome()
    writeFileSync(settingsPath(home), '{ 这不是 json')
    const lines: string[] = []
    const loaded = loadSettings({ home, log: (line) => lines.push(line) })
    expect(loaded.recovered).toBe(true)
    expect(loaded.settings.activeProfile).toBe(DEFAULT_PROFILE)
    expect(existsSync(`${settingsPath(home)}.corrupt`)).toBe(true)
    expect(lines.join('\n')).toContain('已备份')
    expect(() => JSON.parse(readFileSync(settingsPath(home), 'utf8'))).not.toThrow()
  })

  test('保存是原子的：不留 .tmp 残留', () => {
    const home = tempHome()
    saveSettings(home, normalizeSettings({ active_profile: 'app' }))
    expect(existsSync(`${settingsPath(home)}.tmp`)).toBe(false)
    expect(loadSettings({ home }).settings.activeProfile).toBe('app')
  })

  test('updateSettings 改一项不动别项，且不把下划线键写坏', () => {
    const home = tempHome()
    saveSettings(home, normalizeSettings({ active_profile: 'web', proxy_mode: 'system', download_concurrency: 5 }))
    const next = updateSettings(home, { preventSleep: false })
    expect(next.preventSleep).toBe(false)
    expect(next.activeProfile).toBe('web')
    expect(next.proxyMode).toBe('system')
    expect(next.downloadConcurrency).toBe(5)
    const raw = JSON.parse(readFileSync(settingsPath(home), 'utf8'))
    expect(raw.prevent_sleep).toBe(false)
    expect(raw.download_concurrency).toBe(5)
  })
})

// 设置里的 profile 真的能改变壳的布局（service 用 activeProfile(settings, env) 后交给 layout）。
// 没有运行时树时跳过：CI 里由 prepare 步骤铺，本地用 DSH_SHELL_TEST_RUNTIME 指一份。
const layoutRuntime = process.env.DSH_SHELL_TEST_RUNTIME ?? ''
const layoutSuite = layoutRuntime === '' ? describe.skip : describe

layoutSuite('layout > profile 决议', () => {
  test('输入 profile 优先于环境变量（调用方已经算过 env > 设置 > 默认）', () => {
    const env = { DSH_HOME: tempHome(), DSH_SHELL_RUNTIME_DIR: layoutRuntime, DSH_PROFILE: 'env-profile' }
    expect(layout({ env, profile: 'web' }).profile).toBe('web')
    expect(layout({ env }).profile).toBe('env-profile')
    expect(layout({ env: { ...env, DSH_PROFILE: '' } }).profile).toBe(DEFAULT_PROFILE)
  })

  test('设置里的 active_profile 一路走到布局（DSH_PROFILE 未设时）', () => {
    const home = tempHome()
    saveSettings(home, normalizeSettings({ active_profile: 'web' }))
    const settings = loadSettings({ home }).settings
    const env = { DSH_HOME: home, DSH_SHELL_RUNTIME_DIR: layoutRuntime }
    expect(layout({ env, profile: activeProfile(settings, env) }).profile).toBe('web')
  })
})
