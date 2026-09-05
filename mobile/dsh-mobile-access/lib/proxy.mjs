// Host/Origin 改写反向代理（HTTP + WebSocket upgrade 透传）。
// 行为对齐 dsh-pocket 的 lib/proxy.mjs（线上验证可用的实现）：
//   - 入站 Host/Origin 改写成 upstream（loopback），使 dsh /api 信任栅栏看到 loopback；
//   - HTML 注入到 <head> 之后并修正 Content-Length（不破坏页面）；
//   - WebSocket upgrade 全头回传 + 首帧（head）先于 end() 写上游（mux 初始 RPC 不丢）；
//   - 连接级跟踪：所有 socket 挂 error 静默（防 EPIPE 打崩 dsh 进程），close 时全销毁。
// 额外保留：可选 auth 钩子（配对 cookie 门禁，dsh-mobile-access 自用）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';

/** 简易 access log 写到 $DSH_HOME/mobile-access.log（用户能 tail/f 看真实转发） */
const LOG_PATH = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'mobile-access.log');
let logStream = null;
try { logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' }); } catch { /* noop */ }
function accessLog(parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try { logStream?.write(line); } catch { /* noop */ }
  try { process.stdout.write(line); } catch { /* noop */ }
}

export const POLYFILL = '<script data-dsh-mobile-polyfill="1">!function(){if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}();</script>';

/**
 * 远程浏览器「本地身份」补丁：dsh-client-connection 的 `isLoopback` 只看
 * `location.hostname`（127.x/localhost/[::1]），远程经隧道访问的 hostname 是
 * cpolar/cloudflared 域名 → isLoopback=false → settingsScope 走 memory 模式
 * （注释原文：「remote browsers stay process-local because settings RPCs are
 * loopback-only」）→ ui-theme/locale 等所有服务端设置 fallback 默认（主题变
 * 「跟随系统」）。本补丁把 Location.prototype.hostname 的读取伪装成 127.0.0.1，
 * 抢在 dsh client bundles 之前执行（HS 注入位置在 <head> 最前）。
 * 副作用：settings.describe 等 RPC 在远程端启用（经 lane 配对 cookie 放行），
 * 远程端能读到 Host 的服务端设置——这正是「远程跟随桌面设置」的需求。
 * 注意不伪装 href/origin：dsh 的 /api 信任栅栏走 Host 头（lane 已改写），
 * 且页面相对 URL 仍按真实域名解析（cpolar → lane 路径不变）。
 */
export const LOOPBACK_HOSTNAME_PATCH = '<script data-dsh-mobile-loopback="1">!function(){try{var d=Object.getOwnPropertyDescriptor(Location.prototype,"hostname");if(d&&typeof d.get==="function"){Object.defineProperty(Location.prototype,"hostname",{get:function(){return "127.0.0.1"},configurable:true});}}catch(e){}}();</script>';

/**
 * 远程端主题视觉同步：dsh 官方在非 loopback 客户端把 settingsScope 锁成 memory
 * 模式（settings.describe 不发起），ui-theme preference 永远 "system" → body 无
 * `data-ds-dark-theme` → 皮肤 CSS 走浅色背景（§2.2 主题透传）。本补丁从 lane 的
 * `/api/pair/info`（已配对即放行）读桌面端 ui-theme.preference，强制 body 属性，
 * 并用 MutationObserver 守卫（ui-theme publish / React 重渲染可能清掉该属性）。
 * 设置页选项值仍显示 system（官方 memory 模式限制，UI 显示层被锁死，无法注入改）。
 */
export const THEME_SYNC_PATCH = '<script data-dsh-mobile-theme-sync="1">!function(){var pref=null;function enforce(){try{var b=document.body;if(!b)return;var want=pref==="dark";var has=b.hasAttribute("data-ds-dark-theme");if(want!==has){if(want)b.setAttribute("data-ds-dark-theme","");else b.removeAttribute("data-ds-dark-theme");}}catch(e){}}function load(){fetch("/api/pair/info",{headers:{"accept":"application/json"}}).then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error("HTTP "+r.status+" "+t)});return r.json()}).then(function(d){var v=d&&d.uiTheme;if(typeof v==="string"&&(v==="dark"||v==="light"||v==="system")){pref=v;enforce();}}).catch(function(){})}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",load)}else{load()}try{var mo=new MutationObserver(function(){enforce()});if(document.body)mo.observe(document.body,{attributes:true,attributeFilter:["data-ds-dark-theme"],subtree:false});else{var mo2=new MutationObserver(function(){if(document.body){mo2.disconnect();mo.observe(document.body,{attributes:true,attributeFilter:["data-ds-dark-theme"],subtree:false});enforce();}});mo2.observe(document.documentElement,{childList:true});}}catch(e){}}();</script>';

export function desktopEnvPatchScript(platform) {
  const p = ['darwin','win32','linux'].includes(platform) ? platform : 'linux';
  return '<script data-dsh-mobile-desktop-patch="1">!function(){try{var s=new URLSearchParams(location.search);if(!s.has("dsh-desktop-mode")||!s.has("dsh-desktop-platform")){s.set("dsh-desktop-mode","compatibility");s.set("dsh-desktop-platform","' + p + '");var u=new URL(location.href);u.search=s.toString();history.replaceState(null,"",u);}}catch(e){}}();</script>';
}

const INJECT_MARK = 'data-dsh-mobile-polyfill';

/** 把浏览器可见的权威改写成 loopback 权威（Host 和 Origin 都改）。 */
function loopbackAuthority(headers, upstreamHost, upstreamPort) {
  const authority = `${upstreamHost}:${upstreamPort}`;
  headers.Host = authority;
  if (headers.origin) headers.origin = `http://${authority}`;
  if (headers.Origin) headers.Origin = `http://${authority}`;
  return headers;
}

/** 上游响应是否压缩过（压缩流不能做文本注入，会损坏页面）。 */
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * Web-UI 系列插件兼容：dsh 前端/第三方插件在非 loopback 环境会请求 `/remote` 前缀
 * （/remote/api/*、/remote/sidebar/*、/remote/api/events.*），上游 web-app 只实现
 * `/api` 面。本代理即「远程通道」实现：剥离 `/remote` 前缀后转发上游，
 * 使插件设置/会话/皮肤等数据在远程端可读（服务端设置本就在，通道通了即恢复）。
 * 仅剥首段：/remote/api/x → /api/x；/remote → /。
 */
function normalizeRemotePath(url) {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q);
  if (path === '/remote' || path.startsWith('/remote/')) {
    const rest = path.slice('/remote'.length) || '/';
    return rest + query;
  }
  return url;
}

/** 请求是否期望 HTML（浏览器导航）。 */
function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html') || req.url === '/' || /\.html?$/i.test(String(req.url));
}

/**
 * 创建改写反代服务（对齐 dsh-pocket proxy.mjs 的转发行为）。
 * @param opts { upstreamHost, upstreamPort, inject: string[], auth: (req) => {ok, setCookie} | null, onInjectSkip: fn }
 * @returns {server, listen(port?), close()}
 */
export function createRewriteProxy(opts) {
  const {
    upstreamHost = '127.0.0.1',
    upstreamPort = 3080,
    inject = [],
    auth = null,
    onInjectSkip = null,
    // dsh web 会话凭证持有者（dsh 0.1.2-rc.1+ 鉴权）：提供 applyTo/refresh/hasCredential；
    // null = 无凭证模式（老版 dsh 无鉴权，行为同旧版）。
    upstreamAuth = null,
    // 401 重换重放的请求体缓存上限：chunked / 超限请求走流式直通（401 不重放，原样透传）。
    replayBodyLimit = 8 * 1024 * 1024,
  } = opts;
  const upstream = upstreamHost + ':' + upstreamPort;

  const server = http.createServer((req, res) => {
    // 配对门禁（dsh-mobile-access 自用）
    if (auth) {
      const r = auth(req);
      if (!r.ok) {
        accessLog(['HTTP', req.method, req.headers.host ?? '-', '->', req.url, '= 401 UNPAIRED']);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unpaired' }));
        return;
      }
      if (r.setCookie) res.setHeader('set-cookie', r.setCookie);
    }

    /**
     * 转发到上游。allowRetry=true 且持有 upstreamAuth 时：上游 401（dsh 鉴权失效）→
     * 单次重换凭证并原样重放；仍 401 → 原样透传。bodyBuf：Buffer = 已缓存请求体（可重放）；
     * null = 流式管道（不可重放，原始 req.pipe 路径）。
     */
    const forward = (bodyBuf, allowRetry) => {
      const buildHeaders = () => {
        const h = loopbackAuthority({ ...req.headers }, upstreamHost, upstreamPort);
        upstreamAuth?.applyTo(h);
        return h;
      };
      const targetPath = normalizeRemotePath(req.url);
      const stripped = targetPath !== req.url ? ` (from ${req.url})` : '';
      accessLog(['HTTP', req.method, req.headers.host ?? '-', '->', targetPath + stripped]);

      const handleUpstreamResponse = (proxyRes) => {
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        const htmlDoc = contentType.includes('text/html');
        const shouldInject = htmlDoc && !isCompressed(proxyRes.headers) && inject.length > 0;
        accessLog(['  <-', proxyRes.statusCode, contentType.split(';')[0] || '-', (shouldInject ? 'INJECT' : 'PASSTHROUGH')]);

        if (shouldInject) {
          // 收集完整 HTML，注入到 <head> 之后，修正 Content-Length（对齐 pocket）
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${inject.join('')}`);
            }
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }

        // 大 JSON/text 响应流式压缩（对齐 pocket：长会话 17MB→~1MB；跳过 SSE/压缩/HTML）
        const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        const shouldCompress = (canGzip || canBr)
          && !isCompressed(proxyRes.headers)
          && !htmlDoc
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);

        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          proxyRes.pipe(z).pipe(res);
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', () => { z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { z.destroy(); res.destroy(); });
          z.on('error', () => res.destroy());
          return;
        }

        if (htmlDoc && isCompressed(proxyRes.headers) && inject.length > 0 && onInjectSkip) {
          onInjectSkip(req.url.split('?')[0]);
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        // 任一端断开都要清理另一端
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      };

      const send = (isRetry) => {
        const proxyReq = http.request(
          { host: upstreamHost, port: upstreamPort, method: req.method, path: targetPath, headers: buildHeaders(), agent: false },
          (proxyRes) => {
            // dsh 401：凭证失效 → 单次重换（重新自取 token + 换新 cookie）并原样重放；仍 401 透传
            if (!isRetry && allowRetry && upstreamAuth && proxyRes.statusCode === 401) {
              proxyRes.pause();
              void Promise.resolve()
                .then(() => upstreamAuth.refresh())
                .then((ok) => {
                  if (ok) {
                    accessLog(['  <-', 401, 'dsh-auth', '→ 凭证已重换，重放', targetPath]);
                    try { proxyRes.destroy(); } catch { /* noop */ }
                    send(true);
                  } else {
                    accessLog(['  <-', 401, 'dsh-auth', '→ 重换失败，透传', targetPath]);
                    handleUpstreamResponse(proxyRes);
                  }
                })
                .catch(() => {
                  try { proxyRes.resume(); } catch { /* noop */ }
                  handleUpstreamResponse(proxyRes);
                });
              return;
            }
            handleUpstreamResponse(proxyRes);
          },
        );
        proxyReq.on('error', (err) => {
          accessLog(['HTTP', req.method, req.headers.host ?? '-', '->', targetPath, '= ERR', err.code ?? err.message]);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          try { res.end(`dsh-mobile-access: 无法连接上游 ${upstream} | ${err.message}`); } catch { /* noop */ }
        });
        if (bodyBuf === null) req.pipe(proxyReq);
        else proxyReq.end(bodyBuf);
      };
      send(false);
    };

    // 可重放通道判定：持有凭证持有者，且请求体有界可缓存（GET/HEAD 无体；有体需 content-length ≤ 上限）。
    // chunked / 超限 / 无凭证 → 流式直通（401 不重放，行为同旧版）。
    const declaredLen = Number(req.headers['content-length'] || 0);
    const chunked = /chunked/i.test(String(req.headers['transfer-encoding'] ?? ''));
    const bodiless = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (!upstreamAuth || (!bodiless && (chunked || declaredLen > replayBodyLimit))) {
      forward(null, false);
      return;
    }
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => { aborted = true; try { res.destroy(); } catch { /* noop */ } });
    req.on('end', () => { if (!aborted) forward(Buffer.concat(chunks), true); });
  });

  // WebSocket upgrade：全头回传 + 首帧先写（对齐 pocket）
  server.on('upgrade', (req, socket, head) => {
    if (auth) {
      const r = auth(req);
      if (!r.ok) {
        accessLog(['WS', req.method, req.headers.host ?? '-', '->', req.url, '= 401 UNPAIRED']);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.end();
        return;
      }
    }
    const headers = loopbackAuthority({ ...req.headers }, upstreamHost, upstreamPort);
    // dsh 会话凭证：upgrade 请求同样附带（401 不重放——客户端重连即拿新凭证）
    upstreamAuth?.applyTo(headers);
    const wsPath = normalizeRemotePath(req.url);
    accessLog(['WS', req.method, req.headers.host ?? '-', '->', wsPath]);
    const proxyReq = http.request({
      host: upstreamHost, port: upstreamPort, method: req.method, path: normalizeRemotePath(req.url), headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      // 原样回传上游的 upgrade 头（Sec-WebSocket-Accept 等）
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      // 任一端断开都要清理另一端（避免上游残留僵尸连接占用 dsh 连接槽）
      // 对上游用 end()（FIN 优雅关闭），客户端侧已断直接 destroy；
      // 两个 socket 都挂常驻 error 静默（迟到的 EPIPE 不能冒泡崩进程）。
      const quiet = () => {};
      proxySocket.on('error', quiet);
      socket.on('error', quiet);
      const teardown = () => {
        try { proxySocket.unpipe?.(); socket.unpipe?.(); } catch { /* noop */ }
        try { proxySocket.end(); } catch { /* noop */ }
        const force = setTimeout(() => { try { if (!proxySocket.destroyed) proxySocket.destroy(); } catch { /* noop */ } }, 2000);
        if (force.unref) force.unref();
        try { if (!socket.destroyed) socket.destroy(); } catch { /* noop */ }
      };
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
    });
    // 上游返回普通 HTTP 响应（非 101）：把状态码/头回写后断开，别让客户端永久挂起
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return;
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume();
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', () => socket.destroy());
    // 关键：首帧 head 必须先于 end() 写上游（mux 初始 RPC 不丢窗口）
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  });

  // 跟踪所有 TCP 连接（含 upgrade 后的 socket；close 时全销毁，防挂起）
  const clientSockets = new Set();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {});
  });

  return {
    server,
    upstream,
    rewriteHeaders: (h) => loopbackAuthority({ ...h }, upstreamHost, upstreamPort),
    listen: (port = 0) => new Promise((res) => { server.listen(port, '0.0.0.0', () => res(server.address().port)); }),
    close: () => new Promise((r) => {
      for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
      server.close(() => r());
    }),
  };
}