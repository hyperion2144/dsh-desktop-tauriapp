//! 通知服务器 + 任务完成通知注入。
//!
//! 迁移自 lib.rs 功能区域（notify）。

use tauri::{AppHandle, Manager, Emitter};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;
use std::sync::atomic::Ordering;
use std::time::Duration;
use crate::network::web_token::random_token;
use crate::runtime::state::DshState;
/// 启动本地 HTTP 通知服务器（127.0.0.1 随机端口），返回 (端口, token)。
/// 页面注入 JS 通过 POST /notify 上报任务完成。
pub(crate) fn start_notify_server(app: AppHandle) -> (u16, String) {
    let token = random_token();
    let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            log::warn!("通知服务器启动失败：{e}");
            return (0, token);
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    listener.set_nonblocking(true).ok();
    let handle = app.clone();
    let tok = token.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(_) => return,
        };
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => continue,
            };
            let handle = handle.clone();
            let tok = tok.clone();
            tauri::async_runtime::spawn(async move {
                handle_notify_conn(&mut sock, &handle, &tok).await;
            });
        }
    });
    log::info!("任务完成通知服务器已启动：127.0.0.1:{port}");
    (port, token)
}

/// CORS 响应头：注入脚本从 `127.0.0.1:<服务端口>` 跨源 fetch 到本桥（随机端口），
/// `Content-Type: application/json` + `Authorization` 头会触发浏览器 preflight；
/// 不回 OPTIONS 与 `Access-Control-Allow-*` 头，浏览器会直接拦截实际请求
/// （0.3.0 任务通知"收不到"的根因之一）。
pub(crate) const CORS_HEADERS: &str = "Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
Access-Control-Max-Age: 86400\r\n";

/// 完整读取一条 HTTP 请求（头 + 可能分段的 body，按 Content-Length 收齐）。
/// 单次 read 只读头时 body 会丢（自诊断 / 通知的 JSON body 偶发单独到达）。
pub(crate) async fn read_full_request(sock: &mut tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match sock.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
        let s = String::from_utf8_lossy(&buf);
        let Some((head, body)) = s.split_once("\r\n\r\n") else { continue };
        let clen = head.lines().find_map(|l| {
            let l = l.to_ascii_lowercase();
            l.strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        });
        match clen {
            Some(len) if body.len() >= len || buf.len() < 5 => break, // 收齐或请求过小
            Some(_) => continue, // 等剩余 body
            None => break,       // 无 body：头完即止
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// 处理单条通知连接：先应答 CORS 预检，再校验 Bearer token、解析 JSON body、触发通知。
pub(crate) async fn handle_notify_conn(sock: &mut tokio::net::TcpStream, app: &AppHandle, token: &str) {
    use tokio::io::AsyncWriteExt;
    let req = read_full_request(sock).await;
    // 预检 OPTIONS 不带 body、不校验 token，回 204 + CORS 头后由浏览器发起正式 POST。
    if req.starts_with("OPTIONS ") {
        let _ = sock
            .write_all(
                format!("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n{CORS_HEADERS}\r\n")
                    .as_bytes(),
            )
            .await;
        return;
    }
    if !req.contains(&format!("Bearer {token}")) {
        let _ = sock
            .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    }
    let body = req.split("\r\n\r\n").nth(1).unwrap_or("").trim().to_string();
    // #186：忙状态上报**不是通知**——它只驱动壳侧防休眠断言，落地后直接 204 返回。
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        if v.get("type").and_then(|x| x.as_str()) == Some("busy-state") {
            let profile = v.get("profile").and_then(|x| x.as_str()).unwrap_or("");
            let busy = v.get("busy").and_then(|x| x.as_bool()).unwrap_or(false);
            crate::power::set_busy(profile, busy);
            let _ = sock
                .write_all(
                    format!("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n{CORS_HEADERS}\r\n")
                        .as_bytes(),
                )
                .await;
            return;
        }
    }
    // 事件类型分派（#142 原生事件桥）：宿主脚本按 session/event 类型上报，
    // 未知/缺省回落任务完成（兼容旧轮询脚本）。
    let (scenario, msg) = match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(v) => {
            let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("task-complete").to_string();
            let m = v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string();
            match t.as_str() {
                "dsh-approval" => (
                    crate::network::notify_policy::scenario::DSH_APPROVAL,
                    if m.is_empty() { "会话在等待你的审批确认".to_string() } else { m },
                ),
                "dsh-error" => (
                    crate::network::notify_policy::scenario::DSH_ERROR,
                    if m.is_empty() { "会话运行出错，回来看看详情".to_string() } else { m },
                ),
                _ => (
                    crate::network::notify_policy::scenario::TASK_COMPLETE,
                    if m.is_empty() { "任务已完成".to_string() } else { m },
                ),
            }
        }
        Err(_) => (crate::network::notify_policy::scenario::TASK_COMPLETE, "任务已完成".to_string()),
    };
    notify_completed(app, scenario, &msg);
    let _ = sock
        .write_all(
            format!("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n{CORS_HEADERS}\r\n")
                .as_bytes(),
        )
        .await;
}

/// 收到 dsh 事件后的壳侧动作（#142）：场景化投递；仅窗口失焦/隐藏时计入未读、
/// 设 Dock 角标、弹横幅并跳 Dock——聚焦时用户正在看，不构成未读（实测反馈：
/// 角标挂到下次 Focused 才消失是不对行为）。
pub(crate) fn notify_completed(app: &AppHandle, scenario: &str, body: &str) {
    let distracted = app
        .get_webview_window("main")
        .map(|w| {
            let focused = w.is_focused().unwrap_or(true);
            let visible = w.is_visible().unwrap_or(true);
            !focused || !visible
        })
        .unwrap_or(true);
    let state = app.state::<DshState>();
    // 未读角标语义：聚焦时不计未读、不设角标。
    if !distracted {
        log::info!("[notify] {scenario}：{body}（聚焦中，不打扰）");
        return;
    }
    let unread = state.unread.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(Some(unread as i64));
        show_notification(app, scenario, "DeepSeek Harness Desktop · 任务完成", body);
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    // 桌宠气泡：可见时推送 pet-say 事件（前端气泡 5s 自动收起）
    if let Some(pet) = app.get_webview_window("pet") {
        if pet.is_visible().unwrap_or(false) {
            let _ = app.emit("pet-say", serde_json::json!({ "body": body }));
        }
    }
    log::info!("[notify] {scenario}：{body}（未读 {unread}，失焦={distracted}）");
}

/// 生成页面侧任务完成监听脚本：轮询"忙碌→空闲"翻转，翻转即上报。
pub(crate) fn task_notifier_script(port: u16, token: &str) -> String {
    let js = r#"
(function(){
  if (window.__xnlNotify) return;
  window.__xnlNotify = true;
  var PORT = __PORT__, TOKEN = "__TOKEN__";
  var wasBusy = false, lastFire = 0;
  function isBusy(){
    try {
      // 运行中标记：GUI 的加载 spinner 用 data-state="ongoing"（编译产物实测存在；
      // 旧的"停止"是运行时 i18n 文案，bundle 里 0 次，永远判不出忙碌）
      if (document.querySelector('[data-state="ongoing"]')) return true;
      if (document.querySelector('[aria-busy="true"]')) return true;
    } catch(e){}
    return false;
  }
  function fire(){
    var now = Date.now();
    if (now - lastFire < 3000) return;
    lastFire = now;
    try {
      fetch('http://127.0.0.1:'+PORT+'/notify', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
        body: JSON.stringify({type:'task-complete', body:'任务已完成，回来看看吧'})
      });
    } catch(e){}
  }
  setInterval(function(){
    var b = isBusy();
    if (wasBusy && !b) fire();
    wasBusy = b;
  }, 1000);
})();
"#;
    js.replace("__PORT__", &port.to_string())
        .replace("__TOKEN__", token)
}

/// 导航完成后注入任务完成监听（脚本自带守卫，重复注入无害）。
///
/// `label` 是目标窗口（#186 修：此前硬取 `"main"`，次窗从来没被注入过）。
pub(crate) fn inject_task_notifier(app: AppHandle, label: &str, port: u16, token: &str) {
    if port == 0 {
        return;
    }
    let handle = app.clone();
    let label = label.to_string();
    let script = task_notifier_script(port, token);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        if let Some(w) = handle.get_webview_window(&label) {
            if let Err(e) = w.eval(&script) {
                log::warn!("任务完成监听注入失败（{label}）：{e}");
            } else {
                log::info!("任务完成监听已注入（{label}，忙碌→空闲检测）");
            }
        }
    });
}

/// 最小 TCP+HTTP 探测：连接成功且 GET / 返回 <400 视为健康。

/// 确认/申请系统通知权限（三平台分派）。
/// macOS：直连 UNUserNotificationCenter 真实授权（#142；插件桌面端权限 API 是硬编码
/// Granted 的桩，绝不走插件，见 notify_un 模块注释）；Windows/Linux：插件幂等确认。
/// 放任何 `.show()` 之前 best-effort 调用并记录结果，便于排查「通知不生效」。
pub(crate) fn request_notification_permission(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        crate::network::notify_un::request_auth(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::plugin::PermissionState;
        match app.notification().permission_state() {
            Ok(PermissionState::Granted) => log::info!("通知权限：已授予"),
            Ok(PermissionState::Prompt | PermissionState::PromptWithRationale) => {
                match app.notification().request_permission() {
                    Ok(_) => log::info!("通知权限：未决定，已发起请求"),
                    Err(e) => log::warn!("申请通知权限失败：{e}"),
                }
            }
            Ok(PermissionState::Denied) => log::warn!("通知权限：被拒绝，任务完成通知将不可见"),
            Err(e) => log::warn!("查询通知权限失败：{e}"),
        }
    }
}

/// 发一条系统通知（唯一分发口）：场景策略 → 声音档 → 平台分派。
/// macOS：UNUserNotificationCenter 直连（插件路径在新 macOS 静默失败且吞错，#142），
/// 授权被拒/投递失败自动转 osascript 兜底；Windows/Linux：tauri-plugin-notification。
/// 单条投递失败只落日志，不影响调用方流程。
pub(crate) fn show_notification(
    app: &tauri::AppHandle,
    scenario_id: &str,
    title: &str,
    body: &str,
) {
    use crate::network::notify_policy::{self, SoundChoice};

    let cfg = crate::settings::load_desktop_settings().notifications;
    let fullscreen = app
        .get_webview_window("main")
        .map(|w| w.is_fullscreen().unwrap_or(false))
        .unwrap_or(false);
    let decision = notify_policy::decide(&cfg, scenario_id, crate::platform::local_now_hm(), fullscreen);
    if !decision.deliver {
        log::debug!("通知被策略拦截：{scenario_id}（{title}）");
        return;
    }
    if let SoundChoice::Custom(name) = &decision.sound {
        crate::network::sounds::play_custom_async(name);
    }
    let with_sound = !decision.silent && decision.sound == SoundChoice::OsDefault;

    #[cfg(target_os = "macos")]
    {
        let _ = app; // macOS 直连 UN（含 osascript 兜底），不经 tauri-plugin-notification
        crate::network::notify_un::show(title, body, with_sound);
    }
    #[cfg(not(target_os = "macos"))]
    {
        match app.notification().builder().title(title).body(body).show() {
            Ok(()) => log::info!("系统通知已发送：{title}"),
            Err(e) => log::warn!("系统通知发送失败（{title}）：{e}"),
        }
    }
}
