//! Tauri 导航守卫插件模块。
//!
//! 拦截顶层外部导航（阻止），内部主机放行；用户主动点击的外链由 client 侧接管
//! （capture 点击 / window.open 覆盖均转系统浏览器）。
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
            // 顶层外部导航：阻止且不转浏览器。用户主动点击的外链已由 client 侧接管
            // （capture 点击判定 system、<a target=_blank>/window.open 由覆盖层转系统），
            // 能走到这里的只剩 iframe 顶层导航尝试（侧边栏浏览器关闭沙箱后的
            // frame-busting）与页面脚本主动 location 跳转——转浏览器会把用户从应用
            // 甩到外部（实测：点「解锁沙箱」即被甩走）。
            log::info!("[nav] 已阻止顶层外部导航（不转浏览器）：{url}");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    #[test]
    fn navigate_guard_allows_internal_and_blocks_external_top_level() {
        // 内部主机放行（dsh web 各形态）
        assert!(navigate_guard(&u("http://127.0.0.1:3081/")));
        assert!(navigate_guard(&u("http://localhost:3080/x")));
        assert!(navigate_guard(&u("http://tauri.localhost/assets/a.js")));
        // 外部：阻止顶层导航，且不触发系统浏览器（#117 续：frame-busting 误开）
        assert!(!navigate_guard(&u("https://example.com/a")));
        // 其它 scheme 放行（不参与外链判定）
        assert!(navigate_guard(&u("tauri://localhost/index.html")));
    }
}
