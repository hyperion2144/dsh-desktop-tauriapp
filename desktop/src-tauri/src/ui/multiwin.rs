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
        });
    if let Err(e) = build.build() {
        log::error!("[multiwin] 建窗失败（{label}）：{e}");
        return;
    }
    app.state::<DshState>().bind_window(profile, label.clone());

    let app = app.clone();
    let profile = profile.to_string();
    tauri::async_runtime::spawn(async move {
        // 清 per-profile token 残留（旧实例的 token 对新实例无效）
        app.state::<DshState>().web_tokens.lock().unwrap().remove(&profile);
        match spawn_dsh(&app, &profile, port, true) {
            Ok(child) => app.state::<DshState>().set_child(&profile, child),
            Err(e) => {
                let msg = match &e {
                    crate::runtime::error::SpawnError::NotFound(s)
                    | crate::runtime::error::SpawnError::Other(s) => s.clone(),
                };
                show_notification(&app, &format!("{profile} 启动失败"), &msg);
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.close();
                }
                app.state::<DshState>().unbind_window(&profile);
                return;
            }
        }
        let nport = app.state::<DshState>().notify_port.load(std::sync::atomic::Ordering::SeqCst);
        let ntoken = app.state::<DshState>().notify_token.lock().unwrap().clone();
        wait_ready_and_attach(app, profile, label, port, nport, ntoken).await;
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
) {
    let host_port = format!("127.0.0.1:{port}");
    let mut rounds = 0u32;
    loop {
        if app.state::<DshState>().quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let exited = {
            let state = app.state::<DshState>();
            let mut children = state.children.lock().unwrap();
            children
                .get_mut(&profile)
                .and_then(|c| c.try_wait().ok())
                .flatten()
                .is_some()
        };
        if exited {
            let tail = app.state::<DshState>().stderr_tail_for(&profile, 10).join(" ⏎ ");
            show_notification(
                &app,
                &format!("{profile} 实例已退出"),
                &if tail.is_empty() { "进程退出，详情见主窗口日志".to_string() } else { tail },
            );
            close_profile_instance(&app, &profile, false);
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
            return;
        }
        let token = app.state::<DshState>().web_token_for(&profile);
        let Some(token) = token else {
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
}

/// 是否还有可见的 profile 次窗口（主窗隐藏判定用）。
#[allow(dead_code)] // #91 验收 / 主窗隐藏判定将使用
pub(crate) fn has_secondary_windows(app: &AppHandle) -> bool {
    app.webview_windows().keys().any(|l| l.starts_with("profile-"))
}
