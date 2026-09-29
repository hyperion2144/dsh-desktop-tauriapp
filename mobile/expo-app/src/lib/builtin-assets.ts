// 随包内置运行时（#155）：把打好的整包解出来，当「本地运行时」用。
//
// 与鸿蒙侧同形（`sync-builtin.sh` + rawfile 按需直读）：
//   - 构建期把前端产物 + 布局插件打成**一个包** `assets/dsh-frontend.tgz`（scripts/sync-builtin.mjs），
//     所以运行时以后增减文件**不需要改代码**（不写死文件清单）；
//   - 运行时首次使用时解包进内存（几 MB），之后由壳内 loopback 服务按请求路径直读；
//   - 与桌面**同一 pin**，因此两端构建标识一致，版本闸门天然命中——手机不必先下载。
//
// 解包只用 fflate（gzip）+ 本仓自己的 tar 解析（frontend-assets.ts 已导出、有单测），不引新依赖。
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { splitBundle, type BuiltinAssets } from './bundle-format';

/** 随包资源（Metro 会把它当 asset 打包；`.tgz` 已在 metro.config.js 的 assetExts 里）。 */
const BUNDLED_TGZ = require('../../assets/dsh-frontend.tgz');

let cached: BuiltinAssets | null | undefined;

/**
 * 读出随包内置运行时（只解一次，进程内缓存）。
 * 失败返回 null（调用方退回"下载对应运行时"那条路），不抛——首屏不该被它挡住。
 */
export async function loadBuiltinAssets(): Promise<BuiltinAssets | null> {
  if (cached !== undefined) return cached;
  try {
    const asset = Asset.fromModule(BUNDLED_TGZ);
    if (!asset.localUri) await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    const bytes = await new File(uri).bytes();
    cached = splitBundle(bytes);
  } catch {
    cached = null;
  }
  return cached;
}

/** 测试/调试用：清掉进程内缓存。 */
export function resetBuiltinAssetsCache(): void {
  cached = undefined;
}
