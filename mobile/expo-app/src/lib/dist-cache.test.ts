// #155：dist 持久化缓存的测试（用内存文件端口 + 内存键值存储）。
import { describe, it, expect } from 'vitest';
import { createDistCache, distDirFor, manifestKey, type FilePort } from './dist-cache';
import type { KeyValueStore } from './remote-ports';
import type { FrontendDist } from './frontend-assets';

const enc = (s: string) => new TextEncoder().encode(s);

function memFiles(init: Record<string, string> = {}): FilePort & { dump: () => Record<string, string> } {
  const m = new Map<string, Uint8Array>(Object.entries(init).map(([k, v]) => [k, enc(v)]));
  return {
    read: async (p) => m.get(p) ?? null,
    write: async (p, b) => {
      m.set(p, b);
    },
    remove: async (p) => {
      m.delete(p);
    },
    dump: () => Object.fromEntries([...m.entries()].map(([k, v]) => [k, new TextDecoder().decode(v)])),
  };
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

function dist(version = '0.2.0-rc.2'): FrontendDist {
  return {
    version,
    entry: 'index-5SrrfWpU.js',
    files: new Map([
      ['index.html', enc('<script type="module" src="./assets/index-5SrrfWpU.js"></script>')],
      ['assets/index-5SrrfWpU.js', enc('console.log(1)')],
    ]),
  };
}

describe('dist 缓存：存了能读回，缺东西就不认', () => {
  it('save → load 往返一致（文件与清单都落下）', async () => {
    const files = memFiles();
    const store = memStore();
    const cache = createDistCache({ store, files });

    await cache.save(dist());
    // 文件真的落到目录里（相对路径带版本目录）
    const dumped = files.dump();
    expect(dumped[`${distDirFor('0.2.0-rc.2')}/index.html`]).toContain('index-5SrrfWpU.js');
    expect(store.dump()[manifestKey('0.2.0-rc.2')]).toContain('"entry":"index-5SrrfWpU.js"');

    const back = await cache.load('0.2.0-rc.2');
    expect(back?.entry).toBe('index-5SrrfWpU.js');
    expect(back?.version).toBe('0.2.0-rc.2');
    expect([...(back?.files.keys() ?? [])].sort()).toEqual(['assets/index-5SrrfWpU.js', 'index.html']);
    expect(new TextDecoder().decode(back?.files.get('assets/index-5SrrfWpU.js'))).toBe('console.log(1)');
  });

  it('没有清单 → null（没下载过就是没缓存）', async () => {
    const cache = createDistCache({ store: memStore(), files: memFiles() });
    expect(await cache.load('9.9.9')).toBeNull();
  });

  it('清单坏了 → null（不抛）', async () => {
    const cache = createDistCache({
      store: memStore({ [manifestKey('1.0.0')]: '{不是 JSON' }),
      files: memFiles(),
    });
    expect(await cache.load('1.0.0')).toBeNull();
  });

  it('清单在但缺文件 → null：半个缓存比没缓存更糟（页面会以"本地资产"名义加载残缺产物）', async () => {
    const files = memFiles();
    const store = memStore();
    const cache = createDistCache({ store, files });
    await cache.save(dist());
    await files.remove(`${distDirFor('0.2.0-rc.2')}/assets/index-5SrrfWpU.js`);
    expect(await cache.load('0.2.0-rc.2')).toBeNull();
  });

  it('clear 删文件并把清单键清空（之后 load 为 null）', async () => {
    const files = memFiles();
    const store = memStore();
    const cache = createDistCache({ store, files });
    await cache.save(dist());
    await cache.clear('0.2.0-rc.2');
    expect(files.dump()[`${distDirFor('0.2.0-rc.2')}/index.html`]).toBeUndefined();
    expect(store.dump()[manifestKey('0.2.0-rc.2')]).toBe('');
    expect(await cache.load('0.2.0-rc.2')).toBeNull();
  });

  it('不同版本的缓存互不干扰（并存多份产物）', async () => {
    const files = memFiles();
    const store = memStore();
    const cache = createDistCache({ store, files });
    await cache.save(dist('0.2.0-rc.2'));
    await cache.save(dist('0.1.7-rc.2'));
    expect((await cache.load('0.2.0-rc.2'))?.version).toBe('0.2.0-rc.2');
    expect((await cache.load('0.1.7-rc.2'))?.version).toBe('0.1.7-rc.2');
    await cache.clear('0.2.0-rc.2');
    expect(await cache.load('0.2.0-rc.2')).toBeNull();
    expect((await cache.load('0.1.7-rc.2'))?.version).toBe('0.1.7-rc.2');
  });
});
