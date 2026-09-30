// Metro 配置（#155）：手机壳要直接复用 `mobile/shell-web` 的 .mjs 核心（本地资产路由 +
// 启动图增补），而 Metro 默认 sourceExts 不含 mjs —— 不配就解析不到，等于把那份逻辑再抄一遍。
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const exts = new Set(config.resolver.sourceExts);

exts.add('mjs');
// `.tgz` 是随包的内置运行时整包（#155）：不加入 assetExts，Metro 会当成源码去解析而报错。
const assets = new Set(config.resolver.assetExts);
assets.add('tgz');
config.resolver.assetExts = [...assets];
config.resolver.sourceExts = [...exts];
// #155：`shell-web` 在 Expo 工程根**之外**（`mobile/shell-web`），Metro 默认只监视项目根 →
// `../../../shell-web/local-assets.mjs` 解析不到（CI 的 iOS bundling 就是死在 `Unable to resolve
// module ../../../shell-web/local-assets.mjs`；tsc/vitest 不受项目根限制，所以本地全绿也会漏）。
// 只把 shell-web 加进 watchFolders：不把 `dsh-mobile-nav`（子模块、自带 node_modules）拖进来，
// 避免重复模块干扰解析。
config.watchFolders = [...(config.watchFolders ?? []), require('path').resolve(__dirname, '../shell-web')];

module.exports = config;
