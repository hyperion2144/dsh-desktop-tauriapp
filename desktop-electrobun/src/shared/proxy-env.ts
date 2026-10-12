// 代理注入的**纯逻辑**（旧壳 `desktop/src-tauri/src/network/proxy.rs` 的
// `resolved_proxy_env` / `normalize_no_proxy_entries` / `merge_no_proxy_entries` /
// `inject_proxy_credentials`）。
//
// 这一层只算「该注入什么」；真正写进子进程环境、以及系统代理的平台检测（scutil /
// 注册表 / 环境变量）在接线层（`child-env.ts` + `service.ts`）。设置面板的
// `get_proxy_settings.effective` 展示的就是这里算出来的那份。

import type { DesktopSettings } from './settings.ts'
import { normalizeProxyUrl } from './profile-ops.ts'

/** 回环保底：恒进 NO_PROXY（旧壳 `PROXY_LOOPBACK_ENTRIES`）。 */
export const PROXY_LOOPBACK_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const

export interface ProxyEnv {
  http: string | null
  https: string | null
  all: string | null
  no_proxy: string
}

/**
 * 归一 NO_PROXY 条目（旧壳语义）：逗号/分号/空白都算分隔；`<local>` 展开成回环保底；
 * `*.corp` 记成 `.corp`；含 `/` 的 CIDR 在 NO_PROXY 没有标准语义，丢弃。
 */
export function normalizeNoProxyEntries(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,;\s]+/)) {
    const entry = part.trim()
    if (entry === '') continue
    const lower = entry.toLowerCase()
    if (lower === '<local>') {
      out.push(...PROXY_LOOPBACK_ENTRIES)
      continue
    }
    if (lower.startsWith('*.')) {
      const suffix = lower.slice(2)
      if (suffix !== '') out.push(`.${suffix}`)
      continue
    }
    if (lower.includes('/')) continue
    out.push(lower)
  }
  return out
}

/** 合并条目并补回环保底，去重后按顺序拼成 NO_PROXY（旧壳 `merge_no_proxy_entries`）。 */
export function mergeNoProxyEntries(entries: readonly string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...entries, ...PROXY_LOOPBACK_ENTRIES]) {
    if (seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out.join(',')
}

/** 给代理 URL 拼 `user:pass@`（只认 http/https/socks5；已有 userinfo 或没 scheme 就原样返回）。 */
export function injectProxyCredentials(url: string, user: string, pass: string): string {
  if (user === '') return url
  const idx = url.indexOf('://')
  if (idx < 0) return url
  const afterScheme = idx + 3
  const authority = url.slice(afterScheme)
  if (authority.includes('@')) return url
  const userinfo = pass === '' ? `${user}@` : `${user}:${pass}@`
  return `${url.slice(0, afterScheme)}${userinfo}${authority}`
}

/** 从环境里读一份「系统代理」（大小写都认；`system` 模式在 mac 上还会被 scutil 覆盖）。 */
export function systemProxyFromEnv(env: Record<string, string | undefined>): ProxyEnv | null {
  const pick = (name: string): string => {
    const upper = env[name.toUpperCase()]
    const lower = env[name.toLowerCase()]
    return (upper ?? lower ?? '').trim()
  }
  const http = pick('http_proxy')
  const https = pick('https_proxy')
  const all = pick('all_proxy')
  const noProxy = pick('no_proxy')
  if (http === '' && https === '' && all === '') return null
  return {
    http: http === '' ? null : http,
    https: https === '' ? null : https,
    all: all === '' ? null : all,
    no_proxy: mergeNoProxyEntries(normalizeNoProxyEntries(noProxy)),
  }
}

/**
 * 该配置文件对应的注入环境（旧壳 `resolved_proxy_env`）：
 * `off` → null；`manual` 走 URL 规范化（socks5 只写 ALL_PROXY，其余写 HTTP(S)_PROXY）；
 * `system` 用传进来的检测结果（没有就 null，不注入）。最后按需拼凭据。
 */
export function resolveProxyEnv(settings: DesktopSettings, systemProxy: ProxyEnv | null = null): ProxyEnv | null {
  const mode = settings.proxyMode ?? 'off'
  let env: ProxyEnv | null = null
  if (mode === 'manual') {
    const normalized = normalizeProxyUrl(settings.proxyUrl ?? '')
    if (normalized.ok) {
      const url = normalized.target.url
      const entries = normalizeNoProxyEntries(settings.noProxy ?? '')
      env =
        url.startsWith('socks5://')
          ? { http: null, https: null, all: url, no_proxy: mergeNoProxyEntries(entries) }
          : { http: url, https: url, all: null, no_proxy: mergeNoProxyEntries(entries) }
    }
  } else if (mode === 'system') {
    env = systemProxy
  }
  if (env === null) return null
  const user = settings.proxyUser ?? ''
  if (user === '') return env
  const pass = settings.proxyPass ?? ''
  const inject = (value: string | null): string | null => (value === null ? null : injectProxyCredentials(value, user, pass))
  return { ...env, http: inject(env.http), https: inject(env.https), all: inject(env.all) }
}
