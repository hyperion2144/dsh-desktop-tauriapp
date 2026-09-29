// #155：HTTP/1.1 报文处理的测试（壳内 loopback 服务的报文层）。
import { describe, it, expect } from 'vitest';
import {
  parseRequestHead,
  contentLength,
  isUpgrade,
  isComplete,
  serializeResponse,
  WITHHELD_RESPONSE_HEADERS,
  describeRequest,
} from './http1';

const enc = (s: string) => new TextEncoder().encode(s);

describe('parseRequestHead', () => {
  it('解析请求行与头（名字统一小写），返回 body 起点', () => {
    const raw = enc('GET /api/remote.mux?x=1 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nCookie: a=b\r\n\r\n');
    const parsed = parseRequestHead(raw);
    expect(parsed && !('bad' in parsed)).toBe(true);
    if (!parsed || 'bad' in parsed) return;
    expect(parsed.head.method).toBe('GET');
    expect(parsed.head.path).toBe('/api/remote.mux?x=1');
    expect(parsed.head.version).toBe('1.1');
    expect(parsed.head.headers['host']).toBe('127.0.0.1:1234');
    expect(parsed.head.headers['cookie']).toBe('a=b');
    expect(parsed.bodyStart).toBe(raw.length);
  });

  it('头没收齐 → null（继续收字节），不是坏报文', () => {
    expect(parseRequestHead(enc('GET / HTTP/1.1\r\nHost: x\r\n'))).toBeNull();
  });

  it('请求行不是三段 → bad（回 400，别干等）', () => {
    expect(parseRequestHead(enc('BOGUS\r\n\r\n'))).toEqual({ bad: true });
  });

  it('头超 64KB 仍没收齐 → 判坏（防坏客户端吃内存）', () => {
    const huge = enc(`GET / HTTP/1.1\r\nX: ${'a'.repeat(70 * 1024)}`);
    expect(parseRequestHead(huge)).toEqual({ bad: true });
  });

  it('方法规整为大写', () => {
    const parsed = parseRequestHead(enc('post /api/x HTTP/1.1\r\n\r\n'));
    expect(parsed && !('bad' in parsed) && parsed.head.method).toBe('POST');
  });
});

describe('contentLength / isComplete', () => {
  it('Content-Length 缺省或非法 → 0', () => {
    expect(contentLength({})).toBe(0);
    expect(contentLength({ 'content-length': 'abc' })).toBe(0);
    expect(contentLength({ 'content-length': '12' })).toBe(12);
  });

  it('body 未收齐 → false；收齐 → true', () => {
    const head = 'POST /api/x HTTP/1.1\r\ncontent-length: 5\r\n\r\n';
    expect(isComplete(enc(head))).toBe(false);
    expect(isComplete(enc(head + 'abc'))).toBe(false);
    expect(isComplete(enc(head + 'abcde'))).toBe(true);
  });
});

describe('isUpgrade', () => {
  it('只认 websocket + connection: upgrade（大小写不敏感）', () => {
    expect(isUpgrade({ connection: 'Upgrade', upgrade: 'websocket' })).toBe(true);
    expect(isUpgrade({ connection: 'keep-alive', upgrade: 'websocket' })).toBe(false);
    expect(isUpgrade({ connection: 'upgrade' })).toBe(false);
    // 普通 WS 握手头一并带上时也只认那两个字段
    expect(isUpgrade({ connection: 'Upgrade', upgrade: 'WebSocket', 'sec-websocket-key': 'x' })).toBe(true);
  });
});

describe('serializeResponse', () => {
  it('自动补 Content-Length 与 Connection: close，body 字节数按 UTF-8 算', () => {
    const out = serializeResponse({ status: 200, headers: { 'Content-Type': 'text/plain' }, body: '中文' });
    const text = new TextDecoder().decode(out);
    expect(text.startsWith('HTTP/1.1 200 OK\r\n')).toBe(true);
    expect(text).toContain('content-length: 6');
    expect(text).toContain('content-type: text/plain');
    expect(text).toContain('connection: close');
    // 头与 body 之间只有一个空行，body 是原文
    expect(text.endsWith('\r\n\r\n中文')).toBe(true);
  });

  it('调用方给的大小写不一的头不会产生两个 content-length', () => {
    const out = new TextDecoder().decode(serializeResponse({ status: 200, headers: { 'Content-Length': '999' }, body: 'ab' }));
    expect(out.match(/content-length/g)?.length).toBe(1);
    expect(out).toContain('content-length: 2');
  });

  it('204/302 无 body 也能出合法报文', () => {
    const out = new TextDecoder().decode(serializeResponse({ status: 204 }));
    expect(out.startsWith('HTTP/1.1 204 No Content\r\n')).toBe(true);
    expect(out.endsWith('\r\n\r\n')).toBe(true);
  });

  it('剥头清单包含 set-cookie（会话由壳持有，绝不让 webview jar 漂移）', () => {
    expect(WITHHELD_RESPONSE_HEADERS).toContain('set-cookie');
  });

  it('describeRequest 只给方法与路径（日志不炸）', () => {
    expect(describeRequest({ method: 'GET', path: '/api/x', version: '1.1', headers: {} })).toBe('GET /api/x');
  });
});
