//! spawn dsh 时的壳身份 env 组装（#199）。
//!
//! 运行时自带装配（`dsh-web-app/cordis.patch.yml` 的 desktop-product-telemetry 行）从
//! 环境变量读客户端标识：`serviceVersion: !!js process.env.DSH_CLIENT_VERSION`
//! （product-analytics 行的 appVersion 同源）。壳此前从未注入，该插件的必填校验
//! 一直失败——0.2.1-alpha.1 容忍为 warning，0.2.1-alpha.2 起升级为致命 StartupError，
//! 桌面档完全无法启动。unix / windows 两处 `spawn_dsh` 统一经此注入，键名即契约。

/// 组装客户端身份 env：`DSH_CLIENT_VERSION` = 壳（桌面 App）版本。
pub(crate) fn client_identity_envs(version: &str) -> Vec<(&'static str, String)> {
    vec![("DSH_CLIENT_VERSION", version.to_string())]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #199：键名是与运行时装配的硬契约（!!js process.env.DSH_CLIENT_VERSION），
    /// 值逐字等于传入的 App 版本。
    #[test]
    fn client_identity_envs_injects_dsh_client_version() {
        assert_eq!(
            client_identity_envs("0.12.0"),
            vec![("DSH_CLIENT_VERSION", "0.12.0".to_string())]
        );
    }
}
