//! 下载管理器的 Tauri 命令面（#72）。
//!
//! 全部命令供 dsh web 远程 origin 的 client 调用：permissions/app-commands.toml
//! 声明 allow-*，capabilities（default + remote-desktop）按需放行。

use tauri::{AppHandle, State};

use super::manager::{self, DownloadManager};
use super::model::DownloadTask;
use crate::DshState;

/// 全量任务快照（列表初始化；后续靠 downloads://changed 事件增量刷新）。
#[tauri::command]
pub(crate) fn list_downloads(state: State<DshState>) -> Vec<DownloadTask> {
    state.downloads.tasks.lock().unwrap().clone()
}

/// 暂停（URL 任务 .part 保留，可续传恢复）。
#[tauri::command]
pub(crate) fn pause_download(app: AppHandle, state: State<DshState>, id: u64) {
    let _ = state;
    manager::pause(&app, id);
}

/// 恢复（Paused/Failed → 排队 → 调度）。
#[tauri::command]
pub(crate) fn resume_download(app: AppHandle, state: State<DshState>, id: u64) {
    let _ = state;
    manager::resume(&app, id);
}

/// 取消（终止传输 + 清 .part）。
#[tauri::command]
pub(crate) fn cancel_download(app: AppHandle, state: State<DshState>, id: u64) {
    let _ = state;
    manager::cancel(&app, id);
}

/// 清空已完成（终态任务全部移除）。
#[tauri::command]
pub(crate) fn clear_finished_downloads(app: AppHandle, state: State<DshState>) {
    let _ = state;
    manager::clear_finished(&app)
}

/// 并发上限读取（桌面设置 Tab 回显）。
#[tauri::command]
pub(crate) fn get_download_settings(state: State<DshState>) -> serde_json::Value {
    serde_json::json!({ "concurrency": state.downloads.concurrency() })
}

/// 并发上限调整（1..=32，写 settings.yaml，立即补位）。
#[tauri::command]
pub(crate) fn set_download_concurrency(app: AppHandle, state: State<DshState>, value: u32) {
    let _ = state;
    manager::set_concurrency(&app, value);
}

/// 在系统文件管理器中显示（macOS Finder / Windows 资源管理器 / Linux 目录）。
#[tauri::command]
pub(crate) fn reveal_download(state: State<DshState>, id: u64) -> bool {
    let (target, exists) = {
        let tasks = state.downloads.tasks.lock().unwrap();
        match tasks.iter().find(|t| t.id == id) {
            Some(t) => (t.target_path.clone(), t.status == super::model::DownloadStatus::Completed),
            None => return false,
        }
    };
    if !exists {
        return false; // 未完成的任务目标文件不存在：定位 .part 无意义
    }
    reveal_path(&target)
}

/// 跨平台「在文件管理器中显示」。
fn reveal_path(path: &std::path::Path) -> bool {
    #[cfg(target_os = "macos")]
    let ok = std::process::Command::new("open").args(["-R", &path.to_string_lossy()]).spawn().is_ok();
    #[cfg(target_os = "windows")]
    let ok = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.to_string_lossy()))
        .spawn()
        .is_ok();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let ok = path
        .parent()
        .map(|dir| std::process::Command::new("xdg-open").arg(dir).spawn().is_ok())
        .unwrap_or(false);
    ok
}

/// blob 下载开始（client 拦截 blob:/data: 后调用；返回任务 id）。
#[tauri::command]
pub(crate) fn start_blob_download(app: AppHandle, state: State<DshState>, filename: String, total: Option<u64>) -> Option<u64> {
    let _ = state;
    manager::start_blob_download(&app, filename, total)
}

/// blob 分块写入（base64）。返回 false 时 JS 必须停发（任务已取消/暂停）。
#[tauri::command]
pub(crate) fn save_blob_chunk(app: AppHandle, state: State<DshState>, id: u64, chunk: String) -> bool {
    let _ = state;
    manager::save_blob_chunk(&app, id, chunk)
}

/// blob 分块结束（rename .part → 目标 + 通知）。
#[tauri::command]
pub(crate) fn finish_blob_download(app: AppHandle, state: State<DshState>, id: u64) -> bool {
    let _ = state;
    manager::finish_blob_download(&app, id)
}

// DownloadManager 在 State 里仅作类型锚点使用（命令经 manager 自由函数操作）
#[allow(dead_code)]
fn _manager_type_anchor(_: &DownloadManager) {}
