//! DshPhase 状态机：形式化的服务状态枚举 + 合法转换校验。
//!
//! 设计来源：wayfinder 票据 #45 决议。
//! - `#[repr(u8)]` 保持与前端 JSON 数字兼容（`{"status": 2, "detail": "..."}`）。
//! - `transition()` 运行时校验合法对，非法返回 `TransitionError`。
//! - `from_u8()` 从旧 `STATUS_*` 常量值还原 enum（迁移期桥接）。

use crate::runtime::error::TransitionError;

/// dsh 服务生命周期阶段。
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub enum DshPhase {
    /// 初始（仅构造时）。
    Idle = 0,
    /// 启动中。
    Starting = 1,
    /// 运行中。
    Ready = 2,
    /// 复用外部实例。
    External = 3,
    /// 重启中。
    Restarting = 4,
    /// 实例不可达。
    Stale = 5,
    /// 进程死亡（spawn 失败或意外退出）。
    Down = 6,
    /// 远程模式。
    Remote = 7,
}

impl DshPhase {
    /// 从 u8 值还原 enum；非法值回退到 `Idle`。
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Idle,
            1 => Self::Starting,
            2 => Self::Ready,
            3 => Self::External,
            4 => Self::Restarting,
            5 => Self::Stale,
            6 => Self::Down,
            7 => Self::Remote,
            _ => Self::Idle,
        }
    }
}

/// 校验状态转换是否合法；合法返回 `Ok(to)`，非法返回 `Err(TransitionError)`。
///
/// 合法转换图（来自 #45 决议）：
/// ```text
/// IDLE      → STARTING, EXTERNAL
/// STARTING  → READY, STARTING, DOWN
/// EXTERNAL  → READY, STARTING
/// READY     → RESTARTING, STALE, REMOTE, DOWN
/// RESTARTING→ READY, STALE, DOWN
/// STALE     → READY, STALE
/// REMOTE    → READY, REMOTE
/// DOWN      → READY, RESTARTING
/// ```
pub fn transition(from: DshPhase, to: DshPhase) -> Result<DshPhase, TransitionError> {
    use DshPhase::*;
    let ok = match (from, to) {
        (Idle, Starting | External) => true,
        (Starting, Ready | Starting | Down) => true,
        (External, Ready | Starting) => true,
        (Ready, Restarting | Stale | Remote | Down) => true,
        (Restarting, Ready | Stale | Down) => true,
        (Stale, Ready | Stale) => true,
        (Remote, Ready | Remote) => true,
        (Down, Ready | Restarting) => true,
        _ => false,
    };
    if ok {
        Ok(to)
    } else {
        Err(TransitionError { from, to })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_legal_transitions() {
        assert_eq!(transition(DshPhase::Idle, DshPhase::Starting), Ok(DshPhase::Starting));
        assert_eq!(transition(DshPhase::Idle, DshPhase::External), Ok(DshPhase::External));
        assert_eq!(transition(DshPhase::Starting, DshPhase::Ready), Ok(DshPhase::Ready));
        assert_eq!(transition(DshPhase::Starting, DshPhase::Down), Ok(DshPhase::Down));
        assert_eq!(transition(DshPhase::Ready, DshPhase::Restarting), Ok(DshPhase::Restarting));
        assert_eq!(transition(DshPhase::Down, DshPhase::Ready), Ok(DshPhase::Ready));
        assert_eq!(transition(DshPhase::Down, DshPhase::Restarting), Ok(DshPhase::Restarting));
    }

    #[test]
    fn test_illegal_transitions() {
        assert!(transition(DshPhase::Idle, DshPhase::Ready).is_err());
        assert!(transition(DshPhase::Idle, DshPhase::Down).is_err());
        assert!(transition(DshPhase::Ready, DshPhase::Idle).is_err());
        assert!(transition(DshPhase::Down, DshPhase::Idle).is_err());
        assert!(transition(DshPhase::Remote, DshPhase::Starting).is_err());
    }

    #[test]
    fn test_from_u8_roundtrip() {
        for v in 0..=7u8 {
            let phase = DshPhase::from_u8(v);
            assert_eq!(phase as u8, v);
        }
        // 非法值回退到 Idle
        assert_eq!(DshPhase::from_u8(255), DshPhase::Idle);
    }
}
