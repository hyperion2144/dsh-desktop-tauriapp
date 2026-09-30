// 手机壳「本地资产 + 远程数据」核心（与桌面远程模式同形，纯逻辑、可单测）。
//
// 形态（#155 本体，依据 #150 研究 / #151 #152 #153 决策）：
//   ① 检测版本：取远程首页 HTML 里被引用的**入口产物名**（`assets/index-<hash>.js`）当构建标识；
//   ② 比对本地：与已下载的前端 dist 逐个比入口名；
//   ③ 缺则下载：拉 npm registry 上最新 dsh 前端产物（几 MB，不拉整个运行时），重比；
//   ④ 页面：**远程 HTML 原文**（`<base>` 改写到壳内 loopback origin）+ **本地静态资产** + **远程 Host 数据**。
//
// 为什么必须比对入口产物名而不是整页字节：Host 会往 index.html 内联启动注入（模块加载器 facade、
// 批次 script 行、`__DSH_BOOT__`），字节必然不同；而产物名自带内容 hash，是现成的同一性判据。
// 与桌面 `network/shell_origin/assets.rs` 的 `entry_name()` / `build_id()` 同一套规则。

/** 前端产物在 npm 上的包名（桌面的运行时目录同理；这里只要前端那几 MB）。 */
export const FRONTEND_PACKAGE = '@deepseek-ai/dsh-web-frontend';
/** npm registry 地址（测试可覆盖）。 */
export const NPM_REGISTRY = 'https://registry.npmjs.org';

/** 壳内本地服务的路径前缀：随包插件（布局插件）从这里取，与 Host 的 `/plugins/*` 区分开。 */
export const LOCAL_PLUGIN_PREFIX = '/__local-plugins/';

/** 常见静态类型的 MIME（够前端产物用；未知一律 application/octet-stream）。 */
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** 按扩展名给 MIME。 */
export function mimeOf(path) {
  const clean = String(path ?? '').split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME[clean.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 从一份 index.html 里取入口脚本名（`assets/index-<hash>.js` → `index-<hash>.js`）。
 *
 * 只认 `<script type="module" … src="…">`：那是前端产物自己的入口；Host 注入的行里没有这个形态
 * （插件 combo 是 `/plugins/??…`）。与桌面 `assets.rs::entry_name()` 逐条同构。
 */
export function entryName(html) {
  const s = String(html ?? '');
  let rest = s;
  while (true) {
    const at = rest.indexOf('<script');
    if (at < 0) return null;
    const end = rest.indexOf('>', at);
    if (end < 0) return null;
    const tag = rest.slice(at, end);
    if (tag.includes('type="module"')) {
      const m = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (m) {
        const name = m[1].split('?')[0].split('/').pop() ?? '';
        if (name.startsWith('index-')) return name;
      }
    }
    rest = rest.slice(end + 1);
  }
}

/**
 * 版本闸门：拿远程入口名与本机已有的本地 dist 逐个比。
 *
 * @param {{ remoteEntry?: string|null, localDists?: Array<{id:string, entry:string}> }} input
 * @returns {{ kind:'matched', dist:object } | { kind:'missing', remoteEntry:string|null, reason:string }
 *   | { kind:'unavailable', reason:string }}
 */
export function buildGate({ remoteEntry = null, localDists = [] } = {}) {
  if (!remoteEntry) {
    // 取不到入口名（老版 dsh 未注入入口脚本 / 首页非 200 / 远程不可达）：不假装匹配。
    return { kind: 'unavailable', reason: '读不到远程前端构建标识（首页非 200 或没有入口脚本）' };
  }
  const hit = (localDists ?? []).find((d) => d && d.entry === remoteEntry);
  if (hit) return { kind: 'matched', dist: hit };
  return {
    kind: 'missing',
    remoteEntry,
    reason: `远程构建 ${remoteEntry} 本机没有对应产物`,
  };
}

/**
 * 闸门给出的三条路（与桌面远程模式的三选一同构）：
 * - `download`：下载对应的前端产物（拉 npm 上最新那版），重比后命中就用它；
 * - `useLocal`：用现有默认产物（版本可能不一致，界面应给警告）；
 * - `remoteWebview`：直接以 URL webview 打开远程页面（最保守、永远可用）。
 */
export const GATE_CHOICES = [
  { id: 'download', label: '下载对应运行时', hint: '拉取匹配的前端产物后重比，命中即用本地资产' },
  { id: 'useLocal', label: '用当前默认运行时', hint: '版本可能不一致，界面会标注' },
  { id: 'remoteWebview', label: '直接打开远程页面', hint: '不做本地资产，最保守' },
];

/**
 * 本地资产请求判定：命中本地 dist 的文件走壳内服务，其余一律转发远端。
 *
 * 与桌面 `stream_proxy::local_asset()` 同一优先级（本地优先、命中即回），并且**随包插件**
 * 也从本地出（布局插件在 Host 未安装时要靠它，见 #152 决策 5）。
 *
 * @param {string} target 请求路径（含 query）

/**
 * 本地资产请求判定：命中本地 dist 的文件走壳内服务，其余一律转发远端。
 *
 * 与桌面 `stream_proxy::local_asset()` 同一优先级（本地优先、命中即回），并且**随包插件**
 * 也从本地出（布局插件在 Host 未安装时要靠它，见 #152 决策 5）；
 * `/__local-plugins/` 下的未知 id 是终态（`unknownPlugin`），绝不转发。
 *
 * @param {string} target 请求路径（含 query）
 * @param {{ distFiles?: Set<string>|string[], localPlugins?: string[] }} index
 * @returns {{ kind:'local', path:string } | { kind:'plugin', id:string, rest:string }
 *   | { kind:'unknownPlugin', id:string } | { kind:'forward' }}
 */
export function routeRequest(target, { distFiles = [], localPlugins = [] } = {}) {
  const path = String(target ?? '/').split('?')[0];
  if (path.startsWith(LOCAL_PLUGIN_PREFIX)) {
    const rest = path.slice(LOCAL_PLUGIN_PREFIX.length);
    const slash = rest.indexOf('/');
    const id = slash < 0 ? rest : rest.slice(0, slash);
    if (id && (localPlugins ?? []).includes(id)) {
      return { kind: 'plugin', id, rest: slash < 0 ? '/' : rest.slice(slash) };
    }
    // 未知 id 也**不转发**：`/__local-plugins/` 是壳自己的命名空间，Host 上没有这个路由，
    // 转发过去只会得到一个噪声 404（还可能撞上 Host 未来同名的路由）。终态由调用方答 404。
    return { kind: 'unknownPlugin', id };
  }
  const file = path.replace(/^\/+/, '');
  const known = distFiles instanceof Set ? distFiles : new Set(distFiles ?? []);
  // 只服务真实存在的产物文件：`/`、`/api/*`、`/plugins/*` 等一律转发（文档由壳组装）。
  if (file && known.has(file)) return { kind: 'local', path: file };
  return { kind: 'forward' };
}
