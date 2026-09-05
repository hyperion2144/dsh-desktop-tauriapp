import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMobileAccessService, parseCookie } from '../lib/index.mjs';
import { createMemoryStorage } from '../lib/pairing.mjs';

function startStub() { const s = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('upstream'); }); return s; }

const HQ = { Connection: 'close' };
async function textGet(u, opt = {}) {
  const res = await fetch(u, { method: opt.method ?? 'GET', headers: { ...HQ, ...(opt.headers ?? {}) }, body: opt.body });
  return { status: res.status, text: await res.text() };
}

async function jget(u, opt = {}) {
  const res = await fetch(u, { method: opt.method ?? 'GET', headers: { 'content-type': 'application/json', ...HQ, ...(opt.headers ?? {}) }, body: opt.body });
  const body = await res.text();
  return { status: res.status, setCookie: String(res.headers.get('set-cookie') ?? ''), body: body ? JSON.parse(body) : null };
}

test('服务装配：配对路由全链路', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port, platform: 'darwin' });
  const lp = await svc.listen();
  try {
    const pairPre = await jget('http://127.0.0.1:' + lp + '/pair');
    assert.equal(pairPre.body.ok, true);
    const bad = await jget('http://127.0.0.1:' + lp + '/api/pair/accept', { method: 'POST', body: JSON.stringify({ token: 'nope' }) });
    assert.equal(bad.status, 403);
    const token = svc.store.mint();
    const acc = await jget('http://127.0.0.1:' + lp + '/api/pair/accept', { method: 'POST', body: JSON.stringify({ token, name: 'Pixel 9' }) });
    assert.equal(acc.status, 200);
    const cookie = acc.setCookie;
    assert.ok(cookie.includes('dsh_mobile_session='));
    const hdr = { cookie: cookie.split(';')[0] };
    const dev = await jget('http://127.0.0.1:' + lp + '/api/pair/devices', { headers: hdr });
    assert.equal(dev.body.devices.length, 1);
    assert.equal(dev.body.devices[0].name, 'Pixel 9');
    assert.equal(dev.body.tokenRef, '');
    const up = await textGet('http://127.0.0.1:' + lp + '/x', { headers: hdr });
    assert.equal(up.text, 'upstream');
    const stop = await jget('http://127.0.0.1:' + lp + '/api/pair/stop', { method: 'POST', body: '{}' });
    assert.equal(stop.body.ok, true);
    assert.equal(svc.store.snapshotDevices().length, 0, 'stop 后设备表已清空');
    const dev2 = await jget('http://127.0.0.1:' + lp + '/api/pair/devices', { headers: hdr });
    assert.equal(dev2.status, 200, '属主 loopback 仍可查看状态');
    assert.equal(dev2.body.devices.length, 0, '停止访问后设备列表为空');
    // 隧道形态下原设备 cookie 已失效
    const tunnelGot = await jget('http://127.0.0.1:' + lp + '/api/pair/devices', {
      headers: { ...hdr, Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(tunnelGot.status, 401, '停止访问后隧道侧原 cookie 立即失效');
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('控制端点鉴权：隧道访问（外部 Host+XFF）匿名一律 401；属主 loopback 放行', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  const tunnel = { headers: { Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7' } };
  const h = (u, opt = {}) => jget(u, { ...tunnel, ...opt, method: opt.method ?? 'GET' });
  const probe = async (u, opt = {}) => (await h(u, opt)).status;
  try {
    // 隧道（公网）匿名：控制端点一律 401
    assert.equal(await probe('http://127.0.0.1:' + lp + '/api/pair/devices'), 401, '隧道 devices 匿名 401');
    assert.equal(await probe('http://127.0.0.1:' + lp + '/api/pair/stop', { method: 'POST', body: '{}' }), 401, '隧道 stop 匿名 401');
    assert.equal(await probe('http://127.0.0.1:' + lp + '/api/pair/events'), 401, '隧道 events 匿名 401');
    assert.equal(await probe('http://127.0.0.1:' + lp + '/api/pair/mint', { method: 'POST', body: '{}' }), 401, '隧道 mint 匿名 401');
    // 前缀豁免绕过探针：非路由表内的 /api/pair/* 不得放行到上游
    assert.equal(await probe('http://127.0.0.1:' + lp + '/api/pair/unknown'), 401, '隧道未知 /api/pair/* 匿名 401');
    // 非配对前缀的普通路径同样 401
    assert.equal((await textGet('http://127.0.0.1:' + lp + '/x', tunnel)).status, 401, '隧道普通路径匿名 401');
    // 属主 loopback（直连 lane）：控制端点放行，无需 cookie
    assert.equal((await jget('http://127.0.0.1:' + lp + '/api/pair/devices')).status, 200, '属主 devices 放行');
    assert.equal((await jget('http://127.0.0.1:' + lp + '/api/pair/mint', { method: 'POST', body: '{}' })).status, 200, '属主 mint 放行');
    assert.equal((await jget('http://127.0.0.1:' + lp + '/api/pair/stop', { method: 'POST', body: '{}' })).status, 200, '属主 stop 放行');
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('属主 mint 铸造令牌：旧令牌作废 + 可配对', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  try {
    const t1 = await jget('http://127.0.0.1:' + lp + '/api/pair/mint', { method: 'POST', body: '{}' });
    assert.equal(t1.status, 200);
    assert.ok(t1.body.token.length >= 32, '令牌为 128bit hex');
    const oldToken = t1.body.token;
    const t2 = await jget('http://127.0.0.1:' + lp + '/api/pair/mint', { method: 'POST', body: '{}' });
    assert.notEqual(t2.body.token, oldToken, '新令牌不同');
    // 旧令牌作废
    const bad = await jget('http://127.0.0.1:' + lp + '/api/pair/accept', { method: 'POST', body: JSON.stringify({ token: oldToken }) });
    assert.equal(bad.status, 403, '旧令牌不能再配对');
    const acc = await jget('http://127.0.0.1:' + lp + '/api/pair/accept', { method: 'POST', body: JSON.stringify({ token: t2.body.token }) });
    assert.equal(acc.status, 200, '新令牌可配对');
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('probe 隧道地址校验：拒绝 loopback/tuna/非法，放行可达外部地址', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  // 注入 fetchImpl：外部域名直达 stub（模拟第三方隧道指向本机 lane 端口的可达性）
  const svc = createMobileAccessService({
    upstreamPort: stub.address().port,
    fetchImpl: (u) => fetch('http://127.0.0.1:' + stub.address().port + new URL(u).pathname),
  });
  const lp = await svc.listen();
  try {
    // 匿名 401
    assert.equal((await jget('http://127.0.0.1:' + lp + '/api/pair/probe?url=https%3A%2F%2Fx.cn', {
      headers: { Host: 't.cn', 'x-forwarded-for': '1.2.3.4' },
    })).status, 401);
    // loopback / tauri.localhost / 非法 URL 拒绝
    const loop = await jget('http://127.0.0.1:' + lp + '/api/pair/probe?url=' + encodeURIComponent('https://127.0.0.1:9/x'));
    assert.equal(loop.body.ok, false);
    assert.equal(loop.body.reason, 'loopback-or-tuna-not-allowed');
    const tuna = await jget('http://127.0.0.1:' + lp + '/api/pair/probe?url=' + encodeURIComponent('https://x.tauri.localhost'));
    assert.equal(tuna.body.reason, 'loopback-or-tuna-not-allowed');
    const bad = await jget('http://127.0.0.1:' + lp + '/api/pair/probe?url=' + encodeURIComponent('not a url'));
    assert.equal(bad.body.reason, 'invalid-url');
    // 可达外部地址（用本机 stub 模拟第三方隧道：Host 非 loopback 但指向本机端口）
    const ok = await jget('http://127.0.0.1:' + lp + '/api/pair/probe?url=' + encodeURIComponent('http://ext.example.com:' + stub.address().port));
    assert.equal(ok.body.ok, true, '可达外部地址放行：' + JSON.stringify(ok.body));
    assert.equal(ok.body.reason, 'reachable');
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('SSE 事件路由：属主 loopback 放行，隧道必须已配对 cookie', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  try {
    // 隧道匿名 401
    const tunnelAnon = await fetch('http://127.0.0.1:' + lp + '/api/pair/events', {
      headers: { ...HQ, Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(tunnelAnon.status, 401);
    await tunnelAnon.body?.cancel();
    // 属主 loopback 匿名放行
    const owner = await fetch('http://127.0.0.1:' + lp + '/api/pair/events', { headers: HQ });
    assert.ok(String(owner.headers.get('content-type')).includes('text/event-stream'));
    await owner.body?.cancel();
    // 配对后隧道侧凭 cookie 放行
    const token = svc.store.mint();
    const acc = await jget('http://127.0.0.1:' + lp + '/api/pair/accept', { method: 'POST', body: JSON.stringify({ token }) });
    const cookie = acc.setCookie.split(';')[0];
    const res = await fetch('http://127.0.0.1:' + lp + '/api/pair/events', {
      headers: { ...HQ, Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7', cookie },
    });
    assert.ok(String(res.headers.get('content-type')).includes('text/event-stream'));
    await res.body?.cancel();
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('parseCookie', () => {
  assert.equal(parseCookie('a=1; dsh_mobile_session=abc; b=2', 'dsh_mobile_session'), 'abc');
  assert.equal(parseCookie('', 'x'), '');
});


test('cloudflared 控制端点：属主 GET 状态 + 隧道侧 401', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  try {
    // 初始状态：未配置
    const init = await jget('http://127.0.0.1:' + lp + '/api/pair/cloudflared');
    assert.equal(init.status, 200);
    assert.equal(init.body.bin, '');
    assert.equal(init.body.running, false);
    // 隧道匿名 401
    const tunnelAnon = await fetch('http://127.0.0.1:' + lp + '/api/pair/cloudflared', {
      headers: { ...HQ, Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(tunnelAnon.status, 401);
    // POST 非字符串 bin → 400
    const bad = await jget('http://127.0.0.1:' + lp + '/api/pair/cloudflared', { method: 'POST', body: JSON.stringify({ bin: 123 }) });
    assert.equal(bad.status, 400);
    // POST 空串 = 清除配置并停止
    const clear = await jget('http://127.0.0.1:' + lp + '/api/pair/cloudflared', { method: 'POST', body: JSON.stringify({ bin: '' }) });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.running, false);
    // handler 契约：空 bin 返回 null（auto 模式语义）；并 stop 防自动解析拉起真隧道子进程阻塞进程退出
    assert.equal(clear.body.bin, null);
  } finally {
    await jget('http://127.0.0.1:' + lp + '/api/pair/cloudflared', { method: 'POST', body: JSON.stringify({ action: 'stop' }) }).catch(() => {});
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('cloudflared 控制端点：POST 应用配置会写 settings.yaml 并尝试启动（假 bin 启动失败但状态可达）', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  const testDir = process.env.DSH_HOME;
  process.env.DSH_HOME = '/nonexistent-dsh-home-' + Date.now(); // 写入会失败 → persisted:false，但运行状态仍可查询
  try {
    const res = await jget('http://127.0.0.1:' + lp + '/api/pair/cloudflared', {
      method: 'POST',
      body: JSON.stringify({ bin: '/nonexistent/cloudflared' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.bin, '/nonexistent/cloudflared');
    assert.equal(res.body.persisted, false); // DSH_HOME 不可写
    // GET 反映运行状态（child 已 spawn 但大概率立刻退出）
    const st = await jget('http://127.0.0.1:' + lp + '/api/pair/cloudflared');
    assert.equal(st.body.bin, '/nonexistent/cloudflared');
    // 停止
    const stop = await jget('http://127.0.0.1:' + lp + '/api/pair/cloudflared', { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.running, false);
  } finally {
    process.env.DSH_HOME = testDir;
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('浏览器配对：GET /pair?token= 自动接受 + 302 + cookie', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  try {
    const token = svc.store.mint();
    const res = await fetch('http://127.0.0.1:' + lp + '/pair?token=' + token, {
      headers: { ...HQ, Accept: 'text/html', 'user-agent': 'iPhone Safari' },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    const sc = String(res.headers.get('set-cookie') ?? '');
    assert.ok(sc.includes('dsh_mobile_session='));
    // 设备已入列表（UA 推断名称）
    const devs = svc.store.snapshotDevices();
    assert.equal(devs.length, 1);
    assert.equal(devs[0].name, 'iPhone');
    // 令牌一次性：再用 302 → 无效
    const again = await fetch('http://127.0.0.1:' + lp + '/pair?token=' + token, {
      headers: { ...HQ, Accept: 'text/html' },
      redirect: 'manual',
    });
    assert.equal(again.status, 200); // HTML 配对失败页
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('浏览器配对：无效 token → HTML 提示页；API → 403 JSON', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  try {
    const badHtml = await fetch('http://127.0.0.1:' + lp + '/pair?token=nope', {
      headers: { ...HQ, Accept: 'text/html' },
    });
    assert.equal(badHtml.status, 200);
    assert.ok(String(badHtml.headers.get('content-type')).includes('text/html'));
    const badApi = await fetch('http://127.0.0.1:' + lp + '/pair?token=nope', { headers: { ...HQ, Accept: 'application/json' } });
    assert.equal(badApi.status, 403);
    const body = await badApi.json();
    assert.equal(body.error, 'invalid-token');
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('配对候选地址 /api/pair/info：属主放行，隧道匿名 401', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  try {
    const info = await jget('http://127.0.0.1:' + lp + '/api/pair/info');
    assert.equal(info.status, 200);
    assert.equal(typeof info.body.lanIp, 'string');
    assert.equal(info.body.lanePort, lp);
    assert.equal(info.body.tunnelUrl, null);
    const anon = await fetch('http://127.0.0.1:' + lp + '/api/pair/info', {
      headers: { ...HQ, Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(anon.status, 401);
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('设备移除：属主可删除单个设备', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  try {
    // 造两个设备
    svc.store.mint();
    const t1 = svc.store.mint();
    const acc1 = svc.store.accept(t1, { name: 'Pixel' });
    // 移除
    const rm = await jget('http://127.0.0.1:' + lp + '/api/pair/remove', { method: 'POST', body: JSON.stringify({ deviceId: acc1.deviceId }) });
    assert.equal(rm.status, 200);
    assert.equal(svc.store.snapshotDevices().length, 0);
    // 移除不存在 → 404
    const rm404 = await jget('http://127.0.0.1:' + lp + '/api/pair/remove', { method: 'POST', body: JSON.stringify({ deviceId: 'nope' }) });
    assert.equal(rm404.status, 404);
    // 隧道匿名 401
    const anon = await fetch('http://127.0.0.1:' + lp + '/api/pair/remove', {
      method: 'POST', headers: { ...HQ, Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7' }, body: '{}',
    });
    assert.equal(anon.status, 401);
  } finally {
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

test('第三方隧道地址保存：POST /api/pair/tunnel 持久化并经 info 返回', async () => {
  const stub = startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const svc = createMobileAccessService({ storage: createMemoryStorage(), upstreamPort: stub.address().port });
  const lp = await svc.listen();
  const testDir = process.env.DSH_HOME;
  process.env.DSH_HOME = '/nonexistent-dsh-home-' + Date.now(); // 持久化失败但 API 仍应答
  try {
    const bad = await jget('http://127.0.0.1:' + lp + '/api/pair/tunnel', { method: 'POST', body: JSON.stringify({ url: 'not-a-url' }) });
    assert.equal(bad.status, 400);
    const ok = await jget('http://127.0.0.1:' + lp + '/api/pair/tunnel', { method: 'POST', body: JSON.stringify({ url: 'https://abc.cpolar.cn' }) });
    assert.equal(ok.status, 200);
    const info = await jget('http://127.0.0.1:' + lp + '/api/pair/info');
    assert.equal(info.body.customTunnelUrl, 'https://abc.cpolar.cn');
  } finally {
    process.env.DSH_HOME = testDir;
    svc.proxy.server.closeAllConnections?.(); stub.closeAllConnections?.();
    await svc.close();
    stub.close();
  }
});

// ---------------------------------------------------------------------------
// dsh 0.1.2-rc.1+ 会话凭证（#26）：鉴权剧本 mock 上游 + lane 自愈链路
//
function startAuthStub() {
  const state = { token: 'tok-1', secret: 'sig-1', tokenEnabled: true, exchangeCount: 0, unauthorizedCount: 0 };
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // dsh token 交换语义：GET /?token= 正确 → 303 + Set-Cookie；错误/缺失 → 无 Set-Cookie
    if (req.method === 'GET' && u.pathname === '/' && u.searchParams.get('token')) {
      state.exchangeCount++;
      if (state.tokenEnabled && u.searchParams.get('token') === state.token) {
        res.writeHead(303, { location: '/', 'set-cookie': 'dshtest=' + state.secret + '; Path=/; HttpOnly; SameSite=Strict' });
      } else {
        res.writeHead(401, { 'content-type': 'text/plain' });
      }
      res.end();
      return;
    }
    const authed = String(req.headers.cookie ?? '').includes('dshtest=' + state.secret);
    if (!authed) {
      state.unauthorizedCount++;
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('dsh web authentication required');
      return;
    }
    if (u.pathname === '/api/echo' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ got: b })); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body>hello</body></html>');
  });
  s.state = state;
  return s;
}

async function makeAuthedPair() {
  const stub = startAuthStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  return {
    stub,
    opts: {
      storage: createMemoryStorage(),
      upstreamPort: stub.address().port,
      authenticatedUrl: () => (stub.state.tokenEnabled
        ? 'http://127.0.0.1:' + stub.address().port + '/?token=' + stub.state.token
        : null),
    },
  };
}

async function pairDevice(svc, lp) {
  const token = svc.store.mint();
  const acc = await jget('http://127.0.0.1:' + lp + '/api/pair/accept', { method: 'POST', body: JSON.stringify({ token }) });
  assert.equal(acc.status, 200);
  return acc.setCookie.split(';')[0];
}

test('dsh 鉴权自愈：首访上游 401 → lane 自动交换 → 重放成功；info 暴露 dshAuth 状态', async () => {
  const pair = await makeAuthedPair();
  const svc = createMobileAccessService(pair.opts);
  const lp = await svc.listen();
  try {
    const cookie = await pairDevice(svc, lp);
    // 首访：lane 尚无凭证 → 上游 401 → 自动交换 → 原样重放 → 手机拿到页面
    const page = await textGet('http://127.0.0.1:' + lp + '/', {
      headers: { Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7', cookie },
    });
    assert.equal(page.status, 200, '首访经自愈后应拿到页面');
    assert.ok(page.text.includes('hello'), '页面内容来自上游');
    assert.equal(svc.dshAuth.hasCredential(), true, 'lane 已持凭证');
    // 排查可见性：属主 info 端点暴露 dshAuth 布尔
    const info = await jget('http://127.0.0.1:' + lp + '/api/pair/info');
    assert.equal(info.body.dshAuth, true);
  } finally {
    svc.proxy.server.closeAllConnections?.(); pair.stub.closeAllConnections?.();
    await svc.close();
    pair.stub.close();
  }
});

test('dsh 鉴权自愈：凭证轮换 → 下一请求 401 → 重换 → GET/POST 原样重放（POST 体不丢）', async () => {
  const pair = await makeAuthedPair();
  const svc = createMobileAccessService(pair.opts);
  const lp = await svc.listen();
  try {
    const cookie = await pairDevice(svc, lp);
    const tunnel = { Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7', cookie };
    // 先建立有效凭证
    assert.equal((await textGet('http://127.0.0.1:' + lp + '/', { headers: tunnel })).status, 200);
    // dsh 重启剧本：token + secret 双双轮换
    pair.stub.state.token = 'tok-2';
    pair.stub.state.secret = 'sig-2';
    // GET：401 → 重换 → 重放
    const page = await textGet('http://127.0.0.1:' + lp + '/', { headers: tunnel });
    assert.equal(page.status, 200, '轮换后 GET 自愈成功');
    // POST：请求体缓存重放，上游回显一致
    const payload = JSON.stringify({ k: 'v', n: 1 });
    const echo = await jget('http://127.0.0.1:' + lp + '/api/echo', { method: 'POST', headers: tunnel, body: payload });
    assert.equal(echo.status, 200, '轮换后 POST 自愈成功');
    assert.equal(echo.body.got, payload, '重放后请求体原样到达上游');
    assert.ok(pair.stub.state.exchangeCount >= 2, '交换发生至少两次（初始 + 重换）');
  } finally {
    svc.proxy.server.closeAllConnections?.(); pair.stub.closeAllConnections?.();
    await svc.close();
    pair.stub.close();
  }
});

test('dsh 鉴权降级：token 撤销 → 401 原样透传给手机（只重试一次，不死循环）', async () => {
  const pair = await makeAuthedPair();
  const svc = createMobileAccessService(pair.opts);
  const lp = await svc.listen();
  try {
    const cookie = await pairDevice(svc, lp);
    const tunnel = { Host: 'xxxx.trycloudflare.com', 'x-forwarded-for': '203.0.113.7', cookie };
    assert.equal((await textGet('http://127.0.0.1:' + lp + '/', { headers: tunnel })).status, 200);
    // dsh 侧凭证失效 + connection 不再提供 token：重换必败 → 透传 401
    pair.stub.state.secret = 'sig-3';
    pair.stub.state.tokenEnabled = false;
    const before = pair.stub.state.unauthorizedCount;
    const res = await textGet('http://127.0.0.1:' + lp + '/', { headers: tunnel });
    assert.equal(res.status, 401, '重换失败时上游 401 原样透传');
    assert.ok(res.text.includes('dsh web authentication required'), '透传上游 401 响应体');
    assert.equal(svc.dshAuth.hasCredential(), false, '无凭证状态可观测');
    assert.ok(pair.stub.state.unauthorizedCount <= before + 2, '单次重换上限：不产生重试风暴');
    const info = await jget('http://127.0.0.1:' + lp + '/api/pair/info');
    assert.equal(info.body.dshAuth, false, 'info 反映降级状态');
  } finally {
    svc.proxy.server.closeAllConnections?.(); pair.stub.closeAllConnections?.();
    await svc.close();
    pair.stub.close();
  }
});
