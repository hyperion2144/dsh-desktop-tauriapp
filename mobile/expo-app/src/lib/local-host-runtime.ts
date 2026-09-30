// 壳内 loopback HTTP 服务的运行时绑定（#155）：把纯 handler 接到 RN 的 TCP socket 上。
//
// 为什么必须自己起服务（#150 结论 C）：`file://` 与自定义 scheme 都因 opaque origin / CORS /
// Cookie 阻塞失败，iOS 的 `react-native-webview` 不暴露 `WKURLSchemeHandler`、Android 不暴露
// `WebViewAssetLoader` —— 唯一可行的是 **App 内自建 loopback HTTP 服务**当页面 origin。
// 于是页面与本服务同源：Cookie 照旧 `SameSite=Lax; HttpOnly`，不需要 `SameSite=None; Secure`
// （那个在局域网 `http://` 下无解）。
//
// 本文件只做「报文 ↔ socket」的接线，业务全在 `local-host.ts`（纯逻辑、可单测）：
//   收字节 → 头收齐 → 是 upgrade 就原样透传给上游（mux WS）／否则交给 handler → 写回响应。

import TcpSocket from 'react-native-tcp-socket';
import { createLocalHostHandler, type LocalHostPorts, type LocalHostResponse } from './local-host';
import {
  parseRequestHead,
  contentLength,
  isComplete,
  isUpgrade,
  serializeResponse,
  describeRequest,
} from './http1';

export interface LocalHostRuntimeOptions extends LocalHostPorts {
  /** 远端 authority（`host:port`）——WS upgrade 要直连它透传。 */
  remoteAuthority: string;
  /** 诊断日志（默认丢弃；真机排查时接到 console/file）。 */
  onLog?: (line: string) => void;
  /** 监听端口：0 = 让系统分配（真机不受限，端口随会话变）。 */
  port?: number;
}

export interface LocalHostRuntime {
  /** 实际监听端口（页面 origin 用它拼）。 */
  port: number;
  /** 页面地址（`http://127.0.0.1:<port>/`）——WebView 加载的就是它。 */
  url: string;
  stop: () => Promise<void>;
}

/** 字节拼接（两个入参都拷进新 ArrayBuffer，避开 TS 5.7 的 typed-array 泛型差异）。 */
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};


/**
 * 透传 WS 用得到的最小 socket 面。
 *
 * 刻意不提 `Buffer`：库用 JSDoc 引用 Node 的 Buffer 类型，而 Expo 的 tsconfig 不带 node 类型；
 * 而它实际收的也是 `Uint8Array`（`Socket.write` 签名接受 string | Buffer | Uint8Array）。
 */
interface RawSocket {
  write(data: Uint8Array): unknown;
  on(event: string, cb: (data: unknown) => void): unknown;
  end(): unknown;
}


/** socket 收到的一块数据：库给 Buffer | string，统一拷成 Uint8Array（不引 Node 类型）。 */
function toBytes(chunk: Uint8Array | string): Uint8Array {
  const src: ArrayLike<number> = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

/**
 * 起壳内 loopback 服务。
 *
 * 只监听 `127.0.0.1`（同机可达面）：页面 origin 是它，而它持有的会话 cookie 只该由壳使用；
 * 绑到 `0.0.0.0` 就等于把 dsh 的 loopback 信任面复制一份到局域网（#151 第 5 条的同一考量）。
 */
export async function startLocalHost(opts: LocalHostRuntimeOptions): Promise<LocalHostRuntime> {
  const log = opts.onLog ?? (() => {});
  const handle = createLocalHostHandler(opts);

  const server = TcpSocket.createServer((socket) => {
    // 累加器类型跟着 concat 的返回走：TS 5.7 的 typed-array 泛型下 `new Uint8Array(0)` 与它不同型。
    let buf: ReturnType<typeof concat> = new Uint8Array(0);
    let started = false;

    const reply = (res: LocalHostResponse) => {
      try {
        socket.write(serializeResponse(res));
      } catch (e) {
        log(`[local-host] 写响应失败：${String(e)}`);
      } finally {
        try {
          socket.end();
        } catch {
          /* 对端已走 */
        }
      }
    };

    socket.on('data', (chunk: unknown) => {
      if (started) return; // 已交给上游或已应答：后续字节由各自的通路处理
      buf = concat(buf, toBytes(chunk as Uint8Array | string));
      const parsed = parseRequestHead(buf);
      if (parsed && 'bad' in parsed) {
        started = true;
        reply({ status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '手机壳：请求报文不合法' });
        return;
      }
      if (!parsed) return; // 头还没收齐
      if (!isComplete(buf)) return; // body 还没收齐

      started = true;
      const { head, bodyStart } = parsed;
      log(`[local-host] ${describeRequest(head)}`);

      // WebSocket upgrade：原样透传给上游（mux 走这条；绝不能被当普通响应吃掉）。
      if (isUpgrade(head.headers)) {
        // 库的 Socket 与 RawSocket 结构一致、`on` 是重载泛型，这里显式跨过类型边界。
        void tunnelUpgrade(socket as unknown as RawSocket, buf, opts.remoteAuthority, opts.cookie ?? null, log);
        return;
      }

      const len = contentLength(head.headers);
      const body = buf.slice(bodyStart, bodyStart + len);
      void handle({
        method: head.method,
        path: head.path,
        headers: head.headers,
        body: len > 0 ? body : null,
      })
        .then(reply)
        .catch((e) => {
          log(`[local-host] 处理失败：${String(e)}`);
          reply({ status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '手机壳：本地服务处理失败' });
        });
    });

    socket.on('error', (e: unknown) => log(`[local-host] 连接错误：${String(e)}`));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    // 只绑回环：见函数注释。
    server.listen({ port: opts.port ?? 0, host: '127.0.0.1' }, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0));
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    stop: () =>
      new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}

/**
 * WS upgrade 透传：改写信封（补壳持有的会话、Host/Origin 指向远端 authority）后转发。
 *
 * 为什么要改写：页面 origin 是壳内 loopback，浏览器只会带**那个 origin** 的 cookie，而远端要求
 * 升级请求自身带会话（否则 401 UNPAIRED，鸿蒙实机就是这么断的）。与桌面 `stream_proxy` 的 WS 分支对齐。
 */
function rewriteHandshake(raw: string, remoteAuthority: string, cookie: string | null): string {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) return raw;
  const kept: string[] = [];
  const lines = raw.slice(0, end).split('\r\n');
  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    // 第 0 行是请求行，保留；其余剥掉会话/主机相关头，下面统一补。
    if (i > 0 && (lower.startsWith('cookie:') || lower.startsWith('host:') || lower.startsWith('origin:'))) continue;
    kept.push(lines[i]);
  }
  if (cookie) kept.push(`Cookie: ${cookie}`);
  kept.push(`Host: ${remoteAuthority}`);
  kept.push(`Origin: http://${remoteAuthority}`);
  return kept.join('\r\n') + raw.slice(end);
}

function tunnelUpgrade(
  client: RawSocket,
  rawHandshake: Uint8Array,
  remoteAuthority: string,
  cookie: string | null,
  log: (line: string) => void,
): void {

  const [host, portRaw] = remoteAuthority.split(':');
  const port = Number.parseInt(portRaw ?? '80', 10) || 80;
  const up = TcpSocket.createConnection({ host, port }, () => {
    try {
      // 改写信封：剥掉原有的 Cookie/Host/Origin，补上壳持有的会话，并把 Host/Origin 改成远端 authority
      // （远端的信任栅栏按 Host 判）——与鸿蒙 tunnel 同一套改法，都与桌面 stream_proxy 的 WS 分支对齐。
      up.write(toBytes(rewriteHandshake(new TextDecoder().decode(rawHandshake), remoteAuthority, cookie)));
    } catch (e) {
      log(`[local-host] WS 握手转发失败：${String(e)}`);
      client.end();
    }
  });
  up.on('data', (d: unknown) => {
    try {
      client.write(toBytes(d as Uint8Array | string));
    } catch {
      /* 客户端已走 */
    }
  });
  client.on('data', (d: unknown) => {
    try {
      up.write(toBytes(d as Uint8Array | string));
    } catch {
      /* 上游已走 */
    }
  });
  up.on('error', (e: unknown) => log(`[local-host] WS 上游错误：${String(e)}`));
}
