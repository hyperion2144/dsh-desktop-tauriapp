// 手机壳「本地资产 + 远程数据」的请求处理核心（#155）。
//
// 与桌面远程模式同形：**文档 = 远程 HTML 组装**、**静态资产 = 本地 dist**、**其余 = 转发远端 Host**。
// 本文件是**纯逻辑**（所有 IO 走注入的端口），因为：
//   - 真机/模拟器才能跑 socket，而路由与组装这两件事的正确性不该依赖真机；
//   - 与 `mobile/shell-web` 的核心共用同一份实现（那份是两端共同的事实源）。
// socket 绑定（react-native-tcp-socket）与 dist 的下载/缓存见后续 `local-host-runtime.ts`。

import { routeRequest, mimeOf, LOCAL_PLUGIN_PREFIX } from '../../../shell-web/local-assets.mjs';
import { composeDocument, type LocalPluginDescriptor } from '../../../shell-web/boot-manifest.mjs';

/** 一次转发请求（由运行时的转发端口执行；壳在这里把会话 cookie 注入进去）。 */
export interface UpstreamRequest {
  method: string;
  /** 远端相对路径（含 query），如 `/api/remote.mux`。 */
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array | null;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export interface LocalHostPorts {
  /** 远端 Host（`host:port`，如桌面端「远程访问」铸造出的地址）。 */
  remoteBase: string;
  /** 本地已下载的前端 dist 文件清单（相对路径，如 `assets/index-5SrrfWpU.js`）。 */
  distFiles: Iterable<string>;
  /** 读本地 dist 文件；不存在返回 null。 */
  readDistFile: (rel: string) => Promise<Uint8Array | null>;
  /** 随包插件（布局插件）的 client.js 内容：id → 文本。 */
  bundledPlugins: Record<string, string>;
  /** 转发到远端 Host（cookie 由端口实现注入；响应里的 set-cookie 由端口实现剥掉）。 */
  fetchUpstream: (req: UpstreamRequest) => Promise<UpstreamResponse>;
  /** 随包插件的 rev（写进启动图当缓存失效用）；缺省用 `local`。 */
  pluginRev?: string;
}

export interface LocalHostRequest {
  method: string;
  /** 请求行里的路径（含 query）。 */
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
}

export interface LocalHostResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

const TEXT = (s: string) => new TextEncoder().encode(s);
const html = (s: string): LocalHostResponse => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: s,
});

/** 文档请求：`/` 与 `/index.html`（与桌面 `scheme.rs::is_document` 同判定）。 */
export function isDocumentPath(path: string): boolean {
  const p = String(path ?? '/').split('?')[0];
  return p === '/' || p === '/index.html';
}

/**
 * 造一个请求处理器。
 *
 * 契约（与桌面流式代理逐条对齐）：
 * - 文档：远端 `/` **原文** + 剥 lane 补丁 + 增补随包插件 → `no-store`；远端失败就**明确报错**，
 *   绝不回退「直接开远端页面」（那是三选一里的另一条路，由壳的闸门决定）。
 * - 本地资产：命中 dist 清单才本地出（`mimeOf` 定类型，长缓存），未命中一律转发。
 * - 随包插件：`/__local-plugins/<id>/client.js` 从包内出（Host 没装它时唯一的来源）。
 * - 其余（`/api/*`、`/plugins/*`、SSE、WS 的 HTTP 面）：原样转发，方法与请求头透传。
 */
export function createLocalHostHandler(ports: LocalHostPorts) {
  const dist = new Set<string>(ports.distFiles ?? []);
  const pluginIds = Object.keys(ports.bundledPlugins ?? {});
  const rev = ports.pluginRev ?? 'local';
  /** 写进启动图的随包插件描述（url 用相对形态，与 Host 自己的 `plugins/??…` 同风格）。 */
  const bundled: LocalPluginDescriptor | null = pluginIds.includes('dsh-web-mobile')
    ? {
        id: 'dsh-web-mobile',
        url: `__local-plugins/dsh-web-mobile/client.js?rev=${rev}`,
        rev,
        inject: ['@deepseek-ai/dsh-client-modules'],
      }
    : null;

  return async function handle(req: LocalHostRequest): Promise<LocalHostResponse> {
    const method = String(req.method ?? 'GET').toUpperCase();
    const path = String(req.path ?? '/');

    // CORS 预检：壳内页面与本地服务同源，理论上不会有预检；有也本地答掉（桌面同做法）。
    if (method === 'OPTIONS') {
      return {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-max-age': '600',
        },
        body: '',
      };
    }

    if (isDocumentPath(path)) {
      const upstream = await ports.fetchUpstream({ method: 'GET', path: '/', headers: { accept: 'text/html' } });
      if (upstream.status < 200 || upstream.status >= 300) {
        return {
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          body: `手机壳：取远端首页失败（HTTP ${upstream.status}），无法组装本地资产页面`,
        };
      }
      const remoteHtml = typeof upstream.body === 'string' ? upstream.body : new TextDecoder().decode(upstream.body);
      const composed = composeDocument({ remoteHtml, localPlugin: bundled });
      return html(composed.html);
    }

    const route = routeRequest(path, { distFiles: dist, localPlugins: pluginIds });
    if (route.kind === 'local') {
      const file = await ports.readDistFile(route.path);
      if (!file) {
        // 清单里有、但文件读不到：如实 404，让页面自己报错，别静默转发（那会变成"半本地"）。
        return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `本地资产缺失：${route.path}` };
      }
      return {
        status: 200,
        headers: { 'content-type': mimeOf(route.path), 'cache-control': 'public, max-age=31536000, immutable' },
        body: file,
      };
    }
    if (route.kind === 'plugin') {
      const source = ports.bundledPlugins[route.id];
      if (!source) {
        return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '随包插件不存在' };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
        body: source,
      };
    }
    if (route.kind === 'unknownPlugin') {
      // 自己的命名空间下未知 id：终态 404（连碰都不碰远端）——`/__local-plugins/` 是壳自己的，
      // Host 上没有这个路由，转发过去只会拿到一个噪声 404。
      return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '随包插件不存在' };
    }

    // 其余一律转发（数据面、插件 combo、SSE 的 HTTP 面）。
    const upstream = await ports.fetchUpstream({
      method,
      path,
      headers: { ...(req.headers ?? {}) },
      body: req.body ?? null,
    });
    return { status: upstream.status, headers: upstream.headers, body: upstream.body };
  };
}

/** 随包插件的本地 URL 前缀（供 WebView/页面侧引用；与 shell-web 的常量同源）。 */
export { LOCAL_PLUGIN_PREFIX };
/** 文本转字节（RN 侧写响应体用）。 */
export { TEXT };
