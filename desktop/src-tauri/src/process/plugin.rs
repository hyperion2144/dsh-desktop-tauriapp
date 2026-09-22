//! 桌面插件定位/物化/注入。
//!
//! 迁移自 lib.rs 功能区域（plugin）。

use std::path::PathBuf;
use tauri::Manager;
use crate::dsh_home;
use crate::settings::configured_profile;
/// 定位本应用自带的桌面 chrome 插件包（dsh-desktop-tauriapp）。
/// 优先级：
/// 1. `DSH_DESKTOP_PLUGIN` 环境变量（目录）
/// 2. Tauri 运行时资源目录下的内嵌副本 `{resource_dir}/dsh-desktop-tauriapp` —— 打包场景，
///    由 tauri.conf.json 的 `bundle.resources` 内嵌；`resource_dir()` 按平台解析真实位置
///    （macOS=Contents/Resources、Windows=可执行文件所在目录、Linux=/usr/lib 或 AppImage
///    挂载点），因此无论 app 装到哪里都能拿到真实路径，无需写死。
/// 3. 与可执行文件同级的 dsh-desktop-tauriapp（老打包布局兼容）
/// 4. 从可执行文件向上找 package.json.name == dsh-desktop-tauriapp 的目录（开发仓库根）。
pub(crate) fn desktop_plugin_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DSH_DESKTOP_PLUGIN") {
        let p = PathBuf::from(p);
        if p.join("package.json").exists() {
            return Some(p);
        }
    }
    // 打包内嵌副本：resource_dir 已按平台归一为真实资源目录
    if let Ok(res_dir) = app.path().resource_dir() {
        let embedded = res_dir.join("plugins/dsh-desktop-tauriapp");
        if embedded.join("package.json").exists() {
            log::info!("使用内嵌插件包：{}", embedded.display());
            return Some(embedded);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let sibling = exe.parent()?.join("dsh-desktop-tauriapp");
    if sibling.join("package.json").exists() {
        return Some(sibling);
    }
    let mut dir = exe.parent()?;
    // 向上找 package.json.name == dsh-desktop-tauriapp 的目录（开发仓库根）。
    // 跳过中间非同名 package.json（如 desktop/、src-tauri/ 的脚手架清单）。
    for _ in 0..10 {
        let pkg = dir.join("package.json");
        if pkg.exists() {
            if let Ok(text) = std::fs::read_to_string(&pkg) {
                if text.contains("\"name\": \"dsh-desktop-tauriapp\"") || text.contains("\"name\":\"dsh-desktop-tauriapp\"") {
                    return Some(dir.to_path_buf());
                }
            }
        }
        dir = dir.parent()?;
    }
    None
}

/// 桌面插件 --patch 注入清单：桌面插件 + 手机访问（dsh-mobile-access）+ 移动布局
/// （上游包 dsh-web-mobile，v2.3.0 前名 @dsh-external/dsh-mobile-nav；git 子模块原样使用，
/// 不再自研）。写入 app 数据目录，幂等。
pub(crate) fn desktop_plugin_patch_path(app: &tauri::AppHandle) -> PathBuf {
    let Some(dir) = app.path().app_data_dir().ok() else {
        return PathBuf::from("/tmp/dsh-desktop-tauriapp-inject.yml");
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("desktop-plugin-inject.yml");
    // name 与上游 cordis.patch.yml 一致：上游 v2.3.0 起包改名 dsh-web-mobile（弃用
    // @dsh-external scope），patch 行 id/name 随之对齐；
    // materialize 时 link_name 也用同名（见 materialize_desktop_plugin）。
    // 首行 connection scope 补丁：DSH 0.1.5 Web profile 的 connection 条目缺少
    // webRuntime/webServer 注入，导致 rpc.handle 注册的 channel 不会挂 HTTP 路由
    // （浏览器侧报 transport failure）。与 dsh-mnemon 的 cordis.patch.yml 同一手法。
    let content = "- id: connection\n  inject: [webRuntime, webServer]\n\n- insert:\n    - id: dsh-desktop-tauriapp\n      name: dsh-desktop-tauriapp\n    - id: dsh-mobile-access\n      name: dsh-mobile-access\n    - id: dsh-web-mobile\n      name: dsh-web-mobile\n";
    let stale = std::fs::read_to_string(&path).map(|t| t != content).unwrap_or(true);
    if stale {
        let _ = std::fs::write(&path, content);
    }
    path
}

/// 定位手机访问插件包目录（dsh-mobile-access / dsh-mobile-nav）：
/// 优先打包内嵌副本 resource_dir/plugins/<name>，回退开发仓库 mobile/<rel>。
pub(crate) fn mobile_package_dir(app: &tauri::AppHandle, name: &str, rel: &str) -> Option<PathBuf> {
    if let Ok(res_dir) = app.path().resource_dir() {
        let embedded = res_dir.join("plugins").join(name);
        if embedded.join("package.json").exists() {
            return Some(embedded);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    for _ in 0..10 {
        let pkg = dir.join("package.json");
        if pkg.exists() {
            if let Ok(text) = std::fs::read_to_string(&pkg) {
                if text.contains("\"name\": \"dsh-desktop-tauriapp\"") || text.contains("\"name\":\"dsh-desktop-tauriapp\"") {
                    return Some(dir.join("mobile").join(rel));
                }
            }
        }
        dir = dir.parent()?;
    }
    None
}

/// 把插件包挂进 profile 专属模块池 $DSH_HOME/profiles/<profile>/node_modules，使 `name: <pkg>`
/// 从该 profile 可解析（macOS/Linux 用符号链接，Windows 退化为复制整包）。幂等。
/// scoped 包名（如 @dsh-external/dsh-mobile-nav）会自动补建 scope 父目录；
/// pool 目录本身不存在时也会一并创建，函数自足不依赖调用方预建。
pub(crate) fn materialize_pool_package(pool: &std::path::Path, link_name: &str, dir: &std::path::Path) {
    let link = pool.join(link_name);
    // bug #22：scoped 包名的父目录（如 …/node_modules/@dsh-external）若不存在，
    // symlink/copy 会直接 ENOENT 且仅落日志，dsh 启动即报 Cannot find package。
    // 挂载前先补建父目录，失败则放弃本次挂载（错误已记日志，可观测）。
    if let Some(parent) = link.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::error!(
                "共享模块池挂载 {link_name} 前创建父目录 {} 失败：{e}",
                parent.display()
            );
            return;
        }
    }
    let target = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if let Ok(existing) = std::fs::read_link(&link) {
        if existing == target {
            log::info!("共享模块池已挂载 {link_name}（{}）", existing.display());
            return;
        }
    }
    // 安全移除旧挂载：先试 remove_dir/remove_file（只删链接不穿透），失败再用 remove_dir_all（实体复制体）
    if std::fs::remove_dir(&link).is_ok() || std::fs::remove_file(&link).is_ok() {
        // junction/symlink 已删
    } else if link.exists() {
        // 旧复制体（实体目录）→ remove_dir_all 安全删除
        let _ = std::fs::remove_dir_all(&link);
    }
    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(&target, &link) {
            Ok(()) => log::info!("共享模块池挂载 {link_name} -> {}", target.display()),
            Err(e) => log::error!("共享模块池挂载 {link_name}（symlink）失败：{e}"),
        }
    }
    #[cfg(windows)]
    {
        // Windows: 优先 junction（不需管理员权限），失败则试 symlink_dir（需开发者模式）
        let link_str = link.to_string_lossy();
        let target_str = target.to_string_lossy();
        let out = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J", &link_str, &target_str])
            .output();
        match out {
            Ok(o) if o.status.success() => log::info!("共享模块池 junction {link_name} -> {}", target.display()),
            _ => {
                // junction 失败，试 symlink_dir（Windows 开发者模式）
                match std::os::windows::fs::symlink_dir(&target, &link) {
                    Ok(()) => log::info!("共享模块池 symlink {link_name} -> {}", target.display()),
                    Err(e) => log::error!("共享模块池链接 {link_name} 失败（junction+symlink 均失败）：{e}"),
                }
            }
        }
    }
}

/// 从外部 dsh CLI 的安装树反查安装根（node_modules 目录）。
/// bin 通常是 symlink（/opt/homebrew/bin/dsh → lib/node_modules/@deepseek-ai/dsh/bin/dsh.js），
/// realpath 向上找带 package.json 且 name=@deepseek-ai/dsh 的目录，其父即安装根。
fn external_install_node_modules() -> Option<PathBuf> {
    let bin = crate::runtime::builtin::find_external_bin()?;
    let real = std::fs::canonicalize(&bin).ok()?;
    let mut current = real.parent().map(|p| p.to_path_buf());
    for _ in 0..6 {
        let Some(dir) = current.as_ref() else { break };
        let manifest = dir.join("package.json");
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if text.contains("\"@deepseek-ai/dsh\"") {
                return dir.parent().map(|p| p.to_path_buf());
            }
        }
        current = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

/// 内置 dsh 缺失的 profile bundle 补链（anywhere-labs heal 思路适配）：
/// profile manifest 的 dsh.profile.bundles 里，内置树没有的包，从用户外部
/// CLI 安装树 symlink 进 profile node_modules，让内置 dsh 的 resolveBundleDir
/// 能解析；加载后真不兼容的由保险丝隔离。幂等；无外部树时跳过。
pub(crate) fn heal_profile_bundles(app: &tauri::AppHandle, profile: &str) {
    let profile_dir = dsh_home().join("profiles").join(profile);
    let manifest = profile_dir.join("package.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else { return };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let Some(bundles) = value["dsh"]["profile"]["bundles"].as_array() else { return };
    let Some(builtin_nm) = app.path().resource_dir().ok().map(|r| r.join("dsh").join("node_modules")) else { return };
    let Some(external_nm) = external_install_node_modules() else {
        log::info!("[heal] 无外部 dsh 安装树，跳过 bundle 补链");
        return;
    };
    let pool = profile_dir.join("node_modules");
    let mut healed = 0usize;
    for bundle in bundles {
        let Some(name) = bundle.as_str() else { continue };
        let rel = if name.starts_with('@') {
            let parts: Vec<&str> = name.splitn(3, '/').collect();
            if parts.len() < 2 { continue };
            PathBuf::from(parts[0]).join(parts[1])
        } else {
            PathBuf::from(name)
        };
        // 已能解析（内置树或 profile 池）→ 跳过
        if builtin_nm.join(&rel).join("package.json").is_file() { continue }
        if pool.join(&rel).join("package.json").is_file() { continue }
        let src = external_nm.join(&rel);
        if !src.join("package.json").is_file() {
            log::warn!("[heal] bundle {name} 在外部安装树也不存在，交由保险丝处理");
            continue;
        }
        if let Some(parent) = pool.join(&rel).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        #[cfg(unix)]
        {
            if std::os::unix::fs::symlink(&src, pool.join(&rel)).is_ok() {
                healed += 1;
                log::info!("[heal] bundle {name} → {}", src.display());
            }
        }
        #[cfg(not(unix))]
        {
            log::warn!("[heal] bundle {name} 非_unix 平台暂不补链，交由保险丝处理");
        }
    }
    if healed > 0 {
        log::info!("[heal] 已补链 {healed} 个 profile bundle（外部安装树 → profile 池）");
    }
}

/// 把三个内置插件包挂进选中 profile 的模块池：桌面插件 + 手机访问（dsh-mobile-access）+ 移动布局
/// （移动布局：上游 v2.3.0 起包名 dsh-web-mobile）。幂等。
pub(crate) fn materialize_desktop_plugin(app: &tauri::AppHandle) {
    materialize_desktop_plugin_for(app, &configured_profile());
}

/// 按 spawn 的目标 profile 挂池（#90 实测：非激活 profile 的实例也需要
/// 桌面三插件可解析，否则 --patch loader 条目找不到包 → 实例秒退）。幂等。
pub(crate) fn materialize_desktop_plugin_for(app: &tauri::AppHandle, profile: &str) {
    let pool = dsh_home().join("profiles").join(profile).join("node_modules");
    let _ = std::fs::create_dir_all(&pool);
    if let Some(dir) = desktop_plugin_dir(app) {
        materialize_pool_package(&pool, "dsh-desktop-tauriapp", &dir);
    } else {
        log::warn!("未定位到 dsh-desktop-tauriapp 插件包，跳过共享模块池挂载");
    }
    if let Some(dir) = mobile_package_dir(app, "dsh-mobile-access", "dsh-mobile-access") {
        materialize_pool_package(&pool, "dsh-mobile-access", &dir);
    } else {
        log::warn!("未定位到 dsh-mobile-access 插件包，跳过共享模块池挂载");
    }
    // link_name 与上游 cordis.patch.yml 的 name 一致（v2.3.0 起为无 scope 的
    // dsh-web-mobile）：dsh 从 profile 解析 'name: dsh-web-mobile' 时按这个 key
    // 在 profile 专属 node_modules 里查找，链路必须同 key。
    // 内嵌目录名同步改用 dsh-web-mobile；子模块 checkout 路径仍为 mobile/dsh-mobile-nav。
    if let Some(dir) = mobile_package_dir(app, "dsh-web-mobile", "dsh-mobile-nav") {
        materialize_pool_package(&pool, "dsh-web-mobile", &dir);
    } else {
        log::warn!("未定位到 dsh-web-mobile 插件包，跳过共享模块池挂载");
    }
}

/// 退出时清理所有 profile 下的桌面插件 junction/symlink（不删复制体）。
pub(crate) fn cleanup_desktop_plugin_links() {
    let profiles_dir = dsh_home().join("profiles");
    let Ok(entries) = std::fs::read_dir(&profiles_dir) else { return };
    for entry in entries.flatten() {
        let nm = entry.path().join("node_modules");
        for name in ["dsh-desktop-tauriapp", "dsh-mobile-access", "dsh-web-mobile"] {
            let link = nm.join(name);
            // junction/symlink 用 remove_dir 只删链接不穿透；实体目录 remove_dir 会失败（非空）→ 跳过
            if std::fs::remove_dir(&link).is_ok() || std::fs::remove_file(&link).is_ok() {
                log::info!("[exit] 清理插件链接 {}", link.display());
            }
        }
    }
}

/// 清理旧共享池 $DSH_HOME/profiles/node_modules 中本应用注入的三个包残留。
/// 迁移到 profile 专属池后，旧位置副本不再需要且可能引起解析歧义。
fn cleanup_legacy_shared_pool() {
    let legacy = dsh_home().join("profiles").join("node_modules");
    for name in ["dsh-desktop-tauriapp", "dsh-mobile-access", "dsh-web-mobile"] {
        let p = legacy.join(name);
        if p.exists() {
            if let Err(e) = std::fs::remove_dir_all(&p) {
                log::warn!("清理旧共享池残留 {} 失败：{e}", p.display());
            } else {
                log::info!("已清理旧共享池残留 {}", p.display());
            }
        }
    }
}

/// 复制目录树（Windows 不能保证目录符号链接权限，退化为实体复制）。
#[cfg(windows)]
pub(crate) fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

/// 迁移：移除 web profile 里旧的 bundle 注册（历史版本用 `dsh plugin add` 写入），
/// 否则与 --patch 注入行同 id 会触发 loader `duplicate loader entry id`。
/// 直接编辑 package.json 的 dsh.profile.bundles；插件本体与共享池实体不动。
pub(crate) fn strip_web_profile_plugin_bundle() {
    let pkg_path = dsh_home().join("profiles/web/package.json");
    let Ok(text) = std::fs::read_to_string(&pkg_path) else { return };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let Some(bundles) = value
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
    else {
        return;
    };
    let Some(arr) = bundles.as_array_mut() else { return };
    let before = arr.len();
    arr.retain(|b| b.as_str().map(|s| s != "dsh-desktop-tauriapp").unwrap_or(true));
    if arr.len() == before {
        return;
    }
    if let Ok(out) = serde_json::to_string_pretty(&value) {
        let _ = std::fs::write(&pkg_path, out + "\n");
        log::info!("web profile 已移除 dsh-desktop-tauriapp bundle 注册（迁移到 --patch 注入）");
    }
}

/// 当前平台的桌面标记值（get_desktop_client_environment 下发给 client）。
pub(crate) fn desktop_platform_tag() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn pool_test_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dsh-pool-test-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pool_test_pkg(root: &std::path::Path, name: &str) -> std::path::PathBuf {
        let pkg = root.join(name);
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), "{\"name\":\"fake\"}\n").unwrap();
        pkg
    }

    #[test]
    fn pool_mount_scoped_name_creates_scope_parent() {
        // bug #22：scoped 包名挂载时 scope 父目录必须自动创建，
        // 否则 symlink ENOENT 静默失败，dsh 启动报 Cannot find package。
        let root = pool_test_dir("scoped");
        let pool = root.join("profiles").join("node_modules");
        let pkg = pool_test_pkg(&root, "nav");
        materialize_pool_package(&pool, "@dsh-external/dsh-mobile-nav", &pkg);
        let link = pool.join("@dsh-external").join("dsh-mobile-nav");
        assert!(
            link.join("package.json").exists(),
            "scoped 挂载后应能经链接读到包内文件（scope 父目录需自动补建）"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pool_mount_scoped_idempotent() {
        // 重复挂载同一 scoped 包名应幂等复用，不重建、不报错。
        let root = pool_test_dir("scoped-idem");
        let pool = root.join("pool");
        let pkg = pool_test_pkg(&root, "nav");
        materialize_pool_package(&pool, "@scope/pkg", &pkg);
        materialize_pool_package(&pool, "@scope/pkg", &pkg);
        assert!(pool.join("@scope").join("pkg").join("package.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pool_mount_unscoped_and_stale_replacement() {
        // 回归保护：非 scoped 挂载与陈旧链接替换的既有行为不被破坏。
        let root = pool_test_dir("unscoped");
        let pool = root.join("pool");
        let a = pool_test_pkg(&root, "pkg-a");
        let b = root.join("pkg-b");
        std::fs::create_dir_all(&b).unwrap();
        materialize_pool_package(&pool, "dsh-x", &a);
        assert!(pool.join("dsh-x").join("package.json").exists());
        materialize_pool_package(&pool, "dsh-x", &b);
        let target = std::fs::canonicalize(pool.join("dsh-x")).unwrap();
        assert_eq!(
            target,
            std::fs::canonicalize(&b).unwrap(),
            "陈旧链接应替换为新实体"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pool_mount_scope_dir_as_file_fails_observably() {
        // 异常分支：scope 父路径被文件占用时挂载应放弃且可观测（不 panic）。
        let root = pool_test_dir("scope-file");
        let pool = root.join("pool");
        std::fs::create_dir_all(&pool).unwrap();
        std::fs::write(pool.join("@scope"), "not a dir").unwrap();
        let pkg = pool_test_pkg(&root, "nav");
        materialize_pool_package(&pool, "@scope/pkg", &pkg);
        assert!(!pool.join("@scope").join("pkg").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

}

