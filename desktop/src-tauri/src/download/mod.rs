//! 下载管理器模块（#72）：
//! model（状态机/快照）→ persist（tasks.json 跨重启恢复）→ transfer（流式传输）
//! → manager（调度/动作/事件）→ commands（Tauri 命令面）。

pub(crate) mod commands;
pub(crate) mod manager;
pub(crate) mod model;
pub(crate) mod persist;
pub(crate) mod transfer;

pub(crate) use manager::DownloadManager;
