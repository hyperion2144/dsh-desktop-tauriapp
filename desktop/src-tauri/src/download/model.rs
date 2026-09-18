//! 下载任务数据模型。
//!
//! #72：任务状态机与持久化结构。快照（`DownloadTask` 直接 serde）同时是
//! 前端列表的数据源与 tasks.json 的落盘格式，单一事实源。

use std::path::PathBuf;

/// 任务状态。`ChoosingPath` 仅存在于保存框弹出期间；跨重启恢复时，
/// 非终态一律落为 `Paused`（blob 任务例外：源在页面内存，重启即失效，
/// 恢复为 `Cancelled` 并清理 .part）。
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DownloadStatus {
    /// 等待用户在保存对话框选择位置（取消即任务取消）。
    ChoosingPath,
    /// 已有目标路径，等待并发闸门放行。
    Queued,
    /// 传输中（URL 流式下载或 blob 分块写入）。
    Downloading,
    /// 用户暂停或跨重启恢复的暂停态（.part 保留）。
    Paused,
    /// 完成并已从 .part 原子改名到目标路径。
    Completed,
    /// 失败（网络错误 / 写盘错误 / 服务器拒绝）。.part 保留供恢复重试。
    Failed,
    /// 用户取消（.part 已清理）。
    Cancelled,
}

impl DownloadStatus {
    /// 终态（不会再发生状态迁移）。
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, DownloadStatus::Completed | DownloadStatus::Failed | DownloadStatus::Cancelled)
    }
}

/// 任务来源：URL 直链（Rust 侧流式下载，支持 Range 续传）或页面 blob/data
/// （client 拦截后经 IPC 分块写入，无续传语义——源在页面内存）。
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DownloadKind {
    Url,
    Blob,
}

/// 单个下载任务。字段命名 camelCase（前端与 tasks.json 共用）。
#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub(crate) struct DownloadTask {
    pub(crate) id: u64,
    pub(crate) kind: DownloadKind,
    /// 来源 URL（blob 任务为触发页 origin，仅展示用）。
    pub(crate) url: String,
    /// 展示文件名（也是保存框默认名）。
    pub(crate) filename: String,
    /// 用户选择的目标路径（绝对路径）。
    pub(crate) target_path: PathBuf,
    /// 总字节数（服务器 Content-Length；未知为 None）。
    pub(crate) total: Option<u64>,
    /// 已写字节数（URL 任务 = .part 长度；blob 任务 = 已收分块和）。
    pub(crate) received: u64,
    /// 上次成功响应的 ETag（恢复续传时作 If-Range 校验）。
    pub(crate) etag: Option<String>,
    /// 本次传输是否为续传（true 且服务器 206）；服务器不支持时回退全量重下，
    /// 该标志复位为 false——UI 由此如实标注「已重新开始」。
    pub(crate) resumed: bool,
    pub(crate) status: DownloadStatus,
    pub(crate) error: Option<String>,
    /// unix 秒。
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

impl DownloadTask {
    pub(crate) fn touch(&mut self) {
        self.updated_at = chrono_now_secs();
    }
}

/// unix 秒（避免为一个时间戳引入 chrono 依赖）。
pub(crate) fn chrono_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 清洗文件名：去路径分隔符与控制字符，截断到 120 字符，空则回退 "download"。
pub(crate) fn sanitize_filename(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() || c == '/' || c == '\\' || c == ':' { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

/// 从 URL 尾段提取文件名（保存框默认名候选）。
pub(crate) fn filename_from_url(url: &str) -> String {
    let decoded = percent_decode(url);
    let last = decoded.rsplit('/').next().unwrap_or("");
    let name = last.split('?').next().unwrap_or("");
    sanitize_filename(name)
}

/// 仅解码 %XX（含非 UTF-8 字节时回退原串，够用且不引入 urlencoding 依赖）。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_paths_and_control() {
        assert_eq!(sanitize_filename("a/b\\c:d"), "a_b_c_d");
        assert_eq!(sanitize_filename("  ..报告..zip.. "), "报告..zip");
        assert_eq!(sanitize_filename(""), "download");
        assert_eq!(sanitize_filename("\u{7}x"), "_x");
    }

    #[test]
    fn filename_from_url_takes_last_segment() {
        assert_eq!(filename_from_url("http://h/api/session.export?sessionId=s1"), "session.export");
        assert_eq!(filename_from_url("http://h/"), "download");
    }

    #[test]
    fn status_terminal_matrix() {
        assert!(DownloadStatus::Completed.is_terminal());
        assert!(DownloadStatus::Failed.is_terminal());
        assert!(DownloadStatus::Cancelled.is_terminal());
        assert!(!DownloadStatus::Paused.is_terminal());
        assert!(!DownloadStatus::Downloading.is_terminal());
        assert!(!DownloadStatus::Queued.is_terminal());
        assert!(!DownloadStatus::ChoosingPath.is_terminal());
    }
}
