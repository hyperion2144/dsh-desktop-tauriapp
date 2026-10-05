//! PATH 列表纯逻辑（图 #169 / 票 #177）：Windows 用户级 PATH 的拆分/拼接/幂等插入
//! 与「新终端解析模拟」的首命中查询。逻辑平台中立、无 cfg 门控——本机（macOS）即可
//! 跑单测（票 #177 验收「逻辑单测落 cargo test」）；调用方只有 windows.rs
//! （注册表读写与 dsh 文件探测都在 cfg(windows) 侧）。

/// 按分号拆分 PATH 值：去空段、去段两端空白，保留原始大小写与未展开段
/// （%USERPROFILE% 等的展开由调用方负责，写回必须用 raw，#174 #4）。
pub(crate) fn split(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 拼接 PATH 值（分号连接、无尾分号——注册表值惯例）。
pub(crate) fn join(parts: &[String]) -> String {
    parts.join(";")
}

/// 大小写不敏感查找（Windows 路径语义）；两端去空白、去尾部反斜杠后比较——
/// 注册表里同目录可能带/不带尾 `\\`，不规范化会把幂等判定 miss 成重复插入。
pub(crate) fn find_ci(parts: &[String], entry: &str) -> Option<usize> {
    fn norm(s: &str) -> &str {
        s.trim().trim_end_matches('\\')
    }
    let needle = norm(entry);
    parts
        .iter()
        .position(|p| norm(p).eq_ignore_ascii_case(needle))
}

/// 把 idx 处的段移动到最前（保留该段原始写法）。idx 必须有效。
pub(crate) fn move_to_front(parts: &[String], idx: usize) -> Vec<String> {
    let mut out = parts.to_vec();
    let item = out.remove(idx);
    out.insert(0, item);
    out
}

/// 「新终端解析模拟」（#174 #15：PATH 逐目录查找、首命中即实际会执行者）。
/// `hit` 谓词由调用方提供（真实侧 = 目录下存在 dsh.cmd/exe/bat；测试给假数据）。
pub(crate) fn first_hit<'a>(dirs: &'a [String], hit: &dyn Fn(&str) -> bool) -> Option<&'a String> {
    dirs.iter().find(|d| hit(d.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_drops_empty_keeps_order_and_raw_segments() {
        assert_eq!(
            split("%USERPROFILE%\\x; C:\\y ;;C:\\z;"),
            vec!["%USERPROFILE%\\x".to_string(), "C:\\y".to_string(), "C:\\z".to_string()]
        );
        assert!(split("").is_empty());
        assert!(split(";").is_empty());
    }

    #[test]
    fn join_is_semicolon_no_trailing() {
        assert_eq!(
            join(&["a".to_string(), "b".to_string()]),
            "a;b"
        );
        assert_eq!(join(&[]), "");
    }

    #[test]
    fn find_ci_is_case_insensitive_and_trims() {
        let v = vec!["C:\\Users\\u\\AppData\\npm".to_string(), "C:\\x".to_string()];
        assert_eq!(find_ci(&v, "c:\\users\\u\\appdata\\npm"), Some(0));
        assert_eq!(find_ci(&v, " c:\\x "), Some(1));
        assert_eq!(find_ci(&v, "nope"), None);
    }

    #[test]
    fn find_ci_normalizes_trailing_backslash() {
        let v = vec!["C:\\x\\".to_string()];
        assert_eq!(find_ci(&v, "C:\\x"), Some(0));
        let v2 = vec!["C:\\x".to_string()];
        assert_eq!(find_ci(&v2, "C:\\x\\"), Some(0));
    }

    #[test]
    fn move_to_front_keeps_others_order_and_raw_form() {
        let v = vec![
            "a".to_string(),
            "%USERPROFILE%\\mid".to_string(),
            "c".to_string(),
        ];
        assert_eq!(
            move_to_front(&v, 1),
            vec!["%USERPROFILE%\\mid".to_string(), "a".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn first_hit_returns_first_matching_dir() {
        let dirs = vec![
            "C:\\system".to_string(),
            "C:\\npm".to_string(),
            "C:\\ours".to_string(),
        ];
        let only_ours = |d: &str| d == "C:\\ours";
        assert_eq!(first_hit(&dirs, &only_ours), Some(&"C:\\ours".to_string()));
        let none = |_: &str| false;
        assert_eq!(first_hit(&dirs, &none), None);
    }
}
