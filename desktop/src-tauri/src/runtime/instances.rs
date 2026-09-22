//! 实例台账与认领判定（#86）。
//!
//! 桌面壳拉起的每个 dsh 实例（profile × 端口 × pid）落一份本地台账，
//! 供「复用 vs 占用」判定与停止自家实例使用。文件放
//! `$DSH_HOME/dsh-desktop-tauriapp/instances.json`（壳私有目录，不碰 dsh 数据）。
//! 台账只做尽力而为的权威来源：进程崩溃残留的陈旧记录由认领判定兜底
//! （端口无监听即视为 Free，记录不阻塞启动）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 一条实例记录：桌面壳 spawn 的 dsh 子进程。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct InstanceRecord {
    pub(crate) profile: String,
    pub(crate) port: u16,
    pub(crate) lane_port: u16,
    pub(crate) pid: u32,
    /// spawn 时刻（epoch 秒；仅供排查）。
    #[serde(default)]
    pub(crate) spawned_at: u64,
    /// dsh 来源（"builtin"/"external"，spawn 时记录；#90 运行态展示用）。
    #[serde(default)]
    pub(crate) source: String,
}

/// 台账文件路径（`$DSH_HOME/dsh-desktop-tauriapp/instances.json`）。
pub(crate) fn instances_path() -> PathBuf {
    crate::dsh_home()
        .join("dsh-desktop-tauriapp")
        .join("instances.json")
}

/// 从指定路径读台账（缺失/损坏 → 空表；路径显式传参便于测试）。
pub(crate) fn load_instances_from(path: &std::path::Path) -> Vec<InstanceRecord> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub(crate) fn load_instances() -> Vec<InstanceRecord> {
    load_instances_from(&instances_path())
}

/// 原子写台账（.tmp + rename；父目录自动创建）。
pub(crate) fn save_instances_to(path: &std::path::Path, records: &[InstanceRecord]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(json) = serde_json::to_string_pretty(records) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// 登记/更新实例（纯函数核心）：同 profile 旧记录与同端口旧记录都清掉——
/// 端口是独占资源，profile 单实例（#93 硬约束）。
pub(crate) fn register_instance_into(records: &mut Vec<InstanceRecord>, rec: InstanceRecord) {
    records.retain(|r| r.profile != rec.profile && r.port != rec.port);
    records.push(rec);
}

/// 登记实例到默认台账路径。
pub(crate) fn register_instance(profile: &str, port: u16, lane_port: u16, pid: u32, source: &str) {
    let mut records = load_instances();
    register_instance_into(
        &mut records,
        InstanceRecord {
            profile: profile.to_string(),
            port,
            lane_port,
            pid,
            source: source.to_string(),
            spawned_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        },
    );
    save_instances_to(&instances_path(), &records);
}

/// 摘除 profile 的记录（停止/退出自家实例时调用）。
pub(crate) fn remove_instance(profile: &str) {
    let mut records = load_instances();
    let before = records.len();
    records.retain(|r| r.profile != profile);
    if records.len() != before {
        save_instances_to(&instances_path(), &records);
    }
}

/// 认领判定（#86）：把旧的「端口有监听就复用」细分为四种语义，
/// 排掉「端口被别的 profile / 陌生程序占用却盲目复用」的坑。
#[derive(Debug, PartialEq)]
pub(crate) enum ClaimDecision {
    /// 端口空闲，可以 spawn。
    Free,
    /// 台账确认这是本 profile 的实例 → 复用接入。
    Ours,
    /// 无台账、但落在 web 的 legacy 端口上 → 兼容复用（外部 dsh，现行行为保留）。
    ForeignWeb,
    /// 陌生监听者（别的 profile / 别的程序）→ 明确提示，绝不盲目复用或代杀。
    ForeignUnknown,
}

/// 认领判定（纯函数）：`port_open` 由调用方探测后传入，便于单测。
/// `legacy_web_port` = configured_port()，即外部 dsh 的历史默认落点。
pub(crate) fn decide_claim(
    profile: &str,
    port: u16,
    port_open: bool,
    registry: &[InstanceRecord],
    legacy_web_port: u16,
) -> ClaimDecision {
    if !port_open {
        return ClaimDecision::Free;
    }
    if registry.iter().any(|r| r.profile == profile && r.port == port) {
        return ClaimDecision::Ours;
    }
    if profile == "web" && port == legacy_web_port {
        return ClaimDecision::ForeignWeb;
    }
    ClaimDecision::ForeignUnknown
}

/// 停掉自家实例（异步）：台账有记录先杀 pid 并等端口释放，兜底 stop_port_owner。
/// 对台账外的监听者（外部 dsh）不在此处理——那是模式切换流程（choose_desktop_mode）
/// 的显式用户选择，语义不同。消费者：#89 多窗口（每窗口停止自己的实例）；
/// 单窗口重启走 tray 的 child.kill + stop_port_owner（child 句柄需要就地回收防僵尸）。
#[allow(dead_code)]
pub(crate) async fn stop_own_instance(profile: &str) -> bool {
    use crate::process::lifecycle::{kill_process, port_open, stop_port_owner};
    let port = crate::settings::port_for_profile(profile);
    let registry = load_instances();
    if let Some(rec) = registry.iter().find(|r| r.profile == profile) {
        kill_process(rec.pid);
        for _ in 0..30 {
            if !port_open(rec.port) {
                remove_instance(profile);
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    let freed = stop_port_owner(port).await;
    if freed {
        remove_instance(profile);
    }
    freed
}

/// 判定 authority（host:port）是否指向本壳管理的本地实例（下载凭据注入用，#72/#86）。
/// 覆盖：台账里所有实例端口 + web 的 legacy 端口（外部复用实例）。
pub(crate) fn is_local_instance_authority(authority: &str) -> bool {
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    if host != "127.0.0.1" && host != "localhost" {
        return false;
    }
    let Ok(port) = port.parse::<u16>() else { return false };
    if port == crate::settings::configured_port() {
        return true;
    }
    load_instances().iter().any(|r| r.port == port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(profile: &str, port: u16) -> InstanceRecord {
        InstanceRecord {
            profile: profile.into(),
            port,
            lane_port: port + 10,
            pid: 100,
            source: "external".into(),
            spawned_at: 0,
        }
    }

    #[test]
    fn claim_free_when_port_closed() {
        assert_eq!(
            decide_claim("web", 3080, false, &[], 3080),
            ClaimDecision::Free
        );
    }

    #[test]
    fn claim_ours_when_registry_matches() {
        let reg = vec![rec("desktop", 3081)];
        assert_eq!(
            decide_claim("desktop", 3081, true, &reg, 3080),
            ClaimDecision::Ours
        );
    }

    #[test]
    fn claim_foreign_web_for_legacy_reuse() {
        // 无台账 + web profile + legacy 端口 → 兼容复用外部实例（现行行为）
        assert_eq!(
            decide_claim("web", 3080, true, &[], 3080),
            ClaimDecision::ForeignWeb
        );
    }

    #[test]
    fn claim_foreign_unknown_for_other_profile_or_stranger() {
        let reg = vec![rec("web", 3080)];
        // desktop 的端口上挂着 web 的实例 → 不是 desktop 的，不能复用
        assert_eq!(
            decide_claim("desktop", 3080, true, &reg, 3080),
            ClaimDecision::ForeignUnknown
        );
        // 完全陌生的监听者
        assert_eq!(
            decide_claim("research", 3100, true, &[], 3080),
            ClaimDecision::ForeignUnknown
        );
    }

    #[test]
    fn register_upserts_by_profile_and_port() {
        let mut records = vec![rec("web", 3080), rec("desktop", 3081)];
        register_instance_into(&mut records, rec("web", 3090)); // 换端口的 web
        assert!(!records.iter().any(|r| r.profile == "web" && r.port == 3080));
        assert!(records.iter().any(|r| r.profile == "web" && r.port == 3090));
        assert_eq!(records.len(), 2);
        // 同端口不同 profile：新记录顶掉旧记录（端口独占）
        let mut records2 = vec![rec("web", 3080)];
        register_instance_into(&mut records2, rec("other", 3080));
        assert!(records2.iter().all(|r| r.profile != "web"));
        assert_eq!(records2.len(), 1);
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dsh-instances-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("instances.json");
        let mut records = vec![];
        register_instance_into(&mut records, rec("web", 3080));
        register_instance_into(&mut records, rec("desktop", 3081));
        save_instances_to(&path, &records);
        let back = load_instances_from(&path);
        assert_eq!(back, records);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_tolerates_garbage() {
        let dir = std::env::temp_dir().join(format!("dsh-instances-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("instances.json");
        std::fs::write(&path, "not json").unwrap();
        assert!(load_instances_from(&path).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
