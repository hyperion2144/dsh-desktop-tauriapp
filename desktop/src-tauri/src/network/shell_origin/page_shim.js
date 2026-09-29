/*!
 * 壳内页面常驻注入脚本（#154）。
 *
 * 页面 origin 是壳自己注册的协议（macOS/Linux `dshapp://localhost`、Windows
 * `http://dshapp.localhost`），而数据面在 loopback 流式代理上。dsh 自身走
 * `__DSH_TRANSPORT__.streamBaseUrl`，但**第三方插件**普遍直接拿 `location` 拼
 * WebSocket / fetch 地址——在自定义协议页面上这是非法 URL（WKWebView 实测抛
 * "The string did not match the expected pattern."，见 dsh-better-sidebar）。
 *
 * 因此这里做两件事：
 *  1. 设置官方能力位 `__DSH_TRANSPORT__`（streamBaseUrl 指向数据面代理 + ownsHost）；
 *  2. 把 WebSocket / EventSource / fetch / XMLHttpRequest.open / window.open 包一层：
 *     指向**本页 host** 或**非法协议**的 URL 一律改写到数据面代理；相对路径不碰
 *     （由 <base> 解析，避免二次改写）；外部绝对地址（真正的 https:// 等）原样放行。
 *
 * 占位符 `__DSH_STREAM_BASE__` 由 scheme.rs 替换为数据面代理 origin（带尾斜杠）。
 */
(function () {
  'use strict';
  var T = { streamBaseUrl: '__DSH_STREAM_BASE__', ownsHost: true };
  globalThis.__DSH_TRANSPORT__ = T;
  var HTTP = String(T.streamBaseUrl || '').replace(/\/+$/, '');
  var WS = HTTP.replace(/^http/i, 'ws');

  /** 绝对地址是否指向“本页 host / 本机回环 / dshapp 协议”（这些都要改写到代理）。 */
  /**
   * 该 URL 是否需要改写到数据面代理：
   * - 裸绝对路径（`/_dsh/...`）：**绕过 <base>**，在 dshapp 页面上会直接打到协议处理器 → 404，
   *   必须改写（dsh 客户端大量用 `fetch('/_dsh/…')` 这种裸绝对路径）。
   * - 无端口的页面地址（从 location.origin / location.host 拼出来的，dshapp 页上这两个都没端口）。
   * - dshapp 协议地址（非 http 协议，fetch/WS 会直接报非法 URL）。
   *
   *
   * **带明确端口的 http(s) 地址放行不改写**（lane 的 127.0.0.1:3092、dsh 的 :3080、第三方
   * 本地服务 :4992）——那些是真实服务，改写会把请求错转给上游 dsh → 404（实机踩过：
   * 远程访问 tab 查询失败）。相对路径（./、../）不拦，<base> 已正确解析。
   */
  function pointsAtPage(u) {
    var s = String(u);
    if (s.charAt(0) === '/') return true; // 裸绝对路径绕过 <base> → 代理
    return /^(https?:)?\/\/(localhost|127\.0\.0\.1|\[::1\]|dshapp\.localhost)(\/|$)/i.test(s) ||
      /^dshapp:\/\//i.test(s);
  }


  /** http(s) 形态改写：保留 path+query，origin 换成数据面代理。 */
  function toHttp(u) {
    var s = String(u);
    if (!pointsAtPage(s)) return s;
    var m = /^(?:[a-z][a-z0-9+.-]*:\/\/[^\/]*)?([\/?#][\s\S]*)?$/i.exec(s);
    return HTTP + (m && m[1] ? m[1] : '/');
  }

  /** ws(s) 形态改写：指向本页 host 的换到代理；非法协议（dshapp:）同样改写。 */
  function toWs(u) {
    var s = String(u);
    if (/^wss?:\/\//i.test(s)) {
      var m = /^wss?:\/\/([^\/]+)(\/[\s\S]*)?$/i.exec(s);
      if (m && (m[1] === location.host || m[1] === 'localhost' || m[1] === '127.0.0.1')) {
        return WS + (m[2] || '/');
      }
      return s;
    }
    if (/^dshapp:\/\//i.test(s)) {
      var m2 = /^dshapp:\/\/[^\/]*(\/[\s\S]*)?$/i.exec(s);
      return WS + (m2 && m2[1] ? m2[1] : '/');
    }
    return s;
  }

  /* ---- WebSocket ---- */
  var NativeWS = globalThis.WebSocket;
  function PatchedWS(url, protocols) {
    var fixed = toWs(url);
    return protocols === undefined ? new NativeWS(fixed) : new NativeWS(fixed, protocols);
  }
  PatchedWS.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
    try { PatchedWS[k] = NativeWS[k]; } catch (e) { /* noop */ }
  });
  globalThis.WebSocket = PatchedWS;

  /* ---- fetch ---- */
  var nativeFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    try {
      if (typeof input === 'string') input = toHttp(input);
      else if (input && input.url) input = toHttp(input.url);
    } catch (e) { /* noop */ }
    return nativeFetch.call(globalThis, input, init);
  };

  /* ---- XMLHttpRequest ---- */
  var nativeXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { url = toHttp(url); } catch (e) { /* noop */ }
    return arguments.length > 2
      ? nativeXHROpen.call(this, method, url, arguments[2])
      : nativeXHROpen.call(this, method, url);
  };

  /* ---- EventSource ---- */
  var NativeES = globalThis.EventSource;
  globalThis.EventSource = function (url, cfg) {
    try { url = toHttp(url); } catch (e) { /* noop */ }
    return new NativeES(url, cfg);
  };
  try { EventSource.prototype = NativeES.prototype; } catch (e) { /* noop */ }

  /* ---- window.open ---- */
  var nativeOpenWin = globalThis.open;
  globalThis.open = function (url, name, feats) {
    try { if (url != null) url = toHttp(url); } catch (e) { /* noop */ }
    return nativeOpenWin.call(globalThis, url, name, feats);
  };
})();
