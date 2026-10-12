// 登录 shell 环境读取（#220：GUI 启动只继承 launchd 的最小 PATH，gh/bun/node 全部找不到）。
//
// 纯函数逐条对照官方 apps/desktop/src/login-shell-environment.ts 的语义；读取路径用**假 shell**
// （临时脚本按协议打印 dump）驱动，不依赖跑测者自己的 .zshrc —— CI 上也是确定性的。
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_LOGIN_SHELL_TIMEOUT_MS,
  LOGIN_SHELL_TIMEOUT_ENV,
  loginShellCandidates,
  mergeLoginShellEnvironment,
  parseLoginShellOutput,
  readLoginShellEnvironment,
  resolveLoginShellTimeoutMs,
} from '../src/bun/login-shell-env.ts'

const DELIMITER = '_DSH_SHELL_ENV_DELIMITER_'
const MARKER = `\0${DELIMITER}\0`

/** 假 shell：忽略 -ilc，直接按官方协议打印「噪声 + 分隔符 + env -0 + 分隔符」。 */
function fakeShell(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-login-shell-'))
  const file = join(dir, 'fake-shell.sh')
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

function dumpOnly(vars: Readonly<Record<string, string>>): string {
  return `# 欢迎语（rc 打的噪声）\nprintf '\\0%s\\0' '${DELIMITER}'; printf '%s\\0' ${quoteEach(vars)}; printf '\\0%s\\0' '${DELIMITER}'`
}

/** 每个键值各自一个参数：printf 的格式会被复用，于是每个变量后都跟一个 NUL。 */
function quoteEach(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([key, value]) => `'${key}=${value}'`)
    .join(' ')
}

describe('登录 shell 输出解析', () => {
  test('只取两个分隔符之间的键值，rc 噪声忽略', () => {
    const parsed = parseLoginShellOutput(`welcome\n${MARKER}PATH=/usr/bin:/bin\0SHELL=/bin/zsh\0${MARKER}trailing`)
    expect(parsed).toEqual({ PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' })
  })

  test('值里含 = 的也按第一个等号切', () => {
    expect(parseLoginShellOutput(`${MARKER}FOO=a=b\0${MARKER}`)).toEqual({ FOO: 'a=b' })
  })

  test('分隔符不成对 / 没有分隔符 → undefined', () => {
    expect(parseLoginShellOutput(`${MARKER}PATH=/usr/bin\0`)).toBeUndefined()
    expect(parseLoginShellOutput('PATH=/usr/bin\0')).toBeUndefined()
  })

  test('空条目与没有等号的行跳过', () => {
    expect(parseLoginShellOutput(`${MARKER}\0PATH=/bin\0NOEQUALS\0${MARKER}`)).toEqual({ PATH: '/bin' })
  })
})

describe('登录 shell 环境合并', () => {
  test('shell 的值赢，探针会话键与壳自己的 DSH_/ELECTROBUN_ 保持继承值', () => {
    const merged = mergeLoginShellEnvironment(
      { PATH: '/usr/bin:/bin', DSH_HOME: '/Users/me/.dsh', DSH_CLIENT_VERSION: '0.1.0', ELECTROBUN_APP: 'x', HOME: '/Users/me' },
      { PATH: '/opt/homebrew/bin:/usr/bin:/bin', PWD: '/tmp', SHLVL: '2', _: '/bin/zsh', DISABLE_AUTO_UPDATE: 'true', DSH_HOME: '/nope', ELECTROBUN_APP: 'y', HOMEBREW_PREFIX: '/opt/homebrew' },
    )
    expect(merged.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(merged.HOMEBREW_PREFIX).toBe('/opt/homebrew')
    expect(merged.DSH_HOME).toBe('/Users/me/.dsh')
    expect(merged.ELECTROBUN_APP).toBe('x')
    expect(merged.DSH_CLIENT_VERSION).toBe('0.1.0')
    expect(merged.PWD).toBeUndefined()
    expect(merged.SHLVL).toBeUndefined()
    expect(merged._).toBeUndefined()
    expect(merged.DISABLE_AUTO_UPDATE).toBeUndefined()
  })

  test('不改动入参', () => {
    const base = { PATH: '/bin' }
    const shell = { PATH: '/opt/bin' }
    mergeLoginShellEnvironment(base, shell)
    expect(base.PATH).toBe('/bin')
    expect(shell.PATH).toBe('/opt/bin')
  })
})

describe('超时与候选', () => {
  test('默认 10s，可用环境变量覆盖，坏值回落默认', () => {
    expect(resolveLoginShellTimeoutMs({})).toBe(DEFAULT_LOGIN_SHELL_TIMEOUT_MS)
    expect(resolveLoginShellTimeoutMs({ [LOGIN_SHELL_TIMEOUT_ENV]: '2500' })).toBe(2500)
    expect(resolveLoginShellTimeoutMs({ [LOGIN_SHELL_TIMEOUT_ENV]: '0' })).toBe(DEFAULT_LOGIN_SHELL_TIMEOUT_MS)
    expect(resolveLoginShellTimeoutMs({ [LOGIN_SHELL_TIMEOUT_ENV]: 'abc' })).toBe(DEFAULT_LOGIN_SHELL_TIMEOUT_MS)
  })

  test('候选里必有固定系统 shell，且无重复', () => {
    const candidates = loginShellCandidates()
    expect(candidates).toContain('/bin/zsh')
    expect(candidates).toContain('/bin/sh')
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  test('Windows 直接返回继承环境，不跑探针', async () => {
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin' }, { platform: 'win32', shells: ['/nonexistent'] })
    expect(result.environment).toEqual({ PATH: '/usr/bin' })
    expect(result.failures).toEqual([])
  })
})

// 这一组全靠「假 shell 脚本」驱动（POSIX sh），Windows 上跑不了——跳过而不是判失败。
describe.skipIf(process.platform === 'win32')('登录 shell 环境读取（假 shell 驱动）', () => {
  test('读到就合并，并把 PATH 换成登录 shell 的', async () => {
    const shell = fakeShell(dumpOnly({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOMEBREW_PREFIX: '/opt/homebrew' }))
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin:/bin' }, { shells: [shell] })
    expect(result.failures).toEqual([])
    expect(result.environment.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(result.environment.HOMEBREW_PREFIX).toBe('/opt/homebrew')
  })

  test('第一个候选挂了就换下一个，并把失败原因带上', async () => {
    const broken = fakeShell('exit 3')
    const good = fakeShell(dumpOnly({ PATH: '/opt/bin' }))
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin' }, { shells: [broken, good] })
    expect(result.environment.PATH).toBe('/opt/bin')
    expect(result.failures).toEqual([{ shell: broken, reason: 'exit 3' }])
  })

  test('全都读不到 → 退回继承环境（不抛错，照常启动）', async () => {
    const broken = fakeShell('exit 1')
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin' }, { shells: [broken] })
    expect(result.environment).toEqual({ PATH: '/usr/bin' })
    expect(result.failures.length).toBe(1)
  })

  test('一直不说话（rc 卡住）→ 超时收场，且不把壳带死', async () => {
    const silent = fakeShell('/bin/sleep 30')
    const started = Date.now()
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin' }, { shells: [silent], timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.failures).toEqual([{ shell: silent, reason: 'timeout' }])
    expect(result.environment).toEqual({ PATH: '/usr/bin' })
  })
})
