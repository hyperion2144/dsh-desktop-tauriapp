//! 平台外链打开等平台特定工具。
//!
//! 迁移自 lib.rs 功能区域（platform）。
//! 设计决策 #46：PlatformService 不 trait 化（编译期 cfg）。
/// 在系统默认浏览器/应用中打开外链（三平台：macOS `open`、Windows `cmd start`、
/// Linux `xdg-open`）。仅允许 http/https/mailto/tel，避免命令注入。
/// 由 dsh-desktop-tauriapp 插件 client 在 webview 里拦截外链点击后调用。
#[tauri::command]
pub(crate) fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:")
        || url.starts_with("tel:"))
    {
        return Err(format!("不允许打开的链接协议：{url}"));
    }
    let ok = open_external_impl(&url);
    if ok {
        log::info!("已在系统默认应用中打开：{url}");
        Ok(())
    } else {
        Err(format!("打开链接失败：{url}"))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn open_external_impl(url: &str) -> bool {
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
pub(crate) fn open_external_impl(url: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // 走 ShellExecuteW（系统 Shell 按协议路由到默认浏览器/邮件客户端），不用
    // cmd start：cmd 会把 URL 里的 & 当命令分隔符，且 Rust Command 对含引号参数
    // 会二次转义，导致 URL 被搞坏、静默打不开。ShellExecuteW 返回值 >32 表示成功。
    let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    (result as isize) > 32
}

#[cfg(target_os = "linux")]
pub(crate) fn open_external_impl(url: &str) -> bool {
    std::process::Command::new("xdg-open")
        .arg(url)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
