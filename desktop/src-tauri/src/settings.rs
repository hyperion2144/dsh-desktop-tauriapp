//! 设置读写模块。
//!
//! 迁移自 lib.rs 功能区域 1（settings）+ 功能区域 2（configured_* 辅助）。
//! 包含 DesktopSettings、load/save_desktop_settings、from_yaml_value、
//! legacy_desktop_block、configured_port/profile/lane_port/cloudflared_bin、settings_path。

use std::path::PathBuf;


/// 桌面壳专属设置：持久化于 $DSH_HOME/settings.yaml 的 `dsh-desktop-tauriapp:` 顶层键下。
/// 只读写该键，文件其余内容（dsh 自身设置等）一律原样保留；原子写；解析失败先备份。
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
}

pub fn settings_path() -> PathBuf {
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
/// 读取桌面壳设置（文件缺失或 `dsh-desktop-tauriapp:` 键缺失 → 默认值；解析失败 → 默认值）。
pub fn load_desktop_settings() -> DesktopSettings {
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

/// 保存桌面壳设置：与现有 settings.yaml 合并（只写 `dsh-desktop-tauriapp:` 键），原子写；
/// 解析失败时先备份原文件，再以仅含 `dsh-desktop-tauriapp:` 的新文档落盘，绝不丢用户内容。
pub fn save_desktop_settings(settings: &DesktopSettings) {
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
pub fn configured_port() -> u16 {
    std::env::var("DSH_DESKTOP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or_else(|| load_desktop_settings().port)
        .unwrap_or(3080)
}

/// 激活 profile（settings.yaml desktop.active_profile，非法值回退 web）。
pub fn configured_profile() -> String {
    load_desktop_settings()
        .active_profile
        .filter(|s| !s.is_empty() && !s.contains(['/', '\\', '\0']))
        .unwrap_or_else(|| "web".to_string())
}

/// 手机访问 lane 端口：DSH_MOBILE_LANE_PORT 环境变量 > settings.yaml lane_port > 3091。
pub fn configured_lane_port() -> u16 {
    std::env::var("DSH_MOBILE_LANE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or_else(|| load_desktop_settings().lane_port)
        .unwrap_or(3091)
}

/// cloudflared 可执行文件路径（settings.yaml cloudflared_bin；空=不启用公网隧道）。
pub fn configured_cloudflared_bin() -> String {
    load_desktop_settings().cloudflared_bin.unwrap_or_default()
}


/// dsh 服务端口（= configured_port）。端口策略：
/// 已有 dsh web → 复用并降级接入；空闲/高级 → 由本应用 spawn 实例并注入桌面 chrome。
/// 注意：同一 profile 只允许一个 dsh web 实例并发（task-board 等插件持有排它锁），
/// 因此不要用独立端口再起第二实例。
pub(crate) fn app_port() -> u16 {
    configured_port()
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
    };
    let y = serde_yaml::to_string(&s).unwrap();
    let back: DesktopSettings = serde_yaml::from_str(&y).unwrap();
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

}
