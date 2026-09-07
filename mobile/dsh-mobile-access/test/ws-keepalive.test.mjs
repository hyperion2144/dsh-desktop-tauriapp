// WS 空闲保活（帧感知泵）测试：ping 注入、活跃不注入、字节保真、pong 超时判死、
// 客户端活跃保命、关闭回退 raw pipe、异常帧头回退 raw。
// 夹具模拟手机链路：上游 = dsh（服务器帧，未掩码）；客户端 = 手机浏览器（自动回 pong，
// 测试里用「静默」或「定时写字节」两种形态模拟）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRewriteProxy, WS_PING_FRAME, wsFrameLength } from '../lib/proxy.mjs';

const UP_101 = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n';
const PHONE_HEADERS = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'AQIDBAUGBwgJCgsMDQ4P',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 服务器→客户端帧（未掩码）。opcode: 0x1 text / 0x2 binary / 0x0 continuation / 0x9 ping。 */
function serverFrame(opcode, payload, { fin = true } = {}) {
  const b0 = (fin ? 0x80 : 0x00) | opcode;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([b0, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = b0;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = b0;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 客户端→服务器帧（必须掩码；默认全零掩码 = 载荷原样，合法）。 */
function maskedFrame(opcode, payload) {
  const mask = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else {
    header = Buffer.alloc(12);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    header.set(mask, 10);
  }
  return Buffer.concat([header, mask, payload]);
}

/** 把收到的字节流按 WS 信封切开（信封解析与 lib 内同源函数保持一致）。 */
function parseFrames(all) {
  const frames = [];
  let off = 0;
  while (off < all.length) {
    const n = wsFrameLength(all, off);
    if (n <= 0) break;
    frames.push(all.subarray(off, off + n));
    off += n;
  }
  return { frames, tail: all.subarray(off) };
}

/** 安静上游：接受 upgrade 后不发任何字节；port/close 供测试用。 */
async function startQuietUpstream() {
  const sockets = new Set();
  const server = http.createServer((_q, r) => r.end());
  server.on('connection', (s) => sockets.add(s));
  server.on('upgrade', (_req, sock) => {
    sockets.add(sock);
    sock.write(UP_101);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    close: () => { for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } } server.closeAllConnections?.(); server.close(); },
  };
}

/** 手机侧客户端：向 lane 发起 upgrade，收集全部入站字节；closed 在 socket 关闭时兑现。 */
function phoneConnect(lanePort, path = '/api/remote.mux') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('phone upgrade timeout')), 5000);
    const req = http.request(`http://127.0.0.1:${lanePort}${path}`, { headers: PHONE_HEADERS });
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      socket.on('error', () => {});
      // 上游 101 与首帧数据合并写入同一 TCP 段时，Node 把剩余字节交给 head 参数
      // （真实浏览器同样消费 head），必须并入收集器，否则首帧丢失。
      const chunks = head?.length ? [head] : [];
      socket.on('data', (c) => chunks.push(c));
      const closed = new Promise((r) => socket.once('close', () => r()));
      resolve({ socket, bytes: () => Buffer.concat(chunks), closed });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

async function listen(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s.address().port; }

function closeProxy(proxy) { proxy.server.closeAllConnections?.(); proxy.server.close(); }

test('空闲 WS：上游静默时 lane 在帧边界持续注入 ping（帧即 WS_PING_FRAME）', async () => {
  const up = await startQuietUpstream();
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, wsPingIntervalMs: 60, wsPongTimeoutMs: 60000 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    await sleep(350);
    const { frames } = parseFrames(phone.bytes());
    const pings = frames.filter((f) => (f[0] & 0x0f) === 0x09);
    assert.ok(pings.length >= 3, `上游静默期间应收到多次 ping，实际 ${pings.length}`);
    for (const p of pings) assert.ok(p.equals(WS_PING_FRAME), 'ping 帧必须精确等于 89 00（未掩码零负载）');
    phone.socket.destroy();
  } finally { closeProxy(proxy); up.close(); }
});

test('活跃 WS：上游持续发帧时零注入（只在真空闲时才 ping）', async () => {
  const sockets = new Set();
  const server = http.createServer((_q, r) => r.end());
  server.on('connection', (s) => sockets.add(s));
  server.on('upgrade', (_req, sock) => {
    sockets.add(sock);
    sock.write(UP_101);
    const timer = setInterval(() => { try { sock.write(serverFrame(0x01, Buffer.from('tick'))); } catch { /* noop */ } }, 30);
    sock.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const up = { port: server.address().port, close: () => { for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } } server.closeAllConnections?.(); server.close(); } };
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, wsPingIntervalMs: 200, wsPongTimeoutMs: 60000 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    await sleep(600);
    const { frames } = parseFrames(phone.bytes());
    const text = frames.filter((f) => (f[0] & 0x0f) === 0x01);
    const pings = frames.filter((f) => (f[0] & 0x0f) === 0x09);
    assert.ok(text.length >= 15, `上游 30ms 一帧应转发全部数据帧，实际 ${text.length}`);
    assert.equal(pings.length, 0, '上游持续活跃（间隔 30ms < 200ms）不应注入任何 ping');
    for (const f of text) assert.equal(f.subarray(2).toString(), 'tick', '数据帧载荷必须原样');
    phone.socket.destroy();
  } finally { closeProxy(proxy); up.close(); }
});

test('帧泵字节保真：u64 大帧 + 16 位长度帧 + 分片帧，任意分块写入不丢不乱', async () => {
  const big = Buffer.from('B'.repeat(200000));          // >65535 → 127 路径（u64 长度）
  const mid = Buffer.from('S'.repeat(1000));            // 126..65535 → 16 位长度
  const frag = Buffer.concat([
    serverFrame(0x01, Buffer.from('hel'), { fin: false }),
    serverFrame(0x00, Buffer.from('lo'), { fin: false }),
    serverFrame(0x00, Buffer.from('!'), { fin: true }),
  ]);
  const expected = Buffer.concat([serverFrame(0x02, big), serverFrame(0x02, mid), frag]);
  const sockets = new Set();
  const server = http.createServer((_q, r) => r.end());
  server.on('connection', (s) => sockets.add(s));
  server.on('upgrade', async (_req, sock) => {
    sockets.add(sock);
    sock.write(UP_101);
    // 以 997 字节为界任意切分写入（切点必然落在帧头/载荷中间），间隔让 TCP 真分块
    for (let off = 0; off < expected.length; off += 997) {
      sock.write(expected.subarray(off, Math.min(off + 997, expected.length)));
      await sleep(0);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const up = { port: server.address().port, close: () => { for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } } server.closeAllConnections?.(); server.close(); } };
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, wsPingIntervalMs: 5000, wsPongTimeoutMs: 10000 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    for (let i = 0; i < 100 && phone.bytes().length < expected.length; i++) await sleep(50);
    assert.equal(phone.bytes().length, expected.length, '转发的字节总数必须与上游一致');
    assert.ok(phone.bytes().equals(expected), '转发字节流必须与上游逐字节一致（含帧边界）');
    phone.socket.destroy();
  } finally { closeProxy(proxy); up.close(); }
});

test('pong 超时：客户端静默 → lane 判定链路死亡并主动断开（不挂僵尸连接）', async () => {
  const up = await startQuietUpstream();
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, wsPingIntervalMs: 60, wsPongTimeoutMs: 80 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    const closed = await Promise.race([
      phone.closed.then(() => true),
      sleep(2000).then(() => false),
    ]);
    assert.equal(closed, true, 'ping 后 80ms 内无任何回包应触发 teardown 断开手机侧 socket');
  } finally { closeProxy(proxy); up.close(); }
});

test('客户端活跃（回 pong）：不判死，长连接保持', async () => {
  const up = await startQuietUpstream();
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, wsPingIntervalMs: 60, wsPongTimeoutMs: 80 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    // 每 30ms 回一个零负载 pong（掩码帧）——浏览器协议栈在真机上自动做的事
    const timer = setInterval(() => { try { phone.socket.write(maskedFrame(0x8a, Buffer.alloc(0))); } catch { /* noop */ } }, 30);
    await sleep(500);
    clearInterval(timer);
    let closed = false;
    const mark = phone.closed.then(() => { closed = true; });
    await Promise.race([mark, sleep(50)]);
    assert.equal(closed, false, '客户端有回包（pong）时不得判死');
    phone.socket.destroy();
  } finally { closeProxy(proxy); up.close(); }
});

test('wsPingIntervalMs=0：关闭保活，回到 raw pipe（非帧字节原样透传）', async () => {
  const sockets = new Set();
  const server = http.createServer((_q, r) => r.end());
  server.on('connection', (s) => sockets.add(s));
  server.on('upgrade', (_req, sock) => {
    sockets.add(sock);
    sock.write(UP_101);
    sock.on('data', (d) => sock.write(d)); // raw 回声
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const up = { port: server.address().port, close: () => { for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } } server.closeAllConnections?.(); server.close(); } };
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, wsPingIntervalMs: 0 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    phone.socket.write(Buffer.from('RAW-NON-FRAME-BYTES'));
    await sleep(200);
    assert.ok(phone.bytes().includes(Buffer.from('RAW-NON-FRAME-BYTES')), '关闭保活后必须回到字节级透传');
    phone.socket.destroy();
  } finally { closeProxy(proxy); up.close(); }
});

test('帧头声明非法（超长 u64）→ 一次性回退 raw 透传，字节不丢不乱', async () => {
  const bad = Buffer.from([0x81, 0x7f, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]); // u64 = 2^32+ → 超上限
  const after = Buffer.from('raw-check-after-fallback');
  const sockets = new Set();
  const server = http.createServer((_q, r) => r.end());
  server.on('connection', (s) => sockets.add(s));
  server.on('upgrade', (_req, sock) => {
    sockets.add(sock);
    sock.write(UP_101);
    sock.write(bad);
    setTimeout(() => sock.write(after), 50);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const up = { port: server.address().port, close: () => { for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } } server.closeAllConnections?.(); server.close(); } };
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, wsPingIntervalMs: 5000, wsPongTimeoutMs: 10000 });
  const lp = await listen(proxy.server);
  try {
    const phone = await phoneConnect(lp);
    for (let i = 0; i < 40 && phone.bytes().length < bad.length + after.length; i++) await sleep(25);
    const expect = Buffer.concat([bad, after]);
    assert.ok(phone.bytes().subarray(0, expect.length).equals(expect), '回退后必须逐字节透传（非法帧头 + 后续字节）');
    phone.socket.destroy();
  } finally { closeProxy(proxy); up.close(); }
});
