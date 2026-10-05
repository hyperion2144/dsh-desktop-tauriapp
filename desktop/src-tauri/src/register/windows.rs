//! Windows 检测与执行（图 #169 / 票 #175+#177；事实依据 #174）。
//!
//! 本文件整体 cfg(windows)——本机（macOS）编译不到，接口签名以 windows-sys 0.61
//! bindings 为准静态核对（AGENTS.md 血泪坑 6），CI Windows 构建把关。纯逻辑
//! （PATH 拆分/拼接/幂等插入/首命中）已抽到平台中立的 `super::pathlist` 并落了单测。

#![cfg(target_os = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, LPARAM, WPARAM};
use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ,
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
};

use super::{run_with_timeout, ApplyOutcome, DETECT_TIMEOUT_SECS};

/// PATH 探测的扩展名（PATHEXT 官方默认序里 dsh 会命中的子集，#174 #16）。
const DSH_PROBES: [&str; 3] = ["dsh.cmd", "dsh.exe", "dsh.bat"];

/// 解析用户环境里的 `dsh`：`where dsh` 首行 = 实际会执行者（#174 #15）。
///
/// 注意（#174 #13/#14）：进程 PATH = 系统 PATH + 用户 PATH（系统在前）——
/// 用户级「前置」赢不过系统 PATH 里的既有 dsh，该场景由注册后的模拟解析
/// 如实提示（`notify_if_shadowed`，决策 #170/Q9）。
///
/// 返回 `None` = 检测不确定（超时/失败），调用方保持旧缓存；
/// `Some(None)` = 解析不到 dsh（`where` 未命中 / stdout 为空）。
pub(crate) fn resolve() -> Option<Option<PathBuf>> {
    let out = run_with_timeout(Command::new("where").arg("dsh"), DETECT_TIMEOUT_SECS)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(first) = super::extract_first_nonempty_line(&text) else {
        return Some(None);
    };
    let cleaned = super::strip_ansi(first).trim().to_string();
    if cleaned.is_empty() {
        return Some(None);
    }
    Some(Some(PathBuf::from(cleaned)))
}

/// 注册执行（#177）：shim 目录写入用户级 PATH（HKCU\Environment\Path）+ 广播。
///
/// - 普通注册 = **追加尾部**（不抢用户已有 dsh）；force（强制覆盖）= **前置首位**；
///   PATH 已含 shim 目录则幂等不动（保留其原位置/原写法）——决策 #170/Q9。
/// - 注册表读写**保持 REG_EXPAND_SZ 原类型与未展开段**（#174 #4：用
///   RegOpenKeyExW+RegQueryValueExW 原始读取，不走 RegGetValueW 的自动展开；
///   禁用 setx——1024 截断/毁变量引用/合并污染，#174 #18-20）。
/// - 写完广播 WM_SETTINGCHANGE（已开终端不受影响，新开终端生效，#174 #11/#12）。
pub(crate) fn perform(app: &AppHandle, force: bool) -> Result<ApplyOutcome, String> {
    // shim 目录物化（同 macOS：外部 CLI 模式拒绝——那一份 dsh 本来就在用户 PATH）
    let Some(shim_dir) = crate::profiles::ensure_dsh_shim_dir(app) else {
        return Err("外部 CLI 模式下无需注册：系统里的 dsh 即你配置的外部 CLI".into());
    };
    let dir_s = shim_dir.to_string_lossy().trim_end_matches('\\').to_string();

    let (raw, vtype) = read_user_path_raw()?;
    let parts_raw = super::pathlist::split(&raw);
    // 成员比较用「展开后」的形态：raw 里可能存的是 %USERPROFILE% 引用（#174 #4）
    let parts_exp: Vec<String> = parts_raw.iter().map(|p| expand_env(p)).collect();
    let new_raw = match super::pathlist::find_ci(&parts_exp, &dir_s) {
        // 幂等：已含 shim 目录 → 不动（已在首位；或追加语义下已在 PATH 任何位置）
        Some(0) => None,
        Some(_) if !force => None,
        // force：已在 PATH 但不在首位 → 原段移动到最前（保留原始写法，未展开段不动）
        Some(i) => Some(super::pathlist::join(&super::pathlist::move_to_front(
            &parts_raw, i,
        ))),
        // 不在 PATH → 追加尾部 / 前置首位
        None => {
            let mut np = parts_raw.clone();
            if force {
                np.insert(0, dir_s.clone());
            } else {
                np.push(dir_s.clone());
            }
            Some(super::pathlist::join(&np))
        }
    };
    if let Some(new_raw) = new_raw {
        write_user_path_raw(&new_raw, vtype)?;
        broadcast_env_change();
    }
    // 模拟「新终端」解析（系统 PATH + 用户 PATH 拼接，#174 #13）：仍被前序遮蔽时
    // 如实提示（系统 PATH 前序用户级无法赢——票面 fog 项的落地）。
    notify_if_shadowed(app, &dir_s);
    Ok(ApplyOutcome::Done)
}

/// 读 HKCU\Environment\Path 的「原始未展开值 + 类型」。
/// 值不存在（干净机器）→ ("", REG_EXPAND_SZ)——写入时按可展开类型落盘。
fn read_user_path_raw() -> Result<(String, u32), String> {
    match query_reg_raw(HKEY_CURRENT_USER, "Environment", "Path")? {
        Some((raw, vtype)) => Ok((raw, vtype)),
        None => Ok((String::new(), REG_EXPAND_SZ)),
    }
}

/// 通用注册表值原始读取（不做环境变量展开）。`Ok(None)` = 值不存在。
fn query_reg_raw(
    hroot: HKEY,
    subkey: &str,
    value: &str,
) -> Result<Option<(String, u32)>, String> {
    unsafe {
        let sub = utf16(subkey);
        let mut hkey: HKEY = std::ptr::null_mut();
        let rc = RegOpenKeyExW(hroot, sub.as_ptr(), 0, KEY_QUERY_VALUE, &mut hkey);
        if rc != ERROR_SUCCESS {
            return Err(format!("RegOpenKeyExW({subkey}) 失败：code {rc}"));
        }
        let name = utf16(value);
        let mut vtype: u32 = 0;
        let mut size: u32 = 0;
        let rc = RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null(),
            &mut vtype,
            std::ptr::null_mut(),
            &mut size,
        );
        if rc == ERROR_FILE_NOT_FOUND {
            RegCloseKey(hkey);
            return Ok(None);
        }
        if rc != ERROR_SUCCESS {
            RegCloseKey(hkey);
            return Err(format!("RegQueryValueExW({value}) 探大小失败：code {rc}"));
        }
        let mut buf = vec![0u8; size as usize];
        let rc = RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null(),
            &mut vtype,
            buf.as_mut_ptr(),
            &mut size,
        );
        RegCloseKey(hkey);
        if rc != ERROR_SUCCESS {
            return Err(format!("RegQueryValueExW({value}) 读取失败：code {rc}"));
        }
        buf.truncate(size as usize);
        let wide: Vec<u16> = buf
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let s = String::from_utf16_lossy(&wide)
            .trim_end_matches('\0')
            .to_string();
        Ok(Some((s, vtype)))
    }
}

/// 以「读到的原类型」写回（REG_EXPAND_SZ 不可退化为 REG_SZ，#174 #2/#4）。
fn write_user_path_raw(raw: &str, vtype: u32) -> Result<(), String> {
    unsafe {
        let sub = utf16("Environment");
        let mut hkey: HKEY = std::ptr::null_mut();
        let rc = RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_SET_VALUE, &mut hkey);
        if rc != ERROR_SUCCESS {
            return Err(format!("RegOpenKeyExW(Environment) 失败：code {rc}"));
        }
        let name = utf16("Path");
        let mut bytes: Vec<u8> = raw
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        bytes.extend_from_slice(&[0, 0]); // UTF-16 NUL 终止
        let rc = RegSetValueExW(hkey, name.as_ptr(), 0, vtype, bytes.as_ptr(), bytes.len() as u32);
        RegCloseKey(hkey);
        if rc != ERROR_SUCCESS {
            return Err(format!("RegSetValueExW(Path) 失败：code {rc}"));
        }
        Ok(())
    }
}

}

/// 广播环境变量变更（资源管理器等「感兴趣的应用」即时更新；已开终端不受影响，#174 #11/#12）。
/// 挂起窗口不阻塞（SMTO_ABORTIFHUNG + 2s 超时）；广播失败不影响注册本身（注册表已落）。
fn broadcast_env_change() {
    unsafe {
        let env = utf16("Environment");
        let mut ret: usize = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0 as WPARAM,
            env.as_ptr() as LPARAM,
            SMTO_ABORTIFHUNG,
            2000,
            &mut ret,
        );
    }
}

/// 展开环境变量引用（仅用于**模拟解析**；写回永远用 raw，#174 #4）。
fn expand_env(s: &str) -> String {
    unsafe {
        let src = utf16(s);
        let need = ExpandEnvironmentStringsW(src.as_ptr(), std::ptr::null_mut(), 0);
        if need == 0 {
            return s.to_string();
        }
        let mut buf = vec![0u16; need as usize];
        let got = ExpandEnvironmentStringsW(src.as_ptr(), buf.as_mut_ptr(), need);
        if got == 0 || got as usize > buf.len() {
            return s.to_string();
        }
        String::from_utf16_lossy(&buf[..got as usize - 1]) // 去 NUL
    }
}

/// 模拟「新终端」解析并按遮蔽来源如实提示（#174 #13：系统 PATH + 用户 PATH，系统在前）。
fn notify_if_shadowed(app: &AppHandle, dir_s: &str) {
    let sys = match query_reg_raw(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        "Path",
    ) {
        Ok(Some((raw, _))) => expand_env(&raw),
        _ => String::new(),
    };
    let usr = match read_user_path_raw() {
        Ok((raw, _)) => expand_env(&raw),
        Err(_) => String::new(),
    };
    let mut dirs: Vec<String> = Vec::new();
    dirs.extend(super::pathlist::split(&sys));
    dirs.extend(super::pathlist::split(&usr));
    let probe = |d: &str| DSH_PROBES.iter().any(|ext| Path::new(d).join(ext).exists());
    let Some(first) = super::pathlist::first_hit(&dirs, &probe) else {
        return; // 无任何 dsh：新终端将直接命中本壳，通用成功通知已覆盖
    };
    let first = first.trim();
    if first.eq_ignore_ascii_case(dir_s) {
        log::info!("[register] 模拟新终端解析：dsh 命中本壳 shim 目录");
        return;
    }
    let in_system = super::pathlist::split(&sys)
        .iter()
        .any(|d| d.trim().eq_ignore_ascii_case(first));
    let (title, body) = if in_system {
        (
            "dsh 已注册（存在系统级遮蔽）".to_string(),
            format!(
                "用户级 PATH 无法覆盖系统 PATH：新终端的 dsh 仍解析到 {first}。如需本壳接管，请手动调整系统 PATH 或移除该条目"
            ),
        )
    } else {
        (
            "dsh 已注册（追加尾部，未抢已有 dsh）".to_string(),
            format!(
                "新终端的 dsh 仍先解析到 {first}（用户 PATH 前序）。如需本壳接管，请在托盘「注册 dsh 为系统命令（检测到冲突）」中走强制覆盖（前置首位）"
            ),
        )
    };
    crate::show_notification(
        app,
        crate::network::notify_policy::scenario::CONFIG_INFO,
        &title,
        &body,
    );
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
