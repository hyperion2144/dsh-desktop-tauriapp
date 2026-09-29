// #155：会话控制器（状态转移）测试——什么时候能进页面、什么时候弹三选一、失败往哪退。
import { describe, it, expect } from 'vitest';
import { createSessionController } from './remote-controller';
import type { RemoteSessionPorts } from './remote-session';
import type { FrontendDist } from './frontend-assets';

const MATCH_HTML = '<script type="module" src="./assets/index-5SrrfWpU.js"></script>';
const OTHER_HTML = '<script type="module" src="./assets/index-OTHER.js"></script>';

function dist(version: string, entry: string): FrontendDist {
  return { version, entry, files: new Map() };
}

function ports(overrides: Partial<RemoteSessionPorts> = {}): RemoteSessionPorts {
  return {
    base: '192.168.3.90:3092',
    entryPath: '/pair?token=T',
    cookie: null,
    exchange: async () => ({ ok: true, cookie: 'dsh_mobile_session=tok9' }),
    fetchRemoteHtml: async () => ({ ok: true, html: MATCH_HTML }),
    localDists: [{ id: '0.2.0-rc.2', entry: 'index-5SrrfWpU.js', files: ['assets/index-5SrrfWpU.js'] } as never],
    download: async () => ({ ok: true, dist: dist('0.2.0-rc.2', 'index-5SrrfWpU.js') }),
    readDistFile: async () => new Uint8Array([1]),
    bundledPluginSource: '/* layout */',
    pluginRev: 'r1',
    startHost: async () => ({ port: 4321, url: 'http://127.0.0.1:4321/', stop: async () => {} }),
    ...overrides,
  };
}

const deps = (overrides: Partial<RemoteSessionPorts> = {}) => ({
  ports: ports(overrides),
  fallbackUrl: 'http://192.168.3.90:3092/',
});

describe('会话控制器', () => {
  it('命中产物 → ready，并给出壳内 origin 与产物资讯', async () => {
    const c = createSessionController(deps());
    const s = await c.start();
    expect(s.phase).toBe('ready');
    expect(s.url).toBe('http://127.0.0.1:4321/');
    expect(s.version).toBe('0.2.0-rc.2');
    expect(s.entry).toBe('index-5SrrfWpU.js');
    expect(s.gate).toBeNull();
  });

  it('缺产物 → gate（带原因，UI 直接显示）', async () => {
    const c = createSessionController(deps({ fetchRemoteHtml: async () => ({ ok: true, html: OTHER_HTML }) }));
    const s = await c.start();
    expect(s.phase).toBe('gate');
    expect(s.gate?.kind).toBe('missing');
    expect(s.reason).toContain('index-OTHER.js');
    expect(s.url).toBeNull(); // 没就绪就不该给地址
  });

  it('三选一：remoteWebview → fallback（用远端地址）', async () => {
    const c = createSessionController(deps({ fetchRemoteHtml: async () => ({ ok: true, html: OTHER_HTML }) }));
    await c.start();
    const s = await c.choose('remoteWebview');
    expect(s.phase).toBe('fallback');
    expect(s.url).toBe('http://192.168.3.90:3092/');
    expect(s.reason).toContain('直接打开远程页面');
  });

  it('三选一：download → 下载后重比命中 → ready', async () => {
    const c = createSessionController(
      deps({
        fetchRemoteHtml: async () => ({ ok: true, html: OTHER_HTML }),
        localDists: [],
        download: async () => ({ ok: true, dist: dist('9.9.9', 'index-OTHER.js') }),
      }),
    );
    await c.start();
    const s = await c.choose('download');
    expect(s.phase).toBe('ready');
    expect(s.version).toBe('9.9.9');
  });

  it('端口抛错 → error（不静默停在 working）', async () => {
    const c = createSessionController(
      deps({
        fetchRemoteHtml: async () => {
          throw new Error('socket exploded');
        },
      }),
    );
    const s = await c.start();
    expect(s.phase).toBe('error');
    expect(s.reason).toContain('socket exploded');
  });

  it('订阅者拿到状态变化；单个订阅者抛错不影响其他人（日志行也会推快照，UI 要按需去重）', async () => {
    const c = createSessionController(deps());
    const seen: string[] = [];
    c.subscribe(() => {
      throw new Error('bad subscriber');
    });
    c.subscribe((s) => seen.push(s.phase));
    await c.start();
    // 相位只可能是 working → ready；但日志行也会各推一次快照，所以次数可能多于两次。
    expect(seen[0]).toBe('working');
    expect(seen[seen.length - 1]).toBe('ready');
    expect([...new Set(seen)]).toEqual(['working', 'ready']);
  });

  it('端口的日志进状态（真机上这是唯一的诊断面）', async () => {
    const c = createSessionController(
      deps({
        exchange: async () => ({ ok: false, reason: 'HTTP 403 且无 set-cookie' }),
      }),
    );
    const s = await c.start();
    expect(s.logs.join('\n')).toContain('换取会话失败');
    // 换取失败不挡路：仍然走到了 ready
    expect(s.phase).toBe('ready');
  });

  it('getState 与最后一次状态一致（订阅之外也能同步读）', async () => {
    const c = createSessionController(deps());
    await c.start();
    expect(c.getState().phase).toBe('ready');
    expect(c.getState()).toEqual(expect.objectContaining({ url: 'http://127.0.0.1:4321/' }));
  });
});
