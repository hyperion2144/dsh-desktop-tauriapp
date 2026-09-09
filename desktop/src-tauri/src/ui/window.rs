//! 窗口操作：显示/隐藏主窗、错误页跳转、显示器匹配。

use tauri::{AppHandle, Manager};

use crate::network::notify::show_notification;

/// 主窗口跳转到本地错误页并发系统通知。
pub(crate) fn show_error(app: &AppHandle, reason: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let target = format!("error.html?reason={reason}");
        let _ = w.eval(&format!("window.location.replace({target:?});"));
    }
    let body = match reason {
        "not-found" => "未找到 dsh 命令，请按错误页提示安装。",
        "spawn-failed" => "dsh 进程启动失败，详见日志。",
        "timeout" => "等待本地服务就绪超时，详见日志。",
        _ => "未知错误，详见日志。",
    };
    show_notification(app, "DeepSeek Harness Desktop 启动失败", body);
}

/// 显示并聚焦主窗口。
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 双击拖拽区触发 macOS 风格的"zoom"——把窗口几何切到当前屏幕的 work area
///（MenuBar 与 Dock 不被覆盖），再次双击恢复到之前的几何。不是全屏 maximize
///（不调用 NSWindow zoom:，那在 WKWebView 下不会自动放大，且语义偏 Win 风格）。
///
/// work_area 由 `available_monitors` 取，与 NSWindow.visibleFrame 同语义。
pub(crate) fn current_monitor_for_window(
    window: &tauri::WebviewWindow,
) -> Option<tauri::Monitor> {
    let pos = window.outer_position().ok()?;
    let monitors = window.available_monitors().ok()?;
    // 优先匹配窗口中心所在屏（窗口跨屏时取主屏兜底）
    let size = window.outer_size().ok()?;
    let cx = pos.x + (size.width as i32) / 2;
    let cy = pos.y + (size.height as i32) / 2;
    monitors
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
        })
        .or_else(|| window.primary_monitor().ok().flatten())
}
