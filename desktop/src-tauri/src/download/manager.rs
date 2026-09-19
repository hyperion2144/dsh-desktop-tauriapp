//! 下载管理器：任务表、并发调度、保存对话框、暂停/恢复/取消、blob 分块
//! 管线、事件广播与并发设置。
//!
//! #72。所有状态变化的唯一入口；持久化（tasks.json）与前端事件
//! （`downloads://changed`，全量快照）都从这里发出。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use super::model::{chrono_now_secs, filename_from_url, sanitize_filename, DownloadKind, DownloadStatus, DownloadTask};
use super::persist::{self, part_path, prune, save_tasks};
use super::transfer;

/// 前端事件名：payload = 全量任务快照（serde_json::Value 数组）。
pub(crate) const EVENT_CHANGED: &str = "downloads://changed";

/// 管理器（放进 DshState，内部可变）。
pub(crate) struct DownloadManager {
    /// 新任务在前（列表展示顺序）；锁内短暂持有，IO 一律在锁外。
    pub(crate) tasks: Mutex<Vec<DownloadTask>>,
    /// 进行中传输的 abort 句柄（URL 任务）。
    handles: Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
    next_id: AtomicU64,
    concurrency: AtomicU32,
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadManager {
    pub(crate) fn new() -> Self {
        let manager = Self {
            tasks: Mutex::new(persist::load_tasks()),
            handles: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            concurrency: AtomicU32::new(crate::settings::configured_download_concurrency()),
        };
        // next_id 压过恢复表里的最大 id，避免重启后 id 复用
        if let Ok(tasks) = manager.tasks.lock() {
            let max_id = tasks.iter().map(|t| t.id).max().unwrap_or(0);
            manager.next_id.store(max_id + 1, Ordering::SeqCst);
        }
        manager
    }

    pub(crate) fn concurrency(&self) -> u32 {
        self.concurrency.load(Ordering::SeqCst)
    }
}

// ── 工具 ──────────────────────────────────────────────

/// 用户默认下载目录（无 home 时退到当前目录）。
fn default_download_dir() -> PathBuf {
    dirs_like_download_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// 轻量 dirs::download_dir（不引 dirs crate：macOS ~/Downloads、Windows known folder
/// 退注册表外的通用场景、Linux XDG_DOWNLOAD_DIR 解析失败退 ~/Downloads）。
fn dirs_like_download_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(home.join("Downloads"))
}

/// 保存框默认路径：下载目录 + 建议 filename；若同目录目标名与 .part 均已存在，
/// 追加 " (n)" 编号（与浏览器行为一致，避免静默覆盖）。
fn default_target(filename: &str) -> PathBuf {
    let dir = default_download_dir();
    let mut candidate = dir.join(filename);
    let stem = {
        let name = sanitize_filename(filename);
        let (stem, ext) = name.rsplit_once('.').unwrap_or((name.as_str(), ""));
        (stem.to_string(), if ext.is_empty() { String::new() } else { format!(".{ext}") })
    };
    let mut n = 1;
    while candidate.exists()
        || candidate.with_file_name(format!("{}.part", candidate.file_name().and_then(|s| s.to_str()).unwrap_or(""))).exists()
    {
        candidate = dir.join(format!("{} ({}){}", stem.0, n, stem.1));
        n += 1;
    }
    candidate
}

/// 快照（锁内克隆 → 锁外序列化）。
fn snapshots(app: &AppHandle) -> Vec<DownloadTask> {
    let state = app.state::<crate::DshState>();
    let list = state.downloads.tasks.lock().unwrap().clone();
    list
}

/// 广播全量快照（锁外；失败仅记日志）。
pub(crate) fn emit_changed(app: &AppHandle) {
    let list = snapshots(app);
    if let Err(e) = app.emit(EVENT_CHANGED, &list) {
        log::warn!("[downloads] 事件广播失败：{e}");
    }
}

/// 锁内更新任务 + 落盘 + 广播的统一出口（更新器返回 false 表示任务不存在）。
fn mutate_task(app: &AppHandle, id: u64, f: impl FnOnce(&mut DownloadTask) -> bool) -> bool {
    let state = app.state::<crate::DshState>();
    let mut tasks = state.downloads.tasks.lock().unwrap();
    let Some(task) = tasks.iter_mut().find(|t| t.id == id) else {
        return false;
    };
    if !f(task) {
        return false;
    }
    task.touch();
    let snapshot = tasks.clone();
    let pruned = prune(snapshot);
    drop(tasks);
    save_tasks(&pruned);
    {
        let mut tasks = state.downloads.tasks.lock().unwrap();
        *tasks = pruned;
    }
    drop(state);
    emit_changed(app);
    true
}

/// 供 transfer 取 .part 路径（任务可能已被清理：返回 None）。
pub(crate) fn part_path_of(app: &AppHandle, id: u64) -> Option<PathBuf> {
    let state = app.state::<crate::DshState>();
    let tasks = state.downloads.tasks.lock().unwrap();
    tasks.iter().find(|t| t.id == id).map(part_path)
}

// ── 入口：URL 下载（on_download Requested 转交） ──────────────

/// 新 URL 任务：先弹保存框（默认名来自 URL 尾段 / wry 建议名），
/// 选择后入队调度；取消保存框 = 任务即取消（保留记录）。
pub(crate) fn start_url_download(app: &AppHandle, url: String, suggested_name: Option<String>) {
    let filename = suggested_name
        .as_deref()
        .map(sanitize_filename)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| filename_from_url(&url));
    let id = {
        let state = app.state::<crate::DshState>();
        let id = state.downloads.next_id.fetch_add(1, Ordering::SeqCst);
        let task = DownloadTask {
            id,
            kind: DownloadKind::Url,
            url: url.clone(),
            filename: filename.clone(),
            target_path: default_target(&filename),
            total: None,
            received: 0,
            etag: None,
            resumed: false,
            status: DownloadStatus::ChoosingPath,
            error: None,
            created_at: chrono_now_secs(),
            updated_at: chrono_now_secs(),
        };
        state.downloads.tasks.lock().unwrap().insert(0, task);
        id
    };
    emit_changed(app);
    log::info!("[downloads] 新任务 #{id}：{url}");

    // 保存框（tauri-plugin-dialog 回调式；默认目录 + 建议名，可改名可取消）
    let app = app.clone();
    app.dialog()
        .file()
        .set_directory(default_download_dir())
        .set_file_name(&filename)
        .save_file(move |path| {
            let picked = path.and_then(|p| p.as_path().map(|p| p.to_path_buf()));
            match picked {
                Some(target) => {
                    let name = target
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(sanitize_filename)
                        .unwrap_or_else(|| filename.clone());
                    let updated = mutate_task(&app, id, |t| {
                        if t.status != DownloadStatus::ChoosingPath {
                            return false; // 已被并发取消
                        }
                        t.target_path = target.clone();
                        t.filename = name;
                        t.status = DownloadStatus::Queued;
                        true
                    });
                    if updated {
                        schedule(&app);
                    }
                }
                None => {
                    mutate_task(&app, id, |t| {
                        if t.status == DownloadStatus::ChoosingPath {
                            t.status = DownloadStatus::Cancelled;
                            t.error = Some("未选择保存位置".into());
                            return true;
                        }
                        false
                    });
                }
            }
        });
}

// ── 调度 ───────────────────────────────────────────────

/// 并发闸门：把排队中的 URL 任务补进空位（blob 任务 JS 推流，不占闸门）。
pub(crate) fn schedule(app: &AppHandle) {
    let state = app.state::<crate::DshState>();
    let limit = state.downloads.concurrency() as usize;
    let mut to_start: Vec<(u64, String, u64, Option<String>)> = Vec::new();
    {
        let tasks = state.downloads.tasks.lock().unwrap();
        let active = tasks
            .iter()
            .filter(|t| t.kind == DownloadKind::Url && t.status == DownloadStatus::Downloading)
            .count();
        let slots = limit.saturating_sub(active);
        if slots == 0 {
            return;
        }
        // 表是新任务在前：倒序扫描取最老的排队任务先启动（FIFO 语义）
        for t in tasks.iter().rev() {
            if to_start.len() >= slots {
                break;
            }
            if t.kind == DownloadKind::Url && t.status == DownloadStatus::Queued {
                to_start.push((t.id, t.url.clone(), t.received, t.etag.clone()));
            }
        }
    }
    for (id, url, resume_from, etag) in to_start {
        // 占位：Queued → Downloading（transfer 回写进度前 UI 即见状态）
        mutate_task(app, id, |t| {
            if t.status == DownloadStatus::Queued {
                t.status = DownloadStatus::Downloading;
                return true;
            }
            false
        });
        let app = app.clone();
        let handle = tauri::async_runtime::spawn(async move {
            transfer::run_url_transfer(app.clone(), id, url, resume_from, etag).await;
        });
        // 极快完成的任务此刻可能已终态：句柄只对仍 Downloading 的任务登记，
        // 避免残留死句柄（M3）
        let still_running = {
            let tasks = state.downloads.tasks.lock().unwrap();
            tasks
                .iter()
                .any(|t| t.id == id && t.status == DownloadStatus::Downloading)
        };
        if still_running {
            if let Ok(mut handles) = state.downloads.handles.lock() {
                handles.insert(id, handle);
            }
        }
    }
}

// ── transfer 回写 ──────────────────────────────────────

/// 进度回写（etag 仅在响应建立时传 Some，进度期传 None 不覆盖）。
pub(crate) fn update_progress(
    app: &AppHandle,
    id: u64,
    received: u64,
    total: Option<u64>,
    etag: Option<String>,
    resumed: bool,
) {
    let state = app.state::<crate::DshState>();
    {
        let mut tasks = state.downloads.tasks.lock().unwrap();
        let Some(task) = tasks.iter_mut().find(|t| t.id == id) else { return };
        if task.status != DownloadStatus::Downloading {
            return; // 已被暂停/取消：迟到的进度丢弃
        }
        task.received = received;
        task.total = total;
        if etag.is_some() {
            task.etag = etag;
        }
        task.resumed = resumed;
    }
    drop(state);
    emit_changed(app);
}

/// 传输终态回写：Ok = 完成（rename .part → 目标 + 系统通知）；Err = 失败。
/// 之后释放句柄、持久化、调度补位。
pub(crate) fn on_task_finished(app: &AppHandle, id: u64, result: Result<(), String>) {
    if let Ok(mut handles) = app.state::<crate::DshState>().downloads.handles.lock() {
        handles.remove(&id);
    }
    match result {
        Ok(()) => {
            // rename 在锁内 CAS 之后执行：pause 抢先时状态已非 Downloading，
            // updater 返回 false、rename 不动——.part 留给续传，消除「rename 走了
            // 但任务卡 Paused」的死锁（同名目录 rename 微秒级，锁内可接受）。
            let mut completed_name: Option<String> = None;
            let ok = mutate_task(app, id, |t| {
                if t.status != DownloadStatus::Downloading {
                    return false;
                }
                if let Some(dir) = t.target_path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let renamed = std::fs::rename(part_path(t), &t.target_path);
                completed_name = Some(t.filename.clone());
                match renamed {
                    Ok(()) => {
                        t.status = DownloadStatus::Completed;
                        t.error = None;
                    }
                    Err(e) => {
                        t.status = DownloadStatus::Failed;
                        t.error = Some(format!("保存失败：{e}"));
                    }
                }
                true
            });
            if ok {
                if let Some(name) = completed_name {
                    crate::network::notify::show_notification(app, "下载完成", &name);
                }
            }
        }
        Err(message) => {
            mutate_task(app, id, |t| {
                if t.status != DownloadStatus::Downloading {
                    return false; // 暂停/取消已抢先落状态，迟到失败不覆盖
                }
                t.status = DownloadStatus::Failed;
                t.error = Some(message);
                true
            });
        }
    }
    schedule(app);
}

// ── 用户动作 ───────────────────────────────────────────

/// 暂停：abort 传输（已写字节留在 .part，URL 任务可续传恢复）。
pub(crate) fn pause(app: &AppHandle, id: u64) {
    let aborted = {
        let state = app.state::<crate::DshState>();
        let mut handles = state.downloads.handles.lock().unwrap();
        matches!(handles.remove(&id), Some(handle) if { handle.abort(); true })
    };
    let _ = aborted;
    mutate_task(app, id, |t| match t.status {
        // blob 任务同此：状态即闸门，暂停后迟到的分块会被丢弃（JS 收 false 停发）
        DownloadStatus::Downloading | DownloadStatus::Queued => {
            t.status = DownloadStatus::Paused;
            true
        }
        _ => false,
    });
    schedule(app); // 补位
}

/// 恢复：Paused → Queued → 调度（URL 任务带 .part 续传；blob 任务源已失效则直接失败）。
pub(crate) fn resume(app: &AppHandle, id: u64) {
    let is_blob = {
        let state = app.state::<crate::DshState>();
        let tasks = state.downloads.tasks.lock().unwrap();
        tasks.iter().find(|t| t.id == id).map(|t| t.kind == DownloadKind::Blob).unwrap_or(false)
    };
    if is_blob {
        mutate_task(app, id, |t| {
            if t.status == DownloadStatus::Paused && t.kind == DownloadKind::Blob {
                t.status = DownloadStatus::Failed;
                t.error = Some("blob 数据不可恢复：请重新触发下载".into());
                return true;
            }
            false
        });
        return;
    }
    let updated = mutate_task(app, id, |t| {
        if matches!(t.status, DownloadStatus::Paused | DownloadStatus::Failed) {
            t.status = DownloadStatus::Queued;
            t.error = None;
            return true;
        }
        false
    });
    if updated {
        schedule(app);
    }
}

/// 取消：终止传输 + 清 .part + 状态 Cancelled。
pub(crate) fn cancel(app: &AppHandle, id: u64) {
    let removed_handle = {
        let state = app.state::<crate::DshState>();
        let mut handles = state.downloads.handles.lock().unwrap();
        matches!(handles.remove(&id), Some(handle) if { handle.abort(); true })
    };
    let _ = removed_handle;
    let part = {
        let state = app.state::<crate::DshState>();
        let tasks = state.downloads.tasks.lock().unwrap();
        tasks.iter().find(|t| t.id == id).map(part_path)
    };
    if let Some(p) = &part {
        let _ = std::fs::remove_file(p);
    }
    mutate_task(app, id, |t| {
        if t.status.is_terminal() {
            return false;
        }
        t.status = DownloadStatus::Cancelled;
        t.error = None;
        true
    });
    schedule(app);
}

/// 清空已完成（Completed/Failed/Cancelled 全部移除，连带 .part）。
pub(crate) fn clear_finished(app: &AppHandle) {
    let state = app.state::<crate::DshState>();
    let (keep, dropped): (Vec<DownloadTask>, Vec<DownloadTask>) = {
        let tasks = state.downloads.tasks.lock().unwrap();
        tasks.iter().cloned().partition(|t| !t.status.is_terminal())
    };
    for t in &dropped {
        let _ = std::fs::remove_file(part_path(t));
    }
    {
        *state.downloads.tasks.lock().unwrap() = keep.clone();
    }
    drop(state);
    save_tasks(&keep);
    emit_changed(app);
}

/// 并发上限调整（clamp 1..=32，写 settings.yaml，立即补位调度）。
pub(crate) fn set_concurrency(app: &AppHandle, value: u32) {
    let clamped = value.clamp(1, 32);
    let mut settings = crate::settings::load_desktop_settings();
    settings.download_concurrency = Some(clamped);
    // #90：持久化由 client→插件→dsh settings 服务承担
    app.state::<crate::DshState>()
        .downloads
        .concurrency
        .store(clamped, Ordering::SeqCst);
    log::info!("[downloads] 并发上限调整为 {clamped}");
    schedule(app);
}

// ── blob 管线（client 拦截 blob:/data: 下载后 IPC 分块写入） ─────────

/// blob 任务开始：弹保存框（返回任务 id 给 JS；取消保存框即取消任务）。
pub(crate) fn start_blob_download(app: &AppHandle, filename: String, total: Option<u64>) -> Option<u64> {
    let filename = sanitize_filename(&filename);
    let id = {
        let state = app.state::<crate::DshState>();
        let id = state.downloads.next_id.fetch_add(1, Ordering::SeqCst);
        let task = DownloadTask {
            id,
            kind: DownloadKind::Blob,
            url: "blob:".to_string(),
            filename: filename.clone(),
            target_path: default_target(&filename),
            total,
            received: 0,
            etag: None,
            resumed: false,
            status: DownloadStatus::ChoosingPath,
            error: None,
            created_at: chrono_now_secs(),
            updated_at: chrono_now_secs(),
        };
        state.downloads.tasks.lock().unwrap().insert(0, task);
        id
    };
    emit_changed(app);
    let app = app.clone();
    let filename_for_cb = filename.clone();
    app.dialog()
        .file()
        .set_directory(default_download_dir())
        .set_file_name(&filename)
        .save_file(move |path| {
            let picked = path.and_then(|p| p.as_path().map(|p| p.to_path_buf()));
            match picked {
                Some(target) => {
                    let name = target
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(sanitize_filename)
                        .unwrap_or_else(|| filename_for_cb.clone());
                    mutate_task(&app, id, |t| {
                        if t.status != DownloadStatus::ChoosingPath {
                            return false;
                        }
                        t.target_path = target;
                        t.filename = name;
                        // blob 由 JS 推流：不经并发闸门，直接进入接收态
                        t.status = DownloadStatus::Downloading;
                        true
                    });
                }
                None => {
                    mutate_task(&app, id, |t| {
                        if t.status == DownloadStatus::ChoosingPath {
                            t.status = DownloadStatus::Cancelled;
                            t.error = Some("未选择保存位置".into());
                            return true;
                        }
                        false
                    });
                }
            }
        });
    Some(id)
}

/// blob 分块写入（base64；追加 .part）。任务不存在/非接收态返回 false（JS 停发）。
pub(crate) fn save_blob_chunk(app: &AppHandle, id: u64, chunk_b64: String) -> bool {
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(chunk_b64.as_bytes()) {
        Ok(b) => b,
        Err(_) => return false,
    };
    // 先查状态再写盘：暂停后迟到的在途块直接拒收，不落入 .part（M2）
    {
        let state = app.state::<crate::DshState>();
        let tasks = state.downloads.tasks.lock().unwrap();
        match tasks.iter().find(|t| t.id == id) {
            Some(t) if t.status == DownloadStatus::Downloading && t.kind == DownloadKind::Blob => {}
            _ => return false,
        }
    }
    let part = part_path_of(app, id);
    let Some(part) = part else { return false };
    if let Some(dir) = part.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write;
    let ok = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part)
        .and_then(|mut f| f.write_all(&bytes))
        .is_ok();
    if !ok {
        return false;
    }
    // 更新进度（blob 无 etag/resumed 语义）
    let state = app.state::<crate::DshState>();
    {
        let mut tasks = state.downloads.tasks.lock().unwrap();
        let Some(task) = tasks.iter_mut().find(|t| t.id == id) else { return false };
        if task.status != DownloadStatus::Downloading {
            return false; // 与写盘间隙内被暂停：进度不计数（盘上多余字节随取消/清理删除）
        }
        task.received += bytes.len() as u64;
    }
    drop(state);
    emit_changed(app);
    true
}

/// blob 分块结束：rename .part → 目标 + 通知。
pub(crate) fn finish_blob_download(app: &AppHandle, id: u64) -> bool {
    // 同 on_task_finished：rename 放进锁内 CAS 之后，暂停/取消抢先时不 rename
    let mut completed_name: Option<String> = None;
    let ok = mutate_task(app, id, |t| {
        if t.status != DownloadStatus::Downloading || t.kind != DownloadKind::Blob {
            return false;
        }
        if let Some(dir) = t.target_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let renamed = std::fs::rename(part_path(t), &t.target_path);
        completed_name = Some(t.filename.clone());
        match renamed {
            Ok(()) => {
                t.status = DownloadStatus::Completed;
                t.error = None;
            }
            Err(e) => {
                t.status = DownloadStatus::Failed;
                t.error = Some(format!("保存失败：{e}"));
            }
        }
        true
    });
    if ok {
        if let Some(name) = completed_name {
            crate::network::notify::show_notification(app, "下载完成", &name);
        }
    }
    ok
}
