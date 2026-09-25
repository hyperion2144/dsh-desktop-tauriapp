//! 系统托盘模块。
//!
//! 菜单构建、模式切换重启、标题栏形态切换、重启流程编排、运行时版本切换（#98）。
//! 迁移自 lib.rs 功能区域（tray）。

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::runtime::state::{DshState, MODE_ADVANCED, MODE_COMPAT};
use crate::runtime::builtin::DshMode;
use crate::runtime::error::SpawnError;
use crate::process::lifecycle::spawn_dsh;
use crate::network::web_token::clear_web_token;
use crate::ui::pet::toggle_pet;
use crate::{
    show_main, set_status, show_notification,
    stop_port_owner, wait_ready_and_navigate,
    STATUS_STARTING,
};
use crate::settings::{configured_profile, load_desktop_settings, port_for_profile};
/// 托盘运行时目录缓存（build_tray 后异步拉取；static 免动 DshState 三处构造点）。
/// (version, channel) 列表；None = 尚未拉取过（菜单仅显示本地 内置+已装 部分）。
static RUNTIME_CATALOG: std::sync::Mutex<Option<Vec<(String, String)>>> =
    std::sync::Mutex::new(None);

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
    // 切换 Profile 分组（#117）：在当前聚焦窗口内就地切换（与上面「在新窗口打开」的区别：不新建窗）
    let mut ssub =
        tauri::menu::SubmenuBuilder::with_id(app, "switch-profile-menu", "切换 Profile（本窗口）");
    for info in crate::profiles::scan_profiles() {
        let port = port_for_profile(&info.name);
        let running = crate::process::lifecycle::port_open(port);
        let id = format!("switch-profile-{}", info.name);
        let text = if running {
            format!("{} · {}（运行中）", info.name, port)
        } else {
            format!("{} · {}", info.name, port)
        };
        ssub = ssub.text(&id, &text);
    }
    let switch_sub = ssub.build()?;
    // 运行时版本子菜单（#98）：内置 + 已装即时列出（本地数据）；目录未装项经异步缓存补充。
    let builtin_ver = crate::runtime::registry::builtin_version(app);
    let installed = crate::runtime::registry::list_installed(app);
    let selected = crate::settings::load_desktop_settings().dsh_runtime;
    let dl = {
        let st = crate::runtime::registry::runtime_download_status();
        let active = st.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
        if active {
            st.get("version").and_then(|v| v.as_str()).map(String::from)
        } else {
            None
        }
    };
    let catalog = RUNTIME_CATALOG.lock().unwrap().clone();
    let mut rsub = tauri::menu::SubmenuBuilder::with_id(app, "runtime-menu", "运行时版本");
    for (id, text) in runtime_menu_items(
        builtin_ver.as_deref(),
        &installed,
        selected.as_deref(),
        catalog.as_deref(),
        dl.as_deref(),
        // #126：来源决定 ● 落点；外部可用性决定是否列出「外部 dsh」条目
        crate::runtime::builtin::configured_dsh_mode(),
        crate::runtime::builtin::find_external_bin().is_some(),
    ) {
        rsub = rsub.text(&id, &text);
    }
    let runtime_sub = rsub
        .separator()
        .text("runtime-more", "更多版本（设置页）…")
        .build()?;
    let toggle = MenuItem::with_id(app, "toggle-mode", toggle_label, true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启 dsh 服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DeepSeek Harness Desktop", true, None::<&str>)?;
    Ok(Menu::with_items(
        app,
        &[
            &show,
            &pet,
            &profile_sub,
            &switch_sub,
            &runtime_sub,
            &restart,
            &toggle,
            &quit,
        ],
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
            id if id.starts_with("open-profile-") => {
                let name = id.strip_prefix("open-profile-").unwrap_or("").to_string();
                crate::ui::multiwin::open_profile_window(app, &name);
            }
            id if id.starts_with("switch-profile-") => {
                let name = id.strip_prefix("switch-profile-").unwrap_or("").to_string();
                // 「本窗口」= 当前聚焦窗口（无聚焦则主窗）；桌宠窗不参与
                let label = crate::ui::multiwin::focused_window_label(app);
                crate::ui::multiwin::switch_profile_in_window(app, &label, &name);
            }
            "runtime-builtin" => switch_runtime(app, None, DshMode::Builtin),
            "runtime-external" => switch_runtime(app, None, DshMode::External),
            "runtime-more" => {
                spawn_fetch_catalog(app);
                show_main(app);
            }
            id if id.starts_with("runtime-switch-") => {
                let ver = id.strip_prefix("runtime-switch-").unwrap_or("").to_string();
                switch_runtime(app, Some(&ver), DshMode::Builtin);
            }
            id if id.starts_with("runtime-fetch-") => {
                let ver = id.strip_prefix("runtime-fetch-").unwrap_or("").to_string();
                fetch_runtime_and_switch(app, ver);
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
    // #98：托盘就绪后异步拉取运行时目录（失败静默，菜单先显示本地 内置+已装）
    spawn_fetch_catalog(app.handle());
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
pub fn restart_dsh_in_mode(app: &AppHandle, target_mode: u8, profile_override: Option<&str>) {
    let profile_override = profile_override.map(|s| s.to_string());
    // #136 远程模式：服务来源是远程 dsh——不 kill/不 spawn 本地实例，
    // 回加载页稍作停留后直接导航远程（与冷启动远程路径同语义）。
    // 切回本地（remote_addr=None）后自然恢复原有本地重启流程。
    if let Some(addr) = load_desktop_settings().remote_addr {
        log::info!("[restart] 远程模式：回到加载页并导航远程（不拉本地实例）");
        set_status(app, STATUS_STARTING, "启动中（远程）");
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            navigate_to_loading(&handle);
            tokio::time::sleep(Duration::from_millis(300)).await;
            crate::network::remote::navigate_remote(&handle, &addr, target_mode == MODE_ADVANCED);
            refresh_tray_mode(&handle);
        });
        return;
    }
    let mode_name = if target_mode == MODE_ADVANCED { "高级" } else { "兼容" };
    log::info!("[restart] 进入{mode_name}模式：回到加载页并重启 dsh 服务");
    log::logger().flush();
    set_status(app, STATUS_STARTING, &format!("启动中（重启：{mode_name}）"));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 0) 立即回到启动加载页，然后 kill 旧实例、拉起新实例
        navigate_to_loading(&handle);
        log::logger().flush();

        let profile = profile_override.clone().unwrap_or_else(configured_profile);
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
            return;
        }
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
                // 重启即回到启动期（#71）：新实例就绪前守护器让位
                handle.state::<DshState>().ready_once.store(false, Ordering::SeqCst);
                apply_titlebar(&handle, advanced);
            }
            Err(e) => {
                let msg = match &e {
                    SpawnError::NotFound(s) | SpawnError::Other(s) => s.clone(),
                };
                log::error!("[restart] spawn 失败：{msg}");
                show_notification(&handle, "DeepSeek Harness Desktop · 重启失败", &format!("spawn 失败：{msg}"));
                return;
            }
        }
        // 3) 重置失败标志并等待就绪 + 重新导航（按目标模式生成 URL）
        let nport = handle.state::<DshState>().notify_port.load(Ordering::SeqCst);
        let ntoken = handle.state::<DshState>().notify_token.lock().unwrap().clone();
        // #126 验证反馈：重启/切换必须马上生效——restarting 只保护上面 kill/spawn
        // 临界区（毫秒级），此处立即释放；就绪等待期间托盘随时可再次触发：
        // 立刻停掉当前实例、按最新设置拉新的（无需任何状态检测）。
        // 等待本身不设超时（对齐首次启动的产品语义：输出持续上屏，
        // spawn_failed/quitting 时自动返回），也不再长期霸占互斥闸。
        log::info!("[restart] 开始等待 dsh 就绪并导航...");
        log::logger().flush();
        wait_ready_and_navigate(handle.clone(), port, nport, ntoken).await;
        log::info!("[restart] wait_ready_and_navigate 已返回");
        log::logger().flush();
        // 4) 刷新托盘「切换模式」标签
        refresh_tray_mode(&handle);
        log::info!("[restart] {mode_name}模式启动完成");
    });
}

/// 托盘「重启 dsh 服务」：在当前模式下重启。
pub fn restart_dsh(app: &AppHandle) {
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode, None);
}

/// 托盘「切换模式」：兼容 <-> 高级（切换后重启对应的 dsh web）。
pub fn toggle_desktop_mode(app: &AppHandle) {
    let cur = app.state::<DshState>().mode.load(Ordering::SeqCst);
    let next = if cur == MODE_ADVANCED { MODE_COMPAT } else { MODE_ADVANCED };
    restart_dsh_in_mode(app, next, None);
}

/// 托盘切换运行时（#98 / #126）：保存来源（内置 / 外部）+ 内置来源下的版本选择，
/// 随后重启 dsh 生效；重启流程尾部会刷新托盘。
/// - `version`：内置来源下选中的已下载版本（None = 随包内置树）；来源为 external 时忽略
/// - `mode`：目标来源（#126 D1：切到 external 不动 dsh_runtime，切回内置可恢复上次选择）
pub fn switch_runtime(app: &AppHandle, version: Option<&str>, mode: DshMode) {
    let mut s = crate::settings::load_desktop_settings();
    if mode == DshMode::Builtin {
        s.dsh_runtime = version.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    }
    s.dsh_mode = Some(mode.as_str().into());
    if let Err(e) = crate::settings::save_desktop_settings(&s) {
        log::error!("[tray] 保存运行时设置失败：{e}");
        show_notification(app, "运行时切换失败", &e);
        return;
    }
    // 文案：外部来源没有版本号，直接用来源名；内置来源沿用版本号 /「内置版本」
    let label = match mode {
        DshMode::External => "外部 dsh".to_string(),
        DshMode::Builtin => {
            format!("dsh {}", s.dsh_runtime.clone().unwrap_or_else(|| "内置版本".into()))
        }
    };
    show_notification(app, "运行时已切换", &format!("{label}，正在重启服务…"));
    restart_dsh(app);
    // 重启完成后再补一条终态（用户实测反馈：点击后不知道啥时候成功/重启）
    notify_when_ready(app, label);
}

/// 托盘「下载并切换」（#98）：下载安装（registry 单飞行防并发）→ 自动切换重启。
/// 进度经系统通知反馈（托盘无进度条，详细进度在设置页）。
fn fetch_runtime_and_switch(app: &AppHandle, version: String) {
    let st = crate::runtime::registry::runtime_download_status();
    if st.get("active").and_then(|v| v.as_bool()).unwrap_or(false) {
        let cur = st.get("version").and_then(|v| v.as_str()).unwrap_or("?");
        show_notification(app, "运行时下载中", &format!("正在下载 dsh {cur}，完成后可在托盘切换"));
        return;
    }
    show_notification(app, "开始下载运行时", &format!("dsh {version} 安装中，完成后自动切换并重启"));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let src = crate::settings::load_desktop_settings()
            .runtime_source
            .unwrap_or_else(|| "github".into());
        spawn_download_progress_notifier(&handle, version.clone());
        match crate::runtime::registry::download_and_install(&handle, &version).await {
            Ok(()) => {
                crate::runtime::registry::record_installed(
                    &handle,
                    crate::runtime::registry::InstalledRuntime {
                        version: version.clone(),
                        source: src,
                        installed_at: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    },
                );
                refresh_tray_mode(&handle);
                switch_runtime(&handle, Some(&version), DshMode::Builtin);
            }
            Err(e) => {
                log::error!("[tray] 运行时 {version} 下载失败：{e}");
                show_notification(&handle, "运行时下载失败", &e);
            }
        }
    });
}

/// 异步拉取运行时目录进缓存并刷新托盘（build_tray 后一次；「更多版本」点击时重拉）。
/// 失败仅记日志——菜单仍显示本地 内置+已装 部分。
pub fn spawn_fetch_catalog(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let s = crate::settings::load_desktop_settings();
        let src = s.runtime_source.unwrap_or_else(|| "github".into());
        match crate::runtime::registry::fetch_catalog(&src, s.runtime_github_repo.as_deref()).await {
            Ok(entries) => {
                *RUNTIME_CATALOG.lock().unwrap() =
                    Some(entries.into_iter().map(|e| (e.version, e.channel)).collect());
                refresh_tray_mode(&handle);
            }
            Err(e) => log::warn!("[tray] 运行时目录拉取失败（菜单仅显示本地已装）：{e}"),
        }
    });
}


/// 下载进度通知泵（#98 实测反馈补）：轮询 registry 进度，节流（≥15s 且数字变化）发系统通知，
/// 下载结束（连续两轮 inactive，容忍置位竞态）自动退出；成败终态由 fetch 流程负责，不重复。
fn spawn_download_progress_notifier(app: &AppHandle, version: String) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_at = std::time::Instant::now();
        let mut last_nums = (0u64, 0u64, 0u64);
        let mut idle = 0u8;
        // 上限 ~10 分钟（3s × 200），覆盖最大依赖树下载
        for _ in 0..200 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let st = crate::runtime::registry::runtime_download_status();
            let active = st.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
            if !active {
                idle += 1;
                if idle >= 2 {
                    break;
                }
                continue;
            }
            idle = 0;
            let num = |k: &str| st.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
            let nums = (num("resolved"), num("downloaded"), num("added"));
            if nums != last_nums && last_at.elapsed() >= Duration::from_secs(15) {
                show_notification(
                    &handle,
                    "运行时下载中",
                    &format!("dsh {version}：解析 {} · 下载 {} · 安装 {} 个包", nums.0, nums.1, nums.2),
                );
                last_at = std::time::Instant::now();
                last_nums = nums;
            }
        }
    });
}

/// 切换后等服务就绪并弹终态（#98 实测反馈补）：见到过「非就绪」再见到 READY 才提示
/// 完成（防误读切换前旧状态）；90s 未就绪静默放弃（失败原因已流式上屏）。
fn notify_when_ready(app: &AppHandle, label: String) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut saw_pending = false;
        for _ in 0..90 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let state = handle.state::<DshState>();
            if state.status.load(Ordering::SeqCst) != crate::runtime::state::STATUS_READY {
                saw_pending = true;
                continue;
            }
            if saw_pending {
                show_notification(&handle, "运行时切换完成", &format!("✅ {label} 已启动"));
            }
            return;
        }
        log::warn!("[restart] 等待运行时 {label} 就绪超时（90s），放弃完成通知");
    });
}

/// 单选标记（#126）：● 当前生效 / ○ 其余。
fn radio(on: bool) -> &'static str {
    if on { "● " } else { "○ " }
}

/// 生成「运行时版本」子菜单条目（纯函数，单测锁定语义）。
/// 返回 (id, text)：内置项 +「外部 dsh」项（#126：与内置同级单选，探测不到就不列）
/// + 已装项（● 当前选中 / ○ 其余，与内置同号去重）
/// + 目录未装项（↓ 下载并切换，至多 5 条，下载中标注）。
/// `mode` 为当前来源：external 时 ● 只落外部项，内置/已装项一律 ○
/// （#126 D1：external 下 dsh_runtime 仍保留，只是不生效）。
pub(crate) fn runtime_menu_items(
    builtin: Option<&str>,
    installed: &[crate::runtime::registry::InstalledRuntime],
    selected: Option<&str>,
    catalog: Option<&[(String, String)]>,
    downloading: Option<&str>,
    mode: DshMode,
    external_available: bool,
) -> Vec<(String, String)> {
    let mut items = Vec::new();
    let sel = selected.filter(|s| !s.is_empty());
    let external_on = mode == DshMode::External;
    let builtin_on = !external_on && (sel.is_none() || sel == builtin);
    let builtin_label = match builtin {
        Some(v) => format!("内置 {v}（随安装包）"),
        None => "内置（随安装包，版本未知）".to_string()
    };
    items.push((
        "runtime-builtin".into(),
        format!("{}{builtin_label}", radio(builtin_on)),
    ));
    // #126：外部 dsh 就是运行时列表里的又一个条目——与已下载版本一样「存在才列出」
    if external_available {
        items.push((
            "runtime-external".into(),
            format!("{}外部 dsh（DSH_BIN / PATH）", radio(external_on)),
        ));
    }
    for inst in installed {
        if Some(inst.version.as_str()) == builtin {
            continue;
        }
        let on = !external_on && sel == Some(inst.version.as_str());
        items.push((
            format!("runtime-switch-{}", inst.version),
            format!("{}{}", radio(on), inst.version),
        ));
    }
    if let Some(cats) = catalog {
        let mut shown = 0;
        for (ver, channel) in cats {
            if shown >= 5 {
                break;
            }
            if Some(ver.as_str()) == builtin || installed.iter().any(|i| i.version == *ver) {
                continue;
            }
            shown += 1;
            let dl = if downloading == Some(ver.as_str()) { "（下载中…）" } else { "" };
            items.push((
                format!("runtime-fetch-{ver}"),
                format!("↓ 下载并切换 {ver}（{channel}）{dl}"),
            ));
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::runtime_menu_items;
    use crate::runtime::builtin::DshMode;
    use crate::runtime::registry::InstalledRuntime;

    fn inst(ver: &str) -> InstalledRuntime {
        InstalledRuntime { version: ver.into(), source: "github".into(), installed_at: 0 }
    }

    /// 既有语义的便利构造：内置来源 + 探测不到外部 dsh（等价于 #126 之前的调用形态）
    fn menu(
        builtin: Option<&str>,
        installed: &[InstalledRuntime],
        selected: Option<&str>,
        catalog: Option<&[(String, String)]>,
        downloading: Option<&str>,
    ) -> Vec<(String, String)> {
        runtime_menu_items(builtin, installed, selected, catalog, downloading, DshMode::Builtin, false)
    }

    #[test]
    fn builtin_default_when_no_selection() {
        let items = menu(Some("0.1.6"), &[inst("0.1.7")], None, None, None);
        assert_eq!(items[0].0, "runtime-builtin");
        assert!(items[0].1.contains("● 内置 0.1.6"));
        assert!(items[1].1.starts_with("○ 0.1.7"));
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn installed_selection_marks_radio() {
        let items = menu(Some("0.1.6"), &[inst("0.1.7")], Some("0.1.7"), None, None);
        assert!(items[0].1.starts_with("○"));
        assert!(items[1].1.starts_with("● 0.1.7"));
    }

    #[test]
    fn catalog_dedupes_and_caps_at_five() {
        // 8 个目录项：0.1.6=内置、0.1.7=已装 去重；其余 6 条截为 5
        let vers = ["0.1.6", "0.1.7", "0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.2.4", "0.3.0"];
        let cats: Vec<(String, String)> =
            vers.iter().map(|v| (v.to_string(), "latest".into())).collect();
        let items = menu(Some("0.1.6"), &[inst("0.1.7")], None, Some(&cats), None);
        let fetch: Vec<_> = items.iter().filter(|(id, _)| id.starts_with("runtime-fetch-")).collect();
        assert_eq!(fetch.len(), 5, "未装目录项应截为 5 条：{items:?}");
        assert!(!fetch.iter().any(|(id, _)| id.contains("0.3.0")), "第 6 条应被截断");
    }

    #[test]
    fn downloading_version_annotated() {
        let cats = vec![("0.2.0".to_string(), "alpha".to_string())];
        let items = menu(None, &[], None, Some(&cats), Some("0.2.0"));
        assert!(items[1].1.contains("下载中"));
        assert!(items[1].1.contains("alpha"));
    }

    // ── #126：外部 dsh 作为运行时列表里的同级条目 ──

    #[test]
    fn external_item_listed_only_when_available() {
        let absent =
            runtime_menu_items(Some("0.1.6"), &[], None, None, None, DshMode::Builtin, false);
        assert!(
            !absent.iter().any(|(id, _)| id == "runtime-external"),
            "探测不到外部 dsh 时不应列出该条目：{absent:?}"
        );

        let present =
            runtime_menu_items(Some("0.1.6"), &[], None, None, None, DshMode::Builtin, true);
        assert_eq!(present[0].0, "runtime-builtin");
        assert_eq!(present[1].0, "runtime-external", "外部条目紧跟内置条目：{present:?}");
        assert!(
            present[1].1.starts_with("○ 外部 dsh"),
            "内置来源下外部应未选中：{:?}",
            present[1]
        );
    }

    #[test]
    fn external_mode_moves_radio_and_clears_builtin() {
        // #126 D1：external 来源下 dsh_runtime 仍保留（切回可恢复），但 ● 只落外部条目
        let items = runtime_menu_items(
            Some("0.1.6"),
            &[inst("0.1.7")],
            Some("0.1.7"),
            None,
            None,
            DshMode::External,
            true,
        );
        let ext = items
            .iter()
            .find(|(id, _)| id == "runtime-external")
            .expect("应有外部条目");
        assert!(ext.1.starts_with("● 外部 dsh"), "external 来源应选中外部条目：{ext:?}");
        assert!(
            items[0].1.starts_with("○ "),
            "external 来源下内置不应带 ●：{:?}",
            items[0]
        );
        let inst_item = items
            .iter()
            .find(|(id, _)| id == "runtime-switch-0.1.7")
            .expect("应有已装条目");
        assert!(
            inst_item.1.starts_with("○ "),
            "external 来源下已下载版本不应带 ●：{inst_item:?}"
        );
    }

    #[test]
    fn builtin_mode_ignores_external_radio() {
        let items =
            runtime_menu_items(Some("0.1.6"), &[], None, None, None, DshMode::Builtin, true);
        assert!(items[0].1.contains("● 内置 0.1.6"));
        assert!(items[1].1.starts_with("○ 外部 dsh"));
    }

    #[test]
    fn external_mode_without_external_bin_shows_no_radio() {
        // #126 D3+D4：来源是 external 但探测不到外部 dsh —— 外部条目不列，
        // 内置/已装也不带 ●（不谎报「内置已选中」）；用户可点内置切回。
        let items = runtime_menu_items(
            Some("0.1.6"),
            &[inst("0.1.7")],
            Some("0.1.7"),
            None,
            None,
            DshMode::External,
            false,
        );
        assert!(
            !items.iter().any(|(id, _)| id == "runtime-external"),
            "探测不到外部 dsh 时不应列出该条目：{items:?}"
        );
        assert!(
            !items.iter().any(|(text, _)| text.starts_with("● ")),
            "无生效条目时不应有任何 ●：{items:?}"
        );
        assert!(items[0].1.starts_with("○ 内置"), "内置应为 ○：{:?}", items[0]);
    }
}
