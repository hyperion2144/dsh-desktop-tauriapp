//! Profile 扫描/切换/新建。
//!
//! 迁移自 lib.rs 功能区域（profiles）。

use tauri::{AppHandle, Manager};
use std::sync::atomic::Ordering;
use crate::runtime::state::DshState;
use crate::settings::load_desktop_settings;
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

/// profile 完整性检查结果。
pub(crate) struct ProfileHealth {
    pub dir_exists: bool,
    pub missing_files: Vec<&'static str>,
    pub node_modules_exists: bool,
}

/// profile 完整性检查：检查目录、结构文件（可解析）、node_modules。
/// 不检查 node_modules/@deepseek-ai/dsh-web-app —— 共享包在父级 node_modules，Node 向上解析。
pub(crate) fn profile_health_check(name: &str) -> ProfileHealth {
    let dir = dsh_home().join("profiles").join(name);
    if !dir.exists() {
        return ProfileHealth { dir_exists: false, missing_files: vec![], node_modules_exists: false };
    }
    let mut missing = vec![];
    // package.json：存在且可解析为 JSON
    let pj = dir.join("package.json");
    if !pj.is_file() || std::fs::read_to_string(&pj).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).is_none() {
        missing.push("package.json");
    }
    // pnpm-workspace.yaml：存在且可解析为 YAML
    let ws = dir.join("pnpm-workspace.yaml");
    if !ws.is_file() || std::fs::read_to_string(&ws).ok().and_then(|s| serde_yaml::from_str::<serde_yaml::Value>(&s).ok()).is_none() {
        missing.push("pnpm-workspace.yaml");
    }
    // cordis.yml：存在且可解析为 YAML
    let cy = dir.join("cordis.yml");
    if !cy.is_file() || std::fs::read_to_string(&cy).ok().and_then(|s| serde_yaml::from_str::<serde_yaml::Value>(&s).ok()).is_none() {
        missing.push("cordis.yml");
    }
    // cordis.patch.yml：存在且可解析为 YAML
    let cp = dir.join("cordis.patch.yml");
    if !cp.is_file() || std::fs::read_to_string(&cp).ok().and_then(|s| serde_yaml::from_str::<serde_yaml::Value>(&s).ok()).is_none() {
        missing.push("cordis.patch.yml");
    }
    ProfileHealth {
        dir_exists: true,
        missing_files: missing,
        node_modules_exists: dir.join("node_modules").is_dir(),
    }
}

/// 写 profile 模板文件（从 pnpm_direct_add :342-370 提取）。
fn write_profile_templates(dir: &std::path::Path, profile: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建 profile 目录失败：{e}"))?;
    if !dir.join("package.json").is_file() {
        std::fs::write(
            dir.join("package.json"),
            serde_json::json!({
                "name": profile,
                "private": true,
                "dependencies": {},
                "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
                "scripts": {
                    "postinstall": "rm -rf node_modules/@deepseek-ai/dsh-tools",
                    "postuninstall": "rm -rf node_modules/@deepseek-ai/dsh-tools"
                }
            })
            .to_string(),
        )
        .map_err(|e| format!("写 package.json 失败：{e}"))?;
    }
    if !dir.join("pnpm-workspace.yaml").is_file() {
        std::fs::write(
            dir.join("pnpm-workspace.yaml"),
            "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\nallowBuilds:\n  node-pty: true\n  protobufjs: true\n  git-hosted: true\n  cloudflared: true\n  sharp: true\n  ssh2: true\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  koffi: true\n",
        )
        .map_err(|e| format!("写 pnpm-workspace.yaml 失败：{e}"))?;
    }
    if !dir.join("cordis.yml").is_file() {
        std::fs::write(
            dir.join("cordis.yml"),
            "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n",
        )
        .map_err(|e| format!("写 cordis.yml 失败：{e}"))?;
    }
    if !dir.join("cordis.patch.yml").is_file() {
        std::fs::write(dir.join("cordis.patch.yml"), "[]\n")
            .map_err(|e| format!("写 cordis.patch.yml 失败：{e}"))?;
    }
    Ok(())
}

/// 在 profile 目录跑 pnpm install（从 pnpm_direct_add :390-421 提取）。
pub(crate) fn pnpm_install_profile(app: &tauri::AppHandle, profile: &str) -> Result<(), String> {
    use std::io::Read as _;
    use std::process::{Command, Stdio};
    let dir = crate::dsh_home().join("profiles").join(profile);
    let node = crate::runtime::builtin::find_builtin_node().ok_or("内置 node 不可用")?;
    let pnpm = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("dsh").join("node_modules").join("pnpm").join("bin").join("pnpm.cjs"))
        .ok_or("resource_dir 不可用")?;
    if !pnpm.is_file() {
        return Err("内置 pnpm 不存在".into());
    }
    let node_dir = node.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut paths = vec![];
    if let Some(shim_dir) = ensure_node_shim_dir(app) {
        paths.push(shim_dir);
    }
    paths.push(node_dir);
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    // pnpm postinstall 脚本可能需要 pwsh：动态探测候选目录（存在才 push，
    // 绝不硬塞固定字段——macOS/Linux 上 C: 冒号会让 join_paths 直接报错，#95 实测）
    for p in pwsh_fallback_dirs() {
        paths.push(p);
    }
    let joined = std::env::join_paths(&paths).map_err(|e| e.to_string())?;
    let mut child = Command::new(&node)
        .arg(&pnpm)
        .env("CI", "true")
        // 注：CI=true 是为防 pnpm 在无 TTY 下挂起交互，但 pnpm 同时会在 CI 环境默认
        // frozen-lockfile——profile 迁移/重建场景 lockfile 常落后于 package.json（如用户
        // 把插件改为 link: 本地路径后未重跑 install），必须显式关闭 frozen 才能重建。
        .args(["install", "--no-frozen-lockfile"])
        .current_dir(&dir)
        .env("PATH", &joined)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("pnpm 执行失败：{e}"))?;
    let stderr_handle = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut h) = stderr_handle {
            let _ = h.read_to_string(&mut buf);
        }
        buf
    });
    let stdout_handle = child.stdout.take();
    let out_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut h) = stdout_handle {
            let _ = h.read_to_string(&mut buf);
        }
        buf
    });
    let status = child.wait().map_err(|e| format!("pnpm wait 失败：{e}"))?;
    let stderr_tail = err_thread.join().unwrap_or_default();
    let stdout_tail = out_thread.join().unwrap_or_default();
    if !status.success() {
        let err = if stderr_tail.trim().is_empty() { stdout_tail } else { stderr_tail };
        let tail = err.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!("pnpm install 失败：{tail}"));
    }
    Ok(())
}

/// 修复 profile：按缺失项分别处理。
/// 目录不存在 → 建目录 + 写模板 + pnpm install
/// 文件缺失 → 写对应模板
/// node_modules 缺失 → pnpm install
pub(crate) fn repair_profile(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    let dir = dsh_home().join("profiles").join(name);
    let health = profile_health_check(name);
    if !health.dir_exists {
        log::info!("[profile] {name} 目录不存在，创建");
        write_profile_templates(&dir, name)?;
        pnpm_install_profile(app, name)?;
        return Ok(format!("{name} profile 已创建"));
    }
    if !health.missing_files.is_empty() {
        log::info!("[profile] {name} 缺失文件：{:?}，修复", health.missing_files);
        write_profile_templates(&dir, name)?;
    }
    if !health.node_modules_exists {
        log::info!("[profile] {name} node_modules 不存在，pnpm install");
        pnpm_install_profile(app, name)?;
    }
    Ok(format!("{name} profile 已修复"))
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
    // #90：持久化由 client→插件→dsh settings 服务承担
    log::info!("[tray] 切换 profile -> {name}");
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode, None);
}

/// 执行 `dsh plugin --profile <name> add <pkg>`（Windows 走 node<bin.js>）。
/// 返回（是否成功，stderr 尾部）——失败原因直供页面弹窗（#90 实测：系统通知
/// 未授权时被静默吞掉，用户只看到「没反应」）。
pub(crate) fn run_profile_plugin_add(
    app: &tauri::AppHandle,
    profile: &str,
    pkg: &str,
) -> (bool, String) {
    #[cfg(target_os = "windows")]
    {
        let Some(node) = find_node() else { return (false, "未找到 node".into()) };
        let Some(js) = find_dsh_bin_js() else { return (false, "未找到 dsh bin.js".into()) };
        // GUI PATH 缺 node/pnpm：shim 前置（dsh 转发 pnpm 的子进程需要）
        let mut parts = vec![];
        if let Some(shim_dir) = ensure_node_shim_dir(app) {
            parts.push(shim_dir);
        }
        if let Some(existing) = std::env::var_os("PATH") {
            // 必须 split_paths 展开：join_paths 遇到含冒号的整串元素会 Err →
            // unwrap_or_default 静默变空 PATH（子进程找不到 node/pnpm/git）
            parts.extend(std::env::split_paths(&existing));
        }
        let path_env = std::env::join_paths(&parts).unwrap_or_default();
        let out = std::process::Command::new(&node)
            // CI=true：pnpm/npm 检测 CI 环境跳过一切交互提示——GUI 无 TTY 时
            // 交互提示会在空 stdin 上永久挂起（#95 实测 smoke2 挂 10 分钟）
            .env("CI", "true")
            .env("PATH", path_env)
            .arg(&js)
            .args(["plugin", "--profile", profile, "add", "--config.minimumReleaseAge=0"])
            .arg(pkg)
            .stderr(std::process::Stdio::piped())
            .output();
        match out {
            Ok(o) if o.status.success() => (true, String::new()),
            Ok(o) => (false, String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => (false, format!("执行失败：{e}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let Some(dsh) = find_dsh_bin() else { return (false, "未找到外部 dsh CLI".into()) };
        // GUI PATH 缺 node/pnpm（nvm 装的 node 不在）：shim 目录前置，再拼 dsh 运行时 PATH
        let mut parts = vec![];
        if let Some(shim_dir) = ensure_node_shim_dir(app) {
            parts.push(shim_dir);
        }
        for p in std::env::split_paths(&dsh_runtime_path(&dsh)) {
            parts.push(p);
        }
        let path_env = std::env::join_paths(&parts).unwrap_or_default();
        let out = std::process::Command::new(&dsh)
            .env("PATH", path_env)
            .args(["plugin", "--profile", profile, "add", "--config.minimumReleaseAge=0"])
            .arg(pkg)
            .stderr(std::process::Stdio::piped())
            .output();
        match out {
            Ok(o) if o.status.success() => (true, String::new()),
            Ok(o) => (false, String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => (false, format!("执行失败：{e}")),
        }
    }
}

/// 内置感知的插件安装入口（#95 desktop 补建）：内置模式用「内置 node + 内置/选中运行时的
/// dsh bin.js」跑同一条 `plugin --profile add`，外部模式沿用 run_profile_plugin_add。
pub(crate) fn run_profile_plugin_add_auto(
    app: &tauri::AppHandle,
    profile: &str,
    pkg: &str,
) -> (bool, String) {
    use crate::runtime::builtin::DshMode;
    if crate::runtime::builtin::configured_dsh_mode() == DshMode::External {
        return run_profile_plugin_add(app, profile, pkg);
    }
    let Some(node) = crate::runtime::builtin::find_builtin_node() else {
        return (false, "内置 node 不可用".into());
    };
    // dsh 入口：选中的已下载运行时优先，resources/dsh 兑底（与 spawn 解析顺序一致）
    let mut root = None;
    if let Some(ver) = crate::settings::load_desktop_settings().dsh_runtime.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        let dir = crate::runtime::registry::runtime_dir(app, &ver);
        if crate::runtime::registry::is_valid_runtime(&dir) {
            root = Some(dir);
        }
    }
    let root = root
        .or_else(|| app.path().resource_dir().ok().map(|r| r.join("dsh")))
        .unwrap_or_default();
    let bin_js = root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !bin_js.is_file() {
        return (false, format!("内置 dsh 入口缺失：{}", bin_js.display()));
    }
    // 版本对齐（统一走 tree_pinned_spec：树内实际版本，树内没有则运行时 dsh 版本号——
    // 裸名会被 npm latest（dsh-base latest=0.0.1-rc.1，依赖未发布包 404）坑）
    let spec = tree_pinned_spec(app, pkg);
    // GUI 环境 PATH 缺 node：前置内置 node 目录（pnpm 转发需要）
    let node_dir = node.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut paths = vec![];
    if let Some(shim_dir) = ensure_node_shim_dir(app) {
        paths.push(shim_dir);
    }
    paths.push(node_dir);
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let joined = std::env::join_paths(&paths).unwrap_or_default();
    let out = std::process::Command::new(&node)
        .arg(&bin_js)
        // CI=true：防 pnpm 交互提示在无 TTY 的 stdin 上挂起（GUI 环境通病）
        .env("CI", "true")
        .env("PATH", &joined)
        .args(["plugin", "--profile", profile, "add", "--config.minimumReleaseAge=0"])
        .arg(&spec)
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .output();
    match out {
        Ok(o) if o.status.success() => (true, String::new()),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            let out_t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            // pnpm 非 TTY 错误常在 stdout（#95 已有教训）
            (false, if err.is_empty() { out_t } else { err })
        }
        Err(e) => (false, format!("执行失败：{e}")),
    }
}

/// 剖析内置运行时根（选中运行时优先，resources/dsh 兑底）。
fn builtin_tree_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Some(ver) = crate::settings::load_desktop_settings()
        .dsh_runtime
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        let dir = crate::runtime::registry::runtime_dir(app, &ver);
        if crate::runtime::registry::is_valid_runtime(&dir) {
            return dir;
        }
    }
    app.path().resource_dir().map(|r| r.join("dsh")).unwrap_or_default()
}

/// pwsh 兑底目录探测（#95）：仅 Windows 返回实际存在的候选（PS7 → PS6 → 内置 5.1）；
/// 其他平台返回空。绝不返回未经 exists 验证的硬编码字段——含平台分隔符的字段会让
/// join_paths 在非 Windows 平台直接报错（实测新建 profile 全挂根因）。非默认安装位的
/// pwsh 依赖用户 PATH（调用方已 extend 进来）。
fn pwsh_fallback_dirs() -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    {
        [
            r"C:\Program Files\PowerShell\7",
            r"C:\Program Files\PowerShell\6",
            r"C:\Windows\System32\WindowsPowerShell\v1.0", // powershell.exe 5.1
        ]
        .iter()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// git 常见安装目录（pnpm 解析 git 依赖需要 spawn git；存在才返回，跨平台安全）。
fn git_fallback_dirs() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        for p in [r"C:\Program Files\Git\cmd", r"C:\Program Files (x86)\Git\cmd"] {
            let pb = std::path::PathBuf::from(p);
            if pb.is_dir() {
                out.push(pb);
            }
        }
    }
    #[cfg(not(windows))]
    {
        for p in ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"] {
            let pb = std::path::PathBuf::from(p);
            if pb.is_dir() {
                out.push(pb);
            }
        }
    }
    out
}

/// 内置 pnpm 版本（读包内 `node_modules/pnpm/package.json`）。
pub(crate) fn builtin_pnpm_version(app: &tauri::AppHandle) -> Option<String> {
    let pkg = pnpm_cjs_path(app)?.parent()?.parent()?.join("package.json");
    let text = std::fs::read_to_string(pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(String::from)
}

/// 该 profile 的 node_modules 记录的 pnpm 版本（`.modules.yaml` 的 packageManager 行）。
/// 行级提取（不解析整份 YAML）：形如 `  "packageManager": "pnpm@10.34.5",`。
pub(crate) fn profile_recorded_pnpm(profile: &str) -> Option<String> {
    let p = crate::dsh_home()
        .join("profiles")
        .join(profile)
        .join("node_modules")
        .join(".modules.yaml");
    let text = std::fs::read_to_string(p).ok()?;
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("\"packageManager\":") else {
            continue;
        };
        let raw = rest.trim().trim_end_matches(',').trim().trim_matches('"');
        if let Some(ver) = raw.strip_prefix("pnpm@") {
            return Some(ver.to_string());
        }
    }
    None
}

/// 依赖不一致判定（#122）：node_modules 记录的 pnpm 与内置 pnpm 不同 → 返回
/// (记录的版本, 内置版本)。store 大版本不同时 dsh 的插件操作会报
/// ERR_PNPM_UNEXPECTED_STORE（历史上 web profile 可能由系统 pnpm 安装）。
pub(crate) fn profile_dependency_mismatch(
    app: &tauri::AppHandle,
    profile: &str,
) -> Option<(String, String)> {
    let recorded = profile_recorded_pnpm(profile)?;
    let builtin = builtin_pnpm_version(app)?;
    if recorded == builtin {
        None
    } else {
        Some((recorded, builtin))
    }
}

/// 常备 node/pnpm shim（#95）：sidecar 可执行名是 dsh-node，pnpm 只在包内 pnpm.cjs——
/// 而子进程裸调 `node`（postinstall）或 `pnpm`（dsh plugin add 内部转发）都会 command not found。
/// 在 app_data/runtime/bin/ 写同名包装脚本并前置 PATH（幂等）。
pub(crate) fn ensure_node_shim_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let sidecar = crate::runtime::builtin::find_builtin_node()?;
    let pnpm_cjs = pnpm_cjs_path(app)?;
    let dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("runtime")
        .join("bin");
    std::fs::create_dir_all(&dir).ok()?;
    let sidecar_s = sidecar.to_string_lossy().to_string();
    let pnpm_s = pnpm_cjs.to_string_lossy().to_string();
    write_shim(
        &dir,
        "node",
        &format!("exec \"{sidecar_s}\" \"$@\""),
        &format!("\"{sidecar_s}\" %*"),
    )?;
    write_shim(
        &dir,
        "pnpm",
        &format!("exec \"{sidecar_s}\" \"{pnpm_s}\" \"$@\""),
        &format!("\"{sidecar_s}\" \"{pnpm_s}\" %*"),
    )?;
    Some(dir)
}

/// 仅 pnpm 的 shim 目录（#119 修正）：dsh 的插件子进程裸调 `pnpm` 必须命中内置 pnpm
/// （与 profile 的 node_modules/store 大版本一致），但**不劫持** `node`——用户项目里的
/// node 应保持登录 PATH 顺序（实测系统 node v26 vs 内置 v24，劫持会改变项目行为）。
pub(crate) fn ensure_pnpm_shim_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let sidecar = crate::runtime::builtin::find_builtin_node()?;
    let pnpm_cjs = pnpm_cjs_path(app)?;
    let dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("runtime")
        .join("bin-pnpm");
    std::fs::create_dir_all(&dir).ok()?;
    let sidecar_s = sidecar.to_string_lossy().to_string();
    let pnpm_s = pnpm_cjs.to_string_lossy().to_string();
    write_shim(
        &dir,
        "pnpm",
        &format!("exec \"{sidecar_s}\" \"{pnpm_s}\" \"$@\""),
        &format!("\"{sidecar_s}\" \"{pnpm_s}\" %*"),
    )?;
    Some(dir)
}

/// pnpm 的包内入口（resources/dsh/node_modules/pnpm/bin/pnpm.cjs）。
fn pnpm_cjs_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let p = app
        .path()
        .resource_dir()
        .ok()?
        .join("dsh")
        .join("node_modules")
        .join("pnpm")
        .join("bin")
        .join("pnpm.cjs");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// 写 shim 脚本（unix `#!/bin/sh` / windows `.cmd`）：幂等 + 可执行位。
fn write_shim(
    dir: &std::path::Path,
    name: &str,
    unix_body: &str,
    win_body: &str,
) -> Option<()> {
    let file = if cfg!(windows) {
        format!("{name}.cmd")
    } else {
        name.to_string()
    };
    let path = dir.join(file);
    #[cfg(unix)]
    let content = format!("#!/bin/sh\n{unix_body}\n");
    #[cfg(windows)]
    let content = format!("@echo off\r\n{win_body}\r\n");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
        std::fs::write(&path, content).ok()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    Some(())
}
/// 对齐版本号（纯版本，无包名前缀）：
/// 1) 运行时树内有该包（如 dsh 本体依赖）→ 树内实际版本；
/// 2) 树内没有（dsh-base/dsh-web-app 等 profile 发行插件，与 dsh 同版本发布）→ 运行时 dsh 版本号。
pub(crate) fn pinned_version(app: &tauri::AppHandle, name: &str) -> Option<String> {
    let in_tree = std::fs::read_to_string(
            builtin_tree_root(app)
                .join("node_modules")
                .join("@deepseek-ai")
                .join(name)
                .join("package.json"),
        )
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from));
    in_tree.or_else(|| {
        crate::runtime::registry::selected_runtime_version(app)
            .or_else(|| crate::runtime::registry::builtin_version(app))
    })
}

/// name@version spec（命令行参数形态）。裸名会被 npm latest（dsh-base latest=0.0.1-rc.1，
/// 依赖未发布包 404）坑。
fn tree_pinned_spec(app: &tauri::AppHandle, name: &str) -> String {
    pinned_version(app, name)
        .map(|v| format!("{name}@{v}"))
        .unwrap_or_else(|| name.to_string())
}

/// pnpm 直装（#95：dsh CLI 把 desktop 保留给 Electron，plugin add 被拒——守卫只在 CLI 层，
/// profile 本体无特殊性；壳等价于 Electron 管理者，直接在 profile 目录跑 pnpm install，
/// 即 plugin add 的本体「目录内转发 pnpm」。已实测 desktop 可完整启动。）
fn pnpm_direct_add(app: &tauri::AppHandle, profile: &str, pkg: &str) -> Result<(), String> {
    use std::io::Read as _;
    use std::process::{Command, Stdio};
    let dir = crate::dsh_home().join("profiles").join(profile);
    // 首装：写最小发行模板（package.json / workspace / cordis 入口）
    if !dir.join("package.json").is_file() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建 profile 目录失败：{e}"))?;
        std::fs::write(
            dir.join("package.json"),
            serde_json::json!({
                "name": profile,
                "private": true,
                "dependencies": {},
                "dsh": { "profile": { "bundles": [] } },
                "scripts": {
                    "postinstall": "rm -rf node_modules/@deepseek-ai/dsh-tools",
                    "postuninstall": "rm -rf node_modules/@deepseek-ai/dsh-tools"
                }
            })
            .to_string(),
        )
        .map_err(|e| format!("写 package.json 失败：{e}"))?;
        std::fs::write(
            dir.join("pnpm-workspace.yaml"),
            "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\nallowBuilds:\n  node-pty: true\n  protobufjs: true\n  git-hosted: true\n  cloudflared: true\n  sharp: true\n  ssh2: true\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  koffi: true\n",
        )
        .map_err(|e| format!("写 pnpm-workspace.yaml 失败：{e}"))?;
        std::fs::write(
            dir.join("cordis.yml"),
            "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n",
        )
        .map_err(|e| format!("写 cordis.yml 失败：{e}"))?;
        std::fs::write(dir.join("cordis.patch.yml"), "[]\n")
            .map_err(|e| format!("写 cordis.patch.yml 失败：{e}"))?;
    }
    // 登记依赖与 bundle（幂等）
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    // manifest 依赖值必须是纯版本（name@version 是命令行形态，pnpm 会当 alias 解析成空气目录）
    let Some(ver) = pinned_version(app, pkg) else {
        return Err(format!("无法确定 {pkg} 的运行时对齐版本"));
    };
    manifest["dependencies"][pkg] = serde_json::json!(ver);
    manifest["dsh"]["profile"]["bundles"] = {
        let mut bundles = manifest["dsh"]["profile"]["bundles"].as_array().cloned().unwrap_or_default();
        if !bundles.iter().any(|b| b.as_str() == Some(pkg)) {
            bundles.push(serde_json::json!(pkg));
        }
        serde_json::Value::Array(bundles)
    };
    std::fs::write(dir.join("package.json"), serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("回写 package.json 失败：{e}"))?;
    // 内置 node + pnpm install
    let node = crate::runtime::builtin::find_builtin_node().ok_or("内置 node 不可用")?;
    let pnpm = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("dsh").join("node_modules").join("pnpm").join("bin").join("pnpm.cjs"))
        .ok_or("resource_dir 不可用")?;
    if !pnpm.is_file() {
        return Err("内置 pnpm 不存在".into());
    }
    let node_dir = node.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut paths = vec![];
    if let Some(shim_dir) = ensure_node_shim_dir(app) {
        paths.push(shim_dir);
    }
    paths.push(node_dir);
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let joined = std::env::join_paths(&paths).map_err(|e| e.to_string())?;
    let mut child = Command::new(&node)
        .arg(&pnpm)
        // CI=true：防 pnpm 交互提示在无 TTY 的 stdin 上挂起
        .env("CI", "true")
        // 同 pnpm_install_profile：CI=true 下 pnpm 默认 frozen-lockfile，显式关闭以便 lockfile 落后 package.json 时重建
        .args(["install", "--no-frozen-lockfile"])
        .current_dir(&dir)
        .env("PATH", &joined)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("pnpm 执行失败：{e}"))?;
    let stderr_handle = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut h) = stderr_handle {
            let _ = h.read_to_string(&mut buf);
        }
        buf
    });
    let mut stdout_buf = String::new();
    if let Some(out) = child.stdout.take() {
        let mut r = std::io::BufReader::new(out);
        let _ = r.read_to_string(&mut stdout_buf);
    }
    let status = child.wait().map_err(|e| format!("pnpm 等待失败：{e}"))?;
    let err_out = err_thread.join().unwrap_or_default();
    if !status.success() {
        let tail = crate::runtime::registry::pick_pnpm_error_tail(&err_out, &stdout_buf);
        return Err(format!("pnpm install 失败（exit {}）：{}", status.code().unwrap_or(-1), if tail.is_empty() { "（无输出）".into() } else { tail }));
    }
    // 校验落地
    let installed = dir.join("node_modules").join(pkg);
    if !installed.is_dir() {
        return Err(format!("安装命令成功但 {pkg} 未落地"));
    }
    Ok(())
}

/// 统一插件安装入口：CLI 优先；CLI 以「Electron 保留」拒绝时退 pnpm 直装（desktop 场景）。
pub(crate) fn install_profile_plugin(app: &tauri::AppHandle, profile: &str, pkg: &str) -> (bool, String) {
    let (ok, err) = run_profile_plugin_add_auto(app, profile, pkg);
    if !ok && err.contains("managed exclusively") {
        log::warn!("[profile] CLI 以 Electron 保留拒绝 {profile}/{pkg}，退 pnpm 直装");
        return match pnpm_direct_add(app, profile, pkg) {
            Ok(()) => (true, String::new()),
            Err(e) => (false, e),
        };
    }
    (ok, err)
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

/// 新建 profile 流程：弹窗输入名称 → 写模板 + pnpm install（不装 dsh-base/dsh-web-app，共享包从父级 node_modules 解析）。
pub(crate) fn create_profile_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(name) = prompt_input(&handle, "new-profile", "新建 Profile", "profile 名称（字母/数字/_/-）", "").await else {
            return;
        };
        if !valid_profile_name(&name) {
            let msg = "名称仅允许字母、数字、_ 与 -（1-32 字符）";
            crate::commands::show_page_message(&handle, "新建 Profile 失败", &msg);
            show_notification(&handle, "新建 Profile 失败", &msg);
            return;
        }
        // 完整性检查：已存在且完整 → 拦截；不完整 → 修复；不存在 → 创建
        let health = profile_health_check(&name);
        if health.dir_exists && health.missing_files.is_empty() && health.node_modules_exists {
            let msg = format!("{name} 已存在");
            crate::commands::show_page_message(&handle, "新建 Profile 失败", &msg);
            show_notification(&handle, "新建 Profile 失败", &msg);
            return;
        }
        let name_for_cmd = name.clone();
        let h = handle.clone();
        task_begin("create_profile", &format!("新建 profile {name}"), 1);
        let failed = tauri::async_runtime::spawn_blocking(move || {
            task_stage("写模板文件 + pnpm install");
            match repair_profile(&h, &name_for_cmd) {
                Ok(_) => None,
                Err(e) => Some(e),
            }
        })
        .await
        .unwrap_or(Some("创建任务异常".into()));
        match failed {
            None => {
                let msg = format!("{name} 已创建（未自动切换，可在 PROFILE 窗口菜单打开）");
                log::info!("[tray] 新建 profile 成功：{name}");
                task_finish(Ok(msg.clone()));
                crate::commands::show_page_message(&handle, "新建 Profile 成功", &msg);
                show_notification(&handle, "新建 Profile 成功", &msg);
            }
            Some(detail) => {
                log::error!("[tray] 新建 profile 失败：{detail}");
                task_finish(Err(detail.clone()));
                let msg = format!("{detail}");
                crate::commands::show_page_message(&handle, "新建 Profile 失败", &msg);
                show_notification(&handle, "新建 Profile 失败", &detail);
            }
        }
        refresh_tray_mode(&handle);
    });
}


// ── profile 迁移（#88，设计契约来自 #83 研究报告）────────────────

/// 迁移排除规则（纯函数）：
/// - 锁/临时/编辑器残留：*.lock *.pid *.tmp *.swp ._*/.DS_Store
/// - 启动即重写：cordis.yml（prepareProfile 每次写 []，复制无意义）
/// - 纯诊断日志：.plugin-manager/logs/、node_modules/.cache/（.dsh-module-fallback 必须迁：
///   模块解析兑底树，dsh 不会自动重建——#95 实测缺它 boot 中止 cannot create effect）
pub(crate) fn migration_skips(rel: &str, file_name: &str, is_dir: bool) -> bool {
    if file_name == ".DS_Store" || file_name == "cordis.yml" || file_name.starts_with("._") {
        return true;
    }
    const SUFFIXES: [&str; 4] = [".lock", ".pid", ".tmp", ".swp"];
    if SUFFIXES.iter().any(|s| file_name.ends_with(s)) {
        return true;
    }
    if rel.starts_with(".plugin-manager/logs") {
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
    progress: &dyn Fn(),
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
        if rel == "node_modules" {
            continue;
        }
        if rel == ".dsh-module-fallback" {
            continue;
        }
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
                // 重建 symlink，不复制文件内容（同 Unix 逻辑）
                let link_dst = dst_cur.join(&name);
                if target.is_dir() || std::fs::metadata(&target).map(|m| m.is_dir()).unwrap_or(false) {
                    if std::os::windows::fs::symlink_dir(&target, &link_dst).is_ok() {
                        stats.links += 1;
                    } else {
                        stats.skipped += 1;
                    }
                } else {
                    if std::os::windows::fs::symlink_file(&target, &link_dst).is_ok() {
                        stats.links += 1;
                    } else {
                        stats.skipped += 1;
                    }
                }
            }
            continue;
        }
        if ft.is_dir() {
            copy_dir_filtered(root, &entry.path(), &dst_cur.join(&name), stats, progress)?;
            stats.dirs += 1;
        } else {
            std::fs::copy(entry.path(), dst_cur.join(&name))?;
            stats.files += 1;
            progress();
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


/// 通用长任务状态（#95 用户拍板：拒绝一切静默）：新建/迁移全程页面可见，
/// 迁移的 running/copied/total 即由此派生（migration_status 命令读同一状态）。
pub(crate) static MIG_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) static MIG_COPIED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) static MIG_TOTAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TASK_KIND: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static TASK_TITLE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static TASK_STAGE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static TASK_ERROR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static TASK_RESULT: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static TASK_FINISHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 任务快照（前端 600ms 轮询）：kind/title/stage/done/total/error/result/finished。
pub(crate) fn task_status() -> serde_json::Value {
    use std::sync::atomic::Ordering::Relaxed;
    serde_json::json!({
        "running": MIG_RUNNING.load(Relaxed),
        "finished": TASK_FINISHED.load(Relaxed),
        "kind": TASK_KIND.lock().unwrap().clone(),
        "title": TASK_TITLE.lock().unwrap().clone(),
        "stage": TASK_STAGE.lock().unwrap().clone(),
        "done": MIG_COPIED.load(Relaxed),
        "total": MIG_TOTAL.load(Relaxed),
        "error": TASK_ERROR.lock().unwrap().clone(),
        "result": TASK_RESULT.lock().unwrap().clone(),
    })
}

fn task_begin(kind: &str, title: &str, total: u64) {
    use std::sync::atomic::Ordering::Relaxed;
    *TASK_KIND.lock().unwrap() = kind.into();
    *TASK_TITLE.lock().unwrap() = title.into();
    TASK_STAGE.lock().unwrap().clear();
    TASK_ERROR.lock().unwrap().clear();
    TASK_RESULT.lock().unwrap().clear();
    TASK_FINISHED.store(false, Relaxed);
    MIG_TOTAL.store(total, Relaxed);
    MIG_COPIED.store(0, Relaxed);
    MIG_RUNNING.store(true, Relaxed);
}

fn task_stage(stage: &str) {
    *TASK_STAGE.lock().unwrap() = stage.into();
}

fn task_finish(result: Result<String, String>) {
    use std::sync::atomic::Ordering::Relaxed;
    match result {
        Ok(r) => *TASK_RESULT.lock().unwrap() = r,
        Err(e) => *TASK_ERROR.lock().unwrap() = e,
    }
    TASK_FINISHED.store(true, Relaxed);
    MIG_RUNNING.store(false, Relaxed);
}

/// 预统计可复制文件数（与 copy_dir_filtered 同一排除规则）。
fn count_copyable_files(root: &std::path::Path, cur: &std::path::Path) -> u64 {
    let mut n = 0u64;
    let Ok(entries) = std::fs::read_dir(cur) else { return 0 };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        let rel = entry
            .path()
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        if migration_skips(&rel, &name, ft.is_dir()) {
            continue;
        }
        if rel == "node_modules" {
            continue;
        }
        if rel == ".dsh-module-fallback" {
            continue;
        }
        if ft.is_symlink() {
            // symlink 不计入 total——创建链接是瞬时的，不调 progress()
            continue;
        } else if ft.is_dir() {
            n += count_copyable_files(root, &entry.path());
        } else {
            n += 1;
        }
    }
    n
}
/// 迁移 profile（A→B 全量复制，#88）：
/// - 目标为当前激活 profile 直接拒绝；目标已存在需 overwrite=true（先备份 mv 为 .bak-<ts>）
/// - 迁移为当前时点快照复制：不停源实例、不重启服务（#90 用户拍板）
/// - 复制排除锁/临时/cordis.yml/node_modules 等（node_modules 用 pnpm install 重建；
///   .dsh-module-fallback 属必迁数据）；完成后校验 bundles 一致
/// - 不自动切换：用户另行在设置里切换（switch_profile_command）

pub(crate) async fn migrate_profile(
    app: &AppHandle,
    source: String,
    dest: String,
    overwrite: bool,
) -> Result<String, String> {
    // #95 拒绝静默：任何成败都必须在页面任务卡可见（含全部提前 Err 路径）
    let r = migrate_profile_inner(app, source, dest, overwrite).await;
    match &r {
        Ok(s) => task_finish(Ok(s.clone())),
        Err(e) => task_finish(Err(e.clone())),
    }
    r
}

async fn migrate_profile_inner(
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
    // #90 用户拍板：迁移不再停源实例——纯快照复制，不中断正在运行的服务；
    // 运行期间产生的新数据不包含在副本内（UI 已提示）。
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
    // 预统计可复制文件数（供进度条）；然后带进度回调复制（阻塞 IO 放 spawn_blocking）
    let total = count_copyable_files(&src_dir, &src_dir);
    task_begin("migrate", &format!("迁移 {source} → {dest}"), total);
    task_stage("统计完成，开始复制文件");
    let root = src_dir.clone();
    let dst = dst_dir.clone();
    let stats = tauri::async_runtime::spawn_blocking(move || {
        let mut stats = CopyStats::default();
        let progress = || { MIG_COPIED.fetch_add(1, Ordering::Relaxed); };
        let result = copy_dir_filtered(&root, &root, &dst, &mut stats, &progress);
        task_stage("复制完成，重建依赖（pnpm install）");
        result.map(|_| stats)
    })
    .await
    .map_err(|e| format!("复制任务异常：{e}"))?
    .map_err(|e| format!("复制失败：{e}"))?;

    // #90：副本 package.json 的 name 改为目标 profile（不再携带源名）
    let manifest = dst_dir.join("package.json");
    if manifest.is_file() {
        let mut pkg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&manifest).map_err(|e| format!("读取 package.json 失败：{e}"))?)
            .map_err(|e| format!("解析 package.json 失败：{e}"))?;
        pkg["name"] = serde_json::Value::String(format!("dsh-profile-{dest}"));
        std::fs::write(&manifest, serde_json::to_string_pretty(&pkg).unwrap_or_default())
            .map_err(|e| format!("写入 package.json 失败：{e}"))?;
    }

    // #90 用户拍板：node_modules 不复制，用 pnpm install 重建（登录 PATH 恢复后可直接找到 pnpm）
    // #90 用户拍板：依赖重建用「内置 node + 内置 pnpm」，完全不依赖用户机器工具链
    let node = crate::runtime::builtin::find_builtin_node()
        .ok_or_else(|| "内置 node 不可用".to_string())?;
    let node_dir = node
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let pnpm_cjs = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| {
            r.join("dsh")
                .join("node_modules")
                .join("pnpm")
                .join("bin")
                .join("pnpm.cjs")
        })
        .ok_or_else(|| "resource_dir 不可用".to_string())?;
    let mut path_parts = vec![];
    if let Some(shim_dir) = ensure_node_shim_dir(app) {
        path_parts.push(shim_dir);
    }
    path_parts.push(node_dir.clone());
    // pwsh 动态探测（存在才 push；硬编码字段在非 Windows 平台会合 join_paths 报错）
    for p in pwsh_fallback_dirs() {
        path_parts.push(p);
    }
    // git 兜底：pnpm 解析 git 依赖（如 github 源插件）需 spawn git，GUI 精简 PATH 下
    // 必须能找到（本次用户实测：迁移重建 resolved 到 git 依赖时报 spawn git ENOENT）
    for p in git_fallback_dirs() {
        path_parts.push(p);
    }
    if let Some(existing) = std::env::var_os("PATH") {
        // 必须 split_paths 展开：join_paths 遇含冒号的整串元素会 Err → unwrap_or_default
        // 静默变空 PATH（pnpm 自身靠绝对路径可跑，但其子进程 git 只能靠 PATH → ENOENT）
        path_parts.extend(std::env::split_paths(&existing));
    }
    let path_for_pnpm = std::env::join_paths(&path_parts)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dst_for_pnpm = dst_dir.clone();
    let install = tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new(&node)
            .arg(&pnpm_cjs)
            // CI=true：防交互提示挂起（迁移重建同样在 GUI 环境跑）
            .env("CI", "true")
            // #115：CI=true 下 pnpm 默认 frozen-lockfile；迁移重建的 lockfile 常落后于
            // package.json（用户改 link: 本地插件后未重跑 install）→ 必须显式关闭 frozen
            .args(["install", "--prefer-offline", "--no-frozen-lockfile"])
            .current_dir(&dst_for_pnpm)
            .env("PATH", &path_for_pnpm)
            .output();
        match out {
            Ok(o) if o.status.success() => None,
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
                // pnpm 把 ERR_PNPM_* 输出到 stdout，不是 stderr
                Some(if stderr.is_empty() { stdout } else { stderr })
            }
            Err(e) => Some(format!("pnpm 执行失败：{e}")),
        }
    })
    .await
    .unwrap_or_else(|e| Some(format!("pnpm 安装任务异常：{e}")));
    if let Some(err) = install {
        return Err(format!("依赖重建失败（内置 pnpm install）：{err}"));
    }
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

/// 托盘/设置入口的迁移流（#88）：prompt 源/目标 + 覆盖确认 → migrate_profile。
pub(crate) fn migrate_profile_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(source) = prompt_input(&handle, "migrate-src", "迁移 Profile · 源", "要复制的 profile 名称", "").await else {
            return;
        };
        let Some(dest) = prompt_input(
            &handle,
            "migrate-dst",
            "迁移 Profile · 目标",
            "目标 profile 名称（不存在则创建）",
            "",
        )
        .await
        else {
            return;
        };
        let mut overwrite = false;
        if dsh_home().join("profiles").join(&dest).exists() {
            let Some(yes) = prompt_input(
                &handle,
                "migrate-confirm",
                "目标已存在",
                &format!("{dest} 已存在；输入 YES 覆盖（旧目标备份为 .bak-时间戳）"),
                "",
            )
            .await
            else {
                return;
            };
            if yes.trim() != "YES" {
                show_notification(&handle, "迁移已取消", "未确认覆盖");
                return;
            }
            overwrite = true;
        }
        if let Err(e) = migrate_profile(&handle, source, dest, overwrite).await {
            show_notification(&handle, "迁移失败", &e);
        }
    });
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
        copy_dir_filtered(&src, &src, &dst, &mut stats, &|| {}).unwrap();

        // 排除项没过来
        assert!(!dst.join("cordis.yml").exists());
        assert!(!dst.join("run.lock").exists());
        // node_modules 整体排除（#95：迁移不复制，目标用 pnpm install 重建）
        assert!(!dst.join("node_modules").exists());
        // 正常内容在
        assert!(dst.join("package.json").is_file());
        // bundles 校验可读且一致
        assert_eq!(
            profile_bundles(&src),
            Some(vec!["@deepseek-ai/dsh-base".to_string()])
        );
        assert_eq!(profile_bundles(&src), profile_bundles(&dst));
        // 树内符号链接随 node_modules 排除，不重建（重建发生在 pnpm install 后）
        let _ = std::fs::remove_dir_all(&dir);
    }
}
