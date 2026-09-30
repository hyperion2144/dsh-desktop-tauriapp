// 壳内 loopback HTTP 服务的 HTTP/1.1 报文处理（#155）。
//
// 为什么自己解析而不是用现成框架：服务端要跑在 **RN 的 TCP socket** 上（#150 结论 C：页面 origin
// 必须是 App 内自建 loopback 服务），能用的库要么带全套 node http 语义、要么不支持 upgrade 透传。
// 而这里真正需要的只有三件事，且都能纯函数化、单测锁死：
//   ① 解析请求头（方法与路径、头字段、Content-Length 帧定的 body）；
//   ② 序列化响应（状态行 + 头 + body，Content-Length 由我们算，杜绝分块歧义）；
//   ③ 认出 WebSocket upgrade（mux 要走 `upgrade` 事件原样透传，不能被当普通响应吃掉）。

export interface Http1RequestHead {
  method: string;
  /** 请求行里的路径（含 query）。 */
  path: string;
  /** HTTP 版本（归一化为 `1.1` / `1.0`，已剥 `HTTP/` 前缀）。 */

  version: string;
  /** 头字段：名字统一小写（HTTP 头不区分大小写，统一小写才好比对）。 */
  headers: Record<string, string>;
}

export interface ParsedHead {
  head: Http1RequestHead;
  /** 头结束位置（`\r\n\r\n` 之后的下标），body 从这里开始。 */
  bodyStart: number;
}

const decoder = new TextDecoder('latin1');

/** 字节 → 字符串（请求头是 latin1 字节序列，中文 body 不走这里）。 */
function toText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * 尝试解析请求头。数据还没到齐（没有 `\r\n\r\n`）返回 null —— 调用方继续收字节。
 * 形状不对（请求行没有三段）返回 `{ bad: true }`，让调用方回 400 而不是干等。
 */
export function parseRequestHead(buf: Uint8Array): ParsedHead | { bad: true } | null {
  const text = toText(buf);
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) {
    // 头不该无限长：超过 64KB 直接判坏，避免坏客户端把内存吃干。
    return text.length > 64 * 1024 ? { bad: true } : null;
  }
  const lines = text.slice(0, end).split('\r\n');
  const [method, path, version] = (lines.shift() ?? '').split(' ');
  if (!method || !path || !version) return { bad: true };
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  // 版本归一化为 `1.1` / `1.0`（剥 `HTTP/` 前缀）：调用方只关心协议版本，不该每次都处理前缀。
  return {
    head: { method: method.toUpperCase(), path, version: version.replace(/^HTTP\//i, ''), headers },
    bodyStart: end + 4,
  };
}

/** Content-Length（缺省 0；非法值当 0）。 */
export function contentLength(headers: Record<string, string>): number {
  const raw = headers['content-length'];
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 是否 WebSocket 升级请求（要原样透传给上游，不组装响应）。 */
export function isUpgrade(headers: Record<string, string>): boolean {
  const conn = (headers.connection ?? '').toLowerCase();
  const up = (headers.upgrade ?? '').toLowerCase();
  return up === 'websocket' && conn.includes('upgrade');
}

/** 请求是否已收齐（头 + Content-Length 声明的 body）。 */
export function isComplete(buf: Uint8Array): boolean {
  const parsed = parseRequestHead(buf);
  if (!parsed || 'bad' in parsed) return parsed != null && 'bad' in parsed;
  return buf.length >= parsed.bodyStart + contentLength(parsed.head.headers);
}

/**
 * 序列化响应。
 *
 * 一律带 `Content-Length` 且 `Connection: close`：壳内服务只为这一个 WebView 服务，
 * 不做 keep-alive 复用（少一层状态机，少一类"响应串台"的坑）。
 */
export function serializeResponse(res: {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
}): Uint8Array {
  const body = res.body == null ? new Uint8Array(0) : typeof res.body === 'string' ? new TextEncoder().encode(res.body) : res.body;
  const headers: Record<string, string> = { ...(res.headers ?? {}) };
  // 调用方给的头可能大小写不一：先归一到小写再写，避免出现两个 content-length。
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = v;
  normalized['content-length'] = String(body.length);
  if (!normalized.connection) normalized.connection = 'close';
  const reason = STATUS_TEXT[res.status] ?? 'OK';
  const head = `HTTP/1.1 ${res.status} ${reason}\r\n${Object.entries(normalized)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')}\r\n\r\n`;
  const headBytes = new TextEncoder().encode(head);
  const out = new Uint8Array(headBytes.length + body.length);
  out.set(headBytes, 0);
  out.set(body, headBytes.length);
  return out;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** 从上游响应里该剥掉的头（#151：会话由壳持有，绝不能让 webview 的 cookie jar 与壳的真值漂移）。 */
export const WITHHELD_RESPONSE_HEADERS = ['set-cookie', 'transfer-encoding', 'connection', 'content-length'];

/** 供日志/诊断用的简短描述（不带 body，避免日志爆掉）。 */
export function describeRequest(head: Http1RequestHead): string {
  return `${head.method} ${head.path}`;
}
