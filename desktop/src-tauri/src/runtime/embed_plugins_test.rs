//! #212：把 build script 的 staging 核心（`build_support/embed_plugins.rs`）拉进测试目标。
//!
//! `build.rs` 只在编译期运行、本身不参与 `cargo test`，所以「空 `lib/` ⇒ 构建失败」「递归拷贝」
//! 「不跟随符号链接」这些行为原本只能靠手工复现（0.12.0 事故就是手工才发现）。这里以**同一份
//! 源码**建一个测试专用模块，让 `cargo test` 直接跑到那份代码里的 `#[cfg(test)] mod tests`。
//!
//! 生产构建不受影响：本模块与 `#[path]` 声明都在 `cfg(test)` 下。

#[cfg(test)]
#[path = "../../build_support/embed_plugins.rs"]
mod staging;
