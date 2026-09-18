//! 下载任务持久化：$DSH_HOME/storages/downloads/tasks.json（0600，原子写）。
//!
//! #72 跨重启恢复：非终态 URL 任务恢复为 Paused（.part 保留续传）；
//! blob 任务非终态恢复为 Cancelled 并清理 .part（源在页面内存，重启即失效）。
//! 裁剪：总量超上限时按 updated_at 淘汰最老的终态任务（连同 .part）。

use std::path::PathBuf;

use super::model::{DownloadKind, DownloadStatus, DownloadTask};

/// 历史记录上限（拍板：约 200 条，超限自动裁剪最老终态任务）。
pub(crate) const MAX_TASKS: usize = 200;

/// tasks.json 路径（$DSH_HOME/storages/downloads/tasks.json）。
pub(crate) fn tasks_path() -> PathBuf {
    crate::settings::dsh_home().join("storages").join("downloads").join("tasks.json")
}

/// 任务的 .part 临时文件：与目标同目录、同名加 ".part" 后缀。
/// 同目录保证最终 rename 不跨卷；重名目标与 .part 互不干扰。
pub(crate) fn part_path(task: &DownloadTask) -> PathBuf {
    let mut name = task.filename.clone();
    name.push_str(".part");
    task.target_path.with_file_name(name)
}

/// 保存任务表（原子写：tmp → rename；目录递归创建；权限 0600 对齐 pairing.json 惯例）。
pub(crate) fn save_tasks(tasks: &[DownloadTask]) {
    let path = tasks_path();
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return; // 目录创建失败：下载管理不阻塞主流程，下次状态变化再试
        }
    }
    let tmp = path.with_extension("json.tmp");
    let body = match serde_json::to_string_pretty(tasks) {
        Ok(b) => b,
        Err(_) => return,
    };
    if std::fs::write(&tmp, body).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// 加载任务表并做跨重启恢复语义整备 + 裁剪。文件缺失/损坏返回空表（不报错）。
pub(crate) fn load_tasks() -> Vec<DownloadTask> {
    let mut tasks: Vec<DownloadTask> = std::fs::read_to_string(tasks_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for task in tasks.iter_mut() {
        match task.status {
            DownloadStatus::ChoosingPath
            | DownloadStatus::Queued
            | DownloadStatus::Downloading
            | DownloadStatus::Paused => {
                if task.kind == DownloadKind::Blob {
                    // blob 源已随页面销毁：作废并清理 .part
                    task.status = DownloadStatus::Cancelled;
                    task.error = Some("页面已重载，blob 数据不可恢复".into());
                    remove_part(task);
                } else {
                    task.status = DownloadStatus::Paused;
                }
                task.touch();
            }
            _ => {}
        }
    }
    let pruned = prune(tasks);
    if !pruned.is_empty() || std::fs::metadata(tasks_path()).is_ok() {
        // 有恢复动作或已有旧文件时回写整备结果；空表 + 无文件则不产生空文件
        save_tasks(&pruned);
    }
    pruned
}

/// 裁剪：超过 MAX_TASKS 时从最老的终态任务开始移除（连带 .part）；
/// 非终态任务永不裁剪。返回裁剪后的表（顺序保持：新任务在前由 manager 维护）。
pub(crate) fn prune(mut tasks: Vec<DownloadTask>) -> Vec<DownloadTask> {
    if tasks.len() <= MAX_TASKS {
        return tasks;
    }
    let mut terminal: Vec<usize> = tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.status.is_terminal())
        .map(|(i, _)| i)
        .collect();
    // 稳定排序按 updated_at 升序：先淘汰最久未更新的终态任务
    terminal.sort_by_key(|&i| tasks[i].updated_at);
    let excess = tasks.len() - MAX_TASKS;
    let mut victim_ids: Vec<u64> = Vec::with_capacity(excess);
    let mut victims: Vec<usize> = terminal.into_iter().take(excess).collect();
    victims.sort_unstable(); // 逆序删除防止索引漂移
    for &i in victims.iter().rev() {
        victim_ids.push(tasks[i].id);
        let part = part_path(&tasks[i]);
        let _ = std::fs::remove_file(part);
        tasks.remove(i);
    }
    if !victim_ids.is_empty() {
        log::info!("[downloads] 历史裁剪：移除 {} 条终态任务", victim_ids.len());
    }
    tasks
}

/// 清理指定任务在磁盘上的 .part（取消/清理动作用）。
pub(crate) fn remove_part(task: &DownloadTask) {
    let _ = std::fs::remove_file(part_path(task));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::model::DownloadKind;

    fn task(id: u64, status: DownloadStatus, updated: i64) -> DownloadTask {
        DownloadTask {
            id,
            kind: DownloadKind::Url,
            url: format!("http://h/{id}"),
            filename: format!("f{id}.zip"),
            target_path: PathBuf::from(format!("/tmp/dl/f{id}.zip")),
            total: Some(10),
            received: 5,
            etag: None,
            resumed: false,
            status,
            error: None,
            created_at: updated - 10,
            updated_at: updated,
        }
    }

    #[test]
    fn prune_keeps_recent_and_active() {
        let mut tasks: Vec<DownloadTask> = (0..=MAX_TASKS as u64)
            .map(|i| task(i, DownloadStatus::Completed, i as i64))
            .collect();
        // 最老的一条换成进行中：裁剪绝不动非终态（此时超额 1 条，最老终态 id=1 被淘汰）
        tasks[0].status = DownloadStatus::Paused;
        let out = prune(tasks);
        assert_eq!(out.len(), MAX_TASKS);
        assert!(out.iter().any(|t| t.id == 0));
        assert!(!out.iter().any(|t| t.id == 1));
        assert!(out.iter().any(|t| t.id == MAX_TASKS as u64));
    }

    #[test]
    fn prune_noop_under_limit() {
        let tasks = vec![task(1, DownloadStatus::Completed, 1)];
        assert_eq!(prune(tasks).len(), 1);
    }

    #[test]
    fn part_path_sibling_of_target() {
        let t = task(7, DownloadStatus::Paused, 1);
        assert_eq!(part_path(&t), PathBuf::from("/tmp/dl/f7.zip.part"));
    }
}
