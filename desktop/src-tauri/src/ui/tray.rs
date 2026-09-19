//! 系统托盘模块。
//!
//! 菜单构建、模式切换重启、标题栏形态切换、重启流程编排。
//! 迁移自 lib.rs 功能区域（tray）。

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::runtime::state::{DshState, MODE_ADVANCED, MODE_COMPAT};
use crate::runtime::error::SpawnError;
use crate::process::lifecycle::spawn_dsh;
use crate::network::web_token::clear_web_token;
use crate::ui::pet::toggle_pet;
use crate::{
    show_main, set_status, show_notification,
    stop_port_owner, wait_ready_and_navigate,
    STATUS_RESTARTING,
};
use crate::settings::{configured_profile, port_for_profile};

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
    // PROFILE 窗口分组（#89 定稿 A）：运行中点击聚焦、未运行点击开新窗（每 profile 至多一窗）
    let mut sub = tauri::menu::SubmenuBuilder::with_id(app, "profile-windows", "PROFILE 窗口");
    for info in crate::profiles::scan_profiles() {
        let port = port_for_profile(&info.name);
        let running = crate::process::lifecycle::port_open(port);
        let id = format!("open-profile-{}", info.name);
        let text = if running {
            format!("● {} · {}（点击聚焦）", info.name, port)
        } else {
            format!("在新窗口打开 {}", info.name)
        };
        sub = sub.text(&id, &text);
    }
    let profile_sub = sub
        .text("new-profile", "新建 Profile…")
        .text("migrate-profile", "迁移 Profile…")
        .build()?;
    let toggle = MenuItem::with_id(app, "toggle-mode", toggle_label, true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启 dsh 服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DeepSeek Harness Desktop", true, None::<&str>)?;
    Ok(Menu::with_items(app, &[&show, &pet, &profile_sub, &restart, &toggle, &quit])?)
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
            id if id.starts_with("open-profile-") => {
                let name = id.strip_prefix("open-profile-").unwrap_or("").to_string();
                crate::ui::multiwin::open_profile_window(app, &name);
            }
            "new-profile" => crate::profiles::create_profile_flow(app),
            "migrate-profile" => crate::profiles::migrate_profile_flow(app),
            "toggle-mode" => toggle_desktop_mode(app),
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
/// 按接入模式套用窗口标题栏（通用版：主窗/次窗共用）。
pub fn apply_titlebar_for(window: &tauri::WebviewWindow, advanced: bool) {
    #[cfg(target_os = "macos")]
    {
        let style = if advanced {
            tauri::TitleBarStyle::Overlay
        } else {
            tauri::TitleBarStyle::Visible
        };
        if let Err(e) = window.set_title_bar_style(style) {
            log::warn!("切换窗口标题栏样式失败：{e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Err(e) = window.set_decorations(!advanced) {
        log::warn!("切换窗口标题栏失败：{e}");
    }
}

pub fn apply_titlebar(app: &AppHandle, advanced: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    apply_titlebar_for(&w, advanced);
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
        .filter(|u| u != "about:blank")
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
    log::info!("[restart] navigate_to_loading: url = {url}");
    if let Ok(u) = url.parse::<tauri::Url>() {
        if let Err(e) = w.navigate(u) {
            log::warn!("[restart] 导航回加载页失败：{e}");
        } else {
            log::info!("[restart] navigate 成功");
        }
    } else if let Err(e) = w.eval(&format!("window.location.replace({url:?});")) {
        log::warn!("[restart] 导航回加载页失败：{e}");
    } else {
        log::info!("[restart] eval navigate 成功");
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
    log::logger().flush();
    set_status(app, STATUS_RESTARTING, &format!("重启中（{mode_name}）"));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 0) 立即回到启动加载页，然后 kill 旧实例、拉起新实例
        navigate_to_loading(&handle);
        log::logger().flush();

        let profile = configured_profile();
        let port = port_for_profile(&profile);
        // 1) 停掉占用端口的现有 dsh（含自家子进程与外部实例，纯代码）
        if let Some(mut child) = handle.state::<DshState>().child.lock().unwrap().take() {
            let pid = child.id();
            log::info!("[restart] 停止自管 dsh 子进程（PID {pid}）");
            let _ = child.kill();
            log::logger().flush();
            let _ = child.wait();
            log::info!("[restart] 旧 dsh 已退出");
        }
        // 实例台账（#86）：旧实例已停，摘除记录（新 spawn 会重新登记）
        crate::runtime::instances::remove_instance(&profile);
        let freed = stop_port_owner(port).await;
        if !freed {
            log::error!("[restart] 端口 {port} 未能停用/释放，重启中止");
            show_notification(&handle, "DeepSeek Harness Desktop · 重启失败", &format!("端口 {port} 仍被占用"));
            handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
            return;
        }
        // 保险丝（#58）：隔离是持久化变更（写 patch 文件），切模式/手动重启
        // **不**自动恢复——恢复只能从插件保险丝面板手动触发（#61 实测反馈：
        // 切兼容模式后已隔离的插件被恢复导致再次报错）。
        // 重试预算清零：手动重启代表新的启动周期
        handle
            .state::<DshState>()
            .fuse_retries
            .store(0, Ordering::SeqCst);
        // 2) 按目标模式拉起（高级=注入局部拖拽 chrome；兼容=标准布局 + 原生标题栏）
        // 先清旧 token：新实例 token 必然不同，残留会误导宽限窗口内的导航
        clear_web_token(&handle);
        let advanced = target_mode == MODE_ADVANCED;
        match spawn_dsh(&handle, &profile, port, advanced) {
            Ok(child) => {
                log::logger().flush();
                log::info!("[restart] 新 dsh 子进程已启动（PID {}）", child.id());
                *handle.state::<DshState>().child.lock().unwrap() = Some(child);
                handle.state::<DshState>().spawned_this_run.store(true, Ordering::SeqCst);
                handle.state::<DshState>().mode.store(target_mode, Ordering::SeqCst);
                // 重启即回到启动期（#71）：新实例就绪前守护器让位、保险丝接管
                handle.state::<DshState>().ready_once.store(false, Ordering::SeqCst);
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
        // .await 保持 restarting=true 直到导航完成，watchdog 见此标志跳过不干扰。
        // 加 60s 超时防死锁：dsh 起不来时不会永远卡住。
        let nav_handle = handle.clone();
        log::info!("[restart] 开始等待 dsh 就绪并导航...");
        log::logger().flush();
        let nav_result = tokio::time::timeout(
            Duration::from_secs(60),
            wait_ready_and_navigate(nav_handle, port, nport, ntoken),
        ).await;
        if nav_result.is_err() {
            log::warn!("[restart] 等待 dsh 就绪 60s 超时，restarting 复位，交由 watchdog 接管");
        } else {
            log::info!("[restart] wait_ready_and_navigate 已返回");
        }
        handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
        log::logger().flush();
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
