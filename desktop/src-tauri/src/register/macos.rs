//! macOS 检测与执行（图 #169 / 票 #175+#176；事实依据 #173）。

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;

use super::{run_with_timeout, ApplyOutcome, DETECT_TIMEOUT_SECS};

/// 冲突标记：提权脚本内「目标已存在且非本壳」时打到 stderr，Rust 侧据此给冲突指引。
const CONFLICT_MARKER: &str = "dsh-register-conflict";

/// 解析用户真实 shell 环境里的 `dsh`（#173：GUI 进程环境 ≠ 终端环境，必须 spawn
/// 登录 shell 取解析结果；`-ilc` 全读 rc，nvm 等遮蔽源在此暴露）。
///
/// 返回 `None` = 检测不确定（超时/失败），调用方保持旧缓存；
/// `Some(None)` = 解析不到 dsh（干净机器）。
pub(crate) fn resolve() -> Option<Option<PathBuf>> {
    let shell = user_shell();
    let out = run_with_timeout(
        Command::new(&shell)
            .args(["-ilc", "command -v dsh"])
            // 防 Oh My Zsh 自动更新阻塞探测（shell-env 同款，#173）
            .env("DISABLE_AUTO_UPDATE", "true"),
        DETECT_TIMEOUT_SECS,
    )?;
    let text = String::from_utf8_lossy(&out.stdout);
    // 结果取末行（rc 横幅在前，#173）；`command -v` 未命中时非零退出、stdout 为空
    let Some(raw) = super::extract_last_nonempty_line(&text) else {
        return Some(None);
    };
    let cleaned = super::strip_ansi(raw).trim().to_string();
    if cleaned.is_empty() {
        return Some(None);
    }
    // 非 '/' 开头 = alias/function 命中：不是可执行文件路径，但确实「解析到别人」
    // （#173），canonicalize 兜底字面比较会落成 Conflict，把原文展示给用户
    Some(Some(PathBuf::from(cleaned)))
}

/// 登录 shell 权威来源：Directory Services（GUI/launchd 环境的 `$SHELL` 可能缺失
/// 或只是会话快照，#173 实测）；`dscl` 失败回落 `$SHELL`，再回落 `/bin/zsh`。
fn user_shell() -> String {
    let user = std::env::var("USER").unwrap_or_default();
    if !user.is_empty() {
        if let Some(out) = run_with_timeout(
            Command::new("dscl").args([".", "-read", &format!("/Users/{user}"), "UserShell"]),
            4,
        ) {
            if let Some(s) = super::parse_user_shell(&String::from_utf8_lossy(&out.stdout)) {
                return s;
            }
        }
    }
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// 注册执行（#176）：提权 symlink + 顺序遮蔽的 shell rc PATH 修正 + 冲突强制覆盖。
pub(crate) fn perform(app: &AppHandle, force: bool) -> Result<ApplyOutcome, String> {
    // shim 物化（当前运行时那份，spawn 时会被重写、symlink 永远跟随）。
    // 外部 CLI 模式明确拒绝：那一份 dsh 本来就在用户 PATH 上，不该被本壳遮蔽（#160 语义）。
    let Some(shim_dir) = crate::profiles::ensure_dsh_shim_dir(app) else {
        return Err("外部 CLI 模式下无需注册：系统里的 dsh 即你配置的外部 CLI".into());
    };
    let shim = shim_dir.join("dsh");
    // ① 一次授权内完成：mkdir -p + 幂等（已是我们的链接 → exit 0）+
    //    冲突（非 force → exit 3 带标记；force → mv 时间戳备份再 ln）。
    //    决策 #170/Q11：用户取消 = 中性中止，无半成品（脚本不可分割）。
    run_osascript(&registration_script(&shim, force))?;
    // ② 实测解析：已直连命中 → 完成（不碰用户 rc，最小侵入）；
    //    仍被遮蔽（nvm 等前序）→ ③ 按实际 shell 追加 PATH 修正（幂等 sentinel）。
    if resolution_hits(&shim) != Some(false) {
        return Ok(ApplyOutcome::Done);
    }
    let fix = fix_shell_rc_path();
    log::info!("[register] 顺序遮蔽，已追加 shell rc PATH 修正：{fix}");
    // 修正后不再强求立刻命中（rc 只对新开终端生效，#173）：检测模型会继续如实
    // 显示三态；若用户环境仍有前序遮蔽，冲突提示照常可见（决策 #170/Q3 语义）。
    Ok(ApplyOutcome::Done)
}

/// 提权后的解析核对：`Some(true)`=命中本壳；`Some(false)`=未命中；`None`=检测不确定。
fn resolution_hits(shim: &Path) -> Option<bool> {
    match resolve() {
        Some(Some(p)) => Some(super::path_eq(&p, shim)),
        Some(None) => Some(false),
        None => None,
    }
}

/// 跑提权脚本（osascript with administrator privileges，#173）。
/// 不设超时：等用户输密码可能数十秒，kill 会打断授权流程（阻塞线程上等待）。
fn run_osascript(script: &str) -> Result<ApplyOutcome, String> {
    let osa = format!(
        "do shell script \"{}\" with administrator privileges",
        apple_escape(script)
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&osa)
        .output()
        .map_err(|e| format!("osascript 启动失败：{e}"))?;
    if out.status.success() {
        return Ok(ApplyOutcome::Done);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    // 用户取消密码框：AppleScript 统一 exit 1，取消只能靠 stderr 的 -128 判别（#173 实测）
    if stderr.contains("-128") || stderr.contains("User canceled") {
        return Ok(ApplyOutcome::Canceled);
    }
    if stderr.contains(CONFLICT_MARKER) {
        return Err(
            "检测到 dsh 命令冲突：/usr/local/bin/dsh 已存在且非本壳入口。请在托盘「注册 dsh 为系统命令（检测到冲突）」中走强制覆盖"
                .into(),
        );
    }
    Err(format!("提权执行失败：{}", stderr.trim()))
}

/// 生成提权脚本（在 /bin/sh 下执行，#173：内一律绝对路径）：
/// mkdir -p（/usr/local/bin 本机实测可能不存在）→ 幂等（已是我们的链接 → exit 0）→
/// 冲突分支（非 force：stderr 打标记 exit 3；force：mv 带时间戳备份再放行）→ `ln -sfn`。
fn registration_script(shim: &Path, force: bool) -> String {
    let shim_q = shell_quote(&shim.to_string_lossy());
    let force01 = if force { "1" } else { "0" };
    format!(
        r#"/bin/mkdir -p '/usr/local/bin'
t='/usr/local/bin/dsh'
if [ -e "$t" ] || [ -L "$t" ]; then
  cur=`/usr/bin/readlink "$t" 2>/dev/null`
  if [ "$cur" = {shim_q} ]; then
    exit 0
  fi
  if [ '{force01}' = '1' ]; then
    /bin/mv "$t" "$t.bak.`/bin/date +%Y%m%d%H%M%S`" || exit 9
  else
    echo '{CONFLICT_MARKER}' >&2
    exit 3
  fi
fi
/bin/ln -sfn {shim_q} "$t"
"#
    )
}

/// POSIX 单引号包裹（sh 侧路径安全，含空格/单引号）。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// AppleScript 字符串字面量转义（反斜杠 + 双引号）。
fn apple_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 顺序遮蔽修正（决策 #170/Q8）：探测实际 shell，在对应 rc 追加 PATH 修正行。
/// zsh → ~/.zshrc（交互终端必读且在 path_helper 重组之后，#173）；
/// bash → ~/.bash_profile（不存在则用已有 ~/.profile 兜底，**不新建遮蔽它**，#173）；
/// fish → ~/.config/fish/config.fish + `fish_add_path`（原生幂等前置）。
/// 返回说明文本（供日志）。
fn fix_shell_rc_path() -> String {
    let Ok(home) = std::env::var("HOME") else {
        return "HOME 未设置，跳过 rc 修正".into();
    };
    let home = PathBuf::from(home);
    let shell = user_shell();
    let name = shell.rsplit('/').next().unwrap_or(&shell);
    let path_line = r#"export PATH="/usr/local/bin:$PATH""#;
    let (rc, line) = match name {
        "fish" => (
            home.join(".config/fish/config.fish"),
            "fish_add_path /usr/local/bin".to_string(),
        ),
        "bash" => {
            let bp = home.join(".bash_profile");
            // bash login 按序取第一个存在的（#173）：新建 .bash_profile 会遮蔽已有 .profile
            if bp.exists() {
                (bp, path_line.to_string())
            } else {
                let prof = home.join(".profile");
                if prof.exists() {
                    (prof, path_line.to_string())
                } else {
                    (bp, path_line.to_string())
                }
            }
        }
        // zsh 及其他 POSIX shell：zsh 修正行放 ~/.zshrc 最稳（#173）
        _ => (home.join(".zshrc"), path_line.to_string()),
    };
    if append_block(&rc, &line) {
        format!("{}（已追加修正行）", rc.display())
    } else {
        format!("{}（已有修正块，跳过）", rc.display())
    }
}

/// 追加托管块（conda init 同款 sentinel，#173）：已含 `>>> dsh cli path >>>` 则跳过
/// （重复注册不叠加行）；否则追加完整块。返回是否实际追加。
fn append_block(rc: &Path, line: &str) -> bool {
    const OPEN: &str = "# >>> dsh cli path >>>";
    const CLOSE: &str = "# <<< dsh cli path <<<";
    if let Ok(existing) = std::fs::read_to_string(rc) {
        if existing.contains(OPEN) {
            return false;
        }
    }
    if let Some(parent) = rc.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut content = std::fs::read_to_string(rc).unwrap_or_default();
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("\n{OPEN}\n{line}\n{CLOSE}\n"));
    std::fs::write(rc, content).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(shell_quote("/usr/local/bin"), "'/usr/local/bin'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        let p = "/Users/u/Library/Application Support/app/runtime/bin-dsh/dsh";
        let q = shell_quote(p);
        assert!(q.starts_with('\'') && q.ends_with('\''));
    }

    #[test]
    fn apple_escape_escapes_quotes_and_backslashes() {
        assert_eq!(apple_escape("a\"b\\c"), "a\\\"b\\\\c");
        assert_eq!(apple_escape("plain"), "plain");
    }

    #[test]
    fn registration_script_covers_idempotent_conflict_and_force() {
        let shim = PathBuf::from("/Users/u/App Support/app/runtime/bin-dsh/dsh");
        let s0 = registration_script(&shim, false);
        assert!(s0.contains("/bin/mkdir -p '/usr/local/bin'"));
        assert!(s0.contains("/usr/bin/readlink"));
        assert!(s0.contains(&shell_quote(&shim.to_string_lossy())));
        assert!(s0.contains("'0' = '1'")); // 非 force：冲突替换分支条件不可达
        assert!(s0.contains(CONFLICT_MARKER)); // 冲突打标记供 Rust 侧判别
        assert!(s0.contains("/bin/ln -sfn"));
        assert!(s0.contains("exit 0")); // 幂等出口
        let s1 = registration_script(&shim, true);
        assert!(s1.contains("'1' = '1'"));
        assert!(s1.contains("/bin/mv")); // force：先备份
        assert!(s1.contains(".bak."));
    }

    #[test]
    fn append_block_is_idempotent_and_wraps_with_sentinel() {
        let dir = std::env::temp_dir().join(format!("dsh-reg-rc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join(".zshrc");
        assert!(append_block(&rc, "export PATH=\"/usr/local/bin:$PATH\""));
        let once = std::fs::read_to_string(&rc).unwrap();
        assert_eq!(once.matches("# >>> dsh cli path >>>").count(), 1);
        assert!(once.contains("export PATH=\"/usr/local/bin:$PATH\""));
        // 验收「重复注册不叠加 rc 行」：二次追加被 sentinel 拦下
        assert!(!append_block(&rc, "export PATH=\"/usr/local/bin:$PATH\""));
        let twice = std::fs::read_to_string(&rc).unwrap();
        assert_eq!(twice.matches("# >>> dsh cli path >>>").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_block_preserves_existing_content() {
        let dir = std::env::temp_dir().join(format!("dsh-reg-rc2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("config.fish");
        std::fs::write(&rc, "set -g fish_greeting\n").unwrap();
        assert!(append_block(&rc, "fish_add_path /usr/local/bin"));
        let out = std::fs::read_to_string(&rc).unwrap();
        assert!(out.starts_with("set -g fish_greeting"));
        assert!(out.contains("fish_add_path /usr/local/bin"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
