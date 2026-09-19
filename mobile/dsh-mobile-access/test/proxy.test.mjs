import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRewriteProxy, POLYFILL, desktopEnvPatchScript } from '../lib/proxy.mjs';

function startUpstream() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const sfs = req.headers['sec-fetch-site'] ?? null;
    const html = req.url === '/' ? '<html><head></head><body>hello</body></html>' : JSON.stringify({ url: req.url, host: req.headers['host'], origin: req.headers['origin'] ?? null, sfs });
    res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html' : 'application/json' });
    res.end(html);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
    socket.on('close', () => sockets.delete(socket));
  });
  return { server, closeAll: () => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(); } };
}

async function listen(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s.address().port; }

function getRaw(u, headers) {
  return new Promise((resolve, reject) => {
    http.get(u, { headers: { Connection: 'close', ...headers } }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}

test('改写反代：外部 Host 归一为 loopback + HTML 注入', async () => {
  const up = startUpstream();
  const upPort = await listen(up.server);
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: upPort, inject: ['<tag-mobile-inject/>'] });
  const lp = await listen(proxy.server);
  try {
    const json = JSON.parse((await getRaw('http://127.0.0.1:' + lp + '/status', { Host: 'ext.cpolar.cn', Origin: 'https://ext.cpolar.cn' })).body);
    assert.equal(json.host, '127.0.0.1:' + upPort);
    assert.equal(json.origin, 'http://127.0.0.1:' + upPort);
    const html = (await getRaw('http://127.0.0.1:' + lp + '/', { Host: 'ext.cpolar.cn' })).body;
    assert.ok(html.includes('<tag-mobile-inject/>'));
  } finally { proxy.server.closeAllConnections?.(); proxy.server.close(); up.closeAll(); }
});

test('auth 钩子：未配对 401', async () => {
  const up = startUpstream();
  const upPort = await listen(up.server);
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: upPort, inject: [], auth: () => ({ ok: false }) });
  const lp = await listen(proxy.server);
  try {
    const r = await getRaw('http://127.0.0.1:' + lp + '/', { Host: 'x.cn' });
    assert.equal(r.status, 401);
    assert.ok(r.body.includes('unpaired'));
  } finally { proxy.server.closeAllConnections?.(); proxy.server.close(); up.closeAll(); }
});

test('WebSocket upgrade 透传：101 + 字节回声', async () => {
  const up = startUpstream();
  const upPort = await listen(up.server);
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: upPort, inject: [] });
  const lp = await listen(proxy.server);
  try {
    const echo = await upgradeEcho('http://127.0.0.1:' + lp + '/ws', { Origin: 'https://ext.cpolar.cn' });
    assert.equal(echo.status, 101);
    assert.ok(echo.echo.equals(maskedPingFrame(Buffer.from('ping-payload'))), '回声必须逐字节等于发出的掩码帧');
  } finally { proxy.server.closeAllConnections?.(); proxy.server.close(); up.closeAll(); }
});

/** 客户端→服务器方向的合法 WS 帧（必须掩码；全零掩码 = 载荷原样）。 */
function maskedPingFrame(payload, opcode = 0x89) {
  const mask = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, payload]);
}
function upgradeEcho(u, headers) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upgrade timeout')), 5000);
    const req = http.request(u, { headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'AQIDBAUGBwgJCgsMDQ4P' } });
    req.on('upgrade', (res, socket) => {
      const probe = maskedPingFrame(Buffer.from('ping-payload'));
      socket.write(probe);
      socket.once('data', (d) => { clearTimeout(timer); resolve({ status: res.statusCode, echo: d }); socket.destroy(); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

test('注入脚本产物', () => {
  assert.ok(POLYFILL.includes('data-dsh-mobile-polyfill'));
  assert.ok(POLYFILL.includes('randomUUID'));
  const p = desktopEnvPatchScript('darwin');
  assert.ok(p.includes('dsh-desktop-mode'));
  assert.ok(p.includes('darwin'));
});

test('压缩 HTML：跳过注入并触发 onInjectSkip 告警（不静默）', async () => {
  const gz = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    // gzip 是声明的而非真实压缩——反代应按声明跳过注入（内容原样透传即可）。
    res.end(Buffer.from('<html><body>compressed</body></html>'));
  });
  await new Promise((r) => gz.listen(0, '127.0.0.1', r));
  const skipped = [];
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: gz.address().port, inject: ['<tag/>'], onInjectSkip: (p) => skipped.push(p) });
  const lp = await listen(proxy.server);
  try {
    const r = await getRaw('http://127.0.0.1:' + lp + '/page', { Host: 'x.cn' });
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes('<tag/>'), '压缩响应不应注入');
    assert.deepEqual(skipped, ['/page']);
  } finally {
    proxy.server.closeAllConnections?.(); proxy.server.close();
    gz.closeAllConnections?.(); gz.close();
  }
});
test('WS 传输中客户端暴力断开：不产生未捕获异常（EPIPE 崩溃回归）', async () => {
  // 上游 WS 服务器：接受 upgrade 后持续给客户端发数据
  const upstream = http.createServer((_q, _r) => { _r.end(); });
  upstream.on('upgrade', (_req, sock) => {
    sock.on('error', () => {}); // 客户端暴力断开后上游写 EPIPE，静默（测试夹具自身）
    const timer = setInterval(() => { try { sock.write(Buffer.from([0x81, 0x01, 0x78])); } catch { /* noop */ } }, 10); // 合法 text 帧 'x'（上游→客户端帧感知泵要求帧化数据）
    sock.on('close', () => clearInterval(timer));
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: upstream.address().port });
  const lp = await listen(proxy.server);
  const unhandled = [];
  const origOn = process.listeners('uncaughtException').slice();
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (e) => { unhandled.push(String(e?.message ?? e)); });
  try {
    const req = http.request('http://127.0.0.1:' + lp + '/ws', {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'AQIDBAUGBwgJCgsMDQ4P' },
    });
    await new Promise((resolve, reject) => {
      req.on('upgrade', (_r, sock) => {
        sock.on('error', () => {}); // 测试客户端 socket 静默
        sock.once('data', () => { sock.destroy(); resolve(); });
      });
      req.on('error', reject);
      req.end();
    });
    // 等代理侧 teardown（含 2s 强制销毁兜底）传播完，确认全程无 uncaught
    await new Promise((r) => setTimeout(r, 2600));
    assert.deepEqual(unhandled, [], '代理不应产生未捕获异常（会打崩 dsh 进程）');
  } finally {
    process.removeAllListeners('uncaughtException');
    for (const l of origOn) process.on('uncaughtException', l);
    proxy.server.closeAllConnections?.(); proxy.server.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});

test('大 JSON/文本响应流式压缩（gzip），SSE 原样透传', async () => {
  const up = http.createServer((q, res) => {
    if (q.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: 'x'.repeat(5000) }));
    } else if (q.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: 1\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('small');
    }
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.address().port });
  const lp = await listen(proxy.server);
  try {
    // 大 JSON → gzip
    const big = await fetch('http://127.0.0.1:' + lp + '/big', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(big.headers.get('content-encoding'), 'gzip');
    const bigBody = await big.text();
    // fetch 自动解压 gzip；验证内容完整
    assert.ok(bigBody.includes('"data"'));
    // SSE → 原样（不压缩）
    const sse = await fetch('http://127.0.0.1:' + lp + '/sse', { headers: { 'accept-encoding': 'gzip' } });
    assert.ok(!sse.headers.get('content-encoding'), 'SSE 不应压缩');
    assert.ok((await sse.text()).includes('event: a'));
    // 小文本（chunked 无 content-length）→ 压缩无害，内容必须正确
    const small = await fetch('http://127.0.0.1:' + lp + '/small', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(await small.text(), 'small');
  } finally {
    proxy.server.closeAllConnections?.(); proxy.server.close();
    up.closeAllConnections?.(); up.close();
  }
});

test('401 重换重放 + 流式响应：重放后逐块到达、不破坏流', async () => {
  // 验收③：上游 401 → lane 重换凭证 → 原样重放 → 重放响应为 chunked 流式且逐块透传
  let refreshes = 0;
  const upstreamAuth = {
    applyTo(h) { if (refreshes > 0) h.cookie = 'dsh-session=replayed'; },
    async refresh() { refreshes += 1; return true; },
    hasCredential() { return true; },
  };
  const up = http.createServer((q, res) => {
    if (refreshes === 0) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"events":["a","b"');
    setTimeout(() => res.write(',"c"]'), 60);
    setTimeout(() => res.end('}'), 140);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.address().port, upstreamAuth });
  const lp = await listen(proxy.server);
  try {
    const chunks = [];
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${lp}/api/events`, { headers: { 'accept-encoding': 'identity' } }, (res) => {
        assert.equal(res.statusCode, 200, '重换后重放应成功（401 不透传）');
        res.on('data', (c) => chunks.push(c));
        res.on('end', resolve);
      }).on('error', reject);
    });
    assert.ok(chunks.length >= 2, `流式响应应逐块到达（重放未破坏流），实际 ${chunks.length} 块`);
    assert.equal(Buffer.concat(chunks).toString(), '{"events":["a","b","c"]}');
    assert.equal(refreshes, 1, '只重试一次（不死循环）');
  } finally {
    proxy.server.closeAllConnections?.(); proxy.server.close();
    up.closeAllConnections?.(); up.close();
  }
});

test('#78 回归：改写转发补齐 sec-fetch-site 同源信号（HTTP）', async () => {
  const up = startUpstream();
  const upPort = await listen(up.server);
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: upPort, inject: [] });
  const lp = await listen(proxy.server);
  try {
    // 手机老内核场景：不发 Sec-Fetch-* 头、同源 GET 也不带 Origin → lane 补 same-origin
    const bare = JSON.parse((await getRaw('http://127.0.0.1:' + lp + '/status', { Host: '5.tcp.cpolar.top:12710' })).body);
    assert.equal(bare.sfs, 'same-origin');
    // 显式值不覆盖：真正跨站请求仍由上游守卫拒绝（不引入新开放面）
    const explicit = JSON.parse((await getRaw('http://127.0.0.1:' + lp + '/status', { Host: 'ext.cpolar.cn', 'sec-fetch-site': 'cross-site' })).body);
    assert.equal(explicit.sfs, 'cross-site');
  } finally { proxy.server.closeAllConnections?.(); proxy.server.close(); up.closeAll(); }
});

test('#78 回归：WS upgrade 请求同样补齐 sec-fetch-site（mux 握手路径）', async () => {
  // 上游捕获 upgrade 请求的 sec-fetch-site，写入首帧回给客户端
  let captured = null;
  const upstream = http.createServer((_q, r) => { r.end(); });
  upstream.on('upgrade', (req, sock) => {
    captured = req.headers['sec-fetch-site'] ?? null;
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n');
    sock.end(Buffer.from([0x81, 0x01, 0x6f])); // 合法 text 帧 'o' 作首帧信号
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = createRewriteProxy({ upstreamHost: '127.0.0.1', upstreamPort: upstream.address().port, inject: [] });
  const lp = await listen(proxy.server);
  try {
    const req = http.request('http://127.0.0.1:' + lp + '/api/remote.mux', {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'AQIDBAUGBwgJCgsMDQ4P' },
    });
    await new Promise((resolve, reject) => {
      req.on('upgrade', (_r, sock, head) => { sock.on('error', () => {}); const finish = () => { sock.destroy(); resolve(); }; if (head?.length) finish(); else sock.once('data', finish); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(captured, 'same-origin');
  } finally {
    proxy.server.closeAllConnections?.(); proxy.server.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});
