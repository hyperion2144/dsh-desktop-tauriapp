//! DeepSeek Harness Desktop —— Tauri 2 桌面壳入口。
//!
//! 纯入口聚合：run() + generate_handler! + mod 声明。
//! 各功能区域在独立子模块中实现。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// ── 模块声明（分层目录结构）──────────────────────────────
mod runtime;          // 运行时核心：state / phase / error
mod process;          // 进程管理：lifecycle / probing / plugin
mod network;          // 网络层：proxy / web_token / notify / remote
mod ui;               // 界面层：tray / pet / nav_guard / window
mod navigation;       // 导航逻辑：wait_ready_and_navigate
mod settings;         // 设置读写 + dsh_home + app_port
mod platform;         // 平台特定：open_external
mod commands;         // Tauri command 实现
mod profiles;         // profile 管理
mod download;         // 下载管理器（#72）：model/persist/transfer/manager/commands

// ── 运行时核心导入 ──
use runtime::state::{
    DshState, INTERNAL_HOSTS, set_status,
    MODE_ADVANCED, MODE_COMPAT,
    STATUS_IDLE, STATUS_STARTING, STATUS_READY, STATUS_EXTERNAL,
    STATUS_RESTARTING, STATUS_STALE, STATUS_DOWN, STATUS_REMOTE,
};
use runtime::error::SpawnError;

// ── 进程管理导入 ──
use process::lifecycle::{
    port_open, spawn_dsh, kill_process, kill_process_force,
    listener_pids, stop_port_owner,
};
#[cfg(unix)]
use process::lifecycle::{NativeLifecycle, find_dsh_bin, dsh_runtime_path};

// ── 网络层导入 ──
use network::web_token::{
    parse_web_token_line, store_web_token, clear_web_token,
    exchange_token_for_cookie, seed_session_cookie, session_cookie_accepts,
};
use network::notify::{
    start_notify_server, notify_completed, inject_task_notifier,
    request_notification_permission, show_notification,
};
use network::proxy::inject_proxy_env;
use network::remote::{
    remote_display, remote_host_port,
    select_remote, add_remote_flow, remove_remote_flow, set_port_flow,
    open_proxy_settings, navigate_remote,
};

// ── 界面层导入 ──
use ui::tray::{build_tray, apply_titlebar, restart_dsh_in_mode};
use ui::pet::{read_pet_state, write_pet_state, setup_pet, pet_show_main, pet_hide, pet_quit, pet_toggle_passthrough};
use ui::nav_guard::nav_guard_plugin;
use ui::window::{show_main, show_error};

// ── 导航逻辑导入 ──
use navigation::wait_ready_and_navigate;

// ── 设置/插件/平台/command 导入 ──
use settings::{load_desktop_settings, configured_port, app_port, dsh_home, configured_profile};
use process::plugin::{desktop_plugin_patch_path, materialize_desktop_plugin, strip_web_profile_plugin_bundle};
use process::probing::{probe_local, probe_remote};
use platform::{open_external, open_external_impl};
use commands::{
    toggle_zoom, get_mode_prompt_needed, get_desktop_client_environment,
    log_diag, log_console, get_dsh_status, restart_dsh_service,
    get_proxy_settings, save_proxy_settings, test_proxy_connectivity,
    ui_input_confirm, choose_desktop_mode,
    list_quarantine, restore_quarantine, repair_plugin,
    run_doctor, explain_failure, get_fuse_summary,
    get_quarantine_settings, save_quarantine_settings, list_ai_providers,
    get_desktop_settings_data, add_remote_address, remove_remote_address,
    select_remote_address, set_local_port, switch_profile_command,
};
use profiles::{scan_profiles, switch_profile, create_profile_flow};

// ── std/tauri 导入 ──
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU8, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_log::{Target, TargetKind};

// ── 测试专用导入（cargo fix 会移除非测试构建未用的项，这里统一补回）──
#[cfg(test)]
use settings::{DesktopSettings, settings_path, save_desktop_settings, from_yaml_value, legacy_desktop_block, configured_lane_port, configured_cloudflared_bin};
#[cfg(test)]
use network::proxy::{
    ProxyEnv, PROXY_MODE_OFF, PROXY_MODE_SYSTEM, PROXY_MODE_MANUAL, PROXY_LOOPBACK_ENTRIES,
    ProxyProvider, SystemProxy, ManualProxy, OffProxy,
    split_authority, proxy_url_from_authority, normalize_proxy_url,
    normalize_no_proxy_entries, merge_no_proxy_entries,
    parse_windows_proxy_server, system_proxy_env,
    inject_proxy_credentials, resolved_proxy_env, apply_proxy_env,
};
#[cfg(test)]
use process::lifecycle::version_key;
#[cfg(test)]
use network::web_token::random_token;
#[cfg(test)]
use process::plugin::{desktop_plugin_dir, mobile_package_dir, materialize_pool_package, desktop_platform_tag};
#[cfg(windows)] // copy_dir_all 仅 Windows 实现存在；macOS/Linux 测试构建会因导入不存在项而失败
use process::plugin::copy_dir_all;
#[cfg(test)]
use network::remote::{normalize_remote_url, extract_token_from_url, remote_has_plugin};

/// 带 / 之外路径与带凭据的输入（token URL 的路径恒为 /）。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("dsh-desktop-tauriapp".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .max_file_size(10_000_000)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(nav_guard_plugin())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["pet"])
                .build(),
        );
    // 测试钩子：DSH_DESKTOP_NO_SINGLETON=1 时跳过单实例互斥（隔离 E2E 用，
    // 允许测试实例与正在运行的正式实例并行，互不干扰）
    let builder = if std::env::var("DSH_DESKTOP_NO_SINGLETON").as_deref() == Ok("1") {
        log::info!("[test] DSH_DESKTOP_NO_SINGLETON=1：跳过单实例互斥");
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
    };
    builder
        .invoke_handler(tauri::generate_handler![
            pet_show_main,
            pet_hide,
            pet_quit,
            pet_toggle_passthrough,
            toggle_zoom,
            open_external,
            choose_desktop_mode,
            get_mode_prompt_needed,
            get_desktop_client_environment,
            log_diag,
            log_console,
            get_dsh_status,
            restart_dsh_service,
            ui_input_confirm,
            get_proxy_settings,
            save_proxy_settings,
            test_proxy_connectivity,
            list_ai_providers,
            get_desktop_settings_data,
            add_remote_address,
            remove_remote_address,
            select_remote_address,
            set_local_port,
            switch_profile_command,
            list_quarantine,
            restore_quarantine,
            repair_plugin,
            run_doctor,
            explain_failure,
            get_fuse_summary,
            get_quarantine_settings,
            save_quarantine_settings,
            crate::download::commands::list_downloads,
            crate::download::commands::pause_download,
            crate::download::commands::resume_download,
            crate::download::commands::cancel_download,
            crate::download::commands::clear_finished_downloads,
            crate::download::commands::get_download_settings,
            crate::download::commands::set_download_concurrency,
            crate::download::commands::reveal_download,
            crate::download::commands::start_blob_download,
            crate::download::commands::save_blob_chunk,
            crate::download::commands::finish_blob_download
        ])
.manage(DshState {
            child: Mutex::new(None),
            spawned_this_run: AtomicBool::new(false),
            mode_prompt_needed: AtomicBool::new(false),
            mode: AtomicU8::new(MODE_ADVANCED),
            status: AtomicU8::new(STATUS_IDLE),
            loading_url: Mutex::new(None),
            tray: Mutex::new(None),
            spawn_failed: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
            ready_once: AtomicBool::new(false),
            pending_input: Mutex::new(None),
            quitting: AtomicBool::new(false),
            tray_tip_shown: AtomicBool::new(false),
            unread: AtomicU32::new(0),
            pet_save_at: Mutex::new(None),
            notify_port: AtomicU16::new(0),
            notify_token: Mutex::new(String::new()),
            web_token: Mutex::new(String::new()),
            pre_zoom_geom: Mutex::new(None),
             stderr_bufs: Mutex::new(Default::default()),
            fuse_retries: AtomicU8::new(0),
            fuse_summary: Mutex::new(None),
            downloads: download::DownloadManager::new(),
        })
        .setup(|app| {
            // #72：主窗口由代码创建（不再走 tauri.conf.json 声明）以挂载下载处理器
            // ——wry 无 handler 时 macOS WKWebView 会静默取消所有下载。
            let dl_app = app.handle().clone();
            let main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("")
            .inner_size(1280.0, 840.0)
            .min_inner_size(940.0, 620.0)
            .center()
            .disable_drag_drop_handler()
            .on_download(move |_w, event| match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    let suggested = destination
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_string());
                    let scheme = url.scheme().to_ascii_lowercase();
                    if scheme == "http" || scheme == "https" {
                        download::manager::start_url_download(&dl_app, url.to_string(), suggested);
                    } else {
                        // blob:/data: 应由 client 拦截层处理；这里是漏网兜底：取消并记日志
                        log::warn!("[downloads] 漏网的非 http(s) 下载已取消（{}）", url);
                    }
                    false // 原生下载一律取消（转交 Rust 下载管理器）
                }
                _ => true,
            })
            .build();
            if let Err(e) = main_window {
                log::error!("[main] 主窗口创建失败：{e}");
            }
            // #87：在首次端口分配（会落盘创建 settings.yaml）之前判定全新安装
            let fresh_install = !settings::settings_path().exists();
            let port = app_port();
            let profile = configured_profile();
            let state = app.state::<DshState>();
            // 记录内嵌加载页 URL（重启/切换模式时回到该页，像重启应用一样）
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(u) = w.url() {
                    // about:blank 是 webview 导航前的初始状态，不是加载页 URL
                    if u.as_str() != "about:blank" {
                        *state.loading_url.lock().unwrap() = Some(u.to_string());
                    }
                }
            }
            // 申请系统通知权限（macOS 弹授权窗；Windows/Linux 幂等确认）。
            // 放在任何 .show() 之前，best-effort 不阻塞启动。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                request_notification_permission(&handle);
            });
            // 认领判定（#86）：端口有监听不再盲目复用——台账确认是本 profile 的实例、
            // 或落在 web 的 legacy 端口（外部 dsh 兼容）才复用；陌生占用者明确报错不代拉。
            let claim = crate::runtime::instances::decide_claim(
                &profile,
                port,
                port_open(port),
                &crate::runtime::instances::load_instances(),
                configured_port(),
            );
            use crate::runtime::instances::ClaimDecision;
            match claim {
                ClaimDecision::Free => {
                    // 即将由本应用拉起 dsh：先挂共享模块池并迁移旧 bundle 注册（--patch 注入）
                    log::info!("桌面插件 --patch 注入准备：挂共享模块池 + 迁移旧 bundle 注册");
                    set_status(app.handle(), STATUS_STARTING, "启动中");
                    materialize_desktop_plugin(app.handle());
                    strip_web_profile_plugin_bundle();
                    // 首次 spawn 前清 token（防御性：正常为空）；stdout 线程随后写入新值
                    clear_web_token(app.handle());
                    match spawn_dsh(app.handle(), &profile, port, true) {
                        Ok(child) => {
                            log::info!("dsh 子进程已启动（PID {}）", child.id());
                            *state.child.lock().unwrap() = Some(child);
                            state.spawned_this_run.store(true, Ordering::SeqCst);
                            state.mode.store(MODE_ADVANCED, Ordering::SeqCst);
                            // #87：全新安装默认 desktop profile——通知说明 + 指引如何回 web
                            if fresh_install && profile == settings::FRESH_DEFAULT_PROFILE {
                                show_notification(
                                    app.handle(),
                                    "全新安装 · 默认使用 desktop profile",
                                    "启动端口 3081；托盘菜单「切换 Profile」可回到 web@3080",
                                );
                            }
                        }
                        Err(SpawnError::NotFound(e)) => {
                            log::error!("启动 dsh 失败：{e}");
                            state.spawn_failed.store(true, Ordering::SeqCst);
                            show_error(app.handle(), "not-found");
                        }
                        Err(SpawnError::Other(e)) => {
                            log::error!("启动 dsh 失败：{e}");
                            state.spawn_failed.store(true, Ordering::SeqCst);
                            show_error(app.handle(), "spawn-failed");
                        }
                    }
                }
                ClaimDecision::Ours => {
                    // 上次壳拉起的实例仍存活（如壳崩溃后重启）：按复用流程接入
                    log::info!("127.0.0.1:{port} 是 profile {profile} 的在跑实例，直接复用");
                    state.mode_prompt_needed.store(true, Ordering::SeqCst);
                    set_status(app.handle(), STATUS_EXTERNAL, "复用本 profile 实例");
                }
                ClaimDecision::ForeignWeb => {
                    log::info!("127.0.0.1:{port} 已有外部服务在监听（web legacy 端口），直接复用现有实例");
                    // 外部实例复用会禁用桌面 chrome：在加载页弹「兼容/高级」模式选择
                    state.mode_prompt_needed.store(true, Ordering::SeqCst);
                    set_status(app.handle(), STATUS_EXTERNAL, "复用外部实例");
                }
                ClaimDecision::ForeignUnknown => {
                    // 端口被别的 profile / 陌生程序占用：绝不盲目复用，也不代杀
                    let detail = format!(
                        "端口 {port} 被其他实例或程序占用（profile={profile}），已停止自动拉起；可在设置中调整该 profile 的端口后重试"
                    );
                    log::error!("{detail}");
                    state.spawn_failed.store(true, Ordering::SeqCst);
                    show_notification(app.handle(), "DeepSeek Harness Desktop · 启动受阻", &detail);
                    show_error(app.handle(), "spawn-failed");
                }
            }
// 先起通知桥，把端口/token 交给导航任务并保存到 state（重启 dsh 时复用）；
// 导航完成后再注入监听脚本（0.3.0 在导航前注入，冷启动时脚本随加载页销毁）。
            let (nport, ntoken) = start_notify_server(app.handle().clone());
            state.notify_port.store(nport, Ordering::SeqCst);
            *state.notify_token.lock().unwrap() = ntoken.clone();
            if state.spawned_this_run.load(Ordering::SeqCst) {
                // 本次由桌面壳拉起实例：立即导航（advanced，桌面 chrome）
                let handle = app.handle().clone();
                let nav_token = ntoken.clone();
                tauri::async_runtime::spawn(async move {
                    wait_ready_and_navigate(handle, port, nport, nav_token).await;
                });
            } else {
                // 复用了外部实例：等用户在加载页选择模式（choose_desktop_mode）再接入；
                // 这里发一个延迟事件兜底，防止页面早于 state 标记加载完成
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    if handle.state::<DshState>().mode_prompt_needed.load(Ordering::SeqCst) {
                        let _ = handle.emit("desktop-mode-request", serde_json::json!({}));
                    }
                });
            }
            // 窗口拖动完全交由 dsh-desktop-tauriapp 插件的 client 端（root slot 里的
            // AdvancedFrame）渲染拖拽区并挂 data-tauri-drag-region；这里不再注入
            // 任何脚本，也不再使用 movableByWindowBackground（那会让整窗可拖）。
            // macOS 用 titleBarStyle:Overlay（保留原生红绿灯）；
            // Windows/Linux 隐藏原生标题栏（decorations:false），标题栏 UI 由
            // 插件 client 自绘 caption 行 + 窗口按钮。
            // 标题栏形态跟随接入模式（setup/模式切换/启动页选择都会走 apply_titlebar）；
            // 复用外部实例阶段（尚未选模式）保持系统原生标题栏。
            apply_titlebar(
                app.handle(),
                state.spawned_this_run.load(Ordering::SeqCst)
                    && state.mode.load(Ordering::SeqCst) == MODE_ADVANCED,
            );
            // 测试钩子：DSH_DESKTOP_AUTO_QUIT=1 时延迟自动退出（模拟托盘退出，验证子进程回收）
            if std::env::var("DSH_DESKTOP_AUTO_QUIT").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(8)).await;
                    log::info!("[auto-quit] 测试钩子触发退出");
                    handle
                        .state::<DshState>()
                        .quitting
                        .store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
            // 测试钩子：DSH_DESKTOP_PROXY_RESTART_TEST=1 时复现「设置表单保存 → 自动重启」链路
            //（acceptance-proxy.sh 专用）：直接调 save_proxy_settings + restart_dsh_service 两个真实命令，
            // 验证保存持久化 + 重启后新代理注入生效。表单 JS（proxy-settings.html）对这两个命令只是薄封装。
            if std::env::var("DSH_DESKTOP_PROXY_RESTART_TEST").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // 等首次 spawn 完成就绪导航（restarting 标志复位）再触发，模拟用户在表单点「保存」
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    let url = std::env::var("DSH_DESKTOP_PROXY_RESTART_URL").unwrap_or_default();
                    let no_proxy = std::env::var("DSH_DESKTOP_PROXY_RESTART_NO_PROXY").unwrap_or_default();
                    if let Err(e) = save_proxy_settings("manual".into(), url, no_proxy, String::new(), String::new()) {
                        log::error!("[proxy-restart-test] 保存代理设置失败：{e}");
                        return;
                    }
                    log::info!("[proxy-restart-test] 已保存新代理设置，触发 dsh 重启");
                    // restarting 标志尚未复位时短暂重试（与表单行为一致：保存成功即调重启命令）
                    for _ in 0..3 {
                        match restart_dsh_service(handle.clone()) {
                            Ok(()) => return,
                            Err(e) => log::warn!("[proxy-restart-test] 重启暂不可用：{e}"),
                        }
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                    }
                    log::error!("[proxy-restart-test] 重启多次被拒，验收链路中断");
                });
            }
            // 测试钩子：DSH_DESKTOP_NOTIFY_TEST=1 时延迟触发一次通知（验证通知链路）
            if std::env::var("DSH_DESKTOP_NOTIFY_TEST").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(6)).await;
                    notify_completed(&handle, "这是测试通知：任务完成链路验证");
                });
            }
            // 守护器：周期探测 dsh 服务。判定规则（防误杀/防抖动循环）：
            // 启动保险丝监控（#58）：dsh 子进程退出且非 0 → 隔离坏插件 → 自动重试。
            // 常驻任务，重启/重试后的新实例也在它的视野内。
            process::quarantine::monitor::start(app.handle());
            // - 健康 = TCP 连接成功；运行中（已进入 Web GUI）连不上一次 = 服务异常，
            //   立即分流：远程/外部实例只提示，本地拉起马上走完整重启（#71，无等待闸门）；
            // - 自愈每轮 3 次封顶，连续健康 ≥2 分钟才重置计数（防无限重启循环）；
            // - 守护器只管运行中：启动/重启期（ready_once=false）归导航流程与保险丝，
            //   重启流程 spawn 成功即复位 ready_once，从机制上杜绝二次重启；
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(5));
                    let mut healthy_streak = 0u32;
                    let mut epoch_failures = 0u32;
                    let mut last_notify = Instant::now() - Duration::from_secs(300);
                    loop {
                        interval.tick().await;
                        let state = handle.state::<DshState>();
                        if state.quitting.load(Ordering::SeqCst) {
                            break;
                        }
                        // 只管「运行中」：未就绪（启动期）/重启中/已判失败时让位
                        if !state.ready_once.load(Ordering::SeqCst)
                            || state.restarting.load(Ordering::SeqCst)
                            || state.spawn_failed.load(Ordering::SeqCst)
                        {
                            continue;
                        }
                        let settings = load_desktop_settings();
                        let (up, verbose) = match settings.remote_addr.as_deref() {
                            Some(addr) => probe_remote(addr),
                            None => probe_local(app_port()),
                        };
                        let cur = state.status.load(Ordering::SeqCst);
                        if up {
                            healthy_streak += 1;
                            // 持续健康 ≥2 分钟（24 tick）才重置自愈计数：防抖动无限循环
                            if healthy_streak >= 24 {
                                epoch_failures = 0;
                            }
                            if cur == STATUS_STALE || cur == STATUS_DOWN || cur == STATUS_REMOTE {
                                set_status(&handle, STATUS_READY, "运行中");
                            }
                            continue;
                        }
                        healthy_streak = 0;
                        // 运行中连不上 = 服务异常（#71：单次判定，不等计数、不设闸门）
                        if settings.remote_addr.is_some() {
                            set_status(&handle, STATUS_REMOTE, "远程不可达");
                            if Instant::now() - last_notify >= Duration::from_secs(300) {
                                last_notify = Instant::now();
                                show_notification(&handle, "远程 dsh 不可达", &format!("{verbose}"));
                            }
                            continue;
                        }
                        if !state.spawned_this_run.load(Ordering::SeqCst) {
                            // 复用外部实例：不代拉自动重启（那是用户的实例），仅提示
                            set_status(&handle, STATUS_STALE, "外部实例不可达");
                            if Instant::now() - last_notify >= Duration::from_secs(300) {
                                last_notify = Instant::now();
                                log::warn!("[watchdog] 外部 dsh 实例不可达（{verbose}），未自动重启");
                                show_notification(&handle, "dsh 服务不可达", "复用的外部 dsh 实例已停止，请手动重启服务");
                            }
                            continue;
                        }
                        // 本地拉起的实例：立即进入完整重启流程
                        epoch_failures += 1;
                        if epoch_failures >= 3 {
                            log::error!("[watchdog] 连续自动恢复失败 3 次，停止自愈");
                            set_status(&handle, STATUS_STALE, "异常（已停止自愈，请手动重启）");
                            show_notification(&handle, "dsh 服务异常", "连续自动恢复失败，请手动重启");
                            continue;
                        }
                        log::warn!("[watchdog] dsh 不可达（{verbose}），自动重启（第 {epoch_failures} 次）");
                        show_notification(&handle, "dsh 服务异常", &format!("服务异常，正在自动重启（第 {epoch_failures} 次）"));
                        restart_dsh_in_mode(&handle, state.mode.load(Ordering::SeqCst));
                    }
                });
            }
            build_tray(app)?;
            setup_pet(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            match window.label() {
                "pet" => match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        // 桌宠不退出，只隐藏（退出走托盘/右键 pet_quit）
                        api.prevent_close();
                        let _ = window.hide();
                        let mut st = read_pet_state(window.app_handle());
                        st.enabled = false;
                        write_pet_state(window.app_handle(), &st);
                    }
                    WindowEvent::Moved(pos) => {
                        // 拖拽结束才落盘位置（400ms 防抖，避免拖动期间高频写盘）
                        let app = window.app_handle();
                        let state = app.state::<DshState>();
                        let now = Instant::now();
                        let should_save = state
                            .pet_save_at
                            .lock()
                            .map(|last| {
                                last.map_or(true, |t| now.duration_since(t) >= Duration::from_millis(400))
                            })
                            .unwrap_or(true);
                        if should_save {
                            let mut st = read_pet_state(&app);
                            st.x = pos.x;
                            st.y = pos.y;
                            write_pet_state(&app, &st);
                            if let Ok(mut last) = state.pet_save_at.lock() {
                                *last = Some(now);
                            }
                        }
                    }
                    _ => {}
                },
                "main" => {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = window.state::<DshState>();
                        if state.quitting.load(Ordering::SeqCst) {
                            return; // 托盘退出流程：放行关闭
                        }
                        api.prevent_close();
                        let _ = window.hide();
                        if !state.tray_tip_shown.swap(true, Ordering::SeqCst) {
                            show_notification(
                                window.app_handle(),
                                "DeepSeek Harness Desktop 仍在运行",
                                "窗口已隐藏到菜单栏托盘，点击托盘图标可重新打开；托盘菜单可退出。",
                            );
                        }
                    } else if let WindowEvent::Focused(true) = event {
                        // 用户回到窗口：清零角标与未读数
                        let state = window.state::<DshState>();
                        state.unread.store(0, Ordering::SeqCst);
                        let _ = window.set_badge_count(None);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                let quitting = app.state::<DshState>().quitting.load(Ordering::SeqCst);
                if !quitting {
                    api.prevent_exit();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
            RunEvent::Exit => {
                let state = app.state::<DshState>();
                if state.spawned_this_run.load(Ordering::SeqCst) {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        let pid = child.id();
                        log::info!("正在停止 dsh 子进程（PID {pid}）");
                        let _ = child.kill();
                        let _ = child.wait();
                        log::info!("dsh 子进程已退出");
                        // 实例台账（#86）：自家实例已停，摘除记录
                        crate::runtime::instances::remove_instance(&configured_profile());
                    }
                }
            }
            _ => {}
        });
}
