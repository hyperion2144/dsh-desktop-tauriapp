# dsh-desktop-tauriapp 现有桌面壳能力清单

> 只读取证，事实底盘。仓库：`/Users/mutou/vault/projects/dsh-desktop-tauriapp`（worktree `.agents/worktrees/map/204-electrobun-shell`，与 `main` 无 diff）。
> 口径：每条给 `文件:行号`；读不懂或仓内不存在的写「未确认」，不猜。
> 证据基线：commit 与 `main` 一致；`desktop/src-tauri/src` 68 个 `.rs` 共 18,389 行（`wc -l`）。
> 版本：`tauri.conf.json` / `Cargo.toml` / 根 `package.json` 均为 **0.12.0**。

---

## 0. 壳的形状（一句话）

Tauri 2（wry/WKWebView+WebView2）Rust 主进程 + **随包分发的 Node sidecar + 532MB dsh npm 树**；页面不走 `http://127.0.0.1` 而是壳自注册的 `dshapp://` 协议，数据面另开一条 loopback TCP 代理（为了 SSE/WS 不被缓冲协议处理器卡死）。

---

## 1. 自定义 scheme 注册与资产服务

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| 自定义协议名 `dshapp` | `desktop/src-tauri/src/network/shell_origin/scheme.rs:23` | 壳自己注册的页面协议，官方 Electron 的 `dsh-app://` 的 Tauri 对应物 | — | 否 |
| 协议处理器注册（异步） | `desktop/src-tauri/src/lib.rs:170-175` | `register_asynchronous_uri_scheme_protocol("dshapp", …)`，每次请求 spawn 一个 tokio 任务再 `responder.respond` | `Builder::register_asynchronous_uri_scheme_protocol` | 否 |
| 页面 origin 常量（macOS/Linux） | `shell_origin/scheme.rs:32` | `dshapp://localhost` | — | 否 |
| 页面 origin 常量（Windows） | `shell_origin/scheme.rs:30` | `http://dshapp.localhost`（WebView2 对自定义协议的既定映射；注释 `scheme.rs:26-29` 说明 nav_guard 白名单必须用对应形态） | — | 否 |
| 为什么必须是自定义协议 | `shell_origin/scheme.rs:2-8` | Tauri `is_local_url` 把「用户注册的协议」判为 `Origin::Local` → IPC 命中完整 `capabilities/default.json`；换成 `http://127.0.0.1:<port>` 判为 `Origin::Remote` 只命中精简 capability，设置 IPC 被整片拒 | — | 否 |
| 协议处理器职责收敛 | `shell_origin/scheme.rs:63-94` | 只做三件：启动页 → 文档 → 本地静态资产 → 404；**没有转发上游分支**，数据面一律经 `<base>` 落到流式代理 | `UriSchemeResponder` | 否 |
| 路径解析用 `path_and_query` | `shell_origin/scheme.rs:47-51` | 必须取 query，否则 `/plugins/??id1,id2&rev=…` combo 路由退化成裸 `/plugins/` → 404 启动卡死 | — | 否 |
| 文档 = 上游 HTML 原文 | `shell_origin/scheme.rs:113-137` | 不用「本地 dist 的 index.html + 抠注入段」，直接取上游首页 HTML，保住 `tapIndex` 注入（`scheme.rs:107-112` 注释） | `reqwest` | 否 |
| 取上游首页的重试 | `shell_origin/scheme.rs:140-158` | 15 次 × 200ms（约 3s）等待上游出页面，避免切运行时/重启瞬间白屏 | — | 否 |
| `<base href="./">` 改写到代理 origin | `shell_origin/scheme.rs:181-190` | 找不到该标记就报错（否则相对请求会落在缓冲的协议处理器上）；尾斜杠必须带（`scheme.rs:174-177`） | — | 否 |
| 去掉 PWA manifest link | `shell_origin/scheme.rs:192-197` | base 指向代理后 `start_url` 与文档 origin 不一致会触发 WebKit 告警 | — | 否 |
| 剥掉 lane 的页面级补丁 | `shell_origin/scheme.rs:209-227` | 远程模式下重发上游 HTML 时删掉 `data-dsh-mobile-owns-host` / `theme-sync` / `loopback` 三个 `<script>`（否则 WS 被改写成 `/_loopback/…` 永远连不上） | — | 否 |
| 内嵌启动页 `/__startup` | `shell_origin/scheme.rs:248-286` | HTML/CSS/PNG 用 `include_str!`/`include_bytes!` 编进二进制（`scheme.rs:253-255`），不依赖 Tauri asset 协议（`tauri dev` 下后者会 `asset not found: index.html` 白屏） | — | 否 |
| 应答统一 `cache-control: no-store` | `shell_origin/scheme.rs:96-104` | 协议处理器所有应答禁缓存 | — | 否 |
| CSP | `desktop/src-tauri/tauri.conf.json:37-39` | `"security": {"csp": null}` —— **完全关闭 CSP** | Tauri csp 配置 | 否 |
| 资产层 dist 定位 | `shell_origin/assets.rs:16`、`:36-46`、`:125-153` | 从 `node_modules/@deepseek-ai/dsh/lib/bin.js` 向上最多 8 层找 `node_modules/@deepseek-ai/dsh-web-frontend/dist`，结果缓存，仅由 `shell_origin::reset` 失效 | — | 否 |
| dist 解析优先级 | `shell_origin/assets.rs:125-137` | ① 远程闸门 OVERRIDE → ② 设置选中的已下载运行时 → ③ 随包内置树 → ④ 外部 CLI 树 | — | 否 |
| 本地优先是构造上安全的 | `shell_origin/assets.rs:9-10`、`stream_proxy.rs:159-163` | Vite 产物文件名即内容 hash，同名必同内容，版本错配自然退化为转发 | — | 否 |
| 路径穿越防护 | `shell_origin/assets.rs:222-243` | 拒绝 `..`/`.`/空段/含 `\` 或 `:` 的段/解码后含 NUL | — | 否 |
| MIME 表 | `shell_origin/assets.rs:170-201` | 17 种扩展名映射，js/mjs → `text/javascript` | — | 否 |
| 构建标识（远程闸门用） | `shell_origin/assets.rs:88-91`、`:106-133` | 从 dist 的 `index.html` 里取 `assets/index-<hash>.js` 作为构建指纹 | — | 否 |
| 会话 cookie 绑定 authority | `shell_origin/mod.rs:75-96` | 壳持有上游会话 cookie；cookie 名是 `sha256(authority)`，authority 不匹配就当作未认证转发（`mod.rs:41-49`） | — | 否 |
| `shell_origin::start` / `reset` | `shell_origin/mod.rs:54-67`、`:31-35` | setup 起流式代理并记下 origin；reset 清会话 + 清 dist override + 失效缓存 | — | 否 |

---

## 2. 页面注入（逐个全局）

### 2a. `page_shim.js`（常驻注入，随文档 `<head>` 下发）

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| `globalThis.__DSH_TRANSPORT__` | `shell_origin/page_shim.js:20-21` | `{ streamBaseUrl: '<代理origin>', ownsHost: true }`；`ownsHost` 是 dsh 官方解锁位（Windows 上页面 hostname 不在 loopback 白名单，靠它开设置 RPC） | — | **是**（HTML 内联 `<script>`） |
| `globalThis.WebSocket` | `shell_origin/page_shim.js:72-82` | 包一层把指向本页 host / `dshapp:` 的 URL 改写到 `ws://<代理>`；拷贝 `CONNECTING/OPEN/CLOSING/CLOSED` 常量与 prototype | — | **是** |
| `globalThis.fetch` | `shell_origin/page_shim.js:84-92` | 字符串入参和 `Request.url` 都过 `toHttp()` 改写；`init` 原样透传 | — | **是** |
| `XMLHttpRequest.prototype.open` | `shell_origin/page_shim.js:94-101` | 改写 url 参数，保留 async/user/password 三参形态 | — | **是** |
| `globalThis.EventSource` | `shell_origin/page_shim.js:103-109` | 改写 URL 后 `new NativeES(url, cfg)`，prototype 复用原生 | — | **是** |
| `globalThis.open`（window.open） | `shell_origin/page_shim.js:111-115` | 改写 URL 后转原生 open | — | **是** |
| 改写判定 `pointsAtPage` | `shell_origin/page_shim.js:38-46` | 拦：裸绝对路径（`/_dsh/…`，绕过 `<base>`）、无端口页面地址（`localhost`/`127.0.0.1`/`[::1]`/`dshapp.localhost`）、`dshapp://`。**放行带明确端口的 http(s)**（lane :3092、dsh :3080、第三方本地服务 :4992）与相对路径 | — | **是** |
| 注入位置 | `shell_origin/scheme.rs:290-306` | 插在 `</head>` 之前（`<base>` 已解析完，诊断脚本里的 `./__diag` 才指向代理） | — | **是** |
| 占位符替换 | `shell_origin/scheme.rs:295-297` | `__DSH_STREAM_BASE__` → 真实代理 origin（带尾斜杠） | — | **是** |
| 为什么在自定义协议页上要猴补丁 | `shell_origin/page_shim.js:2-16` | 第三方插件普遍直接拿 `location` 拼 WS/fetch 地址，在 `dshapp://` 上是非法 URL（WKWebView 抛 "The string did not match the expected pattern."） | — | — |
| 语法回归防护测试 | `shell_origin/scheme.rs:440-514`、`:517-560` | 在 Node 里真跑一遍注入脚本，断言 URL 改写；**Windows origin 单独一份** | — | — |

### 2b. WebView `initialization_script`（document-start，Tauri 原生注入）

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| `globalThis.dshDesktop` 载体 | `desktop/src-tauri/src/ui/browser_guests/mod.rs:659-683` | `protocolVersion:1` + `browser.{acquire,release,onOpenRequested}` + `keyboard.{subscribe,closeWindow}` + `shortcuts.{get,edit,subscribe,recording}`，方法体惰性转发到 `__dshShellBridgeImpl` | `WebviewWindowBuilder::initialization_script` | **是** |
| 平台名标记 | `ui/browser_guests/mod.rs:653-658` + `:539-553` | 写 `document.documentElement.dataset.platform = 'macos'/'win32'/'linux'`（**不能写 `darwin`**，见 `AGENTS.md` 血泪坑 11 与 `mod.rs:540-543` 注释） | 同上 | **是** |
| origin 白名单 | `ui/browser_guests/mod.rs:564-587` | 只在 `dshapp://localhost` / `http://dshapp.localhost` / `http://127.0.0.1` / `http://localhost`（含带端口形态）安装载体 | 同上 | **是** |
| bridge 就绪宽限 | `ui/browser_guests/mod.rs:635-650` | `whenReady` 轮询至多 4s，`whenKeyboard` 至多 30s，超时按无桥降级（绑定只读） | 同上 | **是** |
| 远程窗口 ownsHost 注入 | `ui/browser_guests/mod.rs:690-712`、`lib.rs:332-336` | 只对壳配置的远程主机注入 `__DSH_TRANSPORT__={ownsHost:true}`；**不装 dshDesktop 载体**；主机名先过字符白名单防注入 | 同上 | **是** |
| 次窗口同样的注入 | `desktop/src-tauri/src/ui/multiwin.rs:213`、`:215-217` | `profile-*` 窗口复用同一套 carrier + ownsHost 脚本 | 同上 | **是** |

### 2c. 其它 `eval` 注入（post-load，非 document-start）

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| 启动期 profile 选择 UI | `desktop/src-tauri/inject_startup_check.js`（全文）+ `lib.rs:415` | 需要用户选 profile 或 profile 不完整时，整段 JS eval 进启动页，弹 profile 列表 / 新建 / 修复卡片 | `WebviewWindow::eval` | **是** |
| 任务完成通知桥 | `desktop/src-tauri/src/network/notify.rs:187-245`、`navigation/mod.rs:44` | 导航后延迟 2.5s eval 一段脚本：轮询 DOM 判 busy→idle，POST 到 `127.0.0.1:<notify_port>/notify` | `WebviewWindow::eval` | **是** |
| 错误横幅 | `desktop/src-tauri/src/ui/window.rs:12-28` | `show_error` eval 出红色 banner + 改启动页状态文字，不导航到 error.html | `WebviewWindow::eval` | **是** |
| guest 状态推送 | `ui/browser_guests/mod.rs:190`、`:205` | 每次 guest 状态变化后 eval `__dshShellBridgeImpl._receive(快照)`（dsh 对 `<webview>` 是同步拉取，Tauri IPC 是异步，所以用推送+镜像） | `WebviewWindow::eval` | **是** |
| `location.replace` 式重定向 | `navigation/mod.rs:299`、`:322`、`ui/tray.rs:352`、`ui/multiwin.rs:441`、`:456` | 切运行时/切模式时用 JS 跳转（与 `navigate_main` 的原生 `navigate` 相对） | `WebviewWindow::eval` | **是** |

---

## 3. 流与网络

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| 独立 loopback 流式数据面 | `shell_origin/stream_proxy.rs:91-120`、`lib.rs:389-393` | `TcpListener::bind(("127.0.0.1", 0))` 起一条真 TCP，端口系统分配；页面仍走 `dshapp://`（保住 Local origin + 完整 capability） | — | 否 |
| 为什么必须单开端口 | `shell_origin/stream_proxy.rs:2-13` | `UriSchemeResponder` 只接受 `Response<Vec<u8>>`（一次性缓冲），SSE 经它必挂（实测响应头到了、body 永不 EOF、悬停 >5min） | — | 否 |
| **SSE 单连接寿命上限 30 分钟** | `shell_origin/stream_proxy.rs:29`、`:282-290` | `SSE_MAX_LIFETIME = 30*60s`；到期主动断开让页面重连、重建异步迭代器。依据：WebKit 崩溃报告里 `JSC::asyncIteratorNextWithDriver` SIGSEGV、崩溃前 WebContent 常驻 1.2GB、三次间隔 55–65min（注释 `stream_proxy.rs:270-281`） | — | 否 |
| SSE 判定依据 | `shell_origin/stream_proxy.rs:272-278` | 响应 `content-type` 含 `text/event-stream` 才加上限；非 SSE 不加上限（保持长连接语义） | — | 否 |
| 上限可测 | `shell_origin/stream_proxy.rs:35-88` | `pump_body` 把上限作为参数传入，测试用 50ms 证明到期必断 | — | 否 |
| **OPTIONS 预检本地应答** | `shell_origin/stream_proxy.rs:134-143` | 页面在 `dshapp://` 上、RPC 打本代理是跨源，`POST`+`application/json` 必先发 OPTIONS；本地直接回 204 + `allow-origin: *` / `allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS` / `allow-headers: *` / `max-age: 600` | — | 否 |
| `/__diag` 本地应答 | `shell_origin/stream_proxy.rs:145-155` | 页面自报探针路径不转 dsh（dsh 没这个路由，转发只会 404），本地 204 并记日志 | — | 否 |
| **CORS 补头** | `shell_origin/head.rs:145-150`、`stream_proxy.rs:210`、`stream_proxy.rs:264` | 所有上游响应补 `access-control-allow-origin: *`（页面在 `dshapp://`，对本代理是跨源；浏览器侧不需要凭据，cookie 由中继在服务端注入，所以 `*` 就够） | — | 否 |
| **Host 头改写** | `shell_origin/head.rs:118-138` | 上行请求强制 `Host: <authority>`、`Origin: <http(s)://authority>`、`Sec-Fetch-Site: same-origin`，cookie 有则替换、无则删除，connection 强制 `close`（upgrade 时保留 `Upgrade`） | — | 否 |
| **响应头剥 set-cookie** | `shell_origin/head.rs:144` | 会话由壳持有，剥掉 `set-cookie` 防止 webview cookie jar 与壳的真值漂移 | — | 否 |
| 缓存头处理 | `shell_origin/head.rs:151-157`、`stream_proxy.rs:317`、`scheme.rs:100` | 插件 bundle（`/plugins/` 前缀）剥 `cache-control`/`expires`/`pragma` 改 `no-store`（dsh 用 revision 标 immutable，壳重启换 revision 旧缓存不可复用）；本地资产也是 `no-store`；协议处理器应答一律 `no-store` | — | 否 |
| **WS 隧道** | `shell_origin/stream_proxy.rs:176-181`、`:189-192`、`:253-262`、`:275-280` | 双 `tokio::io::split` + `tokio::spawn(copy)` 实现请求方向 pump；先开泵再等响应头（否则带 body 的 POST 与上游互等，settings/describe、llm/listProviders 永不返回）；握手结果逐条记 `[stream-proxy] WS … -> 101/403` | — | 否 |
| TLS 上游 | `shell_origin/upstream.rs:106-127` | 远程 https 走 `tokio_native_tls`；**loopback/局域网也关 Nagle**（否则小块 JSON-RPC 被攒包） | — | 否 |
| 上游实时解析（不缓存） | `shell_origin/upstream.rs:85-101` | 每次请求现读 settings + `DshState.main_worker.port()`，dsh 重启/切 profile 后端口变了不会连到死实例 | — | 否 |
| 远程地址解析 | `shell_origin/upstream.rs:37-62` | 完整 URL（http/https）或旧格式 `host[:port]` → `(secure, authority)`；无端口补 `:3080` | — | 否 |
| 报文头上限 64 KiB | `shell_origin/head.rs:9`、`stream_proxy.rs:25` | 超限视为畸形连接直接断 | — | 否 |
| obs-fold 视为畸形 | `shell_origin/head.rs:107-110` | HTTP/1.1 已废弃，浏览器不发，遇到直接 None | — | 否 |
| 耗时仪表 | `shell_origin/stream_proxy.rs:183-189`、`:266-281` | 记录 `connect=` 与 `ttfb=`；ttfb≥200ms 记 `[stream-proxy] SLOW`（用户实报「有时候读内容很慢」的可观测化） | — | 否 |
| 首字节前先写静态资产 | `shell_origin/stream_proxy.rs:158-173` | dist 命中就本地应答不连上游；`.map` 源映射统一回 204（运行时 dist 不随包分发） | — | 否 |
| lane TCP 转发器 | `desktop/src-tauri/src/network/forwarder.rs:11-40` | 壳在 3091 监听转发到「焦点窗口实例」的 lane，手机旧配置零改动，新连接落焦点实例 | — | 否 |
| 通知桥 HTTP 服务 | `network/notify.rs:14-44`、`:46-52` | 127.0.0.1 随机端口 + token，`/notify` POST；带完整 CORS 头（否则 preflight 被浏览器拦，0.3.0 通知收不到的根因） | — | 否 |
| `stream_coalesce_ms`（下行合流） | — | **未确认**：全仓（rs/ts/mjs/json/yaml/md）grep `stream_coalesce` / `streamCoalesce` 无命中；`coalesce` 仅出现在 `mobile/harmony/…/dsh-web-mobile/client.js` 与内置 dsh 运行时若干 UI 包，与壳无关。壳内**没有**下行合流配置。 | — | — |

---

## 4. 导航与安全

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| 导航守卫插件 | `desktop/src-tauri/src/ui/nav_guard.rs:17-30`、`lib.rs:142` | `on_navigation` 钩子：browser-guest-* label 豁免，其余走 `navigate_guard` | Tauri `plugin::Builder::on_navigation` | 否 |
| 内部主机白名单 | `ui/nav_guard.rs:35-45` | `127.0.0.1` / `::1` / `localhost` / `tauri.localhost` / `dshapp.localhost` + 运行时放行的远程 dsh 主机（`INTERNAL_HOSTS` 动态表） | — | 否 |
| 外链拦截（只拦不开） | `ui/nav_guard.rs:47-59` | 顶层外部 http(s) 导航阻止且**不**转浏览器（官方 Electron 会 `openExternal`，实测会把用户甩出应用） | — | 否 |
| mailto/tel 转系统 | `ui/nav_guard.rs:61-67` | 用户主动点击的协议链接仍转系统 | — | 否 |
| 新窗守卫 | `ui/nav_guard.rs:88-101`、`lib.rs:355-361` | `on_new_window` 一律 Deny；http(s)/mailto/tel 转系统浏览器，其余协议丢弃 | `WebviewWindowBuilder::on_new_window` | 否 |
| capabilities: `default` | `desktop/src-tauri/capabilities/default.json:1-84` | 窗口 `main` + `profile-*`；共 **75 条 permission**（其中 70 条 `allow-*` + `core:default` + `notification:default` + `dialog:allow-confirm` + `dialog:allow-message` + `core:window:allow-start-dragging`），覆盖 client env / 通知 / dialog / 拖拽 / 外部打开 / 日志 / 模式 / dsh 状态与重启 / 桌宠 4 项 / 代理 3 项 / 设置 / 通知 5 项 / profile / 远程 / 运行时 5 项 / 端口 / 下载 12 项 / browser guest 8 项 / keybindings 2 项 / 关窗 | Tauri capability | 否 |
| capabilities: `remote-desktop` | `capabilities/remote-desktop.json:1-72` | remote origin（`http://127.0.0.1*` / `http://localhost*`）走 **74 条** 精简集，只放行窗口控制 + 设置 + 通知 + 远程 + profile + 运行时 + 下载 + guest，**不放 tray/dialog** | 同上 | 否 |
| capabilities: `pet` | `capabilities/pet.json`（8 条） | 窗口 `pet`：`core:default` + 拖拽 + `allow-set-ignore-cursor-events` + 桌宠 4 项 + 缩放 | 同上 | 否 |
| capabilities: `proxy-settings` | `capabilities/proxy-settings.json`（6 条） | 窗口 `proxy-settings`：拖拽 + 代理读写/测试 + 重启 dsh | 同上 | 否 |
| 应用自命令权限清单 | `desktop/src-tauri/permissions/app-commands.toml`（13,119 字节） | `commands.allow` 用下划线命令名、`allow-*` 标识符用连字符；改动须同时改这里 + capabilities | 同上 | 否 |
| 原生下载拦截 | `lib.rs:337-353` | wry 无 handler 时 macOS WKWebView 静默取消所有下载，所以主窗挂 `on_download`；http(s) 转 Rust 下载管理器，其余取消记日志 | `WebviewWindowBuilder::on_download` | 否 |
| guest 顶层导航策略 | `ui/browser_guests/policy.rs`（75 行） | 放行外部 http(s)、拒带凭证 URL / 应用宿主（对齐官方 browser-guests.ts 边界） | — | 否 |
| 子 webview 使用 | `Cargo.toml:22`（`features=[… "unstable"]`） | `Window::add_child` 承载侧边栏浏览器 guest（同窗子 webview） | Tauri unstable API | 否 |
| **IPC 命令数** | `#[tauri::command]` 共 **62** 处：`src/commands.rs:46` + `src/download/commands.rs:11` + `src/ui/pet.rs:4` + `src/platform.rs:1`；`lib.rs:176-279` 的 `generate_handler!` 注册 **75** 条 | — | Tauri IPC | 否 |

---

## 5. 窗口与生命周期

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| 主窗代码创建 | `lib.rs:317-363` | 不用 `tauri.conf.json` 声明（要挂下载处理器）；1280×840、最小 940×620、居中、`disable_drag_drop_handler` | `WebviewWindowBuilder` | 否 |
| 窗口状态持久化 | `lib.rs:154-158` | `tauri-plugin-window-state`，denylist `pet` | 插件 | 否 |
| **多窗口**（profile ↔ 窗口） | `ui/multiwin.rs:1-8`、`:26-93` | 每 profile 至多一窗，label `profile-<name>`；托盘「PROFILE 窗口」分组：运行中→聚焦，未运行→开新窗 | `WebviewWindowBuilder` | 否 |
| 次窗口关闭语义 | `lib.rs:700-708`、`ui/multiwin.rs:543-549` | 关窗 = 只销毁窗口 UI、实例保留（#178 定稿） | — | 否 |
| **多 profile 每 profile 端口** | `settings.rs:361-368`（`default_port_for_profile`）、`:372-382`、`:299-303`（`configured_port`）、`:400-424`（`port_for_profile`） | web=3080、desktop=3081、其余 `3082 + fnv1a(profile) % 512` 且冲突向后避让并持久化；lane 端口同构（web=3092、desktop=3093、其余 3094+） | — | 否 |
| 端口优先级链 | `settings.rs:400-404`、`src/runtime/builtin.rs:66-76` | `DSH_DESKTOP_PORT` env > `profile_ports[profile]` > web 的 legacy `settings.port` > 默认公式 | — | 否 |
| 默认 profile | `settings.rs:427-437` | 全新安装→`desktop`；存量未设→`web`（不静默搬家） | — | 否 |
| **单实例** | `lib.rs:163-174` | `tauri-plugin-single-instance`，二次启动只 `show_main`；`DSH_DESKTOP_NO_SINGLETON=1` 时跳过（测试钩子） | 插件 | 否 |
| 端口认领台账 | `lib.rs:388-435` + `runtime/instances.rs` | Free→拉起；Ours→复用；ForeignWeb→兼容模式复用；ForeignUnknown→**不代杀不代拉**，报错弹通知 | — | 否 |
| **深链 / OS 级 URL scheme** | — | **不存在**：全仓无 `deep_link`/`RunEvent::Opened`/`CFBundleURLTypes`；`dshapp` 只在进程内注册（`lib.rs:170`），未向 macOS/Windows 注册为可被外部唤起的 scheme | — | 否 |
| **关闭到托盘** | `lib.rs:709-731` | 主窗 `CloseRequested` → `prevent_close` + `hide()`，首次弹一次通知；`RunEvent::ExitRequested` → `prevent_exit` + hide（`lib.rs:738-747`） | `WindowEvent` / `RunEvent` | 否 |
| macOS Dock 再激活 | `lib.rs:748-754` | `RunEvent::Reopen` 且无可见窗 → `show_main` | — | 否 |
| 退出回收 | `lib.rs:755-776` | 停主 worker、摘台账、清防休眠租约、逐个 shutdown 次实例 worker、清 profile 下的插件 junction/symlink | — | 否 |
| 托盘左键 | `ui/tray.rs:271-280`、`ui/window.rs:44-56` | 聚焦「最后聚焦窗口」（可能次窗）；主实例已停且非启动期 → 重新拉起并导航 | — | 否 |
| 标题栏形态 | `lib.rs:731-741`、`ui/tray.rs:apply_titlebar` | macOS `titleBarStyle:Overlay`（保留原生红绿灯）；Windows/Linux `decorations:false` 由插件 client 自绘 caption | Tauri window builder | 否 |
| 桌宠窗口 | `desktop/src-tauri/tauri.conf.json:13-34`、`ui/pet.rs:1-133`、`lib.rs:376` | 透明置顶 260×300、`focusable:false`、`skipTaskbar`、`visibleOnAllWorkspaces`；位置 400ms 防抖落盘、多屏钳位；关闭只隐藏不退出（`lib.rs:683-698`） | Tauri | 否 |
| 启动状态机 | `lib.rs:281-306`、`runtime/state.rs` | 只有 `STATUS_STARTING(1)` / `STATUS_READY(2)` + `set_status`（写 state + emit `dsh-status`） | — | 否 |
| 就绪导航三步 | `navigation/mod.rs:242-352` | token→cookie→200：换会话 cookie、种入 webview、导航**不带 token 的根路径**（带 token 会走 dsh 的 token 校验分支，webview 跨站 303 链过不去） | — | 否 |
| 导航用原生 `navigate` 而非 JS | `navigation/mod.rs:33-40` | 实测 JS 导航到自定义协议被 WKWebView 静默忽略（协议处理器调用次数=0） | `WebviewWindow::navigate` | 否 |
| 守护器（watchdog） | `lib.rs:606-676` | 5s 一次 TCP 判活；运行中连不上=异常立即分流；自愈 3 次封顶、连续健康≥2 分钟（24 tick）才重置；只管运行中（`ready_once` 门） | — | 否 |
| 测试钩子 | `lib.rs:742-750`、`755-775`、`780-805`、`lib.rs:744` 附近 | `DSH_DESKTOP_AUTO_QUIT` / `_PROXY_RESTART_TEST` / `_NOTIFY_TEST` / `_NO_SINGLETON` | — | 否 |

---

## 6. 系统集成

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| **托盘菜单项** | `ui/tray.rs:46-171` | 「显示主窗口」「显示/隐藏桌宠」+ 5 个子菜单（PROFILE 窗口 / 切换 Profile（本窗口）/ 运行时版本 / dsh 服务地址 / 新建·迁移 Profile）+ 条件项「注册 dsh 命令」+「重启 dsh 服务」「切换兼容/高级模式」「退出」 | `TrayIconBuilder` | 否 |
| 托盘行为 | `ui/tray.rs:200-205`、`:271-280` | id `dsh-tray`、`icon_as_template(false)`、tooltip「DeepSeek Harness Desktop」、左键不弹菜单（改为聚焦最后窗口） | — | 否 |
| 托盘 15s 重建 | `ui/tray.rs:282-290` | 状态实时性兜底：`refresh_tray_mode` 每 15s 重建菜单 | — | 否 |
| **应用菜单（macOS 顶部菜单栏）** | — | **不存在**：`grep set_menu\|Menu::default\|Submenu::with_id` 只命中 `tray.set_menu`（`ui/tray.rs:179`）；没有 `app.set_menu` | — | 否 |
| **系统通知** | `network/notify.rs:254-315`、`notify_un.rs`（120 行） | macOS 直连 `UNUserNotificationCenter`（插件的桌面端权限 API 是硬编码 Granted 的桩，不走插件）；Windows/Linux 走插件幂等确认 | `tauri-plugin-notification` + `mac-usernotifications` | 否 |
| 通知场景策略 | `network/notify_policy.rs:11-24`、`:38-48`、`:50-66` | **14 个场景**（startup.error / runtime.switch / runtime.download / service.health / window.lifecycle / instance.lifecycle / task.complete / download.complete / profile.op / profile.error / config.error / config.info / dsh.approval / dsh.error），分 6 组，各带开关 + 音效档 + 免打扰时段 + 全屏静默 | — | 否 |
| 通知音效 | `network/sounds.rs:1-15`、`:24-28` | `custom:<名>` 半区：文件入库（扩展名 + 魔数 + ≤5MB 校验，复制进 `$DSH_HOME/sounds/`）+ `rodio` 应用侧播放（≤10s 截断）；`default` 档走系统音 `afplay` | `rodio` | 否 |
| **全局快捷键** | — | **不存在**：无 `tauri-plugin-global-shortcut`、`global_shortcut`/`GlobalShortcut` 全仓零命中 | — | 否 |
| 桌面档快捷键（非全局） | `desktop/src-tauri/src/shortcuts.rs:1-56`、`ui/browser_guests/mod.rs:669-677` | 偏好文件 `$DSH_HOME/desktop-keybindings.json`（≤256KiB，原子写）；Rust 只读原始文本/原子回写，语义全在页面侧 `src/client/platform-keyboard.ts` | — | 是（经 `dshDesktop.shortcuts` 桥） |
| **上下文菜单** | — | **不存在**：无 `tauri-plugin-context-menu`；唯一的 `menu_event` 是托盘菜单回调（`ui/tray.rs:206`） | — | 否 |
| 系统命令注册（dsh CLI） | `desktop/src-tauri/src/register/mod.rs:1-16`、`:126-199`、`:201-` | 检测三态（已注册/冲突/未注册），注册物是壳维护的 shim `app_data_dir/runtime/bin-dsh/dsh`（unix）/`dsh.cmd`（win），「已注册」判定要 spawn 登录 shell 看真实 PATH 解析（`register/mod.rs:420` `run_with_timeout`）；检测异步缓存，菜单构建路径零 shell 调用 | — | 否 |
| `open_external` | `desktop/src-tauri/src/platform.rs`（91 行） | macOS 走系统 opener；Windows 走 `ShellExecuteW`（`windows-sys` 的 `Win32_UI_Shell`） | 系统 API | 否 |
| **防休眠** | `desktop/src-tauri/src/power/mod.rs:1-12`、`:19-21`、`:29-32`、`:52-54` | 纯状态机 `Arbiter` + 1s tick 线程（`dsh-keepawake`）；「会话在跑」由宿主插件经 `/notify` 的 `busy-state` 上报，**等审批/等输入不算**；只挡空闲系统休眠，屏幕照熄、合盖不挡 | macOS `IOPMAssertionCreateWithName`（core-foundation）、Windows `SetThreadExecutionState`（windows-sys `Win32_System_Power`） | 否 |
| 开关与语义边界 | `power/mod.rs:1-7`、`settings.rs:461-465` | 缺省 true；只挡空闲休眠（macOS 断言做不到合盖）；心跳超时**不**作释放条件（误释放比多持更糟） | — | 否 |
| **下载管理器** | `desktop/src-tauri/src/download/manager.rs:1-7`、`:143`、`:467-579` | 任务表 + 并发调度（默认 3，钳 1..=32）+ 暂停/恢复/取消 + blob 分块管线 + `downloads://changed` 全量快照事件 + tasks.json 持久化 | — | 否 |
| 浏览器 guest 子 webview | `ui/browser_guests/mod.rs:1-23`、`:389-520` | 侧边栏浏览器从 iframe 换成宿主窗口里的**子 webview**（#118/#134）；租约注册表 + 8 个 IPC 命令；原生历史读控（mac `objc2 msg_send` goBack/goForward、Windows `webview2-com` COM） | Tauri `add_child`（unstable）+ objc2 / webview2-com | 是（载体桥） |

---

## 7. 设置与代理

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| **settings 文件位置** | `settings.rs:161-164` | `$DSH_HOME/desktop-settings.json`（`DSH_HOME` env 支持 `~` 展开，`:186-211`；缺省 `~/.dsh`） | — | 否 |
| 旧 yaml 只读迁移 | `settings.rs:166-170`、`:237-260`、`:266-285` | `$DSH_HOME/settings.yaml` 的 `dsh-desktop-tauriapp:`（或 legacy `desktop:`）块**一次性**迁到私有 JSON，永不写回；损坏时备份为 `.json.corrupt` 后重建 | — | 否 |
| 原子写 | `settings.rs:213-224` | 先写 `.json.tmp` 再 `rename` | — | 否 |
| **字段清单（27 项）** | `settings.rs:78-158` | `port` / `active_profile` / `remote_addr` / `remote_list: Vec<String>` / `remote_session` / `lane_port` / `cloudflared_bin` / `proxy_mode` / `proxy_url` / `no_proxy` / `proxy_user` / `proxy_pass` / `download_concurrency` / `mux_heartbeat_ms` / `desktop_layout_on_phones` / `desktop_render_budget` / `prevent_sleep` / `profile_ports: BTreeMap<String,u16>` / `profile_lane_ports` / `dsh_mode` / `dsh_runtime` / `runtime_source` / `runtime_github_repo` / `tunnel_url` / `ws_keepalive_ms` / `ws_pong_timeout_ms` / `notifications: NotificationsConfig` | — | 否 |
| 通知子结构 | `settings.rs:17-72` | `notifications.enabled` + `dnd{on,from,to,suppress_fullscreen}`（默认 22:00–08:00）+ `scenarios: BTreeMap<String, {enabled, sound}>`（默认 sound `default`） | — | 否 |
| 读写责任 | `settings.rs:11-17` | Rust 单写者（读+写都归壳），client 经 Tauri IPC `save_desktop_settings`；壳设置已彻底搬出 dsh settings.yaml 体系 | — | 否 |
| **代理注入** | `network/proxy.rs:517-531`（`apply_proxy_env`）、`:533-551`（`inject_proxy_env`）、`process/lifecycle.rs:419-420` | manual/system 模式 spawn dsh 时注入 `HTTP_PROXY`+`http_proxy`、`HTTPS_PROXY`+`https_proxy`、`ALL_PROXY`+`all_proxy`（socks5 时只这个）、`NO_PROXY`+`no_proxy`；off 或解析失败**不注入任何变量** | — | 否 |
| 系统代理解析 | `network/proxy.rs:224-279`（macOS `scutil --proxy`）、`:394-430`（Windows 注册表 `ProxyEnable`/`ProxyServer`/`ProxyOverride`） | PAC AutoConfigURL 存在时只注入 NO_PROXY，不注入代理 URL | 系统命令/注册表 | 否 |
| NO_PROXY 回环保底 | `network/proxy.rs:27`、`:205-215` | 只要有代理注入，NO_PROXY 恒含 `localhost,127.0.0.1,::1`（dsh web 与 lane 反代都在回环）；CIDR 条目丢弃并记日志 | — | 否 |
| 代理认证 | `network/proxy.rs:499-513` | `proxy_user` 非空时给所有代理 URL 拼 `user:pass@` | — | 否 |
| 壳自身出站复用同一套 | `network/proxy.rs:553-`（`app_client_builder`） | 版本目录/下载传输的 reqwest 客户端共享 manual/system/off 语义 | — | 否 |
| 代理设置窗口 | `desktop/src-tauri/src/proxy-settings.html`（8,976 字节）+ `capabilities/proxy-settings.json` | 独立窗口改代理；`save` 后由 `restart_dsh_service` 生效 | — | 否 |

### 7b. 注入给 dsh 子进程的环境变量清单

| 变量 | 证据(文件:行号) | 作用 |
|---|---|---|
| `DSH_MOBILE_LANE_PORT` | `process/lifecycle.rs:394`、`:708`（win） | 本实例 lane 端口 |
| `DSH_MOBILE_ENABLED=1` | `process/lifecycle.rs:395`、`:709` | 开启手机访问 lane |
| `DSH_DESKTOP_PORT` | `process/lifecycle.rs:396`、`:710` | 本实例服务端口 |
| `DSH_CLIENT_VERSION` | `process/lifecycle.rs:397-403` + `process/client_env.rs:9-11` | 壳版本；#199 起是运行时 telemetry 装配的**必填**契约（0.2.1-alpha.2 起缺失即致命 StartupError） |
| `DSH_DESKTOP_PROFILE` | `process/lifecycle.rs:405` | 实例身份；busy-state 上报靠它记账 |
| `DSH_DESKTOP_NOTIFY_PORT` / `DSH_DESKTOP_NOTIFY_TOKEN` | `process/lifecycle.rs:409-413` | 通知桥口（port=0 时不注入） |
| `DSH_CLOUDFLARED_BIN` | `process/lifecycle.rs:414-417` | 隧道二进制路径（设置非空时） |
| `DSH_DESKTOP_BUNDLED_MODULES` | `runtime/builtin/launcher.mjs:31` | 内置 node_modules 根，供 resolver hooks 接管解析 |
| `PATH`（重组） | `process/lifecycle.rs:346-381` | 内置模式：pnpm shim 目录 → dsh shim 目录 → 登录 shell PATH → `FALLBACK_TOOL_PATH`；**只劫持 pnpm 不劫持 node** |
| `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` | `network/proxy.rs:517-531` | 见上 |
| `cwd` | `process/lifecycle.rs:428-429` | 强制设为 `dsh_home()`（GUI 启动的 cwd 是 `/` 不可写，`.mnemon` 会 ENOENT） |
| `RLIMIT_NOFILE` | `process/lifecycle.rs:436-467` | `pre_exec` 抬到 16384（长期会话 + fs.watch 会触发 EMFILE） |

宿主侧读取的壳环境变量（非注入）：`DSH_DESKTOP_PORT`、`DSH_DESKTOP_LOG_SHELL_ORIGIN=1`（`scheme.rs:309-311`、`stream_proxy.rs:146`/`:156`/`:207`）、`DSH_DESKTOP_EXTRA_PATCH`、`DSH_MODE`、`DSH_NODE_BIN`、`DSH_BIN`、`DSH_NODE`、`DSH_MOBILE_LANE_PORT`、`DSH_DESKTOP_NO_SINGLETON`、`DSH_DESKTOP_AUTO_QUIT`、`DSH_DESKTOP_PROXY_RESTART_TEST`、`DSH_DESKTOP_NOTIFY_TEST`。

---

## 8. 内置运行时

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| 运行时布局 | `desktop/src-tauri/src/runtime/builtin.rs:9-13` | ① `resources/dsh/`（dsh npm 包树，只读直跑无需解压）② 应用可执行文件旁 `dsh-node`（Node sidecar）③ `app_data/runtime/dsh-launcher.mjs`（启动时写出） | — | 否 |
| sidecar 定位 | `runtime/builtin.rs:88-119` | `DSH_NODE_BIN` env > `current_exe()` 旁的 `dsh-node`（win 是 `.exe`）> PATH 里的 `node` | — | 否 |
| dsh 树定位 | `runtime/builtin.rs:79-86` + `runtime/paths.rs:34-40` | `resource_dir()/dsh/node_modules/@deepseek-ai/dsh/lib`；Windows verbatim 前缀（`\\?\`）统一剥离（#123，否则 `pathToFileURL` 生成无效 URL 导致 import 静默失败） | `AppHandle::path().resource_dir()` | 否 |
| 来源两态 | `runtime/builtin.rs:22-35`、`:56-79` | `DshSource::Builtin{node,dsh_lib,launcher}` / `External{bin}`；`DSH_MODE` env > `settings.dsh_mode` > builtin（默认） | — | 否 |
| **双向回退** | `runtime/builtin.rs:159-205` | 内置不可用 → 通知 + 回退外部；外部不可用 → 通知 + 回退随包内置；两者皆缺才报错。回退只作用于本次运行 | — | 否 |
| 已下载运行时优先 | `runtime/builtin.rs:138-157` | `settings.dsh_runtime` 选中的版本优先于随包树（node 仍是内置 sidecar） | — | 否 |
| **启动器写出** | `runtime/builtin.rs:121-136` | 编译期 `include_str!` 的 `launcher.mjs` + `resolver-hooks.mjs` 写到 `app_data/runtime/` | — | 否 |
| **launcher（`runtime/builtin/launcher.mjs`）** | 全文 71 行 | `node dsh-launcher.mjs <dshLibDir> <profile> <port> [--patch ...]`；① 归一 Windows verbatim 前缀 ② 装 resolver hooks（`registerHooks` 优先、回退 `register`）③ `createRequire(join(dshLibDir,"bin.js"))` 解析 `@deepseek-ai/dsh-app-boot` 的 `loadLayeredEnv` ④ 找 `profile-boot.js` 或散列名 `profile-boot-*.js` 导出 `runProfile` ⑤ 以与 CLI case "profile" 相同的契约调用 | `node:module` registerHooks | 否 |
| **resolver hooks** | `runtime/builtin/resolver-hooks.mjs` 全文 45 行 | 照搬 anywhere-labs/dsh-desktop：凡内置 `node_modules` 里存在的**裸说明符**一律解析到内置版本（`@deepseek-ai/*` 与运行时依赖），profile 本地残留的旧版副本不再遮蔽；profile 插件自己的第三方依赖照常默认解析；带 cache | 同上 | 否 |
| 内置 argv | `runtime/builtin.rs:220-245` | `[launcher, dsh_lib, profile, port, (--init-from-default), (--patch p)...]` | — | 否 |
| 外部 argv | `runtime/builtin.rs:247-268` | `--profile X --patch P... --no-open --host 127.0.0.1 --port N`；`--patch` **必须**早于 `--no-open`（dsh passThrough 顺序约束，有单测锁死） | — | 否 |
| pnpm allowBuilds 白名单 | `runtime/builtin.rs:45-53` | `PNPM_ALLOW_BUILDS`：node-pty / protobufjs / git-hosted / cloudflared / sharp / ssh2 / dsh-subprocess-local / @google/genai / koffi，单一常量防漂移 | — | 否 |
| spawn 主流程 | `process/lifecycle.rs:306-499` | heal bundle → materialize 桌面插件 → 组 --patch → 解析来源 → 拼 PATH → 注入 env → `pre_exec` 抬 fd 上限 → spawn → 注册台账 → stdout/stderr 转发线程 | `std::process::Command` | 否 |
| stdout 转发 | `process/lifecycle.rs:473-496` | 逐行 lossy 解码（`.lines().map_while(Result::ok)` 遇非法 UTF-8 会静默终止整个循环）；解析带 process token 的启动 URL 存 state；emit `dsh-console` 事件 | — | 否 |
| stderr 环形缓冲 | `process/lifecycle.rs:53`（`process/stderr_buf.rs`） | 退出通知取尾部展示原因（#127） | — | 否 |
| **worker（唯一 spawn 入口）** | `desktop/src-tauri/src/process/worker.rs`（236 行） | per-profile dsh 进程 worker：句柄唯一持有者 + 全壳唯一 spawn 入口，latest-wins epoch；重启/切 Profile/守护器自愈全经它 | — | 否 |
| 插件物化 | `desktop/src-tauri/src/process/plugin.rs`（672 行） | 从安装路径 `resource_dir()/plugins/<name>` 解析包体，挂进 `$DSH_HOME/profiles/<profile>/node_modules/<pkg>`，再由 `desktop-plugin-inject.yml`（运行时写到 app data 目录）按包名 `--patch` 启用；开发运行回退仓库源码 | — | 否 |
| **构建期 staging** | `desktop/src-tauri/build.rs:14-16`、`:33-77` | 编译期把三个插件包（dsh-desktop-tauriapp / dsh-mobile-access / dsh-web-mobile）stage 进 `src-tauri/embedded/`，由 `tauri.conf.json` 的 `bundle.resources` 打进 `.app/Contents/Resources/plugins/` | `tauri_build` | 否 |
| **打包脚本** | `desktop/scripts/prepare-builtin-runtime.mjs`（126 行） | `node scripts/prepare-builtin-runtime.mjs --variant latest [--node-version latest-v24.x] [--skip-node] [--skip-packages]`；① npm 装 `@deepseek-ai/dsh@0.2.0-rc.2`（**pin，不跟随 dist-tag**，`prepare-builtin-runtime.mjs:27`）+ `pnpm@11.16.0`（pin，因为它决定 profile 依赖的 store 大版本）拷进 `resources/dsh/node_modules` + 写 `desktop-runtime.json` ② 从 nodejs.org 下 `latest-v24.x` 的 `bin/node` 拷成 `binaries/dsh-node-<triple>` | — | 否 |

---

## 9. 更新器与打包

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| **Tauri updater 插件** | — | **不存在**：`Cargo.toml` 无 `tauri-plugin-updater`，`tauri.conf.json` 无 `plugins.updater` 配置 | — | 否 |
| 实际的「更新」通道 | `desktop/src-tauri/src/runtime/registry.rs:12-13`、`:267-296`、`:458-` | **应用内运行时下载/切换**：从 github（默认 `deepseek-ai/deepseek-harness`）或 npm 拉 `@deepseek-ai/dsh` 的 `.tgz`（npm tarball 同构），`flate2`+`tar` 解到 `app_data/runtimes/<ver>`，经 `pnpm` 装依赖树；装完记 `installed.json`；卸载进回收站延迟删 | — | 否 |
| 回收站清理 | `runtime/registry.rs:46-70`、`lib.rs:295` | 启动时 `purge_trash`（须在 spawn 之前，避免硬 link ctime 变化触发插件 rebuilt） | — | 否 |
| 运行时目录 | `runtime/registry.rs:29-50` | `app_data/runtimes/<version>`，manifest `installed.json` | — | 否 |
| 签名 | `desktop/src-tauri/tauri.conf.json:44-48` | `bundle.macOS.signingIdentity: "-"` = **ad-hoc 本地签名**，无 Developer ID | — | 否 |
| 公证 | — | **不存在**：`tauri.conf.json` 无 `notarization`/CI 无 `xcrun notarytool`（`.github/workflows/release.yml` 无公证步骤） | — | 否 |
| **entitlements** | `desktop/src-tauri/Entitlements.plist` | 4 条：`allow-unsigned-executable-memory`、`allow-jit`（Node/V8 sidecar 在 hardened runtime 下必需，缺了 V8 初始化直接 Fatal OOM，2026-09-22 v0.9.1 实测）、`disable-library-validation`（`resources/dsh/node_modules` 内 `.node` 未逐个签名）、`allow-dyld-environment-variables` | — | 否 |
| 最低系统版本 | `tauri.conf.json:43` | macOS 10.15 | — | 否 |
| **产物形态** | `tauri.conf.json:39-68`、`.github/workflows/release.yml:86-97` | macOS aarch64：`.app` + `.dmg`；Windows x86_64：`.msi`(WiX, zh-CN) + `-setup.exe`(NSIS)。CI tag `v*` 触发 → `tauri-apps/tauri-action@v0` 出 **draft** release，再用 `gh release edit` 覆写 release body（多行 UTF-8 经 `${{ }}` 会损坏成 U+FFFD） | — | 否 |
| 构建变体 | `.github/workflows/release.yml:16-19` | #95 后安装包只出单一变体（bootstrap 默认带 latest 稳定内置运行时），alpha 等由应用内下载切换 | — | 否 |
| 随包资源 | `tauri.conf.json:56-65` | `bundle.resources` 四条：`embedded/dsh-desktop-tauriapp` → `plugins/dsh-desktop-tauriapp/`、`embedded/dsh-mobile-access` → `plugins/dsh-mobile-access/`、`embedded/dsh-web-mobile` → `plugins/dsh-web-mobile/`、`resources/dsh/` → `dsh/` | — | 否 |
| 外部二进制 | `tauri.conf.json:66-68` | `externalBin: ["binaries/dsh-node"]`（Tauri 会补 `-<target triple>` 后缀） | — | 否 |
| `frontendDist` | `tauri.conf.json:8` | `../src`（即 `desktop/src`：启动页 index.html/styles.css/icon.png、桌宠 pet.html/pet.css/pet.js/pet.png、代理设置页 proxy-settings.html） | — | 否 |
| 移动端产物（同一 release） | `.github/workflows/release.yml:113-215` | Android `app-debug.apk`（Gradle debug 签名）、iOS `DeepSeek.ipa`（未签名，`CODE_SIGNING_ALLOWED=NO`，供 AltStore）；鸿蒙不进 CI | — | 否 |
| CI 触发与前置 | `.github/workflows/release.yml:29-40`、`:50-51` | `submodules: recursive`（`mobile/dsh-mobile-nav` 是 git 子模块，不递归 checkout 则 build.rs 读不到它 → CI 构建失败）；Node 22 + pnpm 9；先跑 `prepare-builtin-runtime.mjs --variant latest` 再 `tauri build` | — | 否 |

---

## 10. 日志与诊断

| 能力 | 证据(文件:行号) | 一句话它实际做什么 | 依赖的 Tauri/系统 API | 是否涉及 WebView 注入 |
|---|---|---|---|---|
| 日志配置 | `desktop/src-tauri/src/lib.rs:114-131` | `tauri-plugin-log`，双 target：Stdout + `LogDir{file_name: Some("dsh-desktop-tauriapp")}`；本地时区（+8，不再 UTC 免得排障要脑内换算）；level Info；`KeepAll` 轮转；`max_file_size: 10_000_000` | 插件 | 否 |
| **日志文件位置** | 插件 API + 实测 | macOS：`~/Library/Logs/com.arcreel.dsh-desktop-tauriapp/dsh-desktop-tauriapp.log`（实测该文件 7.9MB，同目录另有 90+ 个 10MB 的历史轮转文件） | — | 否 |
| 1s flush 任务 | `lib.rs:132-143` | 每秒 `log::logger().flush()`——文件 target 带缓冲，不 flush 时 mtime 已更新但内容落后数小时 | — | 否 |
| `[stream-proxy]` 诊断行 | `stream_proxy.rs:101`（就绪）、`:148`（DIAG）、`:157`（REQ）、`:166`（LOCAL）、`:256`（WS 握手）、`:276`（`RES …/api/* len=`）、`:288`（SSE 到上限）、`:270`（SLOW） | 页面实际发出的请求逐条可见——base 指向代理后页面自报与预检只能从这里看到，否则是诊断盲区 | — | 否 |
| `[dshapp]` 诊断行 | `scheme.rs:40`（`[dshapp] GET dshapp://localhost/`）、`:71`（未命中本地资产）、`:82`（文档生成失败） | 文档被重新取的时刻就是页面被重载的时刻（回归脚本 `reload-regression.sh` 靠它计数） | — | 否 |
| `[shell-origin]` | `shell_origin/mod.rs:57`、`:62` | 数据面代理就绪 / 未启动 | — | 否 |
| `[nav]` | `ui/nav_guard.rs:56`、`:64`、`:92`、`:95`、`:98` | 已阻止顶层外部导航 / 拦截外部协议转系统 / 新窗请求转系统 / 新窗请求丢弃 | — | 否 |
| `[watchdog]` | `lib.rs:646`、`:660`、`:666` | 外部实例不可达 / dsh 不可达自动重启 / 连续 3 次停止自愈 | — | 否 |
| `[spawn]` / `[dsh]` | `process/lifecycle.rs:308`、`:335`、`:337`、`:341`、`:474` | 启动参数与模式 / dsh 每行 stdout | — | 否 |
| `[source]` | `runtime/builtin.rs:146`、`:180`、`:198` | 使用已下载运行时 / 内置不可用回退 / 外部不可用回退 | — | 否 |
| `[ports]` | `settings.rs:420`、`:430` | profile 端口分配 | — | 否 |
| `[proxy]` | `network/proxy.rs:197`、`:490`、`:539` | NO_PROXY CIDR 丢弃 / 未检测到系统代理 / 注入的四个变量与值 | — | 否 |
| `[forwarder]` | `network/forwarder.rs:21` | lane 转发目标变更 | — | 否 |
| `[settings]` | `settings.rs:243`、`:232` | 一次性迁移完成 / 私有文件损坏已备份重建 | — | 否 |
| `[desktop-resolver]` | `runtime/builtin/launcher.mjs:38`、`runtime/builtin/resolver-hooks.mjs:42` | hooks 已注册（附内置 node_modules 根路径）/ 诊断横幅 | — | 否 |
| `[main]` / `[startup]` / `[exit]` / `[downloads]` | `lib.rs:340`、`:344`、`:393`、`:398`、`:757`；`download/manager.rs` | 主窗创建失败 / 本地资产路径可用 / 远程模式跳过拉起 / 全新安装默认 desktop / 退出停实例 | — | 否 |
| 测试钩子日志 | `lib.rs:744`（`[auto-quit]`）、`lib.rs:790`（`[proxy-restart-test]`）、`lib.rs:163`（`[test]` 单实例跳过） | — | — | 否 |
| 页面侧自报探针 | `shell_origin/scheme.rs:320-352`、`stream_proxy.rs:145-155` | **仅 `DSH_DESKTOP_LOG_SHELL_ORIGIN=1` 才注入**（生产页面不该有这些噪声——之前无条件注入导致用户控制台多一条 `__diag 404` 红字）。四组：① DOM/IPC 自报 ② 真实 SSE 订阅并自报 readyState ③ 设置面 POST 探针 ④ 10s 总探针 | — | **是** |
| 前端错误日志通道 | `desktop/src-tauri/src/commands.rs:129`（`log_diag`）、`:139`（`log_console`） | 便于不依赖 GUI 开发者工具直接 `tail -f` 看前端错误 | Tauri IPC | 是 |
| 崩溃回归判定 | `desktop/scripts/reload-regression.sh` | 「白屏+自动刷新」回归判定：崩溃报告数（`~/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent-*.ips` 按 mtime）/ 文档重取数 / mux 建连次数 / 内存采样 | — | 否 |

---

## 构建期产物与体积

> 数字来源标注在每行。`du` 于 2026-10-10 在本机实测；仓库 worktree 内无构建产物（`target/` 为 gitignore 且 worktree 中为空），故体积取自主检出 `/Users/mutou/vault/projects/dsh-desktop-tauriapp`。

### 随包内容（会进 .app 的 Resources）

| 产物 | 体积 | 来源 |
|---|---|---|
| `resources/dsh/node_modules`（dsh 0.2.0-rc.2 依赖树） | **532 MB** | `du -sh desktop/src-tauri/resources/dsh`（主检出）；清单 `resources/dsh/desktop-runtime.json`：`{"variant":"latest","dsh":"0.2.0-rc.2","node":"latest-v24.x","staged_at":"2026-09-29T13:19:29.749Z"}` |
| `binaries/dsh-node-aarch64-apple-darwin`（Node v24 sidecar） | **116 MB**（122,129,232 B） | `ls -la desktop/src-tauri/binaries/` |
| `embedded/dsh-web-mobile`（git 子模块插件） | 612 KB | `du -sh desktop/src-tauri/embedded/*` |
| `embedded/dsh-desktop-tauriapp`（本仓插件） | 560 KB | 同上 |
| `embedded/dsh-mobile-access`（手机访问插件） | 260 KB | 同上 |
| `desktop/src`（`frontendDist`：启动页 + 桌宠 + 代理设置页） | 152 KB | `du -sh desktop/src`；`desktop/src-tauri/tauri.conf.json:8` |
| `desktop/src-tauri/icons` | 3.7 MB | `du -sh` |
| `desktop/assets`（鲸鱼娘图 + LICENSE） | 1.6 MB | `du -sh` |

### 最终产物

| 产物 | 体积 | 来源 |
|---|---|---|
| Rust 主二进制 `dsh-desktop-tauriapp`（release） | **18.9 MB**（19,768,640 B） | `ls -la desktop/src-tauri/target/release/dsh-desktop-tauriapp` |
| **macOS DMG v0.12.0（aarch64）** | **187.7 MiB / 196.8 MB**（196,819,826 B） | `ls -la desktop/src-tauri/target/release/bundle/dmg/DeepSeek Harness Desktop_0.12.0_aarch64.dmg` |
| macOS DMG v0.9.0（历史参考） | 100.7 MiB / 105.6 MB | `du -sh installers/`（主检出） |
| ⚠️ `bundle/macos/rw.28937.…_0.9.4_aarch64.dmg`（829,462,016 B / 791 MiB） | **不是产物** | `hdiutil` 打包失败残留（`AGENTS.md` 已知坑 7：`bundle_dmg.sh` hdiutil 残留，失败时清理 `bundle/macos/rw.*.dmg` 再试）。**不要拿它当体积基线** |
| `.app` 独立目录 | 未测 | dmg 打包后 `.app` 已被清理，`target/release/bundle/macos/` 下只剩上述残留 |
| Windows `.msi` / `-setup.exe` | 未测 | 本机无 Windows 目标（`AGENTS.md` 已知坑 6：交叉编译被 `tauri-winres` 需 llvm-rc、`externalBin` 缺 `dsh-node-*.exe` 挡死），只能靠 CI 产物 |
| Android `app-debug.apk` / iOS `DeepSeek.ipa` | 未测 | 同 release 的 `build-mobile` job，本机无构建产物 |

### 运行时（非随包，用户侧下载后落盘）

| 项 | 体积 | 来源 |
|---|---|---|
| `app_data/runtimes/0.2.0-rc.2`（已下载运行时） | 492 MB | `du -sh ~/Library/Application\ Support/com.arcreel.dsh-desktop-tauriapp/runtimes/*` |
| `app_data/runtimes/0.2.1-alpha.2`（已下载运行时） | 523 MB | 同上 |
| `app_data/` 总计 | 2.5 GB | 同上（`runtimes` 之外还有 `runtime/` 32 KB：launcher + resolver hooks） |
| 日志目录 | 单文件 7.9 MB，90+ 个 10 MB 轮转文件 | `du -sh ~/Library/Logs/com.arcreel.dsh-desktop-tauriapp/` |

### 体积小结（迁移相关）

- **随包 532 MB + 116 MB ≈ 648 MB**，其中 82% 是 dsh 的 node_modules 树、18% 是 Node sidecar。Electrobun + Bun 迁移时，**这 648 MB 是唯一的大头**；Electron 官方壳走的是「运行时按需下载」，本壳走「随包分发」，两者体积差一个量级。
- 压缩后 DMG 187.7 MiB / 196.8 MB（压缩率约 3.3×）。
- 若改成 Bun 替代 Node sidecar：Bun 单二进制约 50–100 MB 量级（**未确认**：本仓无 Bun sidecar 构建产物，`docs/research/bun-runtime-feasibility.md` 是可行性报告而非实测数据；`desktop/src-tauri/resources/dsh/bun-preload.mjs` 只是一段 preload 补丁脚本，由 commit `f27e907` 加入，尚未接入任何构建路径）。

---

## 附录 A：仓内已存在的 Bun/Electron 相关前期工作

| 项 | 证据 | 说明 |
|---|---|---|
| Bun 运行时可行性报告 | `docs/research/bun-runtime-feasibility.md`（34,275 字节） | commit `f27e907` 加入，尚未被任何代码引用 |
| Bun preload 补丁 | `desktop/src-tauri/resources/dsh/bun-preload.mjs`（16,501 字节） | 三件事：拦 `require("node-addon-require-builtin")` 返回桩（Bun 缺 V8 context 符号）、用 `Bun.Transpiler` 提供 `stripTypeScriptTypes`、置 `DSH_BUN_COMPAT_DISABLE_HMR=1` 跳过 Cordis HMR。**未接入 `prepare-builtin-runtime.mjs`** |
| ADR 0003 | `docs/adr/0003-local-origin-loopback-shell-service.md` | 本清单第 1、3 节架构的决策原文（`dshapp://` + 独立 loopback 数据面） |
| ADR 0005 | `docs/adr/0005-remote-build-identity-gate.md` | 远程构建标识闸门（`assets.rs:88` 的 `build_id` 的来源） |

## 附录 B：明确的「不存在」清单（迁移讨论必问项）

以下能力经 grep 确认**仓内不存在**，不是遗漏：

- 深链 / OS 级 URL scheme（`dshapp` 只在进程内注册）
- Tauri updater 插件与应用内自动更新检查
- macOS 应用顶部菜单栏（`app.set_menu`）
- 全局快捷键（`tauri-plugin-global-shortcut`）
- 上下文菜单（`tauri-plugin-context-menu`）
- 代码签名（Developer ID）与公证（notarization）
- 下行合流 `stream_coalesce_ms`