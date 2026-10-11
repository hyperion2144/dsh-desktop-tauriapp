// dsh 系统命令注册：纯逻辑 + IO 外壳（旧壳 `desktop/src-tauri/src/register/` 的等价物）。
// IO 侧全部注入（run / 文件读写 / realpath），所以这里不 spawn 真 shell、不碰真实 PATH。
import { describe, expect, test } from 'bun:test'
import {
  CACHE_TTL_MS,
  CONFLICT_MARKER,
  REGISTER_TARGET,
  classifyResolution,
  classifyShim,
  extractLastNonEmptyLine,
  parseUserShell,
  registerTrayLabel,
  registrationScript,
  samePath,
  shellQuote,
  shellRcPathFix,
  shimFileName,
  shimPathOf,
  shimScript,
  stripAnsi,
  type RegisterState,
} from '../src/shared/register-cli.ts'
import { createRegisterCli, type RunResult } from '../src/bun/register-cli.ts'

describe('shim：位置 / 内容 / 判词', () => {
  test('文件名与路径按平台', () => {
    expect(shimFileName('darwin')).toBe('dsh')
    expect(shimFileName('win32')).toBe('dsh.cmd')
    expect(shimPathOf('/tmp/app', 'darwin')).toBe('/tmp/app/runtime/bin-dsh/dsh')
    expect(shimPathOf('/tmp/app/', 'win32')).toBe('/tmp/app/runtime/bin-dsh/dsh.cmd')
  })

  test('unix shim 是一条 exec 转发，参数带引号，指向当前运行时的启动命令', () => {
    const text = shimScript('darwin', ['/bun', '--no-install', '--preload', "/tmp/a b/p.mjs", '/lib/bin.js'])
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toContain("exec '/bun' '--no-install' '--preload' '/tmp/a b/p.mjs' '/lib/bin.js' \"$@\"")
    expect(text).toContain('由 dsh 桌面壳维护')
  })

  test('windows shim 是 .cmd，参数用双引号', () => {
    const text = shimScript('win32', ['C:\\bun.exe', '--no-install', 'C:\\lib\\bin.js'])
    expect(text).toBe('@echo off\r\n"C:\\bun.exe" "--no-install" "C:\\lib\\bin.js" %*\r\n')
  })

  test('判词：absent / ours / stale / foreign（别人放的不覆盖）', () => {
    const expected = shimScript('darwin', ['/bun', '/lib/bin.js'])
    expect(classifyShim(null, expected)).toBe('absent')
    expect(classifyShim(expected, expected)).toBe('ours')
    expect(classifyShim(shimScript('darwin', ['/other', '/lib/bin.js']), expected)).toBe('stale')
    expect(classifyShim('#!/bin/sh\nexec /usr/local/bin/dsh-old "$@"\n', expected)).toBe('foreign')
  })
})

describe('探测输出清洗', () => {
  test('取末行非空并剥 ANSI（rc 横幅在前）', () => {
    const text = '\u001b[1m欢迎\u001b[0m\n\n/usr/local/bin/dsh\n'
    expect(extractLastNonEmptyLine(text)).toBe('/usr/local/bin/dsh')
    expect(stripAnsi('\u001b[31m红\u001b[0m')).toBe('红')
    expect(extractLastNonEmptyLine('\n\n')).toBeNull()
  })

  test('dscl 的 UserShell 解析，失败回 null', () => {
    expect(parseUserShell('UserShell: /bin/zsh\n')).toBe('/bin/zsh')
    expect(parseUserShell('No such key')).toBeNull()
  })
})

describe('三态判定', () => {
  const base = { shimPath: '/app/runtime/bin-dsh/dsh', shimReady: true, platform: 'darwin' }

  test('解析不到 → 未注册；shim 没物化 → 也是未注册', () => {
    expect(classifyResolution({ ...base, resolved: null })).toBe('missing')
    expect(classifyResolution({ ...base, shimReady: false, resolved: '/usr/local/bin/dsh' })).toBe('missing')
  })

  test('命中本壳 → 已注册；别的路径 → 冲突', () => {
    expect(classifyResolution({ ...base, resolved: '/app/runtime/bin-dsh/dsh' })).toBe('registered')
    expect(classifyResolution({ ...base, resolved: '/opt/homebrew/bin/dsh' })).toBe('conflict')
  })

  test('路径比较：尾斜杠、Windows 大小写与斜杠', () => {
    expect(samePath('/a/b/', '/a/b', 'darwin')).toBe(true)
    expect(samePath('C:\\App\\dsh.cmd', 'c:/app/dsh.cmd', 'win32')).toBe(true)
    expect(samePath('/a/b', '/a/c', 'darwin')).toBe(false)
  })

  test('托盘文案：已注册/未探出不显示，未注册/冲突给对应文案', () => {
    const state = (kind: RegisterState['kind'], resolved: string | null = null): RegisterState => ({
      kind,
      resolved,
      shimReady: true,
      at: 0,
    })
    expect(registerTrayLabel(state('registered'))).toBeNull()
    expect(registerTrayLabel(state('unknown'))).toBeNull()
    expect(registerTrayLabel(state('missing'))).toBe('注册 dsh 为系统命令')
    expect(registerTrayLabel(state('conflict', '/opt/homebrew/bin/dsh'))).toContain('/opt/homebrew/bin/dsh')
  })
})

describe('提权脚本与 rc 修正', () => {
  test('脚本：幂等（已是我们 exit 0）、冲突标记、force 备份、ln -sfn', () => {
    const script = registrationScript({ shim: '/app/runtime/bin-dsh/dsh', force: false })
    expect(script).toContain('/bin/mkdir -p \'/usr/local/bin\'')
    expect(script).toContain(`t='${REGISTER_TARGET}'`)
    expect(script).toContain('exit 0')
    expect(script).toContain(`echo '${CONFLICT_MARKER}' >&2`)
    expect(script).toContain("/bin/ln -sfn '/app/runtime/bin-dsh/dsh' \"$t\"")
    expect(registrationScript({ shim: '/x', force: true })).toContain("/bin/mv \"$t\" \"$t.bak.")
  })

  test('shell 单引号转义', () => {
    expect(shellQuote("/a b'c")).toBe("'/a b'\\''c'")
  })

  test('rc 修正：zsh 走 .zshrc，fish 用 fish_add_path，bash 不遮蔽已有 .profile', () => {
    expect(shellRcPathFix({ shell: '/bin/zsh', home: '/Users/x', exists: () => false })).toEqual({
      file: '/Users/x/.zshrc',
      line: 'export PATH="/usr/local/bin:$PATH"',
    })
    expect(shellRcPathFix({ shell: '/opt/homebrew/bin/fish', home: '/Users/x', exists: () => false })).toEqual({
      file: '/Users/x/.config/fish/config.fish',
      line: 'fish_add_path /usr/local/bin',
    })
    // .bash_profile 存在 → 用它
    expect(
      shellRcPathFix({ shell: '/bin/bash', home: '/Users/x', exists: (p) => p.endsWith('.bash_profile') }).file,
    ).toBe('/Users/x/.bash_profile')
    // 不存在但 .profile 在 → 退回 .profile（新建 .bash_profile 会遮蔽它）
    expect(shellRcPathFix({ shell: '/bin/bash', home: '/Users/x', exists: (p) => p.endsWith('.profile') }).file).toBe(
      '/Users/x/.profile',
    )
    // 两个都没有 → 新建 .bash_profile
    expect(shellRcPathFix({ shell: '/bin/bash', home: '/Users/x', exists: () => false }).file).toBe(
      '/Users/x/.bash_profile',
    )
  })
})

/** 注入件：内存文件系统 + 可编排的 run（记下跑过什么）。 */
function harness(options: {
  files?: Record<string, string>
  dshResolved?: string | null
  runStatus?: number
  runStderr?: string
  platform?: string
}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const calls: string[][] = []
  const logs: string[] = []
  const run = (argv: string[]): RunResult => {
    calls.push(argv)
    if (argv[0] === '/usr/bin/dscl') return { status: 0, stdout: 'UserShell: /bin/zsh\n', stderr: '' }
    if (argv.includes('-ilc')) {
      const resolved = options.dshResolved === undefined ? null : options.dshResolved
      return { status: resolved === null ? 1 : 0, stdout: resolved === null ? '' : `${resolved}\n`, stderr: '' }
    }
    return { status: options.runStatus ?? 0, stdout: '', stderr: options.runStderr ?? '' }
  }
  const cli = createRegisterCli({
    log: (message) => logs.push(message),
    appSupport: '/app-support',
    platform: options.platform ?? 'darwin',
    shellCommand: () => ['/bun', '/lib/bin.js'],
    run,
    readText: (path) => files.get(path) ?? null,
    writeText: (path, text) => void files.set(path, text),
    exists: (path) => files.has(path),
    realpath: (path) => path,
    env: { USER: 'tester', SHELL: '/bin/zsh' },
  })
  return { cli, files, calls, logs }
}

describe('createRegisterCli（IO 外壳，全部注入）', () => {
  test('ensureShim 写入并带 exec 位；已是我们就不重写', () => {
    const { cli, files, logs } = harness({})
    const first = cli.ensureShim()
    expect(first.verdict).toBe('ours')
    expect(files.get('/app-support/runtime/bin-dsh/dsh')).toContain("exec '/bun' '/lib/bin.js'")
    const second = cli.ensureShim()
    expect(second.verdict).toBe('ours')
    expect(logs.filter((line) => line.includes('shim 已写入')).length).toBe(1)
  })

  test('foreign 的 shim 不动它', () => {
    const { cli, files, logs } = harness({ files: { '/app-support/runtime/bin-dsh/dsh': '#!/bin/sh\nexec /other\n' } })
    expect(cli.ensureShim().verdict).toBe('foreign')
    expect(files.get('/app-support/runtime/bin-dsh/dsh')).toBe('#!/bin/sh\nexec /other\n')
    expect(logs.some((line) => line.includes('不覆盖'))).toBe(true)
  })

  test('refresh：未注册 / 已注册 / 冲突三态 + 缓存 TTL', async () => {
    const missing = harness({ dshResolved: null })
    expect((await missing.cli.refresh()).kind).toBe('missing')

    const registered = harness({ dshResolved: '/app-support/runtime/bin-dsh/dsh' })
    const state = await registered.cli.refresh()
    expect(state.kind).toBe('registered')
    expect(registered.cli.cached().kind).toBe('registered')
    expect(CACHE_TTL_MS).toBeGreaterThan(0)

    const conflict = harness({ dshResolved: '/opt/homebrew/bin/dsh' })
    expect((await conflict.cli.refresh()).kind).toBe('conflict')
    expect(conflict.cli.describe()).toContain('/opt/homebrew/bin/dsh')
  })

  test('探测走用户真实登录 shell（-ilc + DISABLE_AUTO_UPDATE）', async () => {
    const { cli, calls } = harness({ dshResolved: null })
    await cli.refresh()
    const detect = calls.find((argv) => argv.includes('-ilc'))
    expect(detect?.[0]).toBe('/bin/zsh')
    expect(detect?.[2]).toBe('command -v dsh')
  })

  test('register：macOS 走 osascript 提权；取消 / 冲突 / 成功三种收场', async () => {
    const ok = harness({ dshResolved: null, runStatus: 0 })
    const done = await ok.cli.register()
    expect(done.ok).toBe(true)
    const script = ok.calls.find((argv) => argv[0] === '/usr/bin/osascript')?.join(' ') ?? ''
    expect(script).toContain('with administrator privileges')

    const canceled = harness({ dshResolved: null, runStatus: 1, runStderr: 'execution error: 用户已取消 (-128)' })
    expect((await canceled.cli.register()).code).toBe('canceled')

    const conflict = harness({
      dshResolved: null,
      runStatus: 3,
      runStderr: `sh: ${CONFLICT_MARKER}`,
    })
    const conflicted = await conflict.cli.register()
    expect(conflicted.code).toBe('conflict')
    expect(conflicted.message).toContain('强制覆盖')
  })

  test('非 macOS 平台：只物化 shim，注册执行明确说没接', async () => {
    const linux = harness({ platform: 'linux', dshResolved: null })
    const result = await linux.cli.register()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unsupported')
    expect(linux.files.has('/app-support/runtime/bin-dsh/dsh')).toBe(true)
  })
})
