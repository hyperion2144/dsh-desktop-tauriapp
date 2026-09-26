//! 共享运行时状态：DshState + 常量 + set_status + 全局静态。

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU8, Ordering},
        Mutex,
    },
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager};

// ── 接入模式 ──
pub(crate) const MODE_ADVANCED: u8 = 0;
pub(crate) const MODE_COMPAT: u8 = 1;

// ── 服务状态（侧边栏标识与守护器共用，经 dsh-status 事件广播）──
// ── 服务状态：两态（启动中 STARTING / 启动成功 READY），经 dsh-status 事件广播 ──
// 内置/外部、哪个运行时版本是「当前信息」（running_sources / get_dsh_source 通道），
// 不是生命周期状态，严禁混入此处（#135 重构拍板）。
pub(crate) const STATUS_STARTING: u8 = 1;
pub(crate) const STATUS_READY: u8 = 2;

/// 桌面壳的共享运行时状态（Tauri managed state）。
///
/// dsh 进程句柄不在本结构（由 process::worker 的 per-profile worker 唯一持有）；
pub(crate) struct DshState {
    /// 主实例 worker（激活 profile）：dsh 进程句柄唯一持有者，冷启动/重启/
    /// 守护器自愈等所有启动命令都经它（latest-wins，见 process::worker）。
    pub(crate) main_worker: crate::process::worker::DshWorker,
    /// 子进程是否由本次启动启动（决定退出时是否回收、重启时是否生效）。
    pub(crate) spawned_this_run: AtomicBool,
    /// 启动时端口已被外部 dsh web 占用（复用外部实例）：需要在加载页选择
    /// 兼容（复用、标准布局）或高级（停用外部实例、用桌面 overlay 实例重启）。
    pub(crate) mode_prompt_needed: AtomicBool,
    /// 当前接入模式（MODE_ADVANCED / MODE_COMPAT）。
    pub(crate) mode: AtomicU8,
    /// dsh 服务状态（STATUS_*）。
    pub(crate) status: AtomicU8,
    /// 内嵌启动加载页 URL（setup 抓取，重启/切换模式时回到该页）。
    pub(crate) loading_url: Mutex<Option<String>>,
    /// 托盘实例（供模式切换/重启后刷新「切换模式」标签用）。
    pub(crate) tray: Mutex<Option<tauri::tray::TrayIcon>>,
    /// spawn 失败标志（立即终止等待并跳错误页）。
    /// 是否已至少完成一次就绪导航（守护器只在就绪后介入）。
    pub(crate) ready_once: AtomicBool,
    /// 输入弹窗的确认通道（prompt_input 挂起，页面 ui_input_confirm 回填）。
    pub(crate) pending_input: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(String, String)>>>,
    /// 托盘"退出"标志（置位后放行窗口关闭与应用退出）。
    pub(crate) quitting: AtomicBool,
    /// 是否已提示过"隐藏到托盘"。
    pub(crate) tray_tip_shown: AtomicBool,
    /// 未读任务完成数（Dock 角标）。
    pub(crate) unread: AtomicU32,
    /// 桌宠上次落盘位置的时间（Moved 事件 400ms 防抖）。
    pub(crate) pet_save_at: Mutex<Option<Instant>>,
    /// 任务通知服务器端口（重启 dsh 后复用同一端口重新注入 JS）。
    pub(crate) notify_port: AtomicU16,
    /// 任务通知服务器访问 token（仅启动时生成一次，重启复用）。
    pub(crate) notify_token: Mutex<String>,
    /// dsh web 启动 URL 里的一次性 process token（stdout 解析；空 = 老版 dsh 未打印）。
    /// dsh 新版对不带 token 的请求返回 401；token 经 303 + Set-Cookie 换取 30 天会话
    /// cookie，进程存活期内可重复交换。仅内存保存，不落盘。
    pub(crate) web_token: Mutex<String>,
    /// 双击拖拽区"缩放"前的主窗口几何（None = 当前处于标准尺寸，可触发放大；
    /// Some = 当前已放大，再双击恢复到此几何）。Mutex 防并发双击。
    pub(crate) pre_zoom_geom: Mutex<Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>>,
    /// 每 profile 的 stderr 累积缓冲（spawn 时创建，转发线程写、退出通知读）。
    pub(crate) stderr_bufs: Mutex<std::collections::BTreeMap<String, crate::process::stderr_buf::SharedStderr>>,
    /// #89 次窗口：per-profile worker（打开次窗时创建；关窗时销毁并清理进程）。
    pub(crate) workers: Mutex<std::collections::BTreeMap<String, crate::process::worker::DshWorker>>,
    /// #89 多窗口：profile → 窗口 label（"profile-<name>"）。
    pub(crate) windows: Mutex<std::collections::BTreeMap<String, String>>,
    /// #89 多窗口：每 profile 的 dsh web process token（stdout 解析；激活 profile 另存 `web_token` 供主流程）。
    pub(crate) web_tokens: Mutex<std::collections::BTreeMap<String, String>>,
    /// #90：每 profile 实际使用的 dsh 来源（"builtin"/"external"，spawn 时记录；
    /// 设置 Tab 显示实际运行来源而非设置值——用户实测反馈）。
    pub(crate) running_sources: Mutex<std::collections::BTreeMap<String, String>>,
    pub(crate) skip_startup_check: AtomicBool,
    /// 启动时用户选择的 profile（dsh 启动后前端通过 nsSave 持久化到 settings.yaml）。
    pub(crate) pending_active_profile: Mutex<Option<String>>,
    pub(crate) downloads: crate::download::DownloadManager,
}

impl DshState {
    /// 写入 profile 的 stderr 缓冲（spawn 时调用；覆盖旧实例残留）。
    pub(crate) fn set_stderr_buf(
        &self,
        profile: &str,
        buf: crate::process::stderr_buf::SharedStderr,
    ) {
        self.stderr_bufs
            .lock()
            .unwrap()
            .insert(profile.to_string(), buf);
    }

    /// 取 profile 的 stderr 缓冲引用（可能不存在：非本壳 spawn 的实例）。
    pub(crate) fn stderr_buf_for(
        &self,
        profile: &str,
    ) -> Option<crate::process::stderr_buf::SharedStderr> {
        self.stderr_bufs
            .lock()
            .unwrap()
            .get(profile)
            .cloned()
    }

    /// 取 profile 的 stderr 尾部 N 行（实例退出通知展示用）。
    pub(crate) fn stderr_tail_for(&self, profile: &str, n: usize) -> Vec<String> {
        self.stderr_buf_for(profile)
            .map(|b| b.lock().unwrap().tail_lines(n))
            .unwrap_or_default()
    }
}

impl DshState {
    /// 绑定 profile → 窗口 label。
    pub(crate) fn bind_window(&self, profile: &str, label: String) {
        self.windows.lock().unwrap().insert(profile.to_string(), label);
    }

    /// 取 profile 的窗口 label。
    pub(crate) fn window_of(&self, profile: &str) -> Option<String> {
        self.windows.lock().unwrap().get(profile).cloned()
    }

    /// 解除绑定（窗口关闭/实例停止）。
    pub(crate) fn unbind_window(&self, profile: &str) {
        self.windows.lock().unwrap().remove(profile);
    }

    /// 反查窗口 label 当前绑定的 profile（#117：支持「在本窗口切换 profile」后
    /// 窗口 label 与 profile 不再一一对应，环境下发/托盘标记必须以此为准）。
    pub(crate) fn profile_of_window(&self, label: &str) -> Option<String> {
        self.windows
            .lock()
            .unwrap()
            .iter()
            .find(|(_, l)| l.as_str() == label)
            .map(|(p, _)| p.clone())
    }

    /// 取 per-profile web token（克隆语义；导航轮询反复取用）。
    pub(crate) fn web_token_for(&self, profile: &str) -> Option<String> {
        self.web_tokens.lock().unwrap().get(profile).cloned()
    }

    /// 记录/清除 profile 实际使用的 dsh 来源（spawn/停止时调用）。
    pub(crate) fn set_running_source(&self, profile: &str, source: &str) {
        self.running_sources
            .lock()
            .unwrap()
            .insert(profile.to_string(), source.to_string());
    }

    pub(crate) fn running_source_for(&self, profile: &str) -> Option<String> {
        self.running_sources.lock().unwrap().get(profile).cloned()
    }

    pub(crate) fn clear_running_source(&self, profile: &str) {
        self.running_sources.lock().unwrap().remove(profile);
    }
    /// 存 per-profile web token（spawn stdout 线程调用）。
    pub(crate) fn set_web_token(&self, profile: &str, token: String) {
        self.web_tokens
            .lock()
            .unwrap()
            .insert(profile.to_string(), token);
    }
}

/// 运行时放行的远程 dsh 主机清单（导航守卫读，托盘远程选择写）。
pub(crate) static INTERNAL_HOSTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// 设置并广播 dsh 服务状态（写 DshState + emit `dsh-status` 事件）。
pub(crate) fn set_status(app: &AppHandle, status: u8, detail: &str) {
    app.state::<DshState>().status.store(status, Ordering::SeqCst);
    let _ = app.emit(
        "dsh-status",
        serde_json::json!({ "status": status, "detail": detail }),
    );
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsh_state_default_field_types() {
        // DshState 新增字段（notify_port / notify_token）默认值校验。
        use std::sync::atomic::Ordering;
        let state = DshState {
            main_worker: crate::process::worker::DshWorker::new("web".into(), 3080, true),
            spawned_this_run: AtomicBool::new(false),
            mode_prompt_needed: AtomicBool::new(false),
            mode: AtomicU8::new(MODE_ADVANCED),
            status: AtomicU8::new(STATUS_STARTING),
            loading_url: Mutex::new(None),
            tray: Mutex::new(None),
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
            workers: Mutex::new(Default::default()),
            windows: Mutex::new(Default::default()),
            web_tokens: Mutex::new(Default::default()),
             running_sources: Mutex::new(Default::default()),
            skip_startup_check: AtomicBool::new(false),
            pending_active_profile: Mutex::new(None),
            downloads: crate::download::DownloadManager::default(),
        };
        assert_eq!(state.notify_port.load(Ordering::SeqCst), 0);
        assert!(state.notify_token.lock().unwrap().is_empty());
        assert!(state.pre_zoom_geom.lock().unwrap().is_none());
    }

    #[test]
    fn pre_zoom_geom_starts_unset() {
        // 双击放大前的几何必须从 None 起步，否则启动后第一次双击会把当前尺寸
        // 当成"已放大态"误恢复回去。
        let g = Mutex::new(None);
        assert!(g.lock().unwrap().is_none());
        *g.lock().unwrap() = Some((tauri::PhysicalPosition::new(100, 200),
                                    tauri::PhysicalSize::new(800, 600)));
        assert!(g.lock().unwrap().is_some());
    }

    #[test]
    fn multiwin_bindings_roundtrip() {
        // #89：窗口绑定与 per-profile token 的存取语义
        let state = DshState {
            main_worker: crate::process::worker::DshWorker::new("web".into(), 3080, true),
            spawned_this_run: AtomicBool::new(false),
            mode_prompt_needed: AtomicBool::new(false),
            mode: AtomicU8::new(MODE_ADVANCED),
            status: AtomicU8::new(STATUS_STARTING),
            loading_url: Mutex::new(None),
            tray: Mutex::new(None),
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
            workers: Mutex::new(Default::default()),
            windows: Mutex::new(Default::default()),
            web_tokens: Mutex::new(Default::default()),
            running_sources: Mutex::new(Default::default()),
            skip_startup_check: AtomicBool::new(false),
            pending_active_profile: Mutex::new(None),
            downloads: crate::download::DownloadManager::default(),
        };
        // 窗口绑定：写入/覆盖/解除
        state.bind_window("desktop", "profile-desktop".into());
        assert_eq!(state.window_of("desktop").as_deref(), Some("profile-desktop"));
        state.bind_window("desktop", "profile-desktop-2".into());
        assert_eq!(state.window_of("desktop").as_deref(), Some("profile-desktop-2"));
        state.unbind_window("desktop");
        assert!(state.window_of("desktop").is_none());
        // per-profile token：写入/读取
        state.set_web_token("desktop", "tok-1".into());
        assert_eq!(state.web_token_for("desktop").as_deref(), Some("tok-1"));
        assert!(state.web_token_for("web").is_none());
    }

}
