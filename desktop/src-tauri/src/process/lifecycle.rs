//! DshLifecycle trait：dsh 子进程生命周期抽象。
//!
//! 设计来源：wayfinder 票据 #46 决议。
//! - 两个 impl：NativeLifecycle（unix 直接调 dsh 二进制）/ JsLifecycle（Windows 调 node bin.js）。
//! - `#[cfg]` 编译期选择 impl。
//! - `port_open` / `listener_pids` / `stop_port_owner` 跨平台通用，不进 trait。
//!
//! 实现迁移自 lib.rs（票据 #49）。

use std::{
    io::{BufRead, BufReader},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::runtime::error::SpawnError;
use crate::settings::{configured_cloudflared_bin, lane_port_for_profile};
use crate::network::proxy::inject_proxy_env;
use crate::network::web_token::{parse_web_token_line, store_web_token};

// ── 自由函数（跨平台通用）──────────────────────────────────

/// 从 nvm 版本目录名（如 v22.12.0）解析可比较的版本键；无法解析的返回 (0,0,0)。
/// 注意：目录名必须按 semver 比较排序，字符串排序会把 v9.11.0 排在 v22.12.0 之后。
pub(crate) fn version_key(path: &std::path::Path) -> (u64, u64, u64) {
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

/// 探测 127.0.0.1:port 是否已有服务在监听。
pub(crate) fn port_open(port: u16) -> bool {
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
pub(crate) fn listener_pids(port: u16) -> Vec<u32> {
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

// ── 平台特定：kill_process / kill_process_force ──────────────

#[cfg(not(target_os = "windows"))]
pub(crate) fn kill_process(pid: u32) {
    // SIGTERM：dsh web 通常可优雅退出
    let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn kill_process_force(pid: u32) {
    let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
}

#[cfg(target_os = "windows")]
pub(crate) fn kill_process(pid: u32) {
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
pub(crate) fn kill_process_force(pid: u32) {
    kill_process(pid)
}

// ── DshLifecycle trait ──────────────────────────────────────

/// dsh 子进程生命周期策略。
pub trait DshLifecycle {
    /// 定位 dsh 可执行文件。
    fn find_binary() -> Option<PathBuf>;
    /// spawn dsh web 子进程（profile 显式传入：#86 起端口与实例按 profile 隔离）。
    fn spawn(app: &AppHandle, profile: &str, port: u16, advanced: bool) -> Result<Child, SpawnError>;
    /// 优雅终止进程（SIGTERM / TerminateProcess）。
    fn kill(pid: u32);
    /// 强制终止进程（SIGKILL / TerminateProcess 再调一次）。
    fn kill_force(pid: u32);
}

// ── Unix impl ───────────────────────────────────────────────

/// Unix：直接调 dsh 二进制。
#[cfg(unix)]
pub struct NativeLifecycle;

/// 定位 dsh 可执行文件（unix）。
///
/// Finder 启动的 GUI 应用 PATH 里没有终端配置（nvm bin、npm 全局 bin 都不在），
/// 所以除 PATH 外还要探测常见安装位置。
#[cfg(unix)]
pub(crate) fn find_dsh_bin() -> Option<PathBuf> {
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

/// 构造 spawn dsh 时的运行时 PATH（unix）。
///
/// Finder 启动的 GUI 应用 PATH 只有 `/usr/bin:/bin`，而 dsh 是 Node 脚本
/// （shebang 依赖 `node`）。把 dsh 所在目录、nvm 各版本 bin、Homebrew 等
/// 候选目录补充到子进程 PATH 前面。
#[cfg(unix)]
pub(crate) fn dsh_runtime_path(bin: &std::path::Path) -> std::ffi::OsString {
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

/// 内置模式的静态兑底 PATH（登录 shell 恢复失败时使用）。
const FALLBACK_TOOL_PATH: &str =
    "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// 登录 shell 候选链：用户默认 shell 优先，常见绝对路径兑底（#/bin/zsh 硬编码不可靠）。
#[cfg(unix)]
fn login_shell_candidates() -> Vec<std::path::PathBuf> {
    let mut list: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() {
            list.push(std::path::PathBuf::from(s));
        }
    }
    for p in ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"] {
        let cand = std::path::PathBuf::from(p);
        if !list.contains(&cand) {
            list.push(cand);
        }
    }
    list
}

/// 单个 shell 的 PATH 捕获：按 basename 区分参数（fish 的 PATH 是数组、
/// sh 无 -i 交互模式）；多行输出按 ':' 拼（fish 逐行打印兼容）；
/// 失败/空输出/无路径形状 → None。
#[cfg(unix)]
fn capture_path_with(shell: &std::path::Path) -> Option<String> {
    let name = shell.file_name()?.to_string_lossy().to_string();
    let args: Vec<&str> = if name == "fish" {
        vec!["-l", "-c", "printf '%s\\n' $PATH"]
    } else if name.contains("zsh") || name.contains("bash") {
        vec!["-lic", "echo $PATH"]
    } else {
        vec!["-lc", "echo $PATH"]
    };
    let out = std::process::Command::new(shell)
        .args(&args)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let path = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join(":")
        .trim()
        .to_string();
    (path.contains('/')).then_some(path)
}

/// 登录 shell PATH 恢复（anywhere-labs 模式简版）：候选链逐个尝试，全部失败
/// 返回 None 由调用方走静态兑底。Windows 走继承 PATH（CI 把关）。
pub(crate) fn recover_login_path() -> Option<String> {
    #[cfg(unix)]
    {
        login_shell_candidates()
            .iter()
            .filter(|s| s.exists())
            .find_map(|s| capture_path_with(s))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// spawn `dsh web --host 127.0.0.1 --port <port>`（unix）；stdout/stderr 转发到日志，
/// 并实时 emit 到启动加载页的「本地服务输出」控制台（`dsh-console` 事件）。
#[cfg(unix)]
pub(crate) fn spawn_dsh(app: &tauri::AppHandle, profile: &str, port: u16, advanced: bool) -> Result<Child, SpawnError> {
    // 来源解析（#85 拍板）：内置 → node + 启动器（runProfile 代码路径）；外部 → CLI
    log::info!("[spawn] 启动 dsh（profile={profile}, port={port}）");
    // bundle 补链（anywhere-labs heal 式）：内置树缺失的 profile bundle 从用户
    // 外部 CLI 安装树 symlink 进 profile 池，让内置 dsh 能解析存量插件
    crate::process::plugin::heal_profile_bundles(app, profile);
    // #90 实测：非激活 profile 的池里没有桌面三插件 → --patch loader 条目解析失败 → 实例秒退
    // 未初始化的 profile（无 package.json）跳过预挂池：先物化会让 fromDefaultProfile
    // 初始化撞上非空目录失败（#90 实测闪退根因）；初始化完成后再挂（自动补建流程负责）
    if crate::dsh_home()
        .join("profiles")
        .join(profile)
        .join("package.json")
        .is_file()
    {
        crate::process::plugin::materialize_desktop_plugin_for(app, profile);
    }
    let mut patches: Vec<std::path::PathBuf> = Vec::new();
    if advanced {
        // --patch 仅在高级模式注入（桌面 chrome / mobile-access / mobile-nav）；
        // 兼容模式不注入，行为等同纯 dsh（用户实测需求）
        patches.push(crate::desktop_plugin_patch_path(app));
    }
    if let Ok(patch) = std::env::var("DSH_DESKTOP_EXTRA_PATCH") {
        if !patch.trim().is_empty() {
            patches.push(patch.into());
        }
    }
    let source = crate::runtime::builtin::resolve_source(app).map_err(SpawnError::Other)?;
    let (bin, launcher_args) = match &source {
        crate::runtime::builtin::DshSource::Builtin { node, dsh_lib, launcher } => {
            log::info!("[spawn] 内置模式：node + runProfile（不经 CLI）");
            let init_from_default = !crate::profiles::profile_exists(profile);
            (node.clone(), crate::runtime::builtin::launcher_args(launcher, dsh_lib, profile, port, &patches, init_from_default))
        }
        crate::runtime::builtin::DshSource::External { bin } => {
            log::info!("[spawn] 外部模式：CLI（--patch 必须早于 --no-open，passThrough 顺序）");
            (bin.clone(), crate::runtime::builtin::external_cli_args(profile, port, &patches))
        }
    };
    let source_mode = match &source {
        crate::runtime::builtin::DshSource::Builtin { .. } => "builtin",
        crate::runtime::builtin::DshSource::External { .. } => "external",
    };
    let mut cmd = Command::new(&bin);
    cmd.args(&launcher_args);
    if matches!(source, crate::runtime::builtin::DshSource::External { .. }) {
        // 外部 dsh 是 Node 脚本（shebang 依赖 node）：Finder 启动的 GUI PATH 缺 node，
        // 按现有链路补齐运行时 PATH；
        cmd.env("PATH", dsh_runtime_path(&bin));
    } else {
        // 内置模式（#90 实测）：Finder 启动的 App 只有系统 PATH，dsh 的插件子进程
        // （git/gh/pnpm 等工具链检测）会全部落空。用用户登录 shell 恢复完整 PATH
        // （anywhere-labs 模式简版）；恢复失败回退静态常见目录。
        //
        // #119：shim 目录（内置 node/pnpm）必须**前置**——dsh 的插件管理会裸调 `pnpm`，
        // 若命中用户系统 pnpm（实测 11.16.0，store/v11）而 profile 的 node_modules 是
        // 内置 pnpm（10.34.5，store/v10）装的，会报 ERR_PNPM_UNEXPECTED_STORE，
        // 导致 dsh 自带的插件卸载/安装全部失败。shim 把 pnpm/node 钉回内置版本。
        let mut parts: Vec<std::path::PathBuf> = Vec::new();
        if let Some(shim) = crate::profiles::ensure_node_shim_dir(app) {
            parts.push(shim);
        }
        let login = recover_login_path();
        match &login {
            Some(p) => parts.extend(std::env::split_paths(p)),
            None => parts.extend(std::env::split_paths(FALLBACK_TOOL_PATH)),
        }
        match std::env::join_paths(parts) {
            Ok(joined) => {
                cmd.env("PATH", joined);
            }
            Err(e) => {
                log::warn!("[spawn] 拼 PATH 失败，回退登录 PATH：{e}");
                cmd.env("PATH", login.unwrap_or_else(|| FALLBACK_TOOL_PATH.to_string()));
            }
        }
    }
    let lane = lane_port_for_profile(profile);
    cmd.env("DSH_MOBILE_LANE_PORT", lane.to_string())
        .env("DSH_MOBILE_ENABLED", "1")
        .env("DSH_DESKTOP_PORT", port.to_string());
    let cloudflared = configured_cloudflared_bin();
    if !cloudflared.is_empty() {
        cmd.env("DSH_CLOUDFLARED_BIN", cloudflared);
    }
    // 代理继承：按设置注入 HTTP(S)_PROXY/ALL_PROXY/NO_PROXY（大小写各一）；off/检测失败不注入
    inject_proxy_env(&mut cmd);
    // GUI 应用（Finder 启动）的 cwd 是 /（不可写）：dsh-mnemon 的 workspace 存储域
    // 用 process.cwd() 作 .mnemon 根，子进程继承 / 会报 ENOENT 起不来（终端启动
    // 无此问题，因为终端 cwd 是可写目录）。显式把子进程 cwd 设为 dsh home：
    // .mnemon 等工作区相对产物统一落进 $DSH_HOME/.mnemon，归属 harness 单一根。
    cmd.current_dir(crate::dsh_home());
    // 启动保险丝（#58）：为本实例建 stderr 累积缓冲——转发线程逐行写入，
    // 保险丝监控任务在子进程退出后取快照做失败检测。
    let stderr_buf: crate::process::quarantine::SharedStderr = std::sync::Arc::new(
        std::sync::Mutex::new(crate::process::quarantine::StderrBuffer::default()),
    );
    app.state::<crate::runtime::state::DshState>()
        .set_stderr_buf(profile, stderr_buf.clone());
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
    crate::runtime::instances::register_instance(profile, port, lane, child.id(), source_mode);
    app.state::<crate::runtime::state::DshState>().set_running_source(profile, source_mode);
    if let Some(out) = child.stdout.take() {
        let profile = profile.to_string();
        let app = app.clone();
        thread::spawn(move || {
            // split(b'\n') + from_utf8_lossy：`.lines().map_while(Result::ok)` 遇到
            // 非法 UTF-8 字节会静默终止整个转发循环（控制台输出中断的根因）
            for raw in BufReader::new(out).split(b'\n') {
                let Ok(bytes) = raw else { break };
                let mut line = String::from_utf8_lossy(&bytes).to_string();
                if line.ends_with('\r') {
                    line.pop();
                }
                // dsh 新版在 stdout 打印带 process token 的启动 URL：解析后存入
                // state 供就绪导航拼接（无该行的老版 dsh 走不带 token 的回退路径）。
                if let Some(token) = parse_web_token_line(&line) {
                    app.state::<crate::runtime::state::DshState>()
                        .set_web_token(&profile, token.clone());
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
        let stderr_buf = stderr_buf.clone();
        thread::spawn(move || {
            // 同 stdout：lossy 解码，非法字节不断流
            for raw in BufReader::new(err).split(b'\n') {
                let Ok(bytes) = raw else { break };
                let mut line = String::from_utf8_lossy(&bytes).to_string();
                if line.ends_with('\r') {
                    line.pop();
                }
                log::warn!("[dsh] {line}");
                stderr_buf.lock().unwrap().push(&line);
                let _ = app
                    .emit("dsh-console", serde_json::json!({ "stream": "stderr", "line": line }));
            }
        });
    }
    Ok(child)
}

#[cfg(unix)]
impl DshLifecycle for NativeLifecycle {
    fn find_binary() -> Option<PathBuf> {
        find_dsh_bin()
    }

    fn spawn(app: &AppHandle, profile: &str, port: u16, advanced: bool) -> Result<Child, SpawnError> {
        spawn_dsh(app, profile, port, advanced)
    }

    fn kill(pid: u32) {
        kill_process(pid)
    }

    fn kill_force(pid: u32) {
        kill_process_force(pid)
    }
}

// ── Windows impl ────────────────────────────────────────────

/// Windows：node bin.js 方式启动。
#[cfg(windows)]
pub struct JsLifecycle;

/// Windows：定位 node.exe（nvm-windows / 官方安装器 / PATH）。
#[cfg(windows)]
pub(crate) fn find_node() -> Option<PathBuf> {
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
pub(crate) fn find_dsh_bin_js() -> Option<PathBuf> {
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
pub(crate) fn spawn_dsh(app: &tauri::AppHandle, profile: &str, port: u16, advanced: bool) -> Result<Child, SpawnError> {
    crate::process::plugin::heal_profile_bundles(app, profile);
    crate::process::plugin::materialize_desktop_plugin_for(app, profile);
    use std::os::windows::process::CommandExt;
    // 来源解析（#85 拍板）：内置 → sidecar node + 启动器（runProfile）；外部 → 系统 node + bin.js CLI
    log::info!("[spawn] 启动 dsh（profile={profile}, port={port}）");
    let mut patches: Vec<std::path::PathBuf> = Vec::new();
    if advanced {
        // 历史上 windows 分支无条件注 --patch；#85 统一为与 unix 一致的 advanced 语义
        patches.push(crate::desktop_plugin_patch_path(app));
    }
    if let Ok(patch) = std::env::var("DSH_DESKTOP_EXTRA_PATCH") {
        if !patch.trim().is_empty() {
            patches.push(patch.into());
        }
    }
    let source = crate::runtime::builtin::resolve_source(app).map_err(SpawnError::Other)?;
    let (node, launcher_args) = match &source {
        crate::runtime::builtin::DshSource::Builtin { node, dsh_lib, launcher } => {
            log::info!("[spawn] 内置模式：node + runProfile（不经 CLI）");
            let init_from_default = !crate::profiles::profile_exists(profile);
            (node.clone(), crate::runtime::builtin::launcher_args(launcher, dsh_lib, profile, port, &patches, init_from_default))
        }
        crate::runtime::builtin::DshSource::External { bin } => {
            let node = find_node().ok_or_else(|| {
                SpawnError::NotFound(
                    "未找到 node.exe。请安装 Node.js 或设置 DSH_NODE 环境变量。".to_string(),
                )
            })?;
            log::info!("[spawn] 外部模式：node + bin.js CLI（--patch 必须早于 --no-open）");
            let mut a = vec![bin.clone().into_os_string()];
            a.extend(crate::runtime::builtin::external_cli_args(profile, port, &patches));
            (node, a)
        }
    };
    let source_mode = match &source {
        crate::runtime::builtin::DshSource::Builtin { .. } => "builtin",
        crate::runtime::builtin::DshSource::External { .. } => "external",
    };
    let mut cmd = Command::new(&node);
    let lane = lane_port_for_profile(profile);
    cmd.arg("--use-env-proxy"); // Node.js fetch 代理：必须命令行参数（NODE_OPTIONS 不允许此 flag）
    cmd.args(&launcher_args)
        .env("DSH_MOBILE_LANE_PORT", lane.to_string())
        .env("DSH_MOBILE_ENABLED", "1")
        .env("DSH_DESKTOP_PORT", port.to_string());
    let cloudflared = configured_cloudflared_bin();
    if !cloudflared.is_empty() {
        cmd.env("DSH_CLOUDFLARED_BIN", cloudflared);
    }
    // 代理继承：同 unix 分支，按设置注入代理环境变量；off/检测失败不注入
    inject_proxy_env(&mut cmd);
    // 同 unix 分支：GUI 启动的 cwd 是 /，必须显式设 dsh home（mnemon workspace 域）
    cmd.current_dir(crate::dsh_home());
    // 启动保险丝（#58）：同 unix 分支，建 stderr 累积缓冲。
    let stderr_buf: crate::process::quarantine::SharedStderr = std::sync::Arc::new(
        std::sync::Mutex::new(crate::process::quarantine::StderrBuffer::default()),
    );
    app.state::<crate::runtime::state::DshState>()
        .set_stderr_buf(profile, stderr_buf.clone());
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| SpawnError::Other(format!("spawn node {} 失败：{e}", node.display())))?;
    log::info!(
        "已启动 dsh web（node {} {}，PID {}）",
        node.display(),
        launcher_args.first().map(|a| a.to_string_lossy().to_string()).unwrap_or_default(),
        child.id()
    );
    // 实例台账（#86）：同 unix 分支
    crate::runtime::instances::register_instance(profile, port, lane, child.id(), source_mode);
    app.state::<crate::runtime::state::DshState>().set_running_source(profile, source_mode);
    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        let profile = profile.to_string();
        thread::spawn(move || {
            // split(b'\n') + from_utf8_lossy：非法 UTF-8 字节不断流（同 unix 分支）
            for raw in BufReader::new(out).split(b'\n') {
                let Ok(bytes) = raw else { break };
                let mut line = String::from_utf8_lossy(&bytes).to_string();
                if line.ends_with('\r') {
                    line.pop();
                }
                // dsh 新版在 stdout 打印带 process token 的启动 URL：解析后存入
                // state 供就绪导航拼接（无该行的老版 dsh 走不带 token 的回退路径）。
                if let Some(token) = parse_web_token_line(&line) {
                    app.state::<crate::runtime::state::DshState>()
                        .set_web_token(&profile, token.clone());
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
        let stderr_buf = stderr_buf.clone();
        thread::spawn(move || {
            // 同 stdout：lossy 解码，非法字节不断流
            for raw in BufReader::new(err).split(b'\n') {
                let Ok(bytes) = raw else { break };
                let mut line = String::from_utf8_lossy(&bytes).to_string();
                if line.ends_with('\r') {
                    line.pop();
                }
                log::warn!("[dsh] {line}");
                stderr_buf.lock().unwrap().push(&line);
                let _ = app
                    .emit("dsh-console", serde_json::json!({ "stream": "stderr", "line": line }));
            }
        });
    }
    Ok(child)
}

#[cfg(windows)]
impl DshLifecycle for JsLifecycle {
    fn find_binary() -> Option<PathBuf> {
        find_dsh_bin_js()
    }

    fn spawn(app: &AppHandle, profile: &str, port: u16, advanced: bool) -> Result<Child, SpawnError> {
        spawn_dsh(app, profile, port, advanced)
    }

    fn kill(pid: u32) {
        kill_process(pid)
    }

    fn kill_force(pid: u32) {
        kill_process_force(pid)
    }
}

/// 停掉监听 `port` 的所有进程并等待端口释放（尽力而为，返回端口是否已释放）。
/// 纯代码：先 SIGTERM（Windows TerminateProcess）让其优雅退出，~2.4s 内没释放再
/// SIGKILL（Windows 幂等再 TerminateProcess 一次）。调用方据此决定是否中止。
pub(crate) async fn stop_port_owner(port: u16) -> bool {
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


#[cfg(test)]
mod tests {
    use super::*;

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

}
