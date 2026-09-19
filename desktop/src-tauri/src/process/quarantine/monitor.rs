//! 保险丝监控任务（#58）：dsh 子进程意外退出 → 隔离 → 自动重试。
//!
//! 触发点唯一且明确：「进程退出 + exit code ≠ 0」（#54：端口在 settle 前 ~2.9s
//! 就会 LISTEN，不能当就绪信号）。且仅限启动期（ready_once=false）：运行期进程异常归守护器（#71）。

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::process::lifecycle::{spawn_dsh, stop_port_owner};
use crate::process::plugin::desktop_plugin_patch_path;
use crate::process::quarantine::{self, fuse_settings};
use crate::network::notify::show_notification;
use crate::network::web_token::clear_web_token;
use crate::runtime::state::{
    DshState, MODE_ADVANCED, STATUS_STARTING, set_status,
};
use crate::settings::{configured_profile, dsh_home, load_desktop_settings, port_for_profile};
use crate::ui::window::show_error;
use crate::ui::tray::navigate_to_loading;
use crate::navigation::wait_ready_and_navigate;

/// 在 setup 里启动一次，常驻：每 700ms 轮询子进程退出状态。
pub(crate) fn start(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { monitor(handle).await });
}

async fn monitor(app: AppHandle) {
    loop {
        if app.state::<DshState>().quitting.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
        let state = app.state::<DshState>();
        // 保险丝只管启动期（ready_once=false）：运行期进程异常归守护器（#71 分工）。
        // 只看自家 spawn 的实例；重启中/已判失败/外部复用/已就绪运行中都不介入
        if !state.spawned_this_run.load(Ordering::SeqCst)
            || state.restarting.load(Ordering::SeqCst)
            || state.spawn_failed.load(Ordering::SeqCst)
            || state.ready_once.load(Ordering::SeqCst)
        {
            continue;
        }
        let status = state
            .child
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|c| c.try_wait().ok())
            .flatten();
        let Some(status) = status else { continue };
        // 子进程已退出。成功退出（0）但仍在托管期 = 异常死亡（无报错上下文）；
        // 非 0 = 启动失败，走隔离。
        // #86：stderr 缓冲按 profile 分桶，退出检测取对应实例的快照
        let profile = configured_profile();
        let stderr = state.stderr_snapshot_for(&profile);
        drop(state);
        if status.success() {
            log::warn!("[fuse] dsh 子进程意外退出（exit 0），无失败上下文可隔离");
            fail_closed(&app, "dsh 进程意外退出（exit 0），请查看日志");
            continue;
        }
        let settings = load_desktop_settings();
        let inject = desktop_plugin_patch_path(&app);
        let outcome = quarantine::run_cycle(&dsh_home(), &profile, Some(&inject), &stderr, &settings);
        let (fp, _exclude, max_retries) = fuse_settings(&settings);
        let _ = fp;
        let used = app
            .state::<DshState>()
            .fuse_retries
            .fetch_add(1, Ordering::SeqCst);
        let summary = serde_json::json!({
            "disabled": outcome.disabled.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
            "skipped": outcome.skipped,
            "environmental": outcome.environmental,
            "patch_parse": outcome.patch_parse,
            "deduped": outcome.deduped,
            "retried": used + 1,
            "at": chrono_like_now(),
        });
        *app.state::<DshState>().fuse_summary.lock().unwrap() = Some(summary.clone());
        let _ = app.emit("fuse://boot-summary", summary);
        log::warn!(
            "[fuse] dsh 启动失败（exit {}）：禁用 {} 个，跳过 {} 个，环境类={}，patch解析={}，dedupe={}，重试 {}/{}",
            status.code().unwrap_or(-1),
            outcome.disabled.len(),
            outcome.skipped.len(),
            outcome.environmental,
            outcome.patch_parse,
            outcome.deduped,
            used + 1,
            max_retries
        );
        if !outcome.disabled.is_empty() && used < max_retries {
            let names: Vec<String> = outcome.disabled.iter().map(|e| e.id.clone()).collect();
            let note = format!(
                "已禁用 {}，正在重试启动（第 {}/{} 次）",
                names.join("、"),
                used + 1,
                max_retries
            );
            show_notification(
                &app,
                "插件保险丝 · 已自动禁用不兼容插件",
                &format!("{note}"),
            );
            respawn(&app, &profile, note).await;
        }
        // 无可隔离 / 重试预算用尽 → 停在错误页
        let reason = if outcome.patch_parse {
            "patch 文件解析失败（YAML 语法错误），需人工修复"
        } else if outcome.environmental && outcome.disabled.is_empty() {
            "环境类失败（端口占用/权限等），非插件不兼容"
        } else if outcome.disabled.is_empty() {
            "未检出可自动禁用的插件"
        } else {
            "重试次数已用尽"
        };
        log::error!("[fuse] 启动保险丝放弃自动重试：{reason}");
        fail_closed(&app, reason);
    }
}

/// 失败收尾：置 spawn_failed（导航/watchdog 都会让位），导航到错误页。
/// 失败收尾：置 spawn_failed；stderr 尾部落盘 + 回放到页面控制台（#90 实测：
/// 冷启动早期事件在页面 listener 就绪前丢失，控制台全空、用户无诊断线索）。
fn fail_closed(app: &AppHandle, reason: &str) {
    let state = app.state::<DshState>();
    state.spawn_failed.store(true, Ordering::SeqCst);
    let profile = crate::settings::configured_profile();
    let tail = state.stderr_tail_for(&profile, 40).join("\n");
    // 落盘：~/.dsh/dsh-desktop-tauriapp/last-boot-failure.log（诊断证据）
    let dir = crate::settings::dsh_home().join("dsh-desktop-tauriapp");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(
        dir.join("last-boot-failure.log"),
        format!("time: {}\nprofile: {}\nreason: {}\n\n{}\n", chrono_like_now(), profile, reason, tail),
    );
    drop(state);
    for line in tail.lines() {
        let _ = app.emit("dsh-console", serde_json::json!({ "stream": "stderr", "line": line }));
    }
    show_notification(app, "dsh 启动失败", reason);
    show_error(app, "boot-failed");
}

/// 隔离后重试：确保端口释放 → 清 token → 重新 spawn → 重新进入就绪导航。
async fn respawn(app: &AppHandle, profile: &str, note: String) {
    let port = port_for_profile(profile);
    // 旧子进程已退出，但端口可能仍被占用（TIME_WAIT/晚退出的子进程）：
    // stop_port_owner 会先 SIGTERM 再 SIGKILL，纯代码跨平台。
    let freed = stop_port_owner(port).await;
    if !freed {
        log::error!("[fuse] 重试前端口 {port} 未释放，转失败收尾");
        fail_closed(app, &format!("重试前端口 {port} 未释放"));
        return;
    }
    set_status(app, STATUS_STARTING, "保险丝重试启动");
    clear_web_token(app);
    match spawn_dsh(app, profile, port, true) {
        Ok(child) => {
            let state = app.state::<DshState>();
            log::info!("[fuse] 重试 spawn 成功（PID {}）", child.id());
            *state.child.lock().unwrap() = Some(child);
            state.spawned_this_run.store(true, Ordering::SeqCst);
            state.mode.store(MODE_ADVANCED, Ordering::SeqCst);
            state.ready_once.store(false, Ordering::SeqCst);
            state.spawn_failed.store(false, Ordering::SeqCst);
            drop(state);
            navigate_to_loading(app);
            // 内嵌加载页的事件监听需要 ~1s 才就绪；就绪后重放缓冲尾部 + 保险丝状态行，
            // 否则重试实例的早期输出全部丢失，加载页日志看起来像卡死（用户实测）。
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let tail = app.state::<DshState>().stderr_tail_for(profile, 40);
            for line in &tail {
                let _ = app.emit(
                    "dsh-console",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
            let _ = app.emit(
                "dsh-console",
                serde_json::json!({ "stream": "stdout", "line": format!("[保险丝] {note}——以上为重放日志，下方为新实例输出") }),
            );
            let nport = app.state::<DshState>().notify_port.load(Ordering::SeqCst);
            let ntoken = app.state::<DshState>().notify_token.lock().unwrap().clone();
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                wait_ready_and_navigate(h, port, nport, ntoken).await;
            });
        }
        Err(e) => {
            let msg = match &e {
                crate::runtime::error::SpawnError::NotFound(s)
                | crate::runtime::error::SpawnError::Other(s) => s.clone(),
            };
            log::error!("[fuse] 重试 spawn 失败：{msg}");
            fail_closed(app, &format!("重试 spawn 失败：{msg}"));
        }
    }
}

/// 与台账时间戳同款的本地时间串（monitor 摘要用）。
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    #[cfg(not(target_os = "windows"))]
    {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        let t: libc::time_t = secs as libc::time_t;
        unsafe {
            libc::localtime_r(&t, &mut tm);
        }
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec
        )
    }
    #[cfg(target_os = "windows")]
    {
        format!("epoch-{secs}")
    }
}
