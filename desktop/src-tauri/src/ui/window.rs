//! 窗口操作：显示/隐藏主窗、错误页跳转、显示器匹配。

use tauri::{AppHandle, Manager};

use crate::network::notify::show_notification;

/// 在当前启动页上注入错误提示（红色横幅 + 状态文本变色），保留 dsh 控制台输出不动。
/// 不导航到 error.html——桌面壳只有启动页和 dsh Web GUI 两个页面。
pub(crate) fn show_error(app: &AppHandle, reason: &str) {
    let detail = match reason {
        "not-found" => "未找到 dsh 命令。请先执行 npm i -g @deepseek-ai/dsh，或设置 DSH_BIN 环境变量。",
        "spawn-failed" => "dsh 进程启动失败，请查看下方日志输出。",
        "boot-failed" => "dsh 启动反复失败（插件不兼容或环境异常），已按保险丝策略处理。请查看下方日志输出。",
        "timeout" => "等待本地服务就绪超时，请查看下方日志输出并重试。",
        _ => "未知错误，请查看下方日志输出。",
    };
    if let Some(w) = app.get_webview_window("main") {
        let safe = detail.replace('\\', "\\\\").replace('\'', "\\'");
        let js = format!(
            "(function(){{var s=document.getElementById('status');if(s){{s.textContent='{safe}';s.style.color='#ef4444';}}if(!document.getElementById('dsh-err-banner')){{var b=document.createElement('div');b.id='dsh-err-banner';b.style.cssText='position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;padding:12px 24px;font-size:14px;font-family:system-ui,sans-serif;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.3)';b.textContent='启动失败：{safe}';document.body.prepend(b);}}}})();"
        );
        let _ = w.eval(&js);
    }
    show_notification(app, "DeepSeek Harness Desktop 启动失败", detail);
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
