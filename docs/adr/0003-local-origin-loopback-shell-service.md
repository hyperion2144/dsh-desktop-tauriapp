# 访问端本地资产：页面 origin 改为「壳/App 自建 loopback HTTP 服务」，自持令牌防护，新路径不再注入 `ownsHost`

把 dsh 前端产物改成"随包、本地 origin 加载"之后，页面不再是 dsh 服务地址，而是**壳/App 自己起的一个 loopback HTTP 服务**（`http://127.0.0.1:<自选端口>/<per-launch 令牌>/`）：这一个服务同时承担静态资产（读当前生效运行时的 `dsh-web-frontend/dist`）、到 dsh 的反代（`/api/*`、`/plugins/*`）与 `/api/remote.mux` 的 WebSocket 升级透传。页面与数据同源，因此 dsh 的信任栅栏（`isTrustedApiRequest`）天然通过、cookie 自动随行、`__DSH_TRANSPORT__` 与 WS 同源。**在 macOS 与手机端（Expo / 鸿蒙）是同一条架构**。

## Status

accepted（2026-09-27；issue #149 研究、#150 研究、#151 决策；维护者逐条拍板）

## Context

官方 Electron 桌面从不把 dsh 的 web 地址当页面打开：主窗加载自定义协议 `dsh-app://app/`，`/`、`/index.html`、`/assets/*` 直接从内置 `dsh-web-frontend/dist` 读，**其余一切（含 `/plugins/*`、全部 API 与流）转发 Host 并携带壳自持 cookie**（`apps/desktop/src/main.ts:617-635`、`src/web-document.ts:78-93`）。Tauri 2 与 wry **无法照搬**：

- `register_asynchronous_uri_scheme_protocol` 的响应体类型是 `Box<dyn FnOnce(http::Response<Cow<'static, [u8]>>) + Send>`（`tauri-2.11.5/src/app.rs:2455`）——**一次性缓冲，没有 stream 通道**，SSE 与长 chunked（chat / job / shell / 事件流）必破；`asset:` 与 `frontendDist` 走同一协议栈且 `frontendDist` 是构建期嵌入、不能引用运行时外部路径。
- wry **没有任何等价 Electron `webRequest.onBeforeSendHeaders` 的出站头钩子**（`wry-0.55.1/src` 全库无 `webRequest`/`onBeforeSend`；唯一出站钩子只返回 `bool`）。Electron 靠它给 `ws://127.0.0.1/*` 补 cookie（`main.ts:666-677`）；没有它，自定义协议下页面发的 WS 既无 cookie、`Origin` 又是 `<scheme>://localhost`，必被 dsh 拒。

dsh 的拒绝点（`@deepseek-ai/dsh-client-connection/lib/index.js:205-211`）：

```js
if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
const origin = header(request.headers, "origin");
if (origin === undefined) return true;
try { return new URL(origin).host === hostUrl.host; } catch { return false; }
```

只有「页面与 WS 同源」能同时满足 `sec-fetch-site: same-origin` 与 `Origin.host === Host`。另外，平台差异使自定义协议更不可取：macOS 是 `<scheme>://localhost/<path>`、Windows 是 `http://<scheme>.localhost/<path>`（`tauri-2.11.5/src/app.rs:2126-2127`、`:2194-2195`），后者不在 `isLoopbackHostname` 白名单（只认 `localhost` / `[::1]` / `127.0.0.0/8`）。

手机端同样排除本地文件方案：`file://` 与自定义 scheme 都会让页面落进 opaque origin（iOS WKWebView 的 `file://` Cookie 受限、鸿蒙 ArkWeb 官方文档禁止 `file`/`resource` 跨 origin、`react-native-webview@13.16.1` 不暴露 `WKURLSchemeHandler` / `WebViewAssetLoader`）；而"改为跨 origin 访问桌面 dsh"要 `SameSite=None; Secure`，`Secure` 在局域网 `http://` 下永不发送——**硬约束无解**。

## Considered Options

- **Tauri 自定义协议（照搬官方）**：否决——响应体不能流式（`app.rs:2455`），且 wry 无 WS 头钩子。
- **Tauri `asset:` / `frontendDist`**：否决——同一协议栈，同样不能流式；`frontendDist` 不能引用运行时外部路径。
- **手机端 `file://` / 自定义 scheme**：否决——opaque origin、Cookie 与 CORS 双重阻塞（见上）。
- **跨 origin 直连桌面 dsh（页面在本地、数据跨站）**：否决——`SameSite=None; Secure` 在局域网 http 下无解；且要新增一整套 CORS 预检。
- **壳/App 自建 loopback HTTP 服务**（选中）：页面与数据同源，流式、WS、Cookie 全部恢复常态；不依赖任何 WebView 私有 hook，三端同构。
- **入口防护只靠 `Origin` + `Sec-Fetch-Site`**：否决——这两个头能挡住**浏览器**跨站请求（JS 伪造不了），但**本机任意进程**可以自己伪造；而壳的代理是唯一持有 dsh session cookie 的一方，等于把 dsh 的 loopback 信任面复制了一份出来。
- **入口防护只靠令牌**：否决——失去与 dsh 自身栅栏一致的语义校验。
- **防护 = `Origin`/`Sec-Fetch-Site` 精确校验 + per-launch 随机路径令牌**（选中）：浏览器被前者挡、本机进程被后者挡。

## Consequences

- **页面 origin** = `http://127.0.0.1:<自选端口>/<per-launch 令牌>/`。令牌进路径，因此 `__DSH_TRANSPORT__.streamBaseUrl` 必须带尾斜杠（dsh 用 `new URL('api/remote.mux', streamBaseUrl)` 相对解析，`dsh-api-gateway/lib/client.js:730`）。
- **`ownsHost` 在本地资产路径上退场**：页面 hostname 就是 `127.0.0.1`，dsh 的 `isLoopback` 天然为真（`dsh-client-connection/lib/client.js:1404`）。**ADR 0002 的 `ownsHost` 注入降级为「旧路径（浏览器/远程直连 dsh 地址）专用」**，新路径不再注入——ADR 0002 因此被本 ADR **amended**（不是 superseded：它对既有 path 仍然有效）。
- **cookie 由壳持有**：反代必须让 dsh 看到的 `Host` 仍是 `127.0.0.1:<dsh 端口>`（cookie 名是 `sha256(authority)`，`dsh-client-connection/lib/index.js:284-286`），同时**剥掉响应里的 `set-cookie`**（否则 webview cookie jar 与壳的"真值"漂移）——同官方 `WITHHELD_RESPONSE_HEADERS`（`web-document.ts:58-62`）。
- **`/plugins/*` 必须转发**（combo `plugins/??…&rev=…`、chunk `plugins/<pkg>/client.<name>.js?rev=…`、`.map`），且响应改 `cache-control: no-store`：dsh 用 revision 标 immutable，壳重启会换 revision，旧缓存不可复用（`web-document.ts:64-65/91`）。
- **不需要 `boot()` 命令与 injections 契约**（2026-09-27 实现时修订，见 ADR 0004 “本地优先静态叠加”）：官方的 injections 由 Host 运行时组装，壳侧拿不到（官方走 `host-process.ts:212` 的进程间消息，本壳只从 stdout 解析 token 行）。改为让 `/` 与 `/index.html` 也走反代（Host 自己生成注入），壳只做静态叠加——页面照旧拿到完整的 `__DSH_BOOT__` 与 `__ModuleLoader__`，不需要 `dshDesktopBoot` 或 `__DSH_BOOT_READY__`。
- **旧路径保留为兜底**（自动降级 + 设置里可见开关），发版验证后再议；`navigation` 的 token→cookie 三步链保留为"cookie 已就绪"的信号，但种 cookie 的目标 origin 从 dsh 端口改为壳端口。
- **手机端**：App 内 loopback 服务使手机页面也天然 loopback，于是 #145 的 `ownsHost` 注入在手机新路径上同样退场；lane 仍承担传输与配对边界（配对会话 cookie 由 App 侧持有并注入）。
