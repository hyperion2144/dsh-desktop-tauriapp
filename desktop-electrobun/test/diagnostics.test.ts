// 诊断快照与导出（缝 ② 纯逻辑 + 真文件）。
//
// 守的是什么：用户报问题时，壳要能回答「哪版、哪个 profile、端口/pid、运行时来源、
// 设置改过什么、日志在哪、日志尾巴是什么」——字段名与段名是契约（面板与排障脚本都读它）。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDiagnostics,
  DIAG_TAIL_LINES,
  diagnosticsFileName,
  diagnosticsSummary,
  type DiagnosticsInput,
} from '../src/shared/diagnostics.ts'
import { exportDiagnostics, diagnosticsDir } from '../src/bun/diagnostics.ts'
import { appVersionCandidates, resolveAppVersion } from '../src/bun/app-version.ts'

function sampleInput(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: '0.1.0',
    pid: 4242,
    startedAt: '2026-10-11T15:00:00.000Z',
    uptimeMs: 60_000,
    noWindow: false,
    locale: 'zh-CN',
    profile: 'desktop',
    origin: 'http://127.0.0.1:6390',
    pageUrl: 'http://127.0.0.1:6390/tok/page',
    pagePort: 6390,
    upstreamPort: 3081,
    lanePort: 3092,
    hostPid: 4243,
    hostRunning: true,
    runtimeKind: 'installed',
    runtimeVersion: '0.2.1-alpha.2',
    runtimeDir: '/rt/0.2.1-alpha.2',
    distDir: '/rt/0.2.1-alpha.2/node_modules/@deepseek-ai/dsh-web-frontend/dist',
    injections: 12,
    settingsSummary: 'dsh 来源=内置',
    settingsPath: '/home/.dsh/desktop-settings.json',
    settingsProvenance: { created: false, migrated: true, recovered: false },
    views: [{ kind: 'shell', profile: 'desktop', label: 'profile-desktop' }],
    downloads: { tasks: 2, active: 1, concurrency: 3 },
    notify: { available: true, permission: 'granted', port: 5000 },
    logs: {
      shell: { path: '/home/.dsh/shell.log', bytes: 120, rotated: 1 },
      webview: { path: '/home/.dsh/dsh-desktop-webview.log', bytes: 30, rotated: 0 },
      tail: ['2026-10-11 23:00:00.000 [shell] 起服务面：profile = desktop'],
    },
    process: {
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '27.0.0',
      bun: '1.4.0',
      cpus: 10,
      totalMemBytes: 25_769_803_776,
      freeMemBytes: 12_000_000_000,
    },
    ...overrides,
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-diag-'))
}

describe('诊断快照（纯逻辑）', () => {
  test('段名与顶层字段固定，摘要带 profile/端口/宿主', () => {
    const now = new Date(2026, 9, 11, 23, 45, 1)
    const snapshot = buildDiagnostics(sampleInput(), now)
    expect(Object.keys(snapshot)).toEqual([
      'generatedAt',
      'summary',
      'shell',
      'dsh',
      'settings',
      'views',
      'downloads',
      'notify',
      'logs',
      'process',
    ])
    expect(snapshot.generatedAt).toBe(now.toISOString())
    expect(snapshot.summary).toBe('desktop · installed 0.2.1-alpha.2 · 页面 6390 / 上游 3081 · 宿主 4243')
    expect(snapshot.dsh).toMatchObject({ profile: 'desktop', upstreamPort: 3081, lanePort: 3092, injections: 12 })
    expect(snapshot.logs).toMatchObject({ tail: ['2026-10-11 23:00:00.000 [shell] 起服务面：profile = desktop'] })
    expect((snapshot.process as Record<string, unknown>).node).toBeUndefined()
  })

  test('运行时版本缺失时摘要写「未知」，node 有值才出现', () => {
    const snapshot = buildDiagnostics(
      sampleInput({
        runtimeVersion: null,
        process: { platform: 'darwin', arch: 'x64', osRelease: '1', bun: '1.4.0', node: '24.0.0', cpus: 2, totalMemBytes: 1, freeMemBytes: 0 },
      }),
      new Date(0)
    )
    expect(diagnosticsSummary(sampleInput({ runtimeVersion: null }))).toContain('installed 未知')
    expect((snapshot.process as Record<string, unknown>).node).toBe('24.0.0')
  })

  test('导出文件名是本地时区时间戳', () => {
    expect(diagnosticsFileName(new Date(2026, 9, 11, 8, 3, 9))).toBe('diag-20261011-080309.json')
  })

  test('尾巴行数上限是常量（面板与脚本都按它取值）', () => {
    expect(DIAG_TAIL_LINES).toBe(80)
  })
})

describe('诊断导出（真文件）', () => {
  test('写到 <home>/diagnostics/，返回路径与字节数、调 reveal、打日志', () => {
    const home = tempDir()
    try {
      const logs: string[] = []
      const revealed: string[] = []
      const result = exportDiagnostics({
        home,
        snapshot: buildDiagnostics(sampleInput(), new Date(2026, 9, 11, 8, 3, 9)),
        now: new Date(2026, 9, 11, 8, 3, 9),
        reveal: (path) => revealed.push(path),
        log: (line) => logs.push(line),
      })
      expect(result.path).toBe(join(diagnosticsDir(home), 'diag-20261011-080309.json'))
      expect(existsSync(result.path)).toBe(true)
      expect(result.bytes).toBeGreaterThan(100)
      const parsed = JSON.parse(readFileSync(result.path, 'utf8')) as { summary?: string }
      expect(parsed.summary).toContain('desktop')
      expect(revealed).toEqual([result.path])
      expect(logs).toEqual([`[diag] 诊断已导出：${result.path}（${String(result.bytes)} 字节）`])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('重复导出不覆盖：文件名带秒级时间戳', () => {
    const home = tempDir()
    try {
      const first = exportDiagnostics({ home, snapshot: { a: 1 }, now: new Date(2026, 9, 11, 8, 3, 9) })
      const second = exportDiagnostics({ home, snapshot: { a: 2 }, now: new Date(2026, 9, 11, 8, 3, 10) })
      expect(first.path).not.toBe(second.path)
      expect(JSON.parse(readFileSync(second.path, 'utf8'))).toEqual({ a: 2 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('壳版本号解析', () => {
  test('环境变量优先', () => {
    expect(resolveAppVersion({ env: { DSH_SHELL_APP_VERSION: '9.9.9' } })).toBe('9.9.9')
  })

  test('按候选顺序找到第一份 version.json', () => {
    const candidates = appVersionCandidates('/app/Contents/Resources/app/src/bun', '/app/Contents/MacOS/launcher', '/app/Contents/Resources/app')
    const first = candidates[0] ?? ''
    const version = resolveAppVersion({
      env: {},
      importDir: '/app/Contents/Resources/app/src/bun',
      execPath: '/app/Contents/MacOS/launcher',
      cwd: '/app/Contents/Resources/app',
      exists: (path) => path === first,
      read: () => JSON.stringify({ version: '0.1.0', identifier: 'com.arcreel.dsh-desktop-tauriapp' }),
    })
    expect(candidates.length).toBeGreaterThan(2)
    expect(version).toBe('0.1.0')
  })

  test('候选里都没有就返回 unknown（不编数字）', () => {
    expect(
      resolveAppVersion({
        env: {},
        importDir: '/nope/a',
        execPath: '/nope/b',
        cwd: '/nope/c',
        exists: () => false,
      })
    ).toBe('unknown')
  })

  test('坏掉的那份跳过，继续找下一份', () => {
    const candidates = appVersionCandidates('/app/Contents/Resources/app/src/bun', '/app/Contents/MacOS/launcher', '/app/Contents/Resources/app')
    const bad = candidates[0] ?? ''
    const good = candidates[1] ?? ''
    const version = resolveAppVersion({
      env: {},
      importDir: '/app/Contents/Resources/app/src/bun',
      execPath: '/app/Contents/MacOS/launcher',
      cwd: '/app/Contents/Resources/app',
      exists: (path) => path === bad || path === good,
      read: (path) => (path === bad ? '{not json' : JSON.stringify({ version: '1.2.3' })),
    })
    expect(version).toBe('1.2.3')
  })
})
