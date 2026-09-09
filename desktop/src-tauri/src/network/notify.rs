//! 通知服务器 + 任务完成通知注入。
//!
//! 迁移自 lib.rs 功能区域（notify）。

use tauri::{AppHandle, Manager, Emitter};
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
    let mut msg = "任务已完成".to_string();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(s) = v.get("body").and_then(|x| x.as_str()) {
            msg = s.to_string();
        }
    }
    notify_completed(app, &msg);
    let _ = sock
        .write_all(
            format!("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n{CORS_HEADERS}\r\n")
                .as_bytes(),
        )
        .await;
}

/// 收到任务完成信号后的壳侧动作：Dock 角标 +1；仅窗口失焦/隐藏时弹通知并跳 Dock。
pub(crate) fn notify_completed(app: &AppHandle, body: &str) {
    let distracted = app
        .get_webview_window("main")
        .map(|w| {
            let focused = w.is_focused().unwrap_or(true);
            let visible = w.is_visible().unwrap_or(true);
            !focused || !visible
        })
        .unwrap_or(true);
    let state = app.state::<DshState>();
    let unread = state.unread.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(Some(unread as i64));
        if distracted {
            show_notification(app, "DeepSeek Harness Desktop · 任务完成", body);
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
    // 桌宠气泡：可见时推送 pet-say 事件（前端气泡 5s 自动收起）
    if let Some(pet) = app.get_webview_window("pet") {
        if pet.is_visible().unwrap_or(false) {
            let _ = app.emit("pet-say", serde_json::json!({ "body": body }));
        }
    }
    log::info!("任务完成通知：{}（未读 {unread}，失焦={distracted}）", body);
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
pub(crate) fn inject_task_notifier(app: AppHandle, port: u16, token: &str) {
    if port == 0 {
        return;
    }
    let handle = app.clone();
    let script = task_notifier_script(port, token);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        if let Some(w) = handle.get_webview_window("main") {
            if let Err(e) = w.eval(&script) {
                log::warn!("任务完成监听注入失败：{e}");
            } else {
                log::info!("任务完成监听已注入（忙碌→空闲检测）");
            }
        }
    });
}

/// 最小 TCP+HTTP 探测：连接成功且 GET / 返回 <400 视为健康。

/// 确认/申请系统通知权限（三平台通用）。
/// tauri-plugin-notification 桌面端 `request_permission`/`permission_state` 返回
/// `PermissionState`：macOS 走 UNUserNotificationCenter、Windows 走 Toast（AUMID）、
/// Linux 走 dbus 通知。放任何 `.show()` 之前 best-effort 调用并记录结果，便于排查
/// “通知不生效”（显示权限被拒 / 平台不支持 / 请求失败等）。
pub(crate) fn request_notification_permission(app: &tauri::AppHandle) {
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

/// 发一条系统通知并记录发送失败（用于排查“通知不生效”）。
/// `.show()` 返回的错在插件内部被吞掉，这里统一落日志。
pub(crate) fn show_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => log::info!("系统通知已发送：{title}"),
        Err(e) => log::warn!("系统通知发送失败（{title}）：{e}"),
    }
}
