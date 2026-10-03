// #167 回归：插件入口 apply(ctx) 的同源 RPC 通道 seam。
// 修复前 case 'tunnel.probe' 跨作用域调用了 service 私有 runProbe → ReferenceError，
// 被 RPC catch 包成 errRpc('runProbe is not defined') → UI「校验并保存」100% 失败。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectLanIPv4 } from '../lib/links.mjs';

// 环境隔离必须发生在 lib 导入之前：proxy.mjs 在模块导入时冻结 LOG_PATH 并打开
// $DSH_HOME/mobile-access.log（flags:'a'）——若此时 DSH_HOME 指向不存在的目录，
// open ENOENT 会变成无监听 error 事件 → uncaughtException，整个测试文件判 fail。
// 因此这里 mkdtemp 先建目录，再动态 import lib；原环境变量在 after() 统一恢复。
const ORIG_ENV = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_CLOUDFLARED_BIN: process.env.DSH_CLOUDFLARED_BIN,
  DSH_MOBILE_ENABLED: process.env.DSH_MOBILE_ENABLED,
  DSH_MOBILE_LANE_PORT: process.env.DSH_MOBILE_LANE_PORT,
};
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh167-home-'));
process.env.DSH_HOME = TMP_HOME;
process.env.DSH_MOBILE_LANE_PORT = '0'; // lane 随机端口，避免与宿主冲突
delete process.env.DSH_CLOUDFLARED_BIN; // 防止 apply 的 boot 拉起 cloudflared

const { apply } = await import('../lib/index.mjs');

after(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function makeCtx() {
  const handlers = new Map();
  const ctx = {
    _handlers: handlers,
    _dispose: null,
    on(ev, cb) { if (ev === 'dispose') this._dispose = cb; },
    logger: { info() {}, warn() {}, error() {} },
    settings: null,
    connection: {
      rpc: { handle: (ch, h) => handlers.set(ch, h) },
      authenticatedUrl: () => null,
    },
  };
  return ctx;
}

async function withLane(fn) {
  delete process.env.DSH_MOBILE_ENABLED;
  const ctx = makeCtx();
  apply(ctx);
  const rpc = ctx._handlers.get('/dsh-mobile-access');
  assert.ok(rpc, '插件入口必须注册同源 RPC 通道 /dsh-mobile-access');
  try {
    await fn(rpc);
  } finally {
    await ctx._dispose?.();
  }
}

function httpStub(status) {
  return http.createServer((_q, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end('stub');
  });
}

async function listenOn(server, host) {
  await new Promise((r) => server.listen(0, host, r));
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

// fetch 路径需要一个「非 loopback 形态」的 host：探测逻辑会拒绝 127.0.0.1/localhost/[::1]，
// 而 macOS 不允许直接绑 127.0.0.2。复用 lib 的 selectLanIPv4 取本机非回环 IPv4
// （stub 绑 0.0.0.0，经局域网地址回环到本机，不依赖外部网络）。
const LAN = selectLanIPv4(os.networkInterfaces());
const SKIP_FETCH_PATH = LAN ? false : '本机无非回环 IPv4，无法离线走真实 fetch 路径';

test('插件入口 RPC tunnel.probe：守门分支，永不 ReferenceError（#167）', async () => {
  await withLane(async (rpc) => {
    const bad = await rpc('tunnel.probe', { url: 'not a url' });
    assert.equal(bad.ok, true, 'RPC 层成功、判定层失败（不再出现 ReferenceError）');
    assert.equal(bad.value.ok, false);
    assert.equal(bad.value.reason, 'invalid-url');

    for (const loop of ['https://127.0.0.1:3080/x', 'http://localhost:9', 'http://[::1]:9/pair', 'https://x.tauri.localhost']) {
      const v = await rpc('tunnel.probe', { url: loop });
      assert.equal(v.ok, true);
      assert.equal(v.value.reason, 'loopback-or-tuna-not-allowed', loop);
    }
  });
});

test('插件入口 RPC tunnel.probe：可达性判定与 lane HTTP 路由同语义（#167）', { skip: SKIP_FETCH_PATH }, async () => {
  const stub200 = httpStub(200);
  const stub404 = httpStub(404);
  const stub500 = httpStub(500);
  // 绑 0.0.0.0（回环+局域网都可达），用非回环 IPv4 形态的 host 探测
  const port200 = await listenOn(stub200, '0.0.0.0');
  const port404 = await listenOn(stub404, '0.0.0.0');
  const port500 = await listenOn(stub500, '0.0.0.0');
  // 造一个确定空闲的端口模拟「不可达」
  const dead = httpStub(200);
  const deadPort = await listenOn(dead, '0.0.0.0');
  await closeServer(dead);
  try {
    await withLane(async (rpc) => {
      // 修复前：下面每个调用都得到 { ok:false, error:{ message:'runProbe is not defined' } }
      const reach = await rpc('tunnel.probe', { url: 'http://' + LAN + ':' + port200 });
      assert.equal(reach.ok, true, 'RPC 层必须成功（修复前是 errRpc 包裹的 ReferenceError）');
      assert.equal(reach.value._status, 200);
      assert.equal(reach.value.ok, true);
      assert.equal(reach.value.reason, 'reachable');

      // 配对入口放行语义：404 也算可达（与 lane HTTP 路由一致）
      const notFound = await rpc('tunnel.probe', { url: 'http://' + LAN + ':' + port404 });
      assert.equal(notFound.value.ok, true, '404 视为可达（配对入口路由放行）');
      assert.equal(notFound.value.reason, 'reachable');
      assert.equal(notFound.value.status, 404);

      const serverErr = await rpc('tunnel.probe', { url: 'http://' + LAN + ':' + port500 });
      assert.equal(serverErr.value.ok, false);
      assert.equal(serverErr.value.reason, 'http-500');

      const unreach = await rpc('tunnel.probe', { url: 'http://' + LAN + ':' + deadPort });
      assert.equal(unreach.value.ok, false);
      assert.equal(unreach.value.reason, 'unreachable');
    });
  } finally {
    await closeServer(stub200);
    await closeServer(stub404);
    await closeServer(stub500);
  }
});
