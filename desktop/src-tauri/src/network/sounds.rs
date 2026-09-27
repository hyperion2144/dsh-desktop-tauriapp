//! 通知自定义音效（#142 / T5 / ADR-0001）：文件入库校验 + rodio 应用侧播放。
//!
//! 声音三分语义里 `custom:<名>` 的应用侧半区：文件入库（扩展名+魔数+大小校验，
//! 复制进 `$DSH_HOME/sounds/`）与播放（rodio，10s 截断）。`default`/`none` 不经过本模块。
//! `default` 档的试听走系统音（afplay），不经过本模块的文件解析。

use crate::settings::dsh_home;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 单文件大小上限（T5 决议：5MB）。
pub const MAX_SOUND_BYTES: u64 = 5 * 1024 * 1024;
/// 单次播放时长上限（T5 决议：10s 截断，防长音频当通知音）。
pub const MAX_PLAY_SECONDS: u64 = 10;

/// 白名单：扩展名 → 允许的魔数前缀（T5：wav/mp3/ogg；aac/m4a 不进白名单）。
const ALLOWED: [(&str, &[&[u8]]); 3] = [
    ("wav", &[b"RIFF"]),
    ("mp3", &[b"ID3", b"\xFF\xFB", b"\xFF\xF3", b"\xFF\xFA", b"\xFF\xF2"]),
    ("ogg", &[b"OggS"]),
];

/// 音效存放目录：`$DSH_HOME/sounds/`。
pub fn sounds_dir() -> PathBuf {
    dsh_home().join("sounds")
}

/// 文件名白名单校验：只允许字母/数字/点/下划线/连字符/空格与中日韩字符，
/// 拒绝路径分隔符与 `..`（防穿越）。返回原名。
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 {
        return Err("音效文件名长度不合法".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("音效文件名不允许包含路径分隔符".into());
    }
    if !name.chars().all(|c| {
        c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | ' ' | '(' | ')' | '[' | ']')
    }) {
        // is_alphanumeric 覆盖中日韩与全角数字；其余标点拒绝
        return Err("音效文件名包含不允许的字符".into());
    }
    Ok(())
}

/// 扩展名 + 魔数白名单校验（双保险的前半由 picker accept 承担）。
fn validate_format(path: &std::path::Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let allowed_magic = ALLOWED
        .iter()
        .find(|(e, _)| *e == ext)
        .ok_or_else(|| format!("不支持的音效格式 .{ext}（白名单：wav / mp3 / ogg）"))?
        .1;
    let mut head = [0u8; 4];
    let mut f = std::fs::File::open(path).map_err(|e| format!("无法读取文件：{e}"))?;
    let n = std::io::Read::read(&mut f, &mut head).map_err(|e| format!("无法读取文件头：{e}"))?;
    if n >= 3 && allowed_magic.iter().any(|m| head.starts_with(m)) {
        Ok(())
    } else {
        Err("文件内容与扩展名不符（魔数校验失败）".into())
    }
}

/// 入库：校验扩展名/魔数/大小 → 复制进 sounds/ → 返回保存的文件名（原名保留，重名覆盖）。
pub fn import_file(src: &str) -> Result<String, String> {
    let src_path = PathBuf::from(src);
    let name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法取得文件名".to_string())?;
    validate_name(name)?;
    validate_format(&src_path)?;
    let meta = std::fs::metadata(&src_path).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if !meta.is_file() {
        return Err("不是 regular 文件".into());
    }
    if meta.len() > MAX_SOUND_BYTES {
        return Err(format!(
            "文件 {} 超过上限 {}MB",
            name,
            MAX_SOUND_BYTES / 1024 / 1024
        ));
    }
    let dir = sounds_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 sounds 目录失败：{e}"))?;
    let dest = dir.join(name);
    std::fs::copy(&src_path, &dest).map_err(|e| format!("复制音效文件失败：{e}"))?;
    log::info!("[sounds] 音效入库：{name}（{} bytes）", meta.len());
    Ok(name.to_string())
}

/// 解析 sounds/ 下的音效路径；名字不合法或文件不存在返回 None。
pub fn resolve(name: &str) -> Option<PathBuf> {
    validate_name(name).ok()?;
    let p = sounds_dir().join(name);
    p.is_file().then_some(p)
}

/// 播放（阻塞，最长 10s）；mixer drop 即停。仅在工作线程调用。
fn play_blocking(name: &str) -> Result<(), String> {
    let path = resolve(name).ok_or_else(|| format!("音效不存在：{name}"))?;
    let sink = rodio::DeviceSinkBuilder::open_default_sink()
        .map_err(|e| format!("无法打开音频输出设备：{e}"))?;
    let file = std::fs::File::open(&path).map_err(|e| format!("无法打开音效文件：{e}"))?;
    rodio::play(sink.mixer(), std::io::BufReader::new(file))
        .map_err(|e| format!("音效解码/播放失败：{e}"))?;
    let start = Instant::now();
    let cap = Duration::from_secs(MAX_PLAY_SECONDS);
    while start.elapsed() < cap {
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(()) // drop(sink) 停止播放（10s 截断或自然结束后超时兜底）
}

/// 试听：后台线程播放，立即返回；错误落日志（前端凭此异步刷新状态）。
pub fn preview(name: &str) {
    let name = name.to_string();
    std::thread::spawn(move || {
        if let Err(e) = play_blocking(&name) {
            log::warn!("[sounds] 试听失败（{name}）：{e}");
        }
    });
}

/// 通知触达时的自定义音播放（fire-and-forget，10s 截断；失败仅落日志）。
pub fn play_custom_async(name: &str) {
    let name = name.to_string();
    std::thread::spawn(move || {
        if let Err(e) = play_blocking(&name) {
            log::warn!("[sounds] 自定义音播放失败（{name}）：{e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation_rejects_traversal() {
        assert!(validate_name("alert.wav").is_ok());
        assert!(validate_name("提示音-1.mp3").is_ok());
        assert!(validate_name("../evil.wav").is_err());
        assert!(validate_name("a/b.wav").is_err());
        assert!(validate_name("a\\b.wav").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn format_validation_by_magic() {
        let dir = std::env::temp_dir();
        // 假 wav：扩展名对 + RIFF 头 → 通过
        let wav = dir.join("t-probe-ok.wav");
        std::fs::write(&wav, b"RIFFxxxxWAVEfmt").unwrap();
        assert!(validate_format(&wav).is_ok());
        // 假 mp3：扩展名 mp3 内容文本 → 拒绝
        let mp3 = dir.join("t-probe-bad.mp3");
        std::fs::write(&mp3, b"hello world not audio").unwrap();
        assert!(validate_format(&mp3).is_err());
        // 未知扩展名 → 拒绝
        let m4a = dir.join("t-probe.m4a");
        std::fs::write(&m4a, b"RIFFxxxx").unwrap();
        assert!(validate_format(&m4a).is_err());
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_file(&mp3);
        let _ = std::fs::remove_file(&m4a);
    }
}

/// sounds/ 目录下已入库的音效文件名列表（设置 tab 下拉用；按名字排序）。
pub fn list_sounds() -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(sounds_dir())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                .filter(|n| {
                    ALLOWED.iter().any(|(ext, _)| {
                        n.to_ascii_lowercase().ends_with(&format!(".{ext}"))
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// 系统默认提示音试听（macOS：afplay 播 /System/Library/Sounds；纯放音，
/// 不涉及通知投递身份，与被否决的 osascript 通知兜底无关）。
pub fn play_system_default_async() {
    #[cfg(target_os = "macos")]
    std::thread::spawn(|| {
        for name in ["Ping.aiff", "Boop.aiff", "Tink.aiff"] {
            let p = format!("/System/Library/Sounds/{name}");
            if std::path::Path::new(&p).exists() {
                let ok = Command::new("afplay")
                    .arg(&p)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map(|mut c| {
                        let _ = c.wait();
                        true
                    })
                    .unwrap_or(false);
                if ok {
                    return;
                }
            }
        }
        log::warn!("[sounds] 系统默认音试听失败（未找到系统音文件）");
    });
    #[cfg(not(target_os = "macos"))]
    log::info!("[sounds] 当前平台暂无系统默认音试听实现");
}
