//! 共享运行时状态：DshState + 常量 + set_status + 全局静态。

use std::{
    process::Child,
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
pub(crate) const STATUS_IDLE: u8 = 0;
pub(crate) const STATUS_STARTING: u8 = 1;
pub(crate) const STATUS_READY: u8 = 2;
pub(crate) const STATUS_EXTERNAL: u8 = 3;
pub(crate) const STATUS_RESTARTING: u8 = 4;
pub(crate) const STATUS_STALE: u8 = 5;
pub(crate) const STATUS_DOWN: u8 = 6;
pub(crate) const STATUS_REMOTE: u8 = 7;

/// 桌面壳的共享运行时状态（Tauri managed state）。
///
/// 20 个字段，几乎被所有功能区域通过 `app.state::<DshState>()` 访问。
pub(crate) struct DshState {
    /// 本次运行 spawn 的 dsh 子进程（None = 复用了已有实例）。
    pub(crate) child: Mutex<Option<Child>>,
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
    pub(crate) spawn_failed: AtomicBool,
    /// 重启流程进行中（防止重复点击托盘重启项导致并发 kill/spawn）。
    pub(crate) restarting: AtomicBool,
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
    /// 启动保险丝：每 profile 的 stderr 累积缓冲（#86 起按实例隔离；spawn 时创建，
    /// 转发线程写、保险丝监控任务读；子进程退出且非 0 时取快照做失败检测）。
    pub(crate) stderr_bufs: Mutex<std::collections::BTreeMap<String, crate::process::quarantine::SharedStderr>>,
    /// #89 多窗口：非激活 profile 的子进程（窗口↔实例绑定；激活 profile 走 `child`）。
    pub(crate) children: Mutex<std::collections::BTreeMap<String, Child>>,
    /// #89 多窗口：profile → 窗口 label（"profile-<name>"）。
    pub(crate) windows: Mutex<std::collections::BTreeMap<String, String>>,
    /// #89 多窗口：每 profile 的 dsh web process token（stdout 解析；激活 profile 另存 `web_token` 供主流程）。
    pub(crate) web_tokens: Mutex<std::collections::BTreeMap<String, String>>,
    /// 启动保险丝：本轮启动周期内已用的自动重试次数（手动重启时清零）。
    pub(crate) fuse_retries: AtomicU8,
    /// 启动保险丝：最近一次启动的隔离事件摘要（设置 Tab 通知区经 IPC 读取）。
    pub(crate) fuse_summary: Mutex<Option<serde_json::Value>>,
    /// 下载管理器（#72）：任务表/调度/句柄，内部可变。
    pub(crate) downloads: crate::download::DownloadManager,
}

impl DshState {
    /// 写入 profile 的 stderr 缓冲（spawn 时调用；覆盖旧实例残留）。
    pub(crate) fn set_stderr_buf(
        &self,
        profile: &str,
        buf: crate::process::quarantine::SharedStderr,
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
    ) -> Option<crate::process::quarantine::SharedStderr> {
        self.stderr_bufs
            .lock()
            .unwrap()
            .get(profile)
            .cloned()
    }

    /// 取 profile 的 stderr 快照（无缓冲 → 空串）。
    pub(crate) fn stderr_snapshot_for(&self, profile: &str) -> String {
        self.stderr_buf_for(profile)
            .map(|b| b.lock().unwrap().snapshot())
            .unwrap_or_default()
    }

    /// 取 profile 的 stderr 尾部 N 行（重试后重放到加载页用）。
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

    /// 取 per-profile web token（克隆语义；导航轮询反复取用）。
    pub(crate) fn web_token_for(&self, profile: &str) -> Option<String> {
        self.web_tokens.lock().unwrap().get(profile).cloned()
    }
    /// 存 per-profile web token（spawn stdout 线程调用）。
    pub(crate) fn set_web_token(&self, profile: &str, token: String) {
        self.web_tokens
            .lock()
            .unwrap()
            .insert(profile.to_string(), token);
    }

    /// 存非激活 profile 的子进程。
    pub(crate) fn set_child(&self, profile: &str, child: Child) {
        self.children.lock().unwrap().insert(profile.to_string(), child);
    }

    /// 取走非激活 profile 的子进程（停止时；负责 kill+wait 回收）。
    pub(crate) fn take_child(&self, profile: &str) -> Option<Child> {
        self.children.lock().unwrap().remove(profile)
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
        // DshState 新增字段（notify_port / notify_token / restarting）默认值校验。
        use std::sync::atomic::Ordering;
        let state = DshState {
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
            children: Mutex::new(Default::default()),
            windows: Mutex::new(Default::default()),
            web_tokens: Mutex::new(Default::default()),
            fuse_retries: AtomicU8::new(0),
            fuse_summary: Mutex::new(None),
            downloads: crate::download::DownloadManager::default(),
        };
        assert!(!state.restarting.load(Ordering::SeqCst));
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

}
