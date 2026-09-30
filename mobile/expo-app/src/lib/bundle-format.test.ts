// #155：随包运行时整包的拆包契约测试（纯逻辑，node 里可跑）。
//
// 夹具与 scripts/sync-builtin.mjs 的真实产物同形：`dsh-frontend/**` + `plugins/dsh-web-mobile/client.js`，
// 用真实 gzip + 手写 ustar 头造出来，因此解包路径是真在跑，不是把解析器 mock 掉自证。
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'fflate';
import { splitBundle, DIST_PREFIX, PLUGIN_PREFIX } from './bundle-format';

const enc = (s: string) => new TextEncoder().encode(s);

function makeTar(files: Array<{ name: string; body: string }>): Uint8Array {
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
  return out;
}

const INDEX_HTML =
  '<!doctype html><html><head><script type="module" src="./assets/index-abc123.js"></script></head><body></body></html>';

function makeBundle(extra: Array<{ name: string; body: string }> = []): Uint8Array {
  return gzipSync(
    makeTar([
      { name: `${DIST_PREFIX}index.html`, body: INDEX_HTML },
      { name: `${DIST_PREFIX}assets/index-abc123.js`, body: 'console.log(1)' },
      { name: `${DIST_PREFIX}assets/index-abc123.css`, body: 'a{}' },
      { name: `${PLUGIN_PREFIX}client.js`, body: '/* layout plugin */' },
      ...extra,
    ]),
    { level: 1 },
  );
}

describe('splitBundle：随包整包 → 本地产物 + 布局插件', () => {
  it('拆出 dist（去前缀、含 index.html）并从 index.html 认入口产物名', () => {
    const out = splitBundle(makeBundle());
    expect(out).not.toBeNull();
    expect(out?.dist.entry).toBe('index-abc123.js');
    // 版本标识 = 入口产物名（与桌面/鸿蒙同一把尺子，用于跟远端比对）
    expect(out?.dist.version).toBe('index-abc123.js');
    expect([...(out?.dist.files.keys() ?? [])].sort()).toEqual([
      'assets/index-abc123.css',
      'assets/index-abc123.js',
      'index.html',
    ]);
    expect(out?.pluginClientJs).toBe('/* layout plugin */');
  });

  it('新增文件不需要改代码：包里多出什么就带出什么', () => {
    const out = splitBundle(makeBundle([{ name: `${DIST_PREFIX}assets/fonts/new.woff2`, body: 'x' }]));
    expect(out?.dist.files.has('assets/fonts/new.woff2')).toBe(true);
  });

  it('没有 index.html 或认不出入口 → null（不拿半个包去起服务）', () => {
    expect(splitBundle(gzipSync(makeTar([{ name: `${DIST_PREFIX}assets/a.js`, body: 'x' }])))).toBeNull();
    expect(
      splitBundle(gzipSync(makeTar([{ name: `${DIST_PREFIX}index.html`, body: '<html></html>' }]))),
    ).toBeNull();
  });

  it('不是 gzip → null（不抛）', () => {
    expect(splitBundle(enc('not a gzip'))).toBeNull();
  });

  it('缺布局插件也能用（Host 自己装了那份就不再需要随包）', () => {
    const out = splitBundle(
      gzipSync(makeTar([{ name: `${DIST_PREFIX}index.html`, body: INDEX_HTML }]), { level: 1 }),
    );
    expect(out?.dist.entry).toBe('index-abc123.js');
    expect(out?.pluginClientJs).toBe('');
  });
});
