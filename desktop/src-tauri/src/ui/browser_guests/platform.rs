//! guest 平台原生读控（#118）。
//!
//! tauri Webview 没有 goBack/goForward/canGoBack/canGoForward 的跨平台 API
//! （reload/navigate/set_bounds 有）。历史读写按平台实现：
//! - macOS：`with_webview` 拿到裸 WKWebView 指针，objc2 `msg_send!` 直调；
//! - Windows：`controller()` 拿到 `ICoreWebView2Controller`，COM 调
//!   `CoreWebView2()` 后 GoBack/GoForward/CanGoBack/CanGoForward。
//!
//! 两个函数都在主线程（`with_webview` 闭包内）执行，禁止阻塞。

use tauri::webview::PlatformWebview;

/// 读取原生历史可用性。
pub(crate) fn native_read_history(pv: &PlatformWebview) -> (bool, bool) {
    native_history_impl(pv, None)
}

/// 执行历史动作（"back" | "forward"），顺带返回读数。
pub(crate) fn native_history_control(pv: &PlatformWebview, action: &str) -> (bool, bool) {
    native_history_impl(pv, Some(action))
}

#[cfg(target_os = "macos")]
fn native_history_impl(pv: &PlatformWebview, action: Option<&str>) -> (bool, bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let wk = pv.inner() as *mut AnyObject;
    if wk.is_null() {
        log::warn!("[browser-guest] WKWebView 指针为空，历史读控跳过");
        return (false, false);
    }
    unsafe {
        let can_back: bool = msg_send![wk, canGoBack];
        let can_forward: bool = msg_send![wk, canGoForward];
        match action {
            Some("back") => {
                let _nav: *mut AnyObject = msg_send![wk, goBack];
            }
            Some("forward") => {
                let _nav: *mut AnyObject = msg_send![wk, goForward];
            }
            _ => {}
        }
        (can_back, can_forward)
    }
}

#[cfg(windows)]
fn native_history_impl(pv: &PlatformWebview, action: Option<&str>) -> (bool, bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Controller};

    let controller: ICoreWebView2Controller = pv.controller();
    let core: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[browser-guest] 取 CoreWebView2 失败：{e}");
            return (false, false);
        }
    };
    unsafe {
        let mut back = windows_core::BOOL::default();
        if let Err(e) = core.CanGoBack(&mut back) {
            log::warn!("[browser-guest] CanGoBack 失败：{e}");
            return (false, false);
        }
        let mut forward = windows_core::BOOL::default();
        if let Err(e) = core.CanGoForward(&mut forward) {
            log::warn!("[browser-guest] CanGoForward 失败：{e}");
            return (false, false);
        }
        match action {
            Some("back") => {
                if let Err(e) = core.GoBack() {
                    log::warn!("[browser-guest] GoBack 失败：{e}");
                }
            }
            Some("forward") => {
                if let Err(e) = core.GoForward() {
                    log::warn!("[browser-guest] GoForward 失败：{e}");
                }
            }
            _ => {}
        }
        (back.as_bool(), forward.as_bool())
    }
}

// 其它平台（Linux 不在本壳支持范围）编译占位
#[cfg(not(any(target_os = "macos", windows)))]
fn native_history_impl(_pv: &PlatformWebview, _action: Option<&str>) -> (bool, bool) {
    (false, false)
}
