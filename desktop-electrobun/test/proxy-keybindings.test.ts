// 代理注入预览（旧壳 network/proxy.rs）、桌面档快捷键偏好（旧壳 shortcuts.rs）、
// profile 依赖状态（旧壳 profiles.rs）三条纯逻辑/IO 缝。
//
// 这三样都是设置面板上看得见的东西：`effective` 展示错了会被当成「代理没生效」，
// 依赖状态行错了重建按钮就会误判，快捷键档写坏了页面侧整份绑定丢失。

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  injectProxyCredentials,
  mergeNoProxyEntries,
  normalizeNoProxyEntries,
  resolveProxyEnv,
  systemProxyFromEnv,
} from '../src/shared/proxy-env.ts'
import { dependencyMismatch, pnpmFromModulesYaml, pnpmMajor } from '../src/shared/profile-ops.ts'
import { builtinPnpmVersion, profileDependencyRows, readRecordedPnpm } from '../src/bun/profile-manager.ts'
import { KEYBINDINGS_FILE, MAX_KEYBINDINGS_BYTES, readKeybindings, writeKeybindings } from '../src/bun/keybindings.ts'
import { defaultSettings, type DesktopSettings } from '../src/shared/settings.ts'

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-${tag}-`))
}

function withProxy(overrides: Partial<DesktopSettings>): DesktopSettings {
  return { ...defaultSettings(), ...overrides }
}

describe('代理注入预览（旧壳 resolved_proxy_env）', () => {
  test('NO_PROXY 归一：分隔符、<local>、*. 前缀、CIDR 丢弃', () => {
    expect(normalizeNoProxyEntries('*.Corp, 10.0.0.0/8; <local>\texample.com')).toEqual([
      '.corp',
      'localhost',
      '127.0.0.1',
      '::1',
      'example.com',
    ])
    expect(normalizeNoProxyEntries('')).toEqual([])
  })

  test('NO_PROXY 合并去重并恒带回环保底', () => {
    expect(mergeNoProxyEntries([])).toBe('localhost,127.0.0.1,::1')
    expect(mergeNoProxyEntries(['localhost', '.corp'])).toBe('localhost,.corp,127.0.0.1,::1')
  })

  test('凭据注入：只拼一次、没 scheme 不动、空 user 不动', () => {
    expect(injectProxyCredentials('http://127.0.0.1:7890', 'u', 'p')).toBe('http://u:p@127.0.0.1:7890')
    expect(injectProxyCredentials('http://127.0.0.1:7890', 'u', '')).toBe('http://u@127.0.0.1:7890')
    expect(injectProxyCredentials('http://u:p@127.0.0.1:7890', 'u2', 'p2')).toBe('http://u:p@127.0.0.1:7890')
    expect(injectProxyCredentials('127.0.0.1:7890', 'u', 'p')).toBe('127.0.0.1:7890')
    expect(injectProxyCredentials('http://127.0.0.1:7890', '', 'p')).toBe('http://127.0.0.1:7890')
  })

  test('off → 不注入；manual + http → http/https 同值且 NO_PROXY 带回环', () => {
    expect(resolveProxyEnv(withProxy({ proxyMode: 'off' }))).toBeNull()
    expect(resolveProxyEnv(withProxy({ proxyMode: 'manual', proxyUrl: 'not-a-url' }))).toBeNull()
    expect(
      resolveProxyEnv(withProxy({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890', noProxy: '*.corp' })),
    ).toEqual({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7890',
      all: null,
      no_proxy: '.corp,localhost,127.0.0.1,::1',
    })
  })

  test('manual + socks5 → 只写 ALL_PROXY；凭据拼进每条 URL', () => {
    const socks = resolveProxyEnv(withProxy({ proxyMode: 'manual', proxyUrl: 'socks5://127.0.0.1:7891' }))
    expect(socks).toEqual({ http: null, https: null, all: 'socks5://127.0.0.1:7891', no_proxy: 'localhost,127.0.0.1,::1' })
    const withCreds = resolveProxyEnv(
      withProxy({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890', proxyUser: 'u', proxyPass: 'p' }),
    )
    expect(withCreds?.http).toBe('http://u:p@127.0.0.1:7890')
  })

  test('system → 用检测到的系统代理；没检测到就不注入', () => {
    expect(resolveProxyEnv(withProxy({ proxyMode: 'system' }))).toBeNull()
    const detected = { http: 'http://a:1', https: null, all: null, no_proxy: 'localhost' }
    expect(resolveProxyEnv(withProxy({ proxyMode: 'system' }), detected)).toEqual(detected)
  })

  test('系统代理环境：大小写都认，缺省回 null', () => {
    expect(systemProxyFromEnv({})).toBeNull()
    expect(systemProxyFromEnv({ HTTP_PROXY: 'http://a:1', no_proxy: 'x' })?.http).toBe('http://a:1')
    expect(systemProxyFromEnv({ https_proxy: 'http://b:2' })?.https).toBe('http://b:2')
    expect(systemProxyFromEnv({ ALL_PROXY: 'socks5://c:3' })?.all).toBe('socks5://c:3')
  })
})

describe('profile 依赖状态（旧壳 list_profile_dependency_status）', () => {
  test('从 .modules.yaml 抠 pnpm 版本：带引号/不带引号/没有', () => {
    expect(pnpmFromModulesYaml('  "packageManager": "pnpm@11.16.0",\n')).toBe('11.16.0')
    expect(pnpmFromModulesYaml('packageManager: pnpm@10.0.0\n')).toBe('10.0.0')
    expect(pnpmFromModulesYaml('{"packageManager": "npm@10.0.0"}\n')).toBeNull()
  })

  test('只比大版本（小版本差异不算不一致）', () => {
    expect(pnpmMajor('11.16.0')).toBe('11')
    expect(dependencyMismatch('11.1.0', '11.16.0')).toBe(false)
    expect(dependencyMismatch('10.34.5', '11.16.0')).toBe(true)
    expect(dependencyMismatch(null, '11.16.0')).toBe(false)
    expect(dependencyMismatch('11.16.0', null)).toBe(false)
  })

  test('读得到磁盘上的记录，读不到回 null', () => {
    const home = tempDir('pnpm-record')
    try {
      mkdirSync(join(home, 'profiles', 'desktop', 'node_modules'), { recursive: true })
      writeFileSync(
        join(home, 'profiles', 'desktop', 'node_modules', '.modules.yaml'),
        '  "packageManager": "pnpm@11.16.0",\n',
      )
      expect(readRecordedPnpm(home, 'desktop')).toBe('11.16.0')
      expect(readRecordedPnpm(home, 'web')).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('行形状与运行态逐行给全（面板读的是 {profiles:[…]} 里的这些字段）', () => {
    const home = tempDir('pnpm-rows')
    try {
      mkdirSync(join(home, 'profiles', 'desktop', 'node_modules'), { recursive: true })
      writeFileSync(join(home, 'profiles', 'desktop', 'node_modules', '.modules.yaml'), '"packageManager": "pnpm@10.1.0",\n')
      const rows = profileDependencyRows({
        home,
        profiles: ['desktop', 'web'],
        builtinPnpm: '11.16.0',
        running: (profile) => profile === 'web',
      })
      expect(rows).toEqual([
        { profile: 'desktop', recordedPnpm: '10.1.0', builtinPnpm: '11.16.0', needsRebuild: true, running: false },
        { profile: 'web', recordedPnpm: null, builtinPnpm: '11.16.0', needsRebuild: false, running: true },
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('内置 pnpm 版本读自运行时树；树里没有就 null', () => {
    const root = tempDir('pnpm-builtin')
    try {
      const pkgDir = join(root, 'node_modules', 'pnpm')
      mkdirSync(join(pkgDir, 'bin'), { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.16.0' }))
      writeFileSync(join(pkgDir, 'bin', 'pnpm.cjs'), '// pnpm\n')
      expect(builtinPnpmVersion({ runtimeRoot: root, appSupport: root, env: {} })).toBe('11.16.0')
      const bare = tempDir('pnpm-builtin-empty')
      try {
        expect(builtinPnpmVersion({ runtimeRoot: bare, appSupport: bare, env: {} })).toBeNull()
      } finally {
        rmSync(bare, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('桌面档快捷键偏好（旧壳 shortcuts.rs）', () => {
  test('文件不存在回 null（页面侧按默认绑定处理）', () => {
    const home = tempDir('kb-missing')
    try {
      expect(readKeybindings(home)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('原子写 + 原样读回；不解析 JSON', () => {
    const home = tempDir('kb-roundtrip')
    try {
      const raw = '{"schemaVersion":1,"bindings":{"mod+k":"clear"},"future":{"keep":true}}\n'
      writeKeybindings(home, raw)
      expect(readKeybindings(home)).toBe(raw)
      expect(existsSync(join(home, `${KEYBINDINGS_FILE}.tmp`))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('目录不存在时自建', () => {
    const home = join(tempDir('kb-nested'), 'nested', 'deeper')
    try {
      writeKeybindings(home, '{}\n')
      expect(readFileSync(join(home, KEYBINDINGS_FILE), 'utf8')).toBe('{}\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('超上限直接拒，且不落地任何文件', () => {
    const home = tempDir('kb-huge')
    try {
      const huge = 'x'.repeat(MAX_KEYBINDINGS_BYTES + 1)
      expect(() => writeKeybindings(home, huge)).toThrow('快捷键文件过大')
      expect(existsSync(join(home, KEYBINDINGS_FILE))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
