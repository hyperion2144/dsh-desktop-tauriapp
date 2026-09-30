// #155：远程会话端口的真实实现测试（fetch / 存储 / 缓存都接上，用假 fetch 与内存存储）。
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'fflate';
import { createRemotePorts, cookieKey, type KeyValueStore } from './remote-ports';
import { tarballUrl, type FetchBytes } from './frontend-assets';
import type { FetchLike } from './session';

const enc = (s: string) => new TextEncoder().encode(s);
const INDEX_HTML = '<script type="module" src="./assets/index-abc.js"></script>';

/** 极简 ustar 打包（只为造一份可解的前端包）。 */
function makeTgz(files: Array<{ name: string; body: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    const body = enc(f.body);
    const h = new Uint8Array(512);
    h.set(enc(f.name).subarray(0, 100), 0);
    h.set(enc('0000644\0'), 100);
    h.set(enc('0000000\0'), 108);
    h.set(enc('0000000\0'), 116);
    h.set(enc(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
    h.set(enc('00000000000\0'), 136);
    h[156] = '0'.charCodeAt(0);
    h.set(enc('ustar\0'), 257);
    h.set(enc('00'), 263);
    blocks.push(h);
    const pad = new Uint8Array(Math.ceil(body.length / 512) * 512);
    pad.set(body, 0);
    blocks.push(pad);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return gzipSync(out, { level: 1 });
}

function memStore(init: Record<string, string> = {}): KeyValueStore & { dump: () => Record<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    dump: () => Object.fromEntries(m),
  };
}

/** 假网络：按 URL 分发（元数据 / tarball / 远端首页 / pair）。 */
function net(routes: Record<string, { status: number; body: string | Uint8Array }>): FetchLike & FetchBytes {
  return (async (url: string) => {
    const hit = routes[url];
    const body = hit ? hit.body : '';
    const bytes = typeof body === 'string' ? enc(body) : body;
    return {
      status: hit ? hit.status : 404,
      headers: { get: () => null },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(bytes)),
    };
  }) as unknown as FetchLike & FetchBytes;
}

describe('cookieKey', () => {
  it('按远端 authority 分开存（一台手机可能配多个桌面）', () => {
    expect(cookieKey('192.168.3.90:3092')).toBe('dsh-mobile-session:192.168.3.90:3092');
  });
});

describe('createRemotePorts', () => {
  it('把已存的会话 cookie 读出来并挂到端口上', async () => {
    const store = memStore({ [cookieKey('h:1')]: 'dsh_mobile_session=old' });
    const ports = await createRemotePorts({ base: 'h:1', store, fetchImpl: net({}) });
    expect(ports.cookie).toBe('dsh_mobile_session=old');
  });

  it('exchange 成功后把 cookie 落库（下次启动不必再消费一次性链接）', async () => {
    const store = memStore();
    const ports = await createRemotePorts({
      base: 'h:1',
      entryPath: '/pair?token=T',
      store,
      fetchImpl: (async (url: string) => ({
        status: 302,
        headers: { get: (n: string) => (n.toLowerCase() === 'set-cookie' ? 'dsh_mobile_session=new; Path=/' : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
      })) as unknown as FetchLike & FetchBytes,
    });
    const res = await ports.exchange?.('h:1', '/pair?token=T');
    expect(res).toEqual({ ok: true, cookie: 'dsh_mobile_session=new' });
    expect(store.dump()[cookieKey('h:1')]).toBe('dsh_mobile_session=new');
  });

  it('fetchRemoteHtml：200 回 HTML；非 2xx 回明确 reason（不把错误页当页面）', async () => {
    const ok = await createRemotePorts({
      base: 'h:1',
      store: memStore(),
      fetchImpl: net({ 'http://h:1/': { status: 200, body: INDEX_HTML } }),
    });
    expect(await ok.fetchRemoteHtml()).toEqual({ ok: true, html: INDEX_HTML });

    const bad = await createRemotePorts({
      base: 'h:1',
      store: memStore(),
      fetchImpl: net({ 'http://h:1/': { status: 500, body: 'boom' } }),
    });
    const out = await bad.fetchRemoteHtml();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('500');
  });

  it('没有缓存 dist 时 localDists 为空；下载后清单与版本一起可查', async () => {
    const version = '0.2.0-rc.2';
    const tgz = makeTgz([
      { name: 'package/dist/index.html', body: INDEX_HTML },
      { name: 'package/dist/assets/index-abc.js', body: 'x' },
    ]);
    let downloaded: string | null = null;
    const ports = await createRemotePorts({
      base: 'h:1',
      store: memStore(),
      fetchImpl: net({
        'https://registry.npmjs.org/@deepseek-ai/dsh-web-frontend': { status: 200, body: `{"dist-tags":{"next":"${version}"}}` },
        [tarballUrl(version)]: { status: 200, body: tgz },
      }),
      onDistDownloaded: (d) => {
        downloaded = d.version;
      },
    });
    expect(ports.localDists).toEqual([]);

    const dl = await ports.download();
    expect(dl.ok).toBe(true);
    expect(downloaded).toBe(version);
    // 清单与版本同行（编排靠这个起服务）
    expect(ports.localDists).toEqual([
      { id: version, entry: 'index-abc.js', files: ['index.html', 'assets/index-abc.js'] },
    ]);
    // 文件读得出来（本地资产由壳内服务直接应答）
    const bytes = await ports.readDistFile('assets/index-abc.js');
    expect(bytes && new TextDecoder().decode(bytes)).toBe('x');
    expect(await ports.readDistFile('nope.js')).toBeNull();
  });

  it('传入已缓存的 dist 时直接可用（不必再下载）', async () => {
    const files = new Map<string, Uint8Array>([['index.html', enc(INDEX_HTML)]]);
    const ports = await createRemotePorts({
      base: 'h:1',
      store: memStore(),
      fetchImpl: net({}),
      cachedDist: { version: '9.9.9', entry: 'index-abc.js', files },
    });
    expect(ports.localDists).toEqual([{ id: '9.9.9', entry: 'index-abc.js', files: ['index.html'] }]);
  });
});
