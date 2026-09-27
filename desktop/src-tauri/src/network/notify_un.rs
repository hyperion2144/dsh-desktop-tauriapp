//! macOS 通知 UNUserNotificationCenter 直连后端（#142）。
//!
//! 为什么存在：tauri-plugin-notification 桌面端在 macOS 上的 `request_permission`/
//! `permission_state` 是硬编码 Granted 的桩（从不触发系统授权窗），投递走 notify-rust →
//! mac-notification-sys 的 NSUserNotification legacy 后端（新 macOS 静默失败且从不调用
//! requestAuthorization），且插件 `show()` 内部吞掉全部投递错误——根因见 #130。
//! 故 macOS 弃用插件通知路径，直连 UN。Windows/Linux 不用本模块（插件路径活跃，见 notify.rs 分派）。
//!
//! 平台约束（ADR-0001）：本模块对应通知音三分语义的 `default` 档——走 OS 渠道默认音；
//! 自定义音的应用侧播放（rodio）属规格 #143 的后续工作，不在本模块。
//!
//! 仅打包 .app 可用：UNUserNotificationCenter 需要进程持有 bundle id，裸二进制（dev）
//! 没有，故 dev 下降级为日志提示，验收以打包 .app 为准。

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
/// 已弃用（用户拍板 2026-09-27）：osascript 兜底会以「脚本编辑器」身份投递，
/// 点击横幅打开错误应用，不可接受；授权被拒时改为引导用户到系统设置手动开启。
/// UN 授权被拒（含历史拒绝记录导致的静默拒绝）；置位后投递跳过 UN 直接返回失败。
static AUTH_DENIED: AtomicBool = AtomicBool::new(false);

/// 投递前提是否成立（进程内只判定一次：dev 标志与 bundle 注册状态运行期不变）。
fn usable() -> bool {
    static USABLE: OnceLock<bool> = OnceLock::new();
    *USABLE.get_or_init(|| {
        if tauri::is_dev() {
            log::info!(
                "[notify-un] dev 模式（裸二进制无 bundle id），UN 通知跳过；验收以打包 .app 为准"
            );
            return false;
        }
        if let Err(e) = mac_usernotifications::check_bundle() {
            log::warn!("[notify-un] bundle 检查失败，UN 通知不可用：{e}");
            return false;
        }
        true
    })
}

/// 申请系统通知权限：首次调用弹真授权窗（.alert/.sound/.badge），结果落日志。
///
/// 依赖 crate 的 blocking 包装（内部自行派发主线程，任意线程可调）；
/// lib.rs setup 阶段经 notify.rs 分派在异步任务里调用，不阻塞启动。
pub(crate) fn request_auth(_app: &AppHandle) {
    if !usable() {
        return;
    }
    match mac_usernotifications::blocking::request_auth() {
        Ok(true) => log::info!("[notify-un] 通知权限：已授予（UNUserNotificationCenter）"),
        Ok(false) => {
            AUTH_DENIED.store(true, Ordering::SeqCst);
            log::warn!(
                "[notify-un] 通知权限：被系统拒绝（无弹窗，多为历史拒绝记录或对 ad-hoc 签名的策略）；后续通知走 osascript 备份；可在系统设置→通知中手动开启"
            );
        }
        Err(e) => log::warn!("[notify-un] 申请通知权限失败：{e}"),
    }
}

/// 权限状态字符串（设置 tab 用）：granted / denied / not_determined / unavailable。
pub(crate) fn permission_state() -> &'static str {
    if !usable() {
        return "unavailable";
    }
    match mac_usernotifications::blocking::get_notification_settings() {
        Ok(s) => match s.authorization_status {
            mac_usernotifications::AuthorizationStatus::Authorized
            | mac_usernotifications::AuthorizationStatus::Provisional
            | mac_usernotifications::AuthorizationStatus::Ephemeral => "granted",
            mac_usernotifications::AuthorizationStatus::Denied => "denied",
            _ => "not_determined",
        },
        Err(_) => "unavailable",
    }
}

/// IPC 授权申请（设置 tab「申请权限」按钮）：未授予则弹真授权窗，返回最新状态。
pub(crate) fn request_auth_state() -> Result<String, String> {
    if !usable() {
        return Ok("unavailable".to_string());
    }
    match mac_usernotifications::blocking::request_auth() {
        Ok(true) => {
            AUTH_DENIED.store(false, Ordering::SeqCst);
            Ok("granted".to_string())
        }
        Ok(false) => {
            AUTH_DENIED.store(true, Ordering::SeqCst);
            Ok("denied".to_string())
        }
        Err(e) => Err(format!("申请通知权限失败：{e}")),
    }
}

/// 投递一条通知（标题 + 正文 + 系统默认音）。
///
/// 返回是否已成功提交给 UN；失败落日志由调用方决定兜底（本层不做静默吞错——
/// 插件路径「日志恒报成功」的教训见 #130）。
pub(crate) fn show(title: &str, body: &str, with_sound: bool) -> bool {
    if AUTH_DENIED.load(Ordering::SeqCst) || !usable() {
        return false; // 授权不可用：不投递（设置 tab 引导用户开启；不再用脚本编辑器身份兜底）
    }
    let mut n = mac_usernotifications::Notification::new()
        .title(title)
        .message(body);
    if with_sound {
        n = n.default_sound();
    }
    match n.send_blocking() {
        Ok(_) => {
            log::info!("[notify-un] 系统通知已投递：{title}");
            true
        }
        Err(e) => {
            log::warn!("[notify-un] UN 投递失败（{title}）：{e}");
            false
        }
    }
}
