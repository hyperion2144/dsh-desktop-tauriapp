//! 设置读写模块。
//!
//! 迁移自 lib.rs 功能区域 1（settings）+ 功能区域 2（configured_* 辅助）。
//! 包含 DesktopSettings、load_desktop_settings、from_yaml_value、
//! legacy_desktop_block、configured_port/profile/lane_port/cloudflared_bin、settings_path。

use std::path::PathBuf;


/// 桌面壳专属设置：持久化于壳私有文件（app_data/desktop-settings.json）。
/// #95 v0.1.7 适配：dsh 废除 settings.yaml 插件命名空间（改 Profile 插件配置），
/// 壳设置彻底搬出 dsh 体系——壳是注入式插件，脱离壳后这些设置不应污染 dsh。
/// 首次启动从旧 settings.yaml 的 dsh-desktop-tauriapp: 块一次性迁移（不碰该文件）。
/// Rust 单写者：读 + 写都归壳；client 经 Tauri IPC（save_desktop_settings）。
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(default)]
pub struct DesktopSettings {
    /// 本地 dsh web 端口（默认 3080；DSH_DESKTOP_PORT 环境变量优先级更高）。
    pub port: Option<u16>,
    /// 激活 profile（spawn 时 `dsh --profile <name>`）。
    pub active_profile: Option<String>,
    /// 当前远程 dsh 地址（None=本地）。
    pub remote_addr: Option<String>,
    /// 已保存的远程地址列表（host[:port]）。
    pub remote_list: Vec<String>,
    /// 手机访问 lane（改写反代）端口（默认 3091；DSH_MOBILE_LANE_PORT 环境变量优先级更高）。
    pub lane_port: Option<u16>,
    /// cloudflared 可执行文件路径（设置后手机访问自动启动公网隧道；空=不启用）。
    pub cloudflared_bin: Option<String>,
    /// 代理模式：off=直连（不注入）｜system=继承系统代理（spawn 时实时读取）｜manual=手动指定。
    pub proxy_mode: Option<String>,
    /// 手动代理 URL（http/https/socks5://host:port；仅 proxy_mode=manual 时生效）。
    pub proxy_url: Option<String>,
    /// 不走代理的地址（NO_PROXY 标准格式，逗号分隔，支持 host / *.domain / IP）。
    pub no_proxy: Option<String>,
    /// 代理认证用户名（system/manual 模式下注入到 HTTP_PROXY 等 env 的 userinfo 段）。
    pub proxy_user: Option<String>,
    /// 代理认证密码（与 proxy_user 配对；空=无认证）。
    pub proxy_pass: Option<String>,
    /// 保险丝：第一方插件（@deepseek-ai/*）保护开关（默认开）。
    pub quarantine_first_party_protection: Option<bool>,
    /// 保险丝：排除名单（永不自动禁用的插件 id/包名）。
    pub quarantine_exclude: Option<Vec<String>>,
    /// 保险丝：启动失败最大重试次数（默认 2，0-5）。
    pub quarantine_max_retries: Option<u8>,
    /// 保险丝 AI 解读：provider（deepseek=官方 / custom=自定义 OpenAI 兼容）。
    pub ai_provider: Option<String>,
    /// 保险丝 AI 解读：模型（默认 deepseek-v4-flash）。
    pub ai_model: Option<String>,
    /// 保险丝 AI 解读：自定义端点（仅 custom 时生效；默认官方 api.deepseek.com）。
    pub ai_base_url: Option<String>,
    /// 保险丝 AI 解读：密钥的 refs 键名/环境变量名（custom 时必填；默认 DEEPSEEK_API_KEY）。
    pub ai_key_env: Option<String>,
    /// 下载管理器：并发下载数上限（默认 3，1-32）。
    pub download_concurrency: Option<u32>,
    /// 每 profile 启动端口覆盖（#86）：键为 profile 名。web 缺省 3080、desktop 缺省 3081，
    /// 其余 profile 首次 spawn 时按公式分配并持久化到这里，保证后续启动稳定。
    pub profile_ports: Option<std::collections::BTreeMap<String, u16>>,
    /// 每 profile lane（手机访问反代）端口覆盖（#86）：web 缺省 3091、desktop 缺省 3092，
    /// 其余从 3093 起自动分配。
    pub profile_lane_ports: Option<std::collections::BTreeMap<String, u16>>,
    /// dsh 来源（#85 拍板）：builtin=内置运行时（默认，内部 runProfile 代码路径启动）/
    /// external=外部 CLI（DSH_BIN → PATH → npm 全局）。DSH_MODE env 可覆盖。
    pub dsh_mode: Option<String>,
    /// 运行时版本（#95）：选中的已下载 dsh 运行时版本；None=用内置版本。
    #[serde(default)]
    pub dsh_runtime: Option<String>,
    /// 运行时下载源（#95）：github（默认）| npm。
    #[serde(default)]
    pub runtime_source: Option<String>,
    /// GitHub 运行时仓库（owner/repo，github 源用；默认官方仓库）。
    #[serde(default)]
    pub runtime_github_repo: Option<String>,
}

/// 壳私有设置文件（#95 v0.1.7 搬出 dsh settings.yaml；收尾修正正位）：
/// $DSH_HOME/desktop-settings.json 单一源（随 DSH_HOME 走、支持 ~ 展开）。
/// 曾短暂落在 app_data/（d52b22d），按用户拍板不做遗留副本迁移清理，此后只认正位。
pub fn settings_path() -> PathBuf {
    dsh_home().join("desktop-settings.json")
}

/// 旧 settings.yaml 路径（仅一次性迁移读取，永不写入）。
fn legacy_settings_yaml() -> PathBuf {
    dsh_home().join("settings.yaml")
}
/// dsh 数据目录（$DSH_HOME 或 ~/.dsh）。
///
/// 注意：`DSH_HOME` 支持 `~` 前缀展开——dsh 的 resolveDshHome() 会展开（#56），
/// 若这里不展开，同一环境变量下桌面壳与 dsh 会各写各的目录（实测分歧）。
pub(crate) fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        return home_base();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home_base().join(rest);
    }
    PathBuf::from(p)
}

fn home_base() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    #[cfg(not(windows))]
    let base = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    base
}

pub(crate) fn dsh_home() -> PathBuf {
    if let Ok(h) = std::env::var("DSH_HOME") {
        if !h.trim().is_empty() {
            return expand_home(h.trim());
        }
    }
    home_base().join(".dsh")
}
/// 读取桌面壳设置（壳私有 desktop-settings.json）。
/// 首次启动（私有文件不存在）：从旧 settings.yaml 的 dsh-desktop-tauriapp:/desktop:
/// 块一次性迁移到私有文件（只读 yaml，永不写入）；此后永远只读私有文件。
/// v0.1.7 dsh 废除 settings.yaml 插件命名空间后，壳设置与 dsh 完全解耦（#95）。
pub fn load_desktop_settings() -> DesktopSettings {
    let path = settings_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<DesktopSettings>(&text) {
            return v;
        }
        // 私有文件损坏：备份后回退默认（下文迁移逻辑会重建）
        let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
        log::warn!("[settings] 私有设置文件损坏，已备份重建");
    }
    // 一次性迁移：旧 settings.yaml 的壳块 → 私有 JSON
    let migrated = migrate_from_legacy_yaml();
    let _ = save_desktop_settings(&migrated);
    migrated
}

/// 壳单写者：写私有 desktop-settings.json（原子写：先 temp 后 rename）。
pub fn save_desktop_settings(s: &DesktopSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建设置目录失败：{e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(s).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("写设置失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换设置失败：{e}"))?;
    Ok(())
}

/// 从旧 settings.yaml 读取壳块（dsh-desktop-tauriapp: 或 legacy desktop:）。
/// 只读不写；返回默认值当无块/解析失败。
fn migrate_from_legacy_yaml() -> DesktopSettings {
    let Ok(text) = std::fs::read_to_string(legacy_settings_yaml()) else {
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
    let migrated = from_yaml_value(selected).unwrap_or_default();
    if !migrated_eq_default(&migrated) {
        log::info!("[settings] 已从旧 settings.yaml 一次性迁移壳设置到私有文件");
    }
    migrated
}

fn migrated_eq_default(s: &DesktopSettings) -> bool {
    // 粗粒度判定：全字段 JSON 序列化相等即默认（仅用于迁移日志）
    serde_json::to_string(s).ok() == serde_json::to_string(&DesktopSettings::default()).ok()
}

/// 把 YAML Value 反序列化为桌面壳设置（映射缺失字段给默认）。
pub fn from_yaml_value(v: serde_yaml::Value) -> Option<DesktopSettings> {
    serde_yaml::from_value(v).ok()
}

/// 兼容上一版 bug 写入的 `desktop:` 块：仅当它长得像我们的 schema（含
/// port/active_profile/remote_addr/remote_list 任一键）时才认领，不影响第三方键。
pub fn legacy_desktop_block(value: &serde_yaml::Value) -> Option<&serde_yaml::Value> {
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

// #90 架构约束（用户拍板）：Rust 不写 settings.yaml。设置修改一律由桌面插件
// （dsh-desktop-tauriapp 的 host 端）经 dsh settings 服务（settings.mutate）落盘；
// Rust 仅读取（启动前读不到/无对应设置时使用内置默认值）。

// 注意：注释保留说明——settings.yaml 由 dsh settings 服务整体管理，本模块只读。
/// 旧全局端口（web profile 的 legacy 存储位）：DSH_DESKTOP_PORT env > settings.port > 3080。
/// #86 起端口入口是 port_for_profile；本函数仅作 web 兼容回退与外部实例复用判定。
pub fn configured_port() -> u16 {
    std::env::var("DSH_DESKTOP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or_else(|| load_desktop_settings().port)
        .unwrap_or(3080)
}

/// 端口分配基数：web=3080（不变）、desktop=3081、其余 profile 在其名字散列落点冲突时向后探测（#86）。
pub(crate) const PORT_BASE_OTHER: u16 = 3082;
/// lane 端口分配基数：web=3091、desktop=3092、其余从 3093 起分配。
pub(crate) const LANE_BASE_OTHER: u16 = 3094;

/// FNV-1a 64：给 profile 名算稳定散列，跨进程为其它 profile 选出一致的端口起点。
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// profile 的默认端口公式（纯函数，不含覆盖与持久化；#86）。
pub(crate) fn default_port_for_profile(profile: &str) -> u16 {
    match profile {
        "web" => 3080,
        "desktop" => 3081,
        other => PORT_BASE_OTHER + (fnv1a(other.as_bytes()) % 512) as u16,
    }
}

/// profile 的默认 lane 端口公式（纯函数；#94）：实例 lane 整体 +1（3092 起），
/// 腾出 3091 给壳自有 TCP 转发器作为手机稳定接入点（焦点窗口跟随）。
pub(crate) fn default_lane_port_for_profile(profile: &str) -> u16 {
    match profile {
        "web" => 3092,
        "desktop" => 3093,
        other => LANE_BASE_OTHER + (fnv1a(other.as_bytes()) % 512) as u16,
    }
}

/// 在 [base, base+1024) 内找第一个不在 taken 里的端口（纯函数；分配冲突时向后探测）。
pub(crate) fn assign_port_avoiding(base: u16, taken: &[u16]) -> u16 {
    let mut candidate = base;
    while taken.contains(&candidate) && candidate != base.wrapping_add(1023) {
        candidate = candidate.wrapping_add(1);
    }
    candidate
}

/// 取 profile 的启动端口（#86）：
/// DSH_DESKTOP_PORT env（遗留全局覆盖，供脚本/测试）> profile_ports[profile]
/// > web 的 legacy settings.port > 默认公式（desktop=3081，其余散列落点+避让并持久化）。
pub fn port_for_profile(profile: &str) -> u16 {
    port_for_profile_config(profile)
}

/// 仅读 settings + 默认值，不读 env 覆盖——供 list_profile_ports 展示用。
pub fn port_for_profile_config(profile: &str) -> u16 {
    let mut settings = load_desktop_settings();
    if let Some(p) = settings.profile_ports.as_ref().and_then(|m| m.get(profile).copied()) {
        return p;
    }
    match profile {
        "web" => settings.port.unwrap_or_else(|| default_port_for_profile(profile)),
        _ => {
            let taken: Vec<u16> = settings
                .profile_ports
                .as_ref()
                .map(|m| m.values().copied().collect())
                .unwrap_or_default();
            let p = assign_port_avoiding(default_port_for_profile(profile), &taken);
            settings
                .profile_ports
                .get_or_insert_with(Default::default)
                .insert(profile.to_string(), p);
            // #90 架构约束：Rust 不写 settings.yaml——分配仅会话内存；
            // 确定性散列保证跨启动稳定，显式改端口由 client→插件→settings 服务持久化
            log::info!("[ports] profile {profile} 分配启动端口 {p}");
            p
        }
    }
}

/// 取 profile 的 lane 端口（#86/#94）：语义同 port_for_profile，基数换成 lane。
pub fn lane_port_for_profile(profile: &str) -> u16 {
    lane_port_for_profile_config(profile)
}

/// 仅读 settings + 默认值，不读 env 覆盖——供 list_profile_ports 展示用。
pub fn lane_port_for_profile_config(profile: &str) -> u16 {
    let mut settings = load_desktop_settings();
    if let Some(p) = settings.profile_lane_ports.as_ref().and_then(|m| m.get(profile).copied()) {
        return p;
    }
    match profile {
        "web" => settings.lane_port.unwrap_or_else(|| default_lane_port_for_profile(profile)),
        _ => {
            let taken: Vec<u16> = settings
                .profile_lane_ports
                .as_ref()
                .map(|m| m.values().copied().collect())
                .unwrap_or_default();
            let p = assign_port_avoiding(default_lane_port_for_profile(profile), &taken);
            settings
                .profile_lane_ports
                .get_or_insert_with(Default::default)
                .insert(profile.to_string(), p);
            // 同上：会话内存，不写 settings.yaml
            p
        }
    }
}

/// 全新安装的默认 profile（desktop）。
pub(crate) const FRESH_DEFAULT_PROFILE: &str = "desktop";

/// 未设置 active_profile 时的默认值（纯函数，便于单测）：
/// 全新安装（settings.yaml 不存在）→ desktop；存量（文件存在但未设置）→ web，不静默搬家。
pub(crate) fn default_profile_when_unset(settings_file_exists: bool) -> String {
    if settings_file_exists {
        "web".to_string()
    } else {
        FRESH_DEFAULT_PROFILE.to_string()
    }
}

/// 激活 profile（settings.yaml active_profile；未设置时：全新安装→desktop、存量→web）。
pub fn configured_profile() -> String {
    if let Some(p) = load_desktop_settings()
        .active_profile
        .filter(|s| !s.is_empty() && !s.contains(['/', '\\', '\0']))
    {
        return p;
    }
    default_profile_when_unset(settings_path().exists())
}

/// 手机访问转发器端口（#94）：DSH_MOBILE_LANE_PORT env > settings lane_port > 3091。
/// 这是手机的稳定接入点（壳 TCP 转发器监听此处，转发到焦点实例 lane）；
/// 实例自身 lane 端口见 lane_port_for_profile（3092 起）。
pub fn configured_lane_port() -> u16 {
    std::env::var("DSH_MOBILE_LANE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or_else(|| load_desktop_settings().lane_port)
        .unwrap_or(3091)
}

/// 下载并发上限：settings.yaml download_concurrency，默认 3，钳制在 1..=32。
pub fn configured_download_concurrency() -> u32 {
    load_desktop_settings()
        .download_concurrency
        .unwrap_or(3)
        .clamp(1, 32)
}

/// cloudflared 可执行文件路径（settings.yaml cloudflared_bin；空=不启用公网隧道）。
pub fn configured_cloudflared_bin() -> String {
    load_desktop_settings().cloudflared_bin.unwrap_or_default()
}


/// 当前激活 profile 的 dsh 服务端口（= port_for_profile(configured_profile())）。
/// 端口策略（#86 拍板）：web=3080 不变 / desktop=3081 / 其余自动分配，per-profile 可覆盖；
/// 同一 profile 仍只允许一个实例（同 HOME 同 profile 双实例绝对禁止，#93；
/// 旧「task-board 全局锁」说法不准确，真约束是 HOME 共享文件互污，见 #82 报告）。
pub(crate) fn app_port() -> u16 {
    port_for_profile(&configured_profile())
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
      proxy_mode: Some("off".into()),
      proxy_url: Some("http://192.168.1.1:7890".into()),
      no_proxy: Some("*.corp".into()),
      proxy_user: Some("alice".into()),
      proxy_pass: Some("s3cret".into()),
      quarantine_first_party_protection: Some(true),
      quarantine_exclude: Some(vec!["noisy".into()]),
      quarantine_max_retries: Some(3),
      ai_provider: Some("deepseek".into()),
      ai_model: Some("deepseek-v4-flash".into()),
      ai_base_url: None,
      ai_key_env: None,
      download_concurrency: Some(5),
      profile_ports: Some([("web".into(), 3080), ("desktop".into(), 3081)].into_iter().collect()),
      profile_lane_ports: Some([("web".into(), 3091)].into_iter().collect()),
       dsh_mode: Some("builtin".into()),
      dsh_runtime: None,
      runtime_source: None,
      runtime_github_repo: None,
    };
    let y = serde_yaml::to_string(&s).unwrap();
    let back: DesktopSettings = serde_yaml::from_str(&y).unwrap();
    assert_eq!(back.download_concurrency, Some(5));
    assert_eq!(back.profile_ports.as_ref().and_then(|m| m.get("desktop")).copied(), Some(3081));
    assert_eq!(back.profile_lane_ports.as_ref().and_then(|m| m.get("web")).copied(), Some(3091));
    assert_eq!(back.ai_provider.as_deref(), Some("deepseek"));
    assert_eq!(back.ai_model.as_deref(), Some("deepseek-v4-flash"));
    assert_eq!(back.port, Some(3081));
    assert_eq!(back.active_profile.as_deref(), Some("web"));
    assert_eq!(back.remote_list, vec!["x.cn:3091".to_string()]);
    assert_eq!(back.lane_port, Some(3092));
    assert_eq!(back.cloudflared_bin.as_deref(), Some("/opt/bin/cloudflared"));
    assert_eq!(back.proxy_mode.as_deref(), Some("off"));
    assert_eq!(back.proxy_url.as_deref(), Some("http://192.168.1.1:7890"));
    assert_eq!(back.no_proxy.as_deref(), Some("*.corp"));
    assert_eq!(back.proxy_user.as_deref(), Some("alice"));
    assert_eq!(back.proxy_pass.as_deref(), Some("s3cret"));
    assert_eq!(back.quarantine_first_party_protection, Some(true));
    assert_eq!(back.quarantine_exclude, Some(vec!["noisy".to_string()]));
    assert_eq!(back.quarantine_max_retries, Some(3));
  }

  #[test]
  fn expand_home_supports_tilde() {
    // #56 实测分歧：dsh 的 resolveDshHome() 会展开 ~，桌面壳此前不会——
    // 用户设 DSH_HOME=~/x 时两者会各写各的目录。纯函数测试，不动环境变量
    // （并行测试下改 DSH_HOME 会串扰其它设置测试）。
    assert_eq!(expand_home("~/dsh-alt"), home_base().join("dsh-alt"));
    assert_eq!(expand_home("~"), home_base());
    assert_eq!(expand_home("/abs/path"), PathBuf::from("/abs/path"));
    assert_eq!(expand_home("rel"), PathBuf::from("rel"));
  }

  // ==================== 代理设置测试 ====================
  // ==================== 每 profile 端口模型（#86）测试 ====================

  #[test]
  fn default_port_formula_fixed_profiles() {
    assert_eq!(default_port_for_profile("web"), 3080);
    assert_eq!(default_port_for_profile("desktop"), 3081);
    // 其余 profile 落在 [3082, 3594)，不与固定端口重叠
    for name in ["research", "work-2", "x"] {
      let p = default_port_for_profile(name);
      assert!((PORT_BASE_OTHER..PORT_BASE_OTHER + 512).contains(&p), "{name} -> {p}");
    }
  }

  #[test]
  fn default_lane_formula_fixed_profiles() {
     assert_eq!(default_lane_port_for_profile("web"), 3092);
     assert_eq!(default_lane_port_for_profile("desktop"), 3093);
    let p = default_lane_port_for_profile("research");
    assert!((LANE_BASE_OTHER..LANE_BASE_OTHER + 512).contains(&p));
  }

  #[test]
  fn assign_port_avoiding_skips_taken() {
    assert_eq!(assign_port_avoiding(3082, &[]), 3082);
    assert_eq!(assign_port_avoiding(3082, &[3082]), 3083);
    assert_eq!(assign_port_avoiding(3100, &[3100, 3101, 3102]), 3103);
  }

  #[test]
  fn port_hash_is_deterministic() {
    // 同名 profile 两次计算必须同值（跨进程稳定，否则重启后端口漂移）
    assert_eq!(default_port_for_profile("abc"), default_port_for_profile("abc"));
    assert_eq!(default_port_for_profile("abc"), default_port_for_profile("abc"));
    // 不同名不要求不同值（冲突由 assign_port_avoiding 兜住）
  }

  #[test]
  fn fresh_install_defaults_to_desktop_profile() {
    // #87：全新安装（无 settings.yaml）默认 desktop；存量（文件在但未设置）保持 web
    assert_eq!(default_profile_when_unset(false), "desktop");
    assert_eq!(default_profile_when_unset(true), "web");
    assert_eq!(FRESH_DEFAULT_PROFILE, "desktop");
  }


  #[test]
  fn settings_path_pins_dsh_home_single_source() {
    // #95 收尾：壳设置唯一正位 $DSH_HOME/desktop-settings.json（不再走 app_data），
    // 锁死该不变量，防止路径再次分叉出第二个源。
    assert_eq!(settings_path(), dsh_home().join("desktop-settings.json"));
  }

}
