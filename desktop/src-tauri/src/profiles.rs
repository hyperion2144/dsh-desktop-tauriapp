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
use crate::process::lifecycle::{find_dsh_bin, dsh_runtime_path};
/// 扫描 $DSH_HOME/profiles 下的可 boot-profile（bundles 顺序先 base 后 web-app 才可选）。
#[derive(serde::Serialize)]
pub(crate) struct ProfileInfo {
    pub(crate) name: String,
    pub(crate) active: bool,
    pub(crate) selectable: bool,
}

/// profile 是否已初始化（有 package.json）：desktop 等非出厂模板首启时
/// 启动器需追加 --init-from-default（从 web 模板初始化，#85）。
pub(crate) fn profile_exists(name: &str) -> bool {
    dsh_home().join("profiles").join(name).join("package.json").is_file()
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
            // GUI 启动的 app PATH 缺 nvm/homebrew node：dsh 内部转发 pnpm 需要可用 node
            .env("PATH", dsh_runtime_path(&dsh))
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


// ── profile 迁移（#88，设计契约来自 #83 研究报告）────────────────

/// 迁移排除规则（纯函数）：
/// - 锁/临时/编辑器残留：*.lock *.pid *.tmp *.swp ._*/.DS_Store
/// - 启动即重写：cordis.yml（prepareProfile 每次写 []，复制无意义）
/// - 绝对路径符号链接目录：.dsh-module-fallback/（dsh 启动自动重建）
/// - 纯诊断日志：.plugin-manager/logs/、node_modules/.cache/
pub(crate) fn migration_skips(rel: &str, file_name: &str, is_dir: bool) -> bool {
    if file_name == ".DS_Store" || file_name == "cordis.yml" || file_name.starts_with("._") {
        return true;
    }
    const SUFFIXES: [&str; 4] = [".lock", ".pid", ".tmp", ".swp"];
    if SUFFIXES.iter().any(|s| file_name.ends_with(s)) {
        return true;
    }
    if rel.starts_with(".dsh-module-fallback") || rel.starts_with(".plugin-manager/logs") {
        return true;
    }
    if is_dir && file_name == ".cache" && rel.starts_with("node_modules") {
        return true;
    }
    false
}

/// 复制统计（迁移结果汇报用）。
#[derive(Default)]
pub(crate) struct CopyStats {
    pub(crate) files: u64,
    pub(crate) dirs: u64,
    pub(crate) links: u64,
    pub(crate) skipped: u64,
}

/// 递归复制 profile 目录树（排除规则 + 符号链接感知）。
/// `root` 用于计算相对路径供排除规则；unix 符号链接原样重建（node_modules/.bin
/// 是相对链接，portable）；windows 重建需要特权，树内目标退化为复制、树外跳过。
fn copy_dir_filtered(
    root: &std::path::Path,
    cur: &std::path::Path,
    dst_cur: &std::path::Path,
    stats: &mut CopyStats,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dst_cur)?;
    for entry in std::fs::read_dir(cur)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = entry.file_type()?;
        let rel = entry
            .path()
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        if migration_skips(&rel, &name, ft.is_dir()) {
            stats.skipped += 1;
            continue;
        }
        if ft.is_symlink() {
            let target = std::fs::read_link(entry.path())?;
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&target, dst_cur.join(&name))?;
                stats.links += 1;
            }
            #[cfg(windows)]
            {
                let resolved = if target.is_absolute() {
                    target.clone()
                } else {
                    cur.join(&target)
                };
                match resolved.canonicalize() {
                    Ok(p) if p.starts_with(root.canonicalize().unwrap_or_else(|_| root.to_path_buf())) => {
                        if p.is_dir() {
                            copy_dir_filtered(root, &p, &dst_cur.join(&name), stats)?;
                        } else {
                            std::fs::copy(&p, dst_cur.join(&name))?;
                            stats.files += 1;
                        }
                    }
                    _ => stats.skipped += 1,
                }
            }
            continue;
        }
        if ft.is_dir() {
            copy_dir_filtered(root, &entry.path(), &dst_cur.join(&name), stats)?;
            stats.dirs += 1;
        } else {
            std::fs::copy(entry.path(), dst_cur.join(&name))?;
            stats.files += 1;
        }
    }
    Ok(())
}

/// 读 profile 的 dsh.profile.bundles（迁移后校验用）。
fn profile_bundles(profile_dir: &std::path::Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(profile_dir.join("package.json")).ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&text).ok()?;
    pkg.get("dsh")?
        .get("profile")?
        .get("bundles")?
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
}

/// 迁移 profile（A→B 全量复制，#88）：
/// - 目标为当前激活 profile 直接拒绝；目标已存在需 overwrite=true（先备份 mv 为 .bak-<ts>）
/// - 源为激活 profile 时先停自家实例（台账/child 判定）；外部实例在跑则拒绝不代杀
/// - 复制排除锁/临时/cordis.yml/.dsh-module-fallback 等；完成后校验 bundles 一致
/// - 不自动切换：用户另行在设置里切换（switch_profile_command）
pub(crate) async fn migrate_profile(
    app: &AppHandle,
    source: String,
    dest: String,
    overwrite: bool,
) -> Result<String, String> {
    if !valid_profile_name(&source) || !valid_profile_name(&dest) {
        return Err("名称仅允许字母、数字、_ 与 -（1-32 字符）".into());
    }
    let active = crate::settings::configured_profile();
    if dest == active {
        return Err(format!("目标 profile {dest} 正在使用，拒绝迁移（请先切换到其他 profile）"));
    }
    let profiles_root = dsh_home().join("profiles");
    let src_dir = profiles_root.join(&source);
    let dst_dir = profiles_root.join(&dest);
    if !src_dir.join("package.json").is_file() {
        return Err(format!("源 profile {source} 不存在或缺少 package.json"));
    }
    // 源为激活 profile：先停自家实例（#83：锁/manifest 被运行中实例持有，必须停机复制）
    if source == active {
        let port = crate::settings::port_for_profile(&source);
        let ours = crate::runtime::instances::load_instances()
            .iter()
            .any(|r| r.profile == source);
        let child_alive = app.state::<DshState>().child.lock().unwrap().is_some();
        if !ours && !child_alive && crate::process::lifecycle::port_open(port) {
            return Err(format!(
                "源 profile {source} 的外部实例正在运行，请先手动停止（不代杀外部进程）"
            ));
        }
        if let Some(mut child) = app.state::<DshState>().child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        crate::runtime::instances::remove_instance(&source);
        let _ = crate::process::lifecycle::stop_port_owner(port).await;
        log::info!("[migrate] 源 {source} 为激活 profile，已停自家实例");
    }
    // 目标已存在：备份后替换
    let mut bak: Option<std::path::PathBuf> = None;
    if dst_dir.exists() {
        if !overwrite {
            return Err(format!("目标 profile {dest} 已存在（需确认覆盖）"));
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bak_path = profiles_root.join(format!("{dest}.bak-{stamp}"));
        std::fs::rename(&dst_dir, &bak_path).map_err(|e| format!("备份旧目标失败：{e}"))?;
        bak = Some(bak_path);
    }
    // 复制（阻塞 IO 放 spawn_blocking）
    let root = src_dir.clone();
    let dst = dst_dir.clone();
    let stats = tauri::async_runtime::spawn_blocking(move || {
        let mut stats = CopyStats::default();
        let result = copy_dir_filtered(&root, &root, &dst, &mut stats);
        result.map(|_| stats)
    })
    .await
    .map_err(|e| format!("复制任务异常：{e}"))?
    .map_err(|e| format!("复制失败：{e}"))?;
    // 校验 bundles 一致（源没有 bundles 时跳过校验）
    let src_bundles = profile_bundles(&src_dir);
    let dst_bundles = profile_bundles(&dst_dir);
    if src_bundles.is_some() && src_bundles != dst_bundles {
        return Err(format!(
            "迁移后 bundles 校验不一致（源 {src_bundles:?} vs 目标 {dst_bundles:?}），请检查目标目录"
        ));
    }
    let summary = format!(
        "已迁移 {source} → {dest}：文件 {}、目录 {}、链接 {}、排除 {}{}",
        stats.files,
        stats.dirs,
        stats.links,
        stats.skipped,
        bak.as_ref()
            .map(|p| format!("；旧目标已备份为 {}", p.display()))
            .unwrap_or_default()
    );
    log::info!("[migrate] {summary}");
    show_notification(app, "Profile 迁移完成", &summary);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_skips_locks_and_regenerables() {
        // 锁/临时/编辑器残留
        assert!(migration_skips("a/ledger.lock", "ledger.lock", false));
        assert!(migration_skips("x.pid", "x.pid", false));
        assert!(migration_skips("y.tmp", "y.tmp", false));
        assert!(migration_skips("z.swp", "z.swp", false));
        assert!(migration_skips("._Icon", "._Icon", false));
        assert!(migration_skips(".DS_Store", ".DS_Store", false));
        // 启动即重写 / 绝对符号链接目录 / 诊断日志
        assert!(migration_skips("cordis.yml", "cordis.yml", false));
        assert!(migration_skips(".dsh-module-fallback/node_modules", "node_modules", true));
        assert!(migration_skips(".plugin-manager/logs/a.log", "a.log", false));
        assert!(migration_skips("node_modules/.cache", ".cache", true));
        // 正常文件不排
        assert!(!migration_skips("package.json", "package.json", false));
        assert!(!migration_skips("node_modules/.bin/dsh", "dsh", false));
        assert!(!migration_skips("cordis.patch.yml", "cordis.patch.yml", false));
    }

    #[test]
    fn copy_tree_filters_and_preserves_links() {
        let dir = std::env::temp_dir().join(format!("dsh-mig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src");
        let dst = dir.join("dst");
        std::fs::create_dir_all(src.join("node_modules/.bin")).unwrap();
        std::fs::create_dir_all(src.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(src.join(".dsh-module-fallback/node_modules")).unwrap();
        std::fs::write(
            src.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}"#,
        )
        .unwrap();
        std::fs::write(src.join("cordis.yml"), "[]").unwrap();
        std::fs::write(src.join("run.lock"), "x").unwrap();
        std::fs::write(src.join("node_modules/pkg/index.js"), "hi").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("../pkg", src.join("node_modules/.bin/pkg-link")).unwrap();

        let mut stats = CopyStats::default();
        copy_dir_filtered(&src, &src, &dst, &mut stats).unwrap();

        // 排除项没过来
        assert!(!dst.join("cordis.yml").exists());
        assert!(!dst.join("run.lock").exists());
        assert!(!dst.join(".dsh-module-fallback").exists());
        // 正常内容在
        assert!(dst.join("node_modules/pkg/index.js").is_file());
        // bundles 校验可读且一致
        assert_eq!(
            profile_bundles(&src),
            Some(vec!["@deepseek-ai/dsh-base".to_string()])
        );
        assert_eq!(profile_bundles(&src), profile_bundles(&dst));
        // 符号链接重建（unix）
        #[cfg(unix)]
        {
            let l = dst.join("node_modules/.bin/pkg-link");
            assert!(l.symlink_metadata().unwrap().file_type().is_symlink());
            assert_eq!(std::fs::read_link(&l).unwrap(), std::path::PathBuf::from("../pkg"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
