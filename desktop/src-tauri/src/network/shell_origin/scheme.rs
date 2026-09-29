//! `dshapp://` 协议处理器（官方 Electron `dsh-app://` 的 Tauri 对应物）。
//!
//! 为什么必须是自定义协议而不是 loopback http：`tauri-2.11.5/src/webview/mod.rs:1698`
//! 的 `is_local_url` 把「**用户自己注册的协议**」判为本地 origin，于是 IPC 命中
//! `capabilities/default.json` 的完整权限集；换成 `http://127.0.0.1:<port>` 则被判
//! `Origin::Remote`，只命中精简的 remote capability——设置面板的 IPC 会被整片拒掉
//! （#154 实机复现的「正在加载设置…」）。
//!
//! 本模块只做两件事（#154 重构）：**文档**与**本地静态资产**。
//! 文档 = 本地运行时的 `index.html` + 从 Host 取来的 head/body 注入段（[`splice_injections`]），
//! 资产 = 同一份 dist 里的文件；数据面（`/api/*`、`/plugins/*`、SSE、WS）由文档 `<base>`
//! 指向的 [`super::stream_proxy`] 承载，**协议处理器里没有转发分支**。

use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeResponder};


/// 壳内页面常驻注入脚本（传输能力位 + WebSocket/fetch/XHR/EventSource/open 改写）。
const PAGE_SHIM: &str = include_str!("page_shim.js");
use super::assets;

/// 协议名。官方是 `dsh-app`，这里用短名 `dshapp`。
pub(crate) const SCHEME: &str = "dshapp";

/// 页面 origin（macOS/Linux 形态；Windows 由 Tauri 记为 `http://dshapp.localhost`）。
/// 页面 origin。macOS/Linux 是 `dshapp://localhost`；**Windows 的 WebView2 把自定义协议
/// 映射为 `http://dshapp.localhost`**（Tauri 的既定行为），导航目标、Origin 校验、
/// nav_guard 白名单都必须用对应形态，否则导航直接被拦（PR #162 诊断 #1/#2）。
#[cfg(windows)]
pub(crate) const PAGE_ORIGIN: &str = "http://dshapp.localhost";
#[cfg(not(windows))]
pub(crate) const PAGE_ORIGIN: &str = "dshapp://localhost";

/// 处理一次 `dshapp://` 请求。
///
/// 职责收敛为两件（#154 重构）：**文档**与**本地静态资产**。数据面（`/api/*`、`/plugins/*`、
/// SSE、WS）一律不经这里——文档里的 `<base>` 被改写到 [`super::stream_proxy`] 的 origin，
/// 页面的相对请求全部落在流式 TCP 上；协议处理器这个**缓冲**出口只承载能一次写完的东西。
pub(crate) fn handle(app: &AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    log::info!("[dshapp] {} {}", request.method(), request.uri());
    // 必须用 `path_and_query`，不能只取 `.path()`：dsh 的插件 combo 路由是
    // `/plugins/??id1,id2&rev=…`——它的“路径”其实是 `/plugins/`，标识全在 query 里。
    // 丢掉 query 会让 combo 请求变成裸 `/plugins/` → dsh 回 404 → 启动卡死
    // （实测：三连 404，页面停在拉插件那一步）。
    let path = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        responder.respond(serve(&app, &path).await);
    });
}

/// 一次请求的完整回答：**启动页** → 文档 → 本地资产 → 404。
///
/// 启动页（`/__startup`）走壳内嵌的 HTML/CSS（`include_str!` 编进二进制），不依赖 Tauri 的
/// asset 协议——后者在开发运行时报 `asset not found: index.html`（PR 评论方案 1d）。
///
/// 文档分支**没有「转发上游」**（#154 重构）：数据面走 `<base>` 指向的流式代理，打到协议处理器的
/// 相对请求都是壳自己的路由问题，明确 404 比静默转发更好诊断，也让「到底走没走本地」一眼可判。
async fn serve(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    // 启动/加载页（重启、切模式、切运行时期间显示）：壳内嵌，不碰上游也不碰本地 dist。
    if is_startup(path) {
        return startup_response(path);
    }
    if is_document(path) {
        return match document(app).await {
            Ok(bytes) => reply(StatusCode::OK, "text/html; charset=utf-8", bytes),
            Err(reason) => {
                log::error!("[dshapp] 文档生成失败：{reason}");
                reply(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "text/plain; charset=utf-8",
                    format!("dshapp: 无法生成本地页面文档：{reason}（不回退 Host 的 HTML）")
                        .into_bytes(),
                )
            }
        };
    }
    match serve_local(app, path).await {
        Some((bytes, mime)) => reply(StatusCode::OK, mime, bytes),
        None => {
            log::warn!("[dshapp] 未命中本地资产（数据面本应走流式代理）：{path}");
            reply(
                StatusCode::NOT_FOUND,
                "text/plain; charset=utf-8",
                format!("dshapp: 无此本地资产：{path}").into_bytes(),
            )
        }
    }
}

/// 组装一次响应（协议处理器的响应体是 `Vec<u8>`）。
fn reply(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("cache-control", "no-store")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 文档：**取上游 HTML 原文**（本地 Host 或远程），静态资产走本地 dist（PR 评论方案 1a）。
///
/// 为什么不用「本地 dist 的 index.html + 抠出 Host 注入段拼进去」（旧实现）：宿主侧插件（如
/// beauticode）经 `tapIndex` 往 index 里插 `<script>`，而 `tapIndex` 不经过 `collectIndexInjections`，
/// 抠注入段那条路会把它们全漏掉；而靠 `tapIndex` 探测补齐又有时序问题（注册前就探测）。直接用
/// 上游 HTML：所有注入（collectIndexInjections + tapIndex + 全局变量）天然都在里面。
///
/// 无论本地还是远程都走这一条（远程时上游就是远程地址），一条路径通吃。
async fn document(app: &AppHandle) -> Result<Vec<u8>, String> {
    // 文档 = **上游原文**（本地 Host 或远程），静态资产才走本地 dist（PR 评论方案 1a）。
    // 之前是「本地 dist 的 index.html + 从 Host 抠出注入段拼进去」，那条路会漏掉宿主侧插件
    // 经 tapIndex 注入的 <script>（collectIndexInjections 抓不到），而 tapIndex 探测本身有时序
    // 问题（注册前就去探测）。直接用上游 HTML：所有注入都已经在里面，一条路径通吃本地+远程。
    let html = host_page(app).await?;
    let origin =
        super::proxy_origin().ok_or("数据面代理未启动（相对请求与 SSE/WS 无处可去）")?;
    let base = if origin.ends_with('/') {
        origin
    } else {
        format!("{origin}/")
    };
    // <base href="./"> → 数据面代理 origin（相对请求 / SSE / WS 必须落在流式代理上）。
    let html = rebind_base(&html, &base)?;
    let html = drop_manifest_link(&html);
    // 上游 HTML 里带着 lane 给它自己页面准备的补丁，必须剥——否则那些补丁会在本页（壳 origin）
    // 上把回环地址改写成 `/_loopback/…`，把 mux WS 改坏（详见 drop_lane_patches）。
    let html = drop_lane_patches(&html);
    Ok(diagnostics(&html, &base).into_bytes())
}

/// 取上游首页的 HTML——**它就是页面本体**（PR 评论方案 1a）。

///
/// 上游刚起（切运行时/重启 dsh）时可能还没就绪，这里重试 15 次 × 200ms（约 3s）等它出页面，
/// 而不是一次失败就白屏。
pub(crate) async fn host_page(app: &AppHandle) -> Result<String, String> {
    let mut last = String::new();
    for attempt in 0..15u32 {
        match host_page_once(app).await {
            Ok(html) => return Ok(html),
            Err(e) => last = e,
        }
        if attempt < 14 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
    Err(format!("{last}（重试 15 次 / 约 3s 仍未就绪）"))
}

/// 取一次上游首页（带壳持会话 cookie）。
async fn host_page_once(app: &AppHandle) -> Result<String, String> {
    let upstream = super::upstream::current(app).ok_or("上游 dsh 地址未知（尚未就绪）")?;
    let url = format!("{}/", upstream.origin().trim_end_matches('/'));
    let mut request = reqwest::Client::new().get(&url);
    if let Some(cookie) = upstream.cookie.as_deref() {
        request = request.header("cookie", cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("取上游首页失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("取上游首页失败：HTTP {}", response.status()));
    }
    response
        .text()
        .await
        .map_err(|e| format!("读上游首页失败：{e}"))
}



/// `<base href="./">` → 数据面代理 origin。
///
/// 尾斜杠**必须带**：`streamBaseUrl` 与 `<base>` 都参与相对解析（dsh 用
/// `new URL('api/remote.mux', base)` 定 WS 目标），缺尾斜杠会退掉最后一段路径。
fn rebind_base(html: &str, base: &str) -> Result<String, String> {
    let rebound = html.replace("<base href=\"./\">", &format!("<base href=\"{base}\">"));
    if rebound == html && !html.contains(&format!("<base href=\"{base}\">")) {
        return Err("文档里没有 <base href=\"./\">：相对请求会落在缓冲的协议处理器上".to_string());
    }
    Ok(rebound)
}

/// 去掉 PWA manifest 链接：桌面壳不是 PWA，而 base 指向代理后它的 start_url 会与文档
/// origin 不一致（WebKit 告警：start_url's origin "http://127.0.0.1:xxxx" is different from
/// the document's origin "dshapp://localhost"）。留着只会误导，且本来无意义。
fn drop_manifest_link(html: &str) -> String {
    html.replace(
        "<link rel=\"manifest\" href=\"./manifest.webmanifest\" />",
        "",
    )
}

/// 剥掉 **lane 自己的页面级补丁**（`data-dsh-mobile-*` 那几个 `<script>`）。
///
/// 为什么必须剥（实机踩过）：壳在远程模式下把上游 HTML **原样**拿过来在自己的 origin 下重发，
/// 而那份 HTML 里已经带着 lane 给它自己页面准备的补丁——它们把「回环端口地址」改写成 lane 的
/// `/_loopback/<port>/…`。于是壳页面里 `ws://127.0.0.1:<代理端口>/api/remote.mux` 被改写成
/// `ws://<页host>/_loopback/<代理端口>/api/remote.mux`（页 host 上根本没这个路由）→ WS 永远连
/// 不上，客户端只在控制台里刷 `[connection] connection lost, retry #N`。
///
/// 这些补丁对「直接以 lane origin 打开的页面」（手机、以及 URL-webview 回退）仍是必需的，
/// 所以只在**壳重发**时剥：壳自己的 `page_shim.js` 会提供正确的传输与改写。
fn drop_lane_patches(html: &str) -> String {
    const MARKERS: [&str; 3] = [
        "data-dsh-mobile-owns-host",
        "data-dsh-mobile-theme-sync",
        "data-dsh-mobile-loopback",
    ];
    let mut out = html.to_string();
    for marker in MARKERS {
        while let Some(at) = out.find(marker) {
            // 回退到该标记所在 `<script` 的开头（找不到就只删标记本身，不猜）。
            let start = out[..at].rfind("<script").unwrap_or(at);
            let Some(close) = out[at..].find("</script>") else {
                out.replace_range(at..at + marker.len(), "");
                break;
            };
            let end = at + close + "</script>".len();
            out.replace_range(start..end, "");
        }
    }
    out
}

/// 从当前生效运行时的 dist 取一个文件；未命中返回 None。
async fn serve_local(app: &AppHandle, path: &str) -> Option<(Vec<u8>, &'static str)> {
    let dist = assets::dist_dir(app)?;
    let relative = assets::relative_path(path)?;
    assets::read_asset(&dist, &relative).await
}

/// 是否是「文档」请求（`/` 或 `/index.html`）。
fn is_document(path: &str) -> bool {
    matches!(path.split('?').next().unwrap_or(path), "/" | "/index.html")
}



/// 启动页完整地址：与 [`PAGE_ORIGIN`] 同一形态拼上 `/__startup`（Windows 同样是 http 映射）。
/// 重启/切模式/切运行时期间显示的内嵌加载界面，不依赖 Tauri asset 协议（PR 评论方案 1d）。
#[cfg(windows)]
pub(crate) const PAGE_ORIGIN_STARTUP: &str = "http://dshapp.localhost/__startup";
#[cfg(not(windows))]
pub(crate) const PAGE_ORIGIN_STARTUP: &str = "dshapp://localhost/__startup";
/// 启动/加载页路径（`/__startup` 及其静态资源）——壳内嵌，不经 Tauri asset 协议。
const STARTUP_PREFIX: &str = "/__startup";
const STARTUP_HTML: &str = include_str!("../../../../src/index.html");
const STARTUP_CSS: &str = include_str!("../../../../src/styles.css");
const STARTUP_ICON: &[u8] = include_bytes!("../../../../src/icon.png");

/// 是否启动页请求。
fn is_startup(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    path == STARTUP_PREFIX || path == "/__startup/" || path.starts_with(&format!("{STARTUP_PREFIX}/"))
}

/// 启动页应答：HTML 与 CSS 都由壳内嵌。
///
/// 为什么不用 Tauri 的 asset 协议（`tauri://localhost/index.html` / `http://tauri.localhost/`）：
/// 开发运行（`tauri dev`）下它会回 `asset not found: index.html`，窗口直接白屏；而重启/切模式时
/// 要回的就是这个加载界面，不能依赖开发服务器。路径挂在壳自己的 origin 下，于是本地与远程都拿得到。
fn startup_response(path: &str) -> Response<Vec<u8>> {
    let path = path.split('?').next().unwrap_or(path);
    if path.ends_with(".css") {
        return reply(StatusCode::OK, "text/css; charset=utf-8", STARTUP_CSS.as_bytes().to_vec());
    }
    if path.ends_with(".png") {
        return reply(StatusCode::OK, "image/png", STARTUP_ICON.to_vec());
    }
    let html = STARTUP_HTML
        .replace("\"styles.css\"", &format!("\"{STARTUP_PREFIX}/styles.css\""))
        .replace("\"icon.png\"", &format!("\"{STARTUP_PREFIX}/icon.png\""));
    reply(StatusCode::OK, "text/html; charset=utf-8", html.into_bytes())
}
/// 往 `</head>` 前注入页面脚本。
///
/// **总是**注入 `__DSH_TRANSPORT__`：`streamBaseUrl` 指向流式代理（WS 目标），
/// `ownsHost: true` 是官方解锁位（Windows 上页面 hostname 是 `dshapp.localhost`，不在 dsh 的
/// loopback 白名单里 → isLoopback 为假 → 设置类 RPC 不发起）。
///
/// **自报探针只往诊断开启时注入**（`DSH_DESKTOP_LOG_SHELL_ORIGIN=1`，与 Rust 侧请求日志同一开关）：
/// 它们会发额外请求（`__diag`、一个真实 SSE 订阅、两次设置面探针），生产页面不该有这些噪声——
/// 之前那版无条件注入，用户控制台里就多一条 `__diag 404` 的红字。
fn diagnostics(html: &str, base: &str) -> String {
    // 常驻注入脚本独立成 `page_shim.js`（include_str! 引入）：它是一段真 JS，
    // 放在 Rust 字符串里要过 Rust→JS 字符串→JS 正则三层转义，不可维护也无谓报错。
    // 占位符 `__DSH_STREAM_BASE__` 在这里替换为数据面代理 origin。
    let mut tag = format!(
        "<script>{}</script>",
        PAGE_SHIM.replace("__DSH_STREAM_BASE__", base)
    );
    if shell_origin_logging() {
        tag.push_str(&probes(base));
    }
    // 插在 `</head>` 之前：`<base>` 已经解析完，诊断脚本里的相对 `./__diag` 才指向代理。
    match html.find("</head>") {
        Some(at) => format!("{}{}{}", &html[..at], tag, &html[at..]),
        None => format!("{tag}{html}"),
    }
}

/// 是否开启壳 origin 诊断（与 Rust 侧请求/响应日志同一个开关）。
fn shell_origin_logging() -> bool {
    std::env::var("DSH_DESKTOP_LOG_SHELL_ORIGIN").as_deref() == Ok("1")
}

/// 页面自报探针（仅诊断开启时注入）。
///
/// 三组：① `location.protocol`／模块加载器／`#root` 渲染情况／一次真实壳命令是否被 IPC 授权；
/// ② SSE 订一个真实流式端点并自报 `readyState`（1=OPEN=真流式；0=CONNECTING=仍被缓冲）；
/// ③ 设置面探针（空 payload，dsh 会如实回 `invalid-request`——它证明的是「请求到达并被应答」，
/// 真实数据看代理日志里的 `RES … /api/*`）。全部打回 `./__diag`（经 `<base>` 落到流式代理，
/// 由代理本地应答并记日志：不靠截图，也不靠推断）。
fn probes(base: &str) -> String {
    format!(concat!(
        "<script>(function(){{",
        "var S=function(t,x){{try{{var r=document.getElementById('root');",
        "fetch('./__diag?tag='+t+'&proto='+encodeURIComponent(location.protocol)",
        "+'&ready='+document.readyState+'&loader='+(typeof globalThis.__ModuleLoader__)",
        "+'&kids='+(r?r.childNodes.length:-1)+'&carrier='+(typeof globalThis.dshDesktop)",
        "+(x?('&'+x):''),{{cache:'no-store'}}).catch(function(){{}});",
        "}}catch(e){{}}}};",
        "var I=function(){{try{{window.__TAURI_INTERNALS__.invoke('get_dsh_status')",
        ".then(function(v){{S('ipc_ok','res='+encodeURIComponent(String(v).slice(0,60)));}})",
        ".catch(function(e){{S('ipc_denied','err='+encodeURIComponent(String(e).slice(0,140)));}});",
        "}}catch(e){{S('ipc_missing');}}}};",
        "setTimeout(function(){{S('dom');I();}},1500);",
        "var n=0;try{{var es=new EventSource('{base}plugins/events');es.onmessage=function(){{n++;}};es.onerror=function(){{}};}}catch(e){{}}",
        "setTimeout(function(){{fetch('./__diag?tag=sse3&n='+n+'&rs='+(typeof es!=='undefined'&&es?es.readyState:-1),{{cache:'no-store'}}).catch(function(){{}});}},3000);",
        "setTimeout(function(){{fetch('./__diag?tag=sse8&n='+n+'&rs='+(typeof es!=='undefined'&&es?es.readyState:-1),{{cache:'no-store'}}).catch(function(){{}});}},8000);",
        // ④ 设置面探针（页面 origin → `<base>` → 流式代理 → dsh）：状态码与响应长度就是
        // 「设置里各种信息能不能拿到」的第一手证据——之前是 `Load failed`，连状态码都没有。
        "var A=function(p){{return fetch(p,{{method:'POST',headers:{{'content-type':'application/json'}},body:'{{}}',cache:'no-store'}})",
        ".then(function(r){{return r.text().then(function(t){{return r.status+'/'+t.length+'/'+encodeURIComponent(t.slice(0,90));}});}})",
        ".catch(function(e){{return 'ERR';}});}};",
        "setTimeout(function(){{A('./api/settings/describe').then(function(a){{return A('./api/llm/listProviders')",
        // 探针用的是**空 payload**，dsh 会如实回 `invalid-request`（已经实测到了）；它的价值在
        // 「请求真的到达并被应答」——真实的设置数据看代理日志里的 `RES … /api/settings/describe`。
        ".then(function(b){{fetch('./__diag?tag=api_probe&settings='+a+'&providers='+b,{{cache:'no-store'}}).catch(function(){{}});}});}});}},4000);",
        "setTimeout(function(){{S('t10');}},10000);}})();</script>"
    ), base = base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_and_origin_constants_are_consistent() {
        assert!(PAGE_ORIGIN.starts_with(SCHEME));
        assert!(PAGE_ORIGIN.ends_with("//localhost"));
    }

    /// 本地 dist 的 index.html 精简复刻（结构与运行时那份一致：head 里只有 meta + 入口脚本）。
    const LOCAL_INDEX: &str = concat!(
        "<!doctype html><html lang=\"en\"><head>",
        "<meta charset=\"utf-8\" />",
        "<script type=\"module\" crossorigin src=\"./assets/index-Q6zc2uHV.js\"></script>",
        "</head><body><div id=\"root\"></div></body></html>"
    );



    /// 远程模式下壳重发上游 HTML 时，必须把 lane 自己的页面补丁剥掉（否则 mux WS 被改坏）。
    #[test]
    fn drop_lane_patches_removes_only_lane_scripts() {
        let html = concat!(
            "<html><head>",
            "<script data-dsh-mobile-owns-host=\"1\">!function(){{}}();</script>",
            "<script data-dsh-mobile-theme-sync=\"1\">!function(){{}}();</script>",
            "<script data-dsh-mobile-loopback=\"1\">!function(){{}}();</script>",
            "<script data-dsh-mobile-polyfill=\"1\">/* 保留：老内核 polyfill */</script>",
            "<script type=\"module\" src=\"./assets/index-Q6zc2uHV.js\"></script>",
            "</head><body><div id=\"root\"></div></body></html>"
        );
        let out = drop_lane_patches(html);
        assert!(!out.contains("data-dsh-mobile-owns-host"), "owns-host 补丁必须剥掉");
        assert!(!out.contains("data-dsh-mobile-theme-sync"), "theme-sync 补丁必须剥掉");
        assert!(!out.contains("data-dsh-mobile-loopback"), "loopback 改写层必须剥掉");
        // 其余一律不动：polyfill（老内核兼容）与页面自己的模块脚本。
        assert!(out.contains("data-dsh-mobile-polyfill"), "polyfill 应保留");
        assert!(out.contains("src=\"./assets/index-Q6zc2uHV.js\""), "入口脚本应保留");
        assert!(out.contains("<div id=\"root\">"), "页面内容应保留");
        // 没有补丁时原样返回（幂等）。
        assert_eq!(drop_lane_patches("<html></html>"), "<html></html>");
    }
    /// PR 评论方案 1a：文档就是上游 HTML 原文。旧的「抠注入段拼进本地 index」已删（会漏 tapIndex 注入），
    /// 这里锁「上游原文的注入段一个字节都不许丢」+「只改 <base>」。
    #[test]
    fn upstream_document_keeps_every_injection_and_only_rebinds_base() {
        // 上游首页：<head> 后紧跟 base + head 行 + tapIndex 注入的 <script>，<body> 后跟 body 行。
        let upstream = concat!(
            "<html><head><base href=\"./\"><script>queue</script>",
            "<link rel=\"modulepreload\" href=\"x\"><meta charset=\"utf-8\" />",
            "<script data-dsh-tap-index=\"\">/* tapIndex 注入 */</script>",
            "<script type=\"module\" src=\"./assets/index-Q6zc2uHV.js\"></script></head>",
            "<body><script>ready</script><div id=\"root\"></div></body></html>"
        );
        let base = "http://127.0.0.1:41234/";
        // 与 document() 的处理链一致：rebind_base → drop_manifest_link → 注入常驻脚本。
        let html = drop_manifest_link(&rebind_base(upstream, base).expect("应重写 base"));
        let out = diagnostics(&html, base);
        // tapIndex 注入的脚本必须在（旧拼接实现会把这类丢掉）。
        assert!(out.contains("data-dsh-tap-index=\"\""), "tapIndex 注入的脚本必须保留");
        // 其它上游注入段原样保留。
        assert!(out.contains("<script>queue</script>"), "head 注入段必须保留");
        assert!(out.contains("<body><script>ready</script><div id=\"root\">"), "body 注入段必须保留");
        // 入口产物引用保留（相对路径由 <base> 解析到代理）。
        assert!(out.contains("src=\"./assets/index-Q6zc2uHV.js\""));
        // <base> 指向数据面代理。
        assert!(out.contains("<base href=\"http://127.0.0.1:41234/\">"), "<base> 必须指向代理");
    }

    #[test]
    fn rebind_base_requires_the_relative_marker() {
        let html = "<head><base href=\"./\"></head>";
        let out = rebind_base(html, "http://127.0.0.1:41234/").expect("应重写");
        assert_eq!(out, "<head><base href=\"http://127.0.0.1:41234/\"></head>");
        // 没有标记 = 相对请求会落在缓冲的协议处理器上，必须报错。
        assert!(rebind_base("<head></head>", "http://127.0.0.1:1/").is_err());
    }

    #[test]
    fn diagnostics_land_before_head_close() {
        let out = diagnostics(LOCAL_INDEX, "http://127.0.0.1:41234/");
        let script = out.find("__DSH_TRANSPORT__").expect("应注入 transport");
        let close = out.find("</head>").expect("应有 </head>");
        assert!(script < close, "注入必须在 </head> 之前（base 已解析）");
        // page_shim.js 的占位符必须被替换成真实代理 origin（带尾斜杠）
        assert!(
            out.contains("streamBaseUrl: 'http://127.0.0.1:41234/'"),
            "占位符替换失败");
        assert!(out.contains("ownsHost: true"));
        // WebSocket / fetch / EventSource 改写层必须随常驻脚本注入（第三方插件在
        // 自定义协议页面上拿 location 拼 ws/http 地址会得到非法 URL）
        assert!(out.contains("globalThis.WebSocket = PatchedWS"));
        assert!(out.contains("globalThis.fetch ="));
        assert!(out.contains("globalThis.EventSource ="));
        // 诊断探针只往诊断开启时注入：这里未开开关，不应出现 __diag
        assert!(!out.contains("__diag"), "诊断未开启时不应注入探针");
    }

    /// #154 Windows 实测回归（PR 评论）：把注入后的脚本**真跑一遍**。
    /// ①语法错（曾因 `pointsAtPage` 重复声明，整个 IIFE 抛 SyntaxError → `__DSH_TRANSPORT__` 从未设置 →
    /// Windows `dshapp.localhost` 非 loopback → 拿不到 `ownsHost` → settings unavailable）；
    /// ②裸绝对路径（绕过 `<base>`）必须被改写到数据面代理，否则 `/_dsh/*` 全 404。
    #[test]
    fn page_shim_runs_in_node_and_rewrites_urls() {
        let out = diagnostics(LOCAL_INDEX, "http://127.0.0.1:41234/");
        let script = out
            .split("<script>")
            .nth(1)
            .and_then(|s| s.split("</script>").next())
            .expect("应有一段 <script> 注入");
        // 在 Node 里造一个最小沙箱：页面 origin 是 dshapp 协议，记录 fetch/WS 实参。
        let harness = format!(
            "const fetched = []; const wsUrls = [];\nconst location = {{ origin: 'dshapp://localhost', host: 'localhost', protocol: 'dshapp:' }};\nconst XMLHttpRequest = function () {{}}; XMLHttpRequest.prototype = {{ open() {{}} }};\nfunction WebSocket(u) {{ wsUrls.push(u); }} WebSocket.prototype = {{}};\nfunction EventSource(u) {{ this.url = u; }}\nfunction open() {{ return null; }}\nconst realFetch = globalThis.fetch;\nglobalThis.fetch = (u) => (fetched.push(String(u)), Promise.resolve({{ ok: true }}));\nglobalThis.location = location; globalThis.XMLHttpRequest = XMLHttpRequest;\nglobalThis.WebSocket = WebSocket; globalThis.EventSource = EventSource; globalThis.open = open;\n{script}\nconst expectEq = (got, want, what) => {{ if (got !== want) throw new Error(what + ': got ' + got + ' want ' + want); }};\nif (!globalThis.__DSH_TRANSPORT__ || globalThis.__DSH_TRANSPORT__.ownsHost !== true) throw new Error('ownsHost 未设置');\nexpectEq(globalThis.__DSH_TRANSPORT__.streamBaseUrl, 'http://127.0.0.1:41234/', 'streamBaseUrl');\nfetch('/_dsh/dsh-prompt/update/check');\nexpectEq(fetched.at(-1), 'http://127.0.0.1:41234/_dsh/dsh-prompt/update/check', '裸绝对路径');\nfetch('/api/remote.mux?x=1');\nexpectEq(fetched.at(-1), 'http://127.0.0.1:41234/api/remote.mux?x=1', '带 query 的裸路径');\nfetch('http://localhost/api/describe');\nexpectEq(fetched.at(-1), 'http://127.0.0.1:41234/api/describe', '无端口页面地址');\nfetch('dshapp://localhost/api/x');\nexpectEq(fetched.at(-1), 'http://127.0.0.1:41234/api/x', 'dshapp 协议地址');\nfetch('http://127.0.0.1:3092/__dsh-mobile/api/pair/info');\nexpectEq(fetched.at(-1), 'http://127.0.0.1:3092/__dsh-mobile/api/pair/info', '带端口 lane 地址应放行');\nfetch('http://127.0.0.1:4992/smooth-stream/settings.read');\nexpectEq(fetched.at(-1), 'http://127.0.0.1:4992/smooth-stream/settings.read', '带端口本地服务应放行');\nfetch('https://dsh-market.com/api/telemetry/event');\nexpectEq(fetched.at(-1), 'https://dsh-market.com/api/telemetry/event', '外部 https 应放行');\nfetch('./plugins/x.js');\nexpectEq(fetched.at(-1), './plugins/x.js', '相对路径不碰');\nnew globalThis.WebSocket('ws://localhost/api/remote.mux');\nexpectEq(wsUrls.at(-1), 'ws://127.0.0.1:41234/api/remote.mux', 'WS 指向本页 host');\nnew globalThis.WebSocket('dshapp://localhost/api/remote.mux');\nexpectEq(wsUrls.at(-1), 'ws://127.0.0.1:41234/api/remote.mux', 'dshapp WS');\nnew globalThis.WebSocket('ws://127.0.0.1:4992/other');\nexpectEq(wsUrls.at(-1), 'ws://127.0.0.1:4992/other', '带端口 WS 应放行');\nconsole.log('PAGE_SHIM_OK');\n",

        );
        let tmp = std::env::temp_dir().join(format!("dsh-page-shim-{}.cjs", std::process::id()));
        std::fs::write(&tmp, harness).expect("写临时脚本");
        let res = std::process::Command::new("node")
            .arg(&tmp)
            .output()
            .expect("需要 node 才能验证注入脚本");
        let _ = std::fs::remove_file(&tmp);
        let stdout = String::from_utf8_lossy(&res.stdout);
        assert!(
            res.status.success(),
            "注入脚本在 Node 里执行失败（Windows 实测：重复声明 → SyntaxError → ownsHost 丢失）：\n{}\n{}",
            stdout,
            String::from_utf8_lossy(&res.stderr)
        );
        assert!(stdout.contains("PAGE_SHIM_OK"), "注入脚本未跑到末尾：\n{stdout}");
    }

    /// 同一个 shim 在 **Windows origin**（`http://dshapp.localhost`，WebView2 映射）下也必须能跑通：
    /// Windows 不在 dsh 的 loopback 白名单里，全靠 `ownsHost` 这个能力位解锁设置面；且裸绝对路径
    /// 在这个 origin 下同样要改写到代理（PR 评论的 Windows 实测就是这个组合）。
    #[test]
    fn page_shim_runs_on_windows_origin() {
        let out = diagnostics(LOCAL_INDEX, "http://127.0.0.1:41234/");
        let script = out
            .split("<script>")
            .nth(1)
            .and_then(|s| s.split("</script>").next())
            .expect("应有一段 <script> 注入");
        let harness = format!(
            "const fetched = [];\nconst location = {{ origin: 'http://dshapp.localhost', host: 'dshapp.localhost', protocol: 'http:' }};\nconst XMLHttpRequest = function () {{}}; XMLHttpRequest.prototype = {{ open() {{}} }};\nfunction WebSocket(u) {{}} WebSocket.prototype = {{}};\nfunction EventSource(u) {{ this.url = u; }}\nfunction open() {{ return null; }}\nglobalThis.fetch = (u) => (fetched.push(String(u)), Promise.resolve({{ ok: true }}));\nglobalThis.location = location; globalThis.XMLHttpRequest = XMLHttpRequest; globalThis.WebSocket = WebSocket; globalThis.EventSource = EventSource; globalThis.open = open;\n{script}\nif (!globalThis.__DSH_TRANSPORT__ || globalThis.__DSH_TRANSPORT__.ownsHost !== true) throw new Error('ownsHost 未设置');\nfetch('/_dsh/dsh-prompt/update/check');\nif (fetched.at(-1) !== 'http://127.0.0.1:41234/_dsh/dsh-prompt/update/check') throw new Error('裸绝对路径未改写: ' + fetched.at(-1));\nfetch('http://dshapp.localhost/api/describe');\nif (fetched.at(-1) !== 'http://127.0.0.1:41234/api/describe') throw new Error('无端口页面地址未改写: ' + fetched.at(-1));\nconsole.log('PAGE_SHIM_WIN_OK');\n",
        );
        let tmp = std::env::temp_dir().join(format!("dsh-page-shim-win-{}.cjs", std::process::id()));
        std::fs::write(&tmp, harness).expect("写临时脚本");
        let res = std::process::Command::new("node")
            .arg(&tmp)
            .output()
            .expect("需要 node 才能验证注入脚本");
        let _ = std::fs::remove_file(&tmp);
        assert!(
            res.status.success(),
            "Windows origin 下注入脚本执行失败：\n{}",
            String::from_utf8_lossy(&res.stderr)
        );
        assert!(
            String::from_utf8_lossy(&res.stdout).contains("PAGE_SHIM_WIN_OK"),
            "Windows origin 下注入脚本未跑到末尾"
        );
    }
    #[test]
    fn probes_include_sse_selfreport() {
        // 直接测探针段（不经 diagnostics + env 开关，避免并行测试抢环境变量）
        let out = probes("http://127.0.0.1:41234/");
        assert!(out.contains("tag=sse3"), "探针应包含 SSE 自报");
        assert!(out.contains("tag=api_probe"), "探针应包含设置面探针");
        assert!(out.contains("http://127.0.0.1:41234/plugins/events"), "探针 SSE 应指向代理 origin");
    }
}
