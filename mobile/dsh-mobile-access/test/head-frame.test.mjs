// #35 回归：upgrade 的 proxyHead 可能是某帧的后半段（dsh 的 101 与首帧数据同段到达）。
// head 必须喂给帧泵重组帧边界，客户端收到的字节流必须与上游完全一致（不得错位/重复/丢失）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRewriteProxy } from '../lib/proxy.mjs';

const UP_101 = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n';
const PHONE_HEADERS = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'AQIDBAUGBwgJCgsMDQ4P',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s.address().port; }

function phoneConnect(lanePort) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('phone upgrade timeout')), 5000);
    const req = http.request(`http://127.0.0.1:${lanePort}/api/remote.mux`, { headers: PHONE_HEADERS });
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      socket.on('error', () => {});
      const chunks = [];
      // lane 转发的首字节可能与 101 同段到达，作为 upgrade 事件的 head 交付
      if (head?.length) chunks.push(head);
      socket.on('data', (d) => chunks.push(d));
      const closed = new Promise((r) => socket.once('close', () => r()));
      resolve({ socket, bytes: () => Buffer.concat(chunks), push: (c) => chunks.push(c), closed });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

test('proxyHead 为帧后半段时：head 喂给泵重组，客户端字节流与上游逐字节一致', async () => {
  // 上游帧序列：text 'HELLO'（拆成 3+2 两段写入，前 3 字节混入 head）+ ping + text 'WORLD'
  const f1 = Buffer.concat([Buffer.from([0x81, 0x05]), Buffer.from('HELLO')]);
  const f2 = Buffer.from([0x89, 0x00]);
  const f3 = Buffer.concat([Buffer.from([0x81, 0x05]), Buffer.from('WORLD')]);
  const expected = Buffer.concat([f1, f2, f3]);

  const sockets = new Set();
  const server = http.createServer((_q, r) => r.end());
  server.on('connection', (s) => sockets.add(s));
  server.on('upgrade', (_req, sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    // 101 与 f1 的前 3 字节同一写入（head 拆帧场景），f1 其余部分稍后到达
    sock.write(Buffer.concat([Buffer.from(UP_101), f1.subarray(0, 3)]));
    setTimeout(() => {
      sock.write(f1.subarray(3));
      sock.write(f2);
      sock.write(f3);
    }, 30);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: server.address().port, wsPingIntervalMs: 60000, wsPongTimeoutMs: 30000 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    for (let i = 0; i < 50 && phone.bytes().length < expected.length; i++) await sleep(20);
    assert.equal(phone.bytes().length, expected.length, `转发字节总数应一致，实际 ${phone.bytes().length} 期望 ${expected.length}`);
    assert.ok(phone.bytes().equals(expected), '转发字节流必须与上游逐字节一致（head 拆帧场景不得错位）');
    phone.socket.destroy();
  } finally {
    proxy.server.closeAllConnections?.(); proxy.server.close();
    for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } }
    server.closeAllConnections?.(); server.close();
  }
});
