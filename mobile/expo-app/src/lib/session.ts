// 会话由**壳持有**（#151 决策 1/4，纯逻辑 + 注入的 fetch/存储端口）。
//
// 为什么壳持有而不是让 webview 的 cookie jar 持有：壳是反代的唯一一方，dsh 的 cookie 名是
// `sha256(authority)`（改了 Host 就换一套 cookie 名、旧的全失效），所以转发必须由壳注入
// `Cookie`、并且**把响应里的 `set-cookie` 剥掉**——否则 webview 的 jar 与壳的"真值"会漂移，
// 出现"浏览器里能进、壳里 401"这类只有一方认得的会话。
//
// 本文件不直接碰 RN API：fetch 与存储都从端口进来，于是逻辑能在 vitest 里逐条锁死。

import { WITHHELD_RESPONSE_HEADERS } from './http1';
import type { UpstreamRequest, UpstreamResponse } from './local-host';

/** 设备会话 cookie 名（lane 配对写的就是它）。 */
export const SESSION_COOKIE_NAME = 'dsh_mobile_session';

export interface FetchLike {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string | null;
    redirect?: 'manual' | 'follow';
  }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  }>;
}

/** Cookie 属性名：它们不能当 cookie 名（否则畸形头 `Path=/; HttpOnly` 会被误当会话）。 */
const COOKIE_ATTRIBUTES = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority', 'partitioned'];

/** 从一条 `set-cookie` 头里取 `name=value`（剥掉 Path/HttpOnly/SameSite 等属性）。 */
export function parseSetCookie(header: string | null | undefined): { name: string; value: string } | null {
  if (!header) return null;
  const first = header.split(';')[0]?.trim() ?? '';
  const at = first.indexOf('=');
  if (at <= 0) return null;
  const name = first.slice(0, at).trim();
  const value = first.slice(at + 1).trim();
  if (!name || !value) return null;
  // 属性名在前头 = 这条不是合法的 set-cookie（真 cookie 必须以 name=value 开头）。
  if (COOKIE_ATTRIBUTES.includes(name.toLowerCase())) return null;
  return { name, value };
}

export interface SessionExchangeInput {
  /** 远端 authority（`host:port`）。 */
  base: string;
  /** 入口路径（含 token），如 `/pair?token=…`。 */
  entryPath: string;
  fetchImpl: FetchLike;
}

export type SessionExchangeResult =
  | { ok: true; cookie: string }
  | { ok: false; reason: string; status?: number };

/**
 * 用一次性入口地址换取设备会话 cookie（对齐官方 `authenticateWebHost`：要求 3xx + `set-cookie`）。
 *
 * 判据是**有没有 `set-cookie`**，不是状态码——lane 成功回 302、dsh 的 `/?token=` 回 303，两者都是正常形态；
 * 失败则把状态码与入口写进 reason，不让人猜（桌面同款判断，见 `shell_origin/mod.rs` 的注释）。
 */
export async function exchangeForSession(input: SessionExchangeInput): Promise<SessionExchangeResult> {
  const { base, entryPath, fetchImpl } = input;
  const path = entryPath.startsWith('/') ? entryPath : `/${entryPath}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`http://${base}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
  } catch (e) {
    return { ok: false, reason: `请求失败：${String(e)}` };
  }
  const pair = parseSetCookie(res.headers.get('set-cookie'));
  if (!pair) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      /* 读不出就算了，状态码已经够定位 */
    }
    return {
      ok: false,
      status: res.status,
      reason: `HTTP ${res.status} 且无 set-cookie（入口 ${path}）${body ? ` body=${body}` : ''}`,
    };
  }
  return { ok: true, cookie: `${pair.name}=${pair.value}` };
}

export interface UpstreamPortOptions {
  base: string;
  /** 壳持有的会话 cookie（`name=value`）；没有就转发时不带 Cookie。 */
  cookie?: string | null;
  fetchImpl: FetchLike;
}

/** 剥掉不该透给页面的响应头（#151：会话由壳持有）。 */
export function filterResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (WITHHELD_RESPONSE_HEADERS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 造「转发到远端 Host」的端口：注入壳持有的 cookie，剥掉响应里的会话头。
 *
 * 与桌面 `stream_proxy` 的 `/api/*` 分支同一个语义：方法与请求体原样、Host 由 URL 决定、
 * 不带 `Origin`（缺 Origin 时 dsh 的信任栅栏只校验 Host；带上反而可能与 Host 对不上而 403）。
 */
export function createUpstreamPort(opts: UpstreamPortOptions) {
  return async function fetchUpstream(req: UpstreamRequest): Promise<UpstreamResponse> {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    delete headers.origin;
    delete headers.host;
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = await opts.fetchImpl(`http://${opts.base}${req.path}`, {
      method: req.method,
      headers,
      body: req.body ?? null,
      redirect: 'manual',
    });
    const collected: Record<string, string> = {};
    // RN 的 Headers 没有 entries()：按需取我们真正透传的那几个头，避免为了枚举引入平台差异。
    for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'location', 'www-authenticate']) {
      const v = res.headers.get(name);
      if (v) collected[name] = v;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers: filterResponseHeaders(collected), body: buf };
  };
}
