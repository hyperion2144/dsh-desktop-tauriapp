//! 上游（真实 dsh）地址解析与连接：本地 loopback 或远程 http(s)，普通请求与 WS 共用。
//!
//! 每次请求**实时解析**上游：dsh 重启/profile 切换后端口会变，缓存会连到死实例。

use tauri::{AppHandle, Manager};

use crate::runtime::state::DshState;

/// 可读可写的上游连接（TCP 或 TLS，统一装箱）。
pub(crate) trait AsyncStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> AsyncStream for T {}

/// 上游描述。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Upstream {
    /// https（远程隧道）还是 http（本机/局域网）。
    pub(crate) secure: bool,
    /// `host[:port]`——会被写成转发请求的 Host 头，**必须与 dsh 自己的 authority 一致**
    /// （cookie 名是 `sha256(authority)`，改了 Host 就换一套 cookie 名）。
    pub(crate) authority: String,
    /// 壳持有的会话 cookie（`name=value`；与 authority 不匹配时为 None）。
    pub(crate) cookie: Option<String>,
}

impl Upstream {
    /// 转发请求要写的 `Origin`（与 Host 同源，dsh 的同源栅栏据此放行）。
    pub(crate) fn origin(&self) -> String {
        format!(
            "{}://{}",
            if self.secure { "https" } else { "http" },
            self.authority
        )
    }
}

/// 解析 `remote_addr`：完整 URL（含 token）或旧格式 `host[:port]` → `(secure, authority)`。
pub(crate) fn parse_remote(addr: &str) -> Option<(bool, String)> {
    let trimmed = addr.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(url) = tauri::Url::parse(trimmed) {
        if url.scheme() == "http" || url.scheme() == "https" {
            let host = url.host_str()?;
            let authority = match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            };
            return Some((url.scheme() == "https", authority));
        }
    }
    let host_port = trimmed.split('/').next()?;
    if host_port.is_empty() {
        return None;
    }
    let authority = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:3080")
    };
    Some((false, authority))
}

/// `authority` → `(host, port)`；`[::1]:3080` 形态也接受。
pub(crate) fn split_authority(authority: &str, secure: bool) -> Option<(String, u16)> {
    let fallback = if secure { 443 } else { 80 };
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(fallback);
        return Some((host.to_string(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            Some((host.to_string(), port.parse::<u16>().ok()?))
        }
        _ if !authority.is_empty() => Some((authority.to_string(), fallback)),
        _ => None,
    }
}

/// 当前生效的上游；端口未知（尚未就绪 / 远程地址为空）返回 None。
pub(crate) fn current(app: &AppHandle) -> Option<Upstream> {
    let settings = crate::settings::load_desktop_settings();
    let (secure, authority) = match settings.remote_addr.as_deref() {
        Some(addr) => parse_remote(addr)?,
        None => {
            let port = app.state::<DshState>().main_worker.port();
            if port == 0 {
                return None;
            }
            (false, format!("127.0.0.1:{port}"))
        }
    };
    let cookie = super::session_cookie(&authority);
    Some(Upstream {
        secure,
        authority,
        cookie,
    })
}

/// 连接上游（含 TLS）。失败原样返回 io 错误，由调用方回 502。
pub(crate) async fn connect(upstream: &Upstream) -> std::io::Result<Box<dyn AsyncStream>> {
    let (host, port) = split_authority(&upstream.authority, upstream.secure).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("非法上游 authority：{}", upstream.authority),
        )
    })?;
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
    // #147 教训：loopback/局域网也要关 Nagle，否则小块 JSON-RPC 会被攒包。
    let _ = tcp.set_nodelay(true);
    if !upstream.secure {
        return Ok(Box::new(tcp));
    }
    let connector = tokio_native_tls::native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let stream = tokio_native_tls::TlsConnector::from(connector)
        .connect(&host, tcp)
        .await
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    Ok(Box::new(stream))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remote_reads_full_url() {
        assert_eq!(
            parse_remote("http://192.168.1.9:3080/?token=abc"),
            Some((false, "192.168.1.9:3080".to_string()))
        );
        assert_eq!(
            parse_remote("https://box.trycloudflare.com/?token=abc"),
            Some((true, "box.trycloudflare.com".to_string()))
        );
        assert_eq!(
            parse_remote("http://127.0.0.1:3081"),
            Some((false, "127.0.0.1:3081".to_string()))
        );
    }

    #[test]
    fn parse_remote_accepts_legacy_host_port() {
        assert_eq!(parse_remote("10.0.0.5:3080"), Some((false, "10.0.0.5:3080".to_string())));
        assert_eq!(parse_remote("10.0.0.5"), Some((false, "10.0.0.5:3080".to_string())));
        assert_eq!(parse_remote("   "), None);
        assert_eq!(parse_remote(""), None);
    }

    #[test]
    fn split_authority_handles_ipv6_and_defaults() {
        assert_eq!(split_authority("127.0.0.1:3080", false), Some(("127.0.0.1".into(), 3080)));
        assert_eq!(split_authority("example.com", true), Some(("example.com".into(), 443)));
        assert_eq!(split_authority("example.com", false), Some(("example.com".into(), 80)));
        assert_eq!(split_authority("[::1]:3091", false), Some(("::1".into(), 3091)));
        assert_eq!(split_authority("", false), None);
    }

    #[test]
    fn origin_matches_scheme() {
        let up = Upstream {
            secure: true,
            authority: "h:8443".into(),
            cookie: None,
        };
        assert_eq!(up.origin(), "https://h:8443");
    }
}
