// 系统代理检测的 IO 层（旧壳 `network/proxy.rs::system_proxy_env`）：
// macOS 问 `scutil --proxy`、Windows 问注册表、其余平台读环境变量。
// 任何一步失败都回 null（**不注入**）——猜错的代理比不注入更糟，这条与旧壳一致。

import { systemProxyFromEnv, type ProxyEnv } from '../shared/proxy-env.ts'
import { parseScutilProxy, parseWindowsProxyRegistry } from '../shared/system-proxy.ts'

export interface SystemProxyRunResult {
  status: number
  stdout: string
}

export interface SystemProxyInput {
  platform: string
  env: Record<string, string | undefined>
  /** 注入点：单测用它替掉真进程（默认 `Bun.spawnSync`）。 */
  run?: (cmd: string[]) => SystemProxyRunResult
  log?: (line: string) => void
}

export function detectSystemProxy(input: SystemProxyInput): ProxyEnv | null {
  const log = input.log ?? ((): void => {})
  const run = input.run ?? defaultRun
  if (input.platform === 'darwin') {
    const result = safeRun(run, ['scutil', '--proxy'])
    if (result !== null && result.status === 0) {
      const parsed = parseScutilProxy(result.stdout)
      if (parsed !== null) {
        log(`[proxy] 继承系统代理（scutil）：${describe(parsed)}`)
        return parsed
      }
    }
    return systemProxyFromEnv(input.env)
  }
  if (input.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const result = safeRun(run, ['reg', 'query', key])
    if (result !== null && result.status === 0) {
      const parsed = parseWindowsProxyRegistry(result.stdout)
      if (parsed !== null) {
        log(`[proxy] 继承系统代理（注册表）：${describe(parsed)}`)
        return parsed
      }
    }
    return systemProxyFromEnv(input.env)
  }
  return systemProxyFromEnv(input.env)
}

function describe(env: ProxyEnv): string {
  const parts = [env.http === null ? null : `http=${env.http}`, env.https === null ? null : `https=${env.https}`, env.all === null ? null : `all=${env.all}`]
  return parts.filter((part): part is string => part !== null).join(' ') + ` no_proxy=${env.no_proxy}`
}

function safeRun(run: (cmd: string[]) => SystemProxyRunResult, cmd: string[]): SystemProxyRunResult | null {
  try {
    return run(cmd)
  } catch {
    return null
  }
}

function defaultRun(cmd: string[]): SystemProxyRunResult {
  const child = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'ignore' })
  const stdout = child.stdout === null || child.stdout === undefined ? '' : new TextDecoder().decode(child.stdout)
  return { status: child.exitCode ?? 1, stdout }
}
