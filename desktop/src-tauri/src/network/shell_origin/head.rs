//! HTTP/1.1 报文头解析与重写（纯函数，全部可单测）。
//!
//! 壳内 origin 服务是「一次连接一次请求」的转发器：读请求头 → 改写 → 连上游 →
//! 把上游响应头改写后回写，body **逐字节透传**。正因为 body 不解析，`content-length`
//! 与 `transfer-encoding: chunked` 两种分帧都不必理解——上游请求一律 `connection: close`，
//! 响应也强制 `connection: close`，客户端因此不会复用连接去发第二个请求。

/// 报文头上限：超过即视为畸形连接（正常浏览器头 < 8 KiB）。
pub(crate) const MAX_HEAD_BYTES: usize = 64 * 1024;

/// 一个 HTTP 报文头：起始行 + 保序字段（名字保留原样，比较时大小写不敏感）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Head {
    /// 请求行或状态行，不含 CRLF。例如 `GET /t/api/x HTTP/1.1`。
    pub(crate) line: String,
    /// 头字段，保序。
    pub(crate) fields: Vec<(String, String)>,
}

impl Head {
    /// 大小写不敏感取首个字段值。
    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// 删除全部同名字段。
    pub(crate) fn remove(&mut self, name: &str) {
        self.fields.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
    }

    /// 覆盖式写入（先删同名再追加到末尾）。
    pub(crate) fn set(&mut self, name: &str, value: impl Into<String>) {
        self.remove(name);
        self.fields.push((name.to_string(), value.into()));
    }

    /// 起始行的第一个词（请求方法或 HTTP 版本）。
    pub(crate) fn method(&self) -> &str {
        self.line.split_whitespace().next().unwrap_or("")
    }

    /// 起始行的第二个词（请求目标或状态码）。
    pub(crate) fn target(&self) -> &str {
        self.line.split_whitespace().nth(1).unwrap_or("")
    }

    /// 状态行里的状态码（请求头返回 None）。
    pub(crate) fn status(&self) -> Option<u16> {
        let raw = self.line.split_whitespace().nth(1)?;
        if raw.len() == 3 {
            raw.parse().ok()
        } else {
            None
        }
    }

    /// 是否为 WebSocket 升级报文（请求的 Upgrade 或 101 响应的 Upgrade）。
    pub(crate) fn is_upgrade(&self) -> bool {
        if self
            .get("upgrade")
            .is_some_and(|v| v.to_ascii_lowercase().contains("websocket"))
        {
            return true;
        }
        self.get("connection")
            .is_some_and(|v| v.to_ascii_lowercase().contains("upgrade"))
    }

    /// 序列化回字节（CRLF 结尾，含终止空行）。
    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(self.line.as_bytes());
        out.extend_from_slice(b"\r\n");
        for (k, v) in &self.fields {
            out.extend_from_slice(k.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(v.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"\r\n");
        out
    }
}

/// 报文头结束位置（`\r\n\r\n` 之后的下标）；未收齐返回 None。
pub(crate) fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// 解析报文头。畸形（无起始行/字段无冒号/超限）返回 None。
pub(crate) fn parse_head(buf: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(buf).ok()?;
    let mut lines = text.split("\r\n");
    let line = lines.next()?.to_string();
    if line.is_empty() || line.split_whitespace().count() < 2 {
        return None;
    }
    let mut fields = Vec::new();
    for raw in lines {
        if raw.is_empty() {
            break;
        }
        let (name, value) = raw.split_once(':')?;
        // 折行（obs-fold）在 HTTP/1.1 已废弃，浏览器不会发；遇到直接按畸形处理。
        if name.starts_with(' ') || name.starts_with('\t') {
            return None;
        }
        fields.push((name.trim().to_string(), value.trim().to_string()));
    }
    Some(Head { line, fields })
}

/// 上游请求头改写：让 dsh 看到的是**它自己的** authority 与 origin，
/// 并带上壳持有的会话 cookie——`isTrustedApiRequest` 的同源栅栏因此天然通过。
pub(crate) fn rewrite_request(
    mut head: Head,
    authority: &str,
    origin: &str,
    cookie: Option<&str>,
) -> Head {
    let upgrade = head.is_upgrade();
    head.set("host", authority);
    head.set("origin", origin);
    head.set("sec-fetch-site", "same-origin");
    match cookie {
        Some(value) => head.set("cookie", value),
        None => head.remove("cookie"),
    }
    if upgrade {
        head.set("connection", "Upgrade");
    } else {
        head.set("connection", "close");
    }
    head
}

/// 上游响应头改写：剥 `set-cookie`（会话由壳持有，不能让 webview 的 cookie jar
/// 与壳的"真值"漂移）、剥连接级头、强制 `close`；插件 bundle 改 `no-store`
/// （dsh 用 revision 标 immutable，壳重启会换 revision，旧缓存不可复用）。
pub(crate) fn rewrite_response(mut head: Head, plugin_bundle: bool) -> Head {
    head.remove("set-cookie");
    // #154：页面在壳注册的协议上（`dshapp://localhost`），而数据走本机 loopback 中继
    // → 对浏览器而言是**跳源**，所以响应必须带 CORS。浏览器侧**不需要凭据**（会话 cookie
    // 由中继在服务端注入），所以 `*` 就够，不用 `Allow-Credentials`（用了 `*` 反而不允许带凭据）。
    head.set("access-control-allow-origin", "*");
    head.remove("keep-alive");
    head.remove("proxy-connection");
    if plugin_bundle {
        head.remove("cache-control");
        head.remove("expires");
        head.remove("pragma");
        head.set("cache-control", "no-store");
    }
    if !head.is_upgrade() {
        head.set("connection", "close");
    }
    head
}

/// 路径是否属于插件 bundle 路由（combo 与包内 chunk 同前缀）。
pub(crate) fn is_plugin_bundle(path: &str) -> bool {
    path.starts_with("/plugins/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(raw: &str) -> Head {
        parse_head(raw.as_bytes()).expect("应能解析")
    }

    #[test]
    fn parse_splits_start_line_and_fields() {
        let head = req("GET /t/assets/a.js?x=1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nAccept: */*\r\n\r\n");
        assert_eq!(head.method(), "GET");
        assert_eq!(head.target(), "/t/assets/a.js?x=1");
        assert_eq!(head.get("host"), Some("127.0.0.1:1"));
        assert_eq!(head.get("ACCEPT"), Some("*/*"), "字段名比较应大小写不敏感");
        assert_eq!(head.status(), None);
    }

    #[test]
    fn parse_rejects_malformed() {
        assert!(parse_head(b"").is_none());
        assert!(parse_head(b"GET\r\n\r\n").is_none(), "只有方法没有目标");
        assert!(parse_head(b"GET / HTTP/1.1\r\nNoColon\r\n\r\n").is_none());
        assert!(parse_head(b"GET / HTTP/1.1\r\n folded\r\n\r\n").is_none(), "obs-fold 视为畸形");
    }

    #[test]
    fn head_end_finds_terminator() {
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r\nBODY"), Some(18));
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n"), None);
    }

    #[test]
    fn encode_round_trips() {
        let head = req("GET / HTTP/1.1\r\nHost: h\r\nX-A: 1\r\n\r\n");
        let decoded = parse_head(&head.encode()).unwrap();
        assert_eq!(decoded, head);
    }

    #[test]
    fn rewrite_request_pins_host_origin_and_cookie() {
        let head = req("POST /t/api/x HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: http://127.0.0.1:5000\r\nCookie: junk=1\r\n\r\n");
        let out = rewrite_request(head, "127.0.0.1:3080", "http://127.0.0.1:3080", Some("dsh-auth-x=v1"));
        assert_eq!(out.get("host"), Some("127.0.0.1:3080"));
        assert_eq!(out.get("origin"), Some("http://127.0.0.1:3080"));
        assert_eq!(out.get("cookie"), Some("dsh-auth-x=v1"), "旧 cookie 必须被替换而不是并存");
        assert_eq!(out.get("sec-fetch-site"), Some("same-origin"));
        assert_eq!(out.get("connection"), Some("close"));
        assert_eq!(out.fields.iter().filter(|(k, _)| k.eq_ignore_ascii_case("cookie")).count(), 1);
    }

    #[test]
    fn rewrite_request_keeps_upgrade_connection() {
        let head = req("GET /t/api/remote.mux HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        assert!(head.is_upgrade());
        let out = rewrite_request(head, "127.0.0.1:3080", "http://127.0.0.1:3080", None);
        assert_eq!(out.get("connection"), Some("Upgrade"));
        assert!(out.get("cookie").is_none());
    }

    #[test]
    fn rewrite_response_strips_cookie_and_forces_close() {
        let head = req("HTTP/1.1 200 OK\r\nSet-Cookie: dsh-auth-x=v1; Path=/\r\nCache-Control: max-age=60\r\n\r\n");
        let out = rewrite_response(head, true);
        assert!(out.get("set-cookie").is_none(), "响应 set-cookie 不得进 webview cookie jar");
        assert_eq!(out.get("cache-control"), Some("no-store"));
        assert_eq!(out.get("connection"), Some("close"));
        assert_eq!(out.status(), Some(200));
    }

    #[test]
    fn rewrite_response_leaves_101_connection_alone() {
        let head = req("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        let out = rewrite_response(head, false);
        assert_eq!(out.get("connection"), Some("Upgrade"));
        assert_eq!(out.status(), Some(101));
    }

    #[test]
    fn plugin_bundle_prefix_matches_combo_and_chunk() {
        assert!(is_plugin_bundle("/plugins/??a,b.client.js&rev=1"));
        assert!(is_plugin_bundle("/plugins/dsh-web-mobile/client.js?rev=2"));
        assert!(!is_plugin_bundle("/t/plugins/x"));
        assert!(!is_plugin_bundle("/api/x"));
    }
}
