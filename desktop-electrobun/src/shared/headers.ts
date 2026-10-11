// 请求/响应头的剥与补。
//
// 对齐官方 apps/desktop/src/web-document.ts：转发时删 host/origin/cookie/sec-fetch-site
// 再塞壳持有的 cookie；响应剥掉 WITHHELD_RESPONSE_HEADERS（含 set-cookie）。
// /api/* 与 /plugins/* 一律 no-store——插件资产与数据面不得被缓存（官方同款规则）。

export const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]

/** 出站请求要剥掉的：cookie 由壳按 authority 重新塞，host 改写为上游 authority。 */
export const SCRUBBED_REQUEST_HEADERS = [
  'host',
  'origin',
  'cookie',
  'sec-fetch-site',
  'accept-encoding',
  'content-length',
  'connection',
]

export function scrubRequestHeaders(input: Headers, opts: { cookie?: string; authority: string }): Headers {
  const out = new Headers()
  for (const [key, value] of input.entries()) {
    if (SCRUBBED_REQUEST_HEADERS.includes(key.toLowerCase())) continue
    out.set(key, value)
  }
  out.set('host', opts.authority)
  if (opts.cookie !== undefined && opts.cookie !== '') out.set('cookie', opts.cookie)
  return out
}

/** /plugins/* 与 /api/* 一律 no-store（官方同款规则）。 */
export function shouldNoStore(pathname: string): boolean {
  return (
    pathname === '/plugins' ||
    pathname.startsWith('/plugins/') ||
    pathname === '/api' ||
    pathname.startsWith('/api/')
  )
}

export function scrubResponseHeaders(input: Headers, opts: { pathname: string }): Headers {
  const out = new Headers()
  for (const [key, value] of input.entries()) {
    if (WITHHELD_RESPONSE_HEADERS.includes(key.toLowerCase())) continue
    out.set(key, value)
  }
  if (shouldNoStore(opts.pathname)) out.set('cache-control', 'no-store')
  return out
}

/** CORS：数据面是同源调用，预检只在壳自己的 loopback origin 上应答（不再猴补丁改写 URL）。 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '600',
  }
}
