//! guest 导航策略（#118）。
//!
//! 对齐 dsh 官方 Electron 桌面 `browser-guests.ts` 的边界规则：
//! - 放行外部 http/https（guest 的存在意义：顶层导航外部站点）；
//! - 拒绝带凭证 URL（`user:pass@host` ——官方 session 级拒绝）；
//! - 拒绝应用宿主（loopback / 内部 dsh 主机）——guest 页面不得触达本机
//!   dsh 服务（存储已按 workspace partition 隔离，导航层同样封死）；
//! - `about:` 放行（bootstrap 空白页）；
//! - 其余 scheme 一律拒绝（file:/data:/javascript: 等）。
//!
//! 注意：此策略挂在 guest 子 webview 自己的 builder 级 `on_navigation` 上，
//! 先于全局 nav_guard 运行（tauri 导航回调为 AND 组合）。

use crate::runtime::state::INTERNAL_HOSTS;

/// 判定 URL 是否带内嵌凭证（`user:pass@host` 形态）。
fn has_embedded_credentials(url: &tauri::Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

/// 判定主机是否为应用宿主（loopback + tauri.localhost + 运行时放行的远程 dsh 主机）。
/// IPv6 字面量的 host_str() 带方括号（如 `[::1]`），先剥离再比对。
fn is_app_host(host: &str) -> bool {
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if matches!(host, "127.0.0.1" | "::1" | "localhost" | "tauri.localhost") {
        return true;
    }
    INTERNAL_HOSTS
        .lock()
        .map(|hosts| hosts.iter().any(|h| h == host))
        .unwrap_or(false)
}
/// guest 导航策略（builder 级 on_navigation 回调）。
pub(crate) fn guest_navigation_policy(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => !has_embedded_credentials(url) && !is_app_host(url.host_str().unwrap_or("")),
        "about" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    #[test]
    fn guest_policy_allows_external_http_https() {
        assert!(guest_navigation_policy(&u("https://www.baidu.com/")));
        assert!(guest_navigation_policy(&u("http://example.org:8080/path?q=1")));
    }

    #[test]
    fn guest_policy_denies_credentials_and_app_hosts() {
        assert!(!guest_navigation_policy(&u("https://user:pass@example.com/")));
        assert!(!guest_navigation_policy(&u("https://user@example.com/")));
        // 应用宿主：loopback 各形态 + tauri.localhost
        assert!(!guest_navigation_policy(&u("http://127.0.0.1:3080/api")));
        assert!(!guest_navigation_policy(&u("http://localhost:3081/")));
        assert!(!guest_navigation_policy(&u("http://[::1]:3080/")));
        assert!(!guest_navigation_policy(&u("http://tauri.localhost/assets/a.js")));
    }

    #[test]
    fn guest_policy_allows_about_blank_and_denies_other_schemes() {
        assert!(guest_navigation_policy(&u("about:blank")));
        assert!(!guest_navigation_policy(&u("file:///etc/passwd")));
        assert!(!guest_navigation_policy(&u("data:text/html,<script>1</script>")));
        assert!(!guest_navigation_policy(&u("javascript:alert(1)")));
        assert!(!guest_navigation_policy(&u("ftp://example.com/")));
    }
}
