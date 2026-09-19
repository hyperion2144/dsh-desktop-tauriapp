//! 运行时核心：状态、状态机、域错误。
pub mod error;
pub mod phase;
pub mod state;
pub mod instances;
pub mod builtin;
pub mod registry; // dsh 运行时仓库：版本目录/下载安装/多版本共存（#95）
