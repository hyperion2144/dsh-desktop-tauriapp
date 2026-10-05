//! 多窗口管理（#89）：profile ↔ 窗口绑定、开窗/聚焦/关闭语义。
//!
//! 定稿（#84 变体 A）：托盘「PROFILE 窗口」分组——运行中点击聚焦窗口，
//! 未运行点击开新窗（每 profile 至多一窗）。激活 profile 的窗口就是主窗（"main"）。
//! 窗口关闭语义（#178 定稿）：任意窗口关闭 = 只销毁窗口 UI、实例保留（关窗≠停实例）；
//! 主窗关闭 = 隐藏回托盘；实例崩溃/退出仍关窗+通知；应用退出 = 全回收。

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::network::notify::{inject_task_notifier, show_notification};
use crate::network::web_token::{
    exchange_token_for_cookie, seed_session_cookie_for, session_cookie_accepts,
};
use crate::process::lifecycle::port_open;
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
        ClaimDecision::Ours => attach_running_profile(app, profile, port),
        _ => show_notification(
            app,
            crate::network::notify_policy::scenario::INSTANCE_LIFECYCLE,
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
    /// 附着运行中实例（#178 重开=附着）：实例已在跑 token 很快可取；崩溃仍关窗（Q6）。
    const fn attach_running() -> Self {
        Self {
            token_wait_rounds: Some(60),
            close_window_on_exit: true,
        }
    }
}

/// 托盘「本窗口」作用对象（#181）：读事件驱动的「最后聚焦窗口」记录——点托盘菜单后
/// 窗口必失焦，实时 is_focused 扫描恒回落主窗（#117 体感偏差根因）；窗口销毁摘除、
/// pet 不参与、无记录回落主窗。与 #94 lane 转发同一套焦点事件源，避免两套焦点真相。
pub(crate) fn focused_window_label(app: &AppHandle) -> String {
    let state = app.state::<DshState>();
    let recorded = state.focused_label();
    // #181 实测反馈兑底：若 Focused 事件漏发（记录仍指主窗），用实时 is_focused
    // 扫描补判——托盘菜单场景窗口已失焦扫不到（保持记录），但窗真聚焦时能自愈。
    for (label, w) in app.webview_windows() {
        if label != "pet" && w.is_focused().unwrap_or(false) {
            if recorded != label {
                state.note_focused(&label);
                log::info!("[focus] 兑底扫描校正：{recorded} → {label}");
            }
            return label;
        }
    }
    recorded
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
         show_notification(app, crate::network::notify_policy::scenario::INSTANCE_LIFECYCLE, "无需切换", &format!("该窗口当前已是 {target}。"));
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
                crate::network::notify_policy::scenario::INSTANCE_LIFECYCLE,
                "无法切换",
                &format!("{target} 实例在运行但访问令牌不可用；托盘「重启 dsh 服务」后再试。"),
            );
            return;
        }
        _ => {
            show_notification(
                app,
                crate::network::notify_policy::scenario::INSTANCE_LIFECYCLE,
                "无法切换",
                &format!("{target}：端口 {port} 被外部实例或陌生程序占用，已停止自动拉起。"),
            );
            return;
        }
    }
    // 主窗切换（#136 定稿）：主窗的 profile 可换——主 worker 转向新目标杀旧拉新，
    // 任意时刻主 worker 名下只有一个 dsh 进程；不走次实例路径（否则旧 profile 的
    // 主实例没人停、新 profile 又拉一个 → 双进程）。目标端口已有实例（次窗口/
    // 外部）也由 worker 统一接管清理。
    if label == "main" {
        state.unbind_window(&current);
        state.bind_window(target, label.to_string());
        *state.pending_active_profile.lock().unwrap() = Some(target.to_string());
        let mut s = crate::settings::load_desktop_settings();
        s.active_profile = Some(target.to_string());
        let _ = crate::settings::save_desktop_settings(&s);
        let mode = state.mode.load(std::sync::atomic::Ordering::SeqCst);
        crate::ui::tray::restart_dsh_in_mode(app, mode, Some(target));
        return;
    }
    // 次窗口：改绑 + 就地切换（次 worker 路径）
    state.unbind_window(&current);
    state.bind_window(target, label.to_string());
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

/// 建 profile 窗口（spawn 与附着共用，#178）：载体注入/下载拦截/新窗守卫同一路径。
fn build_profile_window(app: &AppHandle, profile: &str, label: &str) -> Result<(), tauri::Error> {
    let dl_app = app.clone();
    let build = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title(format!("DeepSeek Harness · {profile}"))
        .inner_size(1280.0, 840.0)
        .min_inner_size(940.0, 620.0)
        .disable_drag_drop_handler()
        // #118/#134：同主窗——注入 dshDesktop 载体标记（仅本地 loopback 生效）
        .initialization_script(crate::ui::browser_guests::desktop_carrier_init_script())
        // 远程模式：同主窗——对壳配置的远程主机注入 ownsHost 能力位
        .initialization_script(crate::ui::browser_guests::remote_owns_host_init_script(
            crate::settings::load_desktop_settings().remote_addr.as_deref(),
        ))
        // #118：宿主页 Started 加载时清理旧 guest（dsh 重启后旧实例自愈）
        .on_page_load(|w, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                crate::ui::browser_guests::release_guests_of_host(w.app_handle(), w.label());
            }
        })
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
    build.build().map(|_| ())
}

/// 绑定 + 标题栏形态（建窗成功后的公共收尾）。
fn bind_and_apply_titlebar(app: &AppHandle, profile: &str, label: &str) {
    app.state::<DshState>().bind_window(profile, label.to_string());
    let advanced = app
        .state::<DshState>()
        .mode
        .load(std::sync::atomic::Ordering::SeqCst)
        == crate::MODE_ADVANCED;
    if let Some(w) = app.get_webview_window(label) {
        crate::ui::tray::apply_titlebar_for(&w, advanced);
    }
}

/// spawn 该 profile 的实例并建窗绑定，随后进入就绪导航。
fn spawn_and_attach(app: &AppHandle, profile: &str, port: u16) {
    let label = window_label(profile);
    if let Err(e) = build_profile_window(app, profile, &label) {
        log::error!("[multiwin] 建窗失败（{label}）：{e}");
        return;
    }
    bind_and_apply_titlebar(app, profile, &label);
    spawn_and_navigate_to(app, profile, port, label, false);
}

/// 附着运行中实例（#178）：托盘「PROFILE 窗口」点击运行中项 / 关窗后重开——
/// 建窗 + 绑定 + 就绪导航，**不 spawn 不重启**，会话延续；崩溃仍关窗+通知（Q6）。
fn attach_running_profile(app: &AppHandle, profile: &str, port: u16) {
    let label = window_label(profile);
    if let Err(e) = build_profile_window(app, profile, &label) {
        log::error!("[multiwin] 附着建窗失败（{label}）：{e}");
        return;
    }
    bind_and_apply_titlebar(app, profile, &label);
    let state = app.state::<DshState>();
    let nport = state.notify_port.load(std::sync::atomic::Ordering::SeqCst);
    let ntoken = state.notify_token.lock().unwrap().clone();
    let app2 = app.clone();
    let profile2 = profile.to_string();
    let label2 = label;
    tauri::async_runtime::spawn(async move {
        wait_ready_and_attach(
            app2,
            profile2,
            label2,
            port,
            nport,
            ntoken,
            AttachOptions::attach_running(),
        )
        .await;
    });
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
        // 就地切换：先销毁同名旧 worker（停旧实例——「启动新的必须停掉旧的」）
        if let Some(old) = app.state::<DshState>().workers.lock().unwrap().remove(&profile) {
            old.shutdown();
        }
        // 次实例 worker：打开次窗口时创建（关窗时销毁，见 close_profile_instance）
        let worker = crate::process::worker::DshWorker::new(profile.clone(), port, false);
        worker.begin_start(&app, advanced);
        if !crate::process::lifecycle::stop_port_owner(port).await {
             show_notification(&app, crate::network::notify_policy::scenario::PROFILE_ERROR, &format!("{profile} 启动失败"), &format!("端口 {port} 未能释放"));
            if !in_place {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.close();
                }
                app.state::<DshState>().unbind_window(&profile);
            }
            return;
        }
        if let Err(e) = worker.spawn_now(&app, advanced) {
            let msg = match &e {
                crate::runtime::error::SpawnError::NotFound(s)
                | crate::runtime::error::SpawnError::Other(s) => s.clone(),
            };
             show_notification(&app, crate::network::notify_policy::scenario::PROFILE_ERROR, &format!("{profile} 启动失败"), &msg);
            if !in_place {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.close();
                }
                app.state::<DshState>().unbind_window(&profile);
            }
            return;
        }
        // 登记 worker（退出检测 / 关窗销毁 / 应用退出回收都从表里取）
        app.state::<DshState>()
            .workers
            .lock()
            .unwrap()
            .insert(profile.clone(), worker);
        crate::ui::tray::refresh_tray_mode(&app);
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
    let mut token_rounds = 0u32; // token 等待计数（opts.token_wait_rounds 有上限时生效）
    loop {
        if app.state::<DshState>().quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        // 次实例退出检测：pre-ready 退出 → 通知摘要（stderr 尾部）并关闭窗口
        let exit_status = {
            app.state::<DshState>()
                .workers
                .lock()
                .unwrap()
                .get(&profile)
                .and_then(|w| w.child_exited())
        };
        if let Some(status) = exit_status {
            if !status.success() {
                log::warn!("[multiwin] {profile} 实例退出异常（{:?}）", status.code());
            }
            let tail = app.state::<DshState>().stderr_tail_for(&profile, 10).join(" ⏎ ");
            show_notification(
                &app,
                crate::network::notify_policy::scenario::PROFILE_ERROR,
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
                        crate::network::notify_policy::scenario::PROFILE_ERROR,
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
        // #179/#180 反馈：端口开始监听 = 「运行中」，即刻刷新托盘（不等导航完成）
        crate::ui::tray::refresh_tray_mode(&app);
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
                inject_task_notifier(app.clone(), &label, nport, &ntoken);
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
            inject_task_notifier(app.clone(), &label, nport, &ntoken);
            let _ = w.set_focus();
        }
        log::info!("[multiwin:{profile}] 窗口已接入（{host_port}）");
        // #179/#180 反馈：接入完成，托盘状态对齐（运行中子菜单就位）
        crate::ui::tray::refresh_tray_mode(&app);
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
    _port: u16,
    close_window_on_exit: bool,
) {
    loop {
        if app.state::<DshState>().quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        let exited = {
            app.state::<DshState>()
                .workers
                .lock()
                .unwrap()
                .get(&profile)
                .and_then(|w| w.child_exited())
                .is_some()
        };
        if !exited {
            continue;
        }
        let tail = app.state::<DshState>().stderr_tail_for(&profile, 10).join(" ⏎ ");
        show_notification(
            &app,
            crate::network::notify_policy::scenario::PROFILE_ERROR,
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
        // 崩溃/退出路径（stop_process=false）：实例状态变化，同样刷新托盘
        crate::ui::tray::refresh_tray_mode(app);
        return;
    }
    // 关闭窗口 = 销毁该 profile 的 worker：worker 自行清理其 dsh 进程
    if let Some(worker) = app.state::<DshState>().workers.lock().unwrap().remove(profile) {
        worker.shutdown();
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

/// 次窗口关闭（#178 新语义）：只销毁窗口 UI → 解绑窗口，worker/台账/端口全部保留，
/// 会话继续跑；托盘「PROFILE 窗口」该项回到「运行中·点击聚焦」，点击即重新附着。
pub(crate) fn detach_profile_window(app: &AppHandle, profile: &str) {
    app.state::<DshState>().unbind_window(profile);
    log::info!("[multiwin:{profile}] 窗口已关闭，实例保留运行（关窗≠停实例）");
    crate::ui::tray::refresh_tray_mode(app);
}

/// 入口（托盘/状态条共用，#179/#180）：快速校验后 defer 到后台执行——
/// kill+wait 与窗口销毁不占主线程（实机反馈：退出卡死）。
pub(crate) fn exit_profile_instance(app: &AppHandle, profile: &str) {
    if profile == crate::settings::configured_profile()
        && crate::runtime::builtin::configured_dsh_mode()
            == crate::runtime::builtin::DshMode::External
    {
        // 主实例外部复用模式：绝不杀（Q10——那不是本壳的进程）
        show_notification(
            app,
            crate::network::notify_policy::scenario::INSTANCE_LIFECYCLE,
            "无法退出",
            "外部 dsh 模式下实例由外部 CLI 管理，不在本壳退出范围",
        );
        return;
    }
    let app2 = app.clone();
    let profile2 = profile.to_string();
    tauri::async_runtime::spawn(async move {
        exit_profile_instance_bg(&app2, &profile2).await;
    });
}

/// 退出执行（后台线程）：停实例 + 清端口 + 关窗 + 刷新托盘 + 通知。
async fn exit_profile_instance_bg(app: &AppHandle, profile: &str) {
    if profile == crate::settings::configured_profile() {
        let state = app.state::<DshState>();
        state.main_worker.stop();
        crate::runtime::instances::remove_instance(profile);
        let port = crate::settings::port_for_profile(profile);
        let _ = crate::process::lifecycle::stop_port_owner(port).await;
        // 主窗「关窗」= 隐藏回托盘；Dock 菜单「显示主窗口」可唤回（重开 = 拉起并导航）
        if let Some(w) = app.get_webview_window("main") {
            // 主窗隐藏回托盘；Dock 菜单「显示主窗口」可唤回（#181 反馈定稿）
            let _ = w.hide();
        }
        show_notification(
            app,
            crate::network::notify_policy::scenario::INSTANCE_LIFECYCLE,
            &format!("{profile} 实例已退出"),
            "托盘「显示主窗口」可重新拉起",
        );
        crate::ui::tray::refresh_tray_mode(app);
        return;
    }
    // 次实例：停 worker + 摘台账 + 清端口，再关窗 UI（close 事件的 detach 为无害 no-op）
    let label = window_label(profile);
    close_profile_instance(app, profile, true);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    show_notification(
        app,
        crate::network::notify_policy::scenario::INSTANCE_LIFECYCLE,
        &format!("{profile} 实例已退出"),
        "已停止实例并关闭窗口",
    );
}
