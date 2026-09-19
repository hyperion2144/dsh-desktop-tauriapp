//! repair 判定与执行 + dedupe（#60）。
//!
//! - `is_repairable`：包解析失败 / ESM 导出不匹配 → 可重装修复；
//!   `file://` 路径式条目不可修复（没有包可装）；
//! - repair：`dsh plugin --profile <p> add <name>@latest`（Windows 走 node bin.js）；
//!   成功 → 从台账摘除 + 重写托管区块；失败 → 无损返回；
//! - dedupe：重复挂载且冗余来源可定位到 patch 侧 insert 行时摘除该行；
//!   定位不到（如两个不同包注册同名 entry）→ 只记录，提示人工处理。

use std::path::Path;

use super::patchfile;
use crate::profiles::run_profile_plugin_add;

/// 判定一条失败原因是否可修复（对齐 dsh-safe repair.js 的口径）。
pub fn is_repairable(reason: &str, name: &str) -> bool {
    if name.starts_with("file://") || name.starts_with('/') || name.starts_with("./") {
        return false; // 路径式条目没有包可重装
    }
    let r = reason;
    r.contains("Cannot find package")
        || r.contains("ERR_MODULE_NOT_FOUND")
        || r.contains("does not provide an export")
        || r.contains("Cannot find module")
}

/// 执行修复：重装包（`@latest`），由调用方在 spawn_blocking 里跑。
/// 返回 Ok(()) 表示 `dsh plugin add` 成功（是否真正修复由下次启动验证）。
pub fn repair(app: &tauri::AppHandle, profile: &str, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("缺少包名，无法修复".into());
    }
    let spec = format!("{name}@latest");
    log::info!("[fuse] 修复：dsh plugin --profile {profile} add {spec}");
    let (ok, stderr_tail) = run_profile_plugin_add(app, profile, &spec);
    if ok {
        Ok(())
    } else {
        Err(format!("dsh plugin add {spec} 失败：{stderr_tail}"))
    }
}

/// 修复成功后的收尾：从台账摘除 + 重写托管区块（`base` = dsh home）。
pub fn finish_repair(base: &Path, profile: &str, id: &str) {
    super::ledger::remove_entries(base, profile, Some(&[id.to_string()]));
    let patch = base.join("profiles").join(profile).join("cordis.patch.yml");
    if let Ok(text) = std::fs::read_to_string(&patch) {
        let new_text = patchfile::remove_managed_ids(&text, &[id.to_string()]);
        if new_text != text {
            if let Err(e) = patchfile::atomic_write(&patch, &new_text) {
                log::error!("[fuse] 重写托管区块失败：{e}");
                return;
            }
        }
        log::info!("[fuse] 修复完成：{id} 已从台账与托管区块摘除（下次重启生效）");
    }
}

/// dedupe：重复挂载 id 的 patch 侧 insert 来源摘除。返回是否做了改动。
pub fn dedupe_patch_side(patch: &Path, id: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(patch) else {
        return false;
    };
    match patchfile::remove_insert_entry(&text, id) {
        Some(new_text) => match patchfile::atomic_write(patch, &new_text) {
            Ok(()) => {
                log::info!("[fuse] dedupe：已从 patch 摘除重复来源 {id}");
                true
            }
            Err(e) => {
                log::error!("[fuse] dedupe 写回失败：{e}");
                false
            }
        },
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairable_matrix() {
        assert!(is_repairable(
            "Cannot find package 'no-such-module-xyz' imported from /x",
            "no-such-module-xyz"
        ));
        assert!(is_repairable(
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'a'",
            "a"
        ));
        assert!(is_repairable(
            "does not provide an export named 'default'",
            "pkg"
        ));
        // file:// 路径式条目不可修复
        assert!(!is_repairable(
            "Cannot find module '/tmp/x.js'",
            "file:///tmp/x.js"
        ));
        // 激活失败 / 重复挂载不修
        assert!(!is_repairable("pending (waiting for service: required)", "pkg"));
        assert!(!is_repairable("duplicate loader entry id: llm", "llm"));
    }

    #[test]
    fn dedupe_patch_side_removes_and_persists() {
        let dir = std::env::temp_dir().join(format!("dsh-repair-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let patch = dir.join("cordis.patch.yml");
        std::fs::write(
            &patch,
            "- insert:\n    - id: llm\n      name: \"dup-pkg\"\n    - id: ok\n      name: \"keep\"\n",
        )
        .unwrap();
        assert!(dedupe_patch_side(&patch, "llm"));
        let text = std::fs::read_to_string(&patch).unwrap();
        assert!(!text.contains("dup-pkg"));
        assert!(text.contains("keep"));
        assert!(!dedupe_patch_side(&patch, "llm"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
