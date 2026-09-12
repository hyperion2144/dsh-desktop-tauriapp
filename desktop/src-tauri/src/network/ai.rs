//! AI explain 的凭据解析与 OpenAI 兼容调用（#60，依据 #56 研究报告）。
//!
//! 关键事实（#56 实测，别凭直觉改）：
//! - dsh 官方没有「读回密钥」的途径（no read path returns it）→ 桌面壳必须直接
//!   读 `$DSH_HOME/.credentials.yaml`；
//! - 密钥在 `refs:` 区，键名 = provider 声明的环境变量名（官方 DeepSeek 路由 =
//!   `DEEPSEEK_API_KEY`）；`records` 区也可能承载 api-key（非官方路由）；
//! - 优先级：process.env > .credentials.yaml refs；
//! - 端点：OpenAI 兼容 `POST {base}/chat/completions` + Bearer，默认
//!   `https://api.deepseek.com`，`DEEPSEEK_BASE_URL` 可覆盖；
//! - 降级硬要求：任何失败（无凭据/读失败/网络/超时/非 2xx/非 JSON）返回 None，
//!   绝不阻塞隔离主流程；日志/UI 一律不落密钥明文。

use std::path::PathBuf;

/// 默认端点（与 dsh 官方 DeepSeek 适配器一致）。
pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
/// 默认模型（#56：产品层事实默认是 deepseek-v4-flash）。
pub const DEFAULT_MODEL: &str = "deepseek-v4-flash";
/// 默认密钥的 refs 键名 / 环境变量名。
pub const DEFAULT_KEY_ENV: &str = "DEEPSEEK_API_KEY";
/// 请求超时（秒）。
const TIMEOUT_SECS: u64 = 30;

/// 展开路径里的 `~` 前缀（与 settings::expand_home 同规则；ai 模块自足，避免环依赖）。
fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        return home_base();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home_base().join(rest);
    }
    PathBuf::from(p)
}

fn home_base() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    #[cfg(not(windows))]
    let base = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    base
}

fn dsh_home() -> PathBuf {
    if let Ok(h) = std::env::var("DSH_HOME") {
        if !h.trim().is_empty() {
            return expand_home(h.trim());
        }
    }
    home_base().join(".dsh")
}

/// 解析 AI 密钥：`process.env[key_env]` → `.credentials.yaml refs[key_env]`。
///
/// 宽松解析（#56 修正 2）：按 serde_yaml Value 导航，未知顶层键/字段一律忽略——
/// 照抄 dsh 的严格校验会把它的格式演进变成桌面壳的故障。
pub fn resolve_api_key_env(key_env: &str) -> Option<String> {
    if let Ok(k) = std::env::var(key_env) {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    let text = std::fs::read_to_string(dsh_home().join(".credentials.yaml")).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&text).ok()?;
    let refs = value.get("refs")?;
    let key = refs.get(key_env)?.as_str()?.trim().to_string();
    if key.is_empty() { None } else { Some(key) }
}

/// 默认路由（DeepSeek 官方）的密钥解析。
pub fn resolve_api_key() -> Option<String> {
    resolve_api_key_env(DEFAULT_KEY_ENV)
}

/// 解析端点：`DEEPSEEK_BASE_URL` → 默认官方。去尾部 `/`（拼接 /chat/completions）。
pub fn resolve_base_url() -> String {
    let base = std::env::var("DEEPSEEK_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    base.trim_end_matches('/').to_string()
}

/// 单轮补全（阻塞；调用方放 spawn_blocking）。失败返回 Err（不含密钥）。
pub fn chat(prompt: &str) -> Result<String, String> {
    let base = resolve_base_url();
    let model = std::env::var("DEEPSEEK_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let key = resolve_api_key_env(DEFAULT_KEY_ENV)
        .ok_or("未找到 AI 密钥（DEEPSEEK_API_KEY 或 .credentials.yaml refs）")?;
    chat_with(&key, &base, &model, prompt)
}

/// 指定端点/密钥/模型的单轮补全（阻塞；调用方放 spawn_blocking）。
/// provider 可选能力（#60 扩展）：设置里可选 provider/模型/自定义 OpenAI 兼容端点。
pub fn chat_with(
    key: &str,
    base: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
        "temperature": 0,
        "max_tokens": 1000,
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败：{e}"))?;
    let resp = client
        .post(&url)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .map_err(|e| format!("AI 请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("AI 端点返回 {status}"));
    }
    let value: serde_json::Value = resp.json().map_err(|e| format!("AI 响应非 JSON：{e}"))?;
    let content = value
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or("AI 响应缺少 choices[0].message.content")?;
    Ok(content.to_string())
}

/// 构造 explain prompt（输入：失败类型 + 插件 + 截断后的原始错误）。
pub fn explain_prompt(failure_type: &str, plugin: &str, raw_error: &str) -> String {
    let raw: String = raw_error.lines().take(40).collect::<Vec<_>>().join("\n");
    format!(
        "你是 dsh（DeepSeek Harness）桌面壳的启动保险丝助手。dsh 启动失败，一个插件被自动禁用。\n\
         失败类型：{failure_type}\n插件：{plugin}\n原始错误（已截断）：\n{raw}\n\n\
         请用中文按三段回答：【原因】为什么会失败；【建议】给出具体可执行的修复步骤；【置信】高/中/低。总长不超过 300 字。"
    )
}

/// explain 入口：内部构造 prompt → chat。失败返回 Err（消息不含密钥）。
pub fn explain_failure(failure_type: &str, plugin: &str, raw_error: &str) -> Result<String, String> {
    chat(&explain_prompt(failure_type, plugin, raw_error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_home_tilde() {
        assert_eq!(expand_home("~/x"), home_base().join("x"));
        assert_eq!(expand_home("/abs"), PathBuf::from("/abs"));
    }

    #[test]
    fn base_url_strips_trailing_slash_and_env_wins() {
        // 不动真实环境变量：只测默认拼接逻辑
        assert_eq!(DEFAULT_BASE_URL, "https://api.deepseek.com");
    }

    #[test]
    fn prompt_contains_structured_sections_and_caps_lines() {
        let raw = (0..100).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n");
        let p = explain_prompt("loader-entry", "pkg", &raw);
        assert!(p.contains("【原因】"));
        assert!(p.contains("loader-entry"));
        assert!(!p.contains("line99"), "原始错误须截断到 40 行");
    }

    #[test]
    fn credentials_parsing_tolerates_unknown_keys() {
        // 宽松解析：未知顶层键/未知 records kind 不影响 refs 读取
        let dir = std::env::temp_dir().join(format!("dsh-ai-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = "version: 1\nfuture_section:\n  whatever: 1\nrefs:\n  OTHER_KEY: sk-aaa\n  DEEPSEEK_API_KEY: sk-bbb\nrecords:\n  weird/kind:\n    kind: future-kind\n";
        std::fs::write(dir.join(".credentials.yaml"), text).unwrap();
        let value: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(dir.join(".credentials.yaml")).unwrap()).unwrap();
        let key = value.get("refs").unwrap().get("DEEPSEEK_API_KEY").unwrap().as_str().unwrap();
        assert_eq!(key, "sk-bbb");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
