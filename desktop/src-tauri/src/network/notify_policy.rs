//! 通知场景策略层（#142 / 规格 #143 / T3 决策）：场景表 + 投递决策纯函数。
//!
//! 本模块是通知系统的唯一决策缝：给定（notifications 配置、场景 id、当前时刻、
//! 全屏标志）判定「是否投递、是否静默、用哪个声音」。纯函数、无 IO、无副作用，
//! 48 处 `show_notification` 调用点只传场景 id，策略全部在此收口。

use crate::settings::NotificationsConfig;

/// 场景 id 常量（T3 决议的 12 类；desktop-settings.json `notifications.scenarios` 的键）。
pub mod scenario {
    pub const STARTUP_ERROR: &str = "startup.error";
    pub const RUNTIME_SWITCH: &str = "runtime.switch";
    pub const RUNTIME_DOWNLOAD: &str = "runtime.download";
    pub const SERVICE_HEALTH: &str = "service.health";
    pub const WINDOW_LIFECYCLE: &str = "window.lifecycle";
    pub const INSTANCE_LIFECYCLE: &str = "instance.lifecycle";
    pub const TASK_COMPLETE: &str = "task.complete";
    pub const DOWNLOAD_COMPLETE: &str = "download.complete";
    pub const PROFILE_OP: &str = "profile.op";
    pub const PROFILE_ERROR: &str = "profile.error";
    pub const CONFIG_ERROR: &str = "config.error";
    pub const CONFIG_INFO: &str = "config.info";
}

/// 场景展示元数据（设置 tab 分组渲染用；显示名/分组为 T4 原型提案，已获用户采纳）。
#[derive(Clone, Copy)]
pub struct ScenarioMeta {
    pub id: &'static str,
    pub group: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub default_on: bool,
}

/// 六组展示分组（顺序即 tab 内出现顺序）。
pub const GROUPS: [(&str, &str); 6] = [
    ("g-run", "启动与服务"),
    ("g-win", "窗口与实例"),
    ("g-prof", "Profile"),
    ("g-dl", "下载"),
    ("g-task", "任务"),
    ("g-cfg", "配置"),
];

/// 12 场景元数据表（唯一事实源；设置 tab 与配置默认值都从这里派生）。
pub const SCENARIOS: [ScenarioMeta; 12] = [
    ScenarioMeta { id: scenario::STARTUP_ERROR, group: "g-run", name: "启动受阻", desc: "spawn 失败 · 自愈封顶", default_on: true },
    ScenarioMeta { id: scenario::RUNTIME_SWITCH, group: "g-run", name: "运行时切换", desc: "内置 / 外部 dsh 切换结果", default_on: true },
    ScenarioMeta { id: scenario::RUNTIME_DOWNLOAD, group: "g-run", name: "运行时下载", desc: "运行时下载开始 / 失败", default_on: true },
    ScenarioMeta { id: scenario::SERVICE_HEALTH, group: "g-run", name: "服务健康", desc: "不可达 · 自动重启", default_on: true },
    ScenarioMeta { id: scenario::WINDOW_LIFECYCLE, group: "g-win", name: "窗口生命周期", desc: "窗口恢复 / 异常", default_on: false },
    ScenarioMeta { id: scenario::INSTANCE_LIFECYCLE, group: "g-win", name: "实例生命周期", desc: "端口认领冲突 / 归属提示", default_on: false },
    ScenarioMeta { id: scenario::PROFILE_OP, group: "g-prof", name: "Profile 操作", desc: "新建 / 迁移完成", default_on: true },
    ScenarioMeta { id: scenario::PROFILE_ERROR, group: "g-prof", name: "Profile 错误", desc: "启动失败 / 修复失败", default_on: true },
    ScenarioMeta { id: scenario::DOWNLOAD_COMPLETE, group: "g-dl", name: "下载完成", desc: "文件下载结束", default_on: true },
    ScenarioMeta { id: scenario::TASK_COMPLETE, group: "g-task", name: "任务完成", desc: "失焦时提醒回来看看", default_on: true },
    ScenarioMeta { id: scenario::CONFIG_ERROR, group: "g-cfg", name: "配置错误", desc: "token 无法识别等", default_on: true },
    ScenarioMeta { id: scenario::CONFIG_INFO, group: "g-cfg", name: "配置提示", desc: "端口保存等低危信息", default_on: false },
];

pub fn meta_of(scenario_id: &str) -> Option<&'static ScenarioMeta> {
    SCENARIOS.iter().find(|s| s.id == scenario_id)
}

/// 场景默认配置（未知场景回退：开 + 系统默认音）。
pub fn default_scenario_config(scenario_id: &str) -> (bool, String) {
    let on = meta_of(scenario_id).map(|m| m.default_on).unwrap_or(true);
    (on, "default".to_string())
}

/// 全场景默认配置映射（NotificationsConfig::default 用）。
pub fn default_scenarios_map() -> std::collections::BTreeMap<String, crate::settings::NotificationScenarioConfig> {
    SCENARIOS
        .iter()
        .map(|m| {
            (
                m.id.to_string(),
                crate::settings::NotificationScenarioConfig { enabled: m.default_on, sound: "default".to_string() },
            )
        })
        .collect()
}

/// 声音档位（ADR-0001 三分语义的决策产物）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SoundChoice {
    /// OS 通知渠道默认音（macOS UN default sound / Windows toast 默认声）
    OsDefault,
    /// 静默（无声或被免打扰/全屏压掉）
    Silent,
    /// 自定义音：应用侧 rodio 播放（相对 sounds 目录的文件名）
    Custom(String),
}

/// 一次通知的投递决策。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyDecision {
    /// false = 该通知整体不投递（总开关关 / 场景关）
    pub deliver: bool,
    /// true = 投递但无声（免打扰时段 / 全屏静默命中；仍进系统通知中心）
    pub silent: bool,
    pub sound: SoundChoice,
}

/// 解析 "HH:MM" 为 (小时, 分钟)；非法输入返回 None。
fn parse_hm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.trim().parse().ok()?;
    let m: u32 = m.trim().parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

/// 时刻是否落在 [from, to) 免打扰窗内（支持跨午夜，如 22:00–08:00）。
pub fn in_dnd_window(now: (u32, u32), from: &str, to: &str) -> bool {
    let (Some(f), Some(t)) = (parse_hm(from), parse_hm(to)) else {
        return false;
    };
    let cur = now.0 * 60 + now.1;
    let f = f.0 * 60 + f.1;
    let t = t.0 * 60 + t.1;
    if f == t {
        return false; // 零长度窗视为未配置
    }
    if f < t {
        cur >= f && cur < t
    } else {
        cur >= f || cur < t
    }
}


/// 投递决策（纯函数）。
///
/// - 总开关关 / 场景关 → 不投递
/// - 免打扰开且命中时段，或「全屏静默」开且 fullscreen=true → 投递但静默
/// - 声音：场景配置 none→Silent / default→OsDefault / custom:名→Custom
pub fn decide(
    cfg: &NotificationsConfig,
    scenario_id: &str,
    now: (u32, u32),
    fullscreen: bool,
) -> NotifyDecision {
    if !cfg.enabled {
        return NotifyDecision { deliver: false, silent: false, sound: SoundChoice::Silent };
    }
    let (sc_on, sc_sound) = match cfg.scenarios.get(scenario_id) {
        Some(sc) => (sc.enabled, sc.sound.clone()),
        None => default_scenario_config(scenario_id),
    };
    if !sc_on {
        return NotifyDecision { deliver: false, silent: false, sound: SoundChoice::Silent };
    }

    let dnd = &cfg.dnd;
    let dnd_hit = dnd.on && in_dnd_window(now, &dnd.from, &dnd.to);
    let fs_hit = dnd.suppress_fullscreen && fullscreen;
    let silent = dnd_hit || fs_hit;

    let sound = if silent {
        SoundChoice::Silent
    } else if let Some(name) = sc_sound.strip_prefix("custom:") {
        if name.is_empty() {
            SoundChoice::Silent
        } else {
            SoundChoice::Custom(name.to_string())
        }
    } else if sc_sound == "none" {
        SoundChoice::Silent
    } else {
        SoundChoice::OsDefault
    };

    NotifyDecision { deliver: true, silent, sound }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn cfg_full() -> NotificationsConfig {
        let mut c = NotificationsConfig::default();
        c.enabled = true;
        c.dnd.on = false;
        c.scenarios.insert(
            "task.complete".into(),
            crate::settings::NotificationScenarioConfig { enabled: true, sound: "default".into() },
        );
        c
    }

    #[test]
    fn master_switch_off_silences_everything() {
        let mut c = cfg_full();
        c.enabled = false;
        let d = decide(&c, "task.complete", (12, 0), false);
        assert!(!d.deliver);
    }

    #[test]
    fn scenario_off_skips_delivery() {
        let mut c = cfg_full();
        c.scenarios.get_mut("task.complete").unwrap().enabled = false;
        let d = decide(&c, "task.complete", (12, 0), false);
        assert!(!d.deliver);
    }

    #[test]
    fn unknown_scenario_falls_back_to_default_on() {
        let c = NotificationsConfig::default();
        let d = decide(&c, "task.complete", (12, 0), false);
        assert!(d.deliver);
        assert_eq!(d.sound, SoundChoice::OsDefault);
    }

    #[test]
    fn window_lifecycle_defaults_off() {
        let c = NotificationsConfig::default();
        let d = decide(&c, "window.lifecycle", (12, 0), false);
        assert!(!d.deliver);
    }

    #[test]
    fn dnd_window_same_day_mutes() {
        let mut c = cfg_full();
        c.dnd.on = true;
        c.dnd.from = "22:00".into();
        c.dnd.to = "23:00".into();
        let d = decide(&c, "task.complete", (22, 30), false);
        assert!(d.deliver && d.silent && d.sound == SoundChoice::Silent);
        let d2 = decide(&c, "task.complete", (21, 59), false);
        assert!(d2.deliver && !d2.silent);
    }

    #[test]
    fn dnd_window_overnight_wraps() {
        let mut c = cfg_full();
        c.dnd.on = true;
        c.dnd.from = "22:00".into();
        c.dnd.to = "08:00".into();
        assert!(in_dnd_window((23, 30), "22:00", "08:00"));
        assert!(in_dnd_window((0, 30), "22:00", "08:00"));
        assert!(in_dnd_window((7, 59), "22:00", "08:00"));
        assert!(!in_dnd_window((8, 0), "22:00", "08:00"));
        let d = decide(&c, "task.complete", (3, 0), false);
        assert!(d.silent);
    }

    #[test]
    fn fullscreen_mutes_only_when_configured() {
        let mut c = cfg_full();
        c.dnd.suppress_fullscreen = true;
        let d = decide(&c, "task.complete", (12, 0), true);
        assert!(d.silent);
        c.dnd.suppress_fullscreen = false;
        let d2 = decide(&c, "task.complete", (12, 0), true);
        assert!(!d2.silent);
    }

    #[test]
    fn sound_choices_map() {
        let mut c = cfg_full();
        let mut m = BTreeMap::new();
        m.insert("task.complete".to_string(), crate::settings::NotificationScenarioConfig { enabled: true, sound: "none".into() });
        m.insert("download.complete".to_string(), crate::settings::NotificationScenarioConfig { enabled: true, sound: "custom:alert.wav".into() });
        c.scenarios = m;
        assert_eq!(decide(&c, "task.complete", (12, 0), false).sound, SoundChoice::Silent);
        assert_eq!(
            decide(&c, "download.complete", (12, 0), false).sound,
            SoundChoice::Custom("alert.wav".into())
        );
    }

    #[test]
    fn invalid_dnd_time_never_mutes() {
        let mut c = cfg_full();
        c.dnd.on = true;
        c.dnd.from = "bad".into();
        c.dnd.to = "08:00".into();
        let d = decide(&c, "task.complete", (3, 0), false);
        assert!(!d.silent);
    }

    #[test]
    fn scenario_table_has_twelve_unique_ids() {
        let mut ids: Vec<_> = SCENARIOS.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n);
        assert_eq!(n, 12);
    }
}
