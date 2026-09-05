//! DeepSeek Harness 桌面壳核心逻辑。
//!
//! 职责：
//! 1. 启动时探测本地 dsh 服务（默认 127.0.0.1:3080，`DSH_DESKTOP_PORT` 可覆盖）：
//!    已监听则复用现有实例并「降级接入」（不带 advanced 标记，系统原生标题栏）；
//!    空闲/高级模式则由本应用 spawn 实例，桌面插件在原生布局内注入局部拖拽区
//!    （不禁用 stock ui-layout；macOS 侧栏顶部拖拽 + 折叠加宽，Win/Linux 中间 header 顶部拖拽 + 自绘按钮）；
//! 2. 轮询服务就绪后把主窗口从 loading 页导航到 Web GUI；
//! 3. 托盘常驻：关闭窗口仅隐藏，托盘菜单可显示/退出；
//! 4. 应用退出时回收本次启动的子进程，复用已有实例时不动它。

use std::{
    io::{BufRead, BufReader},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU8, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_notification::NotificationExt;

/// 桌面壳专属设置：持久化于 $DSH_HOME/settings.yaml 的 `dsh-desktop-tauriapp:` 顶层键下。
/// 只读写该键，文件其余内容（dsh 自身设置等）一律原样保留；原子写；解析失败先备份。
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(default)]
struct DesktopSettings {
    /// 本地 dsh web 端口（默认 3080；DSH_DESKTOP_PORT 环境变量优先级更高）。
    port: Option<u16>,
    /// 激活 profile（spawn 时 `dsh --profile <name>`）。
    active_profile: Option<String>,
    /// 当前远程 dsh 地址（None=本地）。
    remote_addr: Option<String>,
    /// 已保存的远程地址列表（host[:port]）。
    remote_list: Vec<String>,
    /// 手机访问 lane（改写反代）端口（默认 3091；DSH_MOBILE_LANE_PORT 环境变量优先级更高）。
    lane_port: Option<u16>,
    /// cloudflared 可执行文件路径（设置后手机访问自动启动公网隧道；空=不启用）。
    cloudflared_bin: Option<String>,
}

fn settings_path() -> PathBuf {
    dsh_home().join("settings.yaml")
}

/// 读取桌面壳设置（文件缺失或 `dsh-desktop-tauriapp:` 键缺失 → 默认值；解析失败 → 默认值）。
fn load_desktop_settings() -> DesktopSettings {
    let path = settings_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return DesktopSettings::default();
    };
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&text) else {
        return DesktopSettings::default();
    };
    let selected = value
        .get("dsh-desktop-tauriapp")
        .or_else(|| legacy_desktop_block(&value))
        .cloned()
        .unwrap_or(serde_yaml::Value::Null);
    from_yaml_value(selected).unwrap_or_default()
}

/// 把 YAML Value 反序列化为桌面壳设置（映射缺失字段给默认）。
fn from_yaml_value(v: serde_yaml::Value) -> Option<DesktopSettings> {
    serde_yaml::from_value(v).ok()
}

/// 兼容上一版 bug 写入的 `desktop:` 块：仅当它长得像我们的 schema（含
/// port/active_profile/remote_addr/remote_list 任一键）时才认领，不影响第三方键。
fn legacy_desktop_block(value: &serde_yaml::Value) -> Option<&serde_yaml::Value> {
    let block = value.get("desktop")?;
    let map = block.as_mapping()?;
    const OUR_KEYS: [&str; 6] = [
        "port",
        "active_profile",
        "remote_addr",
        "remote_list",
        "lane_port",
        "cloudflared_bin",
    ];
    if OUR_KEYS
        .iter()
        .any(|k| map.contains_key(serde_yaml::Value::String((*k).to_string())))
    {
        Some(block)
    } else {
        None
    }
}

/// 保存桌面壳设置：与现有 settings.yaml 合并（只写 `dsh-desktop-tauriapp:` 键），原子写；
/// 解析失败时先备份原文件，再以仅含 `dsh-desktop-tauriapp:` 的新文档落盘，绝不丢用户内容。
fn save_desktop_settings(settings: &DesktopSettings) {
    let path = settings_path();
    let mut root: serde_yaml::Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_yaml::from_str(&text).unwrap_or_else(|_| {
            let _ = std::fs::copy(&path, path.with_extension("yaml.bak"));
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
        }),
        Err(_) => serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
    };
    if let Some(map) = root.as_mapping_mut() {
        map.insert(
            serde_yaml::Value::String("dsh-desktop-tauriapp".into()),
            serde_yaml::to_value(settings).unwrap_or(serde_yaml::Value::Null),
        );
        // 迁移清理：删掉上一版 bug 遗留的 `desktop:` 块（仅 schema 匹配时）
        if let Some(legacy) = map.get(&serde_yaml::Value::String("desktop".into())) {
            if legacy_desktop_block(&serde_yaml::Value::Mapping(
                [(serde_yaml::Value::String("desktop".into()), legacy.clone())]
                    .into_iter()
                    .collect(),
            ))
            .is_some()
            {
                map.remove(&serde_yaml::Value::String("desktop".into()));
                log::info!("settings.yaml 已把遗留 desktop: 块迁移到 dsh-desktop-tauriapp:");
            }
        }
    }
    let out = serde_yaml::to_string(&root).unwrap_or_default();
    let tmp = path.with_extension("yaml.tmp");
    if std::fs::write(&tmp, &out).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// 本地 dsh 端口：DSH_DESKTOP_PORT 环境变量 > settings.yaml desktop.port > 3080。
fn configured_port() -> u16 {
    std::env::var("DSH_DESKTOP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or_else(|| load_desktop_settings().port)
        .unwrap_or(3080)
}

/// 激活 profile（settings.yaml desktop.active_profile，非法值回退 web）。
fn configured_profile() -> String {
    load_desktop_settings()
        .active_profile
        .filter(|s| !s.is_empty() && !s.contains(['/', '\\', '\0']))
        .unwrap_or_else(|| "web".to_string())
}

/// 手机访问 lane 端口：DSH_MOBILE_LANE_PORT 环境变量 > settings.yaml lane_port > 3091。
fn configured_lane_port() -> u16 {
    std::env::var("DSH_MOBILE_LANE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or_else(|| load_desktop_settings().lane_port)
        .unwrap_or(3091)
}

/// cloudflared 可执行文件路径（settings.yaml cloudflared_bin；空=不启用公网隧道）。
fn configured_cloudflared_bin() -> String {
    load_desktop_settings().cloudflared_bin.unwrap_or_default()
}

/// dsh 服务端口（= configured_port）。端口策略：
/// 已有 dsh web → 复用并降级接入；空闲/高级 → 由本应用 spawn 实例并注入桌面 chrome。
/// 注意：同一 profile 只允许一个 dsh web 实例并发（task-board 等插件持有排它锁），
/// 因此不要用独立端口再起第二实例。
fn app_port() -> u16 {
    configured_port()
}

/// 等待服务就绪的超时时间。
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// 从 nvm 版本目录名（如 v22.12.0）解析可比较的版本键；无法解析的返回 (0,0,0)。
/// 注意：目录名必须按 semver 比较排序，字符串排序会把 v9.11.0 排在 v22.12.0 之后。
fn version_key(path: &std::path::Path) -> (u64, u64, u64) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parts: Vec<u64> = name
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    (
        parts.first().copied().unwrap_or(0),
        parts.get(1).copied().unwrap_or(0),
        parts.get(2).copied().unwrap_or(0),
    )
}

/// spawn dsh 的失败原因：NotFound 供错误页提示"未找到"，其余归为其它失败。
enum SpawnError {
    NotFound(String),
    Other(String),
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::NotFound(m) | SpawnError::Other(m) => f.write_str(m),
        }
    }
}

/// 桌面接入模式。
const MODE_ADVANCED: u8 = 0;
const MODE_COMPAT: u8 = 1;

/// dsh 服务状态（侧边栏标识与守护器共用，经 `dsh-status` 事件广播）。
const STATUS_IDLE: u8 = 0;
const STATUS_STARTING: u8 = 1;
const STATUS_READY: u8 = 2;
const STATUS_EXTERNAL: u8 = 3;
const STATUS_RESTARTING: u8 = 4;
const STATUS_STALE: u8 = 5;
const STATUS_DOWN: u8 = 6;
const STATUS_REMOTE: u8 = 7;

/// 桌面壳的共享运行时状态。
struct DshState {
    /// 本次运行 spawn 的 dsh 子进程（None = 复用了已有实例）。
    child: Mutex<Option<Child>>,
    /// 子进程是否由本次启动启动（决定退出时是否回收、重启时是否生效）。
    spawned_this_run: AtomicBool,
    /// 启动时端口已被外部 dsh web 占用（复用外部实例）：需要在加载页选择
    /// 兼容（复用、标准布局）或高级（停用外部实例、用桌面 overlay 实例重启）。
    mode_prompt_needed: AtomicBool,
    /// 当前接入模式（MODE_ADVANCED / MODE_COMPAT）。
    mode: AtomicU8,
    /// dsh 服务状态（STATUS_*）。
    status: AtomicU8,
    /// 内嵌启动加载页 URL（setup 抓取，重启/切换模式时回到该页）。
    loading_url: Mutex<Option<String>>,
    /// 托盘实例（供模式切换/重启后刷新「切换模式」标签用）。
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    /// spawn 失败标志（立即终止等待并跳错误页）。
    spawn_failed: AtomicBool,
    /// 重启流程进行中（防止重复点击托盘重启项导致并发 kill/spawn）。
    restarting: AtomicBool,
    /// 是否已至少完成一次就绪导航（守护器只在就绪后介入）。
    ready_once: AtomicBool,
    /// 输入弹窗的确认通道（prompt_input 挂起，页面 ui_input_confirm 回填）。
    pending_input: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(String, String)>>>,
    /// 托盘"退出"标志（置位后放行窗口关闭与应用退出）。
    quitting: AtomicBool,
    /// 是否已提示过"隐藏到托盘"。
    tray_tip_shown: AtomicBool,
    /// 未读任务完成数（Dock 角标）。
    unread: AtomicU32,
    /// 桌宠上次落盘位置的时间（Moved 事件 400ms 防抖）。
    pet_save_at: Mutex<Option<Instant>>,
    /// 任务通知服务器端口（重启 dsh 后复用同一端口重新注入 JS）。
    notify_port: AtomicU16,
    /// 任务通知服务器访问 token（仅启动时生成一次，重启复用）。
    notify_token: Mutex<String>,
    /// dsh web 启动 URL 里的一次性 process token（stdout 解析；空 = 老版 dsh 未打印）。
    /// dsh 新版对不带 token 的请求返回 401；token 经 303 + Set-Cookie 换取 30 天会话
    /// cookie，进程存活期内可重复交换。仅内存保存，不落盘。
    web_token: Mutex<String>,
    /// 双击拖拽区"缩放"前的主窗口几何（None = 当前处于标准尺寸，可触发放大；
    /// Some = 当前已放大，再双击恢复到此几何）。Mutex 防并发双击。
    pre_zoom_geom: Mutex<Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>>,
}

/// 运行时放行的远程 dsh 主机清单（托盘「dsh 服务地址」选择后写入，导航守卫读取）。
static INTERNAL_HOSTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// 设置并广播 dsh 服务状态（写 DshState + emit `dsh-status` 事件）。
fn set_status(app: &AppHandle, status: u8, detail: &str) {
    app.state::<DshState>().status.store(status, Ordering::SeqCst);
    let _ = app.emit(
        "dsh-status",
        serde_json::json!({ "status": status, "detail": detail }),
    );
}

/// 定位 dsh 可执行文件。
///
/// Finder 启动的 GUI 应用 PATH 里没有终端配置（nvm bin、npm 全局 bin 都不在），
/// 所以除 PATH 外还要探测常见安装位置。
#[cfg(unix)]
fn find_dsh_bin() -> Option<PathBuf> {
    // 1. 显式覆盖：DSH_BIN 环境变量
    if let Ok(p) = std::env::var("DSH_BIN") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            log::info!("使用 DSH_BIN 指定的 dsh：{}", pb.display());
            return Some(pb);
        }
        log::warn!("DSH_BIN 指向的文件不存在：{}", pb.display());
    }
    // 2. PATH（终端启动 / tauri dev 场景）
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let pb = dir.join("dsh");
            if pb.is_file() {
                log::info!("在 PATH 中找到 dsh：{}", pb.display());
                return Some(pb);
            }
        }
    }
    // 3. 常见安装位置
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/dsh"),
        PathBuf::from("/usr/local/bin/dsh"),
        PathBuf::from(&home).join(".npm-global/bin/dsh"),
    ];
    // 3a. nvm 管理的 node（按 semver 取版本号最高的目录）
    let nvm_root = PathBuf::from(&home).join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort_by_key(|d| version_key(d));
        for d in dirs.iter().rev() {
            candidates.push(d.join("bin/dsh"));
        }
    }
    // 3b. npx 缓存（取修改时间最新的目录，防缓存漂移）
    let npx_root = PathBuf::from(&home).join(".npm/_npx");
    if let Ok(entries) = std::fs::read_dir(&npx_root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
        for d in dirs.iter().rev() {
            candidates.push(d.join("node_modules/.bin/dsh"));
        }
    }
    candidates.into_iter().find(|p| {
        if p.is_file() {
            log::info!("找到 dsh：{}", p.display());
            true
        } else {
            false
        }
    })
}

/// 探测 127.0.0.1:port 是否已有服务在监听。
fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// 返回当前监听 `port` 的进程 PID 列表（跨平台，纯代码）。
/// 使用 netstat2：内部走各平台系统原生 API（macOS libproc、Linux /proc、
/// Windows GetExtendedTcpTable），不产生任何子进程、不依赖 PATH 里的外部工具
/// （lsof/ss/netstat 等可能未安装，一律不再使用）。
fn listener_pids(port: u16) -> Vec<u32> {
    use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
    let mut pids = Vec::new();
    let Ok(sockets) = get_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP,
    ) else {
        return pids;
    };
    for si in sockets {
        if let ProtocolSocketInfo::Tcp(tcp) = &si.protocol_socket_info {
            if tcp.local_port == port && tcp.state == TcpState::Listen {
                pids.extend(si.associated_pids.iter().copied());
            }
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// 停掉监听 `port` 的所有进程并等待端口释放（尽力而为，返回端口是否已释放）。
/// 纯代码：先 SIGTERM（Windows TerminateProcess）让其优雅退出，~2.4s 内没释放再
/// SIGKILL（Windows 幂等再 TerminateProcess 一次）。调用方据此决定是否中止。
async fn stop_port_owner(port: u16) -> bool {
    let mut seen: Vec<u32> = Vec::new();
    for _ in 0..6 {
        let mut pids = listener_pids(port);
        pids.retain(|p| !seen.contains(p));
        if pids.is_empty() {
            // 没有枚举到任何监听者：回到探测本身判定端口是否已空闲
            return !port_open(port);
        }
        for pid in &pids {
            kill_process(*pid);
        }
        seen.extend(pids);
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if !port_open(port) {
                return true;
            }
        }
    }
    // 优雅退出超时：强杀
    for pid in &seen {
        kill_process_force(*pid);
    }
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if !port_open(port) {
            return true;
        }
    }
    !port_open(port)
}

#[cfg(not(target_os = "windows"))]
fn kill_process(pid: u32) {
    // SIGTERM：dsh web 通常可优雅退出
    let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
}

#[cfg(not(target_os = "windows"))]
fn kill_process_force(pid: u32) {
    let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
}

#[cfg(target_os = "windows")]
fn kill_process(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            let _ = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(target_os = "windows")]
fn kill_process_force(pid: u32) {
    kill_process(pid)
}

/// 构造 spawn dsh 时的运行时 PATH。
///
/// Finder 启动的 GUI 应用 PATH 只有 `/usr/bin:/bin`，而 dsh 是 Node 脚本
/// （shebang 依赖 `node`）。把 dsh 所在目录、nvm 各版本 bin、Homebrew 等
/// 候选目录补充到子进程 PATH 前面。
#[cfg(unix)]
fn dsh_runtime_path(bin: &std::path::Path) -> std::ffi::OsString {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(parent) = bin.parent() {
        paths.push(parent.to_path_buf());
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let nvm_root = PathBuf::from(&home).join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort_by_key(|d| version_key(d));
        for d in dirs.iter().rev() {
            paths.push(d.join("bin"));
        }
    }
    for p in ["/opt/homebrew/bin", "/usr/local/bin"] {
        paths.push(PathBuf::from(p));
    }
    paths.push(PathBuf::from(&home).join(".npm-global/bin"));
    // rustup 的 cargo/rustc：终端启动的 dsh 有，GUI 启动的 dsh 子进程没有
    paths.push(PathBuf::from(&home).join(".cargo/bin"));
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| std::ffi::OsString::from("/usr/bin:/bin"))
}

/// spawn `dsh web --host 127.0.0.1 --port <port>`；stdout/stderr 转发到日志，
/// 并实时 emit 到启动加载页的「本地服务输出」控制台（`dsh-console` 事件）。
#[cfg(unix)]
fn spawn_dsh(app: &tauri::AppHandle, port: u16, _advanced: bool) -> Result<Child, SpawnError> {
    let bin = find_dsh_bin().ok_or_else(|| {
        SpawnError::NotFound(
            "未找到 dsh 命令。请执行 `npm i -g @deepseek-ai/dsh` 或设置 DSH_BIN 环境变量。"
                .to_string(),
        )
    })?;
    let mut cmd = Command::new(&bin);
    // 统一用 `dsh --profile web ...`（等价于 `dsh web`）。桌面插件经 --patch 注入
    //（包名行，实体在共享模块池），不禁用 stock ui-layout；仅当设置
    // DSH_DESKTOP_EXTRA_PATCH 调试环境变量时再叠加一个调试 overlay。
    let profile = configured_profile();
    log::info!("[spawn] 启动 dsh（profile={profile}, port={port}）");
    let mut launcher_args: Vec<std::ffi::OsString> =
        vec!["--profile".into(), profile.into()];
    // 桌面插件经 --patch 注入（包名行，实体在共享模块池，不写 profile bundles）。
    // 注意顺序：--patch 必须早于 --no-open/--host —— dsh CLI 用 passThrough 解析，
    // 靠后的 --patch 会被透传给 web-app 而报 unknown option '--patch'。
    launcher_args.push("--patch".into());
    launcher_args.push(desktop_plugin_patch_path(app).into_os_string());
    if let Ok(patch) = std::env::var("DSH_DESKTOP_EXTRA_PATCH") {
        if !patch.trim().is_empty() {
            launcher_args.push("--patch".into());
            launcher_args.push(patch.into());
        }
    }
    // --no-open：dsh 升级后默认打开系统浏览器，桌面壳自行导航故关闭
    launcher_args.extend([
        "--no-open".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string().into(),
    ]);
    cmd.args(&launcher_args)
        .env("PATH", dsh_runtime_path(&bin))
        .env("DSH_MOBILE_LANE_PORT", configured_lane_port().to_string())
        .env("DSH_MOBILE_ENABLED", "1")
        .env("DSH_DESKTOP_PORT", port.to_string());
    let cloudflared = configured_cloudflared_bin();
    if !cloudflared.is_empty() {
        cmd.env("DSH_CLOUDFLARED_BIN", cloudflared);
    }
    // GUI 应用（Finder 启动）的 cwd 是 /（不可写）：dsh-mnemon 的 workspace 存储域
    // 用 process.cwd() 作 .mnemon 根，子进程继承 / 会报 ENOENT 起不来（终端启动
    // 无此问题，因为终端 cwd 是可写目录）。显式把子进程 cwd 设为 dsh home：
    // .mnemon 等工作区相对产物统一落进 $DSH_HOME/.mnemon，归属 harness 单一根。
    cmd.current_dir(dsh_home());
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped());
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            // 提高 dsh 子进程文件描述符上限：长期会话 + 整页刷新（右键「刷新」= 整页
            // reload）会让 dsh 侧插件（dsh-hud 的 fs.watch / SSE 等）反复注册 watcher，
            // 默认 soft limit 下触发 EMFILE 崩溃（Node 进程退出 → 页面冻结）。只上调，
            // 且不超过系统 hard limit。
            cmd.pre_exec(|| {
                let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
                if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) == 0 {
                    let target: libc::rlim_t = 16384;
                    if lim.rlim_cur < target {
                        lim.rlim_cur = if lim.rlim_max == libc::RLIM_INFINITY || lim.rlim_max >= target {
                            target
                        } else {
                            lim.rlim_max
                        };
                        if lim.rlim_cur > 0 {
                            let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
                        }
                    }
                }
                Ok(())
            });
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| SpawnError::Other(format!("spawn {} 失败：{e}", bin.display())))?;
    log::info!("已启动 dsh web（{}，PID {}）", bin.display(), child.id());
    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                // dsh 新版在 stdout 打印带 process token 的启动 URL：解析后存入
                // state 供就绪导航拼接（无该行的老版 dsh 走不带 token 的回退路径）。
                if let Some(token) = parse_web_token_line(&line) {
                    store_web_token(&app, token);
                }
                log::info!("[dsh] {line}");
                let _ = app
                    .emit("dsh-console", serde_json::json!({ "stream": "stdout", "line": line }));
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log::warn!("[dsh] {line}");
                let _ = app
                    .emit("dsh-console", serde_json::json!({ "stream": "stderr", "line": line }));
            }
        });
    }
    Ok(child)
}

// ==================== Windows 分支 ====================
// 注意：以下代码只在 Windows 上编译（macOS 构建时被 cfg 完全排除），
// 已在 macOS 之外无法本机验证；若 Windows 编译报错，按编译器提示修正。

/// Windows：定位 node.exe（nvm-windows / 官方安装器 / PATH）。
#[cfg(windows)]
fn find_node() -> Option<PathBuf> {
    // ① 显式覆盖：DSH_NODE
    if let Ok(p) = std::env::var("DSH_NODE") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    // ② PATH 中的 node.exe
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let pb = dir.join("node.exe");
            if pb.is_file() {
                return Some(pb);
            }
        }
    }
    // ③ nvm-windows：%NVM_HOME%\v*\node.exe、%NVM_SYMLINK%\node.exe、%APPDATA%\nvm\v*
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut nvm_roots: Vec<PathBuf> = Vec::new();
    if let Ok(h) = std::env::var("NVM_HOME") {
        nvm_roots.push(PathBuf::from(h));
    }
    if let Ok(a) = std::env::var("APPDATA") {
        nvm_roots.push(PathBuf::from(&a).join("nvm"));
    }
    for root in &nvm_roots {
        if let Ok(entries) = std::fs::read_dir(root) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort_by_key(|d| version_key(d));
            for d in dirs.iter().rev() {
                candidates.push(d.join("node.exe"));
            }
        }
        candidates.push(root.join("node.exe"));
    }
    if let Ok(s) = std::env::var("NVM_SYMLINK") {
        candidates.push(PathBuf::from(s).join("node.exe"));
    }
    // ④ 官方安装器固定路径
    for p in [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ] {
        candidates.push(PathBuf::from(p));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Windows：定位 dsh 的 bin.js（npm/nvm/pnpm 全局安装位置）。
/// 支持 DSH_BIN 直接指向 bin.js 或任意可执行文件。
#[cfg(windows)]
fn find_dsh_bin_js() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DSH_BIN") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    const REL: &str = "node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(a) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(&a).join("npm"));
        roots.push(PathBuf::from(&a).join("pnpm"));
        let nvm_dir = PathBuf::from(&a).join("nvm");
        roots.push(nvm_dir.clone());
        // nvm 各版本目录（node_modules 可能装在版本目录下）
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    roots.push(e.path());
                }
            }
        }
    }
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(&l).join("pnpm"));
    }
    if let Ok(h) = std::env::var("NVM_HOME") {
        roots.push(PathBuf::from(&h));
        if let Ok(entries) = std::fs::read_dir(&h) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    roots.push(e.path());
                }
            }
        }
    }
    if let Ok(s) = std::env::var("NVM_SYMLINK") {
        roots.push(PathBuf::from(s));
    }
    roots.push(PathBuf::from(r"C:\Program Files\nodejs"));
    roots.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));
    // PATH 目录（dsh.cmd 所在目录一般就是全局 bin，node_modules 在附近）
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            roots.push(dir);
        }
    }
    roots
        .into_iter()
        .map(|root| root.join(REL))
        .find(|p| p.is_file())
}

/// Windows：spawn `node <bin.js> web ...`。
///
/// npm 全局安装的 dsh 在 Windows 是 dsh.cmd shim，直接 CreateProcess 有引号
/// 转义坑，所以直接用 node.exe 执行 bin.js；CREATE_NO_WINDOW 防止闪黑窗。
#[cfg(windows)]
fn spawn_dsh(app: &tauri::AppHandle, port: u16, _advanced: bool) -> Result<Child, SpawnError> {
    use std::os::windows::process::CommandExt;
    let node = find_node().ok_or_else(|| {
        SpawnError::NotFound(
            "未找到 node.exe。请安装 Node.js 或设置 DSH_NODE 环境变量。".to_string(),
        )
    })?;
    let bin_js = find_dsh_bin_js().ok_or_else(|| {
        SpawnError::NotFound(
            "未找到 @deepseek-ai/dsh。请执行 `npm i -g @deepseek-ai/dsh`，或设置 DSH_BIN 指向 bin.js。"
                .to_string(),
        )
    })?;
    let mut cmd = Command::new(&node);
    let mut launcher_args: Vec<std::ffi::OsString> =
        vec![
            bin_js.clone().into(),
            "--profile".into(),
            configured_profile().into(),
        ];
    // 桌面插件经 --patch 注入（包名行，实体在共享模块池，不写 profile bundles）。
    // 注意顺序：--patch 必须早于 --no-open/--host —— dsh CLI 用 passThrough 解析，
    // 靠后的 --patch 会被透传给 web-app 而报 unknown option '--patch'。
    launcher_args.push("--patch".into());
    launcher_args.push(desktop_plugin_patch_path(app).into_os_string());
    // 仅当设置 DSH_DESKTOP_EXTRA_PATCH 调试环境变量时叠加该 `--patch` overlay。
    if let Ok(patch) = std::env::var("DSH_DESKTOP_EXTRA_PATCH") {
        if !patch.trim().is_empty() {
            launcher_args.push("--patch".into());
            launcher_args.push(patch.into());
        }
    }
    // --no-open：dsh 升级后默认打开系统浏览器，桌面壳自行导航故关闭
    launcher_args.extend([
        "--no-open".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string().into(),
    ]);
    cmd.args(&launcher_args)
        .env("DSH_MOBILE_LANE_PORT", configured_lane_port().to_string())
        .env("DSH_MOBILE_ENABLED", "1")
        .env("DSH_DESKTOP_PORT", port.to_string());
    let cloudflared = configured_cloudflared_bin();
    if !cloudflared.is_empty() {
        cmd.env("DSH_CLOUDFLARED_BIN", cloudflared);
    }
    // 同 unix 分支：GUI 启动的 cwd 是 /，必须显式设 dsh home（mnemon workspace 域）
    cmd.current_dir(dsh_home());
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| SpawnError::Other(format!("spawn node {} 失败：{e}", node.display())))?;
    log::info!(
        "已启动 dsh web（node {} {}，PID {}）",
        node.display(),
        bin_js.display(),
        child.id()
    );
    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                // dsh 新版在 stdout 打印带 process token 的启动 URL：解析后存入
                // state 供就绪导航拼接（无该行的老版 dsh 走不带 token 的回退路径）。
                if let Some(token) = parse_web_token_line(&line) {
                    store_web_token(&app, token);
                }
                log::info!("[dsh] {line}");
                let _ = app
                    .emit("dsh-console", serde_json::json!({ "stream": "stdout", "line": line }));
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log::warn!("[dsh] {line}");
                let _ = app
                    .emit("dsh-console", serde_json::json!({ "stream": "stderr", "line": line }));
            }
        });
    }
    Ok(child)
}

/// 从 dsh web stdout 行解析启动 URL 的 process token。
/// 行格式（单独一行）：`dsh web: http://127.0.0.1:3080/?token=xxxx`，
/// token 字符集为 URL 安全字母（含 -/_）。解析失败/无 token 返回 None
/// （老版 dsh 无 token 机制，桌面壳回退到不带 token 的 URL）。
fn parse_web_token_line(line: &str) -> Option<String> {
    let idx = line.find("dsh web: http")?;
    let rest = &line[idx + "dsh web: http".len()..];
    let marker = "?token=";
    let tidx = rest.find(marker)?;
    let raw = &rest[tidx + marker.len()..];
    let token: String = raw
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.' || *c == '~')
        .collect();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// 把解析到的 process token 写入 DshState（空则忽略；后到的覆盖先到的）。
fn store_web_token(app: &AppHandle, token: String) {
    if token.is_empty() {
        return;
    }
    *app.state::<DshState>().web_token.lock().unwrap() = token.clone();
    log::info!("[token] 已捕获 dsh web process token（长度 {}）", token.len());
}

/// 清空 process token（重启/重新 spawn 前调用：新实例的 token 必然不同，
/// 残留旧 token 会在宽限窗口内被误用于导航而 401）。
fn clear_web_token(app: &AppHandle) {
    *app.state::<DshState>().web_token.lock().unwrap() = String::new();
}

/// 用 token 向 dsh web 换取会话 cookie（裸 HTTP，不跟随重定向）。
/// dsh 对 `GET /?token=x` 回 303 + Set-Cookie（dsh-auth-<authority>=v1.…，
/// HttpOnly; SameSite=Strict; Path=/; Max-Age=30 天）。
/// 返回 Set-Cookie 的 cookie 名与原始值（不含属性），失败返回 None。
fn exchange_token_for_cookie(host_port: &str, token: &str) -> Option<(String, String)> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(host_port).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let req = format!(
        "GET /?token={token} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break; // 响应头已完整（303 无 body）
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let status = head.lines().next()?.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    if !(300..400).contains(&status) {
        log::warn!("[token] 交换会话 cookie 失败：HTTP {status}");
        return None;
    }
    let line = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))?
        .to_string();
    let value_part = line.split_once(':')?.1.trim().to_string();
    let (name, value_full) = value_part.split_once('=')?;
    if name.trim().is_empty() {
        return None;
    }
    // value 取到第一个 ';' 为止（后面是 Max-Age/Path 等属性，不能混入值）
    let value = value_full.split(';').next().unwrap_or("").trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some((name.trim().to_string(), value))
}

/// 把 dsh 会话 cookie 直接种进 webview 的 cookie 存储（WKHTTPCookieStore / WebView2）。
///
/// 为什么不走「导航到 ?token= 让 303 种 cookie」：加载页是 tauri://localhost，
/// 首跳 127.0.0.1 是跨站导航；dsh 的 cookie 是 SameSite=Strict，303 跟随请求
/// 与 WebKit 异步落库 cookie 存在竞态，抢跑的请求不带 cookie → 渲染 401 白屏，
/// 等 2.5s 补跳才恢复。原生种 cookie 不经网络层，导航前 cookie 已就绪，
/// 一次导航直达桌面，全程无白屏。
fn seed_session_cookie(app: &AppHandle, host: &str, port: u16, name: &str, value: &str) {
    let Some(w) = app.get_webview_window("main") else { return };
    let mut cookie = cookie::Cookie::new(name.to_string(), value.to_string());
    cookie.set_domain(host.to_string());
    cookie.set_path("/");
    cookie.set_http_only(true);
    cookie.set_same_site(cookie::SameSite::Strict);
    // 30 天，与 dsh 侧 maxAge 一致；过期则重新用 state 里的 token 换
    cookie.set_max_age(cookie::time::Duration::days(30));
    if let Err(e) = w.set_cookie(cookie) {
        // set_cookie 在 Linux 上（webkitgtk）可能不支持：失败则回退旧两段式导航路径
        log::warn!("[token] 原生种会话 cookie 失败（回退两段式导航）：{e}");
    } else {
        log::info!("[token] 会话 cookie 已原生种入 webview（{host}:{port}）");
    }
}

/// 生成本地通知服务器的访问 token（防本机其它进程误触发；非加密学强度）。
fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("xnl{:x}{:x}", nanos, std::process::id())
}

/// 启动本地 HTTP 通知服务器（127.0.0.1 随机端口），返回 (端口, token)。
/// 页面注入 JS 通过 POST /notify 上报任务完成。
fn start_notify_server(app: AppHandle) -> (u16, String) {
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
const CORS_HEADERS: &str = "Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
Access-Control-Max-Age: 86400\r\n";

/// 完整读取一条 HTTP 请求（头 + 可能分段的 body，按 Content-Length 收齐）。
/// 单次 read 只读头时 body 会丢（自诊断 / 通知的 JSON body 偶发单独到达）。
async fn read_full_request(sock: &mut tokio::net::TcpStream) -> String {
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
async fn handle_notify_conn(sock: &mut tokio::net::TcpStream, app: &AppHandle, token: &str) {
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
fn notify_completed(app: &AppHandle, body: &str) {
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
fn task_notifier_script(port: u16, token: &str) -> String {
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
fn inject_task_notifier(app: AppHandle, port: u16, token: &str) {
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
fn probe_http(host_port: &str, path: &str) -> std::io::Result<bool> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(host_port)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let req = format!("GET {path} HTTP/1.1
Host: {host_port}
Connection: close

");
    stream.write_all(req.as_bytes())?;
    let mut buf = [0u8; 256];
    let n = stream.read(&mut buf)?;
    let head = String::from_utf8_lossy(&buf[..n]).to_string();
    Ok(head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .map(|code| code < 400)
        .unwrap_or(false))
}

/// 本地 dsh 探测：健康=TCP 连接成功（监听 socket 在高负载时也接受连接，不会抖动）；
/// HTTP 探测只作日志细节，绝不作为判死依据。
fn probe_local(port: u16) -> (bool, String) {
    let addr = format!("127.0.0.1:{port}");
    if !matches!(std::net::TcpStream::connect(&addr), Ok(_)) {
        return (false, format!("{addr} 连接失败"));
    }
    let detail = match probe_http(&addr, "/") {
        Ok(true) => "HTTP 200".into(),
        Ok(false) => "HTTP 非 2xx/3xx（仅日志）".into(),
        Err(e) => format!("HTTP 探测超时/异常（仅日志）：{e}"),
    };
    (true, detail)
}

/// 远程 dsh 探测：入参可为完整 URL（新版）或 host:port（旧格式）。与本地同语义。
fn probe_remote(addr: &str) -> (bool, String) {
    let host_port = remote_host_port(addr);
    if !matches!(std::net::TcpStream::connect(&host_port), Ok(_)) {
        return (false, format!("{host_port} 连接失败"));
    }
    let detail = match probe_http(&host_port, "/") {
        Ok(true) => "HTTP 200".into(),
        Ok(false) => "HTTP 非 2xx/3xx（仅日志）".into(),
        Err(e) => format!("HTTP 探测超时/异常（仅日志）：{e}"),
    };
    (true, detail)
}

/// 确认/申请系统通知权限（三平台通用）。
/// tauri-plugin-notification 桌面端 `request_permission`/`permission_state` 返回
/// `PermissionState`：macOS 走 UNUserNotificationCenter、Windows 走 Toast（AUMID）、
/// Linux 走 dbus 通知。放任何 `.show()` 之前 best-effort 调用并记录结果，便于排查
/// “通知不生效”（显示权限被拒 / 平台不支持 / 请求失败等）。
fn request_notification_permission(app: &tauri::AppHandle) {
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
fn show_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => log::info!("系统通知已发送：{title}"),
        Err(e) => log::warn!("系统通知发送失败（{title}）：{e}"),
    }
}
/// dsh 数据目录（$DSH_HOME 或 ~/.dsh）。
fn dsh_home() -> PathBuf {
    if let Ok(h) = std::env::var("DSH_HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    #[cfg(windows)]
    let base = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    #[cfg(not(windows))]
    let base = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    base.join(".dsh")
}

/// 定位本应用自带的桌面 chrome 插件包（dsh-desktop-tauriapp）。
/// 优先级：
/// 1. `DSH_DESKTOP_PLUGIN` 环境变量（目录）
/// 2. Tauri 运行时资源目录下的内嵌副本 `{resource_dir}/dsh-desktop-tauriapp` —— 打包场景，
///    由 tauri.conf.json 的 `bundle.resources` 内嵌；`resource_dir()` 按平台解析真实位置
///    （macOS=Contents/Resources、Windows=可执行文件所在目录、Linux=/usr/lib 或 AppImage
///    挂载点），因此无论 app 装到哪里都能拿到真实路径，无需写死。
/// 3. 与可执行文件同级的 dsh-desktop-tauriapp（老打包布局兼容）
/// 4. 从可执行文件向上找 package.json.name == dsh-desktop-tauriapp 的目录（开发仓库根）。
fn desktop_plugin_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
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
fn desktop_plugin_patch_path(app: &tauri::AppHandle) -> PathBuf {
    let Some(dir) = app.path().app_data_dir().ok() else {
        return PathBuf::from("/tmp/dsh-desktop-tauriapp-inject.yml");
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("desktop-plugin-inject.yml");
    // name 与上游 cordis.patch.yml 一致：上游 v2.3.0 起包改名 dsh-web-mobile（弃用
    // @dsh-external scope），patch 行 id/name 随之对齐；
    // materialize 时 link_name 也用同名（见 materialize_desktop_plugin）。
    let content = "- insert:\n    - id: dsh-desktop-tauriapp\n      name: dsh-desktop-tauriapp\n    - id: dsh-mobile-access\n      name: dsh-mobile-access\n    - id: dsh-web-mobile\n      name: dsh-web-mobile\n";
    let stale = std::fs::read_to_string(&path).map(|t| t != content).unwrap_or(true);
    if stale {
        let _ = std::fs::write(&path, content);
    }
    path
}

/// 定位手机访问插件包目录（dsh-mobile-access / dsh-mobile-nav）：
/// 优先打包内嵌副本 resource_dir/plugins/<name>，回退开发仓库 mobile/<rel>。
fn mobile_package_dir(app: &tauri::AppHandle, name: &str, rel: &str) -> Option<PathBuf> {
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

/// 把插件包挂进共享模块池 $DSH_HOME/profiles/node_modules，使 `name: <pkg>`
/// 从任意 profile 可解析（macOS/Linux 用符号链接，Windows 退化为复制整包）。幂等。
/// scoped 包名（如 @dsh-external/dsh-mobile-nav）会自动补建 scope 父目录；
/// pool 目录本身不存在时也会一并创建，函数自足不依赖调用方预建。
fn materialize_pool_package(pool: &std::path::Path, link_name: &str, dir: &std::path::Path) {
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
    if link.exists() || link.is_symlink() {
        let _ = std::fs::remove_dir_all(&link);
        let _ = std::fs::remove_file(&link);
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
        match copy_dir_all(&dir, &link) {
            Ok(()) => log::info!("共享模块池复制 {link_name} -> {}", link.display()),
            Err(e) => log::error!("共享模块池复制 {link_name} 失败：{e}"),
        }
    }
}

/// 把三个内置插件包挂进共享模块池：桌面插件 + 手机访问（dsh-mobile-access）+ 移动布局
/// （移动布局：上游 v2.3.0 起包名 dsh-web-mobile）。幂等。
fn materialize_desktop_plugin(app: &tauri::AppHandle) {
    let pool = dsh_home().join("profiles").join("node_modules");
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
    // 在共享模块池 node_modules 里查找，链路必须同 key。
    // 内嵌目录名同步改用 dsh-web-mobile；子模块 checkout 路径仍为 mobile/dsh-mobile-nav。
    if let Some(dir) = mobile_package_dir(app, "dsh-web-mobile", "dsh-mobile-nav") {
        materialize_pool_package(&pool, "dsh-web-mobile", &dir);
    } else {
        log::warn!("未定位到 dsh-web-mobile 插件包，跳过共享模块池挂载");
    }
}

/// 复制目录树（Windows 不能保证目录符号链接权限，退化为实体复制）。
#[cfg(windows)]
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
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
fn strip_web_profile_plugin_bundle() {
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

/// 桌面壳加载 Web GUI 的地址。
/// `advanced=true`（本次由桌面壳 spawn 了实例）：附加 desktop 标记，插件 client
/// 在原生布局内注入局部拖拽区（不禁用 ui-layout）；
/// `advanced=false`（复用了外部已有实例）：不带标记，标准布局 + 系统原生标题栏。
/// 普通浏览器/无标记访问不激活桌面 UI。
/// `token` 为 dsh web 的 process token（新版本必需，否则 401；None/空 = 老版回退）。
/// 注意：带 token 的 URL 经 303 重定向到 `/` 时 query 参数会被剥掉，因此有 token
/// 时标记参数不与 token 同跳（wait_ready_and_navigate 的两段式导航负责补跳标记）。
fn desktop_url(port: u16, advanced: bool, token: Option<&str>) -> String {
    match token.filter(|t| !t.is_empty()) {
        Some(tok) => format!("http://127.0.0.1:{port}/?token={tok}"),
        None if advanced => {
            let platform = desktop_platform_tag();
            format!(
                "http://127.0.0.1:{port}/?dsh-desktop-tauriapp-mode=advanced&dsh-desktop-tauriapp-platform={platform}"
            )
        }
        None => format!("http://127.0.0.1:{port}/"),
    }
}

/// 当前平台的桌面标记值（client 端 environment.ts 按同名约定解析）。
fn desktop_platform_tag() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// 在已建立的会话（cookie 已换到）之上追加高级模式标记参数。
/// 无 token 的新版 dsh 上无意义（401），但有 token 交换后这是激活桌面 chrome 的唯一途径。
fn advanced_marker_query() -> String {
    format!(
        "dsh-desktop-tauriapp-mode=advanced&dsh-desktop-tauriapp-platform={}",
        desktop_platform_tag()
    )
}

/// 轮询等待服务就绪，然后把主窗口导航到 Web GUI；失败则跳错误页。
/// `nport`/`ntoken` 是通知桥的端口与令牌，导航完成后才注入监听脚本。
///
/// dsh 新版要求 process token：导航前先用 token 原生换会话 cookie 并种入
/// webview（exchange_token_for_cookie + seed_session_cookie），然后一次性
/// 导航到最终页（高级模式带标记）——全程无 401 中间页（无两段式跳转）。
/// 无 token（老版 dsh）或原生种 cookie 失败时回退：token 随首跳、标记由
/// 2.5s 补跳携带（旧行为）。
async fn wait_ready_and_navigate(app: AppHandle, port: u16, nport: u16, ntoken: String) {
    let state = app.state::<DshState>();
    // advanced 以当前接入模式为准（高级=带标记桌面 chrome；兼容=标准布局）
    let advanced = state.mode.load(Ordering::SeqCst) == MODE_ADVANCED;
    // 远程模式：不探测/不 spawn 本地，直接导航远程页面
    if let Some(addr) = load_desktop_settings().remote_addr {
        navigate_remote(&app, &addr, advanced);
        return;
    }
    // spawn 场景才等 stdout 的 token 行（外部复用场景永远等不到，token 只能来自粘贴）
    let expect_token = state.spawned_this_run.load(Ordering::SeqCst);
    // 端口监听可能先于 stdout 的 token 行就绪（实测出现过）：spawn 场景给 5s 宽限，
    // 新版 dsh 通常 <1s 内到达；老版 dsh（无 token 机制）最多多等 5s 再按回退路径导航。
    let token_grace_deadline = Instant::now() + Duration::from_secs(5);
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if state.spawn_failed.load(Ordering::SeqCst) {
            // 错误页已由 setup 按具体原因（not-found / spawn-failed）显示，这里不再二次导航
            return;
        }
        if port_open(port) {
            let web_token = state.web_token.lock().unwrap().clone();
            if expect_token && web_token.is_empty() && Instant::now() < token_grace_deadline {
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
            // 导航前原生换 cookie：种入 webview 后首次请求即携带，无 401 中间页。
            // 失败（如 Linux webkitgtk 不支持 set_cookie）回退两段式导航。
            let mut seeded = false;
            if !web_token.is_empty() {
                if let Some((name, value)) =
                    exchange_token_for_cookie(&format!("127.0.0.1:{port}"), &web_token)
                {
                    seed_session_cookie(&app, "127.0.0.1", port, &name, &value);
                    seeded = true;
                }
            }
            // URL 在导航时刻构建：cookie 已种好时直达最终页（带标记）；
            // 未种成且有 token 时首跳只带 token（303 会剥参数），标记由补跳携带；
            // 无 token（老版 dsh）维持旧行为。
            let url = if seeded {
                if advanced {
                    format!("http://127.0.0.1:{port}/?{}", advanced_marker_query())
                } else {
                    format!("http://127.0.0.1:{port}/")
                }
            } else {
                desktop_url(
                    port,
                    advanced,
                    if web_token.is_empty() { None } else { Some(web_token.as_str()) },
                )
            };
            if let Some(w) = app.get_webview_window("main") {
                let script = format!("window.location.replace({url:?});");
                if let Err(e) = w.eval(&script) {
                    log::warn!("窗口导航失败：{e}");
                    show_error(&app, "spawn-failed");
                    return;
                }
                // 导航后注入监听：0.3.0 在 setup 阶段提前注入，冷启动时脚本
                // 落在加载页、随导航销毁（通知收不到的根因之二）。
                inject_task_notifier(app.clone(), nport, &ntoken);
                // 回退路径的第二跳：首跳 token 换 cookie 的 303 会剥 query，等 cookie
                // 落地后补跳带高级模式标记的 URL。原生种 cookie 成功（seeded）时无需补跳。
                if !seeded && !web_token.is_empty() && advanced {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(2500)).await;
                        let marked =
                            format!("http://127.0.0.1:{port}/?{}", advanced_marker_query());
                        if let Some(w) = handle.get_webview_window("main") {
                            if let Err(e) =
                                w.eval(&format!("window.location.replace({marked:?});"))
                            {
                                log::warn!("[nav] 高级模式标记补跳失败：{e}");
                            } else {
                                log::info!("[nav] 已补跳高级模式标记 URL");
                            }
                        }
                        // 补跳会再次整页加载，任务通知监听随页面销毁，需要重挂
                        inject_task_notifier(handle, nport, &ntoken);
                    });
                }
            }
            log::info!("本地服务就绪，已导航到 {url}");
            set_status(&app, STATUS_READY, "运行中");
            app.state::<DshState>().ready_once.store(true, Ordering::SeqCst);
            return;
        }
        if Instant::now() >= deadline {
            log::error!("等待本地服务就绪超时（{}s）", READY_TIMEOUT.as_secs());
            set_status(&app, STATUS_STALE, "就绪超时");
            show_error(&app, "timeout");
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 主窗口跳转到本地错误页并发系统通知。
fn show_error(app: &AppHandle, reason: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let target = format!("error.html?reason={reason}");
        let _ = w.eval(&format!("window.location.replace({target:?});"));
    }
    let body = match reason {
        "not-found" => "未找到 dsh 命令，请按错误页提示安装。",
        "spawn-failed" => "dsh 进程启动失败，详见日志。",
        "timeout" => "等待本地服务就绪超时，详见日志。",
        _ => "未知错误，详见日志。",
    };
    show_notification(app, "DeepSeek Harness Desktop 启动失败", body);
}

/// 显示并聚焦主窗口。
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ==================== 桌宠（透明置顶小窗） ====================

/// 桌宠窗口尺寸（物理像素），与 tauri.conf.json 中 pet 窗口 width/height 一致，
/// 用于载入位置时的多屏钳位。
const PET_W: i32 = 260;
const PET_H: i32 = 300;

/// 桌宠持久化状态（存 app_config_dir/pet.json，物理像素坐标）。
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct PetState {
    x: i32,
    y: i32,
    enabled: bool,
    passthrough: bool,
}

fn pet_state_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("pet.json"))
}

fn read_pet_state(app: &AppHandle) -> PetState {
    let Some(path) = pet_state_path(app) else {
        return PetState::default();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_pet_state(app: &AppHandle, st: &PetState) {
    let Some(path) = pet_state_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(st) {
        let _ = std::fs::write(&path, json);
    }
}

/// 载入坐标钳位到可见显示器；全都不在（如拔了外接屏）则回退主屏右下角。
fn clamp_pet_to_monitors(pet: &tauri::WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    if let Ok(monitors) = pet.available_monitors() {
        for m in &monitors {
            let wa = m.work_area();
            let (wx, wy) = (wa.position.x, wa.position.y);
            let (ww, wh) = (wa.size.width as i32, wa.size.height as i32);
            if x >= wx && x + PET_W <= wx + ww && y >= wy && y + PET_H <= wy + wh {
                return (x, y);
            }
        }
    }
    if let Ok(Some(m)) = pet.primary_monitor() {
        let wa = m.work_area();
        let (wx, wy) = (wa.position.x, wa.position.y);
        let (ww, wh) = (wa.size.width as i32, wa.size.height as i32);
        return (wx + ww - PET_W - 16, wy + wh - PET_H - 16);
    }
    (x, y)
}

/// 启动时恢复桌宠位置与可见性（窗口由 tauri.conf.json 声明自动创建）。
fn setup_pet(app: &AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let st = read_pet_state(app);
    let (cx, cy) = clamp_pet_to_monitors(&pet, st.x, st.y);
    let _ = pet.set_position(tauri::PhysicalPosition::new(cx, cy));
    if st.passthrough {
        let _ = pet.set_ignore_cursor_events(true);
    }
    if st.enabled {
        let _ = pet.show();
    }
}

/// 显示/隐藏桌宠（托盘与右键共用），并写回 enabled 状态。
fn toggle_pet(app: &AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let mut st = read_pet_state(app);
    if pet.is_visible().unwrap_or(false) {
        let _ = pet.hide();
        st.enabled = false;
    } else {
        let _ = pet.show();
        st.enabled = true;
    }
    write_pet_state(app, &st);
}

#[tauri::command]
fn pet_show_main(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn pet_hide(app: AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.hide();
    }
    let mut st = read_pet_state(&app);
    st.enabled = false;
    write_pet_state(&app, &st);
}

#[tauri::command]
fn pet_quit(app: AppHandle) {
    app.state::<DshState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn pet_toggle_passthrough(app: AppHandle) -> bool {
    let mut st = read_pet_state(&app);
    st.passthrough = !st.passthrough;
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.set_ignore_cursor_events(st.passthrough);
    }
    write_pet_state(&app, &st);
    st.passthrough
}

/// 双击拖拽区触发 macOS 风格的"zoom"——把窗口几何切到当前屏幕的 work area
///（MenuBar 与 Dock 不被覆盖），再次双击恢复到之前的几何。不是全屏 maximize
///（不调用 NSWindow zoom:，那在 WKWebView 下不会自动放大，且语义偏 Win 风格）。
///
/// work_area 由 `available_monitors` 取，与 NSWindow.visibleFrame 同语义。
fn current_monitor_for_window(
    window: &tauri::WebviewWindow,
) -> Option<tauri::Monitor> {
    let pos = window.outer_position().ok()?;
    let monitors = window.available_monitors().ok()?;
    // 优先匹配窗口中心所在屏（窗口跨屏时取主屏兜底）
    let size = window.outer_size().ok()?;
    let cx = pos.x + (size.width as i32) / 2;
    let cy = pos.y + (size.height as i32) / 2;
    monitors
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
        })
        .or_else(|| window.primary_monitor().ok().flatten())
}

#[tauri::command]
fn toggle_zoom(window: tauri::WebviewWindow, state: tauri::State<DshState>) {
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

/// 在系统默认浏览器/应用中打开外链（三平台：macOS `open`、Windows `cmd start`、
/// Linux `xdg-open`）。仅允许 http/https/mailto/tel，避免命令注入。
/// 由 dsh-desktop-tauriapp 插件 client 在 webview 里拦截外链点击后调用。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:")
        || url.starts_with("tel:"))
    {
        return Err(format!("不允许打开的链接协议：{url}"));
    }
    let ok = open_external_impl(&url);
    if ok {
        log::info!("已在系统默认应用中打开：{url}");
        Ok(())
    } else {
        Err(format!("打开链接失败：{url}"))
    }
}

#[cfg(target_os = "macos")]
fn open_external_impl(url: &str) -> bool {
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn open_external_impl(url: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // 走 ShellExecuteW（系统 Shell 按协议路由到默认浏览器/邮件客户端），不用
    // cmd start：cmd 会把 URL 里的 & 当命令分隔符，且 Rust Command 对含引号参数
    // 会二次转义，导致 URL 被搞坏、静默打不开。ShellExecuteW 返回值 >32 表示成功。
    let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    (result as isize) > 32
}

#[cfg(target_os = "linux")]
fn open_external_impl(url: &str) -> bool {
    std::process::Command::new("xdg-open")
        .arg(url)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
/// 原生导航守卫：拦截 webview 里的一切主框架导航（参考项目 Electron will-frame-navigate）。
/// - 放行：非 http/https scheme（tauri:// 本地加载页、about:、file:、data: 等壳内/本地），
///   以及内部主机的 http(s) —— 桌面壳自管的 dsh web 与 Windows 资产协议
///   （tauri.localhost，对应 mac/linux 的 tauri://）；Windows 资产协议若被当外部链接，
///   cmd start 会把它当文件名打开而报「找不到文件」；
/// - 拦截并在系统默认浏览器打开：外部 http(s)、mailto、tel（webview 内取消导航）。
/// 注册为全局插件 on_navigation，配合客户端 JS 层（点击拦截 + window.open 覆盖）兜底新窗口场景。
fn nav_guard_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("dsh-nav-guard")
        .on_navigation(|_webview, url| navigate_guard(url))
        .build()
}

fn navigate_guard(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            // 内部主机：dsh web（127.0.0.1/::1/localhost）+ Windows 资产协议主机 tauri.localhost
            // （后者若被当外链会触发 cmd start 把 URL 当文件名打开而报「找不到文件」）
            // + 运行时放行的远程 dsh 主机（托盘「dsh 服务地址」选择后写入）。
            let runtime_internal = INTERNAL_HOSTS
                .lock()
                .unwrap()
                .iter()
                .any(|h| h == host);
            let internal = host == "127.0.0.1" || host == "::1" || host == "localhost" || host == "tauri.localhost" || runtime_internal;
            if internal {
                return true;
            }
            log::info!("[nav] 拦截外部链接并交给默认浏览器：{url}");
            let _ = open_external(url.as_str().to_string());
            false
        }
        "mailto" | "tel" => {
            log::info!("[nav] 拦截外部协议并在系统打开：{url}");
            let _ = open_external(url.as_str().to_string());
            false
        }
        _ => true,
    }
}

/// 查询启动是否需要用户选择「兼容/高级」模式（启动页加载后轮询）。
#[tauri::command]
fn get_mode_prompt_needed(state: tauri::State<DshState>) -> bool {
    state.mode_prompt_needed.load(Ordering::SeqCst)
}

/// 客户端诊断上报：把页面侧外链拦截结果写进应用日志，便于排查「点击链接无反应」。
#[tauri::command]
fn log_diag(msg: String) {
    log::info!("[diag] {msg}");
}

/// WebView 控制台捕获：把页面侧 `console.*` 转发到 `$DSH_HOME/dsh-desktop-webview.log`，
/// 便于不依赖 GUI 开发者工具直接 `tail -f` 看前端错误。客户端通过 `initialization_script`
/// 包装 console.*（保持原行为不变，仅额外 invoke 此命令），命令失败吞掉以免阻塞页面。
/// 不向 dsh 进程 stdout 镜像（控制台输出量大时会让 dsh-desktop-tauriapp.log 噪声翻倍），
/// 但通过 `level=warn|error` 时仍镜像一份（出问题优先排查）。
#[tauri::command]
fn log_console(level: String, msg: String, page_url: Option<String>) {
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
fn get_dsh_status(state: tauri::State<DshState>) -> serde_json::Value {
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
fn restart_dsh_service(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DshState>();
    if state.restarting.load(Ordering::SeqCst) {
        return Err("已在重启中".to_string());
    }
    let mode = state.mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(&app, mode);
    Ok(())
}

/// 页面侧输入弹窗回填（确定/取消都到达这里；value 为空视为取消）。
#[tauri::command]
async fn ui_input_confirm(
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
async fn prompt_input(
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
fn input_modal_js(flow: &str, title: &str, placeholder: &str, initial: &str) -> String {
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
fn choose_desktop_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
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


/// 扫描 $DSH_HOME/profiles 下的可 boot-profile（bundles 顺序先 base 后 web-app 才可选）。
#[derive(serde::Serialize)]
struct ProfileInfo {
    name: String,
    active: bool,
    selectable: bool,
}

fn scan_profiles() -> Vec<ProfileInfo> {
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
fn valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 切换 profile：写 settings 后走统一重启流程（spawn 时按新 profile 拉起）。
fn switch_profile(app: &AppHandle, name: &str) {
    if !valid_profile_name(name) {
        show_notification(app, "切换 Profile 失败", "名称不合法");
        return;
    }
    let mut settings = load_desktop_settings();
    if settings.active_profile.as_deref() == Some(name) {
        return;
    }
    settings.active_profile = Some(name.to_string());
    save_desktop_settings(&settings);
    log::info!("[tray] 切换 profile -> {name}");
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode);
}

/// 执行 `dsh plugin --profile <name> add <pkg>`（Windows 走 node<bin.js>）。
fn run_profile_plugin_add(profile: &str, pkg: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Some(node) = find_node() else { return false };
        let Some(js) = find_dsh_bin_js() else { return false };
        std::process::Command::new(node)
            .arg(&js)
            .args(["plugin", "--profile", profile, "add", "--config.minimumReleaseAge=0"])
            .arg(pkg)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let Some(dsh) = find_dsh_bin() else { return false };
        std::process::Command::new(&dsh)
            .args(["plugin", "--profile", profile, "add", "--config.minimumReleaseAge=0"])
            .arg(pkg)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// 新建 profile 流程：弹窗输入名称 → plugin add base + web-app。
fn create_profile_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(name) = prompt_input(&handle, "new-profile", "新建 Profile", "profile 名称（字母/数字/_/-）", "").await else {
            return;
        };
        if !valid_profile_name(&name) {
            show_notification(&handle, "新建 Profile 失败", "名称仅允许字母、数字、_ 与 -（1-32 字符）");
            return;
        }
        if dsh_home().join("profiles").join(&name).exists() {
            show_notification(&handle, "新建 Profile 失败", &format!("{name} 已存在"));
            return;
        }
        let name_for_cmd = name.clone();
        let failed = tauri::async_runtime::spawn_blocking(move || {
            for pkg in ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] {
                if !run_profile_plugin_add(&name_for_cmd, pkg) {
                    return Some(pkg.to_string());
                }
            }
            None
        })
        .await
        .unwrap_or(Some("安装任务异常".into()));
        match failed {
            None => {
                log::info!("[tray] 新建 profile 成功：{name}");
                show_notification(&handle, "新建 Profile 成功", &format!("{name} 已创建（未自动切换）"));
            }
            Some(pkg) => {
                log::error!("[tray] 新建 profile 失败：{pkg}");
                show_notification(&handle, "新建 Profile 失败", &format!("{pkg} 安装失败，请查看日志"));
            }
        }
        refresh_tray_mode(&handle);
    });
}


/// 归一化远程地址（完整 URL 或旧格式 host[:port]）为可导航 URL。
/// 新版 dsh web 的远程地址是它打印的完整 URL（http/https + ?token=…）；
/// 旧格式 host[:port] 自动补 http:// 兼容。拒绝非 http(s)、无 host、
/// 带 / 之外路径与带凭据的输入（token URL 的路径恒为 /）。
fn normalize_remote_url(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url = tauri::Url::parse(&with_scheme).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if url.host_str().unwrap_or("").is_empty() {
        return None;
    }
    let path = url.path();
    if !(path.is_empty() || path == "/") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(url.to_string())
}

/// 远程条目的展示名：URL 形态取 host[:port]（旧格式原样返回）。
/// 托盘标签/状态详情用它，避免把长 URL（含 token）直接铺进菜单。
fn remote_display(addr: &str) -> String {
    if let Ok(url) = tauri::Url::parse(addr) {
        if url.scheme() == "http" || url.scheme() == "https" {
            let host = url.host_str().unwrap_or("");
            return match url.port() {
                Some(p) => format!("{host}:{p}"),
                None => host.to_string(),
            };
        }
    }
    addr.to_string()
}

/// 远程地址的 TCP 连接目标 host:port（URL 形态解析并补 scheme 默认端口；旧格式原样）。
fn remote_host_port(addr: &str) -> String {
    if let Ok(url) = tauri::Url::parse(addr) {
        if url.scheme() == "http" || url.scheme() == "https" {
            let host = url.host_str().unwrap_or("");
            let port = url.port_or_known_default().unwrap_or(80);
            return format!("{host}:{port}");
        }
    }
    addr.to_string()
}

/// 去掉 URL 查询串里的 token= 参数（保留其余参数），用于 cookie 建立后的干净导航。
fn strip_token_query(url: &str) -> String {
    match tauri::Url::parse(url) {
        Ok(mut u) => {
            let pairs: Vec<(String, String)> = u
                .query_pairs()
                .filter(|(k, _)| k != "token")
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            u.set_query(None);
            if !pairs.is_empty() {
                let q = pairs
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("&");
                u.set_query(Some(&q));
            }
            u.to_string()
        }
        Err(_) => url.to_string(),
    }
}

/// 从用户粘贴的 dsh web 启动 URL 里提取 process token（没有则 None）。
fn extract_token_from_url(input: &str) -> Option<String> {
    let url = tauri::Url::parse(input.trim()).ok()?;
    let (_, value) = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(k, v)| (k.to_string(), v.to_string()))?;
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// 选择远程/本地服务来源：写 settings 后按来源重启。
/// `addr` 存完整 URL（新版 dsh web 带 process token；旧格式 host[:port] 仍兼容）。
fn select_remote(app: &AppHandle, addr: Option<String>) {
    let mut settings = load_desktop_settings();
    settings.remote_addr = addr;
    save_desktop_settings(&settings);
    if let Some(a) = settings.remote_addr.as_deref() {
        let host = remote_host_port(a).split(':').next().unwrap_or(a).to_string();
        let mut list = INTERNAL_HOSTS.lock().unwrap();
        if !list.contains(&host) {
            list.push(host);
        }
        log::info!("[tray] 切换 dsh 服务地址 -> 远程 {}", remote_display(a));
    } else {
        log::info!("[tray] 切换 dsh 服务地址 -> 本地");
    }
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode);
}

/// 新增远程地址流程：弹窗输入完整 URL（或旧格式 host[:port]）→ 校验 → 存入列表并选中。
fn add_remote_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(input) = prompt_input(&handle, "add-remote", "新增 dsh 服务地址", "dsh web 打印的完整 URL（含 token），或 host[:port]", "").await else {
            return;
        };
        let Some(addr) = normalize_remote_url(&input) else {
            show_notification(&handle, "新增地址失败", "格式应为 dsh web 打印的完整 URL 或 host[:port]");
            return;
        };
        // 新版 dsh web 的 token 是必要凭据：URL 里带了就先存入 state，
        // 供远程导航直接使用（导航时按需拼接，不修改用户保存的原始 URL）。
        if let Some(token) = extract_token_from_url(&addr) {
            store_web_token(&handle, token);
        }
        let mut settings = load_desktop_settings();
        if !settings.remote_list.contains(&addr) {
            settings.remote_list.push(addr.clone());
        }
        save_desktop_settings(&settings);
        log::info!("[tray] 新增远程 dsh 地址：{}（未切换，请在菜单中手动选择）", remote_display(&addr));
        refresh_tray_mode(&handle);
    });
}

/// 删除远程地址（当前选中项自动回本地）。
fn remove_remote_flow(app: &AppHandle, addr: &str) {
    let mut settings = load_desktop_settings();
    settings.remote_list.retain(|a| a != addr);
    if settings.remote_addr.as_deref() == Some(addr) {
        settings.remote_addr = None;
    }
    save_desktop_settings(&settings);
    log::info!("[tray] 删除远程 dsh 地址：{}", remote_display(addr));
    refresh_tray_mode(app);
}

/// 设置本地端口流程：弹窗输入 → 校验 → 保存 →（本地模式）重启生效。
fn set_port_flow(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let current = configured_port().to_string();
        let Some(input) = prompt_input(&handle, "set-port", "设置本地 dsh web 端口", "端口（1-65535）", &current).await else {
            return;
        };
        let Ok(port) = input.parse::<u16>() else {
            show_notification(&handle, "设置端口失败", "请输入 1-65535 的整数");
            return;
        };
        if port == 0 {
            show_notification(&handle, "设置端口失败", "端口不能为 0");
            return;
        }
        let mut settings = load_desktop_settings();
        settings.port = Some(port);
        save_desktop_settings(&settings);
        log::info!("[tray] 本地端口 -> {port}");
        if settings.remote_addr.is_some() {
            show_notification(&handle, "端口已保存", &format!("{port} 将在本地模式生效"));
        } else {
            let mode = handle.state::<DshState>().mode.load(Ordering::SeqCst);
            restart_dsh_in_mode(&handle, mode);
        }
        refresh_tray_mode(&handle);
    });
}

/// 远程首页是否挂载了本插件的 client（GET / 并从响应里检索挂载串）。
/// `addr` 可为完整 URL（新版，带 token 时跟随 303 换 cookie；探活页只需要 200 首页）
/// 或 host:port（旧格式）。
fn remote_has_plugin(addr: &str) -> bool {
    use std::io::{Read, Write};
    let host_port = remote_host_port(addr);
    // 请求路径取 URL 的 path+query（含 token 时 dsh 会 303 → cookie 首页），
    // 旧格式 host:port 保持请求根路径。
    let (target, cookie) = match tauri::Url::parse(addr) {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => {
            let q = match u.query() {
                Some(q) => format!("?{q}"),
                None => String::new(),
            };
            let path = if u.path().is_empty() { "/" } else { u.path() };
            (format!("{path}{q}"), String::new())
        }
        _ => ("/".to_string(), String::new()),
    };
    // 最多跟一次重定向（token 交换 303 → Set-Cookie → 首页 200）。
    // 裸 socket 不带 cookie jar，手动接住 Set-Cookie 再发第二跳。
    let mut current_target = target;
    let mut current_cookie = cookie;
    let mut buf = Vec::with_capacity(65536);
    for _hop in 0..2 {
        let Ok(mut stream) = std::net::TcpStream::connect(&host_port) else { return false };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let mut req = format!(
            "GET {current_target} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n"
        );
        if !current_cookie.is_empty() {
            req.push_str(&format!("Cookie: {current_cookie}\r\n"));
        }
        req.push_str("\r\n");
        if stream.write_all(req.as_bytes()).is_err() {
            return false;
        }
        buf.clear();
        let mut tmp = [0u8; 8192];
        loop {
            match stream.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.len() >= 65536 {
                        break;
                    }
                }
            }
        }
        let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let status = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse::<u16>().ok())
            .unwrap_or(0);
        if (300..400).contains(&status) {
            // 记下 Set-Cookie，按 Location 起一跳（Location 可能是相对路径 /）
            let set_cookie = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string());
            if let Some(cv) = set_cookie {
                let pair = cv.split(';').next().unwrap_or("").trim().to_string();
                if !pair.is_empty() {
                    current_cookie = pair;
                }
            }
            let loc = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("location:"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string())
                .unwrap_or_default();
            if loc.is_empty() {
                return false;
            }
            current_target = if loc.starts_with("http://") || loc.starts_with("https://") {
                match tauri::Url::parse(&loc) {
                    Ok(u) => {
                        let q = u.query().map(|q| format!("?{q}")).unwrap_or_default();
                        let path = if u.path().is_empty() { "/" } else { u.path() };
                        format!("{path}{q}")
                    }
                    Err(_) => return false,
                }
            } else {
                loc
            };
            continue;
        }
        break;
    }
    String::from_utf8_lossy(&buf).contains("/plugins/dsh-desktop-tauriapp/client.js")
}

/// 导航到远程 dsh 页面。`addr` 为完整 URL（新版 dsh web 含 process token）
/// 或旧格式 host:port（自动补 http://）。高级模式在无 token / 已带标记的场景外
/// 统一两段式：token 交换的 303 会剥 query，2.5s 后补跳带标记 URL（cookie 会话 200）。
/// 远程缺插件时提示建议切兼容，不阻塞。
fn navigate_remote(app: &AppHandle, addr: &str, advanced: bool) {
    let host_port = remote_host_port(addr);
    let host = host_port.split(':').next().unwrap_or(addr).to_string();
    {
        let mut list = INTERNAL_HOSTS.lock().unwrap();
        if !list.contains(&host) {
            list.push(host);
        }
    }
    if advanced && !remote_has_plugin(addr) {
        log::warn!("[remote] 远程未检测到 dsh-desktop-tauriapp 插件，建议使用兼容模式");
        show_notification(app, "远程 dsh 未安装桌面插件", "高级模式需要远程安装 dsh-desktop-tauriapp，建议改用兼容模式");
    }
    // 基础 URL：完整 URL 原样用（含 token/旧参数）；旧格式补 scheme 与根路径。
    let base = if tauri::Url::parse(addr)
        .map(|u| u.scheme() == "http" || u.scheme() == "https")
        .unwrap_or(false)
    {
        addr.to_string()
    } else {
        format!("http://{addr}/")
    };
    let has_token = tauri::Url::parse(&base)
        .ok()
        .map(|u| u.query_pairs().any(|(k, _)| k == "token"))
        .unwrap_or(false);
    let mut url = base.clone();
    let mut follow_up: Option<String> = None;
    if advanced && !base.contains("dsh-desktop-tauriapp-mode=") {
        if has_token {
            // 有 token：首跳先交换 cookie（参数会被 303 剥掉），补跳再带标记
            url = base.clone();
            follow_up = Some(format!("{}?{}", strip_token_query(&base), advanced_marker_query()));
        } else {
            // 无 token（老版 dsh 或已建立 cookie 会话）：标记随首跳
            let sep = if base.contains('?') { "&" } else { "?" };
            url = format!("{base}{sep}{}", advanced_marker_query());
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.location.replace({url:?});"));
        if let Some(marked) = follow_up {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(2500)).await;
                if let Some(w) = handle.get_webview_window("main") {
                    if let Err(e) = w.eval(&format!("window.location.replace({marked:?});")) {
                        log::warn!("[remote] 高级模式标记补跳失败：{e}");
                    } else {
                        log::info!("[remote] 已补跳高级模式标记 URL");
                    }
                }
            });
        }
    }
    log::info!("已导航到远程 dsh：{}（{}）", remote_display(&url), url);
    set_status(app, STATUS_REMOTE, &format!("远程 {}", remote_display(addr)));
    app.state::<DshState>().ready_once.store(true, Ordering::SeqCst);
}

/// 按当前接入模式构建托盘菜单（含「切换模式」项，标签显示当前模式）。
fn tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let advanced = app.state::<DshState>().mode.load(Ordering::SeqCst) == MODE_ADVANCED;
    let toggle_label = if advanced {
        "切换为兼容模式（标准布局）"
    } else {
        "切换为高级模式（桌面界面）"
    };
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let pet = MenuItem::with_id(app, "pet", "显示/隐藏桌宠", true, None::<&str>)?;
    let settings = load_desktop_settings();
    let active_remote = settings.remote_addr.clone();
    let port = configured_port();

    // dsh 服务地址 ▸（标签用展示名 host[:port]，完整 URL 里的 token 不进菜单）
    let local_label = if active_remote.is_none() { "✓ 本地".to_string() } else { "本地".to_string() };
    let local_item = MenuItem::with_id(app, "remote:local", local_label, true, None::<&str>)?;
    let mut remote_builder = SubmenuBuilder::new(app, "dsh 服务地址");
    remote_builder = remote_builder.item(&local_item);
    for addr in &settings.remote_list {
        let display = remote_display(addr);
        let label = if active_remote.as_deref() == Some(addr) {
            format!("✓ {display}")
        } else {
            display
        };
        // 菜单 id 仍携带完整地址（URL 或旧格式），选中/删除按原值匹配
        let item = MenuItem::with_id(app, format!("remote-set:{addr}"), label, true, None::<&str>)?;
        remote_builder = remote_builder.item(&item);
    }
    remote_builder = remote_builder.separator();
    let add_item = MenuItem::with_id(app, "remote-add", "新增地址…", true, None::<&str>)?;
    remote_builder = remote_builder.item(&add_item);
    if !settings.remote_list.is_empty() {
        let mut del_builder = SubmenuBuilder::new(app, "删除地址");
        for addr in &settings.remote_list {
            let item = MenuItem::with_id(app, format!("remote-del:{addr}"), remote_display(addr), true, None::<&str>)?;
            del_builder = del_builder.item(&item);
        }
        remote_builder = remote_builder.items(&[&del_builder.build()?]);
    }
    let remote_menu = remote_builder.build()?;

    // Profile ▸
    let mut profile_builder = SubmenuBuilder::new(app, "Profile");
    for p in scan_profiles() {
        let label = if p.active { format!("✓ {}", p.name) } else { p.name.clone() };
        let item = MenuItem::with_id(app, format!("profile:{}", p.name), label, p.selectable, None::<&str>)?;
        profile_builder = profile_builder.item(&item);
    }
    profile_builder = profile_builder.separator();
    let new_profile = MenuItem::with_id(app, "new-profile", "新建 Profile…", true, None::<&str>)?;
    profile_builder = profile_builder.item(&new_profile);
    let profile_menu = profile_builder.build()?;

    let port_item = MenuItem::with_id(app, "set-port", format!("本地端口… {port}"), true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-mode", toggle_label, true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启 dsh 服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DeepSeek Harness Desktop", true, None::<&str>)?;
    Ok(Menu::with_items(
        app,
        &[&show, &pet, &remote_menu, &profile_menu, &port_item, &restart, &toggle, &quit],
    )?)
}

/// 刷新托盘「切换模式」标签（模式切换/重启后调用）。
fn refresh_tray_mode(app: &AppHandle) {
    let state = app.state::<DshState>();
    if let Ok(menu) = tray_menu(app) {
        if let Some(tray) = state.tray.lock().unwrap().as_ref() {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// 构建菜单栏托盘：左键显示窗口，菜单提供显示/隐藏桌宠/切换模式/重启/退出。
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = tray_menu(app.handle())?;
    // 托盘专用图标：从 64x64 PNG（macOS 菜单栏 32pt @2x = 64px 甜点尺寸）加载，
    // 优先用 include_bytes 编译期嵌入；加载失败回退 default_window_icon。
    // DeepSeek Harness 图标本身有颜色，不当模板图（icon_as_template=false）。
    let icon: tauri::image::Image<'_> = tauri::image::Image::from_bytes(include_bytes!("../icons/64x64.png"))
        .ok()
        .map(tauri::image::Image::to_owned)
        .map(tauri::image::Image::into)
        .unwrap_or_else(|| {
            app.default_window_icon()
                .expect("缺少应用图标")
                .clone()
        });
    TrayIconBuilder::with_id("dsh-tray")
        .icon(icon)
        .icon_as_template(false)
        .tooltip("DeepSeek Harness Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "pet" => toggle_pet(app),
            "restart" => restart_dsh(app),
            "toggle-mode" => toggle_desktop_mode(app),
            "remote:local" => select_remote(app, None),
            "remote-add" => add_remote_flow(app),
            "new-profile" => create_profile_flow(app),
            "set-port" => set_port_flow(app),
            id if id.starts_with("profile:") => {
                switch_profile(app, &id["profile:".len()..]);
            }
            id if id.starts_with("remote-set:") => {
                select_remote(app, Some(id["remote-set:".len()..].to_string()));
            }
            id if id.starts_with("remote-del:") => {
                remove_remote_flow(app, &id["remote-del:".len()..]);
            }
            "quit" => {
                app.state::<DshState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map(|tray| {
            *app.state::<DshState>().tray.lock().unwrap() = Some(tray);
        })?;
    Ok(())
}

/// 按接入模式应用主窗口标题栏形态（首次启动、启动页选择、托盘切换都会调用，
/// 不只在 setup 里生效）。
/// - 高级：macOS Overlay（保留红绿灯 + 自绘拖拽区）；Windows/Linux 隐藏原生标题栏（自绘 caption 行）；
/// - 兼容：macOS Visible（系统原生标题栏）；Windows/Linux 恢复原生标题栏。
fn apply_titlebar(app: &AppHandle, advanced: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    #[cfg(target_os = "macos")]
    {
        let style = if advanced {
            tauri::TitleBarStyle::Overlay
        } else {
            tauri::TitleBarStyle::Visible
        };
        if let Err(e) = w.set_title_bar_style(style) {
            log::warn!("切换主窗口标题栏样式失败：{e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Err(e) = w.set_decorations(!advanced) {
        log::warn!("切换主窗口标题栏失败：{e}");
    }
}

/// 回到内嵌启动加载页（重启/切换模式时，像重启应用一样先回到加载界面）。
fn navigate_to_loading(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let url = app
        .state::<DshState>()
        .loading_url
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| {
            #[cfg(target_os = "windows")]
            {
                "http://tauri.localhost/index.html".to_string()
            }
            #[cfg(not(target_os = "windows"))]
            {
                "tauri://localhost/index.html".to_string()
            }
        });
    if let Ok(u) = url.parse::<tauri::Url>() {
        if let Err(e) = w.navigate(u) {
            log::warn!("导航回加载页失败：{e}");
        }
    } else if let Err(e) = w.eval(&format!("window.location.replace({url:?});")) {
        log::warn!("导航回加载页失败：{e}");
    }
}

/// 重启/切换接入模式（都先回到启动加载页，再停旧实例、按目标模式拉起、重新进入）。
/// target_mode = MODE_ADVANCED / MODE_COMPAT。
/// 通知服务器在 setup 阶段就已启动并常驻，重启时复用同一端口/token。
fn restart_dsh_in_mode(app: &AppHandle, target_mode: u8) {
    let state = app.state::<DshState>();
    if state.restarting.swap(true, Ordering::SeqCst) {
        log::warn!("已在重启/切换中，忽略重复触发");
        return;
    }
    let mode_name = if target_mode == MODE_ADVANCED { "高级" } else { "兼容" };
    log::info!("[restart] 进入{mode_name}模式：回到加载页并重启 dsh 服务");
    set_status(app, STATUS_RESTARTING, &format!("重启中（{mode_name}）"));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 0) 回到启动加载页（像重启一样）
        navigate_to_loading(&handle);
        let port = app_port();
        // 1) 停掉占用端口的现有 dsh（含自家子进程与外部实例，纯代码）
        if let Some(mut child) = handle.state::<DshState>().child.lock().unwrap().take() {
            let pid = child.id();
            log::info!("[restart] 停止自管 dsh 子进程（PID {pid}）");
            let _ = child.kill();
            let _ = child.wait();
            log::info!("[restart] 旧 dsh 已退出");
        }
        let freed = stop_port_owner(port).await;
        if !freed {
            log::error!("[restart] 端口 {port} 未能停用/释放，重启中止");
            show_notification(&handle, "DeepSeek Harness Desktop · 重启失败", &format!("端口 {port} 仍被占用"));
            handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
            return;
        }
        // 2) 按目标模式拉起（高级=注入局部拖拽 chrome；兼容=标准布局 + 原生标题栏）
        // 先清旧 token：新实例 token 必然不同，残留会误导宽限窗口内的导航
        clear_web_token(&handle);
        let advanced = target_mode == MODE_ADVANCED;
        match spawn_dsh(&handle, port, advanced) {
            Ok(child) => {
                log::info!("[restart] 新 dsh 子进程已启动（PID {}）", child.id());
                *handle.state::<DshState>().child.lock().unwrap() = Some(child);
                handle.state::<DshState>().spawned_this_run.store(true, Ordering::SeqCst);
                handle.state::<DshState>().mode.store(target_mode, Ordering::SeqCst);
                apply_titlebar(&handle, advanced);
            }
            Err(e) => {
                let msg = match &e {
                    SpawnError::NotFound(s) | SpawnError::Other(s) => s.clone(),
                };
                log::error!("[restart] spawn 失败：{msg}");
                show_notification(&handle, "DeepSeek Harness Desktop · 重启失败", &format!("spawn 失败：{msg}"));
                handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
                return;
            }
        }
        // 3) 重置失败标志并等待就绪 + 重新导航（按目标模式生成 URL）
        handle.state::<DshState>().spawn_failed.store(false, Ordering::SeqCst);
        let nport = handle.state::<DshState>().notify_port.load(Ordering::SeqCst);
        let ntoken = handle.state::<DshState>().notify_token.lock().unwrap().clone();
        wait_ready_and_navigate(handle.clone(), port, nport, ntoken).await;
        handle.state::<DshState>().restarting.store(false, Ordering::SeqCst);
        // 4) 刷新托盘「切换模式」标签
        refresh_tray_mode(&handle);
        log::info!("[restart] {mode_name}模式启动完成");
    });
}

/// 托盘「重启 dsh 服务」：在当前模式下重启。
fn restart_dsh(app: &AppHandle) {
    let mode = app.state::<DshState>().mode.load(Ordering::SeqCst);
    restart_dsh_in_mode(app, mode);
}

/// 托盘「切换模式」：兼容 <-> 高级（切换后重启对应的 dsh web）。
fn toggle_desktop_mode(app: &AppHandle) {
    let cur = app.state::<DshState>().mode.load(Ordering::SeqCst);
    let next = if cur == MODE_ADVANCED { MODE_COMPAT } else { MODE_ADVANCED };
    restart_dsh_in_mode(app, next);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("dsh-desktop-tauriapp".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(nav_guard_plugin())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["pet"])
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .invoke_handler(tauri::generate_handler![
            pet_show_main,
            pet_hide,
            pet_quit,
            pet_toggle_passthrough,
            toggle_zoom,
            open_external,
            choose_desktop_mode,
            get_mode_prompt_needed,
            log_diag,
            log_console,
            get_dsh_status,
            restart_dsh_service,
            ui_input_confirm
        ])
.manage(DshState {
            child: Mutex::new(None),
            spawned_this_run: AtomicBool::new(false),
            mode_prompt_needed: AtomicBool::new(false),
            mode: AtomicU8::new(MODE_ADVANCED),
            status: AtomicU8::new(STATUS_IDLE),
            loading_url: Mutex::new(None),
            tray: Mutex::new(None),
            spawn_failed: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
            ready_once: AtomicBool::new(false),
            pending_input: Mutex::new(None),
            quitting: AtomicBool::new(false),
            tray_tip_shown: AtomicBool::new(false),
            unread: AtomicU32::new(0),
            pet_save_at: Mutex::new(None),
            notify_port: AtomicU16::new(0),
            notify_token: Mutex::new(String::new()),
            web_token: Mutex::new(String::new()),
            pre_zoom_geom: Mutex::new(None),
        })
        .setup(|app| {
            let port = app_port();
            let state = app.state::<DshState>();
            // 记录内嵌加载页 URL（重启/切换模式时回到该页，像重启应用一样）
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(u) = w.url() {
                    *state.loading_url.lock().unwrap() = Some(u.to_string());
                }
            }
            // 申请系统通知权限（macOS 弹授权窗；Windows/Linux 幂等确认）。
            // 放在任何 .show() 之前，best-effort 不阻塞启动。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                request_notification_permission(&handle);
            });
            if port_open(port) {
                log::info!("127.0.0.1:{port} 已有服务在监听，直接复用现有实例");
                // 外部实例复用会禁用桌面 chrome：在加载页弹「兼容/高级」模式选择
                state.mode_prompt_needed.store(true, Ordering::SeqCst);
                set_status(app.handle(), STATUS_EXTERNAL, "复用外部实例");
            } else {
                // 即将由本应用拉起 dsh：先确保 web profile 已挂载桌面 chrome 插件
                //（参考项目机制：检测缺失则用官方 `dsh plugin --profile web add` 装上）。
                // 桌面插件改为 --patch 注入：先挂共享模块池（解析实体），再迁移旧 bundle 注册
                log::info!("桌面插件 --patch 注入准备：挂共享模块池 + 迁移旧 bundle 注册");
                set_status(app.handle(), STATUS_STARTING, "启动中");
                materialize_desktop_plugin(app.handle());
                strip_web_profile_plugin_bundle();
                // 首次 spawn 前清 token（防御性：正常为空）；stdout 线程随后写入新值
                clear_web_token(app.handle());
                match spawn_dsh(app.handle(), port, true) {
                    Ok(child) => {
                        log::info!("dsh 子进程已启动（PID {}）", child.id());
                        *state.child.lock().unwrap() = Some(child);
                        state.spawned_this_run.store(true, Ordering::SeqCst);
                        state.mode.store(MODE_ADVANCED, Ordering::SeqCst);
                    }
                    Err(SpawnError::NotFound(e)) => {
                        log::error!("启动 dsh 失败：{e}");
                        state.spawn_failed.store(true, Ordering::SeqCst);
                        show_error(app.handle(), "not-found");
                    }
                    Err(SpawnError::Other(e)) => {
                        log::error!("启动 dsh 失败：{e}");
                        state.spawn_failed.store(true, Ordering::SeqCst);
                        show_error(app.handle(), "spawn-failed");
                    }
                }
            }
// 先起通知桥，把端口/token 交给导航任务并保存到 state（重启 dsh 时复用）；
// 导航完成后再注入监听脚本（0.3.0 在导航前注入，冷启动时脚本随加载页销毁）。
            let (nport, ntoken) = start_notify_server(app.handle().clone());
            state.notify_port.store(nport, Ordering::SeqCst);
            *state.notify_token.lock().unwrap() = ntoken.clone();
            if state.spawned_this_run.load(Ordering::SeqCst) {
                // 本次由桌面壳拉起实例：立即导航（advanced，桌面 chrome）
                let handle = app.handle().clone();
                let nav_token = ntoken.clone();
                tauri::async_runtime::spawn(async move {
                    wait_ready_and_navigate(handle, port, nport, nav_token).await;
                });
            } else {
                // 复用了外部实例：等用户在加载页选择模式（choose_desktop_mode）再接入；
                // 这里发一个延迟事件兜底，防止页面早于 state 标记加载完成
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    if handle.state::<DshState>().mode_prompt_needed.load(Ordering::SeqCst) {
                        let _ = handle.emit("desktop-mode-request", serde_json::json!({}));
                    }
                });
            }
            // 窗口拖动完全交由 dsh-desktop-tauriapp 插件的 client 端（root slot 里的
            // AdvancedFrame）渲染拖拽区并挂 data-tauri-drag-region；这里不再注入
            // 任何脚本，也不再使用 movableByWindowBackground（那会让整窗可拖）。
            // macOS 用 titleBarStyle:Overlay（保留原生红绿灯）；
            // Windows/Linux 隐藏原生标题栏（decorations:false），标题栏 UI 由
            // 插件 client 自绘 caption 行 + 窗口按钮。
            // 标题栏形态跟随接入模式（setup/模式切换/启动页选择都会走 apply_titlebar）；
            // 复用外部实例阶段（尚未选模式）保持系统原生标题栏。
            apply_titlebar(
                app.handle(),
                state.spawned_this_run.load(Ordering::SeqCst)
                    && state.mode.load(Ordering::SeqCst) == MODE_ADVANCED,
            );
            // 测试钩子：DSH_DESKTOP_AUTO_QUIT=1 时延迟自动退出（模拟托盘退出，验证子进程回收）
            if std::env::var("DSH_DESKTOP_AUTO_QUIT").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(8)).await;
                    log::info!("[auto-quit] 测试钩子触发退出");
                    handle
                        .state::<DshState>()
                        .quitting
                        .store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
            // 测试钩子：DSH_DESKTOP_NOTIFY_TEST=1 时延迟触发一次通知（验证通知链路）
            if std::env::var("DSH_DESKTOP_NOTIFY_TEST").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(6)).await;
                    notify_completed(&handle, "这是测试通知：任务完成链路验证");
                });
            }
            // 守护器：周期探测 dsh 服务。判定规则（防误杀/防抖动循环）：
            // - 健康 = TCP 连接成功（监听 socket 高负载也接受连接；HTTP 状态仅作日志）；
            // - 连续 3 次连接失败（≈15s）才算一次异常事件，且两次自动重启间隔 ≥60s；
            // - 复用外部实例/远程：只提示、绝不代拉自动重启（不误杀用户自管实例）；
            // - 自愈每轮 3 次封顶；自愈计数仅在「持续健康 ≥2 分钟」后重置（防抖动无限循环）；
            // - 状态从非正常回 READY 时无额外动作。
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(5));
                    let mut fail_streak = 0u32;
                    let mut healthy_streak = 0u32;
                    let mut epoch_failures = 0u32;
                    let mut last_auto = Instant::now() - Duration::from_secs(60);
                    let mut last_notify = Instant::now() - Duration::from_secs(300);
                    loop {
                        interval.tick().await;
                        let state = handle.state::<DshState>();
                        if state.quitting.load(Ordering::SeqCst) {
                            break;
                        }
                        if !state.ready_once.load(Ordering::SeqCst)
                            || state.restarting.load(Ordering::SeqCst)
                            || state.spawn_failed.load(Ordering::SeqCst)
                        {
                            continue;
                        }
                        let settings = load_desktop_settings();
                        let (up, verbose) = match settings.remote_addr.as_deref() {
                            Some(addr) => probe_remote(addr),
                            None => probe_local(configured_port()),
                        };
                        let cur = state.status.load(Ordering::SeqCst);
                        if up {
                            fail_streak = 0;
                            healthy_streak += 1;
                            // 持续健康 ≥2 分钟（24 tick）才重置自愈计数：防「短暂健康→又失败」的抖动循环
                            if healthy_streak >= 24 {
                                epoch_failures = 0;
                            }
                            if cur == STATUS_STALE || cur == STATUS_DOWN || cur == STATUS_REMOTE {
                                set_status(&handle, STATUS_READY, "运行中");
                            }
                            continue;
                        }
                        healthy_streak = 0;
                        fail_streak += 1;
                        if fail_streak < 3 {
                            if cur != STATUS_RESTARTING {
                                set_status(
                                    &handle,
                                    if settings.remote_addr.is_some() { STATUS_REMOTE } else { STATUS_STALE },
                                    "服务异常（持续探测中）",
                                );
                            }
                            continue;
                        }
                        if Instant::now() - last_auto < Duration::from_secs(60) {
                            continue;
                        }
                        last_auto = Instant::now();
                        fail_streak = 0;
                        if settings.remote_addr.is_some() {
                            set_status(&handle, STATUS_REMOTE, "远程不可达");
                            if Instant::now() - last_notify >= Duration::from_secs(300) {
                                last_notify = Instant::now();
                                show_notification(&handle, "远程 dsh 不可达", &format!("{verbose}"));
                            }
                            continue;
                        }
                        if !state.spawned_this_run.load(Ordering::SeqCst) {
                            // 复用外部实例：不代拉自动重启（那是用户的实例），仅提示
                            set_status(&handle, STATUS_STALE, "外部实例不可达");
                            if Instant::now() - last_notify >= Duration::from_secs(300) {
                                last_notify = Instant::now();
                                log::warn!("[watchdog] 外部 dsh 实例不可达（{verbose}），未自动重启");
                                show_notification(&handle, "dsh 服务不可达", "复用的外部 dsh 实例已停止，请手动重启服务");
                            }
                            continue;
                        }
                        epoch_failures += 1;
                        if epoch_failures >= 3 {
                            log::error!("[watchdog] 连续自动恢复失败 3 次，停止自愈");
                            set_status(&handle, STATUS_STALE, "异常（已停止自愈，请手动重启）");
                            show_notification(&handle, "dsh 服务异常", "连续自动恢复失败，请手动重启");
                            continue;
                        }
                        log::warn!("[watchdog] 检测到 dsh 异常（{verbose}），自动重启（第 {epoch_failures} 次）");
                        restart_dsh_in_mode(&handle, state.mode.load(Ordering::SeqCst));
                    }
                });
            }
            build_tray(app)?;
            setup_pet(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            match window.label() {
                "pet" => match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        // 桌宠不退出，只隐藏（退出走托盘/右键 pet_quit）
                        api.prevent_close();
                        let _ = window.hide();
                        let mut st = read_pet_state(window.app_handle());
                        st.enabled = false;
                        write_pet_state(window.app_handle(), &st);
                    }
                    WindowEvent::Moved(pos) => {
                        // 拖拽结束才落盘位置（400ms 防抖，避免拖动期间高频写盘）
                        let app = window.app_handle();
                        let state = app.state::<DshState>();
                        let now = Instant::now();
                        let should_save = state
                            .pet_save_at
                            .lock()
                            .map(|last| {
                                last.map_or(true, |t| now.duration_since(t) >= Duration::from_millis(400))
                            })
                            .unwrap_or(true);
                        if should_save {
                            let mut st = read_pet_state(&app);
                            st.x = pos.x;
                            st.y = pos.y;
                            write_pet_state(&app, &st);
                            if let Ok(mut last) = state.pet_save_at.lock() {
                                *last = Some(now);
                            }
                        }
                    }
                    _ => {}
                },
                "main" => {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = window.state::<DshState>();
                        if state.quitting.load(Ordering::SeqCst) {
                            return; // 托盘退出流程：放行关闭
                        }
                        api.prevent_close();
                        let _ = window.hide();
                        if !state.tray_tip_shown.swap(true, Ordering::SeqCst) {
                            show_notification(
                                window.app_handle(),
                                "DeepSeek Harness Desktop 仍在运行",
                                "窗口已隐藏到菜单栏托盘，点击托盘图标可重新打开；托盘菜单可退出。",
                            );
                        }
                    } else if let WindowEvent::Focused(true) = event {
                        // 用户回到窗口：清零角标与未读数
                        let state = window.state::<DshState>();
                        state.unread.store(0, Ordering::SeqCst);
                        let _ = window.set_badge_count(None);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                let quitting = app.state::<DshState>().quitting.load(Ordering::SeqCst);
                if !quitting {
                    api.prevent_exit();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
            RunEvent::Exit => {
                let state = app.state::<DshState>();
                if state.spawned_this_run.load(Ordering::SeqCst) {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        let pid = child.id();
                        log::info!("正在停止 dsh 子进程（PID {pid}）");
                        let _ = child.kill();
                        let _ = child.wait();
                        log::info!("dsh 子进程已退出");
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    // —— dsh web process token（issue #23）——

    #[test]
    fn parse_web_token_line_extracts_token() {
        // 真实 stdout 行格式（单独一行）
        let line = "dsh web: http://127.0.0.1:3080/?token=RQsEG-U8B4RMcWxE2d8LRQLt5yLHl_3RlPKFexm1Lu0";
        assert_eq!(
            parse_web_token_line(line).as_deref(),
            Some("RQsEG-U8B4RMcWxE2d8LRQLt5yLHl_3RlPKFexm1Lu0")
        );
        let short = "dsh web: http://127.0.0.1:13080/?token=MUpczjUeeXYnS6uOr3b2G461BgylSTmIA3Nkz1LKDOY";
        assert_eq!(
            parse_web_token_line(short).as_deref(),
            Some("MUpczjUeeXYnS6uOr3b2G461BgylSTmIA3Nkz1LKDOY")
        );
    }

    #[test]
    fn parse_web_token_line_stops_at_boundary() {
        // token 后跟其它字符（如回车后的提示）时在字符集边界截断
        let line = "dsh web: http://127.0.0.1:3080/?token=abc123 extra";
        assert_eq!(parse_web_token_line(line).as_deref(), Some("abc123"));
    }

    #[test]
    fn parse_web_token_line_rejects_non_token_lines() {
        assert_eq!(parse_web_token_line("[dsh] ready"), None);
        assert_eq!(parse_web_token_line("dsh web: http://127.0.0.1:3080/"), None);
        assert_eq!(parse_web_token_line("dsh web: http://x/?token="), None);
        assert_eq!(parse_web_token_line(""), None);
    }

    #[test]
    fn desktop_url_with_token_ignores_advanced_marker() {
        // 有 token：URL 只带 token（标记由第二跳补上，303 会剥 query）
        assert_eq!(
            desktop_url(3080, true, Some("tok1")),
            "http://127.0.0.1:3080/?token=tok1"
        );
        // 兼容模式 + token：同上
        assert_eq!(
            desktop_url(3080, false, Some("tok1")),
            "http://127.0.0.1:3080/?token=tok1"
        );
    }

    #[test]
    fn desktop_url_without_token_keeps_legacy_behavior() {
        // 老版 dsh（无 token）回退：高级带标记 / 兼容裸根
        assert_eq!(
            desktop_url(3080, true, None),
            "http://127.0.0.1:3080/?dsh-desktop-tauriapp-mode=advanced&dsh-desktop-tauriapp-platform=darwin"
        );
        assert_eq!(desktop_url(3080, false, None), "http://127.0.0.1:3080/");
        // 空 token 视同无 token
        assert_eq!(
            desktop_url(3080, true, Some("")),
            desktop_url(3080, true, None)
        );
    }

    #[test]
    fn normalize_remote_url_accepts_full_and_legacy() {
        // 完整 URL（新版 dsh web 打印格式）
        assert_eq!(
            normalize_remote_url("http://192.168.1.10:3080/?token=abc-DEF_123").as_deref(),
            Some("http://192.168.1.10:3080/?token=abc-DEF_123")
        );
        // 旧格式 host:port 与裸 host（自动补 scheme/端口）
        assert_eq!(
            normalize_remote_url("192.168.1.10:3080").as_deref(),
            Some("http://192.168.1.10:3080/")
        );
        assert_eq!(
            normalize_remote_url("dsh.example.cn").as_deref(),
            Some("http://dsh.example.cn/")
        );
        // https 保留
        assert_eq!(
            normalize_remote_url("https://dsh.example.cn/").as_deref(),
            Some("https://dsh.example.cn/")
        );
    }

    #[test]
    fn normalize_remote_url_rejects_bad_input() {
        assert_eq!(normalize_remote_url(""), None);
        assert_eq!(normalize_remote_url("ftp://x"), None);
        assert_eq!(normalize_remote_url("http://user:pass@h/"), None);
        assert_eq!(normalize_remote_url("http://h/extra/path"), None);
        // 无 host
        assert_eq!(normalize_remote_url("http://"), None);
    }

    #[test]
    fn remote_display_hides_token() {
        assert_eq!(
            remote_display("http://192.168.1.10:3080/?token=secret123"),
            "192.168.1.10:3080"
        );
        assert_eq!(remote_display("https://dsh.example.cn/"), "dsh.example.cn");
        // 旧格式原样
        assert_eq!(remote_display("192.168.1.10:3080"), "192.168.1.10:3080");
    }

    #[test]
    fn remote_host_port_resolves_urls() {
        assert_eq!(
            remote_host_port("http://192.168.1.10:3080/?token=x"),
            "192.168.1.10:3080"
        );
        // 缺省端口按 scheme 补全
        assert_eq!(remote_host_port("https://dsh.example.cn/"), "dsh.example.cn:443");
        assert_eq!(remote_host_port("192.168.1.10:3080"), "192.168.1.10:3080");
    }

    #[test]
    fn strip_token_query_removes_only_token() {
        assert_eq!(
            strip_token_query("http://127.0.0.1:3080/?token=abc"),
            "http://127.0.0.1:3080/"
        );
        assert_eq!(
            strip_token_query("http://127.0.0.1:3080/?token=abc&keep=1"),
            "http://127.0.0.1:3080/?keep=1"
        );
        assert_eq!(
            strip_token_query("http://127.0.0.1:3080/?keep=1&token=abc&keep2=2"),
            "http://127.0.0.1:3080/?keep=1&keep2=2"
        );
        // 旧格式原样返回
        assert_eq!(strip_token_query("192.168.1.10:3080"), "192.168.1.10:3080");
    }

    #[test]
    fn extract_token_from_url_reads_query() {
        assert_eq!(
            extract_token_from_url("http://127.0.0.1:3080/?token=abc_DEF-1").as_deref(),
            Some("abc_DEF-1")
        );
        assert_eq!(extract_token_from_url("http://127.0.0.1:3080/"), None);
        assert_eq!(extract_token_from_url("http://h/?token="), None);
        assert_eq!(extract_token_from_url("not a url"), None);
    }

    #[test]
    fn advanced_marker_query_contains_mode_and_platform() {
        let q = advanced_marker_query();
        assert!(q.starts_with("dsh-desktop-tauriapp-mode=advanced&dsh-desktop-tauriapp-platform="));
    }

    #[test]
    fn exchange_token_for_cookie_against_live_dsh() {
        // 起一个模拟 dsh 的最小 303+Set-Cookie 服务，验证裸 HTTP 交换与解析
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            // 校验请求行携带 token
            assert!(req.starts_with("GET /?token=testtok123 HTTP/1.1"), "请求行: {req}");
            let resp = concat!(
                "HTTP/1.1 303 See Other\r\n",
                "cache-control: no-store\r\n",
                "location: /\r\n",
                "set-cookie: dsh-auth-127.0.0.1_3080=v1.abc.def; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict\r\n",
                "\r\n"
            );
            sock.write_all(resp.as_bytes()).unwrap();
        });
        let got = exchange_token_for_cookie(&addr.to_string(), "testtok123");
        server.join().unwrap();
        assert_eq!(
            got,
            Some((
                "dsh-auth-127.0.0.1_3080".to_string(),
                "v1.abc.def".to_string()
            ))
        );
    }

    #[test]
    fn exchange_token_for_cookie_rejects_non_redirect() {
        // 对端回 401（token 错）时应返回 None 而非 panic
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf);
            let _ = sock.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        });
        let got = exchange_token_for_cookie(&addr.to_string(), "badtoken");
        server.join().unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn exchange_token_for_cookie_unreachable_is_none() {
        // 连接不存在的端口：应干净返回 None（不 panic、不超时挂死）
        let got = exchange_token_for_cookie("127.0.0.1:1", "tok");
        assert_eq!(got, None);
    }

    #[test]
    fn version_key_parses_semver() {
        assert_eq!(version_key(std::path::Path::new("v22.12.0")), (22, 12, 0));
        assert_eq!(version_key(std::path::Path::new("v1.2.3.4")), (1, 2, 3));
        assert_eq!(version_key(std::path::Path::new("not-a-version")), (0, 0, 0));
    }

    #[test]
    fn version_key_orders_correctly() {
        // 字符串排序会把 v9.11.0 排在 v22.12.0 之后（'9' > '2'），
        // 这是此前取错"最新版本"的 bug，必须由 semver 键规避。
        let v9 = version_key(std::path::Path::new("v9.11.0"));
        let v22 = version_key(std::path::Path::new("v22.12.0"));
        assert!(v9 < v22, "v9.11.0 应小于 v22.12.0");
        let v2 = version_key(std::path::Path::new("v2.0.0"));
        let v10 = version_key(std::path::Path::new("v10.0.0"));
        assert!(v2 < v10, "v2.0.0 应小于 v10.0.0");
    }

    #[test]
    fn random_token_nonempty_and_unique() {
        let a = random_token();
        let b = random_token();
        assert!(!a.is_empty());
        assert_ne!(a, b, "连续两次生成的 token 不应相同");
    }

    #[test]

    #[test]
    fn dsh_state_default_field_types() {
        // DshState 新增字段（notify_port / notify_token / restarting）默认值校验。
        use std::sync::atomic::Ordering;
        let state = DshState {
            child: Mutex::new(None),
            spawned_this_run: AtomicBool::new(false),
            mode_prompt_needed: AtomicBool::new(false),
            mode: AtomicU8::new(MODE_ADVANCED),
            status: AtomicU8::new(STATUS_IDLE),
            loading_url: Mutex::new(None),
            tray: Mutex::new(None),
            spawn_failed: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
            ready_once: AtomicBool::new(false),
            pending_input: Mutex::new(None),
            quitting: AtomicBool::new(false),
            tray_tip_shown: AtomicBool::new(false),
            unread: AtomicU32::new(0),
            pet_save_at: Mutex::new(None),
            notify_port: AtomicU16::new(0),
            notify_token: Mutex::new(String::new()),
            web_token: Mutex::new(String::new()),
            pre_zoom_geom: Mutex::new(None),
        };
        assert!(!state.restarting.load(Ordering::SeqCst));
        assert_eq!(state.notify_port.load(Ordering::SeqCst), 0);
        assert!(state.notify_token.lock().unwrap().is_empty());
        assert!(state.pre_zoom_geom.lock().unwrap().is_none());
    }

    #[test]
    fn pre_zoom_geom_starts_unset() {
        // 双击放大前的几何必须从 None 起步，否则启动后第一次双击会把当前尺寸
        // 当成"已放大态"误恢复回去。
        let g = Mutex::new(None);
        assert!(g.lock().unwrap().is_none());
        *g.lock().unwrap() = Some((tauri::PhysicalPosition::new(100, 200),
                                    tauri::PhysicalSize::new(800, 600)));
        assert!(g.lock().unwrap().is_some());
    }

    #[test]
    fn spawn_error_display() {
        assert_eq!(SpawnError::NotFound("nope".into()).to_string(), "nope");
        assert_eq!(SpawnError::Other("boom".into()).to_string(), "boom");
    }

    // —— 共享模块池挂载（bug #22：scoped 包名挂载）——

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


#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn legacy_desktop_block_claims_our_schema() {
    let v: serde_yaml::Value = serde_yaml::from_str("desktop:\n  port: 3081\n  active_profile: web\n").unwrap();
    assert!(legacy_desktop_block(&v).is_some());
  }

  #[test]
  fn legacy_desktop_block_ignores_foreign_blocks() {
    let v: serde_yaml::Value = serde_yaml::from_str("desktop-launcher:\n  enabled: false\n  announceToAgent: false\n").unwrap();
    assert!(legacy_desktop_block(&v).is_none());
  }

  #[test]
  fn desktop_settings_serde_roundtrip() {
    let s = DesktopSettings {
      port: Some(3081),
      active_profile: Some("web".into()),
      remote_addr: None,
      remote_list: vec!["x.cn:3091".into()],
      lane_port: Some(3092),
      cloudflared_bin: Some("/opt/bin/cloudflared".into()),
    };
    let y = serde_yaml::to_string(&s).unwrap();
    let back: DesktopSettings = serde_yaml::from_str(&y).unwrap();
    assert_eq!(back.port, Some(3081));
    assert_eq!(back.active_profile.as_deref(), Some("web"));
    assert_eq!(back.remote_list, vec!["x.cn:3091".to_string()]);
    assert_eq!(back.lane_port, Some(3092));
    assert_eq!(back.cloudflared_bin.as_deref(), Some("/opt/bin/cloudflared"));
  }
}