//! 让**我们注入的那个 `dsh`** 放行 `desktop` profile。
//!
//! 背景（实机 + 读源码）：
//! 官方 CLI 的启动器里有一段**只按名字**判断的硬拦截——
//! `rejectElectronProfile(program, profile)`：`profile === "desktop"` 就
//! `program.error('error: profile "desktop" is managed exclusively by the Electron application')`，
//! 且**没有环境变量开关**（内置 0.2.0-rc.2 与官方 0.1.7 都如此）。
//!
//! 但拦截只发生在**参数解析**阶段，真正的执行入口是内部的 `runProfile` / `runPlugin`：
//! 桌面壳自己拉起 desktop profile 走的就是 `runProfile`（从不受此限）。问题出在
//! [`super::super::profiles::ensure_dsh_shim_dir`] 注入的那个 `dsh`——它指向**同一个运行时**的
//! `lib/bin.js`，于是用户在终端里用它时会撞上这道拦截（`dsh plugin --profile desktop …` 也一样）。
//!
//! 这里在写 shim 的同时把那段判断**幂等**地去掉，让「注入的 dsh」与壳的行为一致。
//! 只动那一行语句：`plugin` 动作里的 `if (!manageDesktopProfile) rejectElectronProfile(...)`
//! 也因此一并放行（它调用的是同一个函数）。
//!
//! 兼容性：找不到那句原文（上游改了措辞/结构）就**什么都不做**并报 [`PatchOutcome::UnknownShape`]，
//! 绝不猜着改；已打过补丁则报 [`PatchOutcome::AlreadyPatched`]（本函数每次 dsh spawn 都会走一遍）。
use std::path::Path;

/// 上游启动器里的原始判断（逐字，含转义）。
const GUARD: &str = r#"if (profile.toLowerCase() === "desktop") program.error("error: profile \"desktop\" is managed exclusively by the Electron application");"#;

/// 打补丁后留在原处的标记（同时作为幂等判据）。
const MARK: &str =
    "/* dsh-desktop-tauriapp: 放行 desktop profile（我们的壳自己用 runProfile 拉起它） */";

/// 补丁结果（调用方只用来记日志）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PatchOutcome {
    /// 这次真的改了。
    Patched,
    /// 之前已经改过（幂等命中）。
    AlreadyPatched,
    /// 文件里找不到那句原文：上游可能改过，**保持原样**。
    UnknownShape,
}

/// 对 `…/@deepseek-ai/dsh/lib/bin.js` 幂等打补丁。文件不存在返回 `Ok(None)`。
pub(crate) fn allow_desktop_profile(cli: &Path) -> std::io::Result<Option<PatchOutcome>> {
    if !cli.is_file() {
        return Ok(None);
    }
    let source = std::fs::read_to_string(cli)?;
    if source.contains(MARK) {
        return Ok(Some(PatchOutcome::AlreadyPatched));
    }
    if !source.contains(GUARD) {
        return Ok(Some(PatchOutcome::UnknownShape));
    }
    let patched = source.replacen(GUARD, MARK, 1);
    std::fs::write(cli, patched)?;
    Ok(Some(PatchOutcome::Patched))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-cli-patch-test-{name}"));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("bin.js");
        std::fs::write(&file, body).unwrap();
        file
    }

    #[test]
    fn patches_the_guard_and_is_idempotent() {
        let file = tmp(
            "basic",
            &format!("function rejectElectronProfile(program, profile) {{\n\t{GUARD}\n}}\n"),
        );
        assert_eq!(
            allow_desktop_profile(&file).unwrap(),
            Some(PatchOutcome::Patched)
        );
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(!after.contains("managed exclusively"), "拦截语句应已消失");
        assert!(after.contains(MARK), "应留下标记");
        // 第二次：幂等命中，不再改写
        assert_eq!(
            allow_desktop_profile(&file).unwrap(),
            Some(PatchOutcome::AlreadyPatched)
        );
        let again = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, again, "幂等：内容不再变化");
    }

    #[test]
    fn leaves_unknown_shape_alone() {
        let file = tmp("unknown", "function rejectElectronProfile() {}\n");
        assert_eq!(
            allow_desktop_profile(&file).unwrap(),
            Some(PatchOutcome::UnknownShape)
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "function rejectElectronProfile() {}\n",
            "形状不认识时绝不猜着改"
        );
    }

    #[test]
    fn missing_file_is_none() {
        let missing = std::env::temp_dir().join("dsh-cli-patch-test-missing/bin.js");
        assert_eq!(allow_desktop_profile(&missing).unwrap(), None);
    }
}
