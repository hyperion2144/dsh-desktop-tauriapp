//! 系统托盘模块。
//!
//! 菜单构建、模式切换重启、标题栏形态切换、重启流程编排。
//! 迁移自 lib.rs 功能区域（tray）。

use std::sync::atomic::Ordering;

use tauri::{
    menu::{Menu, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::runtime::state::{DshState, MODE_ADVANCED, MODE_COMPAT};
use crate::runtime::error::SpawnError;
use crate::settings::{load_desktop_settings, configured_port};
use crate::process::lifecycle::spawn_dsh;
use crate::network::web_token::clear_web_token;
use crate::ui::pet::toggle_pet;
use crate::{
    show_main, set_status, show_notification, app_port,
    scan_profiles, switch_profile, create_profile_flow, remote_display,
    select_remote, add_remote_flow, remove_remote_flow, set_port_flow,
    open_proxy_settings, stop_port_owner, wait_ready_and_navigate,
    STATUS_RESTARTING,
};

/// 按当前接入模式构建托盘菜单（含「切换模式」项，标签显示当前模式）。
pub fn tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let advanced = app.state::<DshState>().mode.load(Ordering::SeqCst) == MODE_ADVANCED;
    let toggle_label = if advanced {
        "切换为兼容模式（标准布局）"
    } else {
        "切换为高级模式（桌面界面）"
    };
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let pet = MenuItem::with_id(app, "pet", "显示/隐藏桌宠", true, None::<&str>)?;
    let settings = load_desktop_settings();
    let active_remote = settings.remote_addr.clone();
    let port = configured_port();

    // dsh 服务地址 ▸（标签用展示名 host[:port]，完整 URL 里的 token 不进菜单）
    let local_label = if active_remote.is_none() { "✓ 本地".to_string() } else { "本地".to_string() };
    let local_item = MenuItem::with_id(app, "remote:local", local_label, true, None::<&str>)?;
    let mut remote_builder = SubmenuBuilder::new(app, "dsh 服务地址");
    remote_builder = remote_builder.item(&local_item);
    for addr in &settings.remote_list {
        let display = remote_display(addr);
        let label = if active_remote.as_deref() == Some(addr) {
            format!("✓ {display}")
        } else {
            display
        };
        // 菜单 id 仍携带完整地址（URL 或旧格式），选中/删除按原值匹配
        let item = MenuItem::with_id(app, format!("remote-set:{addr}"), label, true, None::<&str>)?;
        remote_builder = remote_builder.item(&item);
    }
    remote_builder = remote_builder.separator();
    let add_item = MenuItem::with_id(app, "remote-add", "新增地址…", true, None::<&str>)?;
    remote_builder = remote_builder.item(&add_item);
    if !settings.remote_list.is_empty() {
        let mut del_builder = SubmenuBuilder::new(app, "删除地址");
        for addr in &settings.remote_list {
            let item = MenuItem::with_id(app, format!("remote-del:{addr}"), remote_display(addr), true, None::<&str>)?;
            del_builder = del_builder.item(&item);
        }
        remote_builder = remote_builder.items(&[&del_builder.build()?]);
    }
    let remote_menu = remote_builder.build()?;

    // Profile ▸
    let mut profile_builder = SubmenuBuilder::new(app, "Profile");
    for p in scan_profiles() {
        let label = if p.active { format!("✓ {}", p.name) } else { p.name.clone() };
        let item = MenuItem::with_id(app, format!("profile:{}", p.name), label, p.selectable, None::<&str>)?;
        profile_builder = profile_builder.item(&item);
    }
    profile_builder = profile_builder.separator();
    let new_profile = MenuItem::with_id(app, "new-profile", "新建 Profile…", true, None::<&str>)?;
    profile_builder = profile_builder.item(&new_profile);
    let profile_menu = profile_builder.build()?;

    let port_item = MenuItem::with_id(app, "set-port", format!("本地端口… {port}"), true, None::<&str>)?;

    // 代理设置菜单项：标签显示当前代理模式
    let proxy_mode_label = match settings.proxy_mode.as_deref() {
        Some("system") => "继承系统代理",
        Some("manual") => "手动代理",
        _ => "直连",
    };
    let proxy_item = MenuItem::with_id(app, "proxy-settings", format!("代理设置…（{proxy_mode_label}）"), true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-mode", toggle_label, true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启 dsh 服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DeepSeek Harness Desktop", true, None::<&str>)?;
    Ok(Menu::with_items(
        app,
        &[&show, &pet, &remote_menu, &profile_menu, &port_item, &proxy_item, &restart, &toggle, &quit],
    )?)
}

/// 刷新托盘「切换模式」标签（模式切换/重启后调用）。
pub fn refresh_tray_mode(app: &AppHandle) {
    let state = app.state::<DshState>();
    if let Ok(menu) = tray_menu(app) {
        if let Some(tray) = state.tray.lock().unwrap().as_ref() {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// 构建菜单栏托盘：左键显示窗口，菜单提供显示/隐藏桌宠/切换模式/重启/退出。
pub fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = tray_menu(app.handle())?;
    // 托盘专用图标：从 64x64 PNG（macOS 菜单栏 32pt @2x = 64px 甜点尺寸）加载，
    // 优先用 include_bytes 编译期嵌入；加载失败回退 default_window_icon。
    // DeepSeek Harness 图标本身有颜色，不当模板图（icon_as_template=false）。
    let icon: tauri::image::Image<'_> = tauri::image::Image::from_bytes(include_bytes!("../../icons/64x64.png"))
        .ok()
        .map(tauri::image::Image::to_owned)
        .map(tauri::image::Image::into)
        .unwrap_or_else(|| {
            app.default_window_icon()
                .expect("缺少应用图标")
                .clone()
        });
    TrayIconBuilder::with_id("dsh-tray")
        .icon(icon)
        .icon_as_template(false)
        .tooltip("DeepSeek Harness Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "pet" => toggle_pet(app),
            "restart" => restart_dsh(app),
            "toggle-mode" => toggle_desktop_mode(app),
            "remote:local" => select_remote(app, None),
            "remote-add" => add_remote_flow(app),
            "new-profile" => create_profile_flow(app),
            "set-port" => set_port_flow(app),
            "proxy-settings" => open_proxy_settings(app),
            id if id.starts_with("profile:") => {
                switch_profile(app, &id["profile:".len()..]);
            }
            id if id.starts_with("remote-set:") => {
                select_remote(app, Some(id["remote-set:".len()..].to_string()));
            }
            id if id.starts_with("remote-del:") => {
                remove_remote_flow(app, &id["remote-del:".len()..]);
            }
            "quit" => {
                app.state::<DshState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map(|tray| {
            *app.state::<DshState>().tray.lock().unwrap() = Some(tray);
        })?;
    Ok(())
}

/// 按接入模式应用主窗口标题栏形态（首次启动、启动页选择、托盘切换都会调用，
/// 不只在 setup 里生效）。
/// - 高级：macOS Overlay（保留红绿灯 + 自绘拖拽区）；Windows/Linux 隐藏原生标题栏（自绘 caption 行）；
/// - 兼容：macOS Visible（系统原生标题栏）；Windows/Linux 恢复原生标题栏。
pub fn apply_titlebar(app: &AppHandle, advanced: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    #[cfg(target_os = "macos")]
    {
        let style = if advanced {
            tauri::TitleBarStyle::Overlay
        } else {
            tauri::TitleBarStyle::Visible
        };
        if let Err(e) = w.set_title_bar_style(style) {
            log::warn!("切换主窗口标题栏样式失败：{e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Err(e) = w.set_decorations(!advanced) {
        log::warn!("切换主窗口标题栏失败：{e}");
    }
}

/// 回到内嵌启动加载页（重启/切换模式时，像重启应用一样先回到加载界面）。
pub fn navigate_to_loading(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let url = app
        .state::<DshState>()
        .loading_url
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| {
            #[cfg(target_os = "windows")]
            {
                "http://tauri.localhost/index.html".to_string()
            }
            #[cfg(not(target_os = "windows"))]
            {
                "tauri://localhost/index.html".to_string()
            }
        });
    if let Ok(u) = url.parse::<tauri::Url>() {
        if let Err(e) = w.navigate(u) {
            log::warn!("导航回加载页失败：{e}");
        }
    } else if let Err(e) = w.eval(&format!("window.location.replace({url:?});")) {
        log::warn!("导航回加载页失败：{e}");
    }
}

/// 重启/切换接入模式（都先回到启动加载页，再停旧实例、按目标模式拉起、重新进入）。
/// target_mode = MODE_ADVANCED / MODE_COMPAT。
/// 通知服务器在 setup 阶段就已启动并常驻，重启时复用同一端口/token。
pub fn restart_dsh_in_mode(app: &AppHandle, target_mode: u8) {
    let state = app.state::<DshState>();
    if state.restarting.swap(true, Ordering::SeqCst) {
        log::warn!("已在重启/切换中，忽略重复触发");
        return;
    }
    let mode_name = if target_mode == MODE_ADVANCED { "高级" } else { "兼容" };
    log::info!("[restart] 进入{mode_name}模式：回到加载页并重启 dsh 服务");
    set_status(app, STATUS_RESTARTING, &format!("重启中（{mode_name}）"));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 0) 回到启动加载页（像重启一样）
        navigate_to_loading(&handle);
        let port = app_port();
        // 1) 停掉占用端口的现有 dsh（含自家子进程与外部实例，纯代码）
        if let Some(mut child) = handle.state::<DshState>().child.lock().unwrap().take() {
            let pid = child.id();
            log::info!("[restart] 停止自管 dsh 子进程（PID {pid}）");
            let _ = child.kill();
            let _ = child.wait();
            log::info!("[restart] 旧 dsh 已退出");
        }
        let freed = stop_port_owner(port).await;
        if !freed {
            log::error!("[restart] 端口 {port} 未能停用/释放，重启中止");
            show_notification(&handle, "DeepSeek Harness Desktop · 重启失败", &format!("端口 {port} 仍被占用"));
            handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
            return;
        }
        // 2) 按目标模式拉起（高级=注入局部拖拽 chrome；兼容=标准布局 + 原生标题栏）
        // 先清旧 token：新实例 token 必然不同，残留会误导宽限窗口内的导航
        clear_web_token(&handle);
        let advanced = target_mode == MODE_ADVANCED;
        match spawn_dsh(&handle, port, advanced) {
            Ok(child) => {
                log::info!("[restart] 新 dsh 子进程已启动（PID {}）", child.id());
                *handle.state::<DshState>().child.lock().unwrap() = Some(child);
                handle.state::<DshState>().spawned_this_run.store(true, Ordering::SeqCst);
                handle.state::<DshState>().mode.store(target_mode, Ordering::SeqCst);
                apply_titlebar(&handle, advanced);
            }
            Err(e) => {
                let msg = match &e {
                    SpawnError::NotFound(s) | SpawnError::Other(s) => s.clone(),
                };
                log::error!("[restart] spawn 失败：{msg}");
                show_notification(&handle, "DeepSeek Harness Desktop · 重启失败", &format!("spawn 失败：{msg}"));
                handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
                return;
            }
        }
        // 3) 重置失败标志并等待就绪 + 重新导航（按目标模式生成 URL）
        handle.state::<DshState>().spawn_failed.store(false, Ordering::SeqCst);
        let nport = handle.state::<DshState>().notify_port.load(Ordering::SeqCst);
        let ntoken = handle.state::<DshState>().notify_token.lock().unwrap().clone();
        wait_ready_and_navigate(handle.clone(), port, nport, ntoken).await;
        handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
        // 4) 刷新托盘「切换模式」标签
        refresh_tray_mode(&handle);
        log::info!("[restart] {mode_name}模式启动完成");
    });
}

/// 托盘「重启 dsh 服务」：在当前模式下重启。
pub fn restart_dsh(app: &AppHandle) {
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode);
}

/// 托盘「切换模式」：兼容 <-> 高级（切换后重启对应的 dsh web）。
pub fn toggle_desktop_mode(app: &AppHandle) {
    let cur = app.state::<DshState>().mode.load(Ordering::SeqCst);
    let next = if cur == MODE_ADVANCED { MODE_COMPAT } else { MODE_ADVANCED };
    restart_dsh_in_mode(app, next);
}
