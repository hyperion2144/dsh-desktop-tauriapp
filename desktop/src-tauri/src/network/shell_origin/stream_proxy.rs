//! 流式数据代理（#154 重构；对齐官方 Electron `protocol.handle` 的流式语义）。
//!
//! **为什么必须单独开一个 loopback 端口**：Tauri 的 `UriSchemeResponder` 只接受
//! `Response<Vec<u8>>`（一次性缓冲），SSE 与 WS 经 `dshapp://` 必然挂死（已实测：
//! 响应头到了、body 永不 EOF、悬停 >5 分钟）。所以数据面走这里：页面仍从 `dshapp://`
//! 出（保住 `Origin::Local` 与完整 capability），把 `__DSH_TRANSPORT__.streamBaseUrl`
//! 与 EventSource 指向本代理。
//!
//! 它只做四件事：读请求头 → 剥 `Host/Origin/Cookie/Sec-Fetch-Site` 并注入**同源值**与
//! 壳持有的 cookie（对齐 dsh 的 `isTrustedApiRequest` 栅栏）→ 连 Host → 响应头补 CORS
//! 后**双向透传**。**不做** token 校验、静态资产、本地命中——那些是 scheme 处理器的事。
//!
//! 复用 [`super::head`]（报文头解析/改写，纯函数且已有单测）与 [`super::upstream`]
//! （上游解析与 TCP/TLS 连接），因此本模块只负责「生命周期 + 单连接拼接」。

use std::time::Duration;

use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::{head, upstream};

/// 报文头上限，与 relay 同口径。
const MAX_HEAD: usize = 64 * 1024;

/// SSE 单条连接寿命上限（见响应泵处的证据注释）：到期主动断开让页面重连、重建异步迭代器。
/// 取 30 分钟 —— 崩溃实测发生在页面存活约 1 小时后，留一半余量。
const SSE_MAX_LIFETIME: Duration = Duration::from_secs(30 * 60);

/// 启动代理，返回其 origin（`http://127.0.0.1:<port>/`，带尾斜杠）。
pub(crate) fn start(app: AppHandle) -> Option<String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.set_nonblocking(true).ok()?;
    let port = listener.local_addr().ok()?.port();
    let origin = format!("http://127.0.0.1:{port}/");

    let app2 = app.clone();
    let origin2 = origin.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(listener) else {
            log::error!("[stream-proxy] 接管监听失败");
            return;
        };
        log::info!("[stream-proxy] 流式数据代理就绪：{origin2}");
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app = app2.clone();
                    tokio::spawn(async move { handle(stream, app).await });
                }
                Err(e) => {
                    log::warn!("[stream-proxy] accept 失败：{e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    });
    Some(origin)
}

/// 处理一条连接：请求头改写 → 连上游 → 响应头补 CORS → 双向透传。
async fn handle(mut inbound: TcpStream, app: AppHandle) {
    let _ = inbound.set_nodelay(true);

    let Some((raw, end)) = read_head(&mut inbound).await else {
        return;
    };
    let Some(request) = head::parse_head(&raw[..end]) else {
        let _ = write_status(&mut inbound, 400).await;
        return;
    };
    // 请求头之后可能已读进 body 前段，必须原样转给上游。
    let body_tail = raw[end..].to_vec();
    // CORS 预检**本地应答**（#154 重构）：页面在 `dshapp://` 上、RPC 打本代理是跨源，
    // `POST` + `application/json` 必先发 OPTIONS。上一版这步在 relay 里，搬到本模块时漏了
    // ——后果是浏览器拦掉真正的 POST，页面侧表现为 `Load failed`（不是 4xx，是请求没发出去）。
    if request.method() == "OPTIONS" {
        let head = "HTTP/1.1 204 No Content\r\ncontent-length: 0\r\naccess-control-allow-origin: *\r\naccess-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\naccess-control-allow-headers: *\r\naccess-control-max-age: 600\r\nconnection: close\r\n\r\n";
        let _ = inbound.write_all(head.as_bytes()).await;
        let _ = inbound.flush().await;
        return;
    }
    // 页面自报（诊断探针）：**本地应答**，不转给 dsh——dsh 没有这个路由，转发只会得到 404
    // 并在页面控制台留一条红字（用户实测到过）。
    if request.target().starts_with("/__diag") {
        if std::env::var("DSH_DESKTOP_LOG_SHELL_ORIGIN").as_deref() == Ok("1") {
            log::info!("[stream-proxy] DIAG {}", request.target());
        }
        let head = "HTTP/1.1 204 No Content\r\ncontent-length: 0\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n";
        let _ = inbound.write_all(head.as_bytes()).await;
        let _ = inbound.flush().await;
        return;
    }
    // 与中继同款开关：把页面实际发出的请求逐条记下来。base 指向本代理后，
    // 页面的自报（__diag）与预检都只能从这里看到——否则诊断盲区。
    if std::env::var("DSH_DESKTOP_LOG_SHELL_ORIGIN").as_deref() == Ok("1") {
        log::info!("[stream-proxy] REQ {} {}", request.method(), request.target());
    }

    // 维护者修正 ①：**静态资产从本地运行时 dist 出**，Host 只做数据接口。命中本地文件就
    // 直接应答（带 CORS：页面在 `dshapp://` 上，对本代理是跨源），不再连上游；`/api/*`、
    // `/plugins/*` 这些 dist 里没有的路径自然落到下面的转发——本地优先是构造上安全的
    // （Vite 产物名即内容 hash，同名必同内容）。
    if let Some(response) = local_asset(&app, request.target()).await {
        if std::env::var("DSH_DESKTOP_LOG_SHELL_ORIGIN").as_deref() == Ok("1") {
            log::info!("[stream-proxy] LOCAL {}", request.target());
        }
        let _ = inbound.write_all(&response).await;
        let _ = inbound.shutdown().await;
        return;
    }

    let Some(up) = upstream::current(&app) else {
        let _ = write_status(&mut inbound, 503).await;
        return;
    };
    // 剥掉浏览器侧的 Host/Origin/Cookie/Sec-Fetch-Site，换成 Host 认得的同源值 + 壳持 cookie。
    let forwarded = head::rewrite_request(
        request.clone(),
        &up.authority,
        &up.origin(),
        up.cookie.as_deref(),
    );

    let Ok(out) = upstream::connect(&up).await else {
        let _ = write_status(&mut inbound, 502).await;
        return;
    };
    // **先开泵、再等响应头**（#154 死锁修复）：若按「写请求头 → 等响应头 → 才开始搬运」的
    // 顺序，带 body 的请求会与上游互等——上游在等剩余 body，我们在等响应头，双方永久挂住。
    // 实测：settings/describe、llm/listProviders 这类 POST 一直不返回，而 GET 全正常。
    // 拆 socket 后两个方向各自独立推进。
    let (mut client_r, mut client_w) = tokio::io::split(inbound);
    let (mut up_r, mut up_w) = tokio::io::split(out);
    if up_w.write_all(&forwarded.encode()).await.is_err() {
        return;
    }
    if !body_tail.is_empty() && up_w.write_all(&body_tail).await.is_err() {
        return;
    }
    if up_w.flush().await.is_err() {
        return;
    }
    let pump = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut client_r, &mut up_w).await;
        let _ = up_w.shutdown().await;
    });

    // 请求方向已在搬运，这时再等响应头就不会互等。
    // 读上游响应头 → 补 CORS（页面在 dshapp:// 上，对本代理是跨源）→ 回写 → 再拼 body。
    let Some((resp_raw, resp_end)) = read_head(&mut up_r).await else {
        pump.abort();
        let _ = write_status(&mut client_w, 502).await;
        return;
    };
    let Some(response) = head::parse_head(&resp_raw[..resp_end]) else {
        pump.abort();
        let _ = write_status(&mut client_w, 502).await;
        return;
    };
    let mut response = head::rewrite_response(response, head::is_plugin_bundle(request.target()));
    response.set("access-control-allow-origin", "*");
    // WebSocket 升级（`/api/remote.mux`）：握手成败就是上游那行状态码，直接记下来——
    // dsh 对带凭证／跨源的升级会回 403，这条是一手证据（不是“应该能过”的推断）。
    if request
        .get("upgrade")
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
    {
        log::info!("[stream-proxy] WS {} -> {}", request.target(), response.status().unwrap_or(0));
    }
    // `/api/*` 的响应行：状态码 + 声明长度。这是「设置／模型列表到底拿到没拿到」的第一手证据
    // （页面探针只能证明通道通；真实数据是应用自己发的那些请求，这里才看得到体量）。
    if std::env::var("DSH_DESKTOP_LOG_SHELL_ORIGIN").as_deref() == Ok("1")
        && request.target().starts_with("/api/")
    {
        log::info!(
            "[stream-proxy] RES {} {} len={}",
            response.status().unwrap_or(0),
            request.target(),
            response.get("content-length").unwrap_or("-")
        );
    }
    if client_w.write_all(&response.encode()).await.is_err() {
        pump.abort();
        return;
    }
    if resp_raw.len() > resp_end && client_w.write_all(&resp_raw[resp_end..]).await.is_err() {
        pump.abort();
        return;
    }
    let _ = client_w.flush().await;

    // 响应体（含 SSE/WS 长流）：读到 EOF 或对端关闭为止；反方向由 pump 维持。
    //
    // **SSE 加寿命上限**：实机崩溃报告（~/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent-*.ips）
    // 显示页面在 `JSC::asyncIteratorNextWithDriver` / `asyncGeneratorUnwrapYieldResumption` 上
    // SIGSEGV（EXC_BAD_ACCESS，KERN_INVALID_ADDRESS at 0x48），崩溃前 WebContent 常驻 1.2 GB，
    // 且三次崩溃间隔约 55–65 分钟；同时已经实测排除传输层（同一资产直连 vs 过代理 sha256 一致、
    // SSE 4 秒字节数一致、带体 POST 200）。⇒ 长命异步迭代器越活越久越危险，到期主动断开，
    // 让页面重连并**重建**迭代器（EventSource 语义本来就重连；mux 那条是 WS，不受此影响）。
    let is_sse = response
        .get("content-type")
        .map(|v| v.to_ascii_lowercase().contains("text/event-stream"))
        .unwrap_or(false);
    if is_sse {
        if tokio::time::timeout(SSE_MAX_LIFETIME, tokio::io::copy(&mut up_r, &mut client_w))
            .await
            .is_err()
        {
            log::info!(
                "[stream-proxy] SSE 达到寿命上限（{}s）→ 主动断开让页面重连（避免异步迭代器累积到崩引擎）",
                SSE_MAX_LIFETIME.as_secs()
            );
        }
    } else {
        let _ = tokio::io::copy(&mut up_r, &mut client_w).await;
    }
    let _ = client_w.shutdown().await;
    pump.abort();
}

/// 本地 dist 命中就回一整条 HTTP 响应（含 CORS）；未命中返回 None，由调用方转发上游。
///
/// **文档不走这里**：它由协议处理器组装（需要 Host 的 head/body 注入段），本函数只管
/// 纯静态文件（JS/CSS/字体/图标…）。
async fn local_asset(app: &AppHandle, target: &str) -> Option<Vec<u8>> {
    let path = target.split('?').next().unwrap_or(target);
    if matches!(path, "/" | "/index.html") {
        return None;
    }
    let dist = super::assets::dist_dir(app)?;
    let relative = super::assets::relative_path(path)?;
    let (bytes, mime) = match super::assets::read_asset(&dist, &relative).await {
        Some(hit) => hit,
        // 源映射（`.map`）：运行时 dist **根本不随包分发**（实测 0 个），dsh 自己也回 404。
        // 回 204：DevTools 对「没有映射」与「映射 404」处理一致，但不会在页面控制台留红字。
        None if relative.ends_with(".map") => {
            return Some(
                b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\naccess-control-allow-origin: *\r\nconnection: keep-alive\r\n\r\n"
                    .to_vec(),
            )
        }
        None => return None,
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: {mime}\r\ncontent-length: {}\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: keep-alive\r\n\r\n",
        bytes.len()
    );
    let mut out = head.into_bytes();
    out.extend_from_slice(&bytes);
    Some(out)
}



/// 读到报文头结束；返回 (缓冲区, 头结束下标)。
async fn read_head<R: tokio::io::AsyncRead + Unpin>(stream: &mut R) -> Option<(Vec<u8>, usize)> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = head::head_end(&buf) {
            return Some((buf, end));
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// 极简状态响应（只在失败路径上用）。
async fn write_status<W: tokio::io::AsyncWrite + Unpin>(out: &mut W, code: u16) -> std::io::Result<()> {
    let body = format!("stream-proxy: {code}\n");
    let head = format!(
        "HTTP/1.1 {code} ERR\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    out.write_all(head.as_bytes()).await?;
    out.write_all(body.as_bytes()).await?;
    out.flush().await
}
