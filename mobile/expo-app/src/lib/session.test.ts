// #155：会话由壳持有（#151）——换 cookie / 转发注入 / 剥 set-cookie 的测试。
import { describe, it, expect } from 'vitest';
import {
  parseSetCookie,
  exchangeForSession,
  filterResponseHeaders,
  createUpstreamPort,
  SESSION_COOKIE_NAME,
  type FetchLike,
} from './session';

function fakeResponse(
  status: number,
  headers: Record<string, string> = {},
  body = '',
): Awaited<ReturnType<FetchLike>> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    text: async () => body,
  };
}

describe('parseSetCookie', () => {
  it('取 name=value，剥掉 Path/HttpOnly/SameSite 等属性', () => {
    expect(parseSetCookie('dsh_mobile_session=abc123; Path=/; HttpOnly; SameSite=Lax')).toEqual({
      name: 'dsh_mobile_session',
      value: 'abc123',
    });
  });

  it('空/畸形/无值 → null', () => {
    expect(parseSetCookie(null)).toBeNull();
    expect(parseSetCookie('')).toBeNull();
    expect(parseSetCookie('Path=/; HttpOnly')).toBeNull();
    expect(parseSetCookie('=abc')).toBeNull();
    expect(parseSetCookie('name=')).toBeNull();
  });
});

describe('exchangeForSession', () => {
  it('3xx + set-cookie → 拿到会话 cookie（判据是有没有 set-cookie，不是状态码）', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return fakeResponse(302, { 'set-cookie': `${SESSION_COOKIE_NAME}=tok9; Path=/; SameSite=Lax` }, '');
    };
    const out = await exchangeForSession({ base: '192.168.3.90:3092', entryPath: '/pair?token=T', fetchImpl });
    expect(out).toEqual({ ok: true, cookie: `${SESSION_COOKIE_NAME}=tok9` });
    expect(calls).toEqual(['GET http://192.168.3.90:3092/pair?token=T']);
  });

  it('没有 set-cookie → 失败并把状态码/入口/片段 body 记进 reason（不让人猜）', async () => {
    const fetchImpl: FetchLike = async () => fakeResponse(403, {}, '{"error":"invalid-token"}');
    const out = await exchangeForSession({ base: 'h:1', entryPath: '/pair?token=X', fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(403);
    expect(out.reason).toContain('403');
    expect(out.reason).toContain('/pair?token=X');
    expect(out.reason).toContain('invalid-token');
  });

  it('入口路径没带前导斜杠也能拼对', async () => {
    let seen = '';
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return fakeResponse(303, { 'set-cookie': 'a=b' });
    };
    await exchangeForSession({ base: 'h:1', entryPath: 'pair?token=Y', fetchImpl });
    expect(seen).toBe('http://h:1/pair?token=Y');
  });

  it('请求抛错 → 明确 reason（远程不可达不该静默）', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };
    const out = await exchangeForSession({ base: 'h:1', entryPath: '/', fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('network down');
  });
});

describe('filterResponseHeaders', () => {
  it('剥掉 set-cookie 与逐跳/长度头，其余保留', () => {
    const out = filterResponseHeaders({
      'set-cookie': 'x=y',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'content-length': '12',
      'content-type': 'application/json',
      etag: 'W/"1"',
    });
    expect(out).toEqual({ 'content-type': 'application/json', etag: 'W/"1"' });
  });
});

describe('createUpstreamPort', () => {
  it('注入壳持有的 cookie；丢掉进来的 origin/host（dsh 的信任栅栏只认 Host，不给自己造不一致）', async () => {
    let seenUrl = '';
    let seenInit: { method?: string; headers?: Record<string, string>; body?: unknown } = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenInit = init ?? {};
      return fakeResponse(200, { 'content-type': 'application/json' }, '{"ok":true}');
    };
    const up = createUpstreamPort({ base: '192.168.3.90:3092', cookie: 'dsh_mobile_session=tok9', fetchImpl });
    const res = await up({
      method: 'POST',
      path: '/api/x?y=1',
      headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:9999', 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"a":1}'),
    });
    expect(seenUrl).toBe('http://192.168.3.90:3092/api/x?y=1');
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers?.cookie).toBe('dsh_mobile_session=tok9');
    expect(seenInit.headers?.origin).toBeUndefined();
    expect(seenInit.headers?.host).toBeUndefined();
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body as Uint8Array)).toBe('{"ok":true}');
  });

  it('没有会话时不带 Cookie（而不是带个空值）', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_u, init) => {
      headers = init?.headers;
      return fakeResponse(401, { 'www-authenticate': 'cookie' });
    };
    const up = createUpstreamPort({ base: 'h:1', fetchImpl });
    const res = await up({ method: 'GET', path: '/api/x', headers: {} });
    expect(headers?.cookie).toBeUndefined();
    // 认证相关信息仍透传（页面据此提示"需要重新配对"）
    expect(res.headers['www-authenticate']).toBe('cookie');
  });

  it('上游的 set-cookie 不出现在返回头里（会话只活在壳手里）', async () => {
    const fetchImpl: FetchLike = async () => fakeResponse(200, { 'set-cookie': 'a=b', 'content-type': 'text/html' });
    const up = createUpstreamPort({ base: 'h:1', fetchImpl });
    const res = await up({ method: 'GET', path: '/', headers: {} });
    expect(Object.keys(res.headers).some((k) => k.toLowerCase() === 'set-cookie')).toBe(false);
    expect(res.headers['content-type']).toBe('text/html');
  });
});
