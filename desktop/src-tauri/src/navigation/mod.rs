//! 主窗口导航模块。
//!
//! 轮询就绪→导航到 Web GUI / 错误页 / 显示主窗。
//! NavigationStrategy 不引入 trait（#46 决议：正交 bool 组合）。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::runtime::state::{
    DshState, MODE_ADVANCED, STATUS_READY, STATUS_STARTING, set_status,
};
use crate::settings::{load_desktop_settings};
use crate::process::lifecycle::port_open;
use crate::network::web_token::{
    exchange_token_for_cookie, seed_session_cookie, session_cookie_accepts,
};


/// 统一的导航收尾：跳转 + 注入通知桥 + 置就绪状态 + 标题栏形态跟随模式。
///
/// **所有「进入本地/远程 GUI」的路径都必须走这里**（本地就绪、远程走壳内 origin 两种）。
/// 之前远程那条路绕过它直接 `w.navigate`，于是远程模式下：侧边栏状态永远停在「启动中」、
/// 窗口还挂着系统原生标题栏（实机报告）。
pub(crate) fn navigate_main(app: &AppHandle, url: &str, nport: u16, ntoken: &str) {
    // 标题栏形态跟随接入模式：从远程/兼容模式切回本地时，窗口可能还挂着系统原生标题栏，
    // 这里（进入本地 GUI 的唯一收尾点）按当前模式再对齐一次。
    crate::ui::tray::apply_titlebar(
        app,
        app.state::<DshState>().mode.load(std::sync::atomic::Ordering::SeqCst) == MODE_ADVANCED,
    );
    if let Some(w) = app.get_webview_window("main") {
        // 用 **webview 原生导航**而不是 JS `location.replace`：实测 JS 导航到自定义协议
        // 被 WKWebView 静默忽略（协议处理器调用次数 = 0），页面根本不会加载。
        // `navigate` 对 http 与 dshapp:// 统一可用。
        let outcome = match tauri::Url::parse(url) {
            Ok(parsed) => w.navigate(parsed).map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        if let Err(e) = outcome {
            log::warn!("窗口导航失败：{e}");
            return;
        }
        inject_task_notifier(app.clone(), nport, ntoken);
    }
    log::info!("本地服务就绪，已导航到 {url}");
    set_status(app, STATUS_READY, "运行中");
    app.state::<DshState>()
        .ready_once
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 远程入口（**唯一一处**）：换会话 cookie → 构建闸门 → 锁定产物。
///
/// 返回 `Some` = 走壳内 origin（会话与产物都已就位）；`None` = 调用方按既有远程导航
/// （URL webview）继续。冷启动短路（`network::remote::navigate_remote`）与
/// [`wait_ready_and_navigate`] 两条入口必须共用本函数，否则必然漂移。
pub(crate) async fn enter_remote(app: &AppHandle, addr: &str) -> RemoteEntry {
    let Some((secure, authority)) = shell_origin::parse_remote(addr) else {
        log::warn!("[nav] 远程地址无法解析：{addr}");
        return RemoteEntry::UrlWebview(addr.to_string());
    };
    // 手机访问的配对链接是**一次性**凭据（lane 的 `/pair` 接受即作废），而且壳里同时存在
    // 两条会碰它的路（壳内 origin 的换会话预检 + 旧路把链接交给 webview 导航）——两条
    // 同时上就是抢一个一次性令牌，总有一条拿到「链接无效或已过期」。规矩：**壳内这条
    // 路做它的唯一使用者**：先看上次配对存下的设备会话，有就直接用，没有才去换一次。
    let saved = crate::settings::load_desktop_settings()
        .remote_session
        .and_then(|s| s.split_once('=').map(|(a, c)| (a.to_string(), c.to_string())))
        .filter(|(saved_authority, _)| *saved_authority == authority);
    let entry = entry_target(addr);
    let cookie = match saved {
        Some((_, cookie)) => {
            log::info!("[nav] 复用上次配对存下的设备会话（不消费配对链接）");
            cookie
        }
        None => {
            // 与本地模式**同一个函数**换会话（入口 path 不同：本地 `/`，lane `/pair`）。
            let Some(token) = crate::network::remote::extract_token_from_url(addr) else {
                log::warn!("[nav] 远程地址里没有 token，按 URL webview 打开");
                return RemoteEntry::UrlWebview(addr.to_string());
            };
            let path = tauri::Url::parse(addr.trim())
                .map(|u| u.path().to_string())
                .unwrap_or_else(|_| "/".to_string());
            let Some((name, value)) =
                crate::network::web_token::exchange_entry_for_cookie(&authority, &path, &token)
            else {
                explain_session_failure(app, &entry);
                return RemoteEntry::UrlWebview(addr.to_string());
            };
            // 存下设备会话（`authority=cookie`）：下次启动直接用它，不再动一次性链接。
            let payload = format!("{name}={value}");
            let mut settings = crate::settings::load_desktop_settings();
            settings.remote_session = Some(format!("{authority}={payload}"));
            // 存盘失败不该静默：下次启动会重新消费一次性链接（或直接失败）。
            if let Err(e) = crate::settings::save_desktop_settings(&settings) {
                log::warn!("[nav] 远程会话存盘失败（下次启动需重新配对）：{e}");
            }
            payload
        }
    };
    // 会话 cookie 只活在壳内存里（数据面转发时注入）。若用户随后选「直接加载远程桌面」，
    // 那个 webview 自己没登录过——所以同一份 cookie 也种进 webview，并把回退地址收敛到
    // **根路径**（已作废的一次性链接不再重开）。
    seed_remote_cookie(app, &authority, secure, &cookie);
    // 与**本地模式同一套**：种入后必须**验证服务端确实接受**这个 cookie 才继续
    // （本地是「换 cookie → 种入 → 验证 → 才切页面」，远程同构）。
    if let Some((name, value)) = cookie.split_once('=') {
        let mut verified = false;
        for _ in 0..4 {
            if crate::network::web_token::session_cookie_accepts(&authority, name, value) {
                verified = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        }
        if !verified {
            log::warn!("[nav] 远程会话 4 轮验证未过（上游未接受该 cookie）");
            crate::network::notify::show_notification(
                app,
                crate::network::notify_policy::scenario::CONFIG_ERROR,
                "远程会话未通过验证",
                "远程地址没有接受刚换到的会话 cookie（可能需重新铸造/配对）。",
            );
        }
    }
    shell_origin::set_session(&authority, cookie);
    match remote_build::gate(app).await {
        // 命中（含「下载对应运行时」后命中）：锁定那一份产物出文档。
        remote_build::BuildGate::Matched(_, dist) => {
            shell_origin::assets::set_dist_override(Some(dist));
            RemoteEntry::ShellOrigin
        }
        // 用户选「用当前默认运行时」：不锁定产物，按设置里那份出（对话框已警告版本风险）。
        remote_build::BuildGate::UseLocalAnyway => RemoteEntry::ShellOrigin,
        // 用户选「直接加载远程桌面」：回退到远程**根路径**（会话已种入 webview）。
        remote_build::BuildGate::RemoteWebview => RemoteEntry::UrlWebview(remote_root(addr)),
    }
}

/// 远程入口的两种走法。
pub(crate) enum RemoteEntry {
    /// 壳内 origin：本地文档 + 本地资产 + 流式数据面（会话与产物都已就位）。
    ShellOrigin,
    /// URL webview：直接打开这个地址（壳内 origin 这条路不成立时的明确出口）。
    UrlWebview(String),
}

/// 会话交换失败要**说清原因**：拿着一次性配对链接时，用户只会看到 lane 的「配对失败」页，
/// 不知道是令牌被用过/过期（壳换会话本身也会把一次性令牌用掉）。
fn explain_session_failure(app: &AppHandle, entry: &str) {
    let (title, body) = if entry.starts_with("/pair") {
        (
            "远程配对失败",
            "配对令牌无效或已被使用（令牌是一次性的，配对过或过期即作废）。请在远程 dsh 的『远程访问』里重新铸造令牌，再粘贴新链接。",
        )
    } else {
        (
            "远程会话建立失败",
            "未能用这个地址换取远程会话 cookie，将直接打开远程页面（详情见日志）。",
        )
    };
    crate::network::notify::show_notification(
        app,
        crate::network::notify_policy::scenario::CONFIG_ERROR,
        title,
        body,
    );
}

/// 远程根地址（`scheme://authority/`）：回退到 URL webview 时用它，而不是一次性链接。
pub(crate) fn remote_root(addr: &str) -> String {
    match tauri::Url::parse(addr.trim()) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {
            let host = url.host_str().unwrap_or("127.0.0.1");
            match url.port() {
                Some(port) => format!("{}://{host}:{port}/", url.scheme()),
                None => format!("{}://{host}/", url.scheme()),
            }
        }
        _ => addr.to_string(),
    }
}

/// 把壳换到的会话 cookie 也种进主窗（回退 URL webview 时才有登录态）。
fn seed_remote_cookie(app: &AppHandle, authority: &str, secure: bool, cookie: &str) {
    let Some((host, port)) = shell_origin::split_authority(authority, secure) else {
        return;
    };
    let Some((name, value)) = cookie.split_once('=') else {
        return;
    };
    if !crate::network::web_token::seed_session_cookie(app, &host, port, name, value) {
        log::warn!("[nav] 远程会话 cookie 未能种入 webview（回退 URL webview 时会重新走鉴权）");
    }
}

mod remote_build;

/// 远程地址 → 入口 path+query（会话交换要用的请求目标）。
///
/// dsh 的启动 URL 形如 `http://host:3080/?token=…`；手机访问的配对链接形如
/// `http://host:3092/pair?token=…`。**不单独抽 token**：把入口整体交给会话交换，
/// 两种上游各自回自己的会话 cookie（dsh 回 `dsh-auth-*`，lane 回 `dsh_mobile_session`）。
/// 老格式 `host[:port]` 没有路径 → `/`。
pub(crate) fn entry_target(addr: &str) -> String {
    match tauri::Url::parse(addr.trim()) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {
            // 手机访问 lane 的铸造链接是历史形态（`/pair`、`/api/pair/*` 是**冻结别名**）；
            // 规范路由住在保留命名空间 `/__dsh-mobile` 下（lane-routes.mjs 的唯一事实源）。
            // 壳统一按规范形态发请求：别名在反代门禁那里不总命中（实测拿到的是反代的
            // `401 {"error":"unpaired"}` 而不是 lane 自己的配对分支），规范形态必中。
            let path = match url.path() {
                "/pair" => "/__dsh-mobile/pair".to_string(),
                other if other.starts_with("/api/pair/") => format!("/__dsh-mobile{other}"),
                other => other.to_string(),
            };
            match url.query() {
                Some(query) => format!("{path}?{query}"),
                None => path,
            }
        }
        _ => "/".to_string(),
    }
}
use crate::network::notify::inject_task_notifier;
use crate::network::remote::navigate_remote;
use crate::network::shell_origin;

/// 轮询等待服务就绪，然后把主窗口导航到 Web GUI。
/// `nport`/`ntoken` 是通知桥的端口与令牌，导航完成后才注入监听脚本。
///
/// 启动无超时限制（产品要求），且严格按「后台交换成功才进入」执行：
/// ① spawn 场景无限等待 stdout 打印 process token（输出持续上屏）；
/// ② 在后台用 token 原生换取会话 cookie（不经任何界面），种入 webview，
///    并带 cookie 请求根路径确认服务端 200 —— 三步全绿才切换；
/// ③ 任一步失败都留在启动界面重试（dsh 输出持续上屏），绝不带着失败
///    状态跳转。成功后主窗口一次性直达根路径（cookie 随行，直接 200），
///    桌面 chrome 由 client 经 IPC 查询壳状态自行激活。
/// `epoch` = 本次启动任务版本（worker latest-wins：被更新任务抢占即让位）。
pub(crate) async fn wait_ready_and_navigate(app: AppHandle, epoch: u64, nport: u16, ntoken: String) {
    let state = app.state::<DshState>();
    // 每次启动/导航都重置壳侧会话与资产解析：旧 authority 的 cookie 属旧实例，
    // 旧的 dist 路径可能指向刚被切掉的运行时。
    shell_origin::reset();
    // 远程模式：不探测/不 spawn 本地，直接导航远程页面
    if let Some(addr) = load_desktop_settings().remote_addr {
        // #154：远程先试壳内 origin（本地文档 + 本地资产 + 构建闸门）；不成立就按 URL
        // webview 直接打开远程页面。两条都是**明确**入口，没有静默兜底。
        match enter_remote(&app, &addr).await {
            RemoteEntry::ShellOrigin => {
                log::info!("[nav] 远程模式走壳内 origin（会话与产物已就位）");
                navigate_main(&app, shell_origin::scheme::PAGE_ORIGIN, nport, &ntoken);
            }
            RemoteEntry::UrlWebview(url) => {
                log::info!("[nav] 远程不走壳内 origin，直接打开远程页面：{url}");

                navigate_remote(&app, &url);
            }
        }
        return;
    }
    let port = state.main_worker.port();
    // spawn 场景才等 stdout 的 token 行（外部复用场景的 token 只能来自粘贴）
    let expect_token = state.spawned_this_run.load(std::sync::atomic::Ordering::SeqCst);
    let mut rounds = 0u32;
    loop {
        // latest-wins 让位：已有更新的启动任务接管（新任务会自己导航），
        // 本任务放弃，绝不把加载页导航到别人的实例。
        if state.main_worker.epoch() != epoch {
            log::info!("[nav] 任务 #{epoch} 已被任务 #{} 抢占，让位", state.main_worker.epoch());
            return;
        }
        // spawn 场景下子进程若已退出，绝不把加载页导航到死实例；
        if expect_token && state.main_worker.child_exited().is_some() {
            tokio::time::sleep(Duration::from_millis(400)).await;
            continue;
        }
        if state.quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let web_token = state.web_token.lock().unwrap().clone();
        // spawn 场景：无限等待 stdout 打印 token（无超时）；dsh 未就绪/挂掉都
        // 停留在启动界面（其输出已流式上屏，供用户查看）
        if expect_token && web_token.is_empty() {
            tokio::time::sleep(Duration::from_millis(400)).await;
            continue;
        }
        if !port_open(port) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        let host_port = format!("127.0.0.1:{port}");
        // 无 token（老版 dsh 外部实例且未粘贴 token）：无鉴权直连（旧行为）
        if web_token.is_empty() {
            let url = format!("http://127.0.0.1:{port}/");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("window.location.replace({url:?});"));
                inject_task_notifier(app.clone(), nport, &ntoken);
            }
            log::info!("本地服务就绪，已导航到 {url}");
            set_status(&app, STATUS_READY, "运行中");
            app.state::<DshState>().ready_once.store(true, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        rounds += 1;
        // ①② 后台交换 cookie 并验证服务端接受（全程不经界面，启动界面保持显示）
        let Some((name, value)) = exchange_token_for_cookie(&host_port, &web_token) else {
            if rounds % 5 == 1 {
                log::warn!("[nav] 会话 cookie 交换未成功，继续等待（第 {rounds} 轮）");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        };
        if !seed_session_cookie(&app, "127.0.0.1", port, &name, &value) {
            // set_cookie 平台不支持：回退 token 直开（此时会经 303 换 cookie，
            // 可能有短暂白屏，属于平台能力降级而非常规路径）
            log::warn!("[nav] 原生种 cookie 不可用，回退 token 直开路径");
            let url = format!("http://127.0.0.1:{port}/?token={web_token}");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("window.location.replace({url:?});"));
                inject_task_notifier(app.clone(), nport, &ntoken);
            }
            log::info!("本地服务就绪，已导航到 {url}");
            set_status(&app, STATUS_READY, "运行中");
            app.state::<DshState>().ready_once.store(true, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        // ③ 验证服务端确实接受种入的 cookie（不经验证不切换）
        if !session_cookie_accepts(&host_port, &name, &value) {
            if rounds <= 10 {
                log::warn!("[nav] 第 {rounds} 轮会话验证未通过，留在启动界面重试");
                set_status(&app, STATUS_STARTING, "重新建立会话…");
                tokio::time::sleep(Duration::from_millis(1000)).await;
                continue;
            }
            log::error!("[nav] 连续 {rounds} 轮会话验证失败，停留在启动界面（请查看 dsh 输出）");
            return;
        }
        // #154（重做）：页面 origin = **壳自己注册的协议**，不再落在 http 上（本分支无兜底）。
        // 依据 `tauri-2.11.5/src/webview/mod.rs:1698` 的 `is_local_url`：认「用户自定义协议」
        // → `Origin::Local` → IPC 命中 `capabilities/default.json` 完整权限集；
        // 而 `http://127.0.0.1:<port>` 会被判 `Origin::Remote`，设置类 IPC 被整片拒掉
        // （实机复现的「正在加载设置…」）。会话仍由壳持有，中继侧注入。
        shell_origin::set_session(&host_port, format!("{name}={value}"));
        navigate_main(&app, shell_origin::scheme::PAGE_ORIGIN, nport, &ntoken);
        return;
        // 旧路径已删：不再有「导航到 http://127.0.0.1:<dsh 端口>/」这条兜底。
        // 页面只可能来自壳注册的协议（见上），走没走本地看 location.protocol 即可。
    }
}
