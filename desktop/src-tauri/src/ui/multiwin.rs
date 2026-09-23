//! 多窗口管理（#89）：profile ↔ 窗口绑定、开窗/聚焦/关闭语义。
//!
//! 定稿（#84 变体 A）：托盘「PROFILE 窗口」分组——运行中点击聚焦窗口，
//! 未运行点击开新窗（每 profile 至多一窗）。激活 profile 的窗口就是主窗（"main"）。
//! 窗口关闭语义：非最后窗口关闭 = 停该实例并摘台账；最后窗口关闭 = 隐藏回托盘
//! （现状，主窗处理不变）；应用退出 = 全回收。

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::Emitter;

use crate::network::notify::{inject_task_notifier, show_notification};
use crate::network::web_token::{
    exchange_token_for_cookie, seed_session_cookie_for, session_cookie_accepts,
};
use crate::process::lifecycle::{port_open, spawn_dsh};
use crate::runtime::instances::{decide_claim, load_instances, ClaimDecision};
use crate::runtime::state::DshState;

/// profile 窗口的 label（"profile-<name>"）。
pub(crate) fn window_label(profile: &str) -> String {
    format!("profile-{profile}")
}

/// 托盘「PROFILE 窗口」项点击：已绑定窗口→聚焦；激活 profile→主窗；未运行→开新窗。
pub(crate) fn open_profile_window(app: &AppHandle, profile: &str) {
    if profile == crate::settings::configured_profile() {
        // 激活 profile 的窗口就是主窗
        crate::ui::window::show_main(app);
        return;
    }
    let label = window_label(profile);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let port = crate::settings::port_for_profile(profile);
    let claim = decide_claim(
        profile,
        port,
        port_open(port),
        &load_instances(),
        crate::settings::configured_port(),
    );
    match claim {
        ClaimDecision::Free => spawn_and_attach(app, profile, port),
        ClaimDecision::Ours => show_notification(
            app,
            "无法打开窗口",
            &format!("{profile}：实例已在运行但未绑定窗口。托盘「重启 dsh 服务」后可接入。"),
        ),
        _ => show_notification(
            app,
            "无法打开窗口",
            &format!("{profile}：端口 {port} 被外部实例或陌生程序占用，已停止自动拉起。"),
        ),
    }
}

/// 接入导航的路径差异（建窗 vs 就地切换）。
#[derive(Clone, Copy)]
struct AttachOptions {
    /// token 等待上限（None=无限；就地切换给有限值，避免无反馈死等）
    token_wait_rounds: Option<u32>,
    /// 实例中途退出时是否关闭目标窗口（建窗 true；就地切换 false → 保留窗口）
    close_window_on_exit: bool,
}

impl AttachOptions {
    /// 建窗路径：首次接入，无限等 token；启动失败/实例退出则关窗。
    const fn spawn_path() -> Self {
        Self {
            token_wait_rounds: None,
            close_window_on_exit: true,
        }
    }
    /// 就地切换路径：窗口已存在（可能还在显示旧 profile），失败不关窗；token 等待有上限。
    const fn in_place() -> Self {
        Self {
            token_wait_rounds: Some(60),
            close_window_on_exit: false,
        }
    }
}

/// 当前聚焦窗口的 label（托盘「切换 Profile」的作用对象）；无聚焦窗口回落主窗。
/// 桌宠窗不参与（装饰窗，不对应 profile）。
pub(crate) fn focused_window_label(app: &AppHandle) -> String {
    for (label, w) in app.webview_windows() {
        if label == "pet" {
            continue;
        }
        if w.is_focused().unwrap_or(false) {
            return label;
        }
    }
    "main".to_string()
}

/// 托盘「切换 Profile」：把指定窗口就地切换到目标 profile（不新建窗口，区别于
/// 「在新窗口打开」）。目标实例未运行则拉起；已在运行（本壳台账 + 令牌在手）则直接改绑导航。
pub(crate) fn switch_profile_in_window(app: &AppHandle, label: &str, target: &str) {
    if target.trim().is_empty() {
        return;
    }
    let state = app.state::<DshState>();
    // 窗口当前 profile：绑定表优先（就地切换后 label 不再权威），回落 label 约定/激活 profile
    let current = state
        .profile_of_window(label)
        .or_else(|| label.strip_prefix("profile-").map(|s| s.to_string()))
        .unwrap_or_else(crate::settings::configured_profile);
    if current == target {
        show_notification(app, "无需切换", &format!("该窗口当前已是 {target}。"));
        return;
    }
    let port = crate::settings::port_for_profile(target);
    let claim = decide_claim(
        target,
        port,
        port_open(port),
        &load_instances(),
        crate::settings::configured_port(),
    );
    // 可行性预判（失败不改绑，避免绑定与窗口内容不一致）
    let token_ready = state.web_token_for(target).is_some();
    match claim {
        ClaimDecision::Free => {}
        ClaimDecision::Ours if token_ready => {}
        ClaimDecision::Ours => {
            show_notification(
                app,
                "无法切换",
                &format!("{target} 实例在运行但访问令牌不可用；托盘「重启 dsh 服务」后再试。"),
            );
            return;
        }
        _ => {
            show_notification(
                app,
                "无法切换",
                &format!("{target}：端口 {port} 被外部实例或陌生程序占用，已停止自动拉起。"),
            );
            return;
        }
    }
    // 改绑：目标 profile 接管该窗口，旧 profile 解绑
    state.unbind_window(&current);
    state.bind_window(target, label.to_string());
    // 主窗即激活 profile 的窗口：同步内存激活 profile 并持久化（下次启动沿用）
    if label == "main" {
        *state.pending_active_profile.lock().unwrap() = Some(target.to_string());
        let mut s = crate::settings::load_desktop_settings();
        s.active_profile = Some(target.to_string());
        let _ = crate::settings::save_desktop_settings(&s);
    }
    let nport = state.notify_port.load(std::sync::atomic::Ordering::SeqCst);
    let ntoken = state.notify_token.lock().unwrap().clone();
    crate::ui::tray::refresh_tray_mode(app);
    match claim {
        ClaimDecision::Free => spawn_and_navigate_to(app, target, port, label.to_string(), true),
        // 已在运行：令牌已预检在手，直接接入导航（有上限，超时给提示）
        _ => {
            let app2 = app.clone();
            let profile2 = target.to_string();
            let label2 = label.to_string();
            tauri::async_runtime::spawn(async move {
                wait_ready_and_attach(
                    app2,
                    profile2,
                    label2,
                    port,
                    nport,
                    ntoken,
                    AttachOptions::in_place(),
                )
                .await;
            });
        }
    }
}

/// spawn 该 profile 的实例并建窗绑定，随后进入就绪导航。
fn spawn_and_attach(app: &AppHandle, profile: &str, port: u16) {
    let label = window_label(profile);
    let dl_app = app.clone();
    let build = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title(format!("DeepSeek Harness · {profile}"))
        .inner_size(1280.0, 840.0)
        .min_inner_size(940.0, 620.0)
        .disable_drag_drop_handler()
        .on_download(move |_w, event| match event {
            tauri::webview::DownloadEvent::Requested { url, destination } => {
                let suggested = destination
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string());
                let scheme = url.scheme().to_ascii_lowercase();
                if scheme == "http" || scheme == "https" {
                    crate::download::manager::start_url_download(&dl_app, url.to_string(), suggested);
                }
                false
            }
            _ => true,
        })
        // 新窗请求同主窗：系统浏览器，应用内不开新窗（nav_guard 模块注释）
        .on_new_window(|url, _| {
            if crate::ui::nav_guard::new_window_guard(&url) {
                tauri::webview::NewWindowResponse::Allow
            } else {
                tauri::webview::NewWindowResponse::Deny
            }
        });
    if let Err(e) = build.build() {
        log::error!("[multiwin] 建窗失败（{label}）：{e}");
        return;
    }
    app.state::<DshState>().bind_window(profile, label.clone());
    // 标题栏形态 + 三插件注入都跟随主窗口当前模式（#90 用户拍板：次窗与主窗一致）
    let advanced = app.state::<DshState>().mode.load(std::sync::atomic::Ordering::SeqCst)
        == crate::MODE_ADVANCED;
    if let Some(w) = app.get_webview_window(&label) {
        crate::ui::tray::apply_titlebar_for(&w, advanced);
    }

    spawn_and_navigate_to(app, profile, port, label, false);
}

/// spawn 该 profile 实例并就绪导航到指定窗口（不建窗）——建窗路径与「本窗口切换」共用。
/// `in_place`：就地切换（窗口已在，启动失败/实例退出都不关窗）；false = 建窗路径。
fn spawn_and_navigate_to(app: &AppHandle, profile: &str, port: u16, label: String, in_place: bool) {
    let app = app.clone();
    let profile = profile.to_string();
    let attach = if in_place { AttachOptions::in_place() } else { AttachOptions::spawn_path() };
    tauri::async_runtime::spawn(async move {
        // 清 per-profile token 残留（旧实例的 token 对新实例无效）
        app.state::<DshState>().web_tokens.lock().unwrap().remove(&profile);
        let advanced = app.state::<DshState>().mode.load(std::sync::atomic::Ordering::SeqCst)
            == crate::MODE_ADVANCED;
        match spawn_dsh(&app, &profile, port, advanced) {
            Ok(child) => {
                app.state::<DshState>().set_child(&profile, child);
                crate::ui::tray::refresh_tray_mode(&app);
            }
            Err(e) => {
                let msg = match &e {
                    crate::runtime::error::SpawnError::NotFound(s)
                    | crate::runtime::error::SpawnError::Other(s) => s.clone(),
                };
                show_notification(&app, &format!("{profile} 启动失败"), &msg);
                if !in_place {
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = w.close();
                    }
                    app.state::<DshState>().unbind_window(&profile);
                }
                return;
            }
        }
        let nport = app
            .state::<DshState>()
            .notify_port
            .load(std::sync::atomic::Ordering::SeqCst);
        let ntoken = app.state::<DshState>().notify_token.lock().unwrap().clone();
        wait_ready_and_attach(app, profile, label, port, nport, ntoken, attach).await;
    });
}

/// 次窗口就绪导航：等 per-profile token → 交换/种 cookie → 验证 → 导航 + 注通知桥。
/// 实例中途退出：通知摘要（stderr 尾部）并关闭窗口清理绑定。
async fn wait_ready_and_attach(
    app: AppHandle,
    profile: String,
    label: String,
    port: u16,
    nport: u16,
    ntoken: String,
    opts: AttachOptions,
) {
    let host_port = format!("127.0.0.1:{port}");
    let mut rounds = 0u32;
    let mut attach_retries = 0u8; // 次实例轻量保险丝的重试预算（1 次）
    let mut token_rounds = 0u32; // token 等待计数（opts.token_wait_rounds 有上限时生效）
    loop {
        if app.state::<DshState>().quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        // #89 第二批：次实例轻量保险丝——pre-ready 退出且非零 → 隔离不兼容插件 + 重试一次
        let exit_status = {
            let state = app.state::<DshState>();
            let mut children = state.children.lock().unwrap();
            children
                .get_mut(&profile)
                .and_then(|c| c.try_wait().ok())
                .flatten()
        };
        if let Some(status) = exit_status {
            let stderr = app.state::<DshState>().stderr_snapshot_for(&profile);
            if attach_retries < 1 && !status.success() {
                let settings = crate::settings::load_desktop_settings();
                let inject = crate::desktop_plugin_patch_path(&app);
                let outcome = crate::process::quarantine::run_cycle(
                    &crate::dsh_home(),
                    &profile,
                    Some(&inject),
                    &stderr,
                    &settings,
                );
                if !outcome.disabled.is_empty() {
                    attach_retries += 1;
                    let names: Vec<String> = outcome.disabled.iter().map(|e| e.id.clone()).collect();
                    show_notification(
                        &app,
                        &format!("{profile} 启动失败 · 已隔离插件"),
                        &format!("已禁用 {}，重试一次", names.join("、")),
                    );
                    let _ = crate::process::lifecycle::stop_port_owner(port).await;
                    app.state::<DshState>().web_tokens.lock().unwrap().remove(&profile);
                    match spawn_dsh(&app, &profile, port, true) {
                        Ok(child) => app.state::<DshState>().set_child(&profile, child),
                        Err(_) => {}
                    }
                    continue;
                }
            }
            let tail = app.state::<DshState>().stderr_tail_for(&profile, 10).join(" ⏎ ");
            show_notification(
                &app,
                &format!("{profile} 实例已退出"),
                &if tail.is_empty() { "进程退出，详情见主窗口日志".to_string() } else { tail },
            );
            close_profile_instance(&app, &profile, false);
            if opts.close_window_on_exit {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.close();
                }
            }
            return;
        }
        // 未退出：继续接入流程（token/端口检查在下方）
        let token = app.state::<DshState>().web_token_for(&profile);
        let Some(token) = token else {
            // 就地切换路径：等不到令牌就明确失败退出（否则无反馈死等，用户不知所以）
            if let Some(max) = opts.token_wait_rounds {
                token_rounds += 1;
                if token_rounds > max {
                    show_notification(
                        &app,
                        &format!("{profile} 接入超时"),
                        "未取到该实例的访问令牌；请用托盘「重启 dsh 服务」后在窗口内重试。",
                    );
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
            continue;
        };
        if !port_open(port) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        let Some((name, value)) = exchange_token_for_cookie(&host_port, &token) else {
            rounds += 1;
            if rounds % 5 == 1 {
                log::warn!("[multiwin:{profile}] cookie 交换未成功，继续等待（第 {rounds} 轮）");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        };
        if !seed_session_cookie_for(&app, &label, "127.0.0.1", port, &name, &value) {
            let url = format!("http://127.0.0.1:{port}/?token={token}");
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.eval(&format!("window.location.replace({url:?});"));
                inject_task_notifier(app.clone(), nport, &ntoken);
            }
            return;
        }
        if !session_cookie_accepts(&host_port, &name, &value) {
            if rounds <= 10 {
                tokio::time::sleep(Duration::from_millis(800)).await;
                continue;
            }
            log::error!("[multiwin:{profile}] 连续 {rounds} 轮会话验证失败，放弃接入");
            return;
        }
        if let Some(w) = app.get_webview_window(&label) {
            let url = format!("http://127.0.0.1:{port}/");
            let _ = w.eval(&format!("window.location.replace({url:?});"));
            inject_task_notifier(app.clone(), nport, &ntoken);
            let _ = w.set_focus();
        }
        log::info!("[multiwin:{profile}] 窗口已接入（{host_port}）");
        // #89 第二批：就绪后进入运行期监督（次实例无保险丝重试，进程退出即通知+关窗）
        supervise_secondary(app, profile, label, port, opts.close_window_on_exit).await;
        return;
    }
}

/// 运行期监督：轮询子进程退出 → stderr 尾部通知 + 关窗清理（建窗路径）/保留窗口（就地切换）。
async fn supervise_secondary(
    app: AppHandle,
    profile: String,
    label: String,
    port: u16,
    close_window_on_exit: bool,
) {
    loop {
        if app.state::<DshState>().quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        let exited = {
            let state = app.state::<DshState>();
            let mut children = state.children.lock().unwrap();
            children
                .get_mut(&profile)
                .and_then(|c| c.try_wait().ok())
                .flatten()
                .is_some()
        };
        if !exited {
            continue;
        }
        let tail = app.state::<DshState>().stderr_tail_for(&profile, 10).join(" ⏎ ");
        show_notification(
            &app,
            &format!("{profile} 实例已退出"),
            &if tail.is_empty() { "进程退出，详情见主窗口日志".to_string() } else { tail },
        );
        close_profile_instance(&app, &profile, false);
        if close_window_on_exit {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
        }
        return;
    }
}

/// 关闭 profile 实例：解绑窗口；stop_process 时停子进程（kill+wait+摘台账+清端口）。
/// 窗口关闭事件里调用（非最后窗口）；`stop_port_owner` 兜底放异步任务执行。
pub(crate) fn close_profile_instance(app: &AppHandle, profile: &str, stop_process: bool) {
    app.state::<DshState>().unbind_window(profile);
    if !stop_process {
        return;
    }
    if let Some(mut child) = app.state::<DshState>().take_child(profile) {
        let _ = child.kill();
        let _ = child.wait();
    }
    crate::runtime::instances::remove_instance(profile);
    let port = crate::settings::port_for_profile(profile);
    let app = app.clone();
    let profile = profile.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = crate::process::lifecycle::stop_port_owner(port).await;
        log::info!("[multiwin:{profile}] 实例已停止，端口 {port} 释放");
    });
    crate::ui::tray::refresh_tray_mode(&app);
}

/// 是否还有可见的 profile 次窗口（主窗隐藏判定用）。
#[allow(dead_code)] // #91 验收 / 主窗隐藏判定将使用
pub(crate) fn has_secondary_windows(app: &AppHandle) -> bool {
    app.webview_windows().keys().any(|l| l.starts_with("profile-"))
}
