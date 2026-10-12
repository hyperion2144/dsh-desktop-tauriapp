// 运行时下载安装的单测：进度解析、错误尾巴、pnpm.cjs 定位、node 垫片、装树流程与单飞状态机。
//
// 装树流程用假 spawn 驱动（不真跑 pnpm）：假 spawn 负责「写出一棵合法的运行时树 + 打进度行 + 退出」，
// 于是这条链上的每个判定（工作区文件内容、进度、失败清理、成功判据、超时）都能在毫秒级验到。

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  OUTPUT_TAIL_LINES,
  createRuntimeDownloader,
  ensureNodeShim,
  installRuntime,
  nodeShimScript,
  parsePnpmProgress,
  pickInstallerErrorTail,
  resolvePnpmCjs,
  tailLines,
} from '../src/bun/runtime-install.ts'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-rt-install-')))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 在 appSupport 下造一棵合法的运行时树（真判据：node_modules/@deepseek-ai/dsh/lib/bin.js 是文件） */
function writeRuntimeTree(dir: string): void {
  const bin = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'bin.js'), '// stub\n')
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>
}

interface FakeSpawnResult {
  calls: Array<{ command: string[]; options: Record<string, unknown> }>
  spawnImpl: (command: string[], options: Record<string, unknown>) => {
    exited: Promise<number>
    stdout?: ReadableStream<Uint8Array> | null
    stderr?: ReadableStream<Uint8Array> | null
    kill?: () => void
  }
}

/**
 * 假 spawn：按脚本回调模拟 pnpm。
 * `onRun` 能在退出前写文件/记账；返回的 exit code 就是 `exited` 的结果。
 */
function fakeSpawn(onRun: (input: { dir: string; command: string[]; env: Record<string, string> }) => { code: number; stdout?: string; stderr?: string }): FakeSpawnResult {
  const calls: FakeSpawnResult['calls'] = []
  return {
    calls,
    spawnImpl: (command, options) => {
      calls.push({ command, options })
      const cwd = String(options.cwd ?? '')
      const env = (options.env ?? {}) as Record<string, string>
      const result = onRun({ dir: cwd, command, env })
      return {
        exited: Promise.resolve(result.code),
        stdout: streamOf(result.stdout ?? ''),
        stderr: streamOf(result.stderr ?? ''),
      }
    },
  }
}

describe('parsePnpmProgress', () => {
  test('标准进度行与千分位逗号', () => {
    expect(parsePnpmProgress('Progress: resolved 1,234, downloaded 56, added 7')).toEqual({
      resolved: 1234,
      downloaded: 56,
      added: 7,
    })
  })

  test('pnpm 11 的格式（多一段 reused）也认，尾部 done 不影响', () => {
    expect(parsePnpmProgress('Progress: resolved 1, reused 0, downloaded 1, added 1, done')).toEqual({
      resolved: 1,
      downloaded: 1,
      added: 1,
    })
    expect(parsePnpmProgress('Progress: resolved 1,234, reused 900, downloaded 56, added 7')?.downloaded).toBe(56)
  })

  test('非进度行回 null（包括 pnpm 的错误行与空行）', () => {
    expect(parsePnpmProgress('ERR_PNPM_NO_MATCHING_VERSION')).toBeNull()
    expect(parsePnpmProgress('')).toBeNull()
    expect(parsePnpmProgress('Progress: resolved 1, downloaded 0')).toBeNull()
  })

  test('行尾还有别的内容也认得（非 TTY 下 pnpm 会拼在同一行）', () => {
    expect(parsePnpmProgress('Progress: resolved 12, downloaded 3, added 1 done')?.added).toBe(1)
  })
})

describe('错误尾巴', () => {
  test('去噪：node 的 TLS 告警与 (node:N) Warning 行不算内容', () => {
    const stderr = "(node:1) Warning: NODE_TLS_REJECT_UNAUTHORIZED set to 0\nERR_PNPM_UNEXPECTED_STORE store mismatch"
    expect(tailLines(stderr)).toBe('ERR_PNPM_UNEXPECTED_STORE store mismatch')
  })

  test('去噪：pnpm default reporter 的 ANSI 光标码也从报错里剔掉', () => {
    const stderr = '\u001b[1A\u001b[KERR_PNPM_UNEXPECTED_STORE store mismatch\u001b[0J'
    expect(tailLines(stderr)).toBe('ERR_PNPM_UNEXPECTED_STORE store mismatch')
  })

  test('stderr 有真东西优先用它；只有噪声时回退 stdout（旧壳 #95 Bug 1）', () => {
    expect(pickInstallerErrorTail('ERR_PNPM_UNEXPECTED_STORE', 'whatever')).toContain('UNEXPECTED_STORE')
    const noisyStderr = '(node:1) Warning: NODE_TLS_REJECT_UNAUTHORIZED set to 0'
    // stdout 里真正的进度行由 installRuntime 自己吞掉，这里只验「噪声 stderr 不挡 stdout 尾巴」
    const fallback = pickInstallerErrorTail(
      noisyStderr,
      'Progress: resolved 1, downloaded 0, added 0\nERR_PNPM_NO_MATCHING_VERSION',
    )
    expect(fallback).toContain('ERR_PNPM_NO_MATCHING_VERSION')
  })

  test('只留尾部 N 行（默认 12）', () => {
    const text = Array.from({ length: 30 }, (_, index) => `line-${String(index)}`).join('\n')
    const tail = tailLines(text)
    expect(tail.split('\n')).toHaveLength(OUTPUT_TAIL_LINES)
    expect(tail.startsWith('line-18')).toBe(true)
    expect(tail.endsWith('line-29')).toBe(true)
  })
})

describe('node 垫片', () => {
  test('系统里有 node 就不插手', () => {
    expect(ensureNodeShim({ appSupport: tempDir(), bunPath: '/bin/bun', hasNode: true })).toBeNull()
  })

  test('没有 node 时写一个可执行的 node → Bun 垫片', () => {
    const appSupport = tempDir()
    const dir = ensureNodeShim({ appSupport, bunPath: '/opt/bun', hasNode: false })
    expect(dir).toBe(join(appSupport, 'runtimes', '.node-shim'))
    expect(readFileSync(join(dir as string, 'node'), 'utf8')).toBe(nodeShimScript('/opt/bun'))
    expect(nodeShimScript('/opt/bun')).toStartWith('#!/bin/sh\nexec "/opt/bun" "$@"')
  })
})

describe('resolvePnpmCjs', () => {
  test('优先级：显式 env > 当前运行时树 > 内置树 > 任一已下载树', () => {
    const appSupport = tempDir()
    const runtimeRoot = join(tempDir(), 'rt')
    const builtinDir = join(tempDir(), 'builtin')
    const installed = join(appSupport, 'runtimes', '1.2.3')
    for (const root of [runtimeRoot, builtinDir, installed]) {
      mkdirSync(join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// pnpm\n')
    }
    const explicit = join(tempDir(), 'mine.cjs')
    writeFileSync(explicit, '// mine\n')

    expect(resolvePnpmCjs({ env: { DSH_SHELL_PNPM: explicit }, runtimeRoot, builtinDir, appSupport })).toBe(explicit)
    expect(resolvePnpmCjs({ env: {}, runtimeRoot, builtinDir, appSupport })).toBe(join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
    expect(resolvePnpmCjs({ env: {}, runtimeRoot: null, builtinDir, appSupport })).toBe(join(builtinDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
    expect(resolvePnpmCjs({ env: {}, runtimeRoot: null, builtinDir: null, appSupport })).toBe(
      join(installed, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    )
    expect(resolvePnpmCjs({ env: {}, runtimeRoot: null, builtinDir: null, appSupport: tempDir() })).toBeNull()
  })

  test('显式 env 指向不存在的文件时不算数（继续往下找）', () => {
    const appSupport = tempDir()
    const builtinDir = join(tempDir(), 'builtin')
    mkdirSync(join(builtinDir, 'node_modules', 'pnpm', 'bin'), { recursive: true })
    writeFileSync(join(builtinDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// pnpm\n')
    expect(resolvePnpmCjs({ env: { DSH_SHELL_PNPM: '/nope/pnpm.cjs' }, runtimeRoot: null, builtinDir, appSupport })).toBe(
      join(builtinDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    )
  })
})

describe('installRuntime', () => {
  test('版本号不合法直接拒绝', async () => {
    await expect(
      installRuntime({ appSupport: tempDir(), version: 'not-a-version', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs' }),
    ).rejects.toThrow('版本号不合法')
  })

  test('已装好的版本不重复装', async () => {
    const appSupport = tempDir()
    writeRuntimeTree(join(appSupport, 'runtimes', '0.2.1-alpha.2'))
    await expect(
      installRuntime({ appSupport, version: '0.2.1-alpha.2', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs' }),
    ).rejects.toThrow('已经装好了')
  })

  test('工作区文件与命令形态：独立 store + packages: [] + hoisted + Bun 跑 pnpm.cjs', async () => {
    const appSupport = tempDir()
    const fake = fakeSpawn(({ dir }) => {
      writeRuntimeTree(dir)
      return { code: 0 }
    })
    await installRuntime({
      appSupport,
      version: '9.9.9',
      bunPath: '/opt/bun',
      pnpmCjs: '/builtin/node_modules/pnpm/bin/pnpm.cjs',
      nodeShimDir: '/shim',
      env: { FOO: 'bar' },
      spawnImpl: fake.spawnImpl,
    })
    const dir = join(appSupport, 'runtimes', '9.9.9')
    const workspace = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace.startsWith('packages: []\n')).toBe(true)
    expect(workspace).toContain('nodeLinker: hoisted')
    // 产物把 storeDir 归一成正斜杠（pnpm 友好），断言跟着归一，Windows 上才对得上
    expect(workspace).toContain(`storeDir: ${join(appSupport, 'runtimes', '.pnpm-store').replace(/\\/g, '/')}`)
    expect(workspace).toContain('allowBuilds:')
    expect(workspace).toContain('node-pty: true')
    expect(readFileSync(join(dir, '.npmrc'), 'utf8')).toBe(
      `node-linker=hoisted\nstore-dir=${join(appSupport, 'runtimes', '.pnpm-store').replace(/\\/g, '/')}\n`,
    )
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({ name: 'dsh-runtime-9.9.9', private: true })

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.command).toEqual([
      '/opt/bun',
      '/builtin/node_modules/pnpm/bin/pnpm.cjs',
      'add',
      '--reporter=default',
      '@deepseek-ai/dsh@9.9.9',
    ])
    const options = fake.calls[0]?.options ?? {}
    expect(options.cwd).toBe(dir)
    const env = options.env as Record<string, string>
    // 垫片目录接在 PATH 最前，分隔符按平台（Windows 是 `;`）
    expect(env.PATH?.startsWith(`/shim${delimiter}`)).toBe(true)
    expect(env.FOO).toBe('bar')
  })

  test('进度行回调带三个数字（非进度行不进回调）', async () => {
    const appSupport = tempDir()
    const seen: number[] = []
    const fake = fakeSpawn(({ dir }) => {
      writeRuntimeTree(dir)
      return {
        code: 0,
        stdout: 'Progress: resolved 10, downloaded 0, added 0\nsome other line\nProgress: resolved 1,234, downloaded 56, added 7\n',
      }
    })
    await installRuntime({
      appSupport,
      version: '9.9.9',
      bunPath: '/bin/bun',
      pnpmCjs: '/p/pnpm.cjs',
      onProgress: (progress) => seen.push(progress.resolved),
      spawnImpl: fake.spawnImpl,
    })
    expect(seen).toEqual([10, 1234])
  })

  test('失败：带错误尾巴、半成品目录被清掉', async () => {
    const appSupport = tempDir()
    const fake = fakeSpawn(() => ({ code: 1, stderr: 'ERR_PNPM_UNEXPECTED_STORE store mismatch\nsecond line' }))
    await expect(
      installRuntime({ appSupport, version: '9.9.9', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs', spawnImpl: fake.spawnImpl }),
    ).rejects.toThrow('ERR_PNPM_UNEXPECTED_STORE')
    expect(() => readFileSync(join(appSupport, 'runtimes', '9.9.9', 'package.json'))).toThrow()
  })

  test('退出码 0 但树不完整也算失败（判据是 isRuntimeTreeValid）', async () => {
    const appSupport = tempDir()
    const fake = fakeSpawn(() => ({ code: 0 }))
    await expect(
      installRuntime({ appSupport, version: '9.9.9', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs', spawnImpl: fake.spawnImpl }),
    ).rejects.toThrow('运行时树不完整')
    expect(() => readFileSync(join(appSupport, 'runtimes', '9.9.9', 'package.json'))).toThrow()
  })

  test('超时：kill 掉子进程并报超时（消息带秒数）', async () => {
    const appSupport = tempDir()
    let killed = false
    const spawnImpl = (): {
      exited: Promise<number>
      stdout?: ReadableStream<Uint8Array> | null
      stderr?: ReadableStream<Uint8Array> | null
      kill?: () => void
    } => {
      let resolveExit: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve
      })
      return {
        exited,
        kill: () => {
          killed = true
          resolveExit(143)
        },
      }
    }
    await expect(
      installRuntime({ appSupport, version: '9.9.9', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs', timeoutMs: 30, spawnImpl }),
    ).rejects.toThrow('安装超时')
    expect(killed).toBe(true)
  })
})

describe('createRuntimeDownloader', () => {
  test('成功：进度进状态、装完记账、状态复位但保留数字', async () => {
    const recorded: Array<{ version: string; source: string }> = []
    const downloader = createRuntimeDownloader({
      install: async (_version, onProgress) => {
        onProgress({ resolved: 5, downloaded: 4, added: 3 })
      },
      record: (version, source) => recorded.push({ version, source }),
    })
    expect(downloader.status()).toEqual({ active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '' })
    const seenDuringRun: boolean[] = []
    const pending = downloader.start('9.9.9', 'npm')
    seenDuringRun.push(downloader.status().active)
    await expect(pending).resolves.toEqual({ ok: true, version: '9.9.9' })
    expect(seenDuringRun).toEqual([true])
    expect(recorded).toEqual([{ version: '9.9.9', source: 'npm' }])
    expect(downloader.status()).toEqual({ active: false, version: '9.9.9', resolved: 5, downloaded: 4, added: 3, error: '' })
  })

  test('单飞：已有任务在跑时第二次 start 抛「已有运行时下载任务」', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const downloader = createRuntimeDownloader({
      install: async () => {
        await gate
      },
      record: () => {},
    })
    const first = downloader.start('1.0.0', 'github')
    await expect(downloader.start('2.0.0', 'github')).rejects.toThrow('已有运行时下载任务')
    release()
    await first
    // 跑完就能再下一个
    await expect(downloader.start('2.0.0', 'github')).resolves.toEqual({ ok: true, version: '2.0.0' })
  })

  test('失败：错误进状态、不记账、active 复位（面板靠 error 判定成败）', async () => {
    const recorded: string[] = []
    const downloader = createRuntimeDownloader({
      install: async () => {
        throw new Error('dsh 9.9.9 安装失败（exit 1）：ERR_PNPM_NO_MATCHING_VERSION')
      },
      record: (version) => recorded.push(version),
    })
    await expect(downloader.start('9.9.9', 'github')).rejects.toThrow('ERR_PNPM_NO_MATCHING_VERSION')
    expect(recorded).toEqual([])
    const status = downloader.status()
    expect(status.active).toBe(false)
    expect(status.error).toContain('ERR_PNPM_NO_MATCHING_VERSION')
    expect(status.version).toBe('9.9.9')
  })
})
