//! dsh 进程的 per-profile 起居管理者（worker）。
//!
//! 一个 profile 一个 worker：主窗口管理激活 profile（主 worker，存于
//! `DshState::main_worker`），次窗口在打开时为自己的 profile 创建独立 worker
//! （存于 `DshState::workers`）；次窗口不可重启，只能关闭——关闭窗口即销毁
//! worker，worker 自行清理该 profile 的 dsh 进程（[`DshWorker::shutdown`]）。
//!
//! worker 对其 dsh 进程完整掌控：进程句柄唯一存于 worker 内部，壳的任何区域
//! 都不再直接持有或启停 dsh 进程。所有启动命令都经 worker 的分层入口：
//!
//! - [`DshWorker::begin_start`]：latest-wins 第一步——递增任务版本（旧任务在
//!   各自步骤发现落后即让位）+ 杀掉当前进程（无论运行中/启动中/刚拉起）+
//!   状态置「启动中」；
//! - [`DshWorker::spawn_now`]：同步拉起进程并交由 worker 掌管（全壳唯一的
//!   spawn 入口；调用前需先 begin_start 并完成端口清理）；
//! - [`DshWorker::request_start`]：主实例便捷组合——begin_start + 后台
//!   （端口清理 → spawn → 就绪导航，成功置「运行中」）。
//!
//! 状态只有「启动中/运行中」两态：进入启动流程立即置「启动中」，就绪导航完成
//! 置「运行中」。守护器只在「运行中」时检查健康，异常时经 worker 排队
//! （同样走 `request_start`），不自行拉起。

use std::{
    process::{Child, ExitStatus},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use tauri::{AppHandle, Manager};

use crate::{
    network::web_token::clear_web_token,
    runtime::{
        error::SpawnError,
        state::{set_status, DshState, MODE_ADVANCED, MODE_COMPAT, STATUS_STARTING},
    },
    ui::window::show_error,
};

/// 一个 profile 的 dsh 进程 worker：进程句柄的唯一持有者与唯一启停入口。
pub(crate) struct DshWorker {
    /// 管理目标 (profile, port)。Mutex 内部可变：DshState 经 Tauri State 只给
    /// 共享引用，主 worker 切换 Profile 时靠它原地改目标（retarget）。
    target: Mutex<(String, u16)>,
    /// 主实例（激活 profile，主窗口）：启动流程会翻转全局运行状态并触发
    /// 主窗就绪导航；次实例（次窗口）不碰全局状态。
    main: bool,
    /// 当前掌管的 dsh 子进程；None = 未拉起 / 复用了外部实例。
    child: Mutex<Option<Child>>,
    /// 启动任务版本号：每次 begin_start 递增；后台步骤发现落后即让位
    /// （latest-wins：新任务立即抢占，不等上一个完成）。
    epoch: AtomicU64,
}

impl DshWorker {
    pub(crate) fn new(profile: String, port: u16, main: bool) -> Self {
        Self {
            target: Mutex::new((profile, port)),
            main,
            child: Mutex::new(None),
            epoch: AtomicU64::new(0),
        }
    }

    /// 目标快照 (profile, port)。
    fn target_snapshot(&self) -> (String, u16) {
        self.target.lock().unwrap().clone()
    }

    pub(crate) fn profile(&self) -> String {
        self.target_snapshot().0
    }

    pub(crate) fn port(&self) -> u16 {
        self.target.lock().unwrap().1
    }

    /// 当前任务版本号（后台步骤用于 latest-wins 让位判断）。
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// 主实例当前是否由壳拉起（区别于复用外部实例）。
    pub(crate) fn has_child(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    /// 子进程是否已退出（try_wait，不取走句柄；供就绪导航的退出检测）。
    pub(crate) fn child_exited(&self) -> Option<ExitStatus> {
        self.child
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|c| c.try_wait().ok())
            .flatten()
    }

    /// 切换管理目标（主 worker 切 Profile）：旧实例句柄留在 worker 里，由下一
    /// 次 request_start 的「杀掉旧的」步骤清理——对切换后的 worker 而言，旧
    /// profile 的实例就是必须先停掉的「旧的」。
    pub(crate) fn retarget(&self, profile: String, port: u16) {
        *self.target.lock().unwrap() = (profile, port);
    }

    /// 停掉当前掌管的 dsh 进程（任何状态：运行中 / 启动中 / 刚拉起）。
    pub(crate) fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let profile = self.profile();
            log::info!("[worker:{profile}] 停掉当前 dsh 进程（PID {}）", child.id());
            let _ = child.kill();
            let _ = child.wait();
            log::info!("[worker:{profile}] 旧 dsh 已退出");
        }
    }

    /// 销毁 worker（关闭次窗口）：worker 自行清理其 dsh 进程。
    pub(crate) fn shutdown(&self) {
        self.stop();
    }

    /// 启动任务第一步（latest-wins）：递增任务版本使旧任务让位，杀掉当前进程
    /// （任何状态），状态置「启动中」；主实例同时翻转全局标志——ready_once
    /// 落回 false（守护器只在「运行中」检查，提前让位）。返回本次任务版本号。
    pub(crate) fn begin_start(&self, app: &AppHandle, advanced: bool) -> u64 {
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        // 「启动新的必须停掉旧的」：无论旧进程处于什么状态，立即杀。
        self.stop();
        if self.main {
            let state = app.state::<DshState>();
            set_status(app, STATUS_STARTING, "启动中");
            state.ready_once.store(false, Ordering::SeqCst);
            state.spawned_this_run.store(true, Ordering::SeqCst);
            state.mode.store(
                if advanced { MODE_ADVANCED } else { MODE_COMPAT },
                Ordering::SeqCst,
            );
        }
        epoch
    }

    /// 拉起进程并交由 worker 掌管（同步；**全壳唯一的 spawn 入口**）。
    /// 调用方需先 [`DshWorker::begin_start`] 并完成端口清理（stop_port_owner）。
    pub(crate) fn spawn_now(&self, app: &AppHandle, advanced: bool) -> Result<(), SpawnError> {
        if self.main {
            // 先清旧 token：新实例 token 必然不同，残留会误导宽限窗口内的导航
            clear_web_token(app);
        }
        let (profile, port) = self.target_snapshot();
        match crate::process::lifecycle::spawn_dsh(app, &profile, port, advanced) {
            Ok(child) => {
                log::info!(
                    "[worker:{profile}] 任务 #{}：dsh 已拉起（PID {}）",
                    self.epoch(),
                    child.id()
                );
                *self.child.lock().unwrap() = Some(child);
                Ok(())
            }
            Err(e) => {
                let msg = match &e {
                    SpawnError::NotFound(s) | SpawnError::Other(s) => s.clone(),
                };
                log::error!("[worker:{profile}] spawn 失败：{msg}");
                Err(e)
            }
        }
    }

    /// 主实例便捷组合：begin_start → 后台（端口清理 → 让位检查 → spawn →
    /// 标题栏 → 就绪导航）。就绪导航成功置「运行中」；spawn 失败进对应错误页。
    pub(crate) fn request_start(&self, app: &AppHandle, advanced: bool) {
        let epoch = self.begin_start(app, advanced);
        let handle = app.clone();
        let (profile, port) = self.target_snapshot();
        tauri::async_runtime::spawn(async move {
            // 端口级兜底清理：外部实例 / 残留进程不归 child 句柄管，杀端口占用者
            if !crate::process::lifecycle::stop_port_owner(port).await {
                log::error!(
                    "[worker:{profile}] 任务 #{epoch}：端口 {port} 未能停用/释放，启动中止"
                );
                show_error(&handle, "timeout");
                return;
            }
            // latest-wins 让位：已有更新的启动任务接管
            if handle.state::<DshState>().main_worker.epoch() != epoch {
                log::info!("[worker:{profile}] 任务 #{epoch}：已被更新任务抢占，让位");
                return;
            }
            if let Err(e) = handle.state::<DshState>().main_worker.spawn_now(&handle, advanced) {
                match &e {
                    SpawnError::NotFound(_) => show_error(&handle, "not-found"),
                    SpawnError::Other(_) => show_error(&handle, "spawn-failed"),
                }
                return;
            }
            crate::ui::tray::apply_titlebar(&handle, advanced);
            let state = handle.state::<DshState>();
            let nport = state.notify_port.load(Ordering::SeqCst);
            let ntoken = state.notify_token.lock().unwrap().clone();
            crate::navigation::wait_ready_and_navigate(handle, epoch, nport, ntoken).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_worker_starts_clean() {
        let w = DshWorker::new("web".into(), 3080, true);
        assert_eq!(w.profile(), "web".to_string());
        assert_eq!(w.port(), 3080);
        assert_eq!(w.epoch(), 0);
        assert!(!w.has_child());
        assert!(w.child_exited().is_none());
        // 停 / 销毁在无进程时是安全的 no-op
        w.stop();
        w.shutdown();
    }

    #[test]
    fn retarget_swaps_target() {
        let w = DshWorker::new("web".into(), 3080, true);
        w.retarget("desktop".into(), 3081);
        assert_eq!(w.profile(), "desktop".to_string());
        assert_eq!(w.port(), 3081);
        // 版本号不受 retarget 影响（仍为 0：只有 begin_start 递增）
        assert_eq!(w.epoch(), 0);
    }
}
