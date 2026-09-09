//! Tauri 导航守卫插件模块。
//!
//! 拦截外链交默认浏览器，内部主机放行。
//! 迁移自 lib.rs 功能区域（nav_guard）。

use crate::runtime::state::INTERNAL_HOSTS;
use crate::open_external_impl;

pub fn nav_guard_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("dsh-nav-guard")
        .on_navigation(|_webview, url| navigate_guard(url))
        .build()
}

pub fn navigate_guard(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            // 内部主机：dsh web（127.0.0.1/::1/localhost）+ Windows 资产协议主机 tauri.localhost
            // （后者若被当外链会触发 cmd start 把 URL 当文件名打开而报「找不到文件」）
            // + 运行时放行的远程 dsh 主机（托盘「dsh 服务地址」选择后写入）。
            let runtime_internal = INTERNAL_HOSTS
                .lock()
                .unwrap()
                .iter()
                .any(|h| h == host);
            let internal = host == "127.0.0.1" || host == "::1" || host == "localhost" || host == "tauri.localhost" || runtime_internal;
            if internal {
                return true;
            }
            log::info!("[nav] 拦截外部链接并交给默认浏览器：{url}");
            let _ = open_external_impl(url.as_str());
            false
        }
        "mailto" | "tel" => {
            log::info!("[nav] 拦截外部协议并在系统打开：{url}");
            let _ = open_external_impl(url.as_str());
            false
        }
        _ => true,
    }
}
