//! 隔离台账（#57）：`$DSH_HOME/dsh-desktop-tauriapp/quarantine.json`。
//!
//! 独立 JSON 格式，不与 dsh-safe CLI 互操作。读写全部原子（.tmp + rename）；
//! 解析失败按空台账处理（先备份坏文件，绝不让台账问题阻塞启动主流程）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::patchfile::atomic_write;

/// 一条隔离记录。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct QuarantineEntry {
    /// loader entry id。
    pub id: String,
    /// 包名 / 条目名（可空：第 4 类只有 id）。
    #[serde(default)]
    pub name: String,
    /// 禁用原因（summarize 后的错误摘要）。
    pub reason: String,
    /// 失败类型（failures::kind::*）。
    pub failure_type: String,
    /// 完整原始错误行。
    pub raw_error: String,
    /// 发生时间（本地 ISO-ish：`YYYY-MM-DD HH:MM:SS`）。
    pub quarantined_at: String,
    /// 来源 patch 文件路径。
    pub file: String,
}

/// 台账根结构。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Ledger {
    pub version: u8,
    #[serde(default)]
    pub profiles: BTreeMap<String, Vec<QuarantineEntry>>,
}

/// 台账文件路径（`base` = dsh home；显式传参便于测试）。
pub fn ledger_path(base: &Path) -> PathBuf {
    base.join("dsh-desktop-tauriapp").join("quarantine.json")
}

/// 本地时间戳（YYYY-MM-DD HH:MM:SS）。不引 chrono：UNIX epoch + 本地时区偏移足够。
fn now_local_string() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 本地时区偏移：用 libc localtime_r（unix）；Windows 用 UTC 兜底（台账时间戳
    // 精确到分钟级足够，不值得为它引平台 API）
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
        let days = secs / 86400;
        let rem = secs % 86400;
        let (y, m, d) = civil_from_days(days as i64);
        format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
    }
}

#[cfg(target_os = "windows")]
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 读取台账（缺失/损坏 → 空台账；损坏时先备份原文件 `.bad`）。
pub fn load(base: &Path) -> Ledger {
    let path = ledger_path(base);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ledger { version: 1, profiles: BTreeMap::new() };
    };
    match serde_json::from_str::<Ledger>(&text) {
        Ok(l) => l,
        Err(_) => {
            let _ = std::fs::copy(&path, path.with_extension("json.bad"));
            log::warn!("隔离台账损坏，已备份为 quarantine.json.bad 并按空台账继续");
            Ledger { version: 1, profiles: BTreeMap::new() }
        }
    }
}

/// 保存台账（原子写；父目录自动创建）。
pub fn save(base: &Path, ledger: &Ledger) -> std::io::Result<()> {
    let path = ledger_path(base);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(ledger).unwrap_or_else(|_| "{\"version\":1,\"profiles\":{}}".into());
    atomic_write(&path, &text)
}

/// 追加一条隔离记录（同 profile 同 id 去重，后写覆盖）。
pub fn add_entry(base: &Path, profile: &str, entry: QuarantineEntry) {
    let mut ledger = load(base);
    let list = ledger.profiles.entry(profile.to_string()).or_default();
    if let Some(old) = list.iter_mut().find(|e| e.id == entry.id) {
        *old = entry;
    } else {
        list.push(entry);
    }
    if let Err(e) = save(base, &ledger) {
        log::error!("隔离台账写入失败：{e}");
    }
}

/// 摘除记录：`ids=None` 摘全部；返回被摘除的条目。
pub fn remove_entries(base: &Path, profile: &str, ids: Option<&[String]>) -> Vec<QuarantineEntry> {
    let mut ledger = load(base);
    let Some(list) = ledger.profiles.get_mut(profile) else {
        return Vec::new();
    };
    let (kept, removed): (Vec<_>, Vec<_>) = list
        .drain(..)
        .partition(|e| ids.is_some_and(|ids| !ids.contains(&e.id)));
    *list = kept;
    if list.is_empty() {
        ledger.profiles.remove(profile);
    }
    let _ = save(base, &ledger);
    removed
}

/// 列出某 profile 的隔离记录。
pub fn list_entries(base: &Path, profile: &str) -> Vec<QuarantineEntry> {
    load(base).profiles.get(profile).cloned().unwrap_or_default()
}

/// 构造一条记录（时间戳取当前）。
pub fn make_entry(
    id: String,
    name: String,
    reason: String,
    failure_type: String,
    raw_error: String,
    file: String,
) -> QuarantineEntry {
    QuarantineEntry {
        id,
        name,
        reason,
        failure_type,
        raw_error,
        quarantined_at: now_local_string(),
        file,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-ledger-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(id: &str) -> QuarantineEntry {
        make_entry(id.into(), "pkg".into(), "boom".into(), "loader-entry".into(), "raw".into(), "/p.yml".into())
    }

    #[test]
    fn add_list_remove_roundtrip() {
        let base = tmp_base("roundtrip");
        add_entry(&base, "web", entry("a"));
        add_entry(&base, "web", entry("b"));
        add_entry(&base, "web", entry("a")); // 同 id 去重覆盖
        assert_eq!(list_entries(&base, "web").len(), 2);
        let removed = remove_entries(&base, "web", Some(&["a".into()]));
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "a");
        assert_eq!(list_entries(&base, "web").len(), 1);
        assert_eq!(remove_entries(&base, "web", None).len(), 1);
        assert!(list_entries(&base, "web").is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn corrupted_ledger_backs_up_and_continues() {
        let base = tmp_base("corrupt");
        let path = ledger_path(&base);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(list_entries(&base, "web").is_empty());
        assert!(path.with_extension("json.bad").exists(), "坏文件应备份");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_ledger_is_empty() {
        let base = tmp_base("missing");
        assert!(list_entries(&base, "smoke").is_empty());
        assert_eq!(load(&base).version, 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
