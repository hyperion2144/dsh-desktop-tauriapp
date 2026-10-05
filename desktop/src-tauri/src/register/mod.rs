//! dsh 系统命令注册（图 #169 / 票 #175）：检测模型（三态）+ 托盘选项 + 异步缓存。
//!
//! 决策（#170）：注册物 = 壳维护的稳定 shim 入口 `app_data_dir/runtime/bin-dsh/dsh`
//! （unix）/ `dsh.cmd`（windows），随运行时版本切换自动跟随（#160 机制）；
//! 「已注册」= 用户真实 shell 环境解析 `dsh` 命中本壳 shim（考虑 PATH 顺序，
//! 而非注册物文件存在）；冲突 = 解析到别人的 dsh（提示 + 可选强制覆盖）。
//!
//! 事实依据：#173（macOS：GUI 进程环境 ≠ 终端环境，须 spawn 登录 shell 取解析；
//! `dscl UserShell` 权威、`-ilc` 全读 rc、DISABLE_AUTO_UPDATE 防卡、超时兜底、
//! realpath 比较）、#174（Windows：`where dsh` 首行即实际执行者；系统 PATH 在
//! 用户 PATH 之前，用户级前置赢不过系统 PATH）。
//!
//! 状态缓存走 static Mutex（tray.rs RUNTIME_CATALOG 同款先例）：菜单重建高频，
//! **绝不在菜单构建里同步 spawn shell**；检测异步执行，完成后仅在状态变化时重建菜单。
//! 执行链路（macOS 提权 symlink / Windows 用户级 PATH 注册表）由 #176/#177 接入，
//! 本票交付检测、展示、点击流程与执行入口（平台 `perform` 桩返回 `PendingExec`）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri::AppHandle;

use crate::runtime::state::DshState;
use crate::show_notification;

/// 检测 shell 的超时上限（秒）。VS Code shellEnv 同款 10s 上限先例（#173），取 8s。
pub(crate) const DETECT_TIMEOUT_SECS: u64 = 8;

/// 注册三态（#175 要点）：未注册（托盘显示选项）/ 已注册（隐藏）/ 冲突（显示，点击给强制覆盖）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RegistrationState {
    /// 用户真实环境解析 `dsh` 命中本壳 shim。
    Registered,
    /// 解析不到 `dsh`（干净机器），或 shim 尚未物化。
    NotRegistered,
    /// 解析到非本壳的 dsh（nvm / npm 全局 / 别名等）——记录解析目标供冲突流程展示。
    Conflict { path: String },
}

/// 注册执行结果：`Done` = 平台写入已完成；`PendingExec` = 执行链路待 #176/#177 接入。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplyOutcome {
    Done,
    PendingExec,
    /// 用户在提权密码框点了取消：中性结果，未对系统做任何更改。
    Canceled,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(any(target_os = "windows", test))]
mod pathlist; // PATH 列表纯逻辑：拆分/拼接/幂等插入/新终端解析模拟（平台中立，本机可测）

static CACHED: Mutex<Option<RegistrationState>> = Mutex::new(None);
static REFRESH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// 当前缓存的注册状态（菜单构建专用：零 shell 调用）。`None` = 尚未完成首次检测。
pub(crate) fn cached_state() -> Option<RegistrationState> {
    CACHED.lock().unwrap().clone()
}

/// 本壳 shim 的期望路径（app 数据目录 `runtime/bin-dsh/dsh[.cmd]`，#160 同位）。
pub(crate) fn shim_path(app: &AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .app_data_dir()
            .ok()?
            .join("runtime")
            .join("bin-dsh")
            .join(shim_file_name()),
    )
}

/// 本壳 shim 的期望文件名（unix `dsh` / windows `dsh.cmd`，#160 write_shim 同名规则）。
fn shim_file_name() -> &'static str {
    if cfg!(windows) {
        "dsh.cmd"
    } else {
        "dsh"
    }
}

/// 异步刷新注册状态缓存；完成后仅当状态变化才重建托盘菜单（防重建循环）。
/// 忙等防抖：同一时刻至多一个检测在跑（触发方只管轻量入队）。
pub(crate) fn refresh_async(app: AppHandle) {
    if REFRESH_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let app_for_detect = app.clone();
        let detected = tauri::async_runtime::spawn_blocking(move || {
            app_for_detect
                .path()
                .app_data_dir()
                .ok()
                .and_then(|dir| detect(&dir.join("runtime").join("bin-dsh").join(shim_file_name())))
        })
        .await
        .ok()
        .flatten();
        REFRESH_IN_FLIGHT.store(false, Ordering::SeqCst);
        let Some(new_state) = detected else {
            // 检测不确定（超时/失败）：保持旧缓存，不打扰菜单
            return;
        };
        let changed = {
            let mut guard = CACHED.lock().unwrap();
            let changed = guard.as_ref() != Some(&new_state);
            *guard = Some(new_state);
            changed
        };
        if changed {
            log::info!("[register] 注册状态变化，重建托盘菜单");
            crate::ui::tray::refresh_tray_mode(&app);
        }
    });
}

/// 检测入口：解析用户真实环境里的 `dsh`，与本壳 shim 比对得三态。
/// `None` = 检测不确定（超时/失败），调用方保持旧缓存。
pub(crate) fn detect(shim: &Path) -> Option<RegistrationState> {
    let resolved = platform_resolve()?;
    Some(classify(shim, resolved))
}

fn platform_resolve() -> Option<Option<PathBuf>> {
    #[cfg(target_os = "macos")]
    {
        return macos::resolve();
    }
    #[cfg(target_os = "windows")]
    {
        return windows::resolve();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// 三态判定：解析不到 → 未注册；shim 未物化 → 未注册（连本壳入口都没有，
/// 无论解析到谁都谈不上「已注册」）；命中本壳 → 已注册；其余 → 冲突并记录解析目标。
fn classify(shim: &Path, resolved: Option<PathBuf>) -> RegistrationState {
    let Some(p) = resolved else {
        return RegistrationState::NotRegistered;
    };
    if !shim.exists() {
        return RegistrationState::NotRegistered;
    }
    if path_eq(&p, shim) {
        RegistrationState::Registered
    } else {
        RegistrationState::Conflict {
            path: p.to_string_lossy().into_owned(),
        }
    }
}

/// 路径相等：先按字面（canonicalize 失败的兜底），再按 realpath（#173：shim 可能被
/// 符号路径指到）；Windows 大小写不敏感。
fn path_eq(a: &Path, b: &Path) -> bool {
    let canon = |x: &Path| std::fs::canonicalize(x).unwrap_or_else(|_| x.to_path_buf());
    let (ca, cb) = (canon(a), canon(b));
    if cfg!(windows) {
        ca.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&cb.as_os_str().to_string_lossy())
    } else {
        ca == cb
    }
}

/// 托盘菜单项（#175）：仅未注册/冲突时显示；已注册或缓存未就绪时隐藏（`None`）。
pub(crate) fn tray_item(
    app: &AppHandle,
) -> tauri::Result<Option<tauri::menu::MenuItem<tauri::Wry>>> {
    let Some(state) = cached_state() else {
        return Ok(None);
    };
    let label = match &state {
        RegistrationState::Registered => return Ok(None),
        RegistrationState::NotRegistered => "注册 dsh 为系统命令".to_string(),
        RegistrationState::Conflict { .. } => "注册 dsh 为系统命令（检测到冲突）".to_string(),
    };
    Ok(Some(tauri::menu::MenuItem::with_id(
        app,
        "register-dsh-cli",
        &label,
        true,
        None::<&str>,
    )?))
}

/// 托盘点击（#175 流程）：未注册 → 直接进入注册流程（系统授权弹窗即确认）；
/// 冲突 → 弹确认框展示解析目标，用户可选强制覆盖（决策 #170 / Q3+Q8）。
pub(crate) fn handle_menu_click(app: &AppHandle) {
    let Some(state) = cached_state() else {
        return;
    };
    match state {
        RegistrationState::Registered => {} // 选项已注册态不该出现；兜底忽略
        RegistrationState::NotRegistered => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                run_registration(&app, false).await;
            });
        }
        RegistrationState::Conflict { path } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let body = format!(
                    "用户环境中解析到的 dsh：\n{path}\n\n强制覆盖会以本壳 dsh 接管该命令入口\n（macOS：原入口改名备份并需管理员授权；Windows：本壳目录前置到用户 PATH）。\n继续吗？"
                );
                if confirm_modal(&app, "dsh-cli-register-force", "检测到 dsh 命令冲突", &body)
                    .await
                    .is_some()
                {
                    run_registration(&app, true).await;
                }
            });
        }
    }
}

/// 注册动作：先以新鲜检测结果核对（缓存可能过期），再分派平台执行，最后刷新缓存与菜单。
async fn run_registration(app: &AppHandle, force: bool) {
    let Some(shim) = shim_path(app) else {
        show_notification(
            app,
            crate::network::notify_policy::scenario::CONFIG_ERROR,
            "无法注册 dsh 系统命令",
            "拿不到应用数据目录",
        );
        return;
    };
    // 新鲜核对：缓存可能滞后（用户在终端手动动过）。检测不确定（None）时继续执行，
    // 平台 perform（#176/#177）落地时会再做权威核对。
    let fresh = tauri::async_runtime::spawn_blocking({
        let shim = shim.clone();
        move || detect(&shim)
    })
    .await
    .ok()
    .flatten();
    if fresh == Some(RegistrationState::Registered) {
        show_notification(
            app,
            crate::network::notify_policy::scenario::CONFIG_INFO,
            "dsh 已注册为系统命令",
            "无需重复操作",
        );
        refresh_async(app.clone());
        return;
    }
    let app_for_exec = app.clone();
    let outcome =
        tauri::async_runtime::spawn_blocking(move || exec::perform(&app_for_exec, force)).await;
    match outcome {
        Ok(Ok(ApplyOutcome::Done)) => {
            // 事实（#173/#174）：rc / 环境块只对新开会话生效——通知里明说
            show_notification(
                app,
                crate::network::notify_policy::scenario::CONFIG_INFO,
                "dsh 已注册为系统命令",
                "新开终端即可使用 dsh；已开终端不受影响，重开才生效",
            );
        }
        Ok(Ok(ApplyOutcome::Canceled)) => {
            // 决策 #170/Q11：取消授权 = 中止、视为未注册、通知说明，选项保留可重试
            show_notification(
                app,
                crate::network::notify_policy::scenario::CONFIG_INFO,
                "已取消授权",
                "未对系统做任何更改；可随时从托盘重试注册",
            );
        }
        Ok(Ok(ApplyOutcome::PendingExec)) => {
            // 执行链路由 #176（macOS 提权 symlink + shell rc 修正）/ #177（Windows 用户级 PATH）接入
            show_notification(
                app,
                crate::network::notify_policy::scenario::CONFIG_INFO,
                "注册请求已就绪",
                "检测与入口已就绪：系统写入链路由后续提交接入（#176/#177）",
            );
        }
        Ok(Err(e)) => {
            show_notification(
                app,
                crate::network::notify_policy::scenario::CONFIG_ERROR,
                "注册 dsh 系统命令失败",
                &e,
            );
        }
        Err(e) => {
            show_notification(
                app,
                crate::network::notify_policy::scenario::CONFIG_ERROR,
                "注册任务执行失败",
                &e.to_string(),
            );
        }
    }
    refresh_async(app.clone());
}

/// 平台执行分派：macOS / Windows 各自实现（本票为桩，返回 `PendingExec`）。
mod exec {
    use super::ApplyOutcome;
    use tauri::AppHandle;

    pub(crate) fn perform(app: &AppHandle, force: bool) -> Result<ApplyOutcome, String> {
        #[cfg(target_os = "macos")]
        {
            return super::macos::perform(app, force);
        }
        #[cfg(target_os = "windows")]
        {
            return super::windows::perform(app, force);
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, force);
            Err("当前平台不支持注册 dsh 系统命令".into())
        }
    }
}

/// 冲突强制覆盖确认弹窗（复用 pending_input 单槽通道 + `ui_input_confirm` 回填，
/// 与 commands.rs 的 prompt_input 同款基建；确认返回 `Some(())`，取消/超时 `None`）。
async fn confirm_modal(app: &AppHandle, flow: &str, title: &str, body: &str) -> Option<()> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
    *app.state::<DshState>().pending_input.lock().unwrap() = Some(tx);
    let js = confirm_modal_js(flow, title, body);
    let Some(w) = app.get_webview_window("main") else {
        log::warn!("[register] 主窗口不存在，冲突确认弹窗无法注入：{flow}");
        app.state::<DshState>().pending_input.lock().unwrap().take();
        return None;
    };
    // 托盘触发时主窗口可能在后台：先置前聚焦，否则弹窗注入了也看不见（#90 实测）
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    if w.eval(&js).is_err() {
        log::warn!("[register] 冲突确认弹窗注入失败：{flow}");
        app.state::<DshState>().pending_input.lock().unwrap().take();
        return None;
    }
    match tokio::time::timeout(Duration::from_secs(180), rx.recv()).await {
        Ok(Some((f, v))) if f == flow && v == "force" => Some(()),
        _ => {
            app.state::<DshState>().pending_input.lock().unwrap().take();
            None
        }
    }
}

/// 构造确认弹窗 JS（自带样式/ESC 取消；「仍要注册」回填 "force"，取消回填空串）。
/// 样式对齐 commands.rs input_modal（同一套 --dsw-* 主题变量）。
fn confirm_modal_js(flow: &str, title: &str, body: &str) -> String {
    let (flow, title, body) = (
        serde_json::to_string(flow).unwrap_or_default(),
        serde_json::to_string(title).unwrap_or_default(),
        serde_json::to_string(body).unwrap_or_default(),
    );
    format!(
        r#"(function(){{
  var key = 'dshDesktopConfirmModal';
  var old = document.getElementById(key);
  if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = key;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--dsw-alias-bg-layer-1,#1e1e1e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;padding:18px 20px;min-width:360px;max-width:80vw;box-shadow:0 12px 40px rgba(0,0,0,0.4);color:var(--dsw-alias-label-primary,#eee);';
  var titleEl = document.createElement('div');
  titleEl.textContent = {title};
  titleEl.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;';
  var bodyEl = document.createElement('div');
  bodyEl.textContent = {body};
  bodyEl.style.cssText = 'font-size:12.5px;line-height:1.6;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#bbb);word-break:break-all;';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
  var cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:13px;cursor:default;';
  var ok = document.createElement('button');
  ok.textContent = '仍要注册（覆盖）';
  ok.style.cssText = 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-state-accent-primary,#3b82f6);color:#fff;font-size:13px;cursor:default;';
  function submit(value) {{
    try {{
      var t = window.__TAURI_INTERNALS__ || (window.__TAURI__ && window.__TAURI__.core);
      if (t && t.invoke) t.invoke('ui_input_confirm', {{ flow: {flow}, value: value }}).catch(function(){{}});
    }} catch (e) {{}}
    overlay.remove();
  }}
  cancel.addEventListener('click', function() {{ submit(''); }});
  ok.addEventListener('click', function() {{ submit('force'); }});
  overlay.addEventListener('click', function(e) {{ if (e.target === overlay) submit(''); }});
  document.addEventListener('keydown', function h(e) {{
    if (e.key === 'Escape') {{ document.removeEventListener('keydown', h); submit(''); }}
  }});
  row.appendChild(cancel);
  row.appendChild(ok);
  card.appendChild(titleEl);
  card.appendChild(bodyEl);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}})()"#
    )
}

/// 带超时的子进程执行（阻塞线程上调用）。超时 → kill 并返回 `None`（检测不确定）。
/// 管道在进程退出后统一收尾；`-ilc` 输出量级为 rc 横幅 + 单行结果，无塞满管道之虞。
pub(crate) fn run_with_timeout(
    cmd: &mut std::process::Command,
    secs: u64,
) -> Option<std::process::Output> {
    use std::io::Read as _;
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= Duration::from_secs(secs) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return None,
        }
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_end(&mut stdout);
    }
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_end(&mut stderr);
    }
    Some(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// 去 ANSI 转义序列（rc 输出可能带颜色码；`command -v` 的结果行按裸路径比对）。
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 取最后一条非空行（macOS `-ilc` 的 rc 横幅在前，结果在末尾，#173）。
fn extract_last_nonempty_line(s: &str) -> Option<&str> {
    s.lines().rev().find(|l| !l.trim().is_empty())
}

/// 取第一条非空行（Windows `where` 首行即实际执行者，#174 #15）。
fn extract_first_nonempty_line(s: &str) -> Option<&str> {
    s.lines().find(|l| !l.trim().is_empty())
}

/// 解析 `dscl . -read /Users/<u> UserShell` 输出（#173：GUI 进程 `$SHELL` 不可靠）。
fn parse_user_shell(dscl_stdout: &str) -> Option<String> {
    dscl_stdout
        .lines()
        .find_map(|l| l.strip_prefix("UserShell: "))
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_color_codes_keeps_plain_text() {
        assert_eq!(strip_ansi("\u{1b}[32m/usr/local/bin/dsh\u{1b}[0m"), "/usr/local/bin/dsh");
        assert_eq!(strip_ansi("/plain/path"), "/plain/path");
        assert_eq!(strip_ansi(""), "");
    }

    #[test]
    fn extract_lines_pick_right_end() {
        assert_eq!(
            extract_last_nonempty_line("\n\n/usr/local/bin/dsh\n"),
            Some("/usr/local/bin/dsh")
        );
        assert_eq!(
            extract_first_nonempty_line("  \nlast login banner\nC:\\x\\dsh.cmd\n"),
            Some("last login banner")
        );
        assert_eq!(extract_last_nonempty_line("   \n  \n"), None);
    }

    #[test]
    fn parse_user_shell_from_dscl_output() {
        assert_eq!(parse_user_shell("UserShell: /bin/zsh\n"), Some("/bin/zsh".to_string()));
        assert_eq!(
            parse_user_shell("gid: 20\nUserShell: /bin/bash\n"),
            Some("/bin/bash".to_string())
        );
        assert_eq!(parse_user_shell("no match here"), None);
        // 非路径值不采纳（回落 $SHELL / /bin/zsh 由调用方兜底）
        assert_eq!(parse_user_shell("UserShell: nologin"), None);
    }

    #[test]
    fn classify_three_states() {
        let dir = std::env::temp_dir().join(format!("dsh-register-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("dsh");
        std::fs::write(&shim, b"#!/bin/sh\n").unwrap();

        // 解析不到 → 未注册
        assert_eq!(classify(&shim, None), RegistrationState::NotRegistered);
        // 解析 = 本壳（真实文件，canonicalize 成立）→ 已注册
        assert_eq!(classify(&shim, Some(shim.clone())), RegistrationState::Registered);
        // 解析 = 别人 → 冲突并记录解析目标
        match classify(&shim, Some(PathBuf::from("/somewhere/else/dsh"))) {
            RegistrationState::Conflict { path } => assert_eq!(path, "/somewhere/else/dsh"),
            other => panic!("期望 Conflict，得到 {other:?}"),
        }
        // shim 未物化（从未以内置/下载运行时 spawn 过）→ 一律未注册
        let ghost = dir.join("missing");
        assert_eq!(classify(&ghost, Some(ghost.clone())), RegistrationState::NotRegistered);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn classify_symlinked_shim_counts_as_registered() {
        let dir = std::env::temp_dir().join(format!("dsh-register-sym-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real-dsh");
        let link = dir.join("link-dsh");
        std::fs::write(&real, b"#!/bin/sh\n").unwrap();
        #[allow(unused_imports)]
        use std::os::unix::fs::symlink;
        symlink(&real, &link).unwrap();
        // 用户 PATH 里的入口是个符号链接，指向本壳 shim → 已注册（#173 realpath 语义）
        assert_eq!(classify(&real, Some(link.clone())), RegistrationState::Registered);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
