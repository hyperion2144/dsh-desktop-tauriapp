//! 领域错误类型体系（thiserror）。
//!
//! 应用层错误统一用 `anyhow::Result`（命令处理等）；
//! 领域层错误用 thiserror 枚举，保留结构化信息供调用方 match。


/// dsh 子进程 spawn 失败。
#[derive(Debug, Clone, thiserror::Error)]
pub enum SpawnError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Other(String),
}

/// 代理配置或探测错误。
#[derive(Debug, Clone, thiserror::Error)]
pub enum ProxyError {
    /// URL 格式非法。
    #[error("代理 URL 格式非法：{0}")]
    InvalidUrl(String),
    /// 系统代理探测失败。
    #[error("系统代理探测失败：{0}")]
    SystemProbeFailed(String),
    /// 不支持的代理模式。
    #[error("不支持的代理模式：{0}")]
    UnknownMode(String),
}

/// 导航流程错误。
#[derive(Debug, Clone, thiserror::Error)]
pub enum NavigationError {
    /// 端口未就绪。
    #[error("端口 {0} 未就绪")]
    PortNotReady(u16),
    /// token 交换失败。
    #[error("会话 cookie 交换失败")]
    TokenExchangeFailed,
    /// 远程地址不可达。
    #[error("远程地址不可达：{0}")]
    RemoteUnreachable(String),
}

/// 设置读写错误。
#[derive(Debug, Clone, thiserror::Error)]
pub enum SettingsError {
    /// YAML 解析失败。
    #[error("settings.yaml 解析失败：{0}")]
    ParseFailed(String),
    /// 文件 I/O 失败。
    #[error("settings.yaml I/O 失败：{0}")]
    IoFailed(String),
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_error_display() {
        assert_eq!(SpawnError::NotFound("nope".into()).to_string(), "nope");
        assert_eq!(SpawnError::Other("boom".into()).to_string(), "boom");
    }

    // —— 共享模块池挂载（bug #22：scoped 包名挂载）——

    fn pool_test_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dsh-pool-test-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pool_test_pkg(root: &std::path::Path, name: &str) -> std::path::PathBuf {
        let pkg = root.join(name);
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), "{\"name\":\"fake\"}\n").unwrap();
        pkg
    }

}
