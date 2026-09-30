// `expo-file-system` 的 FilePort 适配器（#155）：把 dist 缓存接到 App 沙箱的真实文件系统上。
//
// 为什么单独一个文件：`expo-file-system` 是**原生模块**，只能真机/模拟器加载——测试里用内存
// FilePort 跑 `dist-cache` 的逻辑，这里只做「路径 ↔ File/Directory」的机械翻译，不掺判断。
//
// 路径约定（与 dist-cache 对齐）：`${Paths.document}/dsh-frontend/<version>/<相对路径>`。
import { Directory, File, Paths } from 'expo-file-system';
import { createDistCache, type DistCache, type FilePort } from './dist-cache';
import { appStore } from './use-remote-ports';

/** 缓存根目录名（App 沙箱内）。 */
export const CACHE_ROOT = 'dsh-frontend';

/** 沙箱内路径 → File（父目录由 create({ intermediates: true }) 兜住）。 */
function fileAt(relPath: string): File {
  return new File(Paths.document, relPath);
}

export const expoFilePort: FilePort = {
  async read(relPath: string): Promise<Uint8Array | null> {
    try {
      const f = fileAt(relPath);
      if (!f.exists) return null;
      // 备注：`bytes()` 是异步的（native 读在 IO 线程），大文件也不会卡 UI。
      return await f.bytes();
    } catch {
      // 读失败一律当"没有"——缓存层会把整份缓存判为不可用（见 dist-cache 的硬规矩）。
      return null;
    }
  },

  async write(relPath: string, bytes: Uint8Array): Promise<void> {
    const f = fileAt(relPath);
    // intermediates 让 `assets/` 这类中间目录自动建出来；overwrite 让重复下载安全覆盖。
    f.create({ intermediates: true, overwrite: true });
    f.write(bytes);
  },

  async remove(relPath: string): Promise<void> {
    try {
      const f = fileAt(relPath);
      if (f.exists) f.delete();
    } catch {
      /* 已经不在就当删过 */
    }
  },
};

/**
 * App 用的 dist 缓存单例。
 *
 * 做成单例而不是每次建：缓存本身无状态（状态在文件与键值存储里），重复建只是白建对象；
 * 而 `Paths.document` 只在方法调用时才访问，模块加载期不碰原生，所以放在模块级是安全的。
 */
export const appDistCache: DistCache = createDistCache({ store: appStore, files: expoFilePort });

/** 便于排查：缓存根目录的沙箱 URI（真机上打日志用）。 */
export function cacheRootUri(): string {
  return new Directory(Paths.document, CACHE_ROOT).uri;
}
