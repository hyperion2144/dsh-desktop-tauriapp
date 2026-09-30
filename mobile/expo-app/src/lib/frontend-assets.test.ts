// #155：前端 dist 的获取与解包（npm → .tgz → gzip → tar → dist）测试。
//
// tar/gzip 都由测试**现造**（fflate 的 gzipSync + 手写 ustar 头），于是解包路径是真的在跑，
// 而不是把解析器 mock 掉自证。
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'fflate';
import {
  pickVersion,
  tarballUrl,
  parseTar,
  distFromTarball,
  downloadFrontendDist,
  type FetchBytes,
} from './frontend-assets';

const enc = (s: string) => new TextEncoder().encode(s);

/** 造一个 ustar 归档（只写常规文件，512 对齐 + 结尾两个零块）。 */
function makeTar(files: Array<{ name: string; body: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    const body = enc(f.body);
    const header = new Uint8Array(512);
    header.set(enc(f.name).subarray(0, 100), 0);
    // 权限 0000644、uid/gid 0、size（八进制，12 字节含结尾 NUL）、mtime 0、type '0'、magic ustar
    header.set(enc('0000644\0'), 100);
    header.set(enc('0000000\0'), 108);
    header.set(enc('0000000\0'), 116);
    header.set(enc(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
    header.set(enc('00000000000\0'), 136);
    header[156] = '0'.charCodeAt(0);
    header.set(enc('ustar\0'), 257);
    header.set(enc('00'), 263);
    // 校验和：先按空格算，再写回
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    header.set(enc(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body, 0);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // 两个零块 = 结束
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

const INDEX_HTML = '<!doctype html><html><head><base href="./"><script type="module" src="./assets/index-abc123.js"></script></head><body></body></html>';

function makeTgz(files: Array<{ name: string; body: string }>): Uint8Array {
  return gzipSync(makeTar(files), { level: 1 });
}

function fakeFetch(map: Map<string, { status: number; body: string | Uint8Array }>): FetchBytes {
  return async (url: string) => {
    const hit = map.get(url);
    if (!hit) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
    const bytes = typeof hit.body === 'string' ? enc(hit.body) : hit.body;
    return {
      status: hit.status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => (typeof hit.body === 'string' ? hit.body : new TextDecoder().decode(bytes)),
    };
  };
}

describe('pickVersion', () => {
  it('优先 next（桌面内置运行时跟的就是这条渠道），再 latest/alpha，最后任意 tag', () => {
    expect(pickVersion({ next: '0.2.0-rc.2', latest: '0.1.7-rc.2' })).toBe('0.2.0-rc.2');
    expect(pickVersion({ latest: '0.1.7-rc.2' })).toBe('0.1.7-rc.2');
    expect(pickVersion({ alpha: '0.1.7-alpha.2' })).toBe('0.1.7-alpha.2');
    expect(pickVersion({ custom: '9.9.9' })).toBe('9.9.9');
    expect(pickVersion({ next: '  ' })).toBeNull();
    expect(pickVersion(null)).toBeNull();
  });
});

describe('tarballUrl', () => {
  it('scoped 包的 tarball 地址（@scope/name → name-<ver>.tgz）', () => {
    expect(tarballUrl('0.2.0-rc.2')).toBe(
      'https://registry.npmjs.org/@deepseek-ai/dsh-web-frontend/-/dsh-web-frontend-0.2.0-rc.2.tgz',
    );
    expect(tarballUrl('1.0.0', 'https://mirror.example/', '@a/b')).toBe('https://mirror.example/@a/b/-/b-1.0.0.tgz');
  });
});

describe('parseTar', () => {
  it('读出常规文件、按 512 对齐跳过填充、遇零块结束', () => {
    const tar = makeTar([
      { name: 'package/dist/index.html', body: INDEX_HTML },
      { name: 'package/package.json', body: '{"name":"x"}' },
    ]);
    const entries = parseTar(tar);
    expect(entries.map((e) => e.name)).toEqual(['package/dist/index.html', 'package/package.json']);
    expect(new TextDecoder().decode(entries[1].bytes)).toBe('{"name":"x"}');
  });

  it('空归档 → 空数组', () => {
    expect(parseTar(new Uint8Array(1024))).toEqual([]);
  });
});

describe('distFromTarball', () => {
  it('只取 package/dist/**（路径去前缀），并从 index.html 认出入口产物名', () => {
    const tgz = makeTgz([
      { name: 'package/package.json', body: '{"name":"@deepseek-ai/dsh-web-frontend"}' },
      { name: 'package/dist/index.html', body: INDEX_HTML },
      { name: 'package/dist/assets/index-abc123.js', body: 'console.log(1)' },
      { name: 'package/dist/assets/vendor-x.css', body: 'a{}' },
    ]);
    const dist = distFromTarball(tgz, '0.2.0-rc.2');
    expect(dist).not.toBeNull();
    expect(dist?.entry).toBe('index-abc123.js');
    expect(dist?.version).toBe('0.2.0-rc.2');
    expect([...(dist?.files.keys() ?? [])].sort()).toEqual([
      'assets/index-abc123.js',
      'assets/vendor-x.css',
      'index.html',
    ]);
    // dist 之外的东西不进来（package.json 不该被当成静态资产）
    expect(dist?.files.has('package.json')).toBe(false);
  });

  it('缺 dist/index.html 或没有入口产物 → null（不把坏包当成可用本地资产）', () => {
    expect(distFromTarball(makeTgz([{ name: 'package/dist/a.js', body: 'x' }]), '1')).toBeNull();
    expect(distFromTarball(makeTgz([{ name: 'package/dist/index.html', body: '<html></html>' }]), '1')).toBeNull();
  });

  it('不是 gzip → null（不抛）', () => {
    expect(distFromTarball(enc('not a gzip'), '1')).toBeNull();
  });
});

describe('downloadFrontendDist', () => {
  const tgzBody = makeTgz([
    { name: 'package/dist/index.html', body: INDEX_HTML },
    { name: 'package/dist/assets/index-abc123.js', body: 'x' },
  ]);

  it('查 dist-tags → 下包 → 解出 dist（next 优先）', async () => {
    const map = new Map<string, { status: number; body: string | Uint8Array }>([
      ['https://registry.npmjs.org/@deepseek-ai/dsh-web-frontend', { status: 200, body: '{"dist-tags":{"next":"0.2.0-rc.2","latest":"0.1.7-rc.2"}}' }],
      [tarballUrl('0.2.0-rc.2'), { status: 200, body: tgzBody }],
    ]);
    const out = await downloadFrontendDist({ fetchBytes: fakeFetch(map) });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.dist.version).toBe('0.2.0-rc.2');
    expect(out.dist.entry).toBe('index-abc123.js');
  });

  it('指定版本时跳过元数据查询', async () => {
    const map = new Map<string, { status: number; body: string | Uint8Array }>([
      [tarballUrl('0.1.7-rc.2'), { status: 200, body: tgzBody }],
    ]);
    const out = await downloadFrontendDist({ fetchBytes: fakeFetch(map), version: '0.1.7-rc.2' });
    expect(out.ok && out.dist.version).toBe('0.1.7-rc.2');
  });

  it('元数据失败 / 下载失败 / 包坏了 → 都带明确 reason', async () => {
    const meta500 = await downloadFrontendDist({
      fetchBytes: fakeFetch(new Map([['https://registry.npmjs.org/@deepseek-ai/dsh-web-frontend', { status: 500, body: '' }]])),
    });
    expect(meta500.ok).toBe(false);
    if (!meta500.ok) expect(meta500.reason).toContain('HTTP 500');

    const noTarball = await downloadFrontendDist({
      fetchBytes: fakeFetch(new Map([['https://registry.npmjs.org/@deepseek-ai/dsh-web-frontend', { status: 200, body: '{"dist-tags":{"next":"9.9.9"}}' }]])),
    });
    expect(noTarball.ok).toBe(false);
    if (!noTarball.ok) expect(noTarball.reason).toContain('HTTP 404');

    const bad = await downloadFrontendDist({
      fetchBytes: fakeFetch(new Map([[tarballUrl('9.9.9'), { status: 200, body: 'not gzip' }]])),
      version: '9.9.9',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('解不出前端 dist');
  });
});
