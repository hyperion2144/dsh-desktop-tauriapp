//! 启动保险丝：插件不兼容自动隔离与重试（#57/#58，dsh-safe 的 Rust 移植）。
//!
//! 两阶段分离（#58）：插件隔离只在「dsh 子进程退出且 exit != 0」时触发；
//! 健康探活（watchdog，TCP 判活）只在成功启动后运行，两者互不干扰。
//!
//! 关键事实（#54 实测，别凭直觉改）：
//! - 端口不是就绪信号：dsh 在 settle 前 ~2.9s 就 LISTEN，失败 ~14s 才 exit——
//!   保险丝必须以「进程退出 + exit code ≠ 0」为触发点；
//! - 隔离动作 = 在 profile 的 cordis.patch.yml 追加托管区块（`- id: X` +
//!   `disabled: true`），ledger 记账，然后重试 spawn；
//! - 写 profile 的 patch 文件会让运行中实例（patchReload=live）立刻 re-apply——
//!   本模块只在「旧进程已退出」后写盘；
//! - 桌面壳自己的 `--patch` 注入清单（desktop-plugin-inject.yml）每次 spawn 都会被
//!   materialize 重写，隔离它毫无意义 → 内建保护名单。

pub mod failures;
pub mod ledger;
pub mod patchfile;
pub mod repair;
pub mod monitor;

use std::path::PathBuf;
use std::sync::Mutex;

use crate::settings::DesktopSettings;
use ledger::QuarantineEntry;

/// 桌面壳自身注入的插件（改 inject.yml 会在下次 spawn 被 materialize 覆盖，
/// 隔离它们徒劳且会弄坏桌面 chrome）——与 @deepseek-ai/* 一并内建保护。
pub const BUILTIN_PROTECTED: &[&str] = &["dsh-desktop-tauriapp", "dsh-mobile-access", "dsh-web-mobile"];

/// stderr 累积缓冲（512KiB 上限，超出丢最旧的——失败输出在末尾，保新弃旧）。
#[derive(Default)]
pub struct StderrBuffer {
    lines: Vec<String>,
    bytes: usize,
    truncated: bool,
}

impl StderrBuffer {
    const CAP: usize = 512 * 1024;

    pub fn push(&mut self, line: &str) {
        let n = line.len() + 1;
        self.lines.push(line.to_string());
        self.bytes += n;
        while self.bytes > Self::CAP && self.lines.len() > 1 {
            let removed = self.lines.remove(0);
            self.bytes = self.bytes.saturating_sub(removed.len() + 1);
            self.truncated = true;
        }
    }

    /// 完整快照（丢弃行以头部省略号标记）。
    pub fn snapshot(&self) -> String {
        let mut s = String::new();
        if self.truncated {
            s.push_str("…（更早日志已丢弃，512KiB 上限）\n");
        }
        s.push_str(&self.lines.join("\n"));
        s
    }
}

/// 共享缓冲句柄（spawn 时创建，线程写，监控任务读）。
pub type SharedStderr = std::sync::Arc<Mutex<StderrBuffer>>;

/// 一次隔离周期的结果。
#[derive(Debug, Default, Clone)]
pub struct CycleOutcome {
    /// 本轮成功禁用的插件（已写托管区块 + 已记台账）。
    pub disabled: Vec<QuarantineEntry>,
    /// 检出但因保护策略未动的（第一方/排除名单/自家注入/已禁用）。
    pub skipped: Vec<String>,
    /// 环境类失败（端口占用等）：不隔离。
    pub environmental: bool,
    /// patch 文件解析失败（第 6 类）：无法自动修复，需人工处理。
    pub patch_parse: bool,
    /// dedupe 是否做了 patch 侧摘除。
    pub deduped: bool,
}

/// 保险丝三项设置（来自 settings.yaml `dsh-desktop-tauriapp:` 键）。
pub fn fuse_settings(s: &DesktopSettings) -> (bool, Vec<String>, u8) {
    (
        s.quarantine_first_party_protection.unwrap_or(true),
        s.quarantine_exclude.clone().unwrap_or_default(),
        s.quarantine_max_retries.unwrap_or(2).clamp(0, 5),
    )
}

fn is_first_party(id: &str, name: &str, protect_first_party: bool) -> bool {
    (protect_first_party
        && (id.starts_with("@deepseek-ai/") || name.starts_with("@deepseek-ai/")))
        || BUILTIN_PROTECTED.contains(&id)
        || BUILTIN_PROTECTED.contains(&name)
}

/// profile 的 cordis.patch.yml 路径（`base` = dsh home）。
pub fn profile_patch_path(base: &std::path::Path, profile: &str) -> PathBuf {
    base.join("profiles").join(profile).join("cordis.patch.yml")
}

/// 一个周期：从 stderr 检测失败 → 过滤保护策略 → 写托管区块 + 台账 → dedupe。
///
/// `inject_patch` 是桌面壳 `--patch` 注入清单路径：其行只参与「失败归因」，
/// 永不作为隔离目标（每次 spawn 会被 materialize 重写）。
pub fn run_cycle(
    base: &std::path::Path,
    profile: &str,
    inject_patch: Option<&PathBuf>,
    stderr: &str,
    settings: &DesktopSettings,
) -> CycleOutcome {
    let (protect_fp, exclude, _retries) = fuse_settings(settings);
    let det = failures::detect(stderr);
    let mut outcome = CycleOutcome {
        environmental: det.environmental,
        patch_parse: det.patch_parse,
        ..Default::default()
    };
    let quarantineable: Vec<&failures::Failure> = det
        .failures
        .iter()
        .filter(|f| f.kind != failures::kind::PATCH_PARSE)
        .collect();
    if quarantineable.is_empty() {
        return outcome;
    }

    let patch_path = profile_patch_path(base, profile);
    let mut patch_text = std::fs::read_to_string(&patch_path).unwrap_or_default();
    let rows = patchfile::scan_patch_rows(&patch_text);
    // 注入清单（inject_patch）仅作为归因对照的数据来源提示：其行被内建保护名单
    // 排除，永不成为隔离目标（materialize 每次 spawn 都会重写它）。
    let mut disable_ids: Vec<String> = patchfile::managed_ids(&patch_text);
    for f in &quarantineable {
        // 归因：优先 entry_id，其次 name（与 patch 行的 id/name 对照）；统一用
        // 归因：优先 entry_id，其次 name（与 patch 行的 id/name 对照）；统一用
        // as_deref 比较，避免 Option<&Option<String>> 的类型套娃
        let matches_row = |r: &patchfile::PatchRow| {
            f.entry_id.as_deref() == Some(r.id.as_str())
                || f.name.as_deref() == Some(r.id.as_str())
        };
        let mut hit = rows.iter().find(|r| matches_row(r));
        if hit.is_none() {
            hit = rows
                .iter()
                .find(|r| f.name.as_deref() == Some(r.name.as_deref().unwrap_or_default()));
        }
        let Some(row) = hit else {
            // 与 patch 行对不上的失败（外部实例的插件等）：记 skipped，不盲禁
            outcome.skipped.push(format!(
                "{}（{}）不在 {} 的 patch 行内，跳过自动禁用",
                f.entry_id.clone().or_else(|| f.name.clone()).unwrap_or_default(),
                f.kind,
                patch_path.display()
            ));
            continue;
        };
        let id = row.id.clone();
        let name = row.name.clone().unwrap_or_default();
        if rows.iter().any(|r| r.id == id && r.disabled == Some(true)) {
            continue; // 同 id 任一行已禁用（含托管区块）：还失败就不是这条的问题
        }
        if is_first_party(&id, &name, protect_fp) {
            outcome.skipped.push(format!("{id}（第一方/内建保护）"));
            continue;
        }
        if exclude.iter().any(|x| x == &id || (name.len() > 1 && x == &name)) {
            outcome.skipped.push(format!("{id}（排除名单）"));
            continue;
        }
        // dedupe：重复挂载且 patch 侧有同名 insert 来源 → 摘除该来源（取代禁用：
        // 冲突来自插入动作本身，给插入条目加 disabled 解决不了冲突）。摘除后
        // 重读 patch 文本，保证后续托管写基于新内容。
        if f.kind == failures::kind::DUPLICATE_ID {
            let patch_side = patchfile::scan_patch_rows(&patch_text)
                .iter()
                .any(|r| r.in_insert && r.id == id);
            if patch_side {
                outcome.deduped |= repair::dedupe_patch_side(&patch_path, &id);
                if outcome.deduped {
                    patch_text = std::fs::read_to_string(&patch_path).unwrap_or(patch_text);
                    outcome.skipped.push(format!("{id}（重复挂载：已摘除 patch 侧 insert 来源）"));
                    continue;
                }
            } else {
                // 注入清单/materialize 重写：不能自动摘除，只提示
                outcome.skipped.push(format!("{id}（重复来源疑似桌面注入清单，需人工核查）"));
                continue;
            }
        }
        // 记账 + 加入托管禁用名单
        let reason = failures::summarize_line(&f.line);
        let entry = ledger::make_entry(
            id.clone(),
            name.clone(),
            reason.clone(),
            f.kind.to_string(),
            failures::summarize_line(&f.line),
            patch_path.display().to_string(),
        );
        outcome.disabled.push(entry);
        if !disable_ids.contains(&id) {
             disable_ids.push(id.clone());
        }
    }
    // 注入清单里的命中只提示（见上），从待禁用名单剔除
    disable_ids.retain(|id| !BUILTIN_PROTECTED.contains(&id.as_str()));

    if !outcome.disabled.is_empty() {
        let new_text = patchfile::apply_managed_disable(&patch_text, &disable_ids);
        match patchfile::atomic_write(&patch_path, &new_text) {
            Ok(()) => {
                for e in &outcome.disabled {
                    ledger::add_entry(base, profile, e.clone());
                    log::warn!("[fuse] 已禁用插件 {}（{}），原因：{}", e.id, e.failure_type, e.reason);
                }
            }
            Err(e) => {
                log::error!("[fuse] 托管区块写入失败，本轮不隔离：{e}");
                outcome.disabled.clear();
            }
        }
    }
    outcome
}

/// 恢复某 profile 的全部被隔离插件（手动重启时调用；恢复失败不阻塞重启）。
pub fn restore_all_for_profile(base: &std::path::Path, profile: &str) -> usize {
    let patch = profile_patch_path(base, profile);
    let Ok(text) = std::fs::read_to_string(&patch) else {
        return 0;
    };
    let ids = patchfile::managed_ids(&text);
    if ids.is_empty() {
        return 0;
    }
    let new_text = patchfile::remove_managed_block(&text).0;
    match patchfile::atomic_write(&patch, &new_text) {
        Ok(()) => {
            ledger::remove_entries(base, profile, None);
            log::info!("[fuse] 重启前已恢复 {} 个被隔离插件（下次启动生效）", ids.len());
            ids.len()
        }
        Err(e) => {
            log::error!("[fuse] 恢复托管区块写入失败（忽略，继续重启）：{e}");
            0
        }
    }
}

/// 恢复指定 id（UI 单条恢复）。
pub fn restore_ids(base: &std::path::Path, profile: &str, ids: &[String]) -> usize {
    let patch = profile_patch_path(base, profile);
    let Ok(text) = std::fs::read_to_string(&patch) else {
        return 0;
    };
    let new_text = patchfile::remove_managed_ids(&text, ids);
    if new_text == text {
        return 0;
    }
    match patchfile::atomic_write(&patch, &new_text) {
        Ok(()) => {
            ledger::remove_entries(base, profile, Some(ids));
            ids.len()
        }
        Err(e) => {
            log::error!("[fuse] 恢复写回失败：{e}");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-fuse-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(dir.join("profiles").join("web")).unwrap();
        dir
    }

    fn settings(fp: bool, exclude: &[&str], retries: u8) -> DesktopSettings {
        DesktopSettings {
            quarantine_first_party_protection: Some(fp),
            quarantine_exclude: Some(exclude.iter().map(|s| s.to_string()).collect()),
            quarantine_max_retries: Some(retries),
            ..Default::default()
        }
    }

    const IMPORT_STDERR: &str = "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry my-broken-plugin (file:///tmp/definitely-not-here.js): Cannot find module '/tmp/definitely-not-here.js' imported from /x\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/definitely-not-here.js'";

    #[test]
    fn stderr_buffer_caps_at_512k_keeping_newest() {
        let mut buf = StderrBuffer::default();
        let long = "x".repeat(4096);
        for i in 0..200 {
            buf.push(&format!("{i}:{long}"));
        }
        assert!(buf.bytes <= StderrBuffer::CAP + 8192);
        let snap = buf.snapshot();
        assert!(snap.contains("199:"), "最新行必须保留");
        assert!(snap.starts_with("…（"), "丢弃行要有标记");
    }

    #[test]
    fn cycle_disables_broken_plugin_and_writes_ledger() {
        let base = tmp_base("disable");
        let patch = profile_patch_path(&base, "web");
        std::fs::write(&patch, "- insert:\n    - id: my-broken-plugin\n      name: \"file:///tmp/definitely-not-here.js\"\n").unwrap();
        let outcome = run_cycle(&base, "web", None, IMPORT_STDERR, &settings(true, &[], 2));
        assert_eq!(outcome.disabled.len(), 1, "{outcome:?}");
        assert_eq!(outcome.disabled[0].id, "my-broken-plugin");
        // 托管区块已写
        let text = std::fs::read_to_string(&patch).unwrap();
        assert!(text.contains("- id: my-broken-plugin\n  disabled: true"));
        // 台账已记
        let entries = ledger::list_entries(&base, "web");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].failure_type, "loader-entry");
        // 再跑一轮：已禁用不再重复入账
        let again = run_cycle(&base, "web", None, IMPORT_STDERR, &settings(true, &[], 2));
        assert!(again.disabled.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cycle_respects_first_party_and_exclude() {
        let base = tmp_base("protect");
        let patch = profile_patch_path(&base, "web");
        std::fs::write(
            &patch,
            "- insert:\n    - id: @deepseek-ai/dsh-llm\n      name: \"@deepseek-ai/dsh-llm\"\n    - id: excluded-one\n      name: \"excluded-one\"\n",
        )
        .unwrap();
        let stderr = "Error: dsh: 2 entries did not activate\n@deepseek-ai/dsh-llm: pending (waiting for service: required)\nexcluded-one: pending (waiting for service: required)\n";
        let outcome = run_cycle(&base, "web", None, stderr, &settings(true, &["excluded-one"], 2));
        assert!(outcome.disabled.is_empty());
        assert_eq!(outcome.skipped.len(), 2, "{outcome:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cycle_flags_environmental_and_patch_parse_without_quarantine() {
        let base = tmp_base("env");
        let patch = profile_patch_path(&base, "web");
        std::fs::write(&patch, "[]\n").unwrap();
        let env = run_cycle(&base, "web", None, "Error: listen EADDRINUSE: address already in use", &settings(true, &[], 2));
        assert!(env.environmental && env.disabled.is_empty());
        let pp = run_cycle(
            &base,
            "web",
            None,
            "Error: failed to parse overlay cordis.patch.yml: YAMLException: bad indentation",
            &settings(true, &[], 2),
        );
        assert!(pp.patch_parse && pp.disabled.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn restore_all_clears_managed_block_and_ledger() {
        let base = tmp_base("restore");
        let patch = profile_patch_path(&base, "web");
        std::fs::write(&patch, "- insert:\n    - id: my-broken-plugin\n      name: \"file:///tmp/definitely-not-here.js\"\n").unwrap();
        run_cycle(&base, "web", None, IMPORT_STDERR, &settings(true, &[], 2));
        assert!(std::fs::read_to_string(&patch).unwrap().contains("disabled: true"));
        assert_eq!(restore_all_for_profile(&base, "web"), 1);
        let text = std::fs::read_to_string(&patch).unwrap();
        assert!(!text.contains("disabled: true"));
        assert!(ledger::list_entries(&base, "web").is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dedupe_runs_for_duplicate_id_with_patch_side_insert() {
        let base = tmp_base("dup");
        let patch = profile_patch_path(&base, "web");
        std::fs::write(&patch, "- insert:\n    - id: llm\n      name: \"dup-pkg\"\n").unwrap();
        let stderr = "[cause]: Error: failed to apply loader entry include (cordis:include): duplicate loader entry id: llm";
        let outcome = run_cycle(&base, "web", None, stderr, &settings(true, &[], 2));
        // llm 是 patch 侧 insert 来源：dedupe 摘除该来源（而非托管禁用——禁用重复
        // id 没有意义，冲突本身来自插入动作）
        assert!(outcome.deduped, "{outcome:?}");
        let text = std::fs::read_to_string(&patch).unwrap();
        assert!(!text.contains("dup-pkg"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
