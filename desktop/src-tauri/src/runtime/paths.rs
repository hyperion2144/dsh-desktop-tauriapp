//! 资源路径工具（#123）：Windows verbatim 前缀归一。
//!
//! Tauri 的 `resource_dir()` 在 Windows 上可能返回带 `\\?\` 前缀的扩展路径。
//! 该形态对 Rust 侧 fs 操作无碍，但原样传给 Node/子进程后，`pathToFileURL`
//! 会生成无效 file URL，模块 import 静默失败（#123：runProfile not found）。
//! 所有要跨进程传递（spawn 参数、写进脚本内容、.npmrc 等）的资源路径
//! 必须先经过本模块归一。

use tauri::Manager;
/// 去除路径的 Windows verbatim 前缀：`\\?\D:\…` → `D:\…`；`\\?\UNC\srv\…` → `\\srv\…`；
/// 无前缀原样返回。纯字符串处理，跨平台行为一致（resource_dir 为本地盘，
/// 实际不会出现 UNC 形态，仍一并处理求稳）。
pub(crate) fn deverbatim(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// 归一后的资源目录（`resource_dir()` 去 verbatim）。消费方按需拼
/// `plugins/…` 等子路径（#123：此前各处直接用 resource_dir 原样值）。
pub(crate) fn resources_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().resource_dir().ok().map(|r| deverbatim(&r))
}

/// 归一后的内置 dsh 树根（`resources/dsh`）。pnpm.cjs / 包内 bin.js /
/// node_modules 解析等多处共用（#123 统一入口，替代散落的
/// `resource_dir().join("dsh")`）。
pub(crate) fn resources_dsh_root(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    resources_dir(app).map(|r| r.join("dsh"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deverbatim_strips_local_drive_prefix() {
        let out = deverbatim(std::path::Path::new(
            r"\\?\D:\apps\DeepSeek Harness Desktop\dsh\node_modules",
        ));
        assert_eq!(out, std::path::PathBuf::from(r"D:\apps\DeepSeek Harness Desktop\dsh\node_modules"));
    }

    #[test]
    fn deverbatim_maps_unc_prefix_to_slashes() {
        let out = deverbatim(std::path::Path::new(r"\\?\UNC\server\share\dsh"));
        assert_eq!(out, std::path::PathBuf::from(r"\\server\share\dsh"));
    }

    #[test]
    fn deverbatim_keeps_plain_path_untouched() {
        let plain = "/Applications/DeepSeek Harness Desktop.app/Contents/Resources/dsh";
        assert_eq!(deverbatim(std::path::Path::new(plain)), std::path::PathBuf::from(plain));
        // 无前缀的 Windows 形态同样原样返回
        let win = r"D:\apps\dsh";
        assert_eq!(deverbatim(std::path::Path::new(win)), std::path::PathBuf::from(win));
    }
}
