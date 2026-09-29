//! 远程模式的**构建闸门**（#154 维护者修正 ②）。
//!
//! 远程桌面有两种进法：
//!
//! ① **壳内 origin**——本地出文档与静态资产，Host 只做数据接口，长连接走流式代理。
//!    它要求前端产物与远程**同构建**：本地 index.html 引用的 `assets/index-<hash>.js`
//!    必须就是远程那一份，否则页面会去拉不存在的文件。
//! ② **URL webview**——远程整页照旧打开，不做任何本地资产，任何版本都能用。
//!
//! 所以先比**构建标识**（dist 入口产物名；Vite 产物名即内容 hash，同名必同内容）：
//! 命中本地某个运行时就直接走 ①；不命中就把选择权交给用户——下载对应运行时 /
//! 用当前默认运行时（明示版本不符的风险）/ 直接加载远程桌面。
//!
//! 这里不预设「路径一定成」：任何一步拿不到证据（读不到远程构建标识、下载失败、
//! 装完仍不符）都退回**能用的那条路**，并把判断依据写进日志。

use std::path::PathBuf;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

use crate::network::shell_origin::{assets, scheme};

/// 闸门结论：本地资产能不能出、出哪一份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BuildGate {
    /// 命中本地某个运行时（`(版本标识, dist)`）：锁定它出文档。
    Matched(String, PathBuf),
    /// 用户选择：用当前默认运行时（版本不符，已警告）。
    UseLocalAnyway,
    /// 用户选择：不走壳内 origin，直接以 URL 打开远程桌面。
    RemoteWebview,
}

/// 跑一次闸门。命中即返回锁定的产物；不命中就问用户，问完按选择返回。
pub(crate) async fn gate(app: &AppHandle) -> BuildGate {
    let local = assets::local_dists(app);
    let Some(remote) = remote_build_id(app).await else {
        // 读不到远程构建标识（老版 dsh 没注入入口脚本 / 首页非 200）：不假装匹配，
        // 也不把用户堵在对话框前——按当前默认运行时继续，理由记在日志里。
        log::warn!("[remote-build] 读不到远程前端构建标识，按当前默认运行时继续");
        return BuildGate::UseLocalAnyway;
    };
    if let Some((label, dist)) = match_local(&local, &remote) {
        log::info!("[remote-build] 远程构建 {remote} 命中本地运行时 {label}");
        return BuildGate::Matched(label, dist);
    }
    log::warn!(
        "[remote-build] 远程构建 {remote} 不在本地运行时中（本地：{}）",
        describe(&local)
    );
    match ask(app, &remote, &local).await {
        MessageDialogResult::Yes => match install_latest_runtime(app).await {
            Ok(Installed::Matched(label, dist)) => BuildGate::Matched(label, dist),
            Ok(Installed::StillMismatched) => ask_after_download(app).await,
            Err(reason) => {
                log::warn!("[remote-build] 下载运行时失败：{reason}");
                ask_after_download(app).await
            }
        },
        MessageDialogResult::No => BuildGate::UseLocalAnyway,
        // 取消（含关窗）= 「直接加载远程桌面」：最保守、也永远能用的一条。
        _ => BuildGate::RemoteWebview,
    }
}

/// 远程首页的前端构建标识。
async fn remote_build_id(app: &AppHandle) -> Option<String> {
    let html = scheme::host_page(app).await.ok()?;
    assets::entry_name(&html)
}

/// 在本地全部运行时里找构建标识相同的那一个。
fn match_local(local: &[(String, PathBuf)], remote: &str) -> Option<(String, PathBuf)> {
    local
        .iter()
        .find(|(_, dist)| assets::build_id(dist).as_deref() == Some(remote))
        .map(|(label, dist)| (label.clone(), dist.clone()))
}

/// 本地运行时清单的可读形式（进对话框与日志）。
fn describe(local: &[(String, PathBuf)]) -> String {
    if local.is_empty() {
        return "无".to_string();
    }
    local
        .iter()
        .map(|(label, _)| label.as_str())
        .collect::<Vec<_>>()
        .join("、")
}

/// 三个选项（原生对话框，一次问清）。用 oneshot 把回调式弹窗转成异步等待，
/// 不在 async 上下文里阻塞线程。
async fn ask(app: &AppHandle, remote: &str, local: &[(String, PathBuf)]) -> MessageDialogResult {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "远程 dsh 的前端构建是 {remote}，不在本机内置或已下载的运行时里（本机：{}）。\n\n\
             • 下载对应运行时：从发布源装最新运行时装上，装完自动重新比对；\n\
             • 用当前默认运行时：文档与资产出本地那份，版本不符可能界面异常；\n\
             • 直接加载远程桌面：不走壳内 origin，用远程自己的页面（最稳）。",
            describe(local)
        ))
        .title("远程 dsh 与本地运行时版本不一致")
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "下载对应运行时".to_string(),
            "用当前默认运行时".to_string(),
            "直接加载远程桌面".to_string(),
        ))
        .show_with_result(move |result| {
            let _ = tx.send(result);
        });
    rx.await.unwrap_or(MessageDialogResult::Cancel)
}

/// 下载之后仍不符时的两选项（此时已证明「装最新版也对不上」）。
async fn ask_after_download(app: &AppHandle) -> BuildGate {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(
            "最新运行时已经装好，但它的前端构建仍与远程不一致。\n\n\
             • 用当前默认运行时：出本地文档，版本不符可能界面异常；\n\
             • 直接加载远程桌面：不走壳内 origin，用远程自己的页面（最稳）。",
        )
        .title("仍与远程构建不一致")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "用当前默认运行时".to_string(),
            "直接加载远程桌面".to_string(),
        ))
        .show_with_result(move |result| {
            let _ = tx.send(result);
        });
    match rx.await.unwrap_or(MessageDialogResult::Cancel) {
        MessageDialogResult::Ok => BuildGate::UseLocalAnyway,
        _ => BuildGate::RemoteWebview,
    }
}

/// 选项 ① 的执行结果。
enum Installed {
    /// 装完命中了远程构建。
    Matched(String, PathBuf),
    /// 装完仍不符（远程可能比发布源更新，或根本不是发布版）。
    StillMismatched,
}

/// 装发布源里的最新运行时，装完重新比对。
///
/// 远程页面只暴露前端**构建标识**（内容 hash），推不出 dsh 版本号，所以这里取目录里的最新
/// 版本；装完立刻重新比对，命中就用，不命中就如实告诉用户——不假装对齐。
async fn install_latest_runtime(app: &AppHandle) -> Result<Installed, String> {
    let settings = crate::settings::load_desktop_settings();
    let source = settings
        .runtime_source
        .clone()
        .unwrap_or_else(|| "github".to_string());
    let catalog =
        crate::runtime::registry::fetch_catalog(&source, settings.runtime_github_repo.as_deref())
            .await?;
    let latest = catalog
        .iter()
        .find(|entry| entry.channel == "latest")
        .or_else(|| catalog.first())
        .ok_or("发布源里没有可用版本")?;
    log::info!("[remote-build] 下载运行时 {}（来源 {source}）", latest.version);
    crate::runtime::registry::download_and_install(app, &latest.version).await?;
    // 登记：装的这一份要能被 local_dists 看见（否则下次启动又判「不在本地」）。
    crate::runtime::registry::record_installed(
        app,
        crate::runtime::registry::InstalledRuntime {
            version: latest.version.clone(),
            source,
            installed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        },
    );
    // 只失效资产解析缓存：**不能**调 shell_origin::reset()，那会连会话 cookie 一起清掉，
    // 后面的导航就变成未认证请求了。
    assets::invalidate();
    let local = assets::local_dists(app);
    let Some(remote) = remote_build_id(app).await else {
        return Ok(Installed::StillMismatched);
    };
    Ok(match match_local(&local, &remote) {
        Some((label, dist)) => Installed::Matched(label, dist),
        None => Installed::StillMismatched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个「index.html 里引用某个入口产物」的假 dist。
    fn fake_dist(label: &str, entry: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("dsh-buildid-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("index.html"),
            format!("<head><script type=\"module\" src=\"./assets/{entry}\"></script></head>"),
        )
        .unwrap();
        root
    }

    #[test]
    fn match_local_compares_build_ids() {
        let hit = fake_dist("hit", "index-AAA.js");
        let other = fake_dist("other", "index-BBB.js");
        let local = vec![
            ("0.1.7-rc.2".to_string(), hit.clone()),
            ("0.1.6".to_string(), other),
        ];
        assert_eq!(
            match_local(&local, "index-AAA.js"),
            Some(("0.1.7-rc.2".to_string(), hit.clone()))
        );
        // 不在本地 → None（调用方据此弹三选项）
        assert_eq!(match_local(&local, "index-CCC.js"), None);
        let _ = std::fs::remove_dir_all(&hit);
    }

    #[test]
    fn describe_lists_local_labels() {
        assert_eq!(describe(&[]), "无");
        let local = vec![
            ("0.1.7-rc.2".to_string(), PathBuf::from("/tmp/a")),
            ("内置".to_string(), PathBuf::from("/tmp/b")),
        ];
        assert_eq!(describe(&local), "0.1.7-rc.2、内置");
    }
}
