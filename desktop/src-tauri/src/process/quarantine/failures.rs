//! 启动失败检测（#57，正则口径全部对齐 #54 实测报告 §7）。
//!
//! 硬约束（不要凭直觉改）：
//! - `\w`/`\b`/`.` 在 JS(ASCII) 与 Rust(Unicode) 语义不同 → 字符类必须 ASCII 显式化；
//! - 第 2 类（did not activate）的条目名必须兼容 `file://` 路径式条目——
//!   dsh-safe 原 `NAME_CLASS` 不含 `:`，对路径式条目全漏（本仓库插件正是路径式注入）；
//! - 第 1 类（plugin(s) failed to load）无法实验复现（#54 判「仅源码推断」），
//!   保留正则但不为其构造测试；
//! - `patch: entry "x" not found` 是 logger 阈值过滤后的不可见 warn，禁止当失败；
//! - 环境类失败（端口占用等 errno）不是插件不兼容，只标记、不隔离。

use std::sync::LazyLock;
use regex::Regex;

/// ASCII 显式字符类（对齐 JS `\w`，并扩展 `:` 以兼容 `file://` 路径式条目名）。
const NAME_CLASS: &str = r"[A-Za-z0-9_@][A-Za-z0-9_@./:\-]*";
/// ASCII 显式字符类（loader entry id，可含 `:`，如 cordis:include）。
const ID_CLASS: &str = r"[A-Za-z0-9_:\-]+";

static RE_LOAD_LIST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"plugin\(s\) failed to load:\s*([^;\n]+);").unwrap());
static RE_LOADER_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"failed to (?:apply|import|dispose|rollback) loader entry ({ID_CLASS}) \(([^)]+)\)"
    ))
    .unwrap()
});
static RE_ACTIVATE_SUMMARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b\d+ entr(?:y|ies) did not activate\b").unwrap());
/// 第 2 类后续行：`名: 详情`。名称类显式包含 `:`（file:// 修复）且用**惰性量词**：
/// 贪婪版会把 `file:///x.js: pending (waiting for service: required)` 里的
/// 第二个 `: `（service: 后）也吞进捕获；惰性版停在首个 `冒号+空格` 边界，
/// 恰好等于完整路径名。栈帧行（缩进 + `at `）从行首起自然不匹配。
static RE_NAME_LINE_ANCHORED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^\s*({NAME_CLASS}?):\s")).unwrap());
static RE_STACK_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^\s*at \S+#({ID_CLASS})")).unwrap());
static RE_DUP_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"duplicate loader entry id: ({ID_CLASS})")).unwrap());
static RE_PATCH_PARSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"failed to parse overlay|must be a top-level YAML array|YAMLException").unwrap()
});
/// 环境类失败（dsh-safe 0.16 新增 ENV_ERRNO 的 ASCII 等价展开，语义与 JS 对齐）。
static RE_ENV_ERRNO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|[^0-9A-Za-z_])(?:EADDRINUSE|EADDRNOTAVAIL|EACCES|EPERM|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EMFILE|ENFILE)(?:[^0-9A-Za-z_]|$)",
    )
    .unwrap()
});

/// 失败类别（字符串标签与 UI/台账约定一致）。
pub mod kind {
    pub const LOAD_LIST: &str = "load-list";
    pub const ACTIVATION: &str = "activation";
    pub const LOADER_ENTRY: &str = "loader-entry";
    pub const STACK_ID: &str = "stack-id";
    pub const DUPLICATE_ID: &str = "duplicate-id";
    pub const PATCH_PARSE: &str = "patch-parse";
}

/// 一条检测到的失败。
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    /// 类别标签（kind::*）。
    pub kind: &'static str,
    /// loader entry id（第 1/2 类可能只有 name）。
    pub entry_id: Option<String>,
    /// 包名 / 条目名。
    pub name: Option<String>,
    /// 原始错误行（截断前）。
    pub line: String,
}

/// 检测结果：可隔离失败 + 环境标记 + patch 解析失败标记。
#[derive(Debug, Default, PartialEq)]
pub struct Detection {
    pub failures: Vec<Failure>,
    pub environmental: bool,
    pub patch_parse: bool,
}

/// 截断一行做摘要（台账 reason 字段）。
pub fn summarize_line(line: &str) -> String {
    let t = line.trim();
    if t.chars().count() <= 240 {
        t.to_string()
    } else {
        let cut: String = t.chars().take(240).collect();
        format!("{cut}…")
    }
}

/// 从完整 stderr 检测全部失败。
pub fn detect(stderr: &str) -> Detection {
    let mut det = Detection::default();
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut activation_scan = 0usize;
    for line in stderr.lines() {
        // 环境类失败标记（不隔离，仅供上游给出可读原因）
        if RE_ENV_ERRNO.is_match(line) {
            det.environmental = true;
        }
        // 第 6 类：patch 文件解析失败（发生在 boot 之前，5 类正则全不匹配）
        if !det.patch_parse && RE_PATCH_PARSE.is_match(line) {
            det.patch_parse = true;
            det.failures.push(Failure {
                kind: kind::PATCH_PARSE,
                entry_id: None,
                name: None,
                line: line.to_string(),
            });
        }
        // 第 3 类：loader entry 处理失败（entryId + 包名）。
        // 一行里可能有两段匹配（外层 apply include + 内层 import 插件），用 captures_iter 全取。
        for c in RE_LOADER_ENTRY.captures_iter(line) {
            let entry_id = c[1].to_string();
            let name = c[2].to_string();
            let key = (kind::LOADER_ENTRY.to_string(), entry_id.clone());
            if !seen.contains(&key) {
                seen.push(key);
                det.failures.push(Failure {
                    kind: kind::LOADER_ENTRY,
                    entry_id: Some(entry_id),
                    name: Some(name),
                    line: line.to_string(),
                });
            }
        }
        // 第 5 类：重复挂载（同一 id 已由第 3 类捕获时跳过）
        if let Some(c) = RE_DUP_ID.captures(line) {
            let entry_id = c[1].to_string();
            let dup_by_entry = det.failures.iter().any(|f| {
                f.kind == kind::LOADER_ENTRY && f.entry_id.as_deref() == Some(entry_id.as_str())
            });
            let key = (kind::DUPLICATE_ID.to_string(), entry_id.clone());
            if !dup_by_entry && !seen.contains(&key) {
                seen.push(key);
                det.failures.push(Failure {
                    kind: kind::DUPLICATE_ID,
                    entry_id: Some(entry_id),
                    name: None,
                    line: line.to_string(),
                });
            }
        }
        // 第 2 类：摘要行后的 `名: 详情` 行（兼容 file:// 路径式条目名）
        if activation_scan > 0 {
            activation_scan -= 1;
            if !RE_ACTIVATE_SUMMARY.is_match(line) {
                if let Some(c) = RE_NAME_LINE_ANCHORED.captures(line) {
                    let name = c[1].to_string();
                    let key = (kind::ACTIVATION.to_string(), name.clone());
                    if !seen.contains(&key) {
                        seen.push(key);
                        det.failures.push(Failure {
                            kind: kind::ACTIVATION,
                            entry_id: None,
                            name: Some(name),
                            line: line.to_string(),
                        });
                    }
                }
            }
        }
        if RE_ACTIVATE_SUMMARY.is_match(line) {
            activation_scan = 24;
        }
        // 第 4 类：外层栈 `at 路径#entryId`
        if let Some(c) = RE_STACK_ID.captures(line) {
            let entry_id = c[1].to_string();
            let key = (kind::STACK_ID.to_string(), entry_id.clone());
            if !seen.contains(&key) {
                seen.push(key);
                det.failures.push(Failure {
                    kind: kind::STACK_ID,
                    entry_id: Some(entry_id),
                    name: None,
                    line: line.to_string(),
                });
            }
        }
        // 第 1 类：加载失败名单（无法实验复现，保留正则；同一批名去重）
        if let Some(c) = RE_LOAD_LIST.captures(line) {
            for raw in c[1].split(',') {
                let name = raw.trim().trim_start_matches('@').to_string();
                if name.is_empty() {
                    continue;
                }
                let key = (kind::LOAD_LIST.to_string(), name.clone());
                if !seen.contains(&key) {
                    seen.push(key);
                    det.failures.push(Failure {
                        kind: kind::LOAD_LIST,
                        entry_id: None,
                        name: Some(name),
                        line: line.to_string(),
                    });
                }
            }
        }
    }
    det
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #54 实测真实报文（/tmp/wy-exp/E1-insert-ghost.err 节选）。
    const REAL_IMPORT: &str = "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry wy-ghost-plugin2 (file:///tmp/wy-exp/definitely-not-here.js): Cannot find module '/tmp/wy-exp/definitely-not-here.js' imported from /Users/mutou/.dsh/profiles/wy-research/\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/wy-exp/definitely-not-here.js'\n    at finalizeResolution (node:internal/modules/esm/resolve:272:11)";

    /// #54 实测真实报文（/tmp/wy-exp/E16-pending-final.err 节选）。
    const REAL_PENDING: &str = "Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate\nfile:///tmp/wy-exp/pending2.js: pending (waiting for service: required)\n    at assertEntriesActivated (file:///…/dsh-app-boot/lib/index.js:1492:9)\n    at boot (file:///…/dsh-app-boot/lib/index.js:1537:9)";

    #[test]
    fn loader_entry_extracts_id_and_file_url_name() {
        let det = detect(REAL_IMPORT);
        let hits: Vec<_> = det
            .failures
            .iter()
            .filter(|f| f.kind == kind::LOADER_ENTRY)
            .collect();
        assert!(
            hits.iter().any(|f| f.entry_id.as_deref() == Some("wy-ghost-plugin2")
                && f.name.as_deref() == Some("file:///tmp/wy-exp/definitely-not-here.js")),
            "必须提取 file:// 路径式条目名：{hits:?}"
        );
        assert!(hits.iter().any(|f| f.entry_id.as_deref() == Some("include")));
    }

    #[test]
    fn activation_matches_file_url_name_the_fix() {
        // dsh-safe 原 NAME_CLASS 不含 ':' 对该行完全失配（#54 覆盖矩阵：5 类全漏）——
        // 本实现必须命中。
        let det = detect(REAL_PENDING);
        let hits: Vec<_> = det
            .failures
            .iter()
            .filter(|f| f.kind == kind::ACTIVATION)
            .collect();
        assert_eq!(hits.len(), 1, "{:?}", det.failures);
        assert_eq!(hits[0].name.as_deref(), Some("file:///tmp/wy-exp/pending2.js"));
    }

    #[test]
    fn stack_lines_do_not_pollute_activation_scan() {
        let det = detect(REAL_PENDING);
        assert!(
            !det.failures.iter().any(|f| f.kind == kind::STACK_ID),
            "assertEntriesActivated 栈帧不是 stack-id 失败（无 #entryId 形态）：{:?}",
            det.failures
        );
    }

    #[test]
    fn stack_id_extracts_entry_from_hash_frame() {
        let det = detect("          at file:///Users/mutou/.dsh/profiles/wy-research/#wy-boom");
        assert_eq!(det.failures.len(), 1);
        assert_eq!(det.failures[0].kind, kind::STACK_ID);
        assert_eq!(det.failures[0].entry_id.as_deref(), Some("wy-boom"));
    }

    #[test]
    fn duplicate_id_detected() {
        let det = detect("[cause]: Error: failed to apply loader entry include (cordis:include): duplicate loader entry id: llm\nTypeError: duplicate loader entry id: llm");
        let dups: Vec<_> = det
            .failures
            .iter()
            .filter(|f| f.kind == kind::DUPLICATE_ID)
            .collect();
        assert_eq!(dups.len(), 1, "重复报文只记一次：{:?}", det.failures);
        assert_eq!(dups[0].entry_id.as_deref(), Some("llm"));
    }

    #[test]
    fn patch_parse_failure_is_class_six() {
        let det = detect("Error: dsh: composeProfile: failed to parse overlay …/cordis.patch.yml: YAMLException: bad indentation of a mapping entry (5:3)");
        assert!(det.patch_parse);
        assert_eq!(det.failures[0].kind, kind::PATCH_PARSE);
    }

    #[test]
    fn environmental_errno_flagged_not_quarantined() {
        let det = detect("Error: listen EADDRINUSE: address already in use 127.0.0.1:3080");
        assert!(det.environmental);
        assert!(det.failures.is_empty());
    }

    #[test]
    fn cjk_name_not_matched_ascii_parity() {
        // JS `\w` 是 ASCII：`插件名: pending` 在 dsh-safe 下也失配——对齐（宁可漏报
        // 走人工路径，不误报中文文案行）
        let det = detect("1 entry did not activate\n插件名: pending (waiting)\n");
        assert!(det.failures.iter().all(|f| f.kind != kind::ACTIVATION));
    }

    #[test]
    fn load_list_pattern_compiles_and_extracts() {
        // 第 1 类无法用真实启动复现（#54 判无法验证）：仅验证正则与解析行为
        let det = detect("plugin(s) failed to load: @a/x, @b/y;");
        let loads: Vec<_> = det
            .failures
            .iter()
            .filter(|f| f.kind == kind::LOAD_LIST)
            .collect();
        assert_eq!(loads.len(), 2);
        assert_eq!(loads[0].name.as_deref(), Some("a/x"));
    }

    #[test]
    fn summarize_line_truncates() {
        let long = "x".repeat(400);
        assert_eq!(summarize_line(&long).chars().count(), 241);
        assert_eq!(summarize_line("  a b  "), "a b");
    }
}
