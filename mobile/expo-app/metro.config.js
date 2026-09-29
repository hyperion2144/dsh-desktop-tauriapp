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

module.exports = config;
