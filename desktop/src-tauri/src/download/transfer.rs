//! URL 任务传输执行：认证（token→cookie 交换）、Range 续传、流式写 .part、
//! 节流进度上报。
//!
//! #72 关键约束：进度只能来自这里（wry 的 on_download 无进度回调）；
//! 认证复用 web_token 的交换机制——dsh 下载 URL 不带 token，靠会话 cookie，
//! 而 process token 在 dsh 进程存活期内可反复交换 cookie。
//!
//! 本模块无自有状态：任务真身在 manager 的表里，进度/完成/失败一律经
//! `manager::update_progress` / `manager::on_task_finished` 回写。

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::manager;

/// 进度上报节流间隔：列表 UI 60fps 无意义，150ms 足够顺滑。
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);

/// 解析 URL 的 authority（host:port；缺省端口按 scheme 补默认值）。
pub(crate) fn authority_of(url: &tauri::Url) -> String {
    let host = url.host_str().unwrap_or("");
    let port = url.port_or_known_default().unwrap_or(match url.scheme() {
        "https" => 443,
        _ => 80,
    });
    format!("{host}:{port}")
}

/// 为下载 URL 取认证 Cookie 头。仅对壳正在对接的 dsh 实例（本机端口或已导航
/// 的远程地址）且 state 里有 process token 时交换；其余源（外部 http / 老版
/// 无鉴权 dsh）返回 None。
fn auth_cookie_header(app: &AppHandle, url: &tauri::Url) -> Option<String> {
    let (token, loading_authority) = {
        let state = app.state::<crate::DshState>();
        let token = state.web_token.lock().unwrap().clone();
        let loading = state
            .loading_url
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|u| tauri::Url::parse(u).ok())
            .map(|u| authority_of(&u));
        (token, loading)
    };
    if token.is_empty() {
        return None;
    }
    let authority = authority_of(url);
    // #86：本地实例判定交给台账（覆盖所有已 spawn 实例端口 + web legacy 端口）
    let matches_local = crate::runtime::instances::is_local_instance_authority(&authority);
    let matches_remote = loading_authority.as_deref() == Some(authority.as_str());
    if !matches_local && !matches_remote {
        return None; // 与壳对接实例无关的外部源，不带凭据
    }
    let (name, value) = crate::network::web_token::exchange_token_for_cookie(&authority, &token)?;
    Some(format!("{name}={value}"))
}

/// 执行一次 URL 任务的完整传输。进入本函数前任务已被 manager 置为
/// Downloading；本函数只做 IO 并回写进度与终态，不做调度。
pub(crate) async fn run_url_transfer(app: AppHandle, task_id: u64, url: String, resume_from: u64, etag: Option<String>) {
    let fail = |msg: String| async { manager::on_task_finished(&app, task_id, Err(msg)) };
    let url = match tauri::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => return fail(format!("URL 无效：{e}")).await,
    };

    // 认证 cookie（交换是阻塞裸 HTTP，放 blocking 线程）
    let cookie = {
        let app = app.clone();
        let url = url.clone();
        match tauri::async_runtime::spawn_blocking(move || auth_cookie_header(&app, &url)).await {
            Ok(c) => c,
            Err(e) => return fail(format!("认证准备失败：{e}")).await,
        }
    };

    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(e) => return fail(format!("HTTP 客户端构建失败：{e}")).await,
    };

    // 请求构造器（两次尝试：带 Range 续传 → 416 时丢弃续传全量重下）
    let build_request = |client: &reqwest::Client, url: &tauri::Url, cookie: &Option<String>, range_from: u64, etag: &Option<String>| {
        let mut request = client.get(url.clone());
        if let Some(c) = cookie.as_deref() {
            request = request.header("Cookie", c);
        }
        if range_from > 0 {
            request = request.header("Range", format!("bytes={range_from}-"));
            if let Some(etag) = etag.as_deref() {
                request = request.header("If-Range", etag);
            }
        }
        request
    };

    let mut response = match build_request(&client, &url, &cookie, resume_from, &etag).send().await {
        Ok(r) => r,
        Err(e) => return fail(format!("连接失败：{e}")).await,
    };
    // 416：已收字节越界（源变小/损坏的 .part）——丢弃续传状态全量重下，
    // 避免「恢复→416→失败→再恢复」死循环
    let mut resume_from = resume_from;
    if response.status().as_u16() == 416 && resume_from > 0 {
        log::warn!("[downloads] #{task_id} 续传越界（416），改为全量重下");
        resume_from = 0;
        response = match build_request(&client, &url, &cookie, 0, &None).send().await {
            Ok(r) => r,
            Err(e) => return fail(format!("连接失败：{e}")).await,
        };
    }
    let status = response.status();
    if !status.is_success() {
        return fail(format!("服务器返回 {status}")).await;
    }

    // 206 = 续传成立；200 = 服务器不支持 Range（或 If-Range 失配）：全量重下
    let resumed = resume_from > 0 && status.as_u16() == 206;
    let start_at = if resumed { resume_from } else { 0 };

    // Content-Range 的 total（bytes x-y/N 的 N）优先；否则 200 用 Content-Length、
    // 206 用 start_at + Content-Length（后者是剩余量）
    let content_range_total = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|v| v.parse::<u64>().ok());
    let content_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let total = content_range_total.or(match (resumed, content_length) {
        (true, Some(remaining)) => Some(start_at + remaining),
        (true, None) => None,
        (false, len) => len,
    });
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string());

    // .part 打开：续传 append；全量重下/首下 truncate
    let part = manager::part_path_of(&app, task_id);
    let part = match part {
        Some(p) => p,
        None => return fail("任务已不存在".into()).await,
    };
    if let Some(dir) = part.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use tokio::io::AsyncWriteExt;
    // 续传前把 .part 对齐到 start_at：pause 的 abort 可能打在 write_all 中途，
    // .part 尾部可能多出半截数据；task.received 是已计入的最小一致点，以它为准截齐
    if resumed {
        match tokio::fs::File::options().write(true).open(&part).await {
            Ok(mut f) => {
                if let Err(e) = f.set_len(start_at).await {
                    return fail(format!("临时文件对齐失败：{e}")).await;
                }
            }
            Err(e) => return fail(format!("临时文件打开失败：{e}")).await,
        }
    }
    let mut writer = match tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .await
    {
        Ok(w) => w,
        Err(e) => return fail(format!("临时文件创建失败：{e}")).await,
    };

    manager::update_progress(&app, task_id, start_at, total, etag, resumed);

    let mut received = start_at;
    let mut last_emit = Instant::now() - PROGRESS_EMIT_INTERVAL;
    loop {
        // reqwest::Response::chunk 无需 stream trait：逐块拉取即天然背压
        match response.chunk().await {
            Ok(Some(bytes)) => {
                if let Err(e) = writer.write_all(&bytes).await {
                    return fail(format!("写盘失败：{e}")).await;
                }
                received += bytes.len() as u64;
                let now = Instant::now();
                if now.duration_since(last_emit) >= PROGRESS_EMIT_INTERVAL {
                    last_emit = now;
                    manager::update_progress(&app, task_id, received, total, None, resumed);
                }
            }
            Ok(None) => break,
            Err(e) => return fail(format!("传输中断：{e}")).await,
        }
    }
    if let Err(e) = writer.flush().await {
        return fail(format!("写盘失败：{e}")).await;
    }
    manager::update_progress(&app, task_id, received, total, None, resumed);
    // 完成收尾（rename .part → 目标、通知、持久化、调度补位）在 manager
    manager::on_task_finished(&app, task_id, Ok(()));
}
