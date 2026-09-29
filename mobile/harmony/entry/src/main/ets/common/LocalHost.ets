/**
 * 鸿蒙壳的「本地资产 + 远程数据」服务（#155）。
 *
 * 与桌面远程模式同形（依据 #150 研究 / #151 #152 #153 决策）：
 *   页面 origin = App 内自建 loopback HTTP 服务（`file://` 与自定义 scheme 已被 #150 否决：
 *   opaque origin / CORS / Cookie 都过不去，而 `@ohos.net.socket` 是系统能力，无需额外原生模块）；
 *   文档 = 远程 Host 首页原文（剥掉 lane 的页面补丁）；静态资产 = 本地（下载到沙箱的前端 dist）；
 *   其余（`/api/*`、`/plugins/*`、SSE）一律转发远端，会话 cookie 由壳持有并注入、响应剥 set-cookie。
 *
 * 与 Expo 侧共用同一套判定（`mobile/shell-web/*.mjs` 是两端的事实源）：`entryNameOf` / `gateOf` /
 * `stripLanePatches` / `augmentBoot` 是那几件事的 ArkTS 落点，规则逐条对齐：
 *   - 构建标识 = `<script type="module" src="…index-*.js">` 的 basename（与桌面 assets.rs 同规则）；
 *   - 闸门命中 = 远程入口产物名与本地产物清单里某一个相同；
 *   - 路由 = 本地 dist 命中才本地出，`__local-plugins/` 是壳自己的命名空间（未知 id 终态 404），其余转发；
 *   - 启动图增补 = 一行 entry + 一个独占 application batch（装载 ≠ 激活，见 #150 §3）。
 *
 * ArkTS 约束（编译器实测，别按 TS 习惯写）：不许索引签名（动态头用 `Map`）、不许对象展开、
 * 不许解构声明、不许 `delete`、对象字面量必须对应已声明接口、`catch` 参数要显式转类型。
 *
 * 接入点：见 `pages/WebPage.ets::startLocalAssets`（起服务 → 换成壳内 origin，失败回退远端地址）。
 */
import socket from '@ohos.net.socket';
import http from '@ohos.net.http';
import fs from '@ohos.file.fs';
import util from '@ohos.util';
import { BusinessError } from '@kit.BasicServicesKit';

/** 动态头字段（ArkTS 不支持索引签名，所以用 Map；不要改回 Record）。 */
export type HeaderMap = Map<string, string>;

/** 转发到远端的一次请求。 */
export interface UpstreamRequest {
  method: string;
  path: string; // 含 query
  headers: HeaderMap;
  body?: ArrayBuffer;
}

export interface UpstreamResponse {
  status: number;
  headers: HeaderMap;
  body: ArrayBuffer | string;
}

/** 透传给远端的请求头白名单（逐跳头与原 origin/host 都不透传，与桌面流式代理同原则）。 */
interface HttpRequestHeaders {
  accept?: string;
  contentType?: string;
  authorization?: string;
  cookie?: string;
}

/** 启动图里的一行 entry / 一个 batch（对象字面量必须有对应声明，ArkTS 才收）。 */
interface BootEntry {
  id: string;
  url: string;
  rev: string;
  inject?: string[];
}

interface BootBatch {
  phase: string;
  url: string;
  rev: string;
  entries: string[];
}

interface BootGraph {
  rev?: string;
  entries: BootEntry[];
  batches: BootBatch[];
}

export interface LocalHostOptions {
  /** 远端 authority（`host:port`）。 */
  remoteBase: string;
  /** 壳持有的会话 cookie（`name=value`）；空则不注入。 */
  cookie: string;
  /** 本地 dist 的沙箱目录（解包后的 `dist/`）。 */
  distDir: string;
  /** dist 的文件相对路径清单（`assets/index-xxx.js` 等）。 */
  distFiles: string[];
  /** 随包布局插件的 client.js 内容（Host 没装时唯一来源）；空 = 不随包。 */
  pluginClientJs: string;
  /** 随包插件 rev（写进启动图当缓存失效用）。 */
  pluginRev: string;
}

const WITHHELD_HEADERS = ['set-cookie', 'transfer-encoding', 'connection', 'content-length'];

/** 壳内 loopback 服务试绑的端口区间（`getState()` 只回布尔，绑 0 读不到端口，故显式试）。 */
const PORT_RANGE_START = 41850;
const PORT_RANGE_END = 41870;

/** 造一个头 Map（避免在各处写对象字面量）。 */
function headersOf(contentType: string, cacheControl?: string): HeaderMap {
  const h: HeaderMap = new Map<string, string>();
  h.set('content-type', contentType);
  if (cacheControl !== undefined && cacheControl !== '') h.set('cache-control', cacheControl);
  return h;
}

/** 从 index.html 取入口产物名（`assets/index-<hash>.js` → `index-<hash>.js`）。 */
export function entryNameOf(html: string): string {
  let rest = html;
  while (true) {
    const at = rest.indexOf('<script');
    if (at < 0) return '';
    const end = rest.indexOf('>', at);
    if (end < 0) return '';
    const tag = rest.substring(at, end);
    if (tag.indexOf('type="module"') >= 0) {
      const m = /\ssrc\s*=\s*["']([^"']+)["']/.exec(tag);
      if (m) {
        const parts = m[1].split('?')[0].split('/');
        const name = parts[parts.length - 1];
        if (name.startsWith('index-')) return name;
      }
    }
    rest = rest.substring(end + 1);
  }
}

/** 版本闸门：远程入口名是否在本地产物清单里（命中返回清单里的那份名字，否则空串）。 */
export function gateOf(remoteEntry: string, localEntries: string[]): string {
  if (!remoteEntry) return '';
  for (const e of localEntries) {
    if (e === remoteEntry) return e;
  }
  return '';
}

/** 剥掉 lane 的页面级补丁（它们只对 lane 自己 origin 的页面成立，见桌面 drop_lane_patches）。 */
export function stripLanePatches(html: string): string {
  const markers = ['data-dsh-mobile-owns-host', 'data-dsh-mobile-theme-sync', 'data-dsh-mobile-loopback'];
  let out = html;
  for (const marker of markers) {
    let at = out.indexOf(marker);
    while (at >= 0) {
      const start = out.lastIndexOf('<script', at);
      const close = out.indexOf('</script>', at);
      if (start < 0 || close < 0) {
        out = out.substring(0, at) + out.substring(at + marker.length);
      } else {
        out = out.substring(0, start) + out.substring(close + '</script>'.length);
      }
      at = out.indexOf(marker);
    }
  }
  return out;
}

/** 往启动图里增补随包插件（一行 entry + 独占 application batch）；已有同 id 则原样返回。 */
export function augmentBoot(html: string, pluginId: string, pluginUrl: string, rev: string): string {
  const prefix = 'globalThis["__DSH_BOOT__"]';
  const base = html.indexOf(prefix);
  if (base < 0) return html;
  const eq = html.indexOf('=', base + prefix.length);
  const start = html.indexOf('{', eq);
  if (start < 0) return html;
  const end = matchBrace(html, start);
  if (end < 0) return html;
  let graph: BootGraph;
  try {
    graph = JSON.parse(html.substring(start, end + 1)) as BootGraph;
  } catch (err) {
    // 形状不认识就别动（宁可少一个插件，也不要把页面改坏）。
    return html;
  }
  if (graph.entries === undefined || graph.batches === undefined) return html;
  for (const e of graph.entries) {
    if (e.id === pluginId) return html; // Host 自己装了：用它那份
  }
  const entry: BootEntry = {
    id: pluginId,
    url: pluginUrl,
    rev: rev,
    inject: ['@deepseek-ai/dsh-client-modules'],
  };
  const batch: BootBatch = { phase: 'application', url: pluginUrl, rev: rev, entries: [pluginId] };
  graph.entries.push(entry);
  graph.batches.push(batch);
  return html.substring(0, start) + JSON.stringify(graph) + html.substring(end + 1);
}

/** 字符串感知的括号配对（JSON 里可能有含花括号的字符串）。 */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  let quote = '';
  for (let i = open; i < s.length; i++) {
    const c = s.charAt(i);
    if (inStr) {
      if (c === '\\') i++;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 壳内 loopback 服务：起服务、按路由应答、转发远端、WS 原样透传。 */
export class LocalHost {
  private server: socket.TCPSocketServer | undefined = undefined;
  private port = 0;
  private opts: LocalHostOptions;

  private constructor(opts: LocalHostOptions) {
    this.opts = opts;
  }

  /** 页面地址（WebView 加载它）。 */
  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  static async start(opts: LocalHostOptions): Promise<LocalHost> {
    const host = new LocalHost(opts);
    await host.listen();
    return host;
  }

  private async listen(): Promise<void> {
    const server = socket.constructTCPSocketServerInstance();
    // 端口不能交给系统分配：`getState()` 只回布尔（isBound/isConnected/isClosing），绑 0 就永远
    // 拿不到实际端口，也就拼不出页面 origin。于是显式试一段端口，第一个绑成功的即用；
    // 只绑回环：绑 0.0.0.0 等于把 dsh 的 loopback 信任面复制到局域网（#151 第 5 条同一考量）。
    let bound = 0;
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      try {
        await server.listen({ address: '127.0.0.1', port: port, family: 1 });
        bound = port;
        break;
      } catch (err) {
        // 该端口被占（或不可用）：试下一个；全失败在下面抛。
      }
    }
    if (bound === 0) {
      throw new Error(`鸿蒙壳：${PORT_RANGE_START}-${PORT_RANGE_END} 之间没有可用端口`);
    }
    server.on('connect', (client: socket.TCPSocketConnection) => {
      void this.serve(client);
    });
    this.server = server;
    this.port = bound;
  }

  /** 一次连接：收字节 → 头收齐 → upgrade 透传 / 交路由处理 → 写回应答。 */
  private async serve(client: socket.TCPSocketConnection): Promise<void> {
    let buf = new ArrayBuffer(0);
    client.on('message', (value: socket.SocketMessageInfo) => {
      buf = concat(buf, value.message);
      const text = buf2str(buf);
      const headEnd = text.indexOf('\r\n\r\n');
      if (headEnd < 0) return; // 头没收齐：继续收
      const head = text.substring(0, headEnd).split('\r\n');
      const requestLine = head[0].split(' ');
      const method = requestLine.length > 0 ? requestLine[0] : 'GET';
      const path = requestLine.length > 1 ? requestLine[1] : '/';
      const headers: HeaderMap = new Map<string, string>();
      for (let i = 1; i < head.length; i++) {
        const at = head[i].indexOf(':');
        if (at > 0) {
          headers.set(head[i].substring(0, at).trim().toLowerCase(), head[i].substring(at + 1).trim());
        }
      }
      const conn = headers.get('connection');
      if (conn !== undefined && conn.toLowerCase().indexOf('upgrade') >= 0) {
        void this.tunnel(client, buf); // WebSocket：原样透传，别当普通响应吃掉
        return;
      }
      void this.route(method, path, headers).then((res: UpstreamResponse) => {
        client.send({ data: serializeResponse(res.status, res.headers, res.body) }).catch(() => {});
      });
    });
  }

  /** 路由：本地资产命中才本地出；`__local-plugins/` 未知 id 终态 404；其余转发远端。 */
  private async route(method: string, path: string, headers: HeaderMap): Promise<UpstreamResponse> {
    const bare = path.split('?')[0];
    if (bare === '/' || bare === '/index.html') {
      const reqHeaders: HeaderMap = new Map<string, string>();
      reqHeaders.set('accept', 'text/html');
      const upstream = await this.forward({ method: 'GET', path: '/', headers: reqHeaders });
      const html = typeof upstream.body === 'string' ? upstream.body : buf2str(upstream.body);
      if (upstream.status < 200 || upstream.status >= 300) {
        return {
          status: 502,
          headers: headersOf('text/plain; charset=utf-8'),
          body: '鸿蒙壳：取远端首页失败',
        };
      }
      let doc = stripLanePatches(html);
      if (this.opts.pluginClientJs !== '') {
        const url = `__local-plugins/dsh-web-mobile/client.js?rev=${this.opts.pluginRev}`;
        doc = augmentBoot(doc, 'dsh-web-mobile', url, this.opts.pluginRev);
      }
      return { status: 200, headers: headersOf('text/html; charset=utf-8', 'no-store'), body: doc };
    }
    if (bare.startsWith('/__local-plugins/')) {
      if (bare.indexOf('/dsh-web-mobile/client.js') >= 0 && this.opts.pluginClientJs !== '') {
        return {
          status: 200,
          headers: headersOf('text/javascript; charset=utf-8', 'no-store'),
          body: this.opts.pluginClientJs,
        };
      }
      return { status: 404, headers: headersOf('text/plain; charset=utf-8'), body: '随包插件不存在' };
    }
    const rel = bare.replace(/^\/+/, '');
    if (rel !== '' && this.opts.distFiles.indexOf(rel) >= 0) {
      const bytes = readFileOrNull(`${this.opts.distDir}/${rel}`);
      if (bytes !== null) {
        return {
          status: 200,
          headers: headersOf(mimeOf(rel), 'public, max-age=31536000, immutable'),
          body: bytes,
        };
      }
      return { status: 404, headers: headersOf('text/plain; charset=utf-8'), body: `本地资产缺失：${rel}` };
    }
    return await this.forward({ method: method, path: path, headers: headers });
  }

  /** 转发到远端（注入壳持有的 cookie；剥掉响应里的会话头）。 */
  private async forward(req: UpstreamRequest): Promise<UpstreamResponse> {
    const client = http.createHttp();
    try {
      // 白名单透传：逐跳头、原 origin/host 都不带给远端（否则 dsh 的信任栅栏会判不一致）。
      const outHeaders: HttpRequestHeaders = {};
      const accept = req.headers.get('accept');
      const contentType = req.headers.get('content-type');
      const authorization = req.headers.get('authorization');
      if (accept !== undefined) outHeaders.accept = accept;
      if (contentType !== undefined) outHeaders.contentType = contentType;
      if (authorization !== undefined) outHeaders.authorization = authorization;
      if (this.opts.cookie !== '') outHeaders.cookie = this.opts.cookie;

      const res = await client.request(`http://${this.opts.remoteBase}${req.path}`, {
        method: req.method as http.RequestMethod,
        header: outHeaders,
        extraData: req.body,
        readTimeout: 60000,
        connectTimeout: 10000,
      });
      // 响应头：ArkTS 禁止按索引读字段（`res.header['content-type']` 不过编译），所以按**路径推类型**；
      // `set-cookie` 本就不透传（会话只活在壳手里，#151）。
      const out: HeaderMap = new Map<string, string>();
      out.set('content-type', contentTypeOf(req.path));
      return { status: res.responseCode as number, headers: out, body: res.result as ArrayBuffer };
    } catch (err) {
      const e = err as BusinessError;
      return {
        status: 502,
        headers: headersOf('text/plain; charset=utf-8'),
        body: `转发失败：${e.message}`,
      };
    } finally {
      client.destroy();
    }
  }

  /** WebSocket upgrade：把握手字节原样发到远端，之后双向搬运。 */
  private async tunnel(client: socket.TCPSocketConnection, handshake: ArrayBuffer): Promise<void> {
    const parts = this.opts.remoteBase.split(':');
    const host = parts.length > 0 ? parts[0] : '127.0.0.1';
    const portRaw = parts.length > 1 ? parts[1] : '80';
    const port = Number.parseInt(portRaw, 10);
    const up = socket.constructTCPSocketInstance();
    await up.connect({ address: { address: host, port: port, family: 1 } });
    await up.send({ data: handshake });
    up.on('message', (v: socket.SocketMessageInfo) => {
      client.send({ data: v.message }).catch(() => {});
    });
    client.on('message', (v: socket.SocketMessageInfo) => {
      up.send({ data: v.message }).catch(() => {});
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server !== undefined) {
      await server.close();
      this.server = undefined;
    }
  }
}

/** 响应序列化：一律带 content-length + connection: close（壳内只服务这一个 WebView）。 */
export function serializeResponse(status: number, headers: HeaderMap, body: ArrayBuffer | string): ArrayBuffer {
  const bytes = typeof body === 'string' ? str2buf(body) : body;
  let head = `HTTP/1.1 ${status} OK\r\n`;
  headers.forEach((value: string, key: string) => {
    head += `${key}: ${value}\r\n`;
  });
  head += `content-length: ${bytes.byteLength}\r\n`;
  head += 'connection: close\r\n\r\n';
  return concat(str2buf(head), bytes);
}

/** 静态类型（够前端产物用）。 */
export function mimeOf(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.json') || path.endsWith('.map')) return 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

/**
 * 按请求路径推定响应的 content-type。
 *
 * 为什么不用上游返回的那个头：ArkTS 不允许 `res.header['content-type']`（arkts-no-props-by-index），
 * 而模块加载对 MIME 敏感（`import()` 拿到非 JS 类型会被拒）。dsh 的路由是确定的，推得准：
 * `/plugins/??…` 是插件 combo（JS）、`.js/.mjs` 是 JS、`.css` 是 CSS、`/api/*` 与 `.json` 是 JSON。
 */
export function contentTypeOf(path: string): string {
  const bare = path.split('?')[0];
  if (path.indexOf('??') >= 0) return 'text/javascript; charset=utf-8';
  if (bare.startsWith('/api/')) return 'application/json; charset=utf-8';
  return mimeOf(bare);
}


function str2buf(s: string): ArrayBuffer {
  const enc = new util.TextEncoder();
  return enc.encodeInto(s).buffer as ArrayBuffer;
}

function buf2str(b: ArrayBuffer): string {
  return new util.TextDecoder().decodeWithStream(new Uint8Array(b));
}

function concat(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer as ArrayBuffer;
}

function readFileOrNull(path: string): ArrayBuffer | null {
  try {
    if (!fs.accessSync(path)) return null;
    const stat = fs.statSync(path);
    const buf = new ArrayBuffer(stat.size);
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    fs.readSync(file.fd, buf);
    fs.closeSync(file);
    return buf;
  } catch (err) {
    return null;
  }
}
