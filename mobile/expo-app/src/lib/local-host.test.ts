// #155：手机壳本地资产 handler 的测试。
//
// 夹具（HTML）取自 2026-09-29 从真实 lane 抓的页面片段：lane 补丁 + `<base href="./">` +
// `globalThis["__DSH_BOOT__"] = {…}` + module 入口，形状与真机一致。
import { describe, it, expect } from 'vitest';
import {
  createLocalHostHandler,
  isDocumentPath,
  type LocalHostPorts,
  type UpstreamRequest,
  type UpstreamResponse,
} from './local-host';

const REMOTE_HTML = [
  '<!doctype html><html lang="en"><head>',
  '<script data-dsh-mobile-owns-host="1">!function(){g.__DSH_TRANSPORT__={ownsHost:true}}();</script>',
  '<script data-dsh-mobile-loopback="1">!function(){var P="/_loopback/";}();</script>',
  '<script data-dsh-mobile-polyfill="1">/* polyfill */</script>',
  '<script type="module" src="./assets/index-5SrrfWpU.js"></script>',
  '<base href="./">',
  '<script>globalThis["__DSH_BOOT__"] = {"rev":"a1","entries":[{"id":"@deepseek-ai/dsh-client-ui-open-in-app","url":"plugins/??a/client.js&rev=1","rev":"1"}],"batches":[{"phase":"application","url":"plugins/??a/client.js&rev=1","rev":"1","entries":["@deepseek-ai/dsh-client-ui-open-in-app"]}]}</script>',
  '</head><body><div id="root"></div></body></html>',
].join('');

function ports(overrides: Partial<LocalHostPorts> = {}): { ports: LocalHostPorts; calls: UpstreamRequest[] } {
  const calls: UpstreamRequest[] = [];
  // 显式标注 LocalHostPorts：否则字面量会被推成联合类型，`headers: {}` 那支与接口不兼容。
  const base: LocalHostPorts = {
    remoteBase: '192.168.3.90:3092',
    distFiles: ['assets/index-5SrrfWpU.js', 'assets/vendor-a.js'],
    readDistFile: async (rel: string) => (rel === 'assets/index-5SrrfWpU.js' ? new TextEncoder().encode('console.log(1)') : null),
    bundledPlugins: { 'dsh-web-mobile': '/* layout plugin client */' },
    pluginRev: 'rev9',
    fetchUpstream: async (req: UpstreamRequest): Promise<UpstreamResponse> => {
      calls.push(req);
      if (req.path === '/' && req.method === 'GET') {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: REMOTE_HTML };
      }
      if (req.path === '/boom') {
        return { status: 500, headers: {}, body: 'upstream error' };
      }
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
    },
    ...overrides,
  };
  return { ports: base, calls };
}

describe('isDocumentPath', () => {
  it('只认 / 与 /index.html（含 query）', () => {
    expect(isDocumentPath('/')).toBe(true);
    expect(isDocumentPath('/index.html?x=1')).toBe(true);
    expect(isDocumentPath('/assets/index-a.js')).toBe(false);
  });
});

describe('文档路由：远端 HTML 组装（与桌面远程模式同形）', () => {
  it('剥掉 lane 补丁、增补随包插件、no-store', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'GET', path: '/' });

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = String(res.body);
    // ① lane 的 origin 专用补丁必须剥掉（否则 mux WS 被改坏——桌面踩过）
    expect(body).not.toContain('data-dsh-mobile-owns-host');
    expect(body).not.toContain('data-dsh-mobile-loopback');
    // ② 平台无关的 polyfill 与页面本体保留
    expect(body).toContain('data-dsh-mobile-polyfill');
    expect(body).toContain('index-5SrrfWpU.js');
    expect(body).toContain('<base href="./">');
    // ③ 随包布局插件进了启动图（一行 entry + 独占 batch）
    expect(body).toContain('"id":"dsh-web-mobile"');
    expect(body).toContain('__local-plugins/dsh-web-mobile/client.js?rev=rev9');
    const graph = JSON.parse(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/.exec(body)![1]);
    expect(graph.entries.some((e: { id: string }) => e.id === 'dsh-web-mobile')).toBe(true);
    expect(graph.batches.find((b: { url: string }) => b.url.includes('__local-plugins')).phase).toBe('application');
    // ④ 取远端首页只发了一次 GET /
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/' });
  });

  it('远端失败 → 明确 502，绝不回退成远端整页', async () => {
    const { ports: p } = ports({
      fetchUpstream: async (): Promise<UpstreamResponse> => ({ status: 503, headers: {}, body: 'nope' }),
    });
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'GET', path: '/' });
    expect(res.status).toBe(502);
    expect(String(res.body)).toContain('HTTP 503');
    expect(String(res.body)).not.toContain('<html');
  });

  it('没配随包插件时只剥补丁、不动启动图', async () => {
    const { ports: p } = ports({ bundledPlugins: {} });
    const handle = createLocalHostHandler(p);
    const body = String((await handle({ method: 'GET', path: '/' })).body);
    expect(body).not.toContain('data-dsh-mobile-owns-host');
    expect(body).not.toContain('dsh-web-mobile');
    expect(body).toContain('@deepseek-ai/dsh-client-ui-open-in-app');
  });
});

describe('本地资产：命中才本地出，未命中转发', () => {
  it('命中 dist 清单 → 200 + JS MIME + 长缓存', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'GET', path: '/assets/index-5SrrfWpU.js?v=1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(calls).toHaveLength(0); // 本地出，不碰远端
  });

  it('清单里列了但读不到 → 如实 404，不静默转发', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'GET', path: '/assets/vendor-a.js' });
    expect(res.status).toBe(404);
    expect(String(res.body)).toContain('本地资产缺失');
    expect(calls).toHaveLength(0);
  });

  it('不在清单里（远程构建对不上）→ 转发远端', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'GET', path: '/assets/index-other.js' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/assets/index-other.js');
  });
});

describe('随包插件：Host 没装时的唯一来源', () => {
  it('/__local-plugins/<id>/client.js → 包内内容', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'GET', path: '/__local-plugins/dsh-web-mobile/client.js?rev=rev9' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(String(res.body)).toBe('/* layout plugin client */');
    expect(calls).toHaveLength(0);
  });

  it('未随包的插件 id → 404（不转发，避免把本地前缀当 Host 路由）', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'GET', path: '/__local-plugins/not-bundled/client.js' });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('转发面：方法/路径/请求体透传，响应原样回', () => {
  it('POST /api/x 带 body', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const body = new TextEncoder().encode('{"a":1}');
    const res = await handle({ method: 'POST', path: '/api/x', headers: { 'content-type': 'application/json' }, body });
    expect(res.status).toBe(200);
    expect(String(res.body)).toBe('{"ok":true}');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/x' });
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].body).toBe(body);
  });

  it('插件 combo 与 mux 一律转发（数据在 Host）', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    await handle({ method: 'GET', path: '/plugins/??a,b&rev=1' });
    await handle({ method: 'GET', path: '/api/remote.mux' });
    expect(calls.map((c) => c.path)).toEqual(['/plugins/??a,b&rev=1', '/api/remote.mux']);
  });

  it('OPTIONS 本地 204（壳内页面同源，本该没有预检）', async () => {
    const { ports: p, calls } = ports();
    const handle = createLocalHostHandler(p);
    const res = await handle({ method: 'OPTIONS', path: '/api/x' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(calls).toHaveLength(0);
  });
});
