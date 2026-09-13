//! cordis.patch.yml 行级读写（#57，依据 #54 研究报告）。
//!
//! 设计要点（全部来自 #54 实测结论，不要凭直觉改）：
//! - 行级扫描即可，不需要 YAML 库：dsh 对 patch 里 id 不存在的条目只 warn 不报错；
//! - 在条目旁追加托管区块安全（`- id: X` + `disabled: true` 覆盖语义）；
//! - 空模板 `[]` 必须先移除再追加，否则不是合法数组；
//! - 原文保留：除托管区块与空模板行外不改任何字节；
//! - 原子写：先写 `.tmp` 再 rename，避免与运行中实例的 `patchReload: "live"` 竞争。

use std::io::Write;
use std::path::Path;

/// 托管区块开始标记（自定义标识，不与 dsh-safe CLI 互操作）。
pub const MANAGED_BEGIN: &str = "# --- dsh-desktop-tauriapp managed (auto) ---";
/// 托管区块结束标记。
pub const MANAGED_END: &str = "# --- end dsh-desktop-tauriapp managed ---";

/// 一条 patch 行（loader entry 定义）。
#[derive(Debug, Clone, PartialEq)]
pub struct PatchRow {
    /// loader entry id（YAML 值去引号后）。
    pub id: String,
    /// `name:` 值（去引号；缺失为 None）。
    pub name: Option<String>,
    /// `disabled:` 值（缺失为 None）。
    pub disabled: Option<bool>,
    /// 该行在文件中的行号（0 起）。
    pub line_no: usize,
    /// 是否位于 `- insert:` 块内的子条目。
    pub in_insert: bool,
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// 判断 `- id:` 行是否位于某个 `- insert:` 块内（回扫：上方存在缩进更小的
/// `- insert:` 行，且两者之间没有缩进 ≤ insert 缩进的其它块级行）。
fn in_insert_block(lines: &[&str], row_idx: usize, row_indent: usize) -> bool {
    let mut i = row_idx;
    while i > 0 {
        i -= 1;
        let l = lines[i];
        let t = l.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let ind = indent_of(l);
        if ind < row_indent {
            return t.starts_with("- insert:") || t == "- insert";
        }
        // 同级或更深的块级行隔断了归属（例如另一个顶层条目）——继续向上找；
        // 但遇到比 row_indent 更小的非 insert 行说明已离开 insert 上下文。
        if ind < row_indent {
            return false;
        }
    }
    false
}

/// 行级扫描 cordis.patch.yml，提取 loader entry 行。
///
/// 规则（#54）：`- id:` 行定义条目；随后「首个更深缩进行」确立该条目的键缩进，
/// 同键缩进的 `name:` / `disabled:` 归属本条目，更深层（config 子树）一律跳过。
pub fn scan_patch_rows(text: &str) -> Vec<PatchRow> {
    let lines: Vec<&str> = text.lines().collect();
    let mut rows = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim_start();
        let ind = indent_of(line);
        let Some(rest) = t.strip_prefix("- id:") else {
            i += 1;
            continue;
        };
        let id = unquote(rest);
        if id.is_empty() {
            i += 1;
            continue;
        }
        // 收集本条目的 name / disabled（同键缩进），跳过 config 子树
        let mut name: Option<String> = None;
        let mut disabled: Option<bool> = None;
        let mut key_indent: Option<usize> = None;
        let mut j = i + 1;
        while j < lines.len() {
            let l2 = lines[j];
            let t2 = l2.trim();
            if t2.is_empty() || t2.starts_with('#') {
                j += 1;
                continue;
            }
            let ind2 = indent_of(l2);
            if ind2 <= ind {
                break; // 下一个兄弟条目 / 去缩进：本条目结束
            }
            let ki = *key_indent.get_or_insert(ind2);
            if ind2 == ki {
                if let Some(v) = t2.strip_prefix("name:") {
                    name = Some(unquote(v));
                } else if let Some(v) = t2.strip_prefix("disabled:") {
                    disabled = Some(unquote(v) == "true");
                }
                // config: 等其它键只确立键缩进，不下钻
            }
            j += 1;
        }
        let in_insert = in_insert_block(&lines, i, ind);
        rows.push(PatchRow { id, name, disabled, line_no: i, in_insert });
        i = j;
    }
    rows
}

/// 从文本中移除托管区块（含标记行），返回 (新文本, 移除的条目行数)。
pub fn remove_managed_block(text: &str) -> (String, usize) {
    let mut out: Vec<&str> = Vec::new();
    let mut in_block = false;
    let mut removed = 0usize;
    for line in text.lines() {
        if line.trim() == MANAGED_BEGIN {
            in_block = true;
            continue;
        }
        if in_block {
            if line.trim() == MANAGED_END {
                in_block = false;
            }
            continue;
        }
        out.push(line);
    }
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    let mut s = out.join("\n");
    if !out.is_empty() {
        s.push('\n');
    }
    (s, removed)
}

/// 生成托管区块文本（每条：`- id: X` + `disabled: true`）。
fn managed_block_text(ids: &[String]) -> String {
    let mut s = String::from(MANAGED_BEGIN);
    s.push('\n');
    for id in ids {
        s.push_str("- id: ");
        s.push_str(id);
        s.push_str("\n  disabled: true\n");
    }
    s.push_str(MANAGED_END);
    s
}

/// 当前托管区块中的 id 列表（按文件顺序）。
pub fn managed_ids(text: &str) -> Vec<String> {
    let mut in_block = false;
    let mut ids = Vec::new();
    for line in text.lines() {
        if line.trim() == MANAGED_BEGIN {
            in_block = true;
            continue;
        }
        if line.trim() == MANAGED_END {
            in_block = false;
            continue;
        }
        if in_block {
            if let Some(rest) = line.trim_start().strip_prefix("- id:") {
                let id = unquote(rest);
                if !id.is_empty() {
                    ids.push(id);
                }
            }
        }
    }
    ids
}

/// 在文本上应用托管禁用：保留旧托管条目 + 新增 `ids`，原子语义由调用方落盘。
///
/// 规则：空模板 `[]` / 空文件先清掉再追加（#54：`[]` 不是可追加的数组）；
/// 其余原文逐字保留。
pub fn apply_managed_disable(text: &str, new_ids: &[String]) -> String {
    let (base, _) = remove_managed_block(text);
    let mut all = managed_ids(text);
    for id in new_ids {
        if !all.contains(id) {
            all.push(id.clone());
        }
    }
    if all.is_empty() {
        return base;
    }
    let mut base = base.trim_end().to_string();
    // 空模板 `[]`：单行空数组必须移除后才能追加条目
    if base == "[]" {
        base.clear();
    }
    if !base.is_empty() {
        base.push('\n');
    }
    base.push_str(&managed_block_text(&all));
    base.push('\n');
    base
}

/// 从托管区块中移除指定 id（恢复语义），返回新文本；区块变空则连标记一起移除。
pub fn remove_managed_ids(text: &str, ids: &[String]) -> String {
    let kept: Vec<String> = managed_ids(text)
        .into_iter()
        .filter(|id| !ids.contains(id))
        .collect();
    let (base, _) = remove_managed_block(text);
    if kept.is_empty() {
        return base;
    }
    let mut base = base.trim_end().to_string();
    if !base.is_empty() {
        base.push('\n');
    }
    base.push_str(&managed_block_text(&kept));
    base.push('\n');
    base
}

/// 移除 `- insert:` 块内指定 id 的子条目（dedupe 语义：patch 侧插入了与既有
/// entry 冲突的重复 id 时，摘除 patch 侧来源）。返回 Some(新文本) 表示有改动。
pub fn remove_insert_entry(text: &str, id: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<&str> = Vec::new();
    let mut removed = false;
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        let ind = indent_of(line);
        if t == "- insert:" || t == "- insert" {
            // 收集整个 insert 块（子条目行：缩进更深）
            let mut j = i + 1;
            let mut child: Vec<usize> = Vec::new();
            let mut hit: Vec<usize> = Vec::new();
            while j < lines.len() {
                let l2 = lines[j];
                let t2 = l2.trim();
                if t2.is_empty() {
                    j += 1;
                    continue;
                }
                let ind2 = indent_of(l2);
                if ind2 <= ind {
                    break;
                }
                if t2.starts_with("- id:") {
                    child.push(j);
                    if unquote(t2.trim_start_matches("- id:")) == id {
                        hit.push(j);
                    }
                }
                j += 1;
            }
            if hit.is_empty() {
                out.push(line);
                i += 1;
                continue;
            }
            // 逐行搬运 insert 块，跳过命中子条目的行（- id: 行及其更深缩进的键行）
            let mut k = i;
            while k < j {
                if hit.contains(&k) {
                    let kd = indent_of(lines[k]);
                    k += 1;
                    while k < j {
                        let tk = lines[k].trim();
                        if tk.is_empty() {
                            k += 1;
                            continue;
                        }
                        if indent_of(lines[k]) > kd {
                            k += 1;
                        } else {
                            break;
                        }
                    }
                    removed = true;
                    continue;
                }
                if child.contains(&k) || !lines[k].trim().is_empty() {
                    out.push(lines[k]);
                }
                k += 1;
            }
            i = j;
            continue;
        }
        out.push(line);
        i += 1;
    }
    if !removed {
        return None;
    }
    let mut s = out.join("\n");
    if !s.ends_with('\n') {
        s.push('\n');
    }
    Some(s)
}

/// 原子写：先写同目录 `.tmp`（带 PID 防碰撞）再 rename。
pub fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_file_name(format!(
        "{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all().ok();
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\n- insert:\n    - id: dsh-ui-progress\n      name: \"@dsh-external/dsh-ui-progress\"\n- id: dsh-at-file\n  disabled: true\n- id: archify-skill-filesystem\n  disabled: true\n";

    #[test]
    fn scan_rows_top_level_and_insert_children() {
        let rows = scan_patch_rows(SAMPLE);
        assert_eq!(rows.len(), 3, "应扫出 3 条：{rows:?}");
        assert_eq!(rows[0].id, "dsh-ui-progress");
        assert!(rows[0].in_insert, "insert 子条目应标记 in_insert");
        assert_eq!(
            rows[0].name.as_deref(),
            Some("@dsh-external/dsh-ui-progress")
        );
        assert!(!rows[1].in_insert);
        assert_eq!(rows[1].disabled, Some(true));
        assert_eq!(rows[2].id, "archify-skill-filesystem");
    }

    #[test]
    fn scan_avoids_config_subtree() {
        // config 子树里的 name:/disabled: 不得归属到条目键上
        let text = "- id: probe\n  config:\n    name: inner-name\n    disabled: true\n  name: outer\n";
        let rows = scan_patch_rows(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name.as_deref(), Some("outer"), "config 子树不得污染 name");
        assert_eq!(rows[0].disabled, None, "config 子树的 disabled 不得归属");
    }

    #[test]
    fn managed_disable_appends_and_keeps_original() {
        let out = apply_managed_disable(SAMPLE, &["wy-ghost-plugin2".into()]);
        assert!(out.contains("- id: dsh-at-file"), "原文条目必须逐字保留");
        assert!(out.contains(MANAGED_BEGIN));
        assert!(out.contains("- id: wy-ghost-plugin2\n  disabled: true"));
        // 幂等：重复应用不产生重复条目
        let out2 = apply_managed_disable(&out, &["wy-ghost-plugin2".into()]);
        assert_eq!(out2.matches("- id: wy-ghost-plugin2").count(), 1);
    }

    #[test]
    fn managed_disable_replaces_empty_template() {
        let out = apply_managed_disable("[]\n", &["a".into()]);
        assert!(!out.contains("[]"), "空模板 [] 必须移除：{out:?}");
        assert!(out.contains("- id: a"));
        let out_empty = apply_managed_disable("", &["a".into()]);
        assert!(out_empty.contains("- id: a"));
    }

    #[test]
    fn managed_restore_and_full_removal() {
        let out = apply_managed_disable(SAMPLE, &["x".into(), "y".into()]);
        let kept = remove_managed_ids(&out, &["x".into()]);
        assert!(kept.contains("- id: y"));
        assert!(!kept.contains("- id: x"));
        assert!(kept.contains("- id: dsh-at-file"), "非托管内容不动");
        let none = remove_managed_ids(&kept, &["y".into()]);
        assert!(!none.contains(MANAGED_BEGIN), "区块空了应连标记一起移除");
        let (back, _) = remove_managed_block(&out);
        assert_eq!(back.trim_end(), SAMPLE.trim_end());
    }

    #[test]
    fn remove_insert_entry_dedupes_patch_side() {
        let text = "- insert:\n    - id: llm\n      name: \"pkg-a\"\n    - id: keep\n      name: \"pkg-b\"\n";
        let out = remove_insert_entry(text, "llm").expect("应移除命中条目");
        assert!(!out.contains("pkg-a"));
        assert!(out.contains("pkg-b"), "其余子条目保留：{out:?}");
        assert!(remove_insert_entry(text, "nope").is_none(), "未命中应返回 None");
    }

    #[test]
    fn atomic_write_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dsh-qtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cordis.patch.yml");
        atomic_write(&p, "hello\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
