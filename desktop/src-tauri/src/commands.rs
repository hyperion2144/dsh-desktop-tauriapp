//! Tauri command 实现（generate_handler! 注册仍在 lib.rs）。
//!
//! 迁移自 lib.rs 功能区域（commands）。

use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use crate::runtime::state::DshState;
use crate::settings::{load_desktop_settings, save_desktop_settings, configured_port};
use crate::network::proxy::{normalize_proxy_url, split_authority, PROXY_MODE_OFF, PROXY_MODE_SYSTEM, PROXY_MODE_MANUAL};
use crate::process::lifecycle::spawn_dsh;
use crate::network::web_token::{store_web_token, clear_web_token};
use crate::network::notify::show_notification;
use crate::ui::tray::{refresh_tray_mode, restart_dsh_in_mode, apply_titlebar};
use crate::network::remote::{normalize_remote_url, extract_token_from_url};
use crate::process::plugin::desktop_platform_tag;
use crate::settings::dsh_home;
use crate::runtime::error::SpawnError;
use crate::settings::app_port;
use crate::ui::window::{show_error, current_monitor_for_window};
use crate::process::lifecycle::stop_port_owner;
use crate::navigation::wait_ready_and_navigate;
use crate::runtime::state::{MODE_ADVANCED, MODE_COMPAT};
use crate::settings::configured_profile;
use crate::network::proxy::resolved_proxy_env;
#[tauri::command]
pub(crate) fn toggle_zoom(window: tauri::WebviewWindow, state: tauri::State<DshState>) {
    let mut prev = match state.pre_zoom_geom.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if prev.is_none() {
        // 当前未放大 → 记录旧几何，把窗口设到 work area
        let pos = match window.outer_position() {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[zoom] 读不到 outer_position：{e}");
                return;
            }
        };
        let size = match window.outer_size() {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[zoom] 读不到 outer_size：{e}");
                return;
            }
        };
        let Some(mon) = current_monitor_for_window(&window) else {
            log::warn!("[zoom] 找不到窗口所在显示器，跳过");
            return;
        };
        let wa = mon.work_area();
        let target_pos = tauri::PhysicalPosition::new(wa.position.x, wa.position.y);
        let target_size = tauri::PhysicalSize::new(wa.size.width, wa.size.height);
        if let Err(e) = window.set_position(target_pos) {
            log::warn!("[zoom] set_position 失败：{e}");
            return;
        }
        if let Err(e) = window.set_size(target_size) {
            log::warn!("[zoom] set_size 失败：{e}");
            return;
        }
        *prev = Some((pos, size));
        log::info!(
            "[zoom] 已放大到显示器 work area（{}x{} at {},{}），原几何已暂存",
            wa.size.width, wa.size.height, wa.position.x, wa.position.y
        );
    } else {
        // 当前已放大 → 恢复旧几何
        if let Some((pos, size)) = prev.take() {
            if let Err(e) = window.set_position(pos) {
                log::warn!("[zoom] 恢复 set_position 失败：{e}");
            }
            if let Err(e) = window.set_size(size) {
                log::warn!("[zoom] 恢复 set_size 失败：{e}");
            }
            log::info!(
                "[zoom] 已恢复到 zoom 前几何（{}x{} at {},{}）",
                size.width, size.height, pos.x, pos.y
            );
        }
    }
}

/// 查询启动是否需要用户选择「兼容/高级」模式（启动页加载后轮询）。
#[tauri::command]
pub(crate) fn get_mode_prompt_needed(state: tauri::State<DshState>) -> bool {
    state.mode_prompt_needed.load(Ordering::SeqCst)
}

/// 查询桌面 client 渲染环境（替代 URL 标记）：
/// token 交换的 303 重定向会剥掉 query 参数，URL 标记无法与 token 同跳，
/// 故由壳按当前接入模式/平台直接下发。client 拿到 advanced 才装桌面 chrome。
#[tauri::command]
pub(crate) fn get_desktop_client_environment(state: tauri::State<DshState>) -> serde_json::Value {
    let advanced = state.mode.load(Ordering::SeqCst) == MODE_ADVANCED;
    serde_json::json!({
        "mode": if advanced { "advanced" } else { "compatibility" },
        "platform": desktop_platform_tag(),
    })
}

/// 客户端诊断上报：把页面侧外链拦截结果写进应用日志，便于排查「点击链接无反应」。
#[tauri::command]
pub(crate) fn log_diag(msg: String) {
    log::info!("[diag] {msg}");
}

/// WebView 控制台捕获：把页面侧 `console.*` 转发到 `$DSH_HOME/dsh-desktop-webview.log`，
/// 便于不依赖 GUI 开发者工具直接 `tail -f` 看前端错误。客户端通过 `initialization_script`
/// 包装 console.*（保持原行为不变，仅额外 invoke 此命令），命令失败吞掉以免阻塞页面。
/// 不向 dsh 进程 stdout 镜像（控制台输出量大时会让 dsh-desktop-tauriapp.log 噪声翻倍），
/// 但通过 `level=warn|error` 时仍镜像一份（出问题优先排查）。
#[tauri::command]
pub(crate) fn log_console(level: String, msg: String, page_url: Option<String>) {
    use std::io::Write as _;
    let path = dsh_home().join("dsh-desktop-webview.log");
    let prefix = match level.as_str() {
        "error" => "[error]",
        "warn" => "[warn] ",
        "info" => "[info] ",
        "debug" => "[debug]",
        _ => "[log]  ",
    };
    let page = page_url.as_deref().unwrap_or("?");
    // 多行消息逐行加前缀，便于 grep；空行保留可读性。
    let mut out = String::with_capacity(msg.len() + 64);
    for (i, line) in msg.lines().enumerate() {
        if i == 0 {
            out.push_str(&format!("{prefix} [page={page}] {line}\n"));
        } else {
            out.push_str(&format!("{prefix}            {line}\n"));
        }
    }
    if msg.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(out.as_bytes());
    }
    // 错误级额外镜像到 tauri 日志（便于和 dsh 子进程日志交叉对比）
    if level == "error" || level == "warn" {
        log::warn!("[webview] [{page}] {msg}");
    }
}

/// 查询 dsh 服务状态（侧边栏状态标识轮询用）。
#[tauri::command]
pub(crate) fn get_dsh_status(state: tauri::State<DshState>) -> serde_json::Value {
    serde_json::json!({
        "status": state.status.load(Ordering::SeqCst),
        "detail": "",
        "port": configured_port(),
        "profile": configured_profile(),
        "remote": load_desktop_settings().remote_addr,
    })
}

/// 请求重启 dsh 服务（状态标识点击触发；与托盘重启同一条流程）。
#[tauri::command]
pub(crate) fn restart_dsh_service(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DshState>();
    if state.restarting.load(Ordering::SeqCst) {
        return Err("已在重启中".to_string());
    }
    let mode = state.mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(&app, mode);
    Ok(())
}

/// 查询代理设置（供设置表单回显）：返回三字段配置 + 当前生效预览（便于「继承系统代理」自检）。
#[tauri::command]
pub(crate) fn get_proxy_settings() -> serde_json::Value {
    let settings = load_desktop_settings();
    let effective = resolved_proxy_env(&settings).map(|p| {
        serde_json::json!({
            "http": p.http,
            "https": p.https,
            "all": p.all,
            "no_proxy": p.no_proxy,
        })
    });
    serde_json::json!({
        "proxy_mode": settings.proxy_mode.unwrap_or_else(|| PROXY_MODE_OFF.to_string()),
        "proxy_url": settings.proxy_url.unwrap_or_default(),
        "no_proxy": settings.no_proxy.unwrap_or_default(),
        "proxy_user": settings.proxy_user.unwrap_or_default(),
        "proxy_pass": settings.proxy_pass.unwrap_or_default(),
        "effective": effective,
    })
}

/// 空串归一为 None（避免 YAML 里堆空键）。
pub(crate) fn non_empty(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

/// 保存代理设置（供设置表单提交）：校验模式与手动 URL 后沿 load→改→save 合并链路持久化，
/// 不触碰 settings.yaml 其他键。proxy_url/no_proxy/proxy_user/proxy_pass 存原值，空串归一为 None。
#[tauri::command]
pub(crate) fn save_proxy_settings(
    proxy_mode: String,
    proxy_url: String,
    no_proxy: String,
    proxy_user: String,
    proxy_pass: String,
) -> Result<(), String> {
    if proxy_mode != PROXY_MODE_OFF && proxy_mode != PROXY_MODE_SYSTEM && proxy_mode != PROXY_MODE_MANUAL {
        return Err(format!("未知代理模式：{proxy_mode}"));
    }
    if proxy_mode == PROXY_MODE_MANUAL {
        normalize_proxy_url(&proxy_url)
            .ok_or_else(|| format!("代理 URL 非法（需 http/https/socks5://host:port）：{proxy_url}"))?;
    }
    let mut settings = load_desktop_settings();
    settings.proxy_mode = Some(proxy_mode);
    settings.proxy_url = non_empty(proxy_url);
    settings.no_proxy = non_empty(no_proxy);
    settings.proxy_user = non_empty(proxy_user);
    settings.proxy_pass = non_empty(proxy_pass);
    save_desktop_settings(&settings);
    Ok(())
}

/// 代理连通性测试（设置表单「测试连接」）：对代理 host:port 做 3s 超时 TCP connect，返回耗时 ms。
#[tauri::command]
pub(crate) async fn test_proxy_connectivity(url: String) -> Result<u128, String> {
    let normalized = normalize_proxy_url(&url)
        .ok_or_else(|| format!("代理 URL 非法（需 http/https/socks5://host:port）：{url}"))?;
    let authority = normalized.split("://").nth(1).unwrap_or_default();
    let (host, port) = split_authority(authority);
    // normalize_proxy_url 输出恒带端口；万一缺失/非法按参数错误处理，不做静默端口兜底
    let Some(port) = port.and_then(|p| p.parse::<u16>().ok()) else {
        return Err(format!("代理 URL 缺少有效端口：{normalized}"));
    };
    let addr = format!("{host}:{port}");
    let started = std::time::Instant::now();
    let attempt = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(&addr),
    )
    .await;
    match attempt {
        Ok(Ok(_)) => Ok(started.elapsed().as_millis()),
        Ok(Err(e)) => Err(format!("连接 {addr} 失败：{e}")),
        Err(_) => Err(format!("连接 {addr} 超时（3s）")),
    }
}

/// 页面侧输入弹窗回填（确定/取消都到达这里；value 为空视为取消）。
#[tauri::command]
pub(crate) async fn ui_input_confirm(
    state: tauri::State<'_, DshState>,
    flow: String,
    value: String,
) -> Result<(), String> {
    if let Some(tx) = state.pending_input.lock().unwrap().take() {
        let _ = tx.send((flow, value));
    }
    Ok(())
}

/// 打开一个内联输入弹窗（主窗口任意页面通用），返回用户输入（取消/超时/空输入 → None）。
/// flow 用于区分并发场景；最多等待 3 分钟。
pub(crate) async fn prompt_input(
    app: &AppHandle,
    flow: &str,
    title: &str,
    placeholder: &str,
    initial: &str,
) -> Option<String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
    *app.state::<DshState>().pending_input.lock().unwrap() = Some(tx);
    let js = input_modal_js(flow, title, placeholder, initial);
    if let Some(w) = app.get_webview_window("main") {
        if w.eval(&js).is_err() {
            log::warn!("[modal] 在主窗口注入输入弹窗失败：{flow}");
            app.state::<DshState>().pending_input.lock().unwrap().take();
            return None;
        }
    }
    match tokio::time::timeout(Duration::from_secs(180), rx.recv()).await {
        Ok(Some((f, v))) if f == flow && !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => {
            app.state::<DshState>().pending_input.lock().unwrap().take();
            None
        }
    }
}

/// 构造内联输入弹窗 JS（自带样式/焦点/ESC 取消；确定时经 ui_input_confirm 回填）。
pub(crate) fn input_modal_js(flow: &str, title: &str, placeholder: &str, initial: &str) -> String {
    let (flow, title, placeholder, initial) = (
        serde_json::to_string(flow).unwrap_or_default(),
        serde_json::to_string(title).unwrap_or_default(),
        serde_json::to_string(placeholder).unwrap_or_default(),
        serde_json::to_string(initial).unwrap_or_default(),
    );
    format!(
        r#"(function(){{
  var key = 'dshDesktopInputModal';
  var old = document.getElementById(key);
  if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = key;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--dsw-alias-bg-layer-1,#1e1e1e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;padding:18px 20px;min-width:340px;max-width:80vw;box-shadow:0 12px 40px rgba(0,0,0,0.4);color:var(--dsw-alias-label-primary,#eee);';
  var titleEl = document.createElement('div');
  titleEl.textContent = {title};
  titleEl.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:12px;';
  var input = document.createElement('input');
  input.type = 'text';
  input.value = {initial};
  input.placeholder = {placeholder};
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#444);background:var(--dsw-alias-bg-base,#111);color:var(--dsw-alias-label-primary,#eee);font-size:13px;outline:none;';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
  var cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:13px;cursor:default;';
  var ok = document.createElement('button');
  ok.textContent = '确定';
  ok.style.cssText = 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-state-accent-primary,#3b82f6);color:#fff;font-size:13px;cursor:default;';
  function submit() {{
    var value = input.value || '';
    try {{
      var t = window.__TAURI_INTERNALS__ || (window.__TAURI__ && window.__TAURI__.core);
      if (t && t.invoke) t.invoke('ui_input_confirm', {{ flow: {flow}, value: value }}).catch(function(){{}});
      else window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke('ui_input_confirm', {{ flow: {flow}, value: value }}).catch(function(){{}});
    }} catch (e) {{}}
    overlay.remove();
  }}
  function cancelNow() {{ try {{ var t = window.__TAURI_INTERNALS__ || (window.__TAURI__ && window.__TAURI__.core); if (t && t.invoke) t.invoke('ui_input_confirm', {{ flow: {flow}, value: '' }}).catch(function(){{}}); }} catch (e) {{}} overlay.remove(); }}
  ok.addEventListener('click', submit);
  cancel.addEventListener('click', cancelNow);
  document.addEventListener('keydown', function esc(e) {{ if (e.key === 'Escape') {{ cancelNow(); document.removeEventListener('keydown', esc); }} if (e.key === 'Enter') {{ submit(); document.removeEventListener('keydown', esc); }} }});
  row.appendChild(cancel); row.appendChild(ok);
  card.appendChild(titleEl); card.appendChild(input); card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  input.focus(); input.select();
}})();"#
    )
}

/// 用户在启动页选择接入模式（仅复用外部 dsh web 实例时出现）。
/// - `compat`：复用外部实例、标准布局、系统原生标题栏（不启用桌面 chrome）；
/// - `advanced`：停用占用端口的现有 dsh（含外部进程），以桌面实例重启并注入局部拖拽 chrome。
#[tauri::command]
pub(crate) fn choose_desktop_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let state = app.state::<DshState>();
    state.mode_prompt_needed.store(false, Ordering::SeqCst);
    match mode.as_str() {
        "compat" => {
            log::info!("[mode] 用户选择兼容模式：复用外部实例（标准布局）");
            state.mode.store(MODE_COMPAT, Ordering::SeqCst);
            apply_titlebar(&app, false);
            refresh_tray_mode(&app);
            let port = app_port();
            let nport = state.notify_port.load(Ordering::SeqCst);
            let ntoken = state.notify_token.lock().unwrap().clone();
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                // 新版 dsh web 需要 process token（否则 401）：外部实例的 token 拿不到，
                // 提示用户粘贴 dsh web 打印的完整 URL（含 token）。老版 dsh（无 token）
                // 可直接跳过这一步。
                let web_token = handle.state::<DshState>().web_token.lock().unwrap().clone();
                if web_token.is_empty() {
                    if let Some(input) = prompt_input(
                        &handle,
                        "compat-token",
                        "粘贴 dsh web 启动 URL",
                        "形如 http://127.0.0.1:3080/?token=…（老版 dsh 可留空回车）",
                        "",
                    )
                    .await
                    {
                        if let Some(token) = extract_token_from_url(&input) {
                            store_web_token(&handle, token);
                        } else if normalize_remote_url(&input).is_some() && !input.contains("token=") {
                            log::info!("[mode] 兼容模式：输入为不带 token 的 URL，按老版 dsh 处理");
                        } else if !input.trim().is_empty() {
                            show_notification(&handle, "未能识别 token", "输入里没有 ?token= 参数，将按老版 dsh 直连（新版会 401）");
                        }
                    }
                }
                wait_ready_and_navigate(handle, port, nport, ntoken).await;
            });
            Ok(())
        }
        "advanced" => {
            log::info!("[mode] 用户选择高级模式：停用外部实例并以桌面 overlay 实例重启");
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let port = app_port();
                // 1) 停用占用端口的现有 dsh（纯代码，跨平台：netstat2 查 PID + SIGTERM/SIGKILL）
                log::info!("[mode] 停用端口 {port} 上的现有 dsh 进程");
                let freed = stop_port_owner(port).await;
                if !freed {
                    log::error!("[mode] 端口 {port} 未能停用/释放，高级模式失败");
                    show_error(&handle, "timeout");
                    return;
                }
                log::info!("[mode] 端口 {port} 已释放，用桌面 overlay 实例重启");
                // 3) 以桌面 overlay 实例拉起（先清旧 token：新实例 token 必然不同）
                clear_web_token(&handle);
                match spawn_dsh(&handle, port, true) {
                    Ok(child) => {
                        *handle.state::<DshState>().child.lock().unwrap() = Some(child);
                        handle.state::<DshState>().spawned_this_run.store(true, Ordering::SeqCst);
                        handle.state::<DshState>().mode.store(MODE_ADVANCED, Ordering::SeqCst);
                        apply_titlebar(&handle, true);
                    }
                    Err(e) => {
                        let msg = match &e {
                            SpawnError::NotFound(s) | SpawnError::Other(s) => s.clone(),
                        };
                        log::error!("[mode] spawn 失败：{msg}");
                        show_error(&handle, "spawn-failed");
                        return;
                    }
                }
                // 4) 重置标志并导航（advanced=true，桌面 chrome 生效）
                handle.state::<DshState>().spawn_failed.store(false, Ordering::SeqCst);
                let nport = handle.state::<DshState>().notify_port.load(Ordering::SeqCst);
                let ntoken = handle.state::<DshState>().notify_token.lock().unwrap().clone();
                refresh_tray_mode(&handle);
                wait_ready_and_navigate(handle, port, nport, ntoken).await;
            });
            Ok(())
        }
        _ => Err(format!("未知的桌面接入模式：{mode}")),
    }
}
