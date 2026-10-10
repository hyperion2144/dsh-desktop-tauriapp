// #212：内嵌插件 staging 的核心逻辑（递归拷贝 + 缺件收集）。
//
// 同一份源码被两处引入：
//   - `build.rs`（`#[path = "build_support/embed_plugins.rs"] mod embed_plugins;`）——编译期执行；
//   - `src/runtime/embed_plugins_test.rs`——只为把下面的 `#[cfg(test)] mod tests` 拉进 `cargo test`
//     （build script 自身不是测试目标，共用源码才能让这些行为真正可回归）。
//
// 本文件只用 `std`，不依赖 tauri/构建环境；`cargo:` 指令一律留在 `build.rs`，这里保持纯粹。

#![allow(dead_code)] // 测试目标只用到其中一部分入口

use std::path::{Path, PathBuf};

/// 单个包的 staging 结果：成功复制的文件数 + 缺件/失败清单（空 = 完整）。
#[derive(Debug, Default)]
pub struct StageReport {
    pub copied: usize,
    pub missing: Vec<String>,
}

impl StageReport {
    /// 是否完整（没有任何缺件/失败）。
    pub fn is_complete(&self) -> bool {
        self.missing.is_empty()
    }
}

/// 把一个插件包的必需文件与必需目录 stage 到 `dest`（`dest` 先整体清空）。
///
/// - `files`：相对 `src_root` 的顶层必需文件；
/// - `dirs`：相对 `src_root` 的顶层必需目录，**空目录算缺件**（空的 `lib/` 意味着一份加载不
///   起来的包——0.12.0 事故现场就是这种「看着有目录、其实没内容」）；
/// - 目录内容**递归**拷贝（上游 `lib/` 带 `types/` 子目录，只拷一层会静默丢东西）；
/// - 任何一项失败都记进 `missing` 而不是提前中断，由调用方一次报全。
pub fn stage_package(src_root: &Path, dest: &Path, files: &[&str], dirs: &[&str]) -> StageReport {
    let mut report = StageReport::default();
    let _ = std::fs::remove_dir_all(dest);
    if let Err(e) = std::fs::create_dir_all(dest) {
        report
            .missing
            .push(format!("创建 staging 目录失败（{e}）"));
        return report;
    }
    for f in files {
        match std::fs::copy(src_root.join(f), dest.join(f)) {
            Ok(_) => report.copied += 1,
            Err(e) => report.missing.push(format!("{f}（{e}）")),
        }
    }
    for d in dirs {
        copy_dir(&src_root.join(d), &dest.join(d), d, true, &mut report);
    }
    report
}

/// 递归拷贝目录内容；`top` 为真时「空目录」算缺件（顶层必需目录）。
///
/// 嵌套空目录只跳过：上游留一个空子目录不是事故，不该因此挂掉整个构建；
/// 符号链接**不跟随**——跟随会把包外内容悄悄拖进安装包，也可能自指递归爆栈。
fn copy_dir(src: &Path, dest: &Path, label: &str, top: bool, report: &mut StageReport) {
    let entries = match std::fs::read_dir(src) {
        Ok(entries) => entries.flatten().collect::<Vec<_>>(),
        Err(e) => {
            report.missing.push(format!("{label}/（{e}）"));
            return;
        }
    };
    if entries.is_empty() {
        if top {
            report.missing.push(format!("{label}/（源目录为空）"));
        }
        return;
    }
    if let Err(e) = std::fs::create_dir_all(dest) {
        report.missing.push(format!("{label}/（{e}）"));
        return;
    }
    for entry in entries {
        let name = entry.file_name();
        let child = format!("{label}/{}", name.to_string_lossy());
        let child_dest: PathBuf = dest.join(&name);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                report.missing.push(format!("{child}（{e}）"));
                continue;
            }
        };
        if file_type.is_symlink() {
            report
                .missing
                .push(format!("{child}（符号链接，不跟随；请改为真实文件/目录）"));
        } else if file_type.is_dir() {
            copy_dir(&entry.path(), &child_dest, &child, false, report);
        } else {
            match std::fs::copy(entry.path(), &child_dest) {
                Ok(_) => report.copied += 1,
                Err(e) => report.missing.push(format!("{child}（{e}）")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// 唯一临时根（并行跑也不撞；用完各自清理）。
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "embed-plugins-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时根");
        dir
    }

    fn write_file(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("建父目录");
        std::fs::write(&path, body).expect("写文件");
    }

    /// 一个「完整包」：顶层文件齐，且 `lib/` 里带嵌套子目录（v3.0.5 的真实形态）。
    fn complete_package(root: &Path) {
        write_file(root, "package.json", "{}");
        write_file(root, "cordis.patch.yml", "[]");
        write_file(root, "lib/index.js", "module.exports = {}");
        write_file(root, "lib/types/index.d.ts", "export {}");
    }

    const FILES: &[&str] = &["package.json", "cordis.patch.yml"];
    const DIRS: &[&str] = &["lib"];

    #[test]
    fn stages_top_files_and_recurses_subdirs() {
        let root = temp_root("recursive");
        complete_package(&root);
        let dest = root.join("out");
        let report = stage_package(&root, &dest, FILES, DIRS);
        assert!(report.is_complete(), "不该缺件：{:?}", report.missing);
        assert_eq!(report.copied, 4);
        assert!(
            dest.join("lib/types/index.d.ts").exists(),
            "子目录必须递归拷进来（v3.0.5 的 lib/types 就是旧实现丢的那一层）"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_top_dir_is_missing() {
        let root = temp_root("empty-lib");
        write_file(&root, "package.json", "{}");
        std::fs::create_dir_all(root.join("lib")).expect("建空 lib");
        let report = stage_package(&root, &root.join("out"), &["package.json"], DIRS);
        assert!(!report.is_complete(), "空的 lib/ 必须算缺件");
        assert!(
            report
                .missing
                .iter()
                .any(|m| m.starts_with("lib/") && m.contains("为空")),
            "{:?}",
            report.missing
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_empty_dir_is_tolerated() {
        let root = temp_root("nested-empty");
        complete_package(&root);
        std::fs::create_dir_all(root.join("lib/emptysub")).expect("建嵌套空目录");
        let report = stage_package(&root, &root.join("out"), FILES, DIRS);
        assert!(
            report.is_complete(),
            "嵌套空目录不该让构建失败：{:?}",
            report.missing
        );
        assert_eq!(report.copied, 4);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_source_is_reported_with_reason() {
        let root = temp_root("missing");
        let report = stage_package(&root, &root.join("out"), FILES, DIRS);
        assert!(!report.is_complete());
        assert!(
            report.missing.iter().any(|m| m.starts_with("package.json")),
            "{:?}",
            report.missing
        );
        assert!(
            report.missing.iter().any(|m| m.starts_with("lib/")),
            "{:?}",
            report.missing
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_files_in_dest_are_wiped() {
        let root = temp_root("stale");
        complete_package(&root);
        let dest = root.join("out");
        write_file(&dest, "lib/ghost.js", "上一次构建的残留");
        let report = stage_package(&root, &dest, FILES, DIRS);
        assert!(report.is_complete(), "{:?}", report.missing);
        assert!(
            !dest.join("lib/ghost.js").exists(),
            "目标目录必须先清空，残留不能被打进安装包"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_not_followed() {
        let root = temp_root("symlink");
        complete_package(&root);
        std::os::unix::fs::symlink("/etc/hosts", root.join("lib/outside.js")).expect("建符号链接");
        let report = stage_package(&root, &root.join("out"), FILES, DIRS);
        assert!(!report.is_complete(), "符号链接必须报缺件，不能跟随");
        assert!(
            report.missing.iter().any(|m| m.contains("符号链接")),
            "{:?}",
            report.missing
        );
        assert!(
            !root.join("out/lib/outside.js").exists(),
            "包外内容不能被拷进 staging"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
