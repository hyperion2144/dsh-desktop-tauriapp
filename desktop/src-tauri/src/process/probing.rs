//! 健康探测模块。
//!
//! 迁移自 lib.rs 功能区域 6（probing，行 1100–1149）。
//! TCP 连接判活 + HTTP 200 辅助日志。
//! 实现迁移自 lib.rs（票据 #49）。

use std::time::Duration;
use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};

/// 探测连接超时（#71 实测教训：裸 connect 在 SYN 被丢时会挂满系统级 ~75s，
/// 把「3 次失败 ≈15s」的判异常节奏拉长到分钟级）。2s 足够覆盖本地/局域网 RTT。
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// 带超时的探测连接：兼容 IP:port 与域名:port（后者走系统解析取首个地址）。
fn connect_probe(addr: &str) -> io::Result<TcpStream> {
    let sock_addr: SocketAddr = match addr.parse() {
        Ok(a) => a,
        Err(_) => addr
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "解析结果为空"))?,
    };
    TcpStream::connect_timeout(&sock_addr, PROBE_CONNECT_TIMEOUT)
}

/// 裸 HTTP GET 探测：返回状态码 < 400 即 true。
pub(crate) fn probe_http(host_port: &str, path: &str) -> std::io::Result<bool> {
    use std::io::{Read, Write};
    let mut stream = connect_probe(host_port)?;
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
    if connect_probe(&addr).is_err() {
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
    if connect_probe(&host_port).is_err() {
        return (false, format!("{host_port} 连接失败"));
    }
    let detail = match probe_http(&host_port, "/") {
        Ok(true) => "HTTP 200".into(),
        Ok(false) => "HTTP 非 2xx/3xx（仅日志）".into(),
        Err(e) => format!("HTTP 探测超时/异常（仅日志）：{e}"),
    };
    (true, detail)
}
