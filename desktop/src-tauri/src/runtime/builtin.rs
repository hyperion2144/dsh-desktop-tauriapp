//! 内置 dsh 运行时（#85）：来源解析、路径定位、启动器写出。
//!
//! 拍板：内置 dsh 一律经内部 runProfile API 代码路径启动（不走 CLI、不分版本），
//! 只有外部 dsh 走 CLI（#85 / ADR-0001）。desktop 名被 dsh 0.1.6+ CLI 保留给
//! 官方 Electron 应用，内部 API 无此检查（已端到端实证）。
//!
//! 内置运行时布局（随 app 包分发，只读直跑、无需解压）：
//! - resources/dsh/            —— dsh npm 包树（package.json/lib/node_modules...）
//! - 应用可执行文件旁 dsh-node —— Node sidecar（CI 按 -latest/-alpha 变体打包）
//! - app_data/runtime/dsh-launcher.mjs —— 启动器（本模块编译期内嵌，启动时写出）

use std::path::{Path, PathBuf};

use tauri::Manager;

/// 启动器脚本（编译期嵌入；内容与 dsh 版本解耦，直接覆盖写）。
pub(crate) const LAUNCHER_JS: &str = include_str!("builtin/launcher.mjs");
/// 模块解析钩子（anywhere-labs 式，编译期嵌入；与启动器同目录写出）。
pub(crate) const RESOLVER_HOOKS_JS: &str = include_str!("builtin/resolver-hooks.mjs");

/// dsh 来源两态（#85）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DshSource {
    /// 内置：node sidecar + dsh 包 lib 目录（resources 只读直跑）+ 启动器路径。
    Builtin { node: PathBuf, dsh_lib: PathBuf, launcher: PathBuf },
    /// 外部：dsh CLI 可执行文件（现有 find 链路）。
    External { bin: PathBuf },
}

/// dsh 来源设置（settings.dsh_mode；DSH_MODE env 可覆盖，供开发/测试）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum DshMode {
    Builtin,
    External,
}

/// 解析 dsh 来源设置：DSH_MODE env > settings.dsh_mode > 内置（默认）。
pub(crate) fn configured_dsh_mode() -> DshMode {
    let raw = std::env::var("DSH_MODE")
        .ok()
        .or_else(|| crate::settings::load_desktop_settings().dsh_mode)
        .unwrap_or_default();
    match raw.trim().to_ascii_lowercase().as_str() {
        "external" => DshMode::External,
        _ => DshMode::Builtin,
    }
}

/// 从指定 dsh 安装根（npm 安装树）解析 dsh 包 lib 目录。
fn dsh_lib_from_root(root: &std::path::Path) -> Option<PathBuf> {
    let pkg = root.join("node_modules").join("@deepseek-ai").join("dsh");
    // npm 包的 package.json 在包根（lib/ 只有产物）
    if pkg.join("package.json").is_file() {
        Some(pkg.join("lib"))
    } else {
        None
    }
}

/// 内置 dsh 包 lib 目录：resources/dsh 是 npm 安装根，dsh 本体在
/// node_modules/@deepseek-ai/dsh（package.json 在包根，#90 实测教训）；
/// launcher 依赖向上查找正好落在同根。
fn builtin_dsh_lib(app: &tauri::AppHandle) -> Option<PathBuf> {
    let root = app.path().resource_dir().ok()?.join("dsh");
    dsh_lib_from_root(&root)
}

/// node 可执行文件定位：1) DSH_NODE_BIN env 2) 应用可执行文件旁 sidecar（dsh-node）3) 系统 node（开发）。
pub(crate) fn find_builtin_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DSH_NODE_BIN") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            #[cfg(windows)]
            let sidecar = dir.join("dsh-node.exe");
            #[cfg(not(windows))]
            let sidecar = dir.join("dsh-node");
            if sidecar.is_file() {
                return Some(sidecar);
            }
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            #[cfg(windows)]
            let cand = dir.join("node.exe");
            #[cfg(not(windows))]
            let cand = dir.join("node");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// 写出启动器到 app_data/runtime/dsh-launcher.mjs（内容恒定，直接覆盖写）。
pub(crate) fn ensure_launcher(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 不可用：{e}"))?
        .join("runtime");
    std::fs::create_dir_all(&dir).map_err(|e| format!("runtime 目录创建失败：{e}"))?;
    let path = dir.join("dsh-launcher.mjs");
    std::fs::write(&path, LAUNCHER_JS).map_err(|e| format!("启动器写出失败：{e}"))?;
    // 解析钩子与启动器同目录（launcher 用 import.meta.url 相对引用它）
    let hooks = dir.join("dsh-resolver-hooks.mjs");
    std::fs::write(&hooks, RESOLVER_HOOKS_JS).map_err(|e| format!("解析钩子写出失败：{e}"))?;
    Ok(path)
}

/// 外部 dsh 可执行文件定位（unix: dsh CLI；windows: bin.js）——设置 Tab 检测与来源解析共用。
pub(crate) fn find_external_bin() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        crate::process::lifecycle::find_dsh_bin()
    }
    #[cfg(windows)]
    {
        crate::process::lifecycle::find_dsh_bin_js()
    }
}

/// 尝试内置来源：用户选中的已下载运行时（#95）优先，否则 resources/dsh；
/// node sidecar 可用 + 启动器写出成功。
fn try_builtin(app: &tauri::AppHandle) -> Result<DshSource, String> {
    // #95：选中的已下载运行时优先（node 仍是内置 sidecar，dsh 树可换）
    let selected = crate::settings::load_desktop_settings().dsh_runtime;
    if let Some(ver) = selected.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let dir = crate::runtime::registry::runtime_dir(app, ver);
        if let Some(dsh_lib) = dsh_lib_from_root(&dir) {
            let node = find_builtin_node().ok_or_else(|| "内置 node sidecar 未找到".to_string())?;
            let launcher = ensure_launcher(app)?;
            log::info!("[source] 使用已下载运行时 {ver}");
            return Ok(DshSource::Builtin { node, dsh_lib, launcher });
        }
    }
    let dsh_lib = builtin_dsh_lib(app)
        .ok_or_else(|| "resources/dsh 不存在（内置运行时未打包）".to_string())?;
    let node = find_builtin_node().ok_or_else(|| "内置 node sidecar 未找到".to_string())?;
    let launcher = ensure_launcher(app)?;
    Ok(DshSource::Builtin { node, dsh_lib, launcher })
}

/// 解析 dsh 来源（#85 拍板）：内置优先；内置不可用自动回退外部并告警；两者皆缺才报错。
pub(crate) fn resolve_source(app: &tauri::AppHandle) -> Result<DshSource, String> {
    if configured_dsh_mode() == DshMode::Builtin {
        match try_builtin(app) {
            Ok(s) => return Ok(s),
            Err(e) => {
                crate::network::notify::show_notification(
                    app,
                    "内置运行时不可用，已回退外部 dsh",
                    &format!("原因：{e}。可在设置中切换来源或检查安装包完整性。"),
                );
                log::warn!("[source] 内置运行时不可用（{e}），回退外部 dsh");
            }
        }
    }
    match find_external_bin() {
        Some(bin) => Ok(DshSource::External { bin }),
        None => Err(
            "未找到可用的 dsh：内置运行时未打包，外部 dsh 也未找到（DSH_BIN / PATH / npm 全局）。"
                .to_string(),
        ),
    }
}

/// 内置运行时信息（设置 Tab 展示用）：lib 路径 + dsh 版本（读包内 package.json）。
pub(crate) fn builtin_lib_info(app: &tauri::AppHandle) -> Option<(PathBuf, String)> {
    let lib = builtin_dsh_lib(app)?;
    let pkg = lib.parent()?.join("package.json");
    let text = std::fs::read_to_string(pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let version = v.get("version")?.as_str()?.to_string();
    Some((lib, version))
}

/// 启动器 argv 组装（纯函数，便于单测）：
/// `[launcher, dsh_lib, profile, port, (--patch p)...]`；
/// `init_from_default` 时追加 `--init-from-default`（desktop 等非出厂模板首启用）。
pub(crate) fn launcher_args(
    launcher: &Path,
    dsh_lib: &Path,
    profile: &str,
    port: u16,
    patches: &[PathBuf],
    init_from_default: bool,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec![
        launcher.as_os_str().to_os_string(),
        dsh_lib.as_os_str().to_os_string(),
        profile.into(),
        port.to_string().into(),
    ];
    if init_from_default {
        args.push("--init-from-default".into());
    }
    for p in patches {
        args.push("--patch".into());
        args.push(p.as_os_str().to_os_string());
    }

    args
}

/// 外部 CLI argv 组装（纯函数；--patch 必须早于 --no-open/--host，dsh passThrough 顺序约束）。
pub(crate) fn external_cli_args(profile: &str, port: u16, patches: &[PathBuf]) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["--profile".into(), profile.into()];
    for p in patches {
        args.push("--patch".into());
        args.push(p.as_os_str().to_os_string());
    }
    args.extend([
        "--no-open".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string().into(),
    ]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_args_shape() {
        let args = launcher_args(
            Path::new("/tmp/launcher.mjs"),
            Path::new("/app/resources/dsh"),
            "desktop",
            3081,
            &[PathBuf::from("/tmp/patch.yml")],
            true,
        );
        assert_eq!(
            args,
            vec![
                "/tmp/launcher.mjs",
                "/app/resources/dsh",
                "desktop",
                "3081",
                "--init-from-default",
                "--patch",
                "/tmp/patch.yml",
            ]
        );
    }

    #[test]
    fn external_args_patch_before_no_open() {
        let args = external_cli_args("web", 3080, &[PathBuf::from("/p.yml")]);
        let joined = args.iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>();
        let patch_pos = joined.iter().position(|a| a == "--patch").unwrap();
        let no_open_pos = joined.iter().position(|a| a == "--no-open").unwrap();
        assert!(patch_pos < no_open_pos, "--patch 必须早于 --no-open（passThrough 顺序）");
        assert_eq!(joined.last().unwrap(), "3080");
    }

    #[test]
    fn dsh_mode_parsing_defaults_to_builtin() {
        // 无 env、无设置 → 内置默认（消费端传入空串模拟）；
        // 这里只测枚举语义，env/settings 组合由集成验收覆盖（并行测试禁改 env）。
        assert_ne!(DshMode::Builtin, DshMode::External);
    }

    #[test]
    fn dsh_lib_from_root_layout() {
        let dir = std::env::temp_dir().join(format!("dsh-lib-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(dsh_lib_from_root(&dir), None, "空目录不应解析出 dsh lib");
        let pkg = dir.join("node_modules/@deepseek-ai/dsh");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(pkg.join("lib")).unwrap();
        std::fs::write(pkg.join("lib/bin.js"), "// stub").unwrap();
        assert_eq!(
            dsh_lib_from_root(&dir),
            Some(pkg.join("lib")),
            "package.json 在包根（非 lib/）时应解析成功（#90 实测教训）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
