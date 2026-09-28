//! 壳内 loopback origin 服务（ADR 0003 / #154）：页面的 origin 由壳自己提供。
//!
//! 这个服务同时是三件事：**静态资产的本地优先叠加**（读当前生效运行时的
//! `dsh-web-frontend/dist`）、**到真实 dsh 的流式数据面**（`/api/*`、`/plugins/*`、SSE、WS）。
//!
//! **文档与静态资产从本地运行时出**，Host 只做数据接口：唯一从 Host 取的是它往
//! `<head>`/`<body>` 注入的那几行（模块加载器 facade、application preload、bootstrap
//! script-src、`globalThis.__DSH_BOOT__`），见 [`scheme`]。
//!
//! 数据面**不过协议处理器**：`UriSchemeResponder` 是缓冲的（`tauri-2.11.5/src/app.rs:2455`
//! 的 `Box<dyn FnOnce(Response<…>)>`），SSE 经它必挂。文档里的 `<base>` 被改写到
//! [`stream_proxy`] 的 loopback origin，页面的相对请求全部落在那条真 TCP 连接上：
//! Cookie 由壳注入、`Origin`/`Sec-Fetch-*` 改写为同源、CORS 回 `*`。
//!
//! 模块划分：`scheme`（协议处理器：文档 + 本地资产）、`stream_proxy`（loopback 流式数据面）、
//! `assets`（运行时 dist 解析）、`head`（HTTP 头编解码纯函数）、`upstream`（上游客源与连接）。
//! 本模块只管生命周期与壳持有的会话 cookie。

pub(crate) mod assets;
mod head;
mod upstream;
pub(crate) mod scheme;
pub(crate) mod stream_proxy;

use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

/// 一次启动/一次导航的会话重置换：清掉旧 authority 的会话与远程产物锁定，
/// 并让资产解析重新求值。
pub(crate) fn reset() {
    clear_session();
    assets::set_dist_override(None);
    assets::invalidate();
}

pub(crate) use upstream::{parse_remote, split_authority};

/// 壳持有的上游会话：cookie 的 authority 必须与写入 Host 头的一致
/// （dsh 的 cookie 名是 `sha256(authority)`），不一致就当作没有。
struct Session {
    authority: String,
    cookie: String,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// 数据面代理 origin（`http://127.0.0.1:<port>/`），由 [`stream_proxy`] 启动时写入。
static PROXY: OnceLock<String> = OnceLock::new();

/// 启动壳内数据面（setup 调用一次）：起 loopback 流式代理，返回它的 origin
/// （`http://127.0.0.1:<port>/`，端口由系统分配）。
///
/// 页面文档不需要 loopback 监听：它由 [`scheme`] 的协议处理器从本地 dist 直接回答。
pub(crate) fn start(app: AppHandle) -> Option<String> {
    match stream_proxy::start(app) {
        Some(origin) => {
            log::info!("[shell-origin] 数据面代理就绪：{origin}");
            let _ = PROXY.set(origin.clone());
            Some(origin)
        }
        None => {
            log::warn!("[shell-origin] 流式代理未启动：相对请求将不可用");
            None
        }
    }
}

/// 数据面代理 origin；未启动（或启动失败）返回 None。
pub(crate) fn proxy_origin() -> Option<String> {
    PROXY.get().cloned()
}


/// 记下壳持有的上游会话 cookie（`name=value`）。
pub(crate) fn set_session(authority: &str, cookie: String) {
    if cookie.trim().is_empty() {
        return;
    }
    *SESSION.lock().unwrap() = Some(Session {
        authority: authority.to_string(),
        cookie,
    });
}

/// 清空会话（重启 dsh / 切 profile / 切远程前调用：旧 cookie 属于旧 authority）。
pub(crate) fn clear_session() {
    *SESSION.lock().unwrap() = None;
}

/// 与 authority 匹配的会话 cookie；不匹配返回 None（当作未认证转发）。
pub(crate) fn session_cookie(authority: &str) -> Option<String> {
    let guard = SESSION.lock().unwrap();
    guard
        .as_ref()
        .filter(|s| s.authority == authority)
        .map(|s| s.cookie.clone())
}



#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn session_cookie_is_bound_to_authority() {
        clear_session();
        assert_eq!(session_cookie("127.0.0.1:3080"), None);

        set_session("127.0.0.1:3080", "dsh-auth-x=v1".to_string());
        assert_eq!(
            session_cookie("127.0.0.1:3080").as_deref(),
            Some("dsh-auth-x=v1")
        );
        assert_eq!(session_cookie("127.0.0.1:3081"), None, "换端口必须重换会话");

        clear_session();
        assert_eq!(session_cookie("127.0.0.1:3080"), None);
    }

    #[test]
    fn set_session_ignores_blank_value() {
        clear_session();
        set_session("h:1", "   ".to_string());
        assert_eq!(session_cookie("h:1"), None);
    }
}
