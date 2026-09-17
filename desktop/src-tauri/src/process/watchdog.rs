//! 守护器卡死判定（#71）。
//!
//! 健康探活归探测模块；本模块只回答一个问题：
//! 「自家子进程还活着、但端口持续不可达」时，该继续等（启动窗口）还是判卡死（完整重启）。
//! 此前的实现把「子进程存活」无条件当启动窗口且无日志，dsh 外层进程存活、
//! 里层服务已死时会被永久静默跳过（#71 现场：48 分钟端口不可达、零日志、零自愈）。

use std::time::Duration;

/// 启动窗口上限：子进程存活但端口不可达超过该时长即判卡死。
/// 3 分钟 = 远大于正常冷启动（<1 分钟）与单次判异常耗时（3×5s 探测），
/// 又能把「外层活着里层死了」的静默坑压到分钟级自愈。
pub(crate) const STUCK_WINDOW: Duration = Duration::from_secs(180);

/// 「子进程存活但端口不可达」分支的判定结果。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StuckDecision {
    /// 仍在启动窗口内：跳过自愈（防托盘/切模式重启后的二次重启）。
    StartingWindow,
    /// 超出窗口：进程活着但服务已死，判卡死，走完整重启。
    Stuck,
}

/// 纯函数判定，便于单测覆盖矩阵（#71）。
/// `unreachable_for`：端口自本次失联起的持续时长；`window`：启动窗口上限。
pub(crate) fn decide_stuck(unreachable_for: Duration, window: Duration) -> StuckDecision {
    if unreachable_for >= window {
        StuckDecision::Stuck
    } else {
        StuckDecision::StartingWindow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_window_skips() {
        // 冷启动正常范围（0s ~ 上限内）一律视为启动窗口。
        assert_eq!(decide_stuck(Duration::from_secs(0), STUCK_WINDOW), StuckDecision::StartingWindow);
        assert_eq!(decide_stuck(Duration::from_secs(15), STUCK_WINDOW), StuckDecision::StartingWindow);
        assert_eq!(decide_stuck(Duration::from_secs(179), STUCK_WINDOW), StuckDecision::StartingWindow);
    }

    #[test]
    fn at_and_beyond_window_is_stuck() {
        // 边界：恰达上限即判卡死（不等下一次探测）。
        assert_eq!(decide_stuck(Duration::from_secs(180), STUCK_WINDOW), StuckDecision::Stuck);
        assert_eq!(decide_stuck(Duration::from_secs(3600), STUCK_WINDOW), StuckDecision::Stuck);
    }

    #[test]
    fn window_is_parameter_not_hardcoded() {
        // 上限可作参数传入（后续配置化不留死角）。
        assert_eq!(decide_stuck(Duration::from_secs(10), Duration::from_secs(10)), StuckDecision::Stuck);
        assert_eq!(decide_stuck(Duration::from_secs(9), Duration::from_secs(10)), StuckDecision::StartingWindow);
    }

    #[test]
    fn stuck_window_constant_sanity() {
        // 常量基线：≥1 分钟（避免误伤慢启动）、≤10 分钟（不能退化回无限静默）。
        assert!(STUCK_WINDOW >= Duration::from_secs(60));
        assert!(STUCK_WINDOW <= Duration::from_secs(600));
    }
}
