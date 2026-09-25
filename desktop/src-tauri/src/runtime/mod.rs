//! 运行时核心：共享状态（两态生命周期）与域错误。
pub mod error;
pub mod state;
pub mod instances;
pub mod builtin;
pub mod registry; // dsh 运行时仓库：版本目录/下载安装/多版本共存（#95）
pub mod paths; // 资源路径 verbatim 归一（#123）
