//! dsh 运行时仓库（#95）：多版本共存、版本目录抓取（GitHub/npm）、下载安装。
//!
//! 布局：`app_data/runtimes/<version>/`（结构与内置 resources/dsh 同构：
//! package.json + node_modules）。清单 `runtimes/installed.json` 记录来源与时间。
//! settings.yaml 的 `dsh_runtime` 指向选中版本（由 client→插件→settings 服务写入，
//! 本模块只读该值）；内置 resources/dsh 始终作为兜底。
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Manager;

pub(crate) const NPM_PACKAGE: &str = "@deepseek-ai/dsh";
pub(crate) const DEFAULT_GITHUB_REPO: &str = "deepseek-ai/deepseek-harness";

#[derive(serde::Serialize, Clone)]
pub(crate) struct CatalogEntry {
    pub version: String,
    /// 渠道标注：latest / alpha / 空（普通版本）
    pub channel: String,
}

#[derive(serde::Serialize, Clone, serde::Deserialize)]
pub(crate) struct InstalledRuntime {
    pub version: String,
    pub source: String,
    pub installed_at: u64,
}

pub(crate) fn runtimes_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("runtimes")
}

fn installed_manifest_path(app: &tauri::AppHandle) -> PathBuf {
    runtimes_dir(app).join("installed.json")
}

pub(crate) fn runtime_dir(app: &tauri::AppHandle, version: &str) -> PathBuf {
    runtimes_dir(app).join(version)
}

/// 运行时回收站（#114）：卸载先 rename 到此、真实删除推迟到下次启动——
/// 直接 unlink 会改变与运行树 hardlink 共享 inode 的 ctime，触发 dsh 插件 rebuilt（页面白屏）。
pub(crate) fn trash_dir(app: &tauri::AppHandle) -> PathBuf {
    runtimes_dir(app).join(".trash")
}

/// 清空回收站（#114）：壳启动、dsh spawn 之前调用（此刻无运行中实例依赖这些 inode）。
/// 失败仅记日志，不阻塞启动。
pub(crate) fn purge_trash(app: &tauri::AppHandle) {
    let dir = trash_dir(app);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let r = if p.is_dir() {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_file(&p)
        };
        if let Err(err) = r {
            log::warn!("[runtime] 回收站清理失败 {}：{err}", p.display());
        }
    }
}

/// 运行时目录有效性：与内置同构（dsh 包 lib 存在）。
pub(crate) fn is_valid_runtime(dir: &std::path::Path) -> bool {
    dir.join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
        .is_file()
}

pub(crate) fn list_installed(app: &tauri::AppHandle) -> Vec<InstalledRuntime> {
    let path = installed_manifest_path(app);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_installed(app: &tauri::AppHandle, list: &[InstalledRuntime]) {
    let path = installed_manifest_path(app);
    let _ = std::fs::create_dir_all(runtimes_dir(app));
    if let Ok(out) = serde_json::to_string_pretty(list) {
        let _ = std::fs::write(path, out);
    }
}

pub(crate) fn record_installed(app: &tauri::AppHandle, entry: InstalledRuntime) {
    let mut list = list_installed(app);
    list.retain(|r| r.version != entry.version);
    list.push(entry);
    list.sort_by(|a, b| a.version.cmp(&b.version));
    save_installed(app, &list);
}

pub(crate) fn remove_installed(app: &tauri::AppHandle, version: &str) -> bool {
    let mut list = list_installed(app);
    let before = list.len();
    list.retain(|r| r.version != version);
    save_installed(app, &list);
    discard_runtime_dir(app, version);
    list.len() != before
}

/// 丢弃一个运行时目录（#114）：rename 到 .trash、真实删除推迟到下次启动 purge_trash。
/// 直接 unlink 会改与运行树 hardlink 共享 inode 的 ctime（rev = mtime|ctime|size）→
/// 运行中 dsh 判定插件 rebuilt → 重载 → 页面白屏。异常（跨卷等）回退直接删除并记日志。
pub(crate) fn discard_runtime_dir(app: &tauri::AppHandle, version: &str) {
    let dir = runtime_dir(app, version);
    if !dir.exists() {
        return;
    }
    let trash = trash_dir(app);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = trash.join(format!("{version}-{ts}"));
    let moved = std::fs::create_dir_all(&trash).is_ok() && std::fs::rename(&dir, &dest).is_ok();
    if !moved {
        log::warn!("[runtime] 回收站不可用，回退直接删除 {version}");
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            log::warn!("[runtime] 删除 {version} 目录失败：{e}");
        }
    }
}

/// 读指定安装根（npm 布局）里 dsh 包的版本号。
pub(crate) fn dsh_version_in_root(root: &std::path::Path) -> Option<String> {
    let pkg = root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(pkg).ok()?).ok()?;
    v.get("version")?.as_str().map(String::from)
}

/// 内置树版本号（resources/dsh）。
pub(crate) fn builtin_version(app: &tauri::AppHandle) -> Option<String> {
    dsh_version_in_root(&crate::runtime::paths::resources_dsh_root(app)?)
}

/// 选中运行时的实际版本（#95 显示修复）：settings.dsh_runtime 指向的树有效则返回其版本，
/// 否则 None（调用方回退内置兑底版本）。与 try_builtin 的选择优先级一致。
pub(crate) fn selected_runtime_version(app: &tauri::AppHandle) -> Option<String> {
    let ver = crate::settings::load_desktop_settings()
        .dsh_runtime
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let dir = runtime_dir(app, &ver);
    if !is_valid_runtime(&dir) {
        return None;
    }
    dsh_version_in_root(&dir)
}

/// 版本目录抓取：github → releases API；npm → registry 元数据（dist-tags）。
pub(crate) async fn fetch_catalog(
    source: &str,
    repo: Option<&str>,
) -> Result<Vec<CatalogEntry>, String> {
    // #108：壳自身请求走设置页代理（app_client_builder 复用 resolved_proxy_env 全语义）
    let client = crate::network::proxy::app_client_builder()
        .user_agent("dsh-desktop-tauriapp")
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败：{e}"))?;
    let mut entries: Vec<CatalogEntry> = Vec::new();
    if source == "github" {
        let repo = repo
            .filter(|r| !r.trim().is_empty())
            .unwrap_or(DEFAULT_GITHUB_REPO);
        let url = format!("https://api.github.com/repos/{repo}/releases?per_page=20");
        let resp = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("GitHub 请求失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("GitHub releases 查询失败：{}", resp.status()));
        }
        let list: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(arr) = list.as_array() {
            for rel in arr {
                let Some(tag) = rel.get("tag_name").and_then(|v| v.as_str()) else {
                    continue;
                };
                // tag 形如 dsh-v0.1.5-rc.2：先剥 dsh- 前缀再剥 v
                let ver = tag.trim_start_matches("dsh-").trim_start_matches('v');
                let channel = if tag.contains("alpha") {
                    "alpha"
                } else if tag.contains("rc") {
                    "rc"
                } else {
                    "latest"
                };
                entries.push(CatalogEntry {
                    version: ver.to_string(),
                    channel: channel.to_string(),
                });
            }
        }
    } else {
        // npm registry：dist-tags 标渠道，其余取最近版本列表
        let url = format!("https://registry.npmjs.org/{NPM_PACKAGE}");
        let resp = client
            .get(&url)
            .header("Accept", "application/vnd.npm.install-v1+json")
            .send()
            .await
            .map_err(|e| format!("npm registry 请求失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("npm registry 查询失败：{}", resp.status()));
        }
        let meta: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let latest = meta["dist-tags"]["latest"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let alpha = meta["dist-tags"]["alpha"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let mut versions: Vec<String> = meta["versions"]
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        versions.sort_by(|a, b| b.cmp(a));
        for v in versions.into_iter().take(20) {
            let channel = if v == latest {
                "latest"
            } else if v == alpha {
                "alpha"
            } else {
                ""
            };
            entries.push(CatalogEntry {
                version: v.clone(),
                channel: channel.to_string(),
            });
        }
    }
    Ok(entries)
}


/// npm 源安装（#90 评审）：tarball 不含依赖树——在运行时目录写最小 package.json，
// ── 下载进度共享状态（#95）：dsh 页面是 remote origin，event.listen 不可用，
// 沿用 migration_status 的命令轮询模式。──
static DL_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static DL_RESOLVED: AtomicU64 = AtomicU64::new(0);
static DL_DOWNLOADED: AtomicU64 = AtomicU64::new(0);
static DL_ADDED: AtomicU64 = AtomicU64::new(0);
static DL_VERSION: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static DL_ERROR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 下载进度查询（前端轮询）：active/version/resolved/downloaded/added/error。
pub(crate) fn runtime_download_status() -> serde_json::Value {
    serde_json::json!({
        "active": DL_ACTIVE.load(Ordering::Relaxed),
        "version": DL_VERSION.lock().unwrap().clone(),
        "resolved": DL_RESOLVED.load(Ordering::Relaxed),
        "downloaded": DL_DOWNLOADED.load(Ordering::Relaxed),
        "added": DL_ADDED.load(Ordering::Relaxed),
        "error": DL_ERROR.lock().unwrap().clone(),
    })
}

/// 解析 pnpm 进度行（非 TTY 下 pnpm 周期性输出）：
/// "Progress: resolved 101, downloaded 45, added 10"（数字可含千分位逗号）。
/// 三项齐全才返回，避免半截行误报。
pub(crate) fn parse_pnpm_progress(line: &str) -> Option<(u64, u64, u64)> {
    let num_after = |key: &str| -> Option<u64> {
        let i = line.find(key)?;
        let digits: String = line[i + key.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ',')
            .filter(|c| *c != ',')
            .collect();
        digits.parse().ok()
    };
    Some((num_after("resolved ")?, num_after("downloaded ")?, num_after("added ")?))
}

/// pnpm stderr 去噪截尾：滤掉 NODE_TLS 告警等 node 环境噪声行，保留末尾 12 行，
/// 真实失败原因（ERR_*/ELIFECYCLE）不再被海没。
pub(crate) fn filter_pnpm_noise(stderr: &str) -> String {
    const TAIL: usize = 12;
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty()
                && !l.contains("NODE_TLS_REJECT_UNAUTHORIZED")
                && !(l.starts_with("(node:") && l.contains("Warning:"))
        })
        .collect();
    let start = lines.len().saturating_sub(TAIL);
    lines[start..].join("\n")
}

/// 核心安装：在 dst 写最小 package.json 后用 node 跑 pnpm.cjs 拉全依赖树。
/// 流式读 stdout 解析 Progress 行回调进度；失败返回去噪后的 stderr 尾部。
/// 与 Tauri AppHandle 解耦，可用真实 node/pnpm 直接做集成测试。
fn pnpm_add_runtime(
    node: &std::path::Path,
    pnpm_cjs: &std::path::Path,
    dst: &std::path::Path,
    version: &str,
    on_progress: &(dyn Fn(u64, u64, u64) + Send + Sync),
) -> Result<(), String> {
    use std::io::{BufRead as _, Read as _};
    use std::process::{Command, Stdio};

    // 干净安装：清掉可能的旧布局残留（早期 symlink 布局重装会冲突）
    let _ = std::fs::remove_dir_all(dst);
    std::fs::create_dir_all(dst).map_err(|e| format!("创建运行时目录失败：{e}"))?;
    std::fs::write(
        dst.join("package.json"),
        serde_json::json!({ "name": format!("dsh-runtime-{version}"), "private": true }).to_string(),
    )
    .map_err(|e| format!("写入 package.json 失败：{e}"))?;
    // #95 评论 Bug 2：pnpm 会向上搜索 pnpm-workspace.yaml，祖先目录（如用户 home）的
    // workspace 污染会引发 ERR_PNPM_UNEXPECTED_STORE。自声明为 workspace root 截断向上搜索
    // （--ignore-workspace / --store-dir / --force 实测均无效，见 #95 评论）。
    std::fs::write(dst.join("pnpm-workspace.yaml"), runtime_workspace_yaml())
        .map_err(|e| format!("写入 pnpm-workspace.yaml 失败：{e}"))?;
    // #95 实测：pnpm 默认 .pnpm symlink 布局顶层只有直接依赖，dsh/lib/bin.js 向上解析
    // dsh-app-boot 等兄弟包会 MODULE_NOT_FOUND。hoisted = npm 式全量平铺，与内置
    // resources/dsh 同构，解析钩子与启动器无需区分树型。
    // #114：独立 store（绝对路径，正斜杠）——不写全局 store，避免触碰与运行树 hardlink
    // 共享 inode 的 mtime/ctime（rev = mtime|ctime|size，改动即触发 dsh 插件 rebuilt → 白屏）
    let store = dst
        .parent()
        .map(|p| p.join(".pnpm-store"))
        .unwrap_or_else(|| dst.join(".pnpm-store"));
    let store_path = store.display().to_string().replace('\\', "/");
    std::fs::write(
        dst.join(".npmrc"),
        format!("node-linker=hoisted\nstore-dir={store_path}\n"),
    )
        .map_err(|e| format!("写入 .npmrc 失败：{e}"))?;
    // pnpm 及其子进程需要 node：前置内置 node 目录
    let node_dir = node.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut paths = vec![node_dir];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let joined = std::env::join_paths(&paths).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(node);
    cmd.arg(pnpm_cjs)
        .args(["add", &format!("{NPM_PACKAGE}@{version}")])
        .current_dir(dst)
        .env("PATH", &joined)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // #108：pnpm 拉依赖的网络请求同样走设置页代理（与 dsh 子进程同款注入）
    crate::network::proxy::inject_proxy_env(&mut cmd);
    let mut child = cmd
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
    // #95 评论 Bug 1：pnpm 非 TTY 下把 ERR_*/ELIFECYCLE 错误输出到 stdout——
    // 非 Progress 行累积下来供失败报错，不能只读 stderr。
    let mut stdout_tail = String::new();
    if let Some(out) = child.stdout.take() {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(p) = parse_pnpm_progress(&line) {
                on_progress(p.0, p.1, p.2);
            } else {
                stdout_tail.push_str(&line);
                stdout_tail.push('\n');
            }
        }
    }
    let status = child.wait().map_err(|e| format!("pnpm 等待失败：{e}"))?;
    let err_out = err_thread.join().unwrap_or_default();
    if !status.success() {
        let tail = pick_pnpm_error_tail(&err_out, &stdout_tail);
        return Err(format!(
            "pnpm add 失败（exit {}）：{}",
            status.code().unwrap_or(-1),
            if tail.is_empty() { "（无输出）".to_string() } else { tail }
        ));
    }
    Ok(())
}

/// 运行时安装目录的 pnpm-workspace.yaml 内容（#135）：`packages: []` 自声明
/// workspace root 截断向上搜索（#95 评论 Bug 2）+ allowBuilds 白名单——pnpm 11
/// 对未批准构建脚本的依赖直接 ERR_PNPM_IGNORED_BUILDS exit 1（#119 钉 pnpm 11 后暴露）。
fn runtime_workspace_yaml() -> String {
    format!("packages: []\n\n{}", crate::runtime::builtin::PNPM_ALLOW_BUILDS)
}

/// 失败原因提取：stderr 去噪后优先（node 告警所在），空则回退 stdout 去噪
/// （pnpm 非 TTY 下真实错误 ERR_*/ELIFECYCLE 常在 stdout）。
pub(crate) fn pick_pnpm_error_tail(stderr_tail: &str, stdout_tail: &str) -> String {
    let from_err = filter_pnpm_noise(stderr_tail);
    if !from_err.is_empty() {
        return from_err;
    }
    filter_pnpm_noise(stdout_tail)
}

/// 运行时安装（#90 评审 + #95 评论修正）：两渠道安装载荷统一走 pnpm 依赖树重建
/// （GitHub release 无 asset，源码 tarball 是无 deps 的 monorepo 根，不可直接装），
/// 渠道只决定版本目录来源。进度写入共享轮询状态；失败清理半成品目录。
fn install_via_pnpm(app: &tauri::AppHandle, version: &str) -> Result<(), String> {
    if DL_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有运行时下载任务进行中，请稍候".to_string());
    }
    *DL_VERSION.lock().unwrap() = version.to_string();
    DL_ERROR.lock().unwrap().clear();
    DL_RESOLVED.store(0, Ordering::Relaxed);
    DL_DOWNLOADED.store(0, Ordering::Relaxed);
    DL_ADDED.store(0, Ordering::Relaxed);
    let outcome = (|| -> Result<(), String> {
        let node = crate::runtime::builtin::find_builtin_node()
            .ok_or_else(|| "内置 node 不可用".to_string())?;
        // #123：归一后的资源根（去 Windows verbatim 前缀）再拼 pnpm 入口
        let pnpm_cjs = crate::runtime::paths::resources_dsh_root(app)
            .map(|r| {
                r.join("node_modules")
                    .join("pnpm")
                    .join("bin")
                    .join("pnpm.cjs")
            })
            .ok_or_else(|| "resource_dir 不可用".to_string())?;
        if !pnpm_cjs.is_file() {
            return Err("内置 pnpm 不存在（安装包未含 pnpm）".to_string());
        }
        let dst = runtime_dir(app, version);
        pnpm_add_runtime(&node, &pnpm_cjs, &dst, version, &|res, down, added| {
            DL_RESOLVED.store(res, Ordering::Relaxed);
            DL_DOWNLOADED.store(down, Ordering::Relaxed);
            DL_ADDED.store(added, Ordering::Relaxed);
        })?;
        if !is_valid_runtime(&dst) {
            return Err("依赖安装完成但运行时校验失败（node_modules/@deepseek-ai/dsh/lib 缺失）".to_string());
        }
        Ok(())
    })();
    if let Err(e) = &outcome {
        *DL_ERROR.lock().unwrap() = e.clone();
        discard_runtime_dir(app, version);
    }
    DL_ACTIVE.store(false, Ordering::SeqCst);
    outcome
}

/// 下载 + 安装一个运行时版本（两渠道安装载荷统一走 pnpm，见 install_via_pnpm 注释；
/// 渠道只影响版本目录抓取）。阻塞安装丢线程池；进度经 runtime_download_status 轮询。
pub(crate) async fn download_and_install(app: &tauri::AppHandle, version: &str) -> Result<(), String> {
    let app = app.clone();
    let version = version.to_string();
    tauri::async_runtime::spawn_blocking(move || install_via_pnpm(&app, &version))
        .await
        .map_err(|e| format!("安装任务异常：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pnpm_progress_full_line() {
        assert_eq!(
            parse_pnpm_progress("Progress: resolved 101, downloaded 45, added 10"),
            Some((101, 45, 10))
        );
    }

    #[test]
    fn parse_pnpm_progress_thousands() {
        assert_eq!(
            parse_pnpm_progress("Progress: resolved 1,234, downloaded 1,000, added 567"),
            Some((1234, 1000, 567))
        );
    }

    #[test]
    fn parse_pnpm_progress_partial_rejected() {
        assert_eq!(parse_pnpm_progress("Progress: resolved 101"), None);
        assert_eq!(parse_pnpm_progress("Packages: +86"), None);
        assert_eq!(parse_pnpm_progress(""), None);
    }

    #[test]
    fn filter_pnpm_noise_drops_tls_and_tails() {
        let mut s = String::new();
        for i in 0..20 {
            s.push_str(&format!("line-{i}\n"));
        }
        s.push_str("(node:42240) Warning: NODE_TLS_REJECT_UNAUTHORIZED set to 0...\n");
        s.push_str("ERR_PNPM_META_FETCH_FAIL registry timeout");
        let out = filter_pnpm_noise(&s);
        assert!(!out.contains("NODE_TLS"), "应滤掉 TLS 告警：{out}");
        assert!(out.contains("ERR_PNPM_META_FETCH_FAIL"), "应保留真实错误：{out}");
        assert!(out.lines().count() <= 12, "应截尾到 12 行");
    }

    #[test]
    fn runtime_workspace_yaml_has_allow_builds() {
        // #135：pnpm 11 对未批准构建脚本的依赖直接 exit 1——运行时安装目录的
        // pnpm-workspace.yaml 必须带 allowBuilds 白名单（与 profile 侧同一份常量）。
        let yaml = runtime_workspace_yaml();
        assert!(yaml.starts_with("packages: []\n"), "应自声明 workspace root：{yaml}");
        assert!(
            yaml.contains("allowBuilds:"),
            "必须带 allowBuilds 白名单（#135）：{yaml}"
        );
        assert!(
            yaml.contains("node-pty: true") && yaml.contains("koffi: true"),
            "白名单应含报错过的包：{yaml}"
        );
    }

    #[test]
    fn pick_pnpm_error_tail_prefers_stderr_falls_back_stdout() {
        // stderr 只有 node 告警（去噪后空）→ 回退 stdout（pnpm 非 TTY 错误常在 stdout）
        let stderr = "(node:1) Warning: NODE_TLS_REJECT_UNAUTHORIZED set to 0";
        let stdout = "Progress: resolved 1, downloaded 0, added 0\nERR_PNPM_NO_MATCHING_VERSION";
        let picked = pick_pnpm_error_tail(stderr, stdout);
        assert!(picked.contains("ERR_PNPM_NO_MATCHING_VERSION"), "应回退 stdout：{picked}");
        // stderr 有真实错误 → 优先 stderr
        let stderr2 = "ERR_PNPM_UNEXPECTED_STORE store mismatch";
        let picked2 = pick_pnpm_error_tail(stderr2, "whatever ERR_X");
        assert!(picked2.contains("ERR_PNPM_UNEXPECTED_STORE"), "应优先 stderr：{picked2}");
    }

    #[test]
    fn is_valid_runtime_requires_dsh_bin() {
        let dir = std::env::temp_dir().join(format!("dsh-rt-valid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!is_valid_runtime(&dir));
        let bin = dir.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "// stub").unwrap();
        assert!(is_valid_runtime(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真实端到端：用真实 node + pnpm.cjs 安装 @deepseek-ai/dsh 并验证产物。
    /// 需网络与两个环境变量：DSH_TEST_NODE（node 可执行）/ DSH_TEST_PNPM（pnpm.cjs）。
    /// 运行：DSH_TEST_NODE=... DSH_TEST_PNPM=... cargo test real_install -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_install_via_pnpm_e2e() {
        let Ok(node) = std::env::var("DSH_TEST_NODE") else { return };
        let pnpm = std::env::var("DSH_TEST_PNPM").expect("DSH_TEST_PNPM");
        let dst = std::env::temp_dir().join(format!("dsh-rt-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);
        // （进度行只打日志：非 TTY 下 pnpm 可能不输出 Progress，不硬断）
        let r = pnpm_add_runtime(
            std::path::Path::new(&node),
            std::path::Path::new(&pnpm),
            &dst,
            "0.1.5-rc.2",
            &|res, down, added| {
                eprintln!("progress: resolved {res} downloaded {down} added {added}");
            },
        );
        r.expect("pnpm 安装应成功");
        assert!(is_valid_runtime(&dst), "安装后应为有效运行时树");
        // hoisted 布局断言：顶层必须平铺出兄弟包（symlink 布局会 MODULE_NOT_FOUND，#95 实测）
        assert!(
            dst.join("node_modules/@deepseek-ai/dsh-app-boot").exists(),
            "hoisted 布局下 dsh-app-boot 应在顶层平铺"
        );
        let _ = std::fs::remove_dir_all(&dst);
    }
}
