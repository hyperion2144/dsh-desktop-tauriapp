//! dsh web token 解析与 cookie 交换模块。
//!
//! 迁移自 lib.rs 功能区域 4（web_token，行 749–901）。
//! 实现迁移自 lib.rs（票据 #49）。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::DshState;

/// 从 dsh web stdout 行解析启动 URL 的 process token。
/// 行格式（单独一行）：`dsh web: http://127.0.0.1:3080/?token=xxxx`，
/// token 字符集为 URL 安全字母（含 -/_）。解析失败/无 token 返回 None
/// （老版 dsh 无 token 机制，桌面壳回退到不带 token 的 URL）。
pub(crate) fn parse_web_token_line(line: &str) -> Option<String> {
    let idx = line.find("dsh web: http")?;
    let rest = &line[idx + "dsh web: http".len()..];
    let marker = "?token=";
    let tidx = rest.find(marker)?;
    let raw = &rest[tidx + marker.len()..];
    let token: String = raw
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.' || *c == '~')
        .collect();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// 把解析到的 process token 写入 DshState（空则忽略；后到的覆盖先到的）。
pub(crate) fn store_web_token(app: &AppHandle, token: String) {
    if token.is_empty() {
        return;
    }
    *app.state::<DshState>().web_token.lock().unwrap() = token.clone();
    log::info!("[token] 已捕获 dsh web process token（长度 {}）", token.len());
}

/// 清空 process token（重启/重新 spawn 前调用：新实例的 token 必然不同，
/// 拆留旧 token 会在宽限窗口内被误用于导航而 401）。
pub(crate) fn clear_web_token(app: &AppHandle) {
    *app.state::<DshState>().web_token.lock().unwrap() = String::new();
}

/// 用 token 向 dsh web 换取会话 cookie（裸 HTTP GET，不跟随重定向）。
/// dsh 对 `GET /?token=x` 回 303 + Set-Cookie（dsh-auth-<authority>=v1.…，
/// HttpOnly; SameSite=Strict; Path=/; Max-Age=30 天）。
/// 返回 Set-Cookie 的 cookie 名与值（不含属性），失败返回 None。
pub(crate) fn exchange_token_for_cookie(host_port: &str, token: &str) -> Option<(String, String)> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(host_port).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let req = format!(
        "GET /?token={token} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break; // 303 无 body，响应头收齐即止
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let status = head.lines().next()?.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    if !(300..400).contains(&status) {
        log::warn!("[token] 交换会话 cookie 失败：HTTP {status}");
        return None;
    }
    let line = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))?
        .to_string();
    let value_part = line.split_once(':')?.1.trim().to_string();
    let (name, value_full) = value_part.split_once('=')?;
    if name.trim().is_empty() {
        return None;
    }
    // value 取到第一个 ';' 为止（后面是 Max-Age/Path 等属性，不能混入值）
    let value = value_full.split(';').next().unwrap_or("").trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some((name.trim().to_string(), value))
}

/// 把会话 cookie 直接种进主窗口 webview 的 cookie 存储（WKHTTPCookieStore /
/// WebView2，与导航请求同一存储）。种入副本用 SameSite=Lax 而非 dsh 原响应的
/// Strict：主窗口从加载页（tauri://localhost）导航到 127.0.0.1 是跨站顶层 GET
/// 导航，Strict cookie 不随行（WebKit 拒发），Lax 顶层导航始终携带；dsh 侧
/// 只按名字取值验签，不关心存储属性。成功返回 true。
pub(crate) fn seed_session_cookie(app: &AppHandle, host: &str, port: u16, name: &str, value: &str) -> bool {
    seed_session_cookie_for(app, "main", host, port, name, value)
}

/// 同上，但目标窗口按 label（#89 多窗口：每个 profile 一个窗口）。
pub(crate) fn seed_session_cookie_for(
    app: &AppHandle,
    label: &str,
    host: &str,
    port: u16,
    name: &str,
    value: &str,
) -> bool {
    let Some(w) = app.get_webview_window(label) else { return false };
    let mut cookie = cookie::Cookie::new(name.to_string(), value.to_string());
    cookie.set_domain(host.to_string());
    cookie.set_path("/");
    cookie.set_http_only(true);
    cookie.set_same_site(cookie::SameSite::Lax);
    // 30 天，与 dsh 侧 maxAge 一致；过期则重新用 state 里的 token 换
    cookie.set_max_age(cookie::time::Duration::days(30));
    match w.set_cookie(cookie) {
        // set_cookie 在 Linux 上（webkitgtk）可能不支持：失败则回退旧导航路径
        Err(e) => {
            log::warn!("[token] 原生种会话 cookie 失败（回退 token 直开路径）：{e}");
            false
        }
        Ok(()) => {
            log::info!("[token] 会话 cookie 已原生种入 webview（{label} · {host}:{port}）");
            true
        }
    }
}

/// 会话有效性验证：带上会话 cookie 请求根路径，服务端 200 = cookie 可通过认证。
/// 全程 Rust 原生 HTTP，不依赖任何界面状态。
pub(crate) fn session_cookie_accepts(host_port: &str, name: &str, value: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(host_port) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let req = format!(
        "GET / HTTP/1.1\r\nHost: {host_port}\r\nCookie: {name}={value}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    matches!(
        head.lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse::<u16>().ok()),
        Some(200)
    )
}

/// 生成本地通知服务器的访问 token（防本机其它进程误触发；非加密学强度）。
pub(crate) fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("xnl{:x}{:x}", nanos, std::process::id())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_web_token_line_extracts_token() {
        // 真实 stdout 行格式（单独一行）
        let line = "dsh web: http://127.0.0.1:3080/?token=RQsEG-U8B4RMcWxE2d8LRQLt5yLHl_3RlPKFexm1Lu0";
        assert_eq!(
            parse_web_token_line(line).as_deref(),
            Some("RQsEG-U8B4RMcWxE2d8LRQLt5yLHl_3RlPKFexm1Lu0")
        );
        let short = "dsh web: http://127.0.0.1:13080/?token=MUpczjUeeXYnS6uOr3b2G461BgylSTmIA3Nkz1LKDOY";
        assert_eq!(
            parse_web_token_line(short).as_deref(),
            Some("MUpczjUeeXYnS6uOr3b2G461BgylSTmIA3Nkz1LKDOY")
        );
    }

    #[test]
    fn parse_web_token_line_stops_at_boundary() {
        // token 后跟其它字符（如回车后的提示）时在字符集边界截断
        let line = "dsh web: http://127.0.0.1:3080/?token=abc123 extra";
        assert_eq!(parse_web_token_line(line).as_deref(), Some("abc123"));
    }

    #[test]
    fn parse_web_token_line_rejects_non_token_lines() {
        assert_eq!(parse_web_token_line("[dsh] ready"), None);
        assert_eq!(parse_web_token_line("dsh web: http://127.0.0.1:3080/"), None);
        assert_eq!(parse_web_token_line("dsh web: http://x/?token="), None);
        assert_eq!(parse_web_token_line(""), None);
    }



    #[test]
    fn random_token_nonempty_and_unique() {
        let a = random_token();
        let b = random_token();
        assert!(!a.is_empty());
        assert_ne!(a, b, "连续两次生成的 token 不应相同");
    }

}
