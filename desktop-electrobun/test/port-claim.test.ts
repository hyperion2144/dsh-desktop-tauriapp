import { describe, expect, test } from 'bun:test'
import {
  assignPortAvoiding,
  defaultLanePortForProfile,
  defaultPortForProfile,
  fnv1a64,
  profileLanePort,
  profilePort,
  type DesktopSettings,
} from '../src/shared/settings.ts'
import { decideClaim, extractTokenFromUrl } from '../src/shared/port-claim.ts'
const settings: DesktopSettings = { notifications: { enabled: true, scenarios: [] } } as unknown as DesktopSettings

describe('端口认领判定（旧壳 decide_claim）', () => {
  test('端口没人听 → free（无条件可拉起）', () => {
    expect(decideClaim({ profile: 'desktop', port: 3081, portOpen: false, claims: [] })).toBe('free')
  })
  test('本壳台账命中且活着 → ours', () => {
    expect(
      decideClaim({
        profile: 'desktop',
        port: 3081,
        portOpen: true,
        claims: [{ profile: 'desktop', port: 3081, alive: true }],
      }),
    ).toBe('ours')
  })
  test('台账命中但进程死了 → 不算 ours（按外部占用走）', () => {
    expect(
      decideClaim({
        profile: 'desktop',
        port: 3081,
        portOpen: true,
        claims: [{ profile: 'desktop', port: 3081, alive: false }],
      }),
    ).toBe('foreign-unknown')
  })
  test('外部 dsh 占 web 遗留端口 → foreign-web（兼容复用候选）', () => {
    expect(decideClaim({ profile: 'web', port: 3080, portOpen: true, claims: [], legacyWebPort: 3080 })).toBe('foreign-web')
    expect(decideClaim({ profile: 'web', port: 5080, portOpen: true, claims: [], legacyWebPort: 5080 })).toBe('foreign-web')
    expect(decideClaim({ profile: 'web', port: 3080, portOpen: true, claims: [], legacyWebPort: 5080 })).toBe('foreign-unknown')
  })
  test('其余一律 foreign-unknown：别的 profile / 陌生端口 / 桌面 profile 的外部实例', () => {
    expect(decideClaim({ profile: 'desktop', port: 3081, portOpen: true, claims: [] })).toBe('foreign-unknown')
    expect(decideClaim({ profile: 'web', port: 3999, portOpen: true, claims: [], legacyWebPort: 3080 })).toBe('foreign-unknown')
    expect(decideClaim({ profile: 'mobile', port: 4001, portOpen: true, claims: [] })).toBe('foreign-unknown')
  })
})

describe('token 抠取（旧壳 extract_token_from_url）', () => {
  test('完整启动 URL 抠出 token；空白 / 无 token / 不是 URL → null', () => {
    expect(extractTokenFromUrl('http://127.0.0.1:3080/?token=abc123')).toBe('abc123')
    expect(extractTokenFromUrl('  http://127.0.0.1:3080/?x=1&token=tok9  ')).toBe('tok9')
    expect(extractTokenFromUrl('')).toBeNull()
    expect(extractTokenFromUrl('http://127.0.0.1:3080/')).toBeNull()
    expect(extractTokenFromUrl('不是 URL')).toBeNull()
  })
})

describe('固定端口公式（旧壳 default_port_for_profile / default_lane_port_for_profile）', () => {
  test('web/desktop 走固定值；lane 整体 +1（3092/3093）', () => {
    expect(defaultPortForProfile('web')).toBe(3080)
    expect(defaultPortForProfile('desktop')).toBe(3081)
    expect(defaultLanePortForProfile('web')).toBe(3092)
    expect(defaultLanePortForProfile('desktop')).toBe(3093)
  })
  test('其余 profile 走 3082+/3094+ 散列且确定性（同输入同输出，范围受控）', () => {
    for (const profile of ['mobile', 'smoke', 'some-fancy-profile']) {
      const upstream = defaultPortForProfile(profile)
      const lane = defaultLanePortForProfile(profile)
      expect(upstream).toBe(defaultPortForProfile(profile))
      expect(upstream).toBeGreaterThanOrEqual(3082)
      expect(upstream).toBeLessThan(3082 + 512)
      expect(lane).toBeGreaterThanOrEqual(3094)
      expect(lane).toBeLessThan(3094 + 512)
      expect(lane).toBe(defaultLanePortForProfile(profile))
    }
  })
  test('FNV-1a 64 已知向量（空串 = offset basis；"a" = 0xaf63dc4c8601ec8c）', () => {
    expect(fnv1a64('').toString(16)).toBe('cbf29ce484222325')
    expect(fnv1a64('a').toString(16)).toBe('af63dc4c8601ec8c')
  })
})

describe('端口避让（旧壳 assign_port_avoiding）', () => {
  test('base 空闲直接用；占用顺延；窗口占满回绕到 base', () => {
    expect(assignPortAvoiding(4000, [])).toBe(4000)
    expect(assignPortAvoiding(4000, [4000, 4001])).toBe(4002)
    expect(assignPortAvoiding(4000, new Set([4000]))).toBe(4001)
    const full = Array.from({ length: 1024 }, (_, offset) => 4000 + offset)
    expect(assignPortAvoiding(4000, full)).toBe(4000)
  })
})

describe('profilePort / profileLanePort 的 taken 避让（不落盘，会话内存）', () => {
  test('env > 用户配置 > web 遗留 > 公式；taken 只影响非固定档', () => {
    expect(profilePort(settings, 'desktop', { DSH_DESKTOP_PORT: '5081' })).toBe(5081)
    expect(profilePort({ ...settings, profilePorts: { desktop: 5082 } } as DesktopSettings, 'desktop')).toBe(5082)
    expect(profilePort(settings, 'web', {})).toBe(3080)
    expect(profilePort(settings, 'desktop', {}, new Set([3081]))).toBe(3081)
    expect(profilePort(settings, 'other', {}, new Set([defaultPortForProfile('other')]))).toBe(defaultPortForProfile('other') + 1)
    expect(profileLanePort(settings, 'web', {})).toBe(3092)
    expect(profileLanePort(settings, 'web', { DSH_MOBILE_LANE_PORT: '6092' })).toBe(6092)
    expect(profileLanePort({ ...settings, profileLanePorts: { web: 6093 } } as DesktopSettings, 'web')).toBe(6093)
  })
})
