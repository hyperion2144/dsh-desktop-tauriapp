// profile 运维与代理连通性的纯逻辑（缝 ②）。
//
// 守的是什么：设置面板的「迁移 Profile / 依赖重建 / 测试连接」与启动时的 profile 确认弹窗都走
// 这几个判断。规则写错会毁用户的 profile（迁移会把旧目标 rename 成 .bak 再覆盖目录），所以
// 名称校验、排除项、代理 URL 规范化、启动裁决这四件事必须被钉死。

import { describe, expect, test } from 'bun:test'

import {
  EMPTY_TASK,
  MIGRATION_SKIP_DIRS,
  PROFILE_REQUIRED_FILES,
  migratedPackageName,
  migrationSkips,
  migrationSummary,
  normalizeProxyUrl,
  splitAuthority,
  startupAction,
  validProfileName,
} from '../src/shared/profile-ops.ts'

describe('profile 名称校验（旧壳 valid_profile_name）', () => {
  test('字母数字下划线连字符可以，其余不行', () => {
    expect(validProfileName('desktop')).toBe(true)
    expect(validProfileName('web-2_x')).toBe(true)
    expect(validProfileName('A'.repeat(32))).toBe(true)
    expect(validProfileName('')).toBe(false)
    expect(validProfileName('A'.repeat(33))).toBe(false)
    expect(validProfileName('有中文')).toBe(false)
    expect(validProfileName('a b')).toBe(false)
    expect(validProfileName('../etc')).toBe(false)
    expect(validProfileName('a/b')).toBe(false)
  })
})

describe('迁移排除规则（旧壳 migration_skips / copy_dir_filtered）', () => {
  test('锁、临时、编辑器残留一律跳过', () => {
    expect(migrationSkips('a.lock', 'a.lock', false)).toBe(true)
    expect(migrationSkips('x/y.pid', 'y.pid', false)).toBe(true)
    expect(migrationSkips('x/y.tmp', 'y.tmp', false)).toBe(true)
    expect(migrationSkips('x/y.swp', 'y.swp', false)).toBe(true)
    expect(migrationSkips('.DS_Store', '.DS_Store', false)).toBe(true)
    expect(migrationSkips('x/._y', '._y', false)).toBe(true)
  })

  test('cordis.yml 跳过（启动会重写）；其余三个必需文件不跳', () => {
    expect(migrationSkips('cordis.yml', 'cordis.yml', false)).toBe(true)
    for (const file of PROFILE_REQUIRED_FILES) {
      if (file === 'cordis.yml') continue
      expect(migrationSkips(file, file, false)).toBe(false)
    }
  })

  test('插件管理器的日志目录跳过；它在别处的同名文件不跳', () => {
    expect(migrationSkips('.plugin-manager/logs/x.log', 'x.log', false)).toBe(true)
    expect(migrationSkips('.plugin-manager/logs', 'logs', true)).toBe(true)
    expect(migrationSkips('.plugin-manager/other.log', 'other.log', false)).toBe(false)
  })

  test('node_modules/.cache 跳过，其它 .cache 不跳', () => {
    expect(migrationSkips('node_modules/.cache', '.cache', true)).toBe(true)
    expect(migrationSkips('.cache', '.cache', true)).toBe(false)
    expect(migrationSkips('src/.cache', '.cache', true)).toBe(false)
  })

  test('两项硬排除是整目录（依赖靠 pnpm 重建）', () => {
    expect([...MIGRATION_SKIP_DIRS]).toEqual(['node_modules', '.dsh-module-fallback'])
  })
})

describe('代理 URL 规范化（旧壳 normalize_proxy_url）', () => {
  test('四种 scheme，socks 统一成 socks5', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:8080')).toEqual({
      ok: true,
      target: { url: 'http://127.0.0.1:8080', host: '127.0.0.1', port: 8080 },
    })
    const socks = normalizeProxyUrl('socks://127.0.0.1:1080')
    expect(socks.ok && socks.target.url).toBe('socks5://127.0.0.1:1080')
  })

  test('缺端口按 scheme 补（https 443 / socks 1080 / 其它 80）', () => {
    const https = normalizeProxyUrl('https://proxy.example.com')
    expect(https.ok && https.target.port).toBe(443)
    const socks = normalizeProxyUrl('socks5://proxy.example.com')
    expect(socks.ok && socks.target.port).toBe(1080)
    const http = normalizeProxyUrl('http://proxy.example.com')
    expect(http.ok && http.target.port).toBe(80)
  })

  test('多余的路径/查询/锚点丢掉，scheme 大小写不敏感', () => {
    const parsed = normalizeProxyUrl('HTTP://127.0.0.1:3128/path?x=1#frag')
    expect(parsed.ok && parsed.target.url).toBe('http://127.0.0.1:3128')
  })

  test('IPv6 字面量补方括号', () => {
    const parsed = normalizeProxyUrl('http://::1:8080')
    expect(parsed.ok && parsed.target.host).toBe('[::1]')
    const bracketed = normalizeProxyUrl('http://[::1]:8080')
    expect(bracketed.ok && bracketed.target.url).toBe('http://[::1]:8080')
    const noPort = normalizeProxyUrl('socks5://[::1]')
    expect(noPort.ok && noPort.target.port).toBe(1080)
  })

  test('非法输入回错误（照旧壳的话术）', () => {
    expect(normalizeProxyUrl('')).toMatchObject({ ok: false, error: '代理地址为空' })
    const noScheme = normalizeProxyUrl('127.0.0.1:8080')
    expect(noScheme.ok).toBe(false)
    expect(noScheme.ok === false && noScheme.error).toContain('代理 URL 非法')
    const badScheme = normalizeProxyUrl('ftp://127.0.0.1:8080')
    expect(badScheme.ok).toBe(false)
    const badPort = normalizeProxyUrl('http://127.0.0.1:99999')
    expect(badPort.ok).toBe(false)
    expect(badPort.ok === false && badPort.error).toContain('端口非法')
    const noHost = normalizeProxyUrl('http://:8080')
    expect(noHost.ok).toBe(false)
  })

  test('splitAuthority 只认纯数字端口（旧壳 split_authority）', () => {
    expect(splitAuthority('host:8080')).toEqual({ host: 'host', portText: '8080' })
    expect(splitAuthority('host:abc')).toEqual({ host: 'host:abc', portText: null })
    expect(splitAuthority('host')).toEqual({ host: 'host', portText: null })
    expect(splitAuthority('[::1]:8080')).toEqual({ host: '[::1]', portText: '8080' })
    expect(splitAuthority('[::1]')).toEqual({ host: '[::1]', portText: null })
  })
})

describe('启动检查裁决（旧壳 check_startup_needed）', () => {
  const healthy = { dirExists: true, missingFiles: [], nodeModulesExists: true }

  test('已确认过就是 none（哪怕 profile 残缺）', () => {
    expect(
      startupAction({
        skipCheck: true,
        freshInstall: false,
        activeProfile: null,
        profiles: ['desktop'],
        health: { dirExists: false, missingFiles: [], nodeModulesExists: false },
        profile: 'desktop',
      }),
    ).toEqual({ action: 'none' })
  })

  test('全新安装不弹选择（没得选，直接建）', () => {
    expect(
      startupAction({
        skipCheck: false,
        freshInstall: true,
        activeProfile: null,
        profiles: [],
        health: healthy,
        profile: 'desktop',
      }),
    ).toEqual({ action: 'none' })
  })

  test('存量安装且没设 active_profile ⇒ 让用户选', () => {
    expect(
      startupAction({
        skipCheck: false,
        freshInstall: false,
        activeProfile: null,
        profiles: ['desktop', 'web'],
        health: healthy,
        profile: 'desktop',
      }),
    ).toEqual({ action: 'profile-selection', profiles: ['desktop', 'web'] })
  })

  test('当前 profile 残缺 ⇒ 回缺失明细（三项分开报）', () => {
    const decision = startupAction({
      skipCheck: false,
      freshInstall: false,
      activeProfile: 'desktop',
      profiles: ['desktop'],
      health: { dirExists: true, missingFiles: ['cordis.yml'], nodeModulesExists: false },
      profile: 'desktop',
    })
    expect(decision).toEqual({
      action: 'profile-incomplete',
      profile: 'desktop',
      details: { dirExists: true, missingFiles: ['cordis.yml'], nodeModulesExists: false },
    })
  })

  test('目录都不在也算残缺（不是「没问题」）', () => {
    const decision = startupAction({
      skipCheck: false,
      freshInstall: false,
      activeProfile: 'desktop',
      profiles: ['desktop'],
      health: { dirExists: false, missingFiles: [], nodeModulesExists: false },
      profile: 'desktop',
    })
    expect(decision.action).toBe('profile-incomplete')
  })

  test('健全且已设 profile ⇒ none', () => {
    expect(
      startupAction({
        skipCheck: false,
        freshInstall: false,
        activeProfile: 'desktop',
        profiles: ['desktop'],
        health: healthy,
        profile: 'desktop',
      }),
    ).toEqual({ action: 'none' })
  })
})

describe('迁移总结与包名（旧壳文案）', () => {
  test('summary 字段顺序照旧壳', () => {
    expect(
      migrationSummary({ source: 'desktop', dest: 'web', files: 3, dirs: 2, links: 1, skipped: 4, backup: null }),
    ).toBe('已迁移 desktop → web：文件 3、目录 2、链接 1、排除 4')
  })

  test('有备份时追加一句', () => {
    const text = migrationSummary({
      source: 'a',
      dest: 'b',
      files: 0,
      dirs: 0,
      links: 0,
      skipped: 0,
      backup: '/x/profiles/b.bak-1791700000',
    })
    expect(text).toContain('；旧目标已备份为 /x/profiles/b.bak-1791700000')
  })

  test('副本包名不再带源名', () => {
    expect(migratedPackageName('web')).toBe('dsh-profile-web')
  })

  test('任务快照默认什么都不在跑', () => {
    expect(EMPTY_TASK).toMatchObject({ running: false, finished: false, error: '', result: '' })
  })
})
