//! 远程 dsh 地址管理 + 导航。
//!
//! 迁移自 lib.rs 功能区域（remote）。

use tauri::{AppHandle, Manager};
use crate::runtime::state::DshState;
use crate::settings::{load_desktop_settings, configured_port};
use crate::network::web_token::store_web_token;
use crate::network::notify::show_notification;
use crate::ui::tray::{refresh_tray_mode, restart_dsh_in_mode};
use crate::commands::prompt_input;
use std::sync::atomic::Ordering;
use std::time::Duration;
use crate::{set_status, INTERNAL_HOSTS, STATUS_REMOTE};
pub(crate) fn normalize_remote_url(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url = tauri::Url::parse(&with_scheme).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if url.host_str().unwrap_or("").is_empty() {
        return None;
    }
    let path = url.path();
    if !(path.is_empty() || path == "/") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(url.to_string())
}

/// 远程条目的展示名：URL 形态取 host[:port]（旧格式原样返回）。
/// 托盘标签/状态详情用它，避免把长 URL（含 token）直接铺进菜单。
pub(crate) fn remote_display(addr: &str) -> String {
    if let Ok(url) = tauri::Url::parse(addr) {
        if url.scheme() == "http" || url.scheme() == "https" {
            let host = url.host_str().unwrap_or("");
            return match url.port() {
                Some(p) => format!("{host}:{p}"),
                None => host.to_string(),
            };
        }
    }
    addr.to_string()
}

/// 远程地址的 TCP 连接目标 host:port（URL 形态解析并补 scheme 默认端口；旧格式原样）。
pub(crate) fn remote_host_port(addr: &str) -> String {
    if let Ok(url) = tauri::Url::parse(addr) {
        if url.scheme() == "http" || url.scheme() == "https" {
            let host = url.host_str().unwrap_or("");
            let port = url.port_or_known_default().unwrap_or(80);
            return format!("{host}:{port}");
        }
    }
    addr.to_string()
}


/// 从用户粘贴的 dsh web 启动 URL 里提取 process token（没有则 None）。
pub(crate) fn extract_token_from_url(input: &str) -> Option<String> {
    let url = tauri::Url::parse(input.trim()).ok()?;
    let (_, value) = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(k, v)| (k.to_string(), v.to_string()))?;
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// 选择远程/本地服务来源：写 settings 后按来源重启。
/// `addr` 存完整 URL（新版 dsh web 带 process token；旧格式 host[:port] 仍兼容）。
pub(crate) fn select_remote(app: &AppHandle, addr: Option<String>) {
    let mut settings = load_desktop_settings();
    settings.remote_addr = addr;
    // #90 架构约束：Rust 不写 settings.yaml——持久化由 client→插件→dsh settings 服务承担
    if let Some(a) = settings.remote_addr.as_deref() {
        let host = remote_host_port(a).split(':').next().unwrap_or(a).to_string();
        let mut list = INTERNAL_HOSTS.lock().unwrap();
        if !list.contains(&host) {
            list.push(host);
        }
        log::info!("[tray] 切换 dsh 服务地址 -> 远程 {}", remote_display(a));
    } else {
        log::info!("[tray] 切换 dsh 服务地址 -> 本地");
    }
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode);
}

/// 新增远程地址流程：弹窗输入完整 URL（或旧格式 host[:port]）→ 校验 → 存入列表并选中。
pub(crate) fn add_remote_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(input) = prompt_input(&handle, "add-remote", "新增 dsh 服务地址", "dsh web 打印的完整 URL（含 token），或 host[:port]", "").await else {
            return;
        };
        let Some(addr) = normalize_remote_url(&input) else {
            show_notification(&handle, "新增地址失败", "格式应为 dsh web 打印的完整 URL 或 host[:port]");
            return;
        };
        // 新版 dsh web 的 token 是必要凭据：URL 里带了就先存入 state，
        // 供远程导航直接使用（导航时按需拼接，不修改用户保存的原始 URL）。
        if let Some(token) = extract_token_from_url(&addr) {
            store_web_token(&handle, token);
        }
        let mut settings = load_desktop_settings();
        if !settings.remote_list.contains(&addr) {
            settings.remote_list.push(addr.clone());
        }
        // #90：持久化由 client→插件→dsh settings 服务承担
        log::info!("[tray] 新增远程 dsh 地址：{}（未切换，请在菜单中手动选择）", remote_display(&addr));
        refresh_tray_mode(&handle);
    });
}

/// 删除远程地址（当前选中项自动回本地）。
pub(crate) fn remove_remote_flow(app: &AppHandle, addr: &str) {
    let mut settings = load_desktop_settings();
    settings.remote_list.retain(|a| a != addr);
    if settings.remote_addr.as_deref() == Some(addr) {
        settings.remote_addr = None;
    }
    // #90：持久化由 client→插件→dsh settings 服务承担
    log::info!("[tray] 删除远程 dsh 地址：{}", remote_display(addr));
    refresh_tray_mode(app);
}

/// 设置本地端口流程：弹窗输入 → 校验 → 保存 →（本地模式）重启生效。
pub(crate) fn set_port_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let current = configured_port().to_string();
        let Some(input) = prompt_input(&handle, "set-port", "设置本地 dsh web 端口", "端口（1-65535）", &current).await else {
            return;
        };
        let Ok(port) = input.parse::<u16>() else {
            show_notification(&handle, "设置端口失败", "请输入 1-65535 的整数");
            return;
        };
        if port == 0 {
            show_notification(&handle, "设置端口失败", "端口不能为 0");
            return;
        }
        let mut settings = load_desktop_settings();
        settings.port = Some(port);
        // #86：web 端口同时写入 per-profile 覆盖表（settings.port 保留作 legacy 回退/展示）
        settings
            .profile_ports
            .get_or_insert_with(Default::default)
            .insert("web".to_string(), port);
        // #90：持久化由 client→插件→dsh settings 服务承担
        log::info!("[tray] 本地端口 -> {port}");
        if settings.remote_addr.is_some() {
            show_notification(&handle, "端口已保存", &format!("{port} 将在本地模式生效"));
        } else {
            let mode = handle.state::<DshState>().mode.load(Ordering::SeqCst);
            restart_dsh_in_mode(&handle, mode);
        }
        refresh_tray_mode(&handle);
    });
}

/// 打开代理设置窗口（单例：已开则聚焦，不重建）。
pub(crate) fn open_proxy_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("proxy-settings") {
        // 窗口已存在：聚焦即可
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // 创建新窗口（用 App 路径，Tauri 自动按平台解析 tauri://localhost 或 http://tauri.localhost）
    let url = tauri::WebviewUrl::App("proxy-settings.html".into());
    match tauri::WebviewWindowBuilder::new(app, "proxy-settings", url)
        .title("代理设置")
        .inner_size(520.0, 480.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .build()
    {
        Ok(_) => log::info!("[tray] 代理设置窗口已打开"),
        Err(e) => log::error!("[tray] 打开代理设置窗口失败：{e}"),
    }
}

/// 远程首页是否挂载了本插件的 client（GET / 并从响应里检索挂载串）。
/// `addr` 可为完整 URL（新版，带 token 时跟随 303 换 cookie；探活页只需要 200 首页）
/// 或 host:port（旧格式）。
pub(crate) fn remote_has_plugin(addr: &str) -> bool {
    use std::io::{Read, Write};
    let host_port = remote_host_port(addr);
    // 请求路径取 URL 的 path+query（含 token 时 dsh 会 303 → cookie 首页），
    // 旧格式 host:port 保持请求根路径。
    let (target, cookie) = match tauri::Url::parse(addr) {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => {
            let q = match u.query() {
                Some(q) => format!("?{q}"),
                None => String::new(),
            };
            let path = if u.path().is_empty() { "/" } else { u.path() };
            (format!("{path}{q}"), String::new())
        }
        _ => ("/".to_string(), String::new()),
    };
    // 最多跟一次重定向（token 交换 303 → Set-Cookie → 首页 200）。
    // 裸 socket 不带 cookie jar，手动接住 Set-Cookie 再发第二跳。
    let mut current_target = target;
    let mut current_cookie = cookie;
    let mut buf = Vec::with_capacity(65536);
    for _hop in 0..2 {
        let Ok(mut stream) = std::net::TcpStream::connect(&host_port) else { return false };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let mut req = format!(
            "GET {current_target} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n"
        );
        if !current_cookie.is_empty() {
            req.push_str(&format!("Cookie: {current_cookie}\r\n"));
        }
        req.push_str("\r\n");
        if stream.write_all(req.as_bytes()).is_err() {
            return false;
        }
        buf.clear();
        let mut tmp = [0u8; 8192];
        loop {
            match stream.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.len() >= 65536 {
                        break;
                    }
                }
            }
        }
        let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let status = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse::<u16>().ok())
            .unwrap_or(0);
        if (300..400).contains(&status) {
            // 记下 Set-Cookie，按 Location 起一跳（Location 可能是相对路径 /）
            let set_cookie = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string());
            if let Some(cv) = set_cookie {
                let pair = cv.split(';').next().unwrap_or("").trim().to_string();
                if !pair.is_empty() {
                    current_cookie = pair;
                }
            }
            let loc = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("location:"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string())
                .unwrap_or_default();
            if loc.is_empty() {
                return false;
            }
            current_target = if loc.starts_with("http://") || loc.starts_with("https://") {
                match tauri::Url::parse(&loc) {
                    Ok(u) => {
                        let q = u.query().map(|q| format!("?{q}")).unwrap_or_default();
                        let path = if u.path().is_empty() { "/" } else { u.path() };
                        format!("{path}{q}")
                    }
                    Err(_) => return false,
                }
            } else {
                loc
            };
            continue;
        }
        break;
    }
    String::from_utf8_lossy(&buf).contains("/plugins/dsh-desktop-tauriapp/client.js")
}

/// 导航到远程 dsh 页面。`addr` 为完整 URL（新版 dsh web 含 process token）
/// 或旧格式 host:port（自动补 http://）。
/// 桌面 chrome 由 client 经 IPC 查询壳状态自行激活（不再使用 URL 标记，
/// 也就不存在 303 剥参数后的二次补跳）。远程缺插件时提示建议切兼容，不阻塞。
pub(crate) fn navigate_remote(app: &AppHandle, addr: &str, advanced: bool) {
    let host_port = remote_host_port(addr);
    let host = host_port.split(':').next().unwrap_or(addr).to_string();
    {
        let mut list = INTERNAL_HOSTS.lock().unwrap();
        if !list.contains(&host) {
            list.push(host);
        }
    }
    if advanced && !remote_has_plugin(addr) {
        log::warn!("[remote] 远程未检测到 dsh-desktop-tauriapp 插件，建议使用兼容模式");
        show_notification(app, "远程 dsh 未安装桌面插件", "高级模式需要远程安装 dsh-desktop-tauriapp，建议改用兼容模式");
    }
    // 完整 URL 原样用（含 token/旧参数）；旧格式补 scheme 与根路径
    let url = if tauri::Url::parse(addr)
        .map(|u| u.scheme() == "http" || u.scheme() == "https")
        .unwrap_or(false)
    {
        addr.to_string()
    } else {
        format!("http://{addr}/")
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.location.replace({url:?});"));
    }
    log::info!("已导航到远程 dsh：{}（{}）", remote_display(&url), url);
    set_status(app, STATUS_REMOTE, &format!("远程 {}", remote_display(addr)));
    app.state::<DshState>().ready_once.store(true, Ordering::SeqCst);
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_remote_url_accepts_full_and_legacy() {
        // 完整 URL（新版 dsh web 打印格式）
        assert_eq!(
            normalize_remote_url("http://192.168.1.10:3080/?token=abc-DEF_123").as_deref(),
            Some("http://192.168.1.10:3080/?token=abc-DEF_123")
        );
        // 旧格式 host:port 与裸 host（自动补 scheme/端口）
        assert_eq!(
            normalize_remote_url("192.168.1.10:3080").as_deref(),
            Some("http://192.168.1.10:3080/")
        );
        assert_eq!(
            normalize_remote_url("dsh.example.cn").as_deref(),
            Some("http://dsh.example.cn/")
        );
        // https 保留
        assert_eq!(
            normalize_remote_url("https://dsh.example.cn/").as_deref(),
            Some("https://dsh.example.cn/")
        );
    }

    #[test]
    fn normalize_remote_url_rejects_bad_input() {
        assert_eq!(normalize_remote_url(""), None);
        assert_eq!(normalize_remote_url("ftp://x"), None);
        assert_eq!(normalize_remote_url("http://user:pass@h/"), None);
        assert_eq!(normalize_remote_url("http://h/extra/path"), None);
        // 无 host
        assert_eq!(normalize_remote_url("http://"), None);
    }

    #[test]
    fn remote_display_hides_token() {
        assert_eq!(
            remote_display("http://192.168.1.10:3080/?token=secret123"),
            "192.168.1.10:3080"
        );
        assert_eq!(remote_display("https://dsh.example.cn/"), "dsh.example.cn");
        // 旧格式原样
        assert_eq!(remote_display("192.168.1.10:3080"), "192.168.1.10:3080");
    }

    #[test]
    fn remote_host_port_resolves_urls() {
        assert_eq!(
            remote_host_port("http://192.168.1.10:3080/?token=x"),
            "192.168.1.10:3080"
        );
        // 缺省端口按 scheme 补全
        assert_eq!(remote_host_port("https://dsh.example.cn/"), "dsh.example.cn:443");
        assert_eq!(remote_host_port("192.168.1.10:3080"), "192.168.1.10:3080");
    }

    #[test]
    fn extract_token_from_url_reads_query() {
        assert_eq!(
            extract_token_from_url("http://127.0.0.1:3080/?token=abc_DEF-1").as_deref(),
            Some("abc_DEF-1")
        );
        assert_eq!(extract_token_from_url("http://127.0.0.1:3080/"), None);
        assert_eq!(extract_token_from_url("http://h/?token="), None);
        assert_eq!(extract_token_from_url("not a url"), None);
    }

}
