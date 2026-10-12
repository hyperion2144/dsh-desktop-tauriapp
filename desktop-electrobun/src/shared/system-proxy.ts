// 系统代理解析的**纯逻辑**（旧壳 `desktop/src-tauri/src/network/proxy.rs` 的
// `parse_scutil_proxy` / `parse_windows_proxy_server` / `system_proxy_env`）。
//
// 两条硬规则（旧壳研究结论，别改）：
//   · **PAC 不注入代理 URL**：环境变量表达不了按 URL 求值，猜错的代理比不注入更糟 ⇒ 只给 NO_PROXY；
//   · **https 代理也是 HTTP CONNECT 代理**：URL scheme 写的是代理自身协议，所以 https 条目一律 `http://`。

import { normalizeProxyUrl } from './profile-ops.ts'
import { mergeNoProxyEntries, normalizeNoProxyEntries, type ProxyEnv } from './proxy-env.ts'

/**
 * `host` 或 `host:port` → 规范化代理 URL（缺端口按 `defaultPort` 补）。
 * 复用 `normalizeProxyUrl`，所以 `[::1]:8080`、裸 `::1`、坏端口都会被正确处理。
 */
export function proxyUrlFromAuthority(scheme: 'http' | 'socks5', authority: string, defaultPort: number): string | null {
  const trimmed = authority.trim()
  if (trimmed === '') return null
  const hasPort = /:\d+$/.test(trimmed)
  const withPort = hasPort ? trimmed : `${trimmed}:${String(defaultPort)}`
  const normalized = normalizeProxyUrl(`${scheme}://${withPort}`)
  return normalized.ok ? normalized.target.url : null
}

/**
 * 解析 macOS `scutil --proxy`（NeXT 风格 plist 文本）。
 * 以 `XxxEnable == 1` 为准（配置过但禁用的键会残留）；`ExceptionsList` 是下标数组。
 */
export function parseScutilProxy(text: string): ProxyEnv | null {
  const scalars = new Map<string, string>()
  const exceptions: string[] = []
  let inExceptions = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (inExceptions) {
      if (trimmed === '}') {
        inExceptions = false
        continue
      }
      const split = trimmed.split(' : ')
      const key = split[0] ?? ''
      const value = split.slice(1).join(' : ')
      if (key !== '' && /^\d+$/.test(key) && value !== '') exceptions.push(value)
      continue
    }
    const index = trimmed.indexOf(' : ')
    if (index < 0) continue
    const key = trimmed.slice(0, index)
    const value = trimmed.slice(index + 3)
    if (value === '<array> {') {
      inExceptions = true
      continue
    }
    scalars.set(key, value)
  }
  if (scalars.size === 0) return null
  const flag = (key: string): boolean => scalars.get(key) === '1'
  const hostPort = (hostKey: string, portKey: string): string | null => {
    const host = scalars.get(hostKey)
    if (host === undefined || host === '') return null
    const port = scalars.get(portKey)
    return port === undefined || port === '' ? host : `${host}:${port}`
  }
  const noProxy = mergeNoProxyEntries(normalizeNoProxyEntries(exceptions.join(',')))
  if (flag('ProxyAutoConfigEnable')) {
    return { http: null, https: null, all: null, no_proxy: noProxy }
  }
  const env: ProxyEnv = { http: null, https: null, all: null, no_proxy: noProxy }
  if (flag('HTTPEnable')) env.http = portOf(hostPort('HTTPProxy', 'HTTPPort'), 'http', 80)
  if (flag('HTTPSEnable')) env.https = portOf(hostPort('HTTPSProxy', 'HTTPSPort'), 'http', 443)
  if (flag('SOCKSEnable')) env.all = portOf(hostPort('SOCKSProxy', 'SOCKSPort'), 'socks5', 1080)
  return env
}

function portOf(authority: string | null, scheme: 'http' | 'socks5', defaultPort: number): string | null {
  return authority === null ? null : proxyUrlFromAuthority(scheme, authority, defaultPort)
}

/** 解析 Windows `ProxyServer`：单值 `host:port` 对 http/https 同时生效；分协议格式只映射写出且非空的项。 */
export function parseWindowsProxyServer(raw: string): { http: string | null; https: string | null; all: string | null } {
  if (!raw.includes('=')) {
    const url = proxyUrlFromAuthority('http', raw, 80)
    return { http: url, https: url, all: null }
  }
  let http: string | null = null
  let https: string | null = null
  let all: string | null = null
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim().toLowerCase()
    const value = part.slice(index + 1).trim()
    if (value === '') continue
    if (key === 'http') http = proxyUrlFromAuthority('http', value, 80)
    else if (key === 'https' || key === 'secure') https = proxyUrlFromAuthority('http', value, 443)
    else if (key === 'socks') all = proxyUrlFromAuthority('socks5', value, 1080)
  }
  return { http, https, all }
}

/**
 * 解析 `reg query "HKCU\…\Internet Settings"` 的输出（大小写都认，值里可能有空格）。
 * `AutoConfigURL` 存在 = PAC 生效（取消勾选会移除该值）⇒ 只给 NO_PROXY；
 * `ProxyEnable != 1` 视为未启用（残留的 ProxyServer 不算生效）。
 */
export function parseWindowsProxyRegistry(text: string): ProxyEnv | null {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s{2,}([A-Za-z]+)\s+REG_(?:SZ|DWORD)\s+(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const value = (match[2] ?? '').trim()
    if (key === undefined || key === '') continue
    values.set(key.toLowerCase(), value)
  }
  if (values.size === 0) return null
  const entries = (): string => mergeNoProxyEntries(normalizeNoProxyEntries(values.get('proxyoverride') ?? ''))
  const pac = values.get('autoconfigurl')
  if (pac !== undefined && pac !== '') return { http: null, https: null, all: null, no_proxy: entries() }
  const enable = values.get('proxyenable')
  if (enable !== '0x1' && enable !== '1') return null
  const server = values.get('proxyserver') ?? ''
  if (server.trim() === '') return null
  const parsed = parseWindowsProxyServer(server)
  if (parsed.http === null && parsed.https === null && parsed.all === null) return null
  return { http: parsed.http, https: parsed.https, all: parsed.all, no_proxy: entries() }
}
