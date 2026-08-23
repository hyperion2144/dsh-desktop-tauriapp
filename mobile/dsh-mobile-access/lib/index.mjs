// 手机访问服务装配（host 半区）：改写反代 + 配对路由(JS 回调) + SSE + 隧道启动。
// 纯 Node 可测；桌面壳集成时在 dsh 进程内作为 bundle 插件装载。
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRewriteProxy, POLYFILL, LOOPBACK_HOSTNAME_PATCH, THEME_SYNC_PATCH } from './proxy.mjs';
import { PairingStore, createFileStorage, deviceNameFromUA } from './pairing.mjs';
import { selectLanIPv4, buildPairLink, buildHttpPairLink, normalizeRemote } from './links.mjs';
import { readSettingsString, writeSettingsKey, readTopLevelBlockKey } from './settings.mjs';
import { resolveCloudflared } from './cloudflared.mjs';

/** 读取桌面端 ui-theme.preference（'dark' | 'light' | 'system' | null），供注入脚本同步远程视觉。 */
function readUiThemePreference() {
  try {
    const raw = readTopLevelBlockKey('ui-theme', 'preference');
    if (raw == null) return null;
    const m = String(raw).match(/^"(.*)"$/s);
    return (m ? JSON.parse(m[1]) : String(raw).trim()) || null;
  } catch {
    return null;
  }
}

export function createMobileAccessService(opts = {}) {
  const {
    upstreamHost = '127.0.0.1',
    upstreamPort = 3080,
    platform = 'linux',
    pairing = null,
    // 默认文件持久化设备会话（$DSH_HOME 0600）；测试注入 pairing 时可传 createMemoryStorage()
    storage = null,
    warn = null,
    fetchImpl = null,
  } = opts;
  const store = pairing ?? (storage
    ? new PairingStore({ storage })
    : new PairingStore({ storage: createFileStorage() }));
  const proxy = createRewriteProxy({
    upstreamHost,
    upstreamPort,
    // 仅注入 POLYFILL + LOOPBACK_HOSTNAME_PATCH + THEME_SYNC_PATCH（顺序：补丁先于 polyfill、先于 dsh scripts）。
    // ⚠️ 不注入 desktopEnvPatchScript：对齐 pocket 行为——只在 DSH Desktop 壳内注入，
    // 给远程浏览器强制补 dsh-desktop-mode=compatibility 会让 dsh-plugin-desktop 等
    // 走「桌面分支」假设 Tauri IPC、皮肤 mount 时序，远程浏览器没 __TAURI__ 也没准备好
    // 的 DOM → classList null / 皮肤不加载（§2.2）。POLYFILL 单独无害。
    // LOOPBACK_HOSTNAME_PATCH：已证实浏览器禁止伪造 hostname（configurable:false），
    // 该补丁不再生效，保留仅为记录。THEME_SYNC_PATCH 是视觉兜底方案：读 /api/pair/info
    // 的 uiTheme 强制 body[data-ds-dark-theme]，让远程端背景与桌面一致（设置项显示值
    // 仍为 system——dsh 官方 memory 模式限制）。
    inject: [LOOPBACK_HOSTNAME_PATCH, THEME_SYNC_PATCH, POLYFILL],
    auth: (req) => {
      // 配对门禁：所有到达反代本体的路径都必须是已配对设备（携带会话 cookie）。
      // 不做任何 /api/pair/* 前缀豁免——配对/控制路由全部由 routePairing 先行处理，
      // 打到这里的不属于路由表，一律要求 cookie，杜绝「前缀豁免 + 上游路径归一化」绕过。
      const cookie = parseCookie(req.headers.cookie, 'dsh_mobile_session');
      return { ok: store.isDevice(cookie) };
    },
    onInjectSkip: opts.warn
      ? (p) => opts.warn('[dsh-mobile-access] 上游压缩 HTML，跳过注入（该页无 polyfill/桌面补丁）: ' + p)
      : undefined,
  });

  // 本地属主判定：桌面壳（同一台机器）经 loopback 直连 lane 端口，且无隧道加插的
  // X-Forwarded-For —— 视为属主控制台。公网/局域网设备一律经隧道（非 loopback Host
  // 或带 XFF），只能凭设备 cookie 访问控制端点。
  function isLocalOwner(req) {
    const host = String(req.headers.host ?? '').split(':')[0];
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '';
    return loopback && !req.headers['x-forwarded-for'];
  }

  // cloudflared 隧道控制器（服务级状态，可重启）：
  //   bin    = cloudflared 可执行文件路径（'' / null = 未启用）
  //   child  = 当前子进程（null = 未运行）
  //   url    = 最近一次解析到的 trycloudflare 地址
  //   startedAt / stopAt = 状态查询用时间戳
  //   phase  = idle | resolving | downloading | starting | registering | ready | error
  //           （pocket 风格的隧道生命周期阶段，cf 卡片 UI 轮询可见）
  const tunnel = {
    bin: '',
    child: null,
    url: null,
    startedAt: 0,
    stopping: false,
    port: 3091,
    phase: 'idle',
    detail: '',
    message: '',
  };

  // 第三方隧道地址（cpolar 等）内存态：POST /api/pair/tunnel 设置；
  // 重启后从 settings.yaml tunnel_url 恢复（info 端点兜底读取）。
  let customTunnel = '';

  // 启动隧道（若已在运行则先停旧进程）。bin 为空 → 自动解析（PATH 优先，否则 $DSH_HOME/bin 缓存，
  // 否则从 GitHub/ghproxy 等多镜像下载到缓存），全过程异步，phase 字段实时同步状态供 UI 轮询。
  function startTunnel(bin, lanePort) {
    stopTunnel();
    tunnel.stopping = false;  // stopTunnel 保留 stopping=true 等子进程 exit，本轮启动需复位允许 tryParse
    tunnel.phase = 'resolving'
    tunnel.detail = bin ? `启动 ${bin}` : '正在解析 cloudflared…'
    tunnel.message = ''
    void (async () => {
      try {
        let actualBin = bin
        if (!actualBin) {
          const result = await resolveCloudflared({
            onPhase: (phase, detail) => {
              tunnel.phase = phase
              if (detail) tunnel.detail = detail
            },
          })
          actualBin = result.path
          tunnel.bin = actualBin
          tunnel.detail = `${result.source === 'PATH' ? 'PATH 已有' : result.source === 'cache' ? '使用缓存' : '已下载'}：${actualBin}`
        } else {
          tunnel.bin = actualBin
        }
        const targetPort = lanePort ?? tunnel.port
        tunnel.phase = 'starting'
        tunnel.detail = '启动 cloudflared 子进程…'
        let child
        try {
          // 强制 HTTP/2（443）而非 QUIC（7844 UDP）：国内/企业网常屏蔽 UDP 7844 → tunnel error 1033，
          // 走 TCP 443 更稳。--no-autoupdate 跳过版本检查（启动更快）。
          child = spawn(actualBin, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${targetPort}`], { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) {
          tunnel.phase = 'error'
          tunnel.message = String(e?.message ?? e)
          store.emit('tunnel', { url: null, reason: 'spawn-failed', message: tunnel.message })
          return
        }
        // 异步下载/解析期间用户可能已点停止 → 立即 kill 这个孤儿进程
        if (tunnel.stopping) {
          try { child.kill() } catch { /* noop */ }
          return
        }
        tunnel.child = child
        tunnel.startedAt = Date.now()
        tunnel.url = null
        tunnel.phase = 'registering'
        tunnel.detail = '连接 Cloudflare 边缘（通常 5-30 秒）…'
        let out = ''
        const timer = setTimeout(() => {
          child.emit('_cf_timeout')
        }, 45000)
        const tryParse = () => {
          const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
          if (m && !tunnel.stopping) {
            tunnel.url = m[0]
            tunnel.phase = 'ready'
            tunnel.detail = '已连接 Cloudflare 边缘'
            store.emit('tunnel', { url: tunnel.url })
          }
        }
        child.stdout.on('data', (c) => {
          out += c
          tryParse()
        })
        child.stderr.on('data', (c) => {
          out += c
          // cloudflared 偶发把 URL 写到 stderr
          tryParse()
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          if (tunnel.child === child) tunnel.child = null
          tunnel.url = null
          tunnel.phase = 'error'
          tunnel.message = String(e?.message ?? e)
          store.emit('tunnel', { url: null, reason: 'spawn-failed', message: tunnel.message })
        })
        child.on('exit', () => {
          clearTimeout(timer)
          if (tunnel.child === child) tunnel.child = null
          // 仅在「非用户主动 stop」时把 phase 复位到 idle；stop 路径下 stopTunnel 已立刻写 idle，
          // 这里再写一次也无害（幂等），但跳过 error 状态（崩溃应保留 error 让 UI 显示诊断）
          if (tunnel.phase !== 'error') tunnel.phase = 'idle'
          if (tunnel.detail === '连接 Cloudflare 边缘（通常 5-30 秒）…') tunnel.detail = ''
          // 子进程已退出，stopping 复位允许下次 start
          tunnel.stopping = false
        })
        child.on('_cf_timeout', () => {
          clearTimeout(timer)
          if (!tunnel.url) {
            tunnel.phase = 'error'
            tunnel.message = 'cloudflared 45s 未上报 trycloudflare 地址'
            store.emit('tunnel', { url: null, reason: 'timeout' })
          }
        })
      } catch (e) {
        tunnel.phase = 'error'
        tunnel.message = String(e?.message ?? e)
        tunnel.detail = e?.message ?? String(e)
      }
    })()
    return tunnel
  }

  // 停止隧道（kill 子进程，保留 bin 配置）。
  function stopTunnel() {
    const ch = tunnel.child;
    if (ch) {
      tunnel.stopping = true;
      tunnel.child = null;
      try { ch.kill(); } catch { /* noop */ }
      // SIGKILL 兜底：cloudflared 偶发不响应 SIGTERM（边缘网络残留），3s 后强杀
      const hardKill = setTimeout(() => { try { ch.kill('SIGKILL') } catch { /* noop */ } }, 3000);
      if (typeof hardKill.unref === 'function') hardKill.unref();
    }
    tunnel.startedAt = 0;
    tunnel.url = null;
    tunnel.phase = 'idle';        // 立即复位，UI 立刻不显示"运行中"
    tunnel.detail = '';
    tunnel.message = '';
    // tunnel.stopping 保持 true，由 child.on('exit') 在实际退出时复位；
    // 否则 kill→exit 之间 cloudflared 最后一帧 stdout 会触发 tryParse 把 url/phase 复活
  }

  // 配对/授权路由（先于上游转发）：
  function routePairing(req, res) {
    const path = req.url.split('?')[0];
    const authed = store.isDevice(parseCookie(req.headers.cookie, 'dsh_mobile_session'));
    const owner = isLocalOwner(req);
    const canManage = owner || authed;
    const unpaired401 = () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unpaired' }));
    };
    // 属主控制台（同机 loopback 设置页）跨域读取配对状态：CORS 仅放行回环源
    const cors = {
      'access-control-allow-origin': allowCorsOrigin(req.headers.origin, req.headers.host) ?? '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'vary': 'Origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return true;
    }
    const json = (status, body, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    if (path === '/pair') {
      const token = new URL(req.url, 'http://x').searchParams.get('token') ?? '';
      // 浏览器配对：Accept 含 text/html → 自动接受 + 种 cookie + 302 进应用；
      // API 探活 / 属主状态（无 token）→ 保持 JSON 状态。
      const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
      if (token) {
        const session = store.accept(token, { name: deviceNameFromUA(req.headers['user-agent'] ?? '') });
        if (session) {
          res.writeHead(302, {
            'location': '/',
            'set-cookie': 'dsh_mobile_session=' + session.cookie + '; HttpOnly; Path=/; SameSite=Lax',
          });
          res.end();
          return true;
        }
        // token 无效或已作废：API 返回 403 JSON；浏览器渲染简短提示页。
        if (wantsHtml) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>配对失败</title><body style="font-family:sans-serif;padding:32px;background:#f5f5f7;color:#1d1d1f"><h2>配对失败</h2><p>链接无效或令牌已过期。请在桌面「远程访问」设置中重新铸造令牌。</p></body>');
          return true;
        }
        json(403, { error: 'invalid-token' });
        return true;
      }
      json(200, { ok: true, mode: store.token ? 'await-token' : 'no-token', tokenLen: 0 });
      return true;
    }
    if (path === '/api/pair/info' && req.method === 'GET') {
      // 属主 + 已配对设备：配对候选地址（二维码/链接用）；已配对设备需要 uiTheme
      // 让注入脚本同步桌面主题偏好（视觉一致，§2.2）。
      if (!owner && !authed) { unpaired401(); return true; }
      const lanIp = selectLanIPv4(os.networkInterfaces?.() ?? {});
      let customTunnelUrl = customTunnel;
      if (!customTunnelUrl) {
        try { customTunnelUrl = readSettingsString('tunnel_url') ?? ''; } catch { /* noop */ }
      }
      json(200, {
        lanePort: tunnel.port,
        lanIp,
        tunnelUrl: tunnel.url,
        customTunnelUrl,
        uiTheme: readUiThemePreference(),
      });
      return true;
    }
    if (path === '/api/pair/tunnel' && req.method === 'POST') {
      // 仅属主：保存第三方隧道地址（cpolar 等）用于生成配对二维码；空串清除。
      if (!owner) { unpaired401(); return true; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { url } = JSON.parse(body || '{}');
          if (typeof url !== 'string') { json(400, { error: 'bad-request' }); return; }
          const trimmed = url.trim();
          if (trimmed && !/^https?:\/\//.test(trimmed)) { json(400, { error: 'bad-request' }); return; }
          customTunnel = trimmed; // 内存态立即生效（重启后从 settings.yaml 恢复）
          try {
            writeSettingsKey('tunnel_url', JSON.stringify(trimmed));
          } catch (e) {
            try { warn?.('[dsh-mobile-access] 隧道地址持久化失败: ' + e); } catch { /* noop */ }
          }
          json(200, { ok: true, url: trimmed });
        } catch (e) {
          json(400, { error: 'bad-request' });
        }
      });
      return true;
    }
    if (path === '/api/pair/mint' && req.method === 'POST') {
      // 仅属主：铸造新令牌（旧令牌自动作废）
      if (!owner) { unpaired401(); return true; }
      const token = store.mint();
      json(200, { ok: true, token, expiresAt: store.tokenExpiresAt });
      return true;
    }
    if (path === '/api/pair/probe' && req.method === 'GET') {
      // 仅属主：校验第三方隧道地址（cpolar 等）。要求 http(s) URL，探测其 /pair
      // 路由可达（改写反代放行）；loopback 与 tauri.localhost 拒绝。
      if (!owner) { unpaired401(); return true; }
      const raw = new URL(req.url, 'http://x').searchParams.get('url') ?? '';
      void runProbe(raw, json);
      return true;
    }
    if (path === '/api/pair/accept' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { token, name } = JSON.parse(body || '{}');
          const session = store.accept(token, { name: name || deviceNameFromUA(req.headers['user-agent'] ?? '') });
          if (!session) {
            json(403, { error: 'invalid-token' });
            return;
          }
          json(200, { ok: true, deviceId: session.deviceId }, {
            'set-cookie': 'dsh_mobile_session=' + session.cookie + '; HttpOnly; Path=/; SameSite=Lax',
          });
        } catch (e) {
          json(400, { error: 'bad-request' });
        }
      });
      return true;
    }
    if (path === '/api/pair/devices' && req.method === 'GET') {
      if (!canManage) { unpaired401(); return true; }
      json(200, { devices: store.snapshotDevices(), tokenRef: store.ref() });
      return true;
    }
    if (path === '/api/pair/remove' && req.method === 'POST') {
      // 移除单个设备配对（属主控制台操作）。
      if (!owner) { unpaired401(); return true; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { deviceId } = JSON.parse(body || '{}');
          if (typeof deviceId !== 'string' || !store.removeDevice(deviceId)) {
            json(404, { error: 'not-found' });
            return;
          }
          json(200, { ok: true });
        } catch (e) {
          json(400, { error: 'bad-request' });
        }
      });
      return true;
    }
    if (path === '/api/pair/stop' && req.method === 'POST') {
      if (!canManage) { unpaired401(); return true; }
      store.stopAll();
      json(200, { ok: true });
      return true;
    }
    if (path === '/api/pair/events') {
      if (!canManage) { unpaired401(); return true; }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        ...cors,
      });
      res.write(':ok\n\n');
      const off = store.on((event, data) => res.write(store.sse(event, data)));
      req.on('close', off);
      return true;
    }
    if (path === '/api/pair/cloudflared' && req.method === 'GET') {
      // 仅属主：查询隧道配置与运行状态。
      if (!owner) { unpaired401(); return true; }
      json(200, {
        bin: tunnel.bin,
        url: tunnel.url,
        running: !!tunnel.child,
        startedAt: tunnel.startedAt,
      });
      return true;
    }
    if (path === '/api/pair/cloudflared' && req.method === 'POST') {
      // 仅属主：设置 cloudflared 路径（应用并持久化）或停止隧道。
      if (!owner) { unpaired401(); return true; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { bin, action } = JSON.parse(body || '{}');
          if (action === 'stop') {
            stopTunnel();
            json(200, { ok: true, running: false });
            return;
          }
          if (typeof bin !== 'string') {
            json(400, { error: 'bad-request' });
            return;
          }
          const trimmed = bin.trim();
          if (trimmed && !/^[^\0]+$/.test(trimmed)) {
            json(400, { error: 'bad-request' });
            return;
          }
          // 持久化到 settings.yaml（行级 merge，保留注释）；空串 = 进入 auto 模式（不固化路径）。
          let saved = true;
          if (trimmed) {
            try {
              writeSettingsKey('cloudflared_bin', JSON.stringify(trimmed));
              const persisted = readSettingsString('cloudflared_bin');
              if (persisted !== trimmed) saved = false;
            } catch (e) {
              saved = false;
              try { warn?.('[dsh-mobile-access] cloudflared 配置持久化失败: ' + e); } catch { /* noop */ }
            }
          } else {
            try { writeSettingsKey('cloudflared_bin', JSON.stringify('')); } catch { /* 忽略 */ }
          }
          startTunnel(trimmed || null, tunnel.port);
          json(200, { ok: true, running: !!tunnel.child, bin: trimmed || null, phase: tunnel.phase, persisted: saved });
        } catch (e) {
          json(400, { error: 'bad-request' });
        }
      });
      return true;
    }
    return false;
  }

  // 第三方隧道地址探测（异步；结果经 json 回调写出）。
  async function runProbe(raw, json) {
    const verdict = { ok: false, reason: 'invalid-url' };
    const m = String(raw).match(/^(https?):\/\/([^/]+)(\/.*)?$/);
    if (m) {
      const scheme = m[1];
      const host = m[2];
      const isLoopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || /^\[::1\]/.test(host);
      const isTuna = /tauri\.localhost$/i.test(host);
      if (!isLoopback && !isTuna) {
        try {
          const doFetch = fetchImpl ?? ((u, o) => fetch(u, o));
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const r = await doFetch(scheme + '://' + host + '/pair', { signal: ctrl.signal, headers: { Connection: 'close' } });
          clearTimeout(timer);
          verdict.ok = r.ok || r.status === 404;
          verdict.status = r.status;
          verdict.reason = verdict.ok ? 'reachable' : 'http-' + r.status;
        } catch {
          verdict.reason = 'unreachable';
        }
      } else {
        verdict.reason = 'loopback-or-tuna-not-allowed';
      }
    }
    json(200, verdict);
  }

  // 包裹 server 的 request 处理：优先路由，其次反代。
  const originalHandler = proxy.server.listeners('request')[0];
  proxy.server.removeAllListeners('request');
  proxy.server.on('request', (req, res) => {
    if (routePairing(req, res)) return;
    originalHandler(req, res);
  });

  return {
    store,
    proxy,
    routePairing,
    selectLanIPv4,
    buildPairLink,
    buildHttpPairLink,
    normalizeRemote,
    tunnel,
    startTunnel,
    stopTunnel,
    listen: (port = 0) => new Promise((res) => {
      // 0.0.0.0：局域网设备直连（配对门禁保护未配对路径；宿主 dsh 仍只面 loopback）。
      proxy.server.listen(port, '0.0.0.0', () => {
        const addr = proxy.server.address();
        if (addr && typeof addr === 'object') tunnel.port = addr.port;
        res(proxy.server.address().port);
      });
    }),
    close: () => new Promise((res) => proxy.server.close(() => res())),
  };
}

export function parseCookie(header, name) {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// CORS 源白名单：仅放行来自回环（本机 dsh 设置页）的跨域读取；其它 Origin 一律不回显。
export function allowCorsOrigin(origin, hostHeader) {
  if (!origin) return null;
  const o = String(origin);
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o)) return o;
  return null;
}

/**
 * dsh bundle 插件 host 半区入口：随 dsh web 进程装载时启动 lane 改写反代与配对服务。
 * 配置走环境变量（桌面壳 spawn 时注入）：
 *   DSH_MOBILE_ENABLED        = '0' 关闭（默认开）
 *   DSH_MOBILE_LANE_PORT      = lane 端口（默认 3091）
 *   DSH_DESKTOP_PORT          = 上游 dsh web 端口（默认 3080）
 *   DSH_CLOUDFLARED_BIN       = cloudflared 可执行文件路径（设置后自动起隧道）
 * 生命周期：ctx dispose 时关闭 lane 并回收 cloudflared 子进程。
 * 注：桌面壳插件的 host 半区若无需启动服务（如 dsh-desktop-tauriapp 仅技能）可留空 apply。
 *
 * 硬依赖：connection（ctx.connection.rpc.handle）—— 同源 RPC 通道是 client/host 通讯的
 * 唯一途径，无 connection 即无法响应桌面壳 WebView 的 9 个端点请求，必须声明 inject。
 * Cordis 的 Guard 会拒绝任何未声明的 ctx.<service> 访问并让整个 plugin tree 装载失败
 * （下游所有插件如 dsh-session-log-export 也会被级联报 "failed to load"）。
 */
export const inject = ['connection'];

function apply(ctx) {
  const platform = typeof process !== 'undefined' ? process.platform : '';
  if (!platform || !ctx || typeof ctx.on !== 'function') return;
  if (process.env.DSH_MOBILE_ENABLED === '0') return;
  const lanePort = Number(process.env.DSH_MOBILE_LANE_PORT || 3091);
  const upstreamPort = Number(process.env.DSH_DESKTOP_PORT || 3080);
  const svc = createMobileAccessService({
    upstreamHost: '127.0.0.1',
    upstreamPort,
    platform,
    warn: (m) => { try { ctx?.logger?.warn?.(m); } catch { /* noop */ } },
  });

  // 同源 RPC handler（与 client 共享通道名 /dsh-mobile-access）：
  // 桌面壳 WebView 跨域 fetch 被浏览器拦截，必须走 dsh 同源 connection RPC。
  if (ctx?.connection?.rpc?.handle) {
    const ch = '/dsh-mobile-access';
    const ok = (v) => ({ ok: true, value: v });
    const errRpc = (msg) => ({ ok: false, error: { code: 'bad-request', message: msg, details: { issues: [{ message: msg }] } } });
    try { ctx?.logger?.info?.('dsh-mobile-access: 注册同源 RPC 通道 ' + ch); } catch {}
    ctx.connection.rpc.handle(ch, async (endpoint, payload = {}, signal) => {
      try {
        switch (endpoint) {
          case 'devices.list':
            return ok({ devices: svc.store.snapshotDevices(), tokenRef: svc.store.ref() });
          case 'devices.remove': {
            const id = String(payload?.deviceId ?? '');
            if (!id || !svc.store.removeDevice(id)) return errRpc('not-found');
            return ok(true);
          }
          case 'token.mint': {
            const t = svc.store.mint();
            return ok({ token: t, expiresAt: svc.store.tokenExpiresAt });
          }
          case 'token.ref':
            return ok({ ref: svc.store.ref() });
          case 'info': {
            const lanIp = selectLanIPv4(os.networkInterfaces?.() ?? {});
            let customTunnelUrl = svc.tunnel && svc.tunnel._customUrl ? svc.tunnel._customUrl : '';
            if (!customTunnelUrl) {
              try { customTunnelUrl = readSettingsString('tunnel_url') ?? ''; } catch {}
            }
            return ok({
              lanePort: svc.tunnel?.port ?? 3091,
              lanIp,
              tunnelUrl: svc.tunnel?.url ?? null,
              customTunnelUrl,
            });
          }
          case 'tunnel.probe': {
            const url = String(payload?.url ?? '');
            if (!url) return errRpc('bad-url');
            // 同源调用方已信任（仅属主 + 同源 channel），直接调内部 probe
            const verdict = await new Promise((resolve) => {
              const json = (status, body) => resolve({ _status: status, ...body });
              runProbe(url, json);
            });
            return ok(verdict);
          }
          case 'tunnel.save': {
            const url = String(payload?.url ?? '').trim();
            if (url && !/^https?:\/\//.test(url)) return errRpc('bad-url');
            try { writeSettingsKey('tunnel_url', JSON.stringify(url)); } catch {}
            if (svc.tunnel) svc.tunnel._customUrl = url;
            return ok({ url });
          }
          case 'cloudflared.get':
            return ok({
              bin: svc.tunnel?.bin ?? '',
              url: svc.tunnel?.url ?? null,
              running: !!svc.tunnel?.child,
              reason: svc.tunnel?.reason ?? null,
              phase: svc.tunnel?.phase ?? 'idle',
              detail: svc.tunnel?.detail ?? '',
              message: svc.tunnel?.message ?? '',
            });
          case 'cloudflared.apply': {
            // 空 bin = 自动解析（PATH 优先 → ~/.dsh/bin 缓存 → 多镜像下载），适合"一键启动"。
            // 解析/下载是 async，phase 字段会从 'resolving' → 'downloading' → 'starting' → 'ready' 演进。
            const bin = String(payload?.bin ?? '').trim();
            const t = svc.startTunnel(bin || null, svc.tunnel?.port ?? 3091);
            // 仅在用户显式给了 bin 时持久化（auto 模式每次启动自动解析，不要把缓存路径写死）。
            if (bin) { try { writeSettingsKey('cloudflared_bin', JSON.stringify(bin)); } catch {} }
            return ok({ bin: t.bin || null, running: !!t.child, phase: t.phase ?? 'resolving' });
          }
          case 'cloudflared.stop':
            svc.stopTunnel();
            return ok(true);
          default:
            return errRpc('unknown-endpoint');
        }
      } catch (e) {
        return errRpc(String(e?.message ?? e));
      }
    }, { authority: 'loopback' });
  } else {
    try { ctx?.logger?.warn?.('dsh-mobile-access: connection.rpc 不可用，client 端将无法与 host 通信'); } catch {}
  }
  let closed = false;
  const boot = async () => {
    try {
      await svc.listen(lanePort);
    } catch (e) {
      try { ctx?.logger?.error?.(`dsh-mobile-access: lane ${lanePort} 启动失败: ${e}`); } catch { /* noop */ }
      return;
    }
    try { ctx?.logger?.info?.(`dsh-mobile-access: lane 改写反代已监听 127.0.0.1:${lanePort} → ${svc.proxy.upstream}`); } catch { /* noop */ }
    // 启动时按 env（桌面壳 spawn 注入）优先，其次 settings.yaml 持久化值；
    // 运行期变更走 POST /api/pair/cloudflared（立即生效 + 持久化）。
    let bin = process.env.DSH_CLOUDFLARED_BIN || '';
    if (!bin) {
      try { bin = readSettingsString('cloudflared_bin') ?? ''; } catch { bin = ''; }
    }
    if (bin) {
      svc.startTunnel(bin, lanePort);
      try {
        if (closed) return;
        if (svc.tunnel.url) ctx?.logger?.info?.(`dsh-mobile-access: cloudflared 隧道 ${svc.tunnel.url}`);
        else ctx?.logger?.info?.('dsh-mobile-access: cloudflared 已启动，等待隧道地址');
      } catch { /* noop */ }
    }
  };
  void boot();
  ctx.on('dispose', () => {
    closed = true;
    svc.stopTunnel();
    void svc.close();
  });
}

/** dsh bundle 插件入口：cordis-plugin-loader 会同时读取 apply + inject。 */
export { apply };