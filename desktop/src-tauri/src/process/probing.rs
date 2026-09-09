//! 健康探测模块。
//!
//! 迁移自 lib.rs 功能区域 6（probing，行 1100–1149）。
//! TCP 连接判活 + HTTP 200 辅助日志。
//! 实现迁移自 lib.rs（票据 #49）。

use std::time::Duration;

/// 裸 HTTP GET 探测：返回状态码 < 400 即 true。
pub(crate) fn probe_http(host_port: &str, path: &str) -> std::io::Result<bool> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(host_port)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes())?;
    let mut buf = [0u8; 256];
    let n = stream.read(&mut buf)?;
    let head = String::from_utf8_lossy(&buf[..n]).to_string();
    Ok(head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .map(|code| code < 400)
        .unwrap_or(false))
}

/// 本地 dsh 探测：健康=TCP 连接成功（监听 socket 在高负载时也接受连接，不会抖动）；
/// HTTP 探测只作日志细节，绝不作为判死依据。
pub(crate) fn probe_local(port: u16) -> (bool, String) {
    let addr = format!("127.0.0.1:{port}");
    if !matches!(std::net::TcpStream::connect(&addr), Ok(_)) {
        return (false, format!("{addr} 连接失败"));
    }
    let detail = match probe_http(&addr, "/") {
        Ok(true) => "HTTP 200".into(),
        Ok(false) => "HTTP 非 2xx/3xx（仅日志）".into(),
        Err(e) => format!("HTTP 探测超时/异常（仅日志）：{e}"),
    };
    (true, detail)
}

/// 远程 dsh 探测：入参可为完整 URL（新版）或 host:port（旧格式）。与本地同语义。
pub(crate) fn probe_remote(addr: &str) -> (bool, String) {
    let host_port = crate::network::remote::remote_host_port(addr);
    if !matches!(std::net::TcpStream::connect(&host_port), Ok(_)) {
        return (false, format!("{host_port} 连接失败"));
    }
    let detail = match probe_http(&host_port, "/") {
        Ok(true) => "HTTP 200".into(),
        Ok(false) => "HTTP 非 2xx/3xx（仅日志）".into(),
        Err(e) => format!("HTTP 探测超时/异常（仅日志）：{e}"),
    };
    (true, detail)
}
