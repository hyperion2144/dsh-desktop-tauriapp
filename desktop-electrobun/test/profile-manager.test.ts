// profile 运维的 IO 层（真临时目录 + 真 socket）。
//
// 守的是什么：迁移会把旧目标 rename 成 `.bak-<ts>` 再覆盖整个目录——这里必须证明
// ① 三道拒绝门（名字、目标正在用、缺 package.json、需确认覆盖）真的挡得住；
// ② 复制保留软链、跳过 node_modules 与 `.dsh-module-fallback`、跳过锁文件；
// ③ 副本 package.json 的 name 换成 `dsh-profile-<dest>`；
// ④ 依赖重建走注入的 install（测试里不真跑 pnpm）；
// ⑤ 代理连接测试对真监听口回耗时、对连不上的口报错。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  countCopyableFiles,
  createTaskTracker,
  migrateProfile,
  profileHealth,
  testProxyConnectivity,
} from '../src/bun/profile-manager.ts'
import { PROFILE_REQUIRED_FILES } from '../src/shared/profile-ops.ts'

function tempRoot(): string {
  // macOS 的 /tmp 是指向 /private/tmp 的软链：realpath 一下免得断言里出现两种前缀
  return realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pm-')))
}

/** 造一个完整的 profile 目录（四个必需文件 + node_modules + 一个源文件）。 */
function seedProfile(home: string, profile: string, extra: (dir: string) => void = () => {}): string {
  const dir = join(home, 'profiles', profile)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: profile, private: true }, null, 2)}\n`)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(dir, 'src.js'), 'export const a = 1\n')
  extra(dir)
  return dir
}

describe('profile 完整性（旧壳 profile_health_check）', () => {
  test('目录不在 ⇒ dirExists=false，其余为空', () => {
    const home = tempRoot()
    const health = profileHealth(home, 'nope')
    expect(health).toMatchObject({ dirExists: false, missingFiles: [], nodeModulesExists: false })
    rmSync(home, { recursive: true, force: true })
  })

  test('四个必需文件逐个报缺（含 JSON 解析失败）', () => {
    const home = tempRoot()
    const dir = seedProfile(home, 'desktop')
    rmSync(join(dir, 'cordis.yml'))
    // YAML 只做「能读成行」的粗校验（旧壳用 serde_yaml，这里不引依赖），所以只断言 JSON 那种硬错
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    writeFileSync(join(dir, 'package.json'), '{ 坏 JSON')
    const health = profileHealth(home, 'desktop')
    expect(health.dirExists).toBe(true)
    expect([...health.missingFiles].sort()).toEqual(['cordis.yml', 'package.json'])
    expect(health.nodeModulesExists).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })

  test('齐全 ⇒ 什么都不缺；node_modules 不在也算缺', () => {
    const home = tempRoot()
    const dir = seedProfile(home, 'desktop')
    expect(profileHealth(home, 'desktop').missingFiles).toEqual([])
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    expect(profileHealth(home, 'desktop').nodeModulesExists).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })

  test('必需文件清单就这四个（与旧壳一致）', () => {
    expect([...PROFILE_REQUIRED_FILES]).toEqual([
      'package.json',
      'pnpm-workspace.yaml',
      'cordis.yml',
      'cordis.patch.yml',
    ])
  })
})

describe('迁移 profile（旧壳 migrate_profile_inner）', () => {
  test('名字非法 / 目标是当前 profile / 源缺 package.json 三道门', async () => {
    const home = tempRoot()
    seedProfile(home, 'desktop')
    const install = async (): Promise<{ ok: true; error: '' }> => ({ ok: true, error: '' })
    const base = { home, source: 'desktop', dest: 'web', overwrite: false, activeProfile: null, install, log: () => {} }

    await expect(migrateProfile({ ...base, dest: '有中文' })).rejects.toThrow('名称仅允许字母、数字')
    await expect(migrateProfile({ ...base, activeProfile: 'web' })).rejects.toThrow('正在使用，拒绝迁移')
    await expect(migrateProfile({ ...base, source: 'ghost' })).rejects.toThrow('不存在或缺少 package.json')
    rmSync(home, { recursive: true, force: true })
  })

  test('目标已存在且没确认覆盖 ⇒ 明确要确认（前端按这句话文案重试）', async () => {
    const home = tempRoot()
    seedProfile(home, 'desktop')
    seedProfile(home, 'web')
    await expect(
      migrateProfile({
        home,
        source: 'desktop',
        dest: 'web',
        overwrite: false,
        activeProfile: null,
        install: async () => ({ ok: true, error: '' }),
      }),
    ).rejects.toThrow('已存在（需确认覆盖）')
    rmSync(home, { recursive: true, force: true })
  })

  test('成功路径：复制文件、跳过 node_modules 与锁文件、重建依赖、包名换成 dsh-profile-<dest>', async () => {
    const home = tempRoot()
    const src = seedProfile(home, 'desktop', (dir) => {
      writeFileSync(join(dir, 'stale.lock'), 'x')
      writeFileSync(join(dir, 'cordis.yml.lock'), 'x')
      mkdirSync(join(dir, '.plugin-manager', 'logs'), { recursive: true })
      writeFileSync(join(dir, '.plugin-manager', 'logs', 'a.log'), 'x')
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x')
      mkdirSync(join(dir, '.dsh-module-fallback'), { recursive: true })
      writeFileSync(join(dir, '.dsh-module-fallback', 'x.js'), 'x')
      symlinkSync('/tmp', join(dir, 'link-out'))
    })
    // 4 个文件（package/pnpm-workspace/cordis.patch/src.js）+ 1 条软链；cordis.yml、锁文件、node_modules、.plugin-manager/logs 都跳过
    expect(countCopyableFiles(src)).toBe(5)
    let installs = 0
    const track = createTaskTracker()
    const summary = await migrateProfile({
      home,
      source: 'desktop',
      dest: 'web',
      overwrite: false,
      activeProfile: null,
      install: async () => {
        installs += 1
        return { ok: true, error: '' }
      },
      track,
      log: () => {},
    })
    const dst = join(home, 'profiles', 'web')
    expect(summary).toContain('已迁移 desktop → web')
    expect(installs).toBe(1)
    expect(existsSync(join(dst, 'src.js'))).toBe(true)
    expect(existsSync(join(dst, 'node_modules'))).toBe(false)
    expect(existsSync(join(dst, '.dsh-module-fallback'))).toBe(false)
    expect(existsSync(join(dst, 'stale.lock'))).toBe(false)
    expect(existsSync(join(dst, '.plugin-manager', 'logs'))).toBe(false)
    // Windows 的 CI runner 建不了符号链接（无开发者模式/特权），复制器会跳过它——那不算迁移失败
    if (process.platform !== 'win32') expect(readlinkSync(join(dst, 'link-out'))).toBe('/tmp')
    const pkg = JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe('dsh-profile-web')
    expect(track.status()).toMatchObject({ running: false, finished: true, error: '' })
    rmSync(home, { recursive: true, force: true })
  })

  test('覆盖：旧目标先 rename 成 .bak-<秒级时间戳>，且总结里点名备份路径', async () => {
    const home = tempRoot()
    seedProfile(home, 'desktop')
    seedProfile(home, 'web')
    writeFileSync(join(home, 'profiles', 'web', 'old.txt'), 'x')
    const summary = await migrateProfile({
      home,
      source: 'desktop',
      dest: 'web',
      overwrite: true,
      activeProfile: null,
      install: async () => ({ ok: true, error: '' }),
      now: () => 1_791_700_000_000,
    })
    const backup = join(home, 'profiles', 'web.bak-1791700000')
    expect(existsSync(backup)).toBe(true)
    expect(existsSync(join(backup, 'old.txt'))).toBe(true)
    expect(existsSync(join(home, 'profiles', 'web', 'old.txt'))).toBe(false)
    expect(summary).toContain('旧目标已备份为')
    rmSync(home, { recursive: true, force: true })
  })

  test('依赖重建失败 ⇒ 抛错且任务快照记下失败原因（不假装成功）', async () => {
    const home = tempRoot()
    seedProfile(home, 'desktop')
    const track = createTaskTracker()
    await expect(
      migrateProfile({
        home,
        source: 'desktop',
        dest: 'web',
        overwrite: false,
        activeProfile: null,
        install: async () => ({ ok: false, error: '依赖重建失败（内置 pnpm install）：ERR_PNPM_NO_MATCHING_VERSION' }),
        track,
      }),
    ).rejects.toThrow('ERR_PNPM_NO_MATCHING_VERSION')
    expect(track.status()).toMatchObject({ running: false, finished: true, error: expect.stringContaining('ERR_PNPM') })
    rmSync(home, { recursive: true, force: true })
  })
})

describe('依赖重建的前置条件（依赖解析）', () => {
  test('找不到 pnpm.cjs 时明确报错，而不是静默跳过', async () => {
    const home = tempRoot()
    seedProfile(home, 'desktop')
    const { installProfileDependencies } = await import('../src/bun/profile-manager.ts')
    const result = await installProfileDependencies({
      home,
      profile: 'desktop',
      appSupport: join(home, 'support'),
      env: { PATH: '/nonexistent' },
      log: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('找不到 pnpm.cjs')
    rmSync(home, { recursive: true, force: true })
  })
})

describe('代理连通性测试（旧壳 test_proxy_connectivity）', () => {
  test('连真监听口回耗时（毫秒）', async () => {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
    const port = listener.port
    try {
      const elapsed = await testProxyConnectivity(`http://127.0.0.1:${String(port)}`)
      expect(elapsed).toBeGreaterThanOrEqual(0)
      expect(elapsed).toBeLessThan(3_000)
    } finally {
      listener.stop(true)
    }
  })

  test('连不上 ⇒ 抛「连接 … 失败」，URL 非法 ⇒ 原样抛规范化错误', async () => {
    await expect(testProxyConnectivity('http://127.0.0.1:1', 800)).rejects.toThrow(/连接 127\.0\.0\.1:1/)
    // 超时分支：真实网络里难以稳定复现（本机 TUN 代理对任意 IP 都秒回成功），用「永不完成」的桩钉住
    const never = async (): Promise<{ end: () => void }> => new Promise(() => {})
    await expect(testProxyConnectivity('http://127.0.0.1:6449', 120, never)).rejects.toThrow(
      '连接 127.0.0.1:6449 超时（0s）',
    )
    await expect(testProxyConnectivity('ftp://127.0.0.1:21')).rejects.toThrow('代理 URL 非法')
  })
})
