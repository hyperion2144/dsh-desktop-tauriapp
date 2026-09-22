//! lane TCP 转发器（#94）：手机稳定接入点 → 焦点实例 lane。
//!
//! 各实例 lane 端口整体错开（3092 起，#86/#94），壳在 3091（遗留手机配置端口）
//! 监听并转发到「焦点窗口实例」的 lane——手机旧配置零改动，新连接始终落焦点
//! 实例（存量长连接不切换，SSE/WS 保持原实例，新请求落新目标）。

use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};

/// 当前焦点实例的 lane 端口（0 = 无目标：连接直接关闭）。
static FOCUSED_LANE: AtomicU16 = AtomicU16::new(0);

/// 更新焦点实例 lane 端口（窗口焦点事件调用）。
pub(crate) fn set_focused_lane(port: u16) {
    let prev = FOCUSED_LANE.swap(port, Ordering::SeqCst);
    if prev != port {
        log::info!("[forwarder] lane 目标 → {port}");
    }
}

/// 启动转发器（setup 调一次）：监听 configured_lane_port()。
pub(crate) async fn start() {
    let port = crate::settings::configured_lane_port();
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            // 常见原因：外部 dsh 自身 lane 占了 3091——此时手机直连它即可，转发器退场
            log::warn!("[forwarder] 端口 {port} 监听失败（{e}），lane 焦点跟随不可用");
            return;
        }
    };
    log::info!("[forwarder] 手机稳定接入点 127.0.0.1:{port}（跟随焦点窗口）");
    loop {
        match listener.accept().await {
            Ok((mut inbound, _)) => {
                let target = FOCUSED_LANE.load(Ordering::SeqCst);
                if target == 0 {
                    drop(inbound);
                    continue;
                }
                tokio::spawn(async move {
                    match TcpStream::connect(("127.0.0.1", target)).await {
                        Ok(mut outbound) => {
                            let _ = copy_bidirectional(&mut inbound, &mut outbound).await;
                        }
                        Err(e) => log::warn!("[forwarder] 连接目标 {target} 失败：{e}"),
                    }
                });
            }
            Err(e) => {
                log::warn!("[forwarder] accept 失败：{e}");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}
