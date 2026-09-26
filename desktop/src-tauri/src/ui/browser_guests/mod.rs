//! 侧边栏浏览器 guest 管理器（#118/#134）。
//!
//! 在壳内实现 dsh 的 DesktopBrowserBridge（protocolVersion 1，公开宿主桥契约，
//! 见 dsh `ui-sidebar-browser` 的 carrier 选择逻辑）：侧边栏浏览器页面不再是
//! iframe，而是宿主窗口里的**子 webview（guest）**——对齐 dsh 官方 Electron
//! 桌面的 guest 模式。guest 顶层导航外部站点，不经 [`crate::ui::nav_guard`]
//! 误杀 iframe 的路径，从根上修掉 macOS「永远正在打开…」（#134）。
//!
//! 结构：
//! - [`policy`]：guest 导航策略（纯函数，可测试）——放行外部 http(s)、
//!   拒带凭证 URL / 应用宿主（对齐官方 browser-guests.ts 的边界规则）。
//! - [`platform`]：平台原生读控（goBack/goForward/canGoBack/canGoForward，
//!   tauri 无此 API，mac 走 objc2 msg_send、Windows 走 WebView2 COM）。
//! - 本模块：租约注册表 + Tauri 命令 + 状态推送。
//!
//! 状态推送模型：dsh 对 `<webview>` 元素的 getURL/isLoading/canGoBack 等是
//! **同步拉取**，而 tauri IPC 是异步——因此 client 端维护镜像，由本模块在
//! 每次状态变化后向**宿主 webview** eval `__dshShellBridgeImpl._receive(快照)`
//! 推送（不依赖事件权限/API）。
//!
//! bootstrap 历史不落地：guest 初始只挂 about:blank（且 WKWebView/WebView2
//! 对初始 about:blank 通常不产生 back-forward 条目），dsh 的 clearHistory()
//! 在兼容层是 no-op——规避 WKWebView 无公开 clearHistory 的平台限制。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

use crate::runtime::state::DshState;

pub(crate) mod policy;
pub(crate) mod platform;

/// guest 子 webview 的 label 前缀（nav_guard 据此豁免）。
pub(crate) const GUEST_LABEL_PREFIX: &str = "browser-guest-";

/// 判定 webview label 是否为浏览器 guest（nav_guard 豁免用）。
pub(crate) fn is_guest_label(label: &str) -> bool {
    label.starts_with(GUEST_LABEL_PREFIX)
}

/// 单个 guest 的可变状态快照（Rust 侧维护，推送至 client 镜像）。
#[derive(Clone, Debug)]
pub(crate) struct GuestState {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// 当前挂起加载的看门狗令牌（Started 时递增；超时且令牌未变判失败）。
    pub load_token: u64,
    pub load_started_at: Option<Instant>,
}

impl Default for GuestState {
    fn default() -> Self {
        Self {
            url: String::from("about:blank"),
            title: String::new(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            load_token: 0,
            load_started_at: None,
        }
    }
}

/// 注册表里的单个 guest 条目。
pub(crate) struct GuestEntry {
    /// guest 子 webview 的 label（browser-guest-<lease>）。
    pub label: String,
    /// dsh workspace 标识（partition 派生来源；保留供诊断日志）。
    #[allow(dead_code)]
    pub workspace: String,
    /// 宿主 webview 的 label（状态 eval 推送目标 = 发起 acquire 的 dsh 页面）。
    pub host_webview: String,
    pub state: Mutex<GuestState>,
}

/// 全局 guest 注册表（`.manage()` 挂载；与 DshState 分离，避免侵入其构造）。
pub(crate) struct GuestRegistry {
    guests: Mutex<HashMap<String, Arc<GuestEntry>>>,
    seq: AtomicU64,
}

impl GuestRegistry {
    pub(crate) fn new() -> Self {
        Self {
            guests: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
        }
    }

    fn next_lease(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // 进程内唯一即可（同窗口生命周期内租约不复用）
        format!("g{n:04x}{nanos:012x}")
    }

    pub(crate) fn get(&self, lease: &str) -> Option<Arc<GuestEntry>> {
        self.guests.lock().ok()?.get(lease).cloned()
    }

    pub(crate) fn remove(&self, lease: &str) -> Option<Arc<GuestEntry>> {
        self.guests.lock().ok()?.remove(lease)
    }
}

impl Default for GuestRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// dsh 桥契约的预约返回（acquire）：lease + partition（partition 仅回填到
/// `<webview>` 标签属性，dsh 不消费语义，Electron 风格字符串即可）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuestReservation {
    pub lease: String,
    pub partition: String,
}

/// 推送给 client 的快照（kind 决定 client 合成哪组 DOM 事件）。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuestSnapshot {
    pub lease: String,
    /// started | finished | failed | title | gone
    pub kind: &'static str,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// FNV-1a 64（无外部依赖的确定性哈希；workspace→存储标识用）。
fn fnv64(bytes: &[u8], seed: u64) -> u64 {
    let mut h = seed;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// workspace → macOS 14+ 的 WKWebsiteDataStore 标识（确定性，重启不变）。
pub(crate) fn workspace_store_id(workspace: &str) -> [u8; 16] {
    let a = fnv64(workspace.as_bytes(), 0xcbf29ce484222325);
    let b = fnv64(workspace.as_bytes(), a ^ 0x9e3779b97f4a7c15);
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&a.to_be_bytes());
    id[8..].copy_from_slice(&b.to_be_bytes());
    id
}

/// JSON 字面量 → JS 表达式安全化（U+2028/2029 会破坏 JS 字符串字面量）。
fn json_to_js_literal(json: &str) -> String {
    json.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

/// 向宿主 webview eval 推送一条 guest 状态快照。
fn push_snapshot(app: &AppHandle, entry: &GuestEntry, kind: &'static str) {
    let state = entry.state.lock().ok().map(|s| s.clone());
    let Some(state) = state else { return };
    let snapshot = GuestSnapshot {
        lease: entry.label.strip_prefix(GUEST_LABEL_PREFIX).unwrap_or(&entry.label).to_string(),
        kind,
        url: state.url,
        title: state.title,
        loading: state.loading,
        can_go_back: state.can_go_back,
        can_go_forward: state.can_go_forward,
    };
    let Ok(json) = serde_json::to_string(&snapshot) else { return };
    let js = format!(
        "window.__dshShellBridgeImpl&&window.__dshShellBridgeImpl._receive({})",
        json_to_js_literal(&json)
    );
    if let Some(host) = app.get_webview(&entry.host_webview) {
        if let Err(e) = host.eval(&js) {
            log::warn!("[browser-guest] 状态推送失败（{}）：{e}", entry.label);
        }
    }
}

/// guest 内新窗请求 → 转交 dsh（侧栏新标签），不在应用内开窗。
fn push_open_requested(app: &AppHandle, host_webview: &str, lease: &str, url: &str) {
    let payload = serde_json::json!({ "lease": lease, "url": url });
    let Ok(json) = serde_json::to_string(&payload) else { return };
    let js = format!(
        "window.__dshShellBridgeImpl&&window.__dshShellBridgeImpl._openRequested({})",
        json_to_js_literal(&json)
    );
    if let Some(host) = app.get_webview(host_webview) {
        let _ = host.eval(&js);
    }
}

/// 在主线程读取原生 canGoBack/canGoForward 并更新镜像后推送。
fn probe_history_and_push(app: &AppHandle, lease: &str) {
    let Some(entry) = app.state::<GuestRegistry>().get(lease) else { return };
    let label = entry.label.clone();
    let Some(w) = app.get_webview(&label) else { return };
    let app2 = app.clone();
    let lease2 = lease.to_string();
    let _ = w.with_webview(move |pv| {
        let (back, forward) = platform::native_read_history(&pv);
        let registry = app2.state::<GuestRegistry>();
        if let Some(entry) = registry.get(&lease2) {
            if let Ok(mut s) = entry.state.lock() {
                s.can_go_back = back;
                s.can_go_forward = forward;
            }
            // kind=title：只触发 client 重读镜像，不合成导航类事件
            push_snapshot(&app2, &entry, "title");
        }
    });
}

/// 加载失败看门狗：macOS WKWebView 的网络级失败不产生 wry Finished 回调
/// （didFailNavigation wry 未接线），超时兜底终止「正在打开…」状态。
fn arm_load_watchdog(app: &AppHandle, lease: &str) {
    let Some(entry) = app.state::<GuestRegistry>().get(lease) else { return };
    let token = entry
        .state
        .lock()
        .map(|mut s| {
            s.load_token += 1;
            s.load_token
        })
        .unwrap_or(0);
    let app2 = app.clone();
    let lease2 = lease.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let registry = app2.state::<GuestRegistry>();
        let Some(entry) = registry.get(&lease2) else { return };
        let mut s = match entry.state.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if s.loading && s.load_token == token {
            s.loading = false;
            s.load_started_at = None;
            drop(s);
            log::info!("[browser-guest] 加载超时判失败：{lease2}");
            push_snapshot(&app2, &entry, "failed");
        }
    });
}

// ── Tauri 命令 ─────────────────────────────────────────────

/// 创建一个浏览器 guest 子 webview（桥 acquire 的 Rust 侧）。
///
/// 在发起调用的 dsh 页面所在窗口上 `add_child`：多窗（multiwin）下 guest
/// 天然跟随宿主窗口。初始置于屏幕外 1px，待 client 绑定元素后 set_bounds。
#[tauri::command]
pub(crate) async fn browser_guest_acquire(
    app: AppHandle,
    webview: tauri::Webview,
    registry: tauri::State<'_, GuestRegistry>,
    workspace_key: String,
) -> Result<GuestReservation, String> {
    let _ = webview.window(); // 仅确认宿主窗口可解析
    let host_window = webview.window();
    let lease = registry.next_lease();
    let label = format!("{GUEST_LABEL_PREFIX}{lease}");
    let partition = format!("persist:ws-{:016x}", fnv64(workspace_key.as_bytes(), 0xcbf29ce484222325));

    let mut builder = tauri::webview::WebviewBuilder::new(
        &label,
        tauri::WebviewUrl::External(Url::parse("about:blank").map_err(|e| e.to_string())?),
    )
    .on_navigation(policy::guest_navigation_policy)
    // 后台 guest 不抢键盘焦点（默认 true 会把焦点从 dsh 页面夺走到屏幕外的 guest）
    .focused(false)
    .on_download(|_w, _event| {
        // 对齐官方：guest 内一律拒绝原生下载
        false
    });

    // 平台 partition：macOS 14+ 用独立 WKWebsiteDataStore；Windows 用独立
    // 用户数据目录（各自生效，互不干扰；macOS<14 由 wry 降级默认 store）
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(workspace_store_id(&workspace_key));
    }
    #[cfg(windows)]
    {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("browser-guests")
            .join(format!("{:016x}", fnv64(workspace_key.as_bytes(), 0xcbf29ce484222325)));
        builder = builder.data_directory(dir);
    }

    let app_open = app.clone();
    let lease_open = lease.clone();
    let host_label_open = webview.label().to_string();
    builder = builder.on_new_window(move |url, _features| {
        // 新窗 → 回交 dsh 在侧栏开新标签（官方行为），应用内不开窗
        push_open_requested(&app_open, &host_label_open, &lease_open, url.as_str());
        tauri::webview::NewWindowResponse::Deny
    });

    let app_load = app.clone();
    let lease_load = lease.clone();
    builder = builder.on_page_load(move |w, payload| {
        let lease = lease_load.clone();
        let registry = app_load.state::<GuestRegistry>();
        let Some(entry) = registry.get(&lease) else { return };
        match payload.event() {
            tauri::webview::PageLoadEvent::Started => {
                if let Ok(mut s) = entry.state.lock() {
                    s.loading = true;
                    s.load_started_at = Some(Instant::now());
                }
                push_snapshot(&app_load, &entry, "started");
                arm_load_watchdog(&app_load, &lease);
                let _ = w; // webview 未用（事件已由注册表定位）
            }
            tauri::webview::PageLoadEvent::Finished => {
                let finished_url = payload.url().to_string();
                if let Ok(mut s) = entry.state.lock() {
                    s.loading = false;
                    s.load_started_at = None;
                    s.url = finished_url;
                }
                push_snapshot(&app_load, &entry, "finished");
                // Finished 后异步补读原生 canGoBack/canGoForward（快照再推一次）
                probe_history_and_push(&app_load, &lease);
            }
        }
    });

    let app_title = app.clone();
    let lease_title = lease.clone();
    builder = builder.on_document_title_changed(move |_w, title| {
        let registry = app_title.state::<GuestRegistry>();
        if let Some(entry) = registry.get(&lease_title) {
            if let Ok(mut s) = entry.state.lock() {
                s.title = title;
            }
            push_snapshot(&app_title, &entry, "title");
        }
    });

    let created = host_window
        .add_child(
            builder,
            tauri::Position::Logical(tauri::LogicalPosition::new(-20000.0, -20000.0)),
            tauri::Size::Logical(tauri::LogicalSize::new(1.0, 1.0)),
        )
        .map_err(|e| format!("创建浏览器 guest 失败：{e}"))?;

    log::info!(
        "[browser-guest] acquire：lease={lease} workspace={workspace_key} label={}",
        created.label()
    );

    registry.guests.lock().unwrap().insert(
        lease.clone(),
        Arc::new(GuestEntry {
            label,
            workspace: workspace_key,
            host_webview: webview.label().to_string(),
            state: Mutex::new(GuestState::default()),
        }),
    );

    Ok(GuestReservation { lease, partition })
}

/// 释放一个 guest（桥 release 的 Rust 侧）：摘注册表 + 关闭子 webview。
#[tauri::command]
pub(crate) fn browser_guest_release(
    app: AppHandle,
    registry: tauri::State<'_, GuestRegistry>,
    lease: String,
) -> Result<(), String> {
    if let Some(entry) = registry.remove(&lease) {
        log::info!("[browser-guest] release：{lease}");
        if let Some(w) = app.get_webview(&entry.label) {
            let _ = w.close();
        }
    }
    Ok(())
}

/// guest 导航到指定 URL（webview 元素 loadURL 的 Rust 侧）。
#[tauri::command]
pub(crate) fn browser_guest_navigate(
    app: AppHandle,
    registry: tauri::State<'_, GuestRegistry>,
    lease: String,
    url: String,
) -> Result<(), String> {
    let entry = registry
        .get(&lease)
        .ok_or_else(|| format!("guest {lease} 不存在"))?;
    let target: Url = url
        .parse()
        .map_err(|e| format!("无效 URL：{e}"))?;
    if !matches!(target.scheme(), "http" | "https" | "about") {
        return Err(format!("guest 仅支持 http/https/about：{url}"));
    }
    let w = app
        .get_webview(&entry.label)
        .ok_or_else(|| format!("guest webview 不存在：{}", entry.label))?;
    w.navigate(target).map_err(|e| e.to_string())
}

/// guest 历史控制（goBack/goForward/reload）。
#[tauri::command]
pub(crate) fn browser_guest_control(
    app: AppHandle,
    registry: tauri::State<'_, GuestRegistry>,
    lease: String,
    action: String,
) -> Result<(), String> {
    let entry = registry
        .get(&lease)
        .ok_or_else(|| format!("guest {lease} 不存在"))?;
    let w = app
        .get_webview(&entry.label)
        .ok_or_else(|| format!("guest webview 不存在：{}", entry.label))?;
    match action.as_str() {
        "reload" => w.reload().map_err(|e| e.to_string()),
        "back" | "forward" => {
            let app2 = app.clone();
            let lease2 = lease.clone();
            let action2 = action.to_string();
            w.with_webview(move |pv| {
                platform::native_history_control(&pv, &action2);
                // 控制后立即补读一次历史状态（导航事件随后还会推 started/finished）
                probe_history_and_push(&app2, &lease2);
            })
            .map_err(|e| e.to_string())
        }
        other => Err(format!("未知控制动作：{other}")),
    }
}

/// 同步 guest 矩形（client ResizeObserver 驱动；CSS px = 窗口逻辑坐标）。
#[tauri::command]
pub(crate) fn browser_guest_set_bounds(
    app: AppHandle,
    registry: tauri::State<'_, GuestRegistry>,
    lease: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let entry = registry
        .get(&lease)
        .ok_or_else(|| format!("guest {lease} 不存在"))?;
    let w = app
        .get_webview(&entry.label)
        .ok_or_else(|| format!("guest webview 不存在：{}", entry.label))?;
    if !(width.is_finite() && height.is_finite() && x.is_finite() && y.is_finite()) {
        return Err("矩形坐标含非有限值".into());
    }
    w.set_bounds(tauri::Rect {
        position: tauri::Position::Logical(tauri::LogicalPosition::new(x.max(0.0), y.max(0.0))),
        size: tauri::Size::Logical(tauri::LogicalSize::new(width.max(1.0), height.max(1.0))),
    })
    .map_err(|e| e.to_string())
}

/// guest 显隐（rect 归零 / 弹层遮挡时隐藏；原生层永远在 dsh 内容之上）。
#[tauri::command]
pub(crate) fn browser_guest_set_visible(
    app: AppHandle,
    registry: tauri::State<'_, GuestRegistry>,
    lease: String,
    visible: bool,
) -> Result<(), String> {
    let entry = registry
        .get(&lease)
        .ok_or_else(|| format!("guest {lease} 不存在"))?;
    let w = app
        .get_webview(&entry.label)
        .ok_or_else(|| format!("guest webview 不存在：{}", entry.label))?;
    if visible {
        w.show().map_err(|e| e.to_string())
    } else {
        w.hide().map_err(|e| e.to_string())
    }
}

/// 拉取 guest 当前快照（client 绑定元素时初始化镜像用）。
#[tauri::command]
pub(crate) fn browser_guest_state(
    registry: tauri::State<'_, GuestRegistry>,
    lease: String,
) -> Result<GuestSnapshot, String> {
    let entry = registry
        .get(&lease)
        .ok_or_else(|| format!("guest {lease} 不存在"))?;
    let s = entry.state.lock().map_err(|e| e.to_string())?;
    Ok(GuestSnapshot {
        lease,
        kind: "state",
        url: s.url.clone(),
        title: s.title.clone(),
        loading: s.loading,
        can_go_back: s.can_go_back,
        can_go_forward: s.can_go_forward,
    })
}

// ── 载体 initialization_script ─────────────────────────────

/// 注入到宿主窗口的 dshDesktop 载体标记（document-start 运行，先于 dsh 插件）。
///
/// 仅本地 dsh 页面（loopback origin）安装：dsh 的 carrier 探测读取
/// `globalThis.dshDesktop`，存在且 protocolVersion===1 即选 guest 模式。
/// 方法体惰性转发到 `__dshShellBridgeImpl`（由壳 client 插件稍后安装——
/// dsh 只在用户首次打开浏览器标签时才调用桥方法，时序天然安全）。
/// 远程桌面窗口（非 loopback origin）不装载体，dsh 回落 iframe 模式（现状）。
pub(crate) const DESKTOP_CARRIER_INIT_SCRIPT: &str = r#"(function () {
  'use strict';
  var m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.exec(location.origin);
  if (!m || globalThis.dshDesktop) return;
  function impl() { return globalThis.__dshShellBridgeImpl; }
  // 宽限等待：client 插件（bridge 实现）在插件装载期可能尚未就绪；轮询至多 4s。
  // 升级期残留旧插件（壳新、页面 client 旧）时超时后干净报错而非立即炸。
  function whenReady(op, arg) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      (function tick() {
        var i = impl();
        if (i) { resolve(i[op](arg)); return; }
        if (waited >= 4000) { reject(new Error('bridge-not-ready')); return; }
        waited += 100;
        setTimeout(tick, 100);
      })();
    });
  }
  globalThis.dshDesktop = {
    protocolVersion: 1,
    browser: {
      acquire: function (workspace) { return whenReady('acquire', workspace); },
      release: function (lease) { return whenReady('release', lease); },
      onOpenRequested: function (lease, listener) {
        var i = impl();
        return i ? i.onOpenRequested(lease, listener) : function () {};
      }
    }
  };
})();
"#;

/// 释放指定宿主 webview 名下的全部 guest，返回释放数。
/// 双调用点：client pagehide 兑底（IPC 可能丢）+ 宿主页每次 Started 加载自愈
/// （dsh 重启/重导航后旧 guest 原生层会浮在新页面上，必须确定性清理）。
pub(crate) fn release_guests_of_host(app: &AppHandle, host_webview: &str) -> usize {
    let registry = app.state::<GuestRegistry>();
    let mut count = 0usize;
    let leases: Vec<String> = {
        let Ok(guests) = registry.guests.lock() else { return 0 };
        guests
            .iter()
            .filter(|(_, e)| e.host_webview == host_webview)
            .map(|(k, _)| k.clone())
            .collect()
    };
    for lease in leases {
        if let Some(entry) = registry.remove(&lease) {
            log::info!("[browser-guest] 宿主重载清理残留 guest：{lease}");
            if let Some(w) = app.get_webview(&entry.label) {
                let _ = w.close();
            }
            count += 1;
        }
    }
    count
}

/// 宿主窗口卸载/切换 profile 时兑底释放全部 guest（由 client pagehide 触发）。
#[tauri::command]
pub(crate) fn browser_guest_release_all(
    app: AppHandle,
    webview: tauri::Webview,
) -> Result<usize, String> {
    Ok(release_guests_of_host(&app, webview.label()))
}

// 静态断言：模块被 DshState 引用避免未用告警（state 字段未直接使用）
#[allow(unused)]
fn _assert_state_type(_: &DshState) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_store_id_is_deterministic_and_distinct() {
        let a = workspace_store_id("ws-default");
        let b = workspace_store_id("ws-default");
        let c = workspace_store_id("ws-other");
        assert_eq!(a, b, "同 workspace 必须得到同一存储标识（重启隔离不漂移）");
        assert_ne!(a, c, "不同 workspace 必须得到不同存储标识");
    }

    #[test]
    fn guest_label_prefix_matches() {
        assert!(is_guest_label("browser-guest-g0001"));
        assert!(!is_guest_label("main"));
        assert!(!is_guest_label("profile-web"));
        assert!(!is_guest_label("pet"));
    }

    #[test]
    fn json_literal_escapes_line_separators() {
        let out = json_to_js_literal("a\u{2028}b\u{2029}c");
        assert!(!out.contains('\u{2028}') && !out.contains('\u{2029}'));
    }
}
