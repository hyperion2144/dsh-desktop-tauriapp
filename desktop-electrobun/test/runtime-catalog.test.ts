// 运行时目录与选中：纯逻辑（版本比较 / 目录载荷解析 / 清单）+ IO（扫描 / 回收站 / 外部定位）。
//
// 对应旧壳 desktop/src-tauri/src/runtime/registry.rs 与 builtin.rs 的测试面：
// 版本号大小（alpha.10 > alpha.2）、渠道标注、坏 JSON 不炸、目录扫描只认有效树、
// 卸载先入回收站、外部 dsh 的三级查找。

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareRuntimeVersions,
  mergeInstalled,
  parseCliVersion,
  parseGithubCatalog,
  parseInstalledManifest,
  parseNpmCatalog,
  removeInstalledEntry,
  runtimeChannel,
  selectRuntimeVersion,
  serializeInstalledManifest,
  sortRuntimeVersionsDesc,
  upsertInstalled,
  type InstalledRuntime,
} from '../src/shared/runtime-catalog.ts'
import {
  externalPackageRoot,
  externalVersion,
  fetchRuntimeCatalog,
  installedManifestPath,
  isRuntimeTreeValid,
  listInstalledRuntimes,
  purgeRuntimeTrash,
  readInstalledManifest,
  readRuntimeVersion,
  recordInstalledRuntime,
  resolveExternalDsh,
  runtimeDirOf,
  runtimeTrashDir,
  scanInstalledVersions,
  trashInstalledRuntime,
  writeInstalledManifest,
} from '../src/bun/runtime-store.ts'
import { resolveRuntimeSelection, runtimePathsOf } from '../src/bun/runtime.ts'

const tempDirs: string[] = []

function tempDir(prefix = 'dsh-rt-'): string {
  // macOS 的 /tmp 是指向 /private/tmp 的软链：先 realpath，免得与 realpathSync 的结果不一致
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 造一棵「有效」运行时树：node_modules/@deepseek-ai/dsh/{lib/bin.js,package.json}。 */
function makeRuntimeTree(root: string, version: string): string {
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'lib', 'bin.js'), '// stub\n')
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`)
  const dist = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<div id="root"></div>\n')
  return root
}

describe('版本比较与排序', () => {
  test('预发布段按数值比：alpha.10 > alpha.2（旧壳 #95 踩过的坑）', () => {
    expect(compareRuntimeVersions('0.2.1-alpha.10', '0.2.1-alpha.2')).toBe(1)
    expect(compareRuntimeVersions('0.2.1-alpha.2', '0.2.1-alpha.10')).toBe(-1)
    expect(compareRuntimeVersions('0.2.1-alpha.2', '0.2.1-alpha.2')).toBe(0)
  })

  test('预发布 < 正式；核心段按数值', () => {
    expect(compareRuntimeVersions('0.2.1-alpha.2', '0.2.1-rc.1')).toBe(-1)
    expect(compareRuntimeVersions('0.2.1-rc.1', '0.2.1')).toBe(-1)
    expect(compareRuntimeVersions('0.10.0', '0.9.9')).toBe(1)
  })

  test('排序取降序，非版本号不参与破坏', () => {
    expect(sortRuntimeVersionsDesc(['0.2.0', '0.2.1-alpha.2', '0.2.1-alpha.10', '0.1.9'])).toEqual([
      '0.2.1-alpha.10',
      '0.2.1-alpha.2',
      '0.2.0',
      '0.1.9',
    ])
  })
})

describe('渠道标注', () => {
  test('dist-tag 命中优先，否则按预发布段猜', () => {
    expect(runtimeChannel('0.2.1', { latest: '0.2.1' })).toBe('latest')
    expect(runtimeChannel('0.2.1-alpha.2', { alpha: '0.2.1-alpha.2' })).toBe('alpha')
    expect(runtimeChannel('0.2.1-rc.1', { rc: '0.2.1-rc.1' })).toBe('rc')
    expect(runtimeChannel('0.1.7-rc.2')).toBe('rc')
    expect(runtimeChannel('0.2.1-alpha.2')).toBe('alpha')
    expect(runtimeChannel('0.2.1')).toBe('')
  })
})

describe('目录载荷解析', () => {
  test('GitHub：剥 dsh-/v 前缀、去重、坏行跳过', () => {
    const entries = parseGithubCatalog([
      { tag_name: 'dsh-v0.2.1-alpha.2' },
      { tag_name: 'dsh-v0.2.1-alpha.2' },
      { tag_name: 'v0.1.7-rc.2' },
      { tag_name: 'not-a-version' },
      { tag_name: 42 },
      null,
      { tag_name: 'dsh-v0.2.0' },
    ])
    expect(entries.map((entry) => entry.version)).toEqual(['0.2.1-alpha.2', '0.1.7-rc.2', '0.2.0'])
    expect(entries[0]?.channel).toBe('alpha')
  })

  test('GitHub：非数组载荷回空表', () => {
    expect(parseGithubCatalog(null)).toEqual([])
    expect(parseGithubCatalog({ message: 'rate limited' })).toEqual([])
  })

  test('npm：dist-tags 标渠道、版本降序、上限 20', () => {
    const versions: Record<string, unknown> = {}
    for (let index = 0; index < 25; index += 1) versions[`0.2.${String(index)}`] = {}
    versions['0.2.1-alpha.2'] = {}
    const entries = parseNpmCatalog({ 'dist-tags': { latest: '0.2.24', alpha: '0.2.1-alpha.2' }, versions })
    expect(entries.length).toBe(20)
    expect(entries[0]).toEqual({ version: '0.2.24', channel: 'latest' })
    expect(entries.some((entry) => entry.version === '0.2.1-alpha.2' && entry.channel === 'alpha')).toBe(true)
  })

  test('npm：坏载荷回空表', () => {
    expect(parseNpmCatalog(null)).toEqual([])
    expect(parseNpmCatalog({ versions: 'nope' })).toEqual([])
  })

  test('清单：数组与 {runtimes} 两种形态都认，坏 JSON/坏行丢弃', () => {
    expect(parseInstalledManifest('not json')).toEqual([])
    expect(parseInstalledManifest('[{"version":"0.2.1","source":"npm","installed_at":5}]')).toEqual([
      { version: '0.2.1', source: 'npm', installed_at: 5 },
    ])
    expect(parseInstalledManifest('{"runtimes":[{"version":"0.2.1"},{"version":"0.2.1"},{"source":"x"},7]}')).toEqual([
      { version: '0.2.1', source: '', installed_at: 0 },
    ])
  })

  test('清单：序列化按版本降序，往返一致', () => {
    const list: InstalledRuntime[] = [
      { version: '0.2.0', source: 'npm', installed_at: 1 },
      { version: '0.2.1-alpha.2', source: 'github', installed_at: 2 },
    ]
    const text = serializeInstalledManifest(list)
    expect(parseInstalledManifest(text)).toEqual([
      { version: '0.2.1-alpha.2', source: 'github', installed_at: 2 },
      { version: '0.2.0', source: 'npm', installed_at: 1 },
    ])
  })

  test('清单增删：upsert 覆盖同号，remove 摘掉', () => {
    const list: InstalledRuntime[] = [{ version: '0.2.0', source: 'npm', installed_at: 1 }]
    expect(upsertInstalled(list, { version: '0.2.0', source: 'github', installed_at: 9 })).toEqual([
      { version: '0.2.0', source: 'github', installed_at: 9 },
    ])
    expect(removeInstalledEntry(list, '0.2.0')).toEqual([])
  })
})

describe('CLI 版本与选中', () => {
  test('从 dsh --version 输出里取版本号', () => {
    expect(parseCliVersion('0.1.7-rc.2')).toBe('0.1.7-rc.2')
    expect(parseCliVersion('dsh/0.2.1-alpha.2 darwin-arm64 node-v24.21.0')).toBe('0.2.1-alpha.2')
    expect(parseCliVersion('command not found')).toBeNull()
  })

  test('偏好装着的用偏好；否则最高；都没有回 null（= 内置兜底）', () => {
    expect(selectRuntimeVersion({ installed: ['0.2.0', '0.2.1'], preferred: '0.2.0' })).toBe('0.2.0')
    expect(selectRuntimeVersion({ installed: ['0.2.0', '0.2.1'], preferred: '0.9.9' })).toBe('0.2.1')
    expect(selectRuntimeVersion({ installed: ['0.2.1-alpha.2', '0.2.1-alpha.10'], preferred: null })).toBe('0.2.1-alpha.10')
    expect(selectRuntimeVersion({ installed: [], preferred: '0.2.1' })).toBeNull()
  })

  test('mergeInstalled：清单提供来源与时间，目录扫描补漏', () => {
    const merged = mergeInstalled(
      [{ version: '0.2.0', source: 'npm', installed_at: 7 }],
      ['0.2.0', '0.2.1-alpha.2'],
    )
    expect(merged).toEqual([
      { version: '0.2.1-alpha.2', source: '', installed_at: 0 },
      { version: '0.2.0', source: 'npm', installed_at: 7 },
    ])
  })
})

describe('运行时目录 IO', () => {
  test('扫描只认有效树，跳过坏目录与 .trash', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.1-alpha.2'), '0.2.1-alpha.2')
    mkdirSync(runtimeDirOf(appSupport, '9.9.9'), { recursive: true }) // 半成品：没有 dsh 包
    mkdirSync(join(runtimeTrashDir(appSupport), '123-0.1.0'), { recursive: true })
    expect(scanInstalledVersions(appSupport)).toEqual(['0.2.1-alpha.2', '0.2.0'])
    expect(isRuntimeTreeValid(runtimeDirOf(appSupport, '0.2.0'))).toBe(true)
    expect(isRuntimeTreeValid(runtimeDirOf(appSupport, '9.9.9'))).toBe(false)
    expect(readRuntimeVersion(runtimeDirOf(appSupport, '0.2.1-alpha.2'))).toBe('0.2.1-alpha.2')
  })

  test('清单读写与 list 合并', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    expect(readInstalledManifest(appSupport)).toEqual([])
    recordInstalledRuntime(appSupport, { version: '0.2.0', source: 'npm', installed_at: 11 })
    expect(existsSync(installedManifestPath(appSupport))).toBe(true)
    expect(listInstalledRuntimes(appSupport)).toEqual([{ version: '0.2.0', source: 'npm', installed_at: 11 }])
    // 目录里多出一个（上次壳留下的），清单没记：也要出现在列表里
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.1'), '0.2.1')
    expect(listInstalledRuntimes(appSupport).map((row) => row.version)).toEqual(['0.2.1', '0.2.0'])
    writeInstalledManifest(appSupport, [])
    expect(readInstalledManifest(appSupport)).toEqual([])
  })

  test('卸载先入回收站：目录消失、清单摘掉、purge 才真删', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    recordInstalledRuntime(appSupport, { version: '0.2.0', source: 'npm', installed_at: 1 })
    trashInstalledRuntime(appSupport, '0.2.0')
    expect(existsSync(runtimeDirOf(appSupport, '0.2.0'))).toBe(false)
    expect(readInstalledManifest(appSupport)).toEqual([])
    const trashed = scanInstalledVersions(appSupport)
    expect(trashed).toEqual([])
    const purged = purgeRuntimeTrash(appSupport)
    expect(purged).toBe(1)
    expect(existsSync(join(runtimeTrashDir(appSupport), '123-0.2.0'))).toBe(false)
    expect(purgeRuntimeTrash(appSupport)).toBe(0)
  })
})

describe('外部 dsh 定位', () => {
  test('DSH_BIN 优先；不存在时落到 PATH；都没有回 null', () => {
    const root = tempDir()
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    const bin = join(binDir, 'dsh')
    writeFileSync(bin, '#!/usr/bin/env node\n')
    expect(resolveExternalDsh({ DSH_BIN: bin })).toBe(bin)
    expect(resolveExternalDsh({ DSH_BIN: join(root, 'missing'), PATH: binDir })).toBe(bin)
    // 生产环境的「常见安装位置」第三层在这台机器上有 /opt/homebrew/bin/dsh，会掩盖断言；
    // 用 commonCandidates 把它换掉（同时跳过 nvm / npx 扫描）才能测「都找不到」。
    expect(resolveExternalDsh({ PATH: join(root, 'empty'), HOME: root }, { commonCandidates: [] })).toBeNull()
  })

  test('包根解析：bin 是软链时按真实路径往上找 @deepseek-ai/dsh', () => {
    const root = tempDir()
    const pkg = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'bin.js'), '// stub\n')
    writeFileSync(join(pkg, 'package.json'), '{"version":"0.1.7-rc.2"}\n')
    mkdirSync(join(root, 'bin'), { recursive: true })
    const link = join(root, 'bin', 'dsh')
    symlinkSync(join(pkg, 'lib', 'bin.js'), link)
    expect(externalPackageRoot(link)).toBe(pkg)
    expect(externalVersion(pkg)).toBe('0.1.7-rc.2')
  })

  test('包根解析：直接跑在包内的 bin（不是软链）', () => {
    const root = tempDir()
    const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'bin.js'), '// stub\n')
    writeFileSync(join(pkg, 'package.json'), '{"version":"0.2.0"}\n')
    expect(externalPackageRoot(join(pkg, 'lib', 'bin.js'))).toBe(pkg)
  })
})

describe('版本目录抓取', () => {
  const okResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

  test('npm 源：解析 dist-tags 与版本表', async () => {
    const result = await fetchRuntimeCatalog({
      source: 'npm',
      fetchImpl: (async () => okResponse({ 'dist-tags': { latest: '0.2.1' }, versions: { '0.2.1': {}, '0.2.0': {} } })) as unknown as typeof fetch,
    })
    expect(result.error).toBeUndefined()
    expect(result.entries).toEqual([
      { version: '0.2.1', channel: 'latest' },
      { version: '0.2.0', channel: '' },
    ])
  })

  test('github 源：带上仓库名与 UA，默认官方仓库', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return okResponse([{ tag_name: 'dsh-v0.2.1-alpha.2' }])
    }) as unknown as typeof fetch
    const result = await fetchRuntimeCatalog({ source: 'github', fetchImpl })
    expect(seen[0]).toContain('api.github.com/repos/deepseek-ai/deepseek-harness/releases')
    expect(result.entries).toEqual([{ version: '0.2.1-alpha.2', channel: 'alpha' }])
    await fetchRuntimeCatalog({ source: 'github', repo: 'me/other', fetchImpl })
    expect(seen[1]).toContain('repos/me/other/releases')
  })

  test('HTTP 失败与网络异常都回 error，不抛', async () => {
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    expect((await fetchRuntimeCatalog({ source: 'npm', fetchImpl: failing })).error).toContain('HTTP 503')
    const throwing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const result = await fetchRuntimeCatalog({ source: 'github', fetchImpl: throwing })
    expect(result.entries).toEqual([])
    expect(result.error).toContain('offline')
  })
})

describe('运行时选中', () => {
  test('显式覆盖最优先，包根布局也能认', () => {
    const appSupport = tempDir()
    const root = makeRuntimeTree(join(tempDir(), 'tree'), '0.2.0')
    const selection = resolveRuntimeSelection({ env: {}, overrideDir: root, appSupport, installed: [] })
    expect(selection.kind).toBe('override')
    expect(selection.version).toBe('0.2.0')
    expect(selection.layout).toBe('root')
    expect(runtimePathsOf(root).dshLibDir).toBe(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'))
  })

  test('external 模式用外部包根，找不到则回退并带 note', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    const pkg = join(tempDir(), 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'bin.js'), '// stub\n')
    writeFileSync(join(pkg, 'package.json'), '{"version":"0.1.7-rc.2"}\n')
    const external = resolveRuntimeSelection({ env: {}, mode: 'external', externalBin: join(pkg, 'lib', 'bin.js'), appSupport })
    expect(external.kind).toBe('external')
    expect(external.root).toBe(pkg)
    expect(external.version).toBe('0.1.7-rc.2')
    // 0.1.7-rc.2 < 0.2.0：同一 profile 的插件树是 0.2.x 的（实测「1 required plugin did not activate」）
    // ⇒ 选中照旧，但必须带一条 note，日志与面板要能说清为什么起不来
    expect(external.note).toContain('低于 0.2.0')
    expect(runtimePathsOf(pkg, 'package').dshLibDir).toBe(join(pkg, 'lib'))

    // 0.2.x 的外部树不该有这条提示
    const modern = join(tempDir(), 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(modern, 'lib'), { recursive: true })
    writeFileSync(join(modern, 'lib', 'bin.js'), '// stub\n')
    writeFileSync(join(modern, 'package.json'), '{"version":"0.2.1-alpha.2"}\n')
    const fresh = resolveRuntimeSelection({ env: {}, mode: 'external', externalBin: join(modern, 'lib', 'bin.js'), appSupport })
    expect(fresh.kind).toBe('external')
    expect(fresh.note).toBeNull()

    const fallback = resolveRuntimeSelection({ env: {}, mode: 'external', externalBin: null, appSupport })
    expect(fallback.kind).toBe('installed')
    expect(fallback.note).toContain('未找到外部 dsh')
  })

  test('已下载版本：偏好 > 最高；没有已装就回内置树', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.1'), '0.2.1')
    const preferred = resolveRuntimeSelection({ env: {}, appSupport, preferred: '0.2.0' })
    expect(preferred.kind).toBe('installed')
    expect(preferred.version).toBe('0.2.0')
    const highest = resolveRuntimeSelection({ env: {}, appSupport })
    expect(highest.version).toBe('0.2.1')

    const empty = tempDir()
    const builtin = makeRuntimeTree(join(tempDir(), 'builtin'), '0.3.0')
    const selection = resolveRuntimeSelection({ env: {}, appSupport: empty, builtinDir: builtin })
    expect(selection.kind).toBe('builtin')
    expect(selection.version).toBe('0.3.0')
  })

  test('什么都没有时抛清楚的错（带两个可用环境变量）', () => {
    const appSupport = tempDir()
    expect(() => resolveRuntimeSelection({ env: {}, appSupport, builtinDir: null })).toThrow(/找不到可用的 dsh 运行时/)
  })
})
