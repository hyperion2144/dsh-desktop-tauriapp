// 前端 dist 的持久化缓存（#155）：解包结果落盘，冷启动不必再下几 MB。
//
// 为什么拆成「清单 + 文件端口」：
//   清单（版本 / 入口产物名 / 文件列表 / 目录）很小，进键值存储；
//   文件本体（几 MB）必须走文件系统，而 RN 侧的文件 API 是**注入的端口**——
//   于是这层能在 node 里用假文件端口逐条测，真机上只换一个适配器（expo-file-system）。
//
// 一条硬规矩：**清单与文件必须同时齐全才认这份缓存**。缺一个文件就当缓存不存在（返回 null），
// 让上层重新下载——半个缓存比没有缓存更糟（页面会以"本地资产"的名义加载残缺产物）。

import type { FrontendDist } from './frontend-assets';
import type { KeyValueStore } from './remote-ports';

/** 文件端口（真机 = expo-file-system；测试 = 内存 Map）。 */
export interface FilePort {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

/** 缓存根目录（相对 App 沙箱）。 */
export function distDirFor(version: string): string {
  return `dsh-frontend/${version}`;
}

/** 清单的存储键（按版本分开，便于将来并存多份产物）。 */
export function manifestKey(version: string): string {
  return `dsh-frontend-manifest:${version}`;
}

interface Manifest {
  version: string;
  entry: string;
  files: string[];
  dir: string;
}

export interface DistCache {
  /** 读回缓存（清单 + 全部文件齐全才算命中）。 */
  load(version: string): Promise<FrontendDist | null>;
  /** 落盘（先写文件，最后写清单——清单存在即代表整份可用）。 */
  save(dist: FrontendDist): Promise<void>;
  /** 清掉某一份（卸载/换版本时用）。 */
  clear(version: string): Promise<void>;
}

export function createDistCache(deps: { store: KeyValueStore; files: FilePort }): DistCache {
  return {
    async load(version: string) {
      const raw = await deps.store.getItem(manifestKey(version));
      if (!raw) return null;
      let manifest: Manifest;
      try {
        manifest = JSON.parse(raw) as Manifest;
      } catch {
        return null; // 清单坏了：当没有缓存
      }
      if (!manifest?.dir || !manifest.entry || !Array.isArray(manifest.files) || manifest.files.length === 0) {
        return null;
      }
      const files = new Map<string, Uint8Array>();
      for (const rel of manifest.files) {
        const bytes = await deps.files.read(`${manifest.dir}/${rel}`);
        if (!bytes) return null; // 缺文件：整份不认（见文件头注释）
        files.set(rel, bytes);
      }
      return { version: manifest.version, entry: manifest.entry, files };
    },

    async save(dist: FrontendDist) {
      const dir = distDirFor(dist.version);
      const files: string[] = [];
      for (const [rel, bytes] of dist.files.entries()) {
        await deps.files.write(`${dir}/${rel}`, bytes);
        files.push(rel);
      }
      const manifest: Manifest = { version: dist.version, entry: dist.entry, files, dir };
      // 清单最后写：它的存在等价于"这份缓存完整"。
      await deps.store.setItem(manifestKey(dist.version), JSON.stringify(manifest));
    },

    async clear(version: string) {
      const raw = await deps.store.getItem(manifestKey(version));
      if (raw) {
        try {
          const manifest = JSON.parse(raw) as Manifest;
          for (const rel of manifest.files ?? []) await deps.files.remove(`${manifest.dir}/${rel}`);
        } catch {
          /* 清单坏了也要把键删掉 */
        }
      }
      await deps.store.setItem(manifestKey(version), '');
    },
  };
}
