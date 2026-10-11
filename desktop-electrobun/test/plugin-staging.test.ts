// 插件 staging + profile 脚手架：纯逻辑（注入清单、版本契约、模板）+ 真文件系统用例。
//
// 这一段落是旧壳 `profiles.rs`（profile 模板）+ `process/plugin.rs`（物化与注入清单）的迁移，
// 所以断言直接对着旧壳写死的内容（bundle 列表、心跳块、三行 insert、pnpm 白名单）。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_MUX_HEARTBEAT_MS,
  WEB_STARTUP_MIN,
  connectionInjectList,
  gatewayPatchBlock,
  injectYml,
  insertRows,
  versionAtLeast,
} from '../src/shared/inject-yml.ts'
import { PROFILE_BUNDLES, profileFiles, profilePackageJson } from '../src/shared/profile-template.ts'
import { profileExists, scaffoldProfile } from '../src/bun/profile-scaffold.ts'
import { materializePoolPackage, stagePlugins } from '../src/bun/plugin-staging.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'dsh-staging-'))

/** 造一个「包目录」：只要有 package.json 就算存在（定位逻辑看的就是它）。 */
function fakePackage(dir: string, name: string, version = '0.0.1'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  return dir
}

describe('版本契约（connection inject 两代）', () => {
  test('边界：alpha.1 旧契约、alpha.2 起新契约', () => {
    expect(connectionInjectList('0.2.1-alpha.1')).toBe('[webRuntime, webServer]')
    expect(connectionInjectList('0.2.1-alpha.2')).toBe('[webStartup, webServer]')
    expect(WEB_STARTUP_MIN).toBe('0.2.1-alpha.2')
  })

  test('预发布段数字感知：alpha.10 > alpha.2', () => {
    expect(versionAtLeast('0.2.1-alpha.10', WEB_STARTUP_MIN)).toBe(true)
    expect(versionAtLeast('0.2.1-alpha.2', WEB_STARTUP_MIN)).toBe(true)
    expect(versionAtLeast('0.2.1-alpha.1', WEB_STARTUP_MIN)).toBe(false)
  })

  test('正式版高于同号预发布；低版本一律否', () => {
    expect(versionAtLeast('0.2.1', '0.2.1-alpha.2')).toBe(true)
    expect(versionAtLeast('0.2.0', WEB_STARTUP_MIN)).toBe(false)
    expect(versionAtLeast('0.3.0', WEB_STARTUP_MIN)).toBe(true)
    expect(versionAtLeast('0.2.1-beta.1', '0.2.1-beta.2')).toBe(false)
  })

  test('解析失败保守回旧契约（旧壳同样保守）', () => {
    for (const bad of ['', 'desktop', '1.2', '1.2.3.4', 'x.y.z']) {
      expect(versionAtLeast(bad, WEB_STARTUP_MIN)).toBe(false)
      expect(connectionInjectList(bad)).toBe('[webRuntime, webServer]')
      expect(connectionInjectList(undefined)).toBe('[webRuntime, webServer]')
    }
  })
})

describe('注入清单', () => {
  test('心跳块：关掉时不写这一段（dsh 用自己的默认）', () => {
    expect(gatewayPatchBlock(undefined)).toBe('')
    expect(gatewayPatchBlock(0)).toBe('')
    const block = gatewayPatchBlock(DEFAULT_MUX_HEARTBEAT_MS)
    expect(block).toContain('- id: typert-gateway')
    expect(block).toContain('websocketHeartbeatIntervalMs: 30000')
  })

  test('整份清单：connection 行在首、insert 行按序、心跳夹在中间', () => {
    const yml = injectYml({
      runtimeVersion: '0.2.1-alpha.2',
      muxHeartbeatMs: 30000,
      rows: [
        { id: 'dsh-desktop-tauriapp', name: 'dsh-desktop-tauriapp' },
        { id: 'dsh-mobile-access', name: 'dsh-mobile-access' },
      ],
    })
    expect(yml.startsWith('- id: connection\n  inject: [webStartup, webServer]\n')).toBe(true)
    expect(yml).toContain('- id: typert-gateway')
    expect(yml).toContain('- insert:\n    - id: dsh-desktop-tauriapp\n      name: dsh-desktop-tauriapp\n    - id: dsh-mobile-access\n      name: dsh-mobile-access\n')
    expect(yml.indexOf('connection')).toBeLessThan(yml.indexOf('typert-gateway'))
    expect(yml.indexOf('typert-gateway')).toBeLessThan(yml.indexOf('insert'))
  })

  test('没有任何插件行时也保留 connection（那件与插件无关）', () => {
    const yml = injectYml({ runtimeVersion: '0.2.1-alpha.2', rows: [] })
    expect(yml).toContain('- id: connection')
    expect(yml).not.toContain('insert:')
  })

  test('行序：桌面壳插件 → 手机访问 → 移动布局；手机用桌面布局时不注入移动布局', () => {
    const base = { desktopPlugin: 'dsh-desktop-tauriapp', mobileAccess: 'dsh-mobile-access', mobileLayout: 'dsh-web-mobile' }
    expect(insertRows(base).map((row) => row.id)).toEqual(['dsh-desktop-tauriapp', 'dsh-mobile-access', 'dsh-web-mobile'])
    expect(insertRows({ ...base, desktopLayoutOnPhones: true }).map((row) => row.id)).toEqual([
      'dsh-desktop-tauriapp',
      'dsh-mobile-access',
    ])
    expect(insertRows({})).toEqual([])
  })
})

describe('profile 模板与脚手架', () => {
  test('package.json 与旧壳写死的一致（bundles + 两个 post 脚本）', () => {
    const parsed = JSON.parse(profilePackageJson('desktop')) as {
      name: string
      private: boolean
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
      scripts: Record<string, string>
    }
    expect(parsed.name).toBe('desktop')
    expect(parsed.private).toBe(true)
    expect(parsed.dependencies).toEqual({})
    expect(parsed.dsh.profile.bundles).toEqual([...PROFILE_BUNDLES])
    expect(parsed.scripts.postinstall).toBe('rm -rf node_modules/@deepseek-ai/dsh-tools')
    expect(parsed.scripts.postuninstall).toBe('rm -rf node_modules/@deepseek-ai/dsh-tools')
  })

  test('四份文件各就其位（pnpm 白名单含 node-pty 与 koffi）', () => {
    const files = profileFiles('web')
    expect(files.map((file) => file.name)).toEqual(['package.json', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml'])
    const workspace = files.find((file) => file.name === 'pnpm-workspace.yaml')
    expect(workspace?.content).toContain('nodeLinker: hoisted')
    expect(workspace?.content).toContain('node-pty: true')
    expect(workspace?.content).toContain('koffi: true')
    expect(files.find((file) => file.name === 'cordis.patch.yml')?.content).toBe('[]\n')
  })

  test('脚手架：首启写四份、第二次一个字不动（用户的 cordis.patch.yml 是他的地盘）', () => {
    const home = tempDir()
    const first = scaffoldProfile(home, 'desktop')
    expect(first.created.sort()).toEqual(['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml'])
    expect(profileExists(home, 'desktop')).toBe(true)

    const edited = join(first.dir, 'cordis.patch.yml')
    writeFileSync(edited, '- id: mine\n')
    const second = scaffoldProfile(home, 'desktop')
    expect(second.created).toEqual([])
    expect(second.kept.sort()).toEqual(['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml'])
    expect(readFileSync(edited, 'utf8')).toBe('- id: mine\n')
    expect(profileExists(home, 'web')).toBe(false)
  })
})

describe('物化进 profile 模块池', () => {
  test('挂软链、幂等、换目标会重挂；scoped 包名先补父目录', () => {
    const root = tempDir()
    const pool = join(root, 'pool')
    const a = fakePackage(join(root, 'a'), 'pkg-a')
    const b = fakePackage(join(root, 'b'), 'pkg-a')

    materializePoolPackage(pool, 'pkg-a', a)
    expect(readlinkSync(join(pool, 'pkg-a'))).toBe(a)
    materializePoolPackage(pool, 'pkg-a', a)
    expect(readlinkSync(join(pool, 'pkg-a'))).toBe(a)
    materializePoolPackage(pool, 'pkg-a', b)
    expect(readlinkSync(join(pool, 'pkg-a'))).toBe(b)

    const scoped = fakePackage(join(root, 'c'), '@scope/pkg')
    materializePoolPackage(pool, '@scope/pkg', scoped)
    expect(readlinkSync(join(pool, '@scope/pkg'))).toBe(scoped)
  })
})

describe('stagePlugins（端到端：池 + 注入清单）', () => {
  test('物化找到的包、跳过缺的、清单里只写真的挂上的', () => {
    const root = tempDir()
    const home = join(root, 'dsh-home')
    const appSupport = join(root, 'app-support')
    const repoRoot = join(root, 'repo')
    const desktopPlugin = fakePackage(repoRoot, 'dsh-desktop-tauriapp')
    const mobileAccess = fakePackage(join(repoRoot, 'mobile', 'dsh-mobile-access'), 'dsh-mobile-access')

    const logs: string[] = []
    const result = stagePlugins({
      home,
      profile: 'desktop',
      appSupport,
      paths: { repoRoot, resourcesDir: null },
      runtimeVersion: '0.2.1-alpha.2',
      muxHeartbeatMs: 30000,
      log: (line) => logs.push(line),
    })

    // 壳插件来自仓库根；手机访问来自 mobile/；移动布局（子模块没拉）缺包 → 跳过
    expect(result.staged.map((entry) => entry.name).sort()).toEqual(['dsh-desktop-tauriapp', 'dsh-mobile-access'])
    expect(result.missing).toEqual(['dsh-web-mobile'])
    expect(readlinkSync(join(result.pool, 'dsh-desktop-tauriapp'))).toBe(desktopPlugin)
    expect(readlinkSync(join(result.pool, 'dsh-mobile-access'))).toBe(mobileAccess)

    const yml = readFileSync(result.injectFile, 'utf8')
    expect(yml).toContain('- id: connection\n  inject: [webStartup, webServer]')
    expect(yml).toContain('- id: dsh-desktop-tauriapp')
    expect(yml).toContain('- id: dsh-mobile-access')
    expect(yml).not.toContain('dsh-web-mobile')
    expect(logs.join('\n')).toContain('缺包跳过：dsh-web-mobile')
  })

  test('幂等：内容没变不重写（mtime 保留）；桌面布局设置会去掉移动布局行', () => {
    const root = tempDir()
    const home = join(root, 'dsh-home')
    const appSupport = join(root, 'app-support')
    const repoRoot = join(root, 'repo')
    fakePackage(repoRoot, 'dsh-desktop-tauriapp')
    fakePackage(join(repoRoot, 'mobile', 'dsh-mobile-access'), 'dsh-mobile-access')
    fakePackage(join(repoRoot, 'mobile', 'dsh-mobile-nav'), 'dsh-web-mobile')

    const first = stagePlugins({ home, profile: 'web', appSupport, paths: { repoRoot, resourcesDir: null }, runtimeVersion: '0.2.1-alpha.2', muxHeartbeatMs: 0 })
    expect(first.staged).toHaveLength(3)
    expect(readFileSync(first.injectFile, 'utf8')).toContain('dsh-web-mobile')
    // 心跳关闭 → 不写 typert-gateway
    expect(readFileSync(first.injectFile, 'utf8')).not.toContain('typert-gateway')

    const before = statSync(first.injectFile).mtimeMs
    stagePlugins({ home, profile: 'web', appSupport, paths: { repoRoot, resourcesDir: null }, runtimeVersion: '0.2.1-alpha.2', muxHeartbeatMs: 0 })
    expect(statSync(first.injectFile).mtimeMs).toBe(before)

    const second = stagePlugins({
      home,
      profile: 'web',
      appSupport,
      paths: { repoRoot, resourcesDir: null },
      runtimeVersion: '0.2.1-alpha.2',
      muxHeartbeatMs: 0,
      desktopLayoutOnPhones: true,
    })
    expect(second.staged).toHaveLength(3)
    expect(readFileSync(second.injectFile, 'utf8')).not.toContain('dsh-web-mobile')
    expect(existsSync(join(second.pool, 'dsh-web-mobile'))).toBe(true)
  })

  test('打包态优先用 Resources/plugins 的副本（安装后仓库不在身边）', () => {
    const root = tempDir()
    const resourcesDir = join(root, 'Resources')
    const packaged = fakePackage(join(resourcesDir, 'plugins', 'dsh-desktop-tauriapp'), 'dsh-desktop-tauriapp')
    const result = stagePlugins({
      home: join(root, 'home'),
      profile: 'desktop',
      appSupport: join(root, 'app-support'),
      paths: { repoRoot: join(root, 'repo-missing'), resourcesDir },
      runtimeVersion: '0.2.1-alpha.2',
    })
    expect(readlinkSync(join(result.pool, 'dsh-desktop-tauriapp'))).toBe(packaged)
  })
})
