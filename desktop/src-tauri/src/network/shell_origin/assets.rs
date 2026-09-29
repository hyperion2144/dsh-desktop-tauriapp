//! 静态资产层：定位「当前生效的那个运行时」的前端产物、MIME 表、路径归一与穿越防护。
//!
//! 三种运行时来源在磁盘上同构（`<root>/node_modules/@deepseek-ai/dsh/lib/bin.js`
//! 与 `<root>/node_modules/@deepseek-ai/dsh-web-frontend/dist`），因此统一用
//! 「从 lib/bin 路径向上找 dist」一条规则覆盖：内置树、下载的运行时、外部全局 CLI 树。
//!
//! **本地优先是构造上安全的**：Vite 产物文件名带内容 hash——同名必同内容，所以
//! 「本地命中就给本地、没命中就转发上游」不会给出错误版本，版本错配自然退化为转发。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::AppHandle;

/// 前端产物在运行时树里的相对位置。
pub(crate) const DIST_REL: &str = "node_modules/@deepseek-ai/dsh-web-frontend/dist";

/// dsh 包 lib 入口在运行时树里的相对位置（三种来源同构）。
const LIB_REL: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";

/// 向上查找的层数上限（内置/下载/全局三种布局都在 3 层内命中）。
const WALK_LIMIT: usize = 8;

/// dist 解析缓存：`None` 内层 = 已解析但没找到（此时全量转发上游）。
static CACHE: Mutex<Option<Option<PathBuf>>> = Mutex::new(None);

/// 远程会话锁定的前端产物（构建闸门的结论）：远程页面的构建标识命中哪个本地运行时，
/// 就用哪个运行时的 dist——**不改动用户的「本地运行时选择」**（那属于本地模式）。
/// 由 [`super::reset`] 在每次导航前清空，避免跨会话串用。
static OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 当前生效运行时的 dist 目录；找不到返回 None（此时文档与资产都出不来，页面会明确报错）。
///
/// 顺序：① 远程闸门锁定的产物（[`set_dist_override`]）→ ② 设置里选定的下载运行时
/// → ③ 内置树（随包分发，也是 ② 的兜底）→ ④ 外部 CLI 树（外部模式或前两者不可用时的兜底）。
pub(crate) fn dist_dir(app: &AppHandle) -> Option<PathBuf> {
    // 热路径：每次请求都要问一次，因此把「向上找 dist」的结果缓存下来，
    // 只由 shell_origin::reset（每次启动/导航）失效。
    if let Some(cached) = CACHE.lock().unwrap().clone() {
        return cached;
    }
    let resolved = resolve_dist(app);
    *CACHE.lock().unwrap() = Some(resolved.clone());
    resolved
}

/// 失效缓存（运行时切换 / 重启 dsh / 远程闸门改产物后由 [`super::reset`] 调用）。
pub(crate) fn invalidate() {
    *CACHE.lock().unwrap() = None;
}

/// 锁定本次会话的前端产物（远程构建闸门用；`None` = 取消锁定）。
pub(crate) fn set_dist_override(dist: Option<PathBuf>) {
    *OVERRIDE.lock().unwrap() = dist;
    invalidate();
}

/// 本地**全部**可用的前端产物：`(版本标识, dist 目录)`。
///
/// 三种来源同构，故一律「从 lib/bin 向上找 dist」：已下载运行时 → 内置树 → 外部 CLI 树。
/// 远程构建闸门用它回答「远程这个构建，本机有没有」。
pub(crate) fn local_dists(app: &AppHandle) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for entry in crate::runtime::registry::list_installed(app) {
        let root = crate::runtime::registry::runtime_dir(app, &entry.version);
        if let Some(dist) = walk_up_for_dist(&root.join(LIB_REL)) {
            out.push((entry.version, dist));
        }
    }
    if let Some(lib) = crate::runtime::builtin::builtin_dsh_lib(app) {
        if let Some(dist) = walk_up_for_dist(&lib) {
            let label = crate::runtime::registry::builtin_version(app)
                .map(|v| format!("{v}（内置）"))
                .unwrap_or_else(|| "内置".to_string());
            out.push((label, dist));
        }
    }
    if let Some(bin) = crate::runtime::builtin::find_external_bin() {
        if let Some(dist) = walk_up_for_dist(&bin) {
            out.push(("外部 CLI".to_string(), dist));
        }
    }
    out
}

/// 前端**构建标识**：dist 里 `index.html` 引用的入口产物名（Vite 产物名即内容 hash，
/// 所以同名必同构建）。
pub(crate) fn build_id(dist: &Path) -> Option<String> {
    let html = std::fs::read_to_string(dist.join("index.html")).ok()?;
    entry_name(&html)
}

/// 从一份 index.html 文本里取入口脚本名（`assets/index-<hash>.js`）。
///
/// 只认 `<script type="module" ... src="...">`：dist 自己的入口脚本，Host 注入的行里
/// 没有 `assets/index-*.js` 这个形态（插件 combo 是 `/plugins/??…`）。
pub(crate) fn entry_name(html: &str) -> Option<String> {
    let mut rest = html;
    while let Some(at) = rest.find("<script") {
        let tag_end = rest[at..].find('>').map(|i| at + i)?;
        let tag = &rest[at..tag_end];
        if tag.contains("type=\"module\"") {
            if let Some(src) = attr(tag, "src") {
                if let Some(name) = src.rsplit('/').next() {
                    if name.starts_with("index-") {
                        return Some(name.to_string());
                    }
                }
            }
        }
        rest = &rest[tag_end + 1..];
    }
    None
}

/// 取一个 HTML 属性的值（只处理双引号形态，够用且不会误吞）。
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let at = tag.find(&needle)? + needle.len();
    let end = tag[at..].find('"')? + at;
    Some(&tag[at..end])
}

/// 向上查找 dist；结果被 [`dist_dir`] 缓存，因此这里可以放心走文件系统。
fn resolve_dist(app: &AppHandle) -> Option<PathBuf> {
    // 远程会话锁定的产物优先：它按「与远程构建一致」选出，与用户的本地选择无关。
    if let Some(dist) = OVERRIDE.lock().unwrap().clone() {
        if dist.is_dir() {
            return Some(dist);
        }
    }
    let mut starts: Vec<PathBuf> = Vec::new();
    let settings = crate::settings::load_desktop_settings();
    if let Some(version) = settings
        .dsh_runtime
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let lib = crate::runtime::registry::runtime_dir(app, version).join(LIB_REL);
        if lib.is_file() {
            starts.push(lib);
        }
    }
    if let Some(lib) = crate::runtime::builtin::builtin_dsh_lib(app) {
        starts.push(lib);
    }
    if let Some(bin) = crate::runtime::builtin::find_external_bin() {
        starts.push(bin);
    }
    starts.iter().find_map(|p| walk_up_for_dist(p))
}

/// 从 lib/bin 路径向上找 dist。符号链接（全局 `bin/dsh` → 包内 lib）先规范化。
fn walk_up_for_dist(start: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
    let mut cursor = real.parent();
    for _ in 0..WALK_LIMIT {
        let dir = cursor?;
        let candidate = dir.join(DIST_REL);
        if candidate.is_dir() {
            return Some(candidate);
        }
        cursor = dir.parent();
    }
    None
}

/// 扩展名 → Content-Type。与官方 `serveWebDocument` 的 MIME 表同构。
pub(crate) fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "map" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// `%XX` 解码（最小实现：非法序列原样保留，避免把畸形请求变成 500）。
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 请求路径 → dist 内的相对路径。
///
/// 拒绝（返回 None）：`..` 段、`.` 段、空段、含 `\\` 或 `:` 的段（Windows 分隔符与
/// 驱动器/ADS 形态）、以及解码后出现的 NUL。这样拼接结果不可能逃出 dist 目录。
pub(crate) fn relative_path(path: &str) -> Option<String> {
    let decoded = percent_decode(path);
    if decoded.contains('\0') {
        return None;
    }
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some("index.html".to_string());
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        if segment.contains('\\') || segment.contains(':') {
            return None;
        }
        segments.push(segment);
    }
    Some(segments.join("/"))
}

/// 读一个本地资产。命中返回 `(字节, Content-Type)`，未命中返回 None（调用方转上游）。
pub(crate) async fn read_asset(dist: &Path, relative: &str) -> Option<(Vec<u8>, &'static str)> {
    let full = dist.join(relative);
    let bytes = tokio::fs::read(&full).await.ok()?;
    Some((bytes, mime_for(&full)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_maps_root_to_index() {
        assert_eq!(relative_path("/").as_deref(), Some("index.html"));
        assert_eq!(relative_path("").as_deref(), Some("index.html"));
        assert_eq!(
            relative_path("/assets/index-abc.js").as_deref(),
            Some("assets/index-abc.js")
        );
    }

    #[test]
    fn relative_path_decodes_percent_escapes() {
        assert_eq!(
            relative_path("/assets/a%20b%2Fc.woff2").as_deref(),
            Some("assets/a b/c.woff2"),
            "%2F 解码后按段解析（此处仍是合法两级路径）"
        );
        assert_eq!(relative_path("/%E4%B8%AD.svg").as_deref(), Some("中.svg"));
    }

    #[test]
    fn relative_path_rejects_traversal_and_windows_forms() {
        for bad in [
            "/../secret",
            "/assets/../../etc/passwd",
            "/assets/..",
            "/./x",
            "/a//b",
            "/a%2F..%2Fb",
            "/C:/windows/system32",
            "/assets/a\\b.js",
        ] {
            assert_eq!(relative_path(bad), None, "{bad} 应被拒绝");
        }
        assert_eq!(relative_path("/a\0b"), None);
    }

    #[test]
    fn mime_table_covers_frontend_artifacts() {
        assert_eq!(mime_for(Path::new("index.html")), "text/html; charset=utf-8");
        assert_eq!(mime_for(Path::new("x.js")), "text/javascript; charset=utf-8");
        assert_eq!(mime_for(Path::new("x.css")), "text/css; charset=utf-8");
        assert_eq!(mime_for(Path::new("f.woff2")), "font/woff2");
        assert_eq!(mime_for(Path::new("m.webmanifest")), "application/json; charset=utf-8");
        assert_eq!(mime_for(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn walk_up_finds_dist_from_lib_path() {
        let root = std::env::temp_dir().join(format!("dsh-dist-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dist = root.join(DIST_REL);
        std::fs::create_dir_all(&dist).unwrap();
        let lib = root.join(LIB_REL);
        std::fs::create_dir_all(lib.parent().unwrap()).unwrap();
        std::fs::write(&lib, b"// stub").unwrap();

        // 返回路径是规范化后的（macOS 上 /var → /private/var），断言同步规范化。
        let expected = std::fs::canonicalize(&dist).unwrap();
        assert_eq!(walk_up_for_dist(&lib).as_deref(), Some(expected.as_path()));
        // 树里没有 dist 时返回 None（调用方转全量转发）
        std::fs::remove_dir_all(root.join(DIST_REL)).unwrap();
        assert_eq!(walk_up_for_dist(&lib), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_asset_returns_bytes_and_mime() {
        let root = std::env::temp_dir().join(format!("dsh-dist-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/a.js"), b"console.log(1)").unwrap();

        let hit = read_asset(&root, "assets/a.js").await.expect("应命中");
        assert_eq!(hit.0, b"console.log(1)");
        assert_eq!(hit.1, "text/javascript; charset=utf-8");
        assert!(read_asset(&root, "assets/missing.js").await.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn entry_name_reads_the_module_entry_only() {
        let hit = "<script type=\"module\" crossorigin src=\"./assets/index-Q6zc2uHV.js\"></script>";
        assert_eq!(entry_name(hit).as_deref(), Some("index-Q6zc2uHV.js"));
        // 非 module 脚本不认（Host 注入的行不是 module 形态）
        assert_eq!(entry_name("<script src=\"./assets/index-a.js\"></script>"), None);
        // module 但不是 index- 入口（vendor chunk）不认
        assert_eq!(
            entry_name("<script type=\"module\" src=\"./assets/vendor-1.js\"></script>"),
            None
        );
        assert_eq!(entry_name("<head></head>"), None);
    }
}
