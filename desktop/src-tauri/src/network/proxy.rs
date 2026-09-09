//! ProxyProvider trait + 代理环境策略实现 + 代理辅助函数。
//!
//! 迁移自 lib.rs 功能区域 3（proxy）。
//! 设计来源：wayfinder 票据 #46 决议。
//! - 三个 ProxyProvider impl：SystemProxy / ManualProxy / OffProxy。
//! - resolved_proxy_env() 是工厂函数（按 settings 选策略并执行）。
//! - inject_proxy_credentials / apply_proxy_env / inject_proxy_env 保持通用函数。

use std::process::Command;

use crate::settings::{DesktopSettings, load_desktop_settings};

// ==================== 代理设置 ====================
// 托盘「代理设置」数据模型 + 系统代理检测 + spawn 注入
//（依研究票《系统代理检测机制事实调查（macOS/Windows）》结论，docs/agents/research-tray-proxy-system-detection.md）。
// 契约：manual/system 在 spawn dsh 时注入 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY（大小写各一）；
// off/解析失败不注入任何代理变量；只要有代理注入，NO_PROXY 恒含回环保底（localhost,127.0.0.1,::1），
// 保证桌面壳↔本机 dsh web / lane 反代链路绝不被代理劫持。

/// 代理模式取值：off=直连（不注入）。
pub const PROXY_MODE_OFF: &str = "off";
/// 代理模式取值：system=继承系统代理（spawn 时实时读取）。
pub const PROXY_MODE_SYSTEM: &str = "system";
/// 代理模式取值：manual=手动指定（proxy_url 生效）。
pub const PROXY_MODE_MANUAL: &str = "manual";

/// 本地回环 NO_PROXY 保底条目：dsh web / lane 反代全在 127.0.0.1，绝不能进代理。
pub const PROXY_LOOPBACK_ENTRIES: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// 解析完成、可直接注入的代理环境集合。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ProxyEnv {
    /// HTTP_PROXY 值（http:// 代理）。
    pub http: Option<String>,
    /// HTTPS_PROXY 值（http:// 或 https:// 代理）。
    pub https: Option<String>,
    /// ALL_PROXY 值（socks5:// 代理；部分 CLI 工具才识别，尽力而为）。
    pub all: Option<String>,
    /// NO_PROXY 值（逗号分隔，已规范化并合并回环保底）。
    pub no_proxy: String,
}

impl ProxyEnv {
    /// 是否有任何代理 URL（决定 NO_PROXY 是否需要注入）。
    pub fn has_any_proxy(&self) -> bool {
        self.http.is_some() || self.https.is_some() || self.all.is_some()
    }
}

// ── ProxyProvider trait + impl ──────────────────────────────

/// 代理环境解析策略。
pub trait ProxyProvider {
    /// 解析应注入的代理环境；None 表示不注入。
    fn resolve_env(&self) -> Option<ProxyEnv>;
}

/// 系统代理：实时读系统代理设置（macOS scutil / Windows 注册表 / Linux env）。
pub struct SystemProxy;

impl ProxyProvider for SystemProxy {
    fn resolve_env(&self) -> Option<ProxyEnv> {
        system_proxy_env()
    }
}

/// 手动代理：用户配置的 URL。
pub struct ManualProxy {
    pub url: String,
    pub no_proxy: String,
}

impl ProxyProvider for ManualProxy {
    fn resolve_env(&self) -> Option<ProxyEnv> {
        let url = normalize_proxy_url(&self.url)?;
        let entries = if self.no_proxy.is_empty() {
            Vec::new()
        } else {
            normalize_no_proxy_entries(&self.no_proxy)
        };
        let (http, https, all) = if url.starts_with("socks5://") {
            (None, None, Some(url))
        } else {
            let u = url.clone();
            (Some(u), Some(url), None)
        };
        Some(ProxyEnv {
            http,
            https,
            all,
            no_proxy: merge_no_proxy_entries(entries),
        })
    }
}

/// 关闭代理：不注入任何代理环境。
pub struct OffProxy;

impl ProxyProvider for OffProxy {
    fn resolve_env(&self) -> Option<ProxyEnv> {
        None
    }
}

// ── 代理 URL 辅助函数 ──────────────────────────────────────

/// 拆 host[:port]：带方括号的 IPv6（`[::1]:80`）以 `]` 为界；其余按最后一个冒号拆，
/// 端口段必须全数字；纯 IPv6 裸字面量（多冒号无方括号）整体视为主机。
pub fn split_authority(authority: &str) -> (&str, Option<&str>) {
    if let Some(end) = authority.find(']') {
        let host = &authority[..=end];
        let port = authority[end + 1..].strip_prefix(':');
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') && !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
                (h, Some(p))
            }
            _ => (authority, None),
        }
    }
}

/// `scheme + host[:port]` → `<scheme>://<host>:<port>`：
/// 裸 IPv6 主机补方括号；端口缺失用默认（http 80 / https 443 / socks 1080）；socks 统一成 socks5。
pub fn proxy_url_from_authority(scheme: &str, authority: &str, default_port: &str) -> Option<String> {
    let authority = authority.trim();
    // 某些应用会往注册表/输入框里写带 scheme 前缀的值（如 http://proxy:8080），剥离后重拼
    let authority = match authority.find("://") {
        Some(idx) => &authority[idx + 3..],
        None => authority,
    };
    // 代理 URL 含内嵌凭据（user:pass@host）：env 无法安全携带凭据（研究边界 10），剥离并记日志。
    // 只取最后一个 @ 之后的部分：userinfo 里可能含 @，主机段不会。
    let authority = match authority.rfind('@') {
        Some(at) => {
            log::warn!("[proxy] 代理 URL 含内嵌凭据，已剥离（env 不携带凭据）");
            &authority[at + 1..]
        }
        None => authority,
    };
    if authority.is_empty() {
        return None;
    }
    let (host, port) = split_authority(authority);
    if host.is_empty() {
        return None;
    }
    let port = port.filter(|p| !p.is_empty()).unwrap_or(default_port);
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let scheme = if scheme == "socks" { "socks5" } else { scheme };
    Some(format!("{scheme}://{host}:{port}"))
}

/// 校验/规范化手动代理 URL：scheme 限 http/https/socks5/socks，主机必填；
/// 去掉误粘贴的路径/查询片段；IPv6 补方括号；端口缺失按 scheme 默认补全。
pub fn normalize_proxy_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "socks5" | "socks") {
        return None;
    }
    // 用户常多粘贴 "http://host:port/" 之类，只取 authority 部分
    let authority = rest.split(|c| c == '/' || c == '?' || c == '#').next()?;
    let default_port = match scheme.as_str() {
        "https" => "443",
        "socks5" | "socks" => "1080",
        _ => "80",
    };
    proxy_url_from_authority(&scheme, authority, default_port)
}

/// 把 bypass 列表（用户输入 / macOS ExceptionsList / Windows ProxyOverride）规范化为 NO_PROXY 条目：
/// 逗号/分号/空白分隔；`*.x` → `.x`（后缀匹配语义）；`<local>` → 回环组；`*` 保留（绕过一切）；
/// CIDR（含 `/`）在 NO_PROXY 无标准语义，丢弃（多数消费者不支持，字面透传也不生效）。
pub fn normalize_no_proxy_entries(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split(|c| c == ',' || c == ';' || c == ' ' || c == '\t') {
        let entry = part.trim();
        if entry.is_empty() {
            continue;
        }
        let lower = entry.to_ascii_lowercase();
        if lower == "<local>" {
            out.extend(PROXY_LOOPBACK_ENTRIES.iter().map(|s| s.to_string()));
        } else if let Some(suffix) = lower.strip_prefix("*.") {
            if !suffix.is_empty() {
                out.push(format!(".{suffix}"));
            }
        } else if lower.contains('/') {
            // CIDR（如 192.168.0.0/16）在 NO_PROXY 无标准语义，按研究边界 9 丢弃并记日志
            log::warn!("[proxy] NO_PROXY 条目 {entry} 为 CIDR，已丢弃");
        } else {
            out.push(lower);
        }
    }
    out
}

/// 合并 NO_PROXY 条目并始终追加回环保底，去重保序（小写化在规范化阶段完成）。
pub fn merge_no_proxy_entries(entries: Vec<String>) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for e in entries
        .into_iter()
        .chain(PROXY_LOOPBACK_ENTRIES.iter().map(|s| s.to_string()))
    {
        if seen.insert(e.clone()) {
            out.push(e);
        }
    }
    out.join(",")
}

// ── 平台系统代理检测 ───────────────────────────────────────

/// 解析 `scutil --proxy` 输出（NeXT 风格 plist 字典文本，真实样例见研究 §1.2/§1.3）。
/// 规则：以 `XxxEnable == 1` 为准（配置过但禁用的键可能残留）；PAC 启用 → 不注入代理 URL，
/// 仅 NO_PROXY（例外列表 ∪ 回环保底，研究 §2.4/§3.1）。返回 None = 输出不可解析。
#[cfg(any(target_os = "macos", test))]
pub fn parse_scutil_proxy(text: &str) -> Option<ProxyEnv> {
    let mut scalars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut exceptions: Vec<String> = Vec::new();
    let mut in_exceptions = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if in_exceptions {
            if trimmed == "}" {
                in_exceptions = false;
            } else if let Some((idx, value)) = trimmed.split_once(" : ") {
                // 数组元素行形如 `0 : 127.0.0.1`，键是下标
                if !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit()) && !value.is_empty() {
                    exceptions.push(value.to_string());
                }
            }
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(" : ") {
            if value == "<array> {" {
                in_exceptions = true;
            } else {
                scalars.insert(key.to_string(), value.to_string());
            }
        }
    }
    let flag = |k: &str| scalars.get(k).map(|v| v == "1").unwrap_or(false);
    let host_port = |host_key: &str, port_key: &str| -> Option<String> {
        let host = scalars.get(host_key)?;
        if host.is_empty() {
            return None;
        }
        let port = scalars.get(port_key).map(|s| s.as_str()).filter(|s| !s.is_empty());
        Some(match port {
            Some(p) => format!("{host}:{p}"),
            None => host.clone(),
        })
    };
    let no_proxy = merge_no_proxy_entries(normalize_no_proxy_entries(&exceptions.join(",")));
    if flag("ProxyAutoConfigEnable") {
        // PAC：环境变量表达不了按 URL 求值，注入猜错的代理比不注入更糟（研究 §2.4）
        let pac_url = scalars.get("ProxyAutoConfigURLString").map(|s| s.as_str()).unwrap_or("");
        log::info!("[proxy] 系统代理为 PAC（{pac_url}），跳过代理 URL 注入");
        return Some(ProxyEnv {
            http: None,
            https: None,
            all: None,
            no_proxy,
        });
    }
    let mut proxy = ProxyEnv {
        http: None,
        https: None,
        all: None,
        no_proxy,
    };
    if flag("HTTPEnable") {
        proxy.http = host_port("HTTPProxy", "HTTPPort").and_then(|a| proxy_url_from_authority("http", &a, "80"));
    }
    if flag("HTTPSEnable") {
        // https 代理仍是 HTTP CONNECT 代理：URL scheme 表示代理自身协议，写 http://（研究 §3.1）
        proxy.https = host_port("HTTPSProxy", "HTTPSPort").and_then(|a| proxy_url_from_authority("http", &a, "443"));
    }
    if flag("SOCKSEnable") {
        proxy.all = host_port("SOCKSProxy", "SOCKSPort").and_then(|a| proxy_url_from_authority("socks5", &a, "1080"));
    }
    Some(proxy)
}

/// 解析 Windows `ProxyServer` 值为 (http, https, all)（研究 §2.2/§3.2）：
/// 单一格式 `host:port` 对 http/https 同时生效；分协议格式只映射写出且非空的协议；
/// `secure=` 等价 `https=`。https 代理统一写 http:// scheme（代理自身协议是 HTTP）。纯函数，任意平台可单测。
#[cfg(any(target_os = "windows", test))]
pub fn parse_windows_proxy_server(raw: &str) -> (Option<String>, Option<String>, Option<String>) {
    if raw.contains('=') {
        let mut http = None;
        let mut https = None;
        let mut all = None;
        for part in raw.split(';') {
            let Some((key, value)) = part.split_once('=') else {
                continue;
            };
            if value.trim().is_empty() {
                continue;
            }
            match key.trim().to_ascii_lowercase().as_str() {
                "http" => http = proxy_url_from_authority("http", value, "80"),
                // 同上：https/secure 条目也是 HTTP 代理，统一 http:// scheme
                "https" | "secure" => https = proxy_url_from_authority("http", value, "443"),
                "socks" => all = proxy_url_from_authority("socks5", value, "1080"),
                _ => {}
            }
        }
        (http, https, all)
    } else {
        let url = proxy_url_from_authority("http", raw, "80");
        (url.clone(), url, None)
    }
}

/// `&str` → NUL 结尾 UTF-16（RegGetValueW 的 PCWSTR 入参）。
#[cfg(windows)]
fn utf16z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Windows 注册表读 REG_SZ（读不到/类型不符 → None）。
#[cfg(windows)]
fn reg_read_sz(subkey: &[u16], value: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegGetValueW, RRF_RT_REG_SZ};
    let value16 = utf16z(value);
    let mut buf = [0u16; 2048];
    let mut cb = (buf.len() * 2) as u32;
    let err = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value16.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            &mut cb,
        )
    };
    if err != ERROR_SUCCESS {
        return None;
    }
    let len = (cb as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..len]);
    let text = text.trim_end_matches('\0');
    if text.is_empty() { None } else { Some(text.to_string()) }
}

/// Windows 注册表读 REG_DWORD。
#[cfg(windows)]
fn reg_read_dword(subkey: &[u16], value: &str) -> Option<u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegGetValueW, RRF_RT_REG_DWORD};
    let value16 = utf16z(value);
    let mut data: u32 = 0;
    let mut cb = 4u32;
    let err = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value16.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut core::ffi::c_void,
            &mut cb,
        )
    };
    if err != ERROR_SUCCESS || cb != 4 { None } else { Some(data) }
}

/// 读取当前生效的系统代理（研究 §4 选型）。
/// macOS：`Command` 调 `scutil --proxy` 解析文本（返回默认路由主服务的生效值，勿自枚举服务）；
/// 返回 None = 未启用代理 / 检测失败（调用处降级为不注入，绝不阻塞 spawn）。
#[cfg(target_os = "macos")]
pub fn system_proxy_env() -> Option<ProxyEnv> {
    let out = Command::new("scutil").arg("--proxy").output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_scutil_proxy(&String::from_utf8_lossy(&out.stdout))
}

/// Windows：读 HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings（研究 §2）。
/// AutoConfigURL 存在 = PAC 生效（取消勾选会移除该值）→ 不注入代理 URL，仅 NO_PROXY；
/// ProxyEnable != 1 → 视为未启用（残留 ProxyServer 不代表生效）。
#[cfg(windows)]
pub fn system_proxy_env() -> Option<ProxyEnv> {
    let subkey = utf16z("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
    if let Some(pac) = reg_read_sz(&subkey, "AutoConfigURL") {
        log::info!("[proxy] 系统代理为 PAC（{pac}），跳过代理 URL 注入");
        let entries = reg_read_sz(&subkey, "ProxyOverride")
            .map(|s| normalize_no_proxy_entries(&s))
            .unwrap_or_default();
        return Some(ProxyEnv {
            http: None,
            https: None,
            all: None,
            no_proxy: merge_no_proxy_entries(entries),
        });
    }
    if reg_read_dword(&subkey, "ProxyEnable") != Some(1) {
        return None;
    }
    let server = reg_read_sz(&subkey, "ProxyServer")?;
    if server.trim().is_empty() {
        return None;
    }
    let (http, https, all) = parse_windows_proxy_server(&server);
    if http.is_none() && https.is_none() && all.is_none() {
        return None;
    }
    let entries = reg_read_sz(&subkey, "ProxyOverride")
        .map(|s| normalize_no_proxy_entries(&s))
        .unwrap_or_default();
    Some(ProxyEnv {
        http,
        https,
        all,
        no_proxy: merge_no_proxy_entries(entries),
    })
}

/// 其余平台：无系统代理检测途径，视作未启用。
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn system_proxy_env() -> Option<ProxyEnv> {
    None
}

// ── 凭据注入 / 环境注入 ─────────────────────────────────────

/// 把 user:pass@ 注入代理 URL 的 userinfo 段：http://proxy:8080 → http://user:pass@proxy:8080。
/// user 为空或 URL 已含 userinfo（有 @）则原样返回。
pub fn inject_proxy_credentials(url: &str, user: &str, pass: &str) -> String {
    if user.is_empty() {
        return url.to_string();
    }
    let Some(idx) = url.find("://") else { return url.to_string(); };
    let after_scheme = idx + 3;
    let authority = &url[after_scheme..];
    // 已有 userinfo 则不重复注入
    if authority.contains('@') {
        return url.to_string();
    }
    let userinfo = if pass.is_empty() {
        format!("{user}@")
    } else {
        format!("{user}:{pass}@")
    };
    format!("{}{userinfo}{}", &url[..after_scheme], authority)
}

/// 按设置解析应注入的代理环境：
/// - off / 未知值 → None；
/// - manual → 校验 URL（非法 → None）；http/https URL 注 http+https，socks5 URL 注 all；
/// - system → 实时读系统代理（检测失败 → None，记日志）。
/// 末尾按 proxy_user/proxy_pass 给所有代理 URL 注入凭据（userinfo 段）。
pub fn resolved_proxy_env(settings: &DesktopSettings) -> Option<ProxyEnv> {
    let mut env = match settings.proxy_mode.as_deref().unwrap_or(PROXY_MODE_OFF) {
        PROXY_MODE_MANUAL => {
            let url = normalize_proxy_url(settings.proxy_url.as_deref().unwrap_or(""))?;
            let entries = settings
                .no_proxy
                .as_deref()
                .map(normalize_no_proxy_entries)
                .unwrap_or_default();
            let (http, https, all) = if url.starts_with("socks5://") {
                (None, None, Some(url))
            } else {
                let u = url.clone();
                (Some(u), Some(url), None)
            };
            Some(ProxyEnv {
                http,
                https,
                all,
                no_proxy: merge_no_proxy_entries(entries),
            })
        }
        PROXY_MODE_SYSTEM => match system_proxy_env() {
            Some(env) => Some(env),
            None => {
                log::info!("[proxy] 继承系统代理：未检测到启用的系统代理，本次不注入");
                None
            }
        },
        _ => None,
    }?;
    // 凭据注入：proxy_user 非空时给所有代理 URL 拼接 user:pass@
    if let Some(user) = settings.proxy_user.as_deref() {
        if !user.is_empty() {
            let pass = settings.proxy_pass.as_deref().unwrap_or("");
            if let Some(ref mut url) = env.http {
                *url = inject_proxy_credentials(url, user, pass);
            }
            if let Some(ref mut url) = env.https {
                *url = inject_proxy_credentials(url, user, pass);
            }
            if let Some(ref mut url) = env.all {
                *url = inject_proxy_credentials(url, user, pass);
            }
        }
    }
    Some(env)
}

/// 把解析出的代理环境写入子进程 env（大小写各一：Unix 工具惯用小写，Windows 工具惯用大写，研究边界 11）。
pub fn apply_proxy_env(cmd: &mut Command, proxy: &ProxyEnv) {
    if let Some(url) = &proxy.http {
        cmd.env("HTTP_PROXY", url).env("http_proxy", url);
    }
    if let Some(url) = &proxy.https {
        cmd.env("HTTPS_PROXY", url).env("https_proxy", url);
    }
    if let Some(url) = &proxy.all {
        cmd.env("ALL_PROXY", url).env("all_proxy", url);
    }
    if !proxy.no_proxy.is_empty() {
        cmd.env("NO_PROXY", &proxy.no_proxy).env("no_proxy", &proxy.no_proxy);
    }
}

/// spawn dsh 前调用：按当前设置解析代理并注入；off/解析失败不注入任何代理变量。
pub fn inject_proxy_env(cmd: &mut Command) {
    let settings = load_desktop_settings();
    let Some(proxy) = resolved_proxy_env(&settings) else {
        return;
    };
    if proxy.has_any_proxy() {
        log::info!(
            "[proxy] 注入 dsh 代理环境：http={:?} https={:?} all={:?} no_proxy={}",
            proxy.http.as_deref().unwrap_or("-"),
            proxy.https.as_deref().unwrap_or("-"),
            proxy.all.as_deref().unwrap_or("-"),
            proxy.no_proxy
        );
    }
    apply_proxy_env(cmd, &proxy);
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

  #[test]
  fn proxy_settings_default_missing_fields_mean_off() {
    // 旧配置无代理字段 → 反序列化默认（None）→ 不注入；未知模式同样不注入
    let old: DesktopSettings = serde_yaml::from_str("port: 3081\n").unwrap();
    assert_eq!(old.proxy_mode, None);
    assert!(resolved_proxy_env(&old).is_none());
    assert!(resolved_proxy_env(&DesktopSettings::default()).is_none());
    let mut unknown = DesktopSettings::default();
    unknown.proxy_mode = Some("direct".into());
    assert!(resolved_proxy_env(&unknown).is_none());
  }

  #[test]
  fn proxy_url_normalization() {
    assert_eq!(
      normalize_proxy_url("http://127.0.0.1:7890").as_deref(),
      Some("http://127.0.0.1:7890")
    );
    // scheme 大小写归一；主机保留原样
    assert_eq!(
      normalize_proxy_url(" HTTP://Proxy.Corp:8080 ").as_deref(),
      Some("http://Proxy.Corp:8080")
    );
    // socks 统一为 socks5
    assert_eq!(
      normalize_proxy_url("socks://127.0.0.1:7891").as_deref(),
      Some("socks5://127.0.0.1:7891")
    );
    // 缺端口按 scheme 默认补全
    assert_eq!(normalize_proxy_url("http://proxy.corp").as_deref(), Some("http://proxy.corp:80"));
    assert_eq!(normalize_proxy_url("https://proxy.corp").as_deref(), Some("https://proxy.corp:443"));
    // IPv6：带方括号保留；裸字面量补方括号
    assert_eq!(normalize_proxy_url("http://[::1]:7890").as_deref(), Some("http://[::1]:7890"));
    assert_eq!(normalize_proxy_url("http://::1").as_deref(), Some("http://[::1]:80"));
    // 误粘贴的尾部路径被剥离
    assert_eq!(
      normalize_proxy_url("http://127.0.0.1:7890/").as_deref(),
      Some("http://127.0.0.1:7890")
    );
    // 非法输入
    assert_eq!(normalize_proxy_url("ftp://127.0.0.1"), None);
    assert_eq!(normalize_proxy_url("127.0.0.1:7890"), None);
    assert_eq!(normalize_proxy_url("http://"), None);
    assert_eq!(normalize_proxy_url(""), None);
  }

  #[test]
  fn no_proxy_normalization_and_loopback_merge() {
    // *.x → .x；<local> → 回环组；CIDR 丢弃；小写化；始终合并回环保底
    let entries = normalize_no_proxy_entries("*.local; 192.168.0.0/16; <local>; Foo.Example.COM");
    assert_eq!(
      entries,
      vec![".local", "localhost", "127.0.0.1", "::1", "foo.example.com"]
    );
    let merged = merge_no_proxy_entries(entries);
    assert_eq!(merged, ".local,localhost,127.0.0.1,::1,foo.example.com");
    // 空输入也保证回环保底（有代理注入时 NO_PROXY 恒非空）
    assert_eq!(merge_no_proxy_entries(Vec::new()), "localhost,127.0.0.1,::1");
  }

  #[test]
  fn proxy_url_with_embedded_credentials_strips_userinfo() {
    // 研究边界 10：env 不携带凭据——manual 输入含 user:pass@host 时剥离 userinfo
    assert_eq!(
      normalize_proxy_url("http://user:pa%40ss@127.0.0.1:7890").as_deref(),
      Some("http://127.0.0.1:7890")
    );
    // userinfo 里含 @ 时取最后一个 @
    assert_eq!(
      normalize_proxy_url("socks5://u@p@proxy.corp:1080").as_deref(),
      Some("socks5://proxy.corp:1080")
    );
    // 无凭据不受影响
    assert_eq!(
      normalize_proxy_url("http://127.0.0.1:7890").as_deref(),
      Some("http://127.0.0.1:7890")
    );
  }

  // scutil --proxy 真实输出样例（研究 §1.2：全协议禁用）
  const SCUTIL_ALL_OFF: &str = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 127.0.0.1\n    1 : 192.168.0.0/16\n    2 : 10.0.0.0/8\n    3 : 172.16.0.0/12\n    4 : localhost\n    5 : *.local\n    6 : *.crashlytics.com\n    7 : <local>\n  }\n  FTPPassive : 1\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  ProxyAutoConfigEnable : 0\n  SOCKSEnable : 0\n}\n";

  // scutil --proxy 真实输出样例（研究 §1.3：HTTP/HTTPS/SOCKS/PAC 全启用）
  const SCUTIL_ENABLED_WITH_PAC: &str = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 127.0.0.1\n    1 : localhost\n    2 : *.local\n  }\n  HTTPEnable : 1\n  HTTPPort : 7897\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://127.0.0.1:33331/commands/pac\n  SOCKSEnable : 1\n  SOCKSPort : 7897\n  SOCKSProxy : 127.0.0.1\n}\n";

  #[test]
  fn parse_scutil_proxy_disabled_keeps_exceptions_only() {
    // 研究 §1.2 样例：全部协议 Enable=0（配置过但禁用）→ 无代理 URL，仅例外列表规范化
    let off = parse_scutil_proxy(SCUTIL_ALL_OFF).unwrap();
    assert!(!off.has_any_proxy());
    assert_eq!(off.no_proxy, "127.0.0.1,localhost,.local,.crashlytics.com,::1");
  }

  #[test]
  fn parse_scutil_proxy_pac_degrades_to_no_proxy_only() {
    // 研究 §1.3 样例：HTTP/HTTPS/SOCKS 全启用但 PAC 同时启用 → 降级：不注入代理 URL
    let pac = parse_scutil_proxy(SCUTIL_ENABLED_WITH_PAC).unwrap();
    assert!(!pac.has_any_proxy());
    assert_eq!(pac.no_proxy, "127.0.0.1,localhost,.local,::1");
  }

  #[test]
  fn parse_scutil_proxy_enabled_without_pac() {
    let text = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7897\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : 192.168.1.1\n}\n";
    let p = parse_scutil_proxy(text).unwrap();
    assert_eq!(p.http.as_deref(), Some("http://127.0.0.1:7897"));
    assert_eq!(p.https.as_deref(), Some("http://127.0.0.1:7897"));
    assert_eq!(p.all.as_deref(), Some("socks5://192.168.1.1:1080"));
    // 无例外列表 → 仅回环保底
    assert_eq!(p.no_proxy, "localhost,127.0.0.1,::1");
  }

  #[test]
  fn parse_windows_proxy_server_single_and_per_scheme() {
    // 单一格式：http/https 同值
    let single = parse_windows_proxy_server("127.0.0.1:7897");
    assert_eq!(single.0.as_deref(), Some("http://127.0.0.1:7897"));
    assert_eq!(single.1.as_deref(), Some("http://127.0.0.1:7897"));
    assert_eq!(single.2, None);
    // 分协议格式：各自映射；https 代理写 http:// scheme（代理自身是 HTTP 协议）
    let per = parse_windows_proxy_server("http=10.0.0.1:8080;https=10.0.0.1:8443;socks=10.0.0.2:1080");
    assert_eq!(per.0.as_deref(), Some("http://10.0.0.1:8080"));
    assert_eq!(per.1.as_deref(), Some("http://10.0.0.1:8443"));
    assert_eq!(per.2.as_deref(), Some("socks5://10.0.0.2:1080"));
    // 分协议缺省的协议不注入
    let partial = parse_windows_proxy_server("http=10.0.0.1:8080");
    assert!(partial.0.is_some());
    assert!(partial.1.is_none());
    assert!(partial.2.is_none());
    // 无端口按默认补全
    let noport = parse_windows_proxy_server("proxy.corp");
    assert_eq!(noport.0.as_deref(), Some("http://proxy.corp:80"));
  }

  #[test]
  fn resolved_proxy_env_manual_modes() {
    // manual + 非法 URL → 不注入
    let mut bad = DesktopSettings::default();
    bad.proxy_mode = Some("manual".into());
    bad.proxy_url = Some("not-a-url".into());
    assert!(resolved_proxy_env(&bad).is_none());
    // manual + http → http/https 同值，NO_PROXY 恒含回环
    let mut manual = DesktopSettings::default();
    manual.proxy_mode = Some("manual".into());
    manual.proxy_url = Some("http://127.0.0.1:7890".into());
    manual.no_proxy = Some("*.corp".into());
    let m = resolved_proxy_env(&manual).unwrap();
    assert_eq!(m.http.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(m.https.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(m.all, None);
    assert_eq!(m.no_proxy, ".corp,localhost,127.0.0.1,::1");
    // manual + socks5 → 仅 ALL_PROXY
    let mut socks = DesktopSettings::default();
    socks.proxy_mode = Some("manual".into());
    socks.proxy_url = Some("socks5://127.0.0.1:7891".into());
    let so = resolved_proxy_env(&socks).unwrap();
    assert!(so.http.is_none() && so.https.is_none());
    assert_eq!(so.all.as_deref(), Some("socks5://127.0.0.1:7891"));
  }

  #[test]
  fn apply_proxy_env_sets_upper_and_lower() {
    let mut cmd = Command::new("echo");
    let proxy = ProxyEnv {
      http: Some("http://127.0.0.1:7890".into()),
      https: Some("http://127.0.0.1:7890".into()),
      all: None,
      no_proxy: "localhost,127.0.0.1,::1".into(),
    };
    apply_proxy_env(&mut cmd, &proxy);
    let get = |name: &str| {
      cmd
        .get_envs()
        .find(|(k, _)| k.to_string_lossy() == name)
        .and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
    };
    for key in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
      assert_eq!(get(key).as_deref(), Some("http://127.0.0.1:7890"), "{key} 应为代理 URL");
    }
    for key in ["NO_PROXY", "no_proxy"] {
      assert_eq!(get(key).as_deref(), Some("localhost,127.0.0.1,::1"), "{key} 应为 NO_PROXY");
    }
    assert_eq!(get("ALL_PROXY"), None, "all 未设置时不应出现");
  }
}
