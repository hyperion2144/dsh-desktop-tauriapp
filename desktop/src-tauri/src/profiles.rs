//! Profile 扫描/切换/新建。
//!
//! 迁移自 lib.rs 功能区域（profiles）。

use tauri::{AppHandle, Manager};
use std::sync::atomic::Ordering;
use crate::runtime::state::DshState;
use crate::settings::{load_desktop_settings, save_desktop_settings};
use crate::network::notify::show_notification;
use crate::ui::tray::{restart_dsh_in_mode, refresh_tray_mode};
use crate::commands::prompt_input;
use crate::dsh_home;
#[cfg(target_os = "windows")]
use crate::process::lifecycle::{find_node, find_dsh_bin_js};
#[cfg(not(target_os = "windows"))]
use crate::process::lifecycle::find_dsh_bin;
/// 扫描 $DSH_HOME/profiles 下的可 boot-profile（bundles 顺序先 base 后 web-app 才可选）。
#[derive(serde::Serialize)]
pub(crate) struct ProfileInfo {
    pub(crate) name: String,
    pub(crate) active: bool,
    pub(crate) selectable: bool,
}

pub(crate) fn scan_profiles() -> Vec<ProfileInfo> {
    let active = load_desktop_settings().active_profile.unwrap_or_else(|| "web".into());
    let mut list = Vec::new();
    let root = dsh_home().join("profiles");
    let Ok(entries) = std::fs::read_dir(&root) else { return list };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "node_modules" || !entry.path().is_dir() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path().join("package.json")) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let bundles = value
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(|b| b.as_array());
        let _ = bundles; // 暂不校验 bundle 顺序：全部 profile 可选（起不起来的会走错误页提示）
        list.push(ProfileInfo { name: name.clone(), active: name == active, selectable: true });
    }
    list
}

/// 校验 profile 名：仅字母数字下划线连字符，1..=32。
pub(crate) fn valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 切换 profile：写 settings 后走统一重启流程（spawn 时按新 profile 拉起）。
pub(crate) fn switch_profile(app: &AppHandle, name: &str) {
    if !valid_profile_name(name) {
        show_notification(app, "切换 Profile 失败", "名称不合法");
        return;
    }
    let mut settings = load_desktop_settings();
    if settings.active_profile.as_deref() == Some(name) {
        return;
    }
    settings.active_profile = Some(name.to_string());
    save_desktop_settings(&settings);
    log::info!("[tray] 切换 profile -> {name}");
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode);
}

/// 执行 `dsh plugin --profile <name> add <pkg>`（Windows 走 node<bin.js>）。
pub(crate) fn run_profile_plugin_add(profile: &str, pkg: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Some(node) = find_node() else { return false };
        let Some(js) = find_dsh_bin_js() else { return false };
        std::process::Command::new(node)
            .arg(&js)
            .args(["plugin", "--profile", profile, "add", "--config.minimumReleaseAge=0"])
            .arg(pkg)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let Some(dsh) = find_dsh_bin() else { return false };
        std::process::Command::new(&dsh)
            .args(["plugin", "--profile", profile, "add", "--config.minimumReleaseAge=0"])
            .arg(pkg)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// 取 dsh 版本串（doctor 体检用；找不到 dsh / 执行失败返回 None）。
pub(crate) fn dsh_version() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let node = find_node()?;
        let js = find_dsh_bin_js()?;
        let out = std::process::Command::new(node)
            .arg(js)
            .arg("--version")
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let dsh = find_dsh_bin()?;
        let out = std::process::Command::new(dsh).arg("--version").output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

/// 新建 profile 流程：弹窗输入名称 → plugin add base + web-app。
pub(crate) fn create_profile_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(name) = prompt_input(&handle, "new-profile", "新建 Profile", "profile 名称（字母/数字/_/-）", "").await else {
            return;
        };
        if !valid_profile_name(&name) {
            show_notification(&handle, "新建 Profile 失败", "名称仅允许字母、数字、_ 与 -（1-32 字符）");
            return;
        }
        if dsh_home().join("profiles").join(&name).exists() {
            show_notification(&handle, "新建 Profile 失败", &format!("{name} 已存在"));
            return;
        }
        let name_for_cmd = name.clone();
        let failed = tauri::async_runtime::spawn_blocking(move || {
            for pkg in ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] {
                if !run_profile_plugin_add(&name_for_cmd, pkg) {
                    return Some(pkg.to_string());
                }
            }
            None
        })
        .await
        .unwrap_or(Some("安装任务异常".into()));
        match failed {
            None => {
                log::info!("[tray] 新建 profile 成功：{name}");
                show_notification(&handle, "新建 Profile 成功", &format!("{name} 已创建（未自动切换）"));
            }
            Some(pkg) => {
                log::error!("[tray] 新建 profile 失败：{pkg}");
                show_notification(&handle, "新建 Profile 失败", &format!("{pkg} 安装失败，请查看日志"));
            }
        }
        refresh_tray_mode(&handle);
    });
}

