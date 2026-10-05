//! 桌面档快捷键偏好文件（#187）。
//!
//! dsh 的 desktop 键盘档把「用户改过哪些绑定」交给宿主落盘：它自己只消费
//! `window.dshDesktop.shortcuts` 返回的文档，从不碰文件（`ShortcutPersistence` 在
//! desktop 档下根本不参与，适配器由宿主提供）。
//!
//! 壳这边按 dsh 的 `ShortcutDocument` 形状原样存：
//! `{ "schemaVersion": 1|2, "profiles": { "desktop:macos": { "<commandId>": binding } } }`，
//! 落在 `$DSH_HOME/desktop-keybindings.json`。**语义解析/序列化都在页面侧适配器**
//! （src/client/platform-keyboard.ts）：Rust 只做「读原始文本 / 原子写回」，
//! 不解析 JSON——未知字段与未来 schemaVersion 都能原样保留、安全回写。

use std::path::{Path, PathBuf};

/// 单文件大小上限（防误传大文件写坏磁盘）：256 KiB 足够几百条绑定。
const MAX_KEYBINDINGS_BYTES: usize = 256 * 1024;

/// keybindings 文件路径：随 `DSH_HOME` 走，与 [`crate::settings::dsh_home`] 同源。
pub(crate) fn keybindings_path() -> PathBuf {
    crate::settings::dsh_home().join("desktop-keybindings.json")
}

/// 读取原始文本：文件不存在 → `None`（页面侧按「用默认绑定」处理）。
pub(crate) fn read_keybindings() -> Result<Option<String>, String> {
    read_from(&keybindings_path())
}

/// 写回原始文本（原子写：先 temp 后 rename，与 [`crate::settings::save_desktop_settings`] 同范式）。
pub(crate) fn write_keybindings(raw: &str) -> Result<(), String> {
    write_to(&keybindings_path(), raw)
}

fn read_from(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取快捷键文件失败：{e}")),
    }
}

fn write_to(path: &Path, raw: &str) -> Result<(), String> {
    if raw.len() > MAX_KEYBINDINGS_BYTES {
        return Err(format!(
            "快捷键文件过大（{} 字节，上限 {MAX_KEYBINDINGS_BYTES}）",
            raw.len()
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建快捷键目录失败：{e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("写快捷键文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换快捷键文件失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-keybindings-{}-{tag}.json",
            std::process::id()
        ))
    }

    #[test]
    fn 路径落在_dsh_home_下且文件名固定() {
        let path = keybindings_path();
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("desktop-keybindings.json")
        );
        assert_eq!(path.parent(), Some(crate::settings::dsh_home().as_path()));
    }

    #[test]
    fn 读写往返且文件不存在回_none() {
        let path = temp_path("roundtrip");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_from(&path).unwrap(), None);

        let raw = "{\n  \"schemaVersion\": 2,\n  \"profiles\": {\n    \"desktop:macos\": {\n      \"inspector.toggle\": { \"code\": \"Period\", \"modifiers\": [\"meta\", \"shift\"] }\n    }\n  }\n}\n";
        write_to(&path, raw).unwrap();
        assert_eq!(read_from(&path).unwrap().as_deref(), Some(raw));
        // 原子写不留 temp 残骸
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn 超大内容被拒且不落盘() {
        let path = temp_path("oversize");
        let _ = std::fs::remove_file(&path);
        let huge = "x".repeat(MAX_KEYBINDINGS_BYTES + 1);
        assert!(write_to(&path, &huge).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn 目录不存在时会自建() {
        let dir = std::env::temp_dir().join(format!("dsh-keybindings-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("desktop-keybindings.json");
        write_to(&path, "{}\n").unwrap();
        assert_eq!(read_from(&path).unwrap().as_deref(), Some("{}\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
