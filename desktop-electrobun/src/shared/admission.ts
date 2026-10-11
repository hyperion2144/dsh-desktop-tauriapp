// 准入（规格第 2 条闸门口径）：两类准入 + 壳自答端点。
//
// ① 文档与静态资产走「每次启动的 token 路径前缀」，不匹配一律 404（不泄露存在性）；
// ② 数据面（RPC / SSE / WS 隧道 / 插件资产）以**根绝对路径**发出——dsh 会绕开 <base>，
//    所以对它们不做 token 前缀要求，改用「同源校验（Origin / Sec-Fetch-Site）+ 拒绝跨站」；
// ③ 壳自答端点（/__shell__/*）本地应答，但不豁免网络准入（仍须同源）。
//
// 为什么数据面不能要 token：`/api/...` 是根绝对路径（#219 实测：页面发出的 RPC、
// SSE、插件资产都不带启动令牌前缀），给它们加 token 要求就是全站 404。

export const SHELL_PREFIX = '/__shell__/'
export const FORBIDDEN_STATUS = 403
export const MISSING_STATUS = 404

export type AdmissionKind = 'shell' | 'document' | 'data' | 'reject'

export interface AdmissionDecision {
  kind: AdmissionKind
  /** document：已剥 token 的相对路径（默认补成 /index.html）；其余：原始 pathname */
  rel: string
  /** 转发用：已剥 token 但**不**补 index.html 的路径（/plugins/ 这类端点靠查询串寻址） */
  stripped: string
  status?: number
  reason?: string
}

export interface AdmissionInput {
  pathname: string
  token: string
  origin?: string | null
  secFetchSite?: string | null
  selfOrigin: string
}

/** 命中「/<token>/…」返回剥掉前缀的路径；`/<token>` 本身当根；否则 null。 */
export function stripToken(pathname: string, token: string): string | null {
  if (token === '') return null
  const prefix = `/${token}`
  if (pathname === prefix || pathname === `${prefix}/`) return '/'
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length)
  return null
}

/** 同源判据：Sec-Fetch-Site 只在明确跨站时拒绝；Origin 与自身 origin 不等即拒绝。 */
export function isCrossSite(input: Pick<AdmissionInput, 'origin' | 'secFetchSite' | 'selfOrigin'>): boolean {
  const { origin, secFetchSite, selfOrigin } = input
  if (
    secFetchSite !== undefined &&
    secFetchSite !== null &&
    secFetchSite !== '' &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  ) {
    return true
  }
  if (origin !== undefined && origin !== null && origin !== '' && origin !== selfOrigin) return true
  return false
}

export function decide(input: AdmissionInput): AdmissionDecision {
  const { pathname, token } = input
  if (isCrossSite(input)) {
    return { kind: 'reject', rel: pathname, stripped: pathname, status: FORBIDDEN_STATUS, reason: 'cross-site' }
  }
  if (pathname.startsWith(SHELL_PREFIX)) return { kind: 'shell', rel: pathname.slice(SHELL_PREFIX.length), stripped: pathname }
  const rel = stripToken(pathname, token)
  if (rel !== null) return { kind: 'document', rel: normalizeRel(rel), stripped: rel }
  return { kind: 'data', rel: pathname, stripped: pathname }
}

/** 目录型路径补 index.html；`/` 与空串都指向首页。 */
export function normalizeRel(rel: string): string {
  if (rel === '' || rel === '/') return '/index.html'
  if (rel.endsWith('/')) return `${rel}index.html`
  return rel
}

export function sameOriginOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
