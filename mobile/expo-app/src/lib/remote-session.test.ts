// #155：远程会话编排（状态机）测试——这条链最容易错的是"哪一步失败该走哪条路"。
import { describe, it, expect } from 'vitest';
import { openRemoteSession, continueRemoteSession, type RemoteSessionPorts } from './remote-session';
import type { FrontendDist } from './frontend-assets';

const REMOTE_HTML_MATCH = '<script type="module" src="./assets/index-5SrrfWpU.js"></script>';
const REMOTE_HTML_OTHER = '<script type="module" src="./assets/index-OTHER.js"></script>';

function dist(version: string, entry: string): FrontendDist {
  return { version, entry, files: new Map() };
}

function ports(overrides: Partial<RemoteSessionPorts> = {}): {
  ports: RemoteSessionPorts;
  hosts: Array<{ distFiles: string[]; bundled: string[] }>;
} {
  const hosts: Array<{ distFiles: string[]; bundled: string[] }> = [];
  const base: RemoteSessionPorts = {
    base: '192.168.3.90:3092',
    entryPath: '/pair?token=T',
    cookie: null,
    exchange: async () => ({ ok: true, cookie: 'dsh_mobile_session=tok9' }),
    fetchRemoteHtml: async () => ({ ok: true, html: REMOTE_HTML_MATCH }),
    localDists: [{ id: '0.2.0-rc.2', entry: 'index-5SrrfWpU.js', files: ['assets/index-5SrrfWpU.js', 'index.html'] } as never],
    download: async () => ({ ok: true, dist: dist('0.2.0-rc.2', 'index-5SrrfWpU.js') }),
    readDistFile: async () => new Uint8Array([1]),
    bundledPluginSource: '/* layout */',
    pluginRev: 'r1',
    startHost: async (opts) => {
      hosts.push({
        distFiles: [...(opts.distFiles as string[])],
        bundled: Object.keys(opts.bundledPlugins ?? {}),
      });
      return { port: 4321, url: 'http://127.0.0.1:4321/', stop: async () => {} };
    },
    ...overrides,
  };
  return { ports: base, hosts };
}

describe('openRemoteSession', () => {
  it('命中本地产物 → 起壳内服务并返回 settled（带会话 cookie 与产物资讯）', async () => {
    const { ports: p, hosts } = ports();
    const out = await openRemoteSession(p);
    expect(out.kind).toBe('settled');
    if (out.kind !== 'settled') return;
    expect(out.url).toBe('http://127.0.0.1:4321/');
    expect(out.cookie).toBe('dsh_mobile_session=tok9');
    expect(out.version).toBe('0.2.0-rc.2');
    expect(out.entry).toBe('index-5SrrfWpU.js');
    // 起服务时带上了当前生效产物的文件清单与随包插件
    expect(hosts).toHaveLength(1);
    expect(hosts[0].distFiles).toContain('assets/index-5SrrfWpU.js');
    expect(hosts[0].bundled).toEqual(['dsh-web-mobile']);
  });

  it('换取会话失败不中止：照常比版本并 settled（cookie 为 null）', async () => {
    const logs: string[] = [];
    const { ports: p } = ports({
      exchange: async () => ({ ok: false, reason: 'HTTP 403 且无 set-cookie' }),
      onLog: (l) => logs.push(l),
    });
    const out = await openRemoteSession(p);
    expect(out.kind).toBe('settled');
    if (out.kind === 'settled') expect(out.cookie).toBeNull();
    expect(logs.join('\n')).toContain('换取会话失败');
  });

  it('本地没有对应产物 → gate-required（由 UI 去问，不在这里弹窗）', async () => {
    const { ports: p, hosts } = ports({ fetchRemoteHtml: async () => ({ ok: true, html: REMOTE_HTML_OTHER }) });
    const out = await openRemoteSession(p);
    expect(out.kind).toBe('gate-required');
    if (out.kind !== 'gate-required') return;
    expect(out.gate?.kind).toBe('missing');
    expect(hosts).toHaveLength(0); // 没起服务
  });

  it('取不到远端首页 → gate-required(unavailable)（不是"缺产物"）', async () => {
    const { ports: p } = ports({ fetchRemoteHtml: async () => ({ ok: false, reason: 'HTTP 502' }) });
    const out = await openRemoteSession(p);
    expect(out.kind).toBe('gate-required');
    if (out.kind !== 'gate-required') return;
    expect(out.gate?.kind).toBe('unavailable');
  });
});

describe('continueRemoteSession', () => {
  it('download：下载后重比命中 → settled（用下载到的那份）', async () => {
    const { ports: p, hosts } = ports({
      fetchRemoteHtml: async () => ({ ok: true, html: REMOTE_HTML_OTHER }),
      localDists: [],
      download: async () => ({ ok: true, dist: dist('9.9.9', 'index-OTHER.js') }),
    });
    const out = await continueRemoteSession(p, 'download');
    expect(out.kind).toBe('settled');
    if (out.kind === 'settled') expect(out.version).toBe('9.9.9');
    expect(hosts[0].bundled).toEqual(['dsh-web-mobile']);
  });

  it('download：下载完仍不匹配 → 再问一次（gate-required）', async () => {
    const { ports: p } = ports({
      fetchRemoteHtml: async () => ({ ok: true, html: REMOTE_HTML_OTHER }),
      localDists: [],
      download: async () => ({ ok: true, dist: dist('1.0.0', 'index-YET-ANOTHER.js') }),
    });
    const out = await continueRemoteSession(p, 'download');
    expect(out.kind).toBe('gate-required');
  });

  it('download 失败 → 也是三选一（不静默回退），原因写清楚', async () => {
    const { ports: p } = ports({ download: async () => ({ ok: false, reason: 'HTTP 404' }) });
    const out = await continueRemoteSession(p, 'download');
    expect(out.kind).toBe('gate-required');
    if (out.kind !== 'gate-required') return;
    expect(out.gate).toBeNull();
    expect(out.reason).toContain('HTTP 404');

  });

  it('remoteWebview：直接回退（最保守那条路永远可用）', async () => {
    const { ports: p, hosts } = ports();
    const out = await continueRemoteSession(p, 'remoteWebview');
    expect(out).toEqual({ kind: 'fallback', url: 'http://192.168.3.90:3092/', reason: '用户选择直接打开远程页面' });
    expect(hosts).toHaveLength(0);
  });

  it('useLocal：用现有默认产物（版本可能不一致，由调用方提示）', async () => {
    const { ports: p, hosts } = ports();
    const out = await continueRemoteSession(p, 'useLocal');
    expect(out.kind).toBe('settled');
    if (out.kind === 'settled') expect(out.version).toBe('0.2.0-rc.2');
    expect(hosts).toHaveLength(1);
  });

  it('useLocal 但本地一份都没有 → 仍是三选一（不假装能本地出，也不静默开远程）', async () => {
    const { ports: p } = ports({ localDists: [] });
    const out = await continueRemoteSession(p, 'useLocal');
    expect(out.kind).toBe('gate-required');
    if (out.kind !== 'gate-required') return;
    expect(out.reason).toContain('没有任何可用产物');

  });
});
