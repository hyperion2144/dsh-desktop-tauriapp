//! 主窗口导航模块。
//!
//! 轮询就绪→导航到 Web GUI / 错误页 / 显示主窗。
//! NavigationStrategy 不引入 trait（#46 决议：正交 bool 组合）。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::runtime::state::{
    DshState, MODE_ADVANCED, STATUS_READY, STATUS_STARTING, set_status,
};
use crate::settings::{load_desktop_settings};
use crate::process::lifecycle::port_open;
use crate::network::web_token::{
    exchange_token_for_cookie, seed_session_cookie, session_cookie_accepts,
};
use crate::network::notify::inject_task_notifier;
use crate::network::remote::navigate_remote;

/// 轮询等待服务就绪，然后把主窗口导航到 Web GUI。
/// `nport`/`ntoken` 是通知桥的端口与令牌，导航完成后才注入监听脚本。
///
/// 启动无超时限制（产品要求），且严格按「后台交换成功才进入」执行：
/// ① spawn 场景无限等待 stdout 打印 process token（输出持续上屏）；
/// ② 在后台用 token 原生换取会话 cookie（不经任何界面），种入 webview，
///    并带 cookie 请求根路径确认服务端 200 —— 三步全绿才切换；
/// ③ 任一步失败都留在启动界面重试（dsh 输出持续上屏），绝不带着失败
///    状态跳转。成功后主窗口一次性直达根路径（cookie 随行，直接 200），
///    桌面 chrome 由 client 经 IPC 查询壳状态自行激活。
/// `epoch` = 本次启动任务版本（worker latest-wins：被更新任务抢占即让位）。
pub(crate) async fn wait_ready_and_navigate(app: AppHandle, epoch: u64, nport: u16, ntoken: String) {
    let state = app.state::<DshState>();
    // 远程模式：不探测/不 spawn 本地，直接导航远程页面
    if let Some(addr) = load_desktop_settings().remote_addr {
        let advanced = state.mode.load(std::sync::atomic::Ordering::SeqCst) == MODE_ADVANCED;
        navigate_remote(&app, &addr, advanced);
        return;
    }
    let port = state.main_worker.port();
    // spawn 场景才等 stdout 的 token 行（外部复用场景的 token 只能来自粘贴）
    let expect_token = state.spawned_this_run.load(std::sync::atomic::Ordering::SeqCst);
    let mut rounds = 0u32;
    loop {
        // latest-wins 让位：已有更新的启动任务接管（新任务会自己导航），
        // 本任务放弃，绝不把加载页导航到别人的实例。
        if state.main_worker.epoch() != epoch {
            log::info!("[nav] 任务 #{epoch} 已被任务 #{} 抢占，让位", state.main_worker.epoch());
            return;
        }
        // spawn 场景下子进程若已退出，绝不把加载页导航到死实例；
        if expect_token && state.main_worker.child_exited().is_some() {
            tokio::time::sleep(Duration::from_millis(400)).await;
            continue;
        }
        if state.quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let web_token = state.web_token.lock().unwrap().clone();
        // spawn 场景：无限等待 stdout 打印 token（无超时）；dsh 未就绪/挂掉都
        // 停留在启动界面（其输出已流式上屏，供用户查看）
        if expect_token && web_token.is_empty() {
            tokio::time::sleep(Duration::from_millis(400)).await;
            continue;
        }
        if !port_open(port) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        let host_port = format!("127.0.0.1:{port}");
        // 无 token（老版 dsh 外部实例且未粘贴 token）：无鉴权直连（旧行为）
        if web_token.is_empty() {
            let url = format!("http://127.0.0.1:{port}/");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("window.location.replace({url:?});"));
                inject_task_notifier(app.clone(), nport, &ntoken);
            }
            log::info!("本地服务就绪，已导航到 {url}");
            set_status(&app, STATUS_READY, "运行中");
            app.state::<DshState>().ready_once.store(true, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        rounds += 1;
        // ①② 后台交换 cookie 并验证服务端接受（全程不经界面，启动界面保持显示）
        let Some((name, value)) = exchange_token_for_cookie(&host_port, &web_token) else {
            if rounds % 5 == 1 {
                log::warn!("[nav] 会话 cookie 交换未成功，继续等待（第 {rounds} 轮）");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        };
        if !seed_session_cookie(&app, "127.0.0.1", port, &name, &value) {
            // set_cookie 平台不支持：回退 token 直开（此时会经 303 换 cookie，
            // 可能有短暂白屏，属于平台能力降级而非常规路径）
            log::warn!("[nav] 原生种 cookie 不可用，回退 token 直开路径");
            let url = format!("http://127.0.0.1:{port}/?token={web_token}");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("window.location.replace({url:?});"));
                inject_task_notifier(app.clone(), nport, &ntoken);
            }
            log::info!("本地服务就绪，已导航到 {url}");
            set_status(&app, STATUS_READY, "运行中");
            app.state::<DshState>().ready_once.store(true, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        // ③ 验证服务端确实接受种入的 cookie（不经验证不切换）
        if !session_cookie_accepts(&host_port, &name, &value) {
            if rounds <= 10 {
                log::warn!("[nav] 第 {rounds} 轮会话验证未通过，留在启动界面重试");
                set_status(&app, STATUS_STARTING, "重新建立会话…");
                tokio::time::sleep(Duration::from_millis(1000)).await;
                continue;
            }
            log::error!("[nav] 连续 {rounds} 轮会话验证失败，停留在启动界面（请查看 dsh 输出）");
            return;
        }
        log::info!("[nav] 后台会话已建立并验证通过（第 {rounds} 轮），进入 Web GUI");
        // ④ 后台全绿：主窗口一次性直达根路径（cookie 随行，直接 200）
        let url = format!("http://127.0.0.1:{port}/");
        if let Some(w) = app.get_webview_window("main") {
            if let Err(e) = w.eval(&format!("window.location.replace({url:?});")) {
                log::warn!("窗口导航失败：{e}");
                return;
            }
            inject_task_notifier(app.clone(), nport, &ntoken);
        }
        log::info!("本地服务就绪，已导航到 {url}");
        set_status(&app, STATUS_READY, "运行中");
        app.state::<DshState>().ready_once.store(true, std::sync::atomic::Ordering::SeqCst);
        return;
    }
}
