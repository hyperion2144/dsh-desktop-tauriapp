//! 防休眠（#186）：有会话在跑时替用户持有系统防休眠断言。
//!
//! 语义（用户拍板，见地图 #183）：只阻止**系统空闲休眠**——屏幕该熄就熄；合盖不挡
//! （macOS 的断言做不到，见 #185 调研）。「会话在跑」由宿主插件（仓库根 `index.js`）
//! 经 `/notify` 上报的 `busy-state` 决定，**等待审批 / 等待用户输入不算在跑**：
//! DOM 探针（`[data-state="ongoing"]` 之类）是通用 spinner，20+ 处复用，不能当忙判据。
//!
//! 结构：纯状态机 [`Arbiter`] + 常驻 1s tick 线程（线程名 `dsh-keepawake`）。
//! tick 线程是**唯一**调用平台断言的地方——Windows 的 `SetThreadExecutionState` 是
//! 线程级的，断言必须与调用它的线程同生共死；macOS 的 IOKit 断言随进程退出自动释放。
//! 心跳超时**不作为释放条件**（#185 补充第 6 条：熄屏/隐藏窗口时前端定时器是否被节流
//! 未证实，「误释放」比「多持」更糟），陈旧租约只打诊断日志。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// tick 周期：开关/忙状态变化到断言落地的最坏延迟，也是陈旧租约的检查粒度。
const TICK: Duration = Duration::from_secs(1);
/// 租约「陈旧」只用于诊断日志的上报间隔（宿主心跳是 10s，正常不会触发）。
const LEASE_STALE: Duration = Duration::from_secs(60);

/// 上报里没带 profile 名时的兜底键（正常路径由 `DSH_DESKTOP_PROFILE` 给出）。
const UNKNOWN_PROFILE: &str = "default";

/// 防休眠状态机：开关 × 各实例的忙租约。
#[derive(Debug, Default)]
struct Arbiter {
    /// 用户开关（缺省 true，见 `settings::configured_prevent_sleep`）。
    enabled: bool,
    /// 实例身份（profile 名）→ 该实例最近一次上报「有会话在跑」的时刻。
    busy: BTreeMap<String, Instant>,
}

impl Arbiter {
    /// 是否应持有断言：开关开着，且至少有一个实例在跑。
    fn should_hold(&self) -> bool {
        self.enabled && !self.busy.is_empty()
    }

    /// 设置开关（立即影响下一次 tick 的裁决）。
    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// 某实例的忙状态（`false` = 摘掉它的租约）。
    fn set_busy(&mut self, profile: &str, busy: bool) -> bool {
        if busy {
            self.busy.insert(profile.to_string(), Instant::now());
            true
        } else {
            self.busy.remove(profile).is_some()
        }
    }

    /// 实例停 / 重启 / 被销毁：摘掉它的租约（进程没了就不会再有 busy 上报）。
    fn forget(&mut self, profile: &str) -> bool {
        self.busy.remove(profile).is_some()
    }

    /// 壳退出：清空所有租约（tick 线程随即释放断言；进程退出本身也会释放）。
    fn clear(&mut self) {
        self.busy.clear();
    }

    /// 仍在跑的实例名（日志用）。
    fn busy_profiles(&self) -> Vec<String> {
        self.busy.keys().cloned().collect()
    }

    /// 陈旧租约（只诊断，不释放）。
    fn stale(&self, now: Instant) -> Vec<String> {
        self.busy
            .iter()
            .filter(|(_, at)| now.saturating_duration_since(**at) > LEASE_STALE)
            .map(|(profile, _)| profile.clone())
            .collect()
    }
}

static ARBITER: OnceLock<Mutex<Arbiter>> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);

fn arbiter() -> &'static Mutex<Arbiter> {
    ARBITER.get_or_init(|| Mutex::new(Arbiter::default()))
}

/// 起 tick 线程（`lib.rs` setup 里调一次；重复调用只刷新开关，幂等）。
pub(crate) fn init() {
    let enabled = crate::settings::configured_prevent_sleep();
    arbiter().lock().unwrap().set_enabled(enabled);
    log::info!(
        "[power] 防休眠：{}",
        if enabled {
            "开（有会话在跑时阻止系统休眠）"
        } else {
            "关"
        }
    );
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    match std::thread::Builder::new()
        .name("dsh-keepawake".into())
        .spawn(tick_loop)
    {
        Ok(_) => {}
        Err(e) => {
            STARTED.store(false, Ordering::SeqCst);
            log::warn!("[power] 防休眠 tick 线程启动失败，本次不持有断言：{e}");
        }
    }
}

/// 设置开关变化（保存设置后调，即时生效）。
pub(crate) fn set_enabled(enabled: bool) {
    let mut a = arbiter().lock().unwrap();
    if a.enabled != enabled {
        a.enabled = enabled;
        log::info!(
            "[power] 防休眠开关 → {}",
            if enabled { "开" } else { "关" }
        );
    }
}

/// 宿主插件上报的实例忙状态（`/notify` 的 `busy-state`）。
pub(crate) fn set_busy(profile: &str, busy: bool) {
    let profile = if profile.is_empty() {
        UNKNOWN_PROFILE
    } else {
        profile
    };
    let changed = arbiter().lock().unwrap().set_busy(profile, busy);
    if changed {
        log::debug!("[power] 实例 {profile} 忙状态 → {busy}");
    }
}

/// 实例停 / 重启 / 被销毁：摘掉它的租约。
pub(crate) fn forget_profile(profile: &str) {
    let profile = if profile.is_empty() {
        UNKNOWN_PROFILE
    } else {
        profile
    };
    if arbiter().lock().unwrap().forget(profile) {
        log::info!("[power] 实例 {profile} 已停止，摘掉它的防休眠租约");
    }
}

/// 壳退出：清空所有租约（tick 线程随即释放断言）。
pub(crate) fn release_all() {
    arbiter().lock().unwrap().clear();
}

/// tick 线程体：裁决「应不应当持有」，只在翻转时调平台断言。
fn tick_loop() {
    let mut held = false;
    let mut warned_at: Option<Instant> = None;
    loop {
        let (want, busy, stale) = {
            let a = arbiter().lock().unwrap();
            (
                a.should_hold(),
                a.busy_profiles(),
                a.stale(Instant::now()),
            )
        };
        if want != held {
            if want {
                hold::acquire();
            } else {
                hold::release();
            }
            held = want;
            log::info!(
                "[power] {}防休眠断言（在跑的实例：{busy:?}）",
                if want { "持有" } else { "释放" }
            );
        }
        if !stale.is_empty() {
            // 心跳应每 10s 一次；超过 LEASE_STALE 只说明前端可能被节流——照旧持有，只告警。
            let due = warned_at.map(|t| t.elapsed() >= LEASE_STALE).unwrap_or(true);
            if due {
                log::warn!(
                    "[power] 租约 >{}s 未更新（心跳 10s）：{stale:?}——断言继续持有，只做诊断",
                    LEASE_STALE.as_secs()
                );
                warned_at = Some(Instant::now());
            }
        }
        std::thread::sleep(TICK);
    }
}

/// 平台断言层：**只有 tick 线程**会调它。
mod hold {
    /// 持有「系统空闲不休眠」断言。
    pub(super) fn acquire() {
        imp::acquire()
    }

    /// 释放断言（幂等）。
    pub(super) fn release() {
        imp::release()
    }

    #[cfg(target_os = "macos")]
    mod imp {
        use core_foundation::string::CFString;
        use core_foundation::base::TCFType;
        use std::ffi::c_void;
        use std::sync::Mutex;

        /// IOKit 断言 id（`None` = 当前未持有）。
        static HELD: Mutex<Option<u32>> = Mutex::new(None);
        /// `kIOPMAssertionLevelOn`。
        const LEVEL_ON: u32 = 255;
        /// 断言类型：只挡「空闲系统休眠」；挡屏幕熄灭是另一个类型（`PreventUserIdleDisplaySleep`），刻意不用。
        const TYPE: &str = "PreventUserIdleSystemSleep";
        /// 断言名：`pmset -g assertions` 里按这个名字找（验收用）。
        const NAME: &str = "dsh-desktop-tauriapp: session running";

        #[link(name = "IOKit", kind = "framework")]
        extern "C" {
            fn IOPMAssertionCreateWithName(
                assertion_type: *const c_void,
                level: u32,
                name: *const c_void,
                id: *mut u32,
            ) -> i32;
            fn IOPMAssertionRelease(id: u32) -> i32;
        }

        pub(super) fn acquire() {
            if HELD.lock().unwrap().is_some() {
                return; // 已持有：重复创建会漏 id
            }
            let mut id: u32 = 0;
            let rc = unsafe {
                IOPMAssertionCreateWithName(
                    CFString::new(TYPE).as_concrete_TypeRef() as *const c_void,
                    LEVEL_ON,
                    CFString::new(NAME).as_concrete_TypeRef() as *const c_void,
                    &mut id,
                )
            };
            if rc == 0 {
                *HELD.lock().unwrap() = Some(id);
                log::info!("[power] 已持有 macOS 防休眠断言（{NAME}）");
            } else {
                log::warn!("[power] IOPMAssertionCreateWithName 失败（rc={rc}），不持有断言");
            }
        }

        pub(super) fn release() {
            let Some(id) = HELD.lock().unwrap().take() else {
                return;
            };
            let rc = unsafe { IOPMAssertionRelease(id) };
            if rc == 0 {
                log::info!("[power] 已释放 macOS 防休眠断言");
            } else {
                log::warn!("[power] IOPMAssertionRelease 失败（rc={rc}）");
            }
        }
    }

    #[cfg(target_os = "windows")]
    mod imp {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        };

        // 注意：这是**线程级**状态，记在 tick 线程上（线程活着断言就有效）。
        pub(super) fn acquire() {
            let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            if prev == 0 {
                log::warn!("[power] SetThreadExecutionState(ES_SYSTEM_REQUIRED) 失败");
            } else {
                log::info!("[power] 已持有 Windows 防休眠要求（ES_CONTINUOUS|ES_SYSTEM_REQUIRED）");
            }
        }

        pub(super) fn release() {
            // 只留 ES_CONTINUOUS = 清掉「要求系统保持唤醒」，回到系统默认。
            let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            if prev == 0 {
                log::warn!("[power] SetThreadExecutionState(ES_CONTINUOUS) 清除失败");
            } else {
                log::info!("[power] 已释放 Windows 防休眠要求");
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    mod imp {
        pub(super) fn acquire() {}
        pub(super) fn release() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arbiter(enabled: bool) -> Arbiter {
        Arbiter {
            enabled,
            busy: BTreeMap::new(),
        }
    }

    #[test]
    fn holds_only_when_enabled_and_someone_busy() {
        let mut a = arbiter(true);
        assert!(!a.should_hold(), "没人跑就不该持有");
        a.set_busy("web", true);
        assert!(a.should_hold());
        // 第二个 profile 的会话在跑也算：任一窗口在跑即持有
        a.set_busy("desktop", true);
        assert!(a.should_hold());
        a.set_busy("web", false);
        assert!(a.should_hold(), "desktop 还在跑");
        a.set_busy("desktop", false);
        assert!(!a.should_hold(), "都停了就该释放");
    }

    #[test]
    fn switch_off_releases_even_when_busy() {
        let mut a = arbiter(true);
        a.set_busy("web", true);
        assert!(a.should_hold());
        a.set_enabled(false);
        assert!(!a.should_hold(), "关掉开关必须立刻不再持有");
        a.set_enabled(true);
        assert!(a.should_hold(), "再打开且还有会话在跑 → 重新持有");
    }

    #[test]
    fn stopped_instance_loses_its_lease() {
        let mut a = arbiter(true);
        a.set_busy("web", true);
        assert!(a.forget("web"), "有租约才会报告摘除");
        assert!(!a.should_hold());
        assert!(!a.forget("web"), "无租约时是 no-op");
        a.clear();
        assert!(!a.should_hold());
    }

    #[test]
    fn stale_lease_is_reported_but_still_holds() {
        let mut a = arbiter(true);
        a.set_busy("web", true);
        let old = Instant::now() - (LEASE_STALE + Duration::from_secs(5));
        a.busy.insert("web".into(), old);
        assert_eq!(a.stale(Instant::now()), vec!["web".to_string()]);
        assert!(a.should_hold(), "陈旧只告警，不释放（#185 补充第 6 条）");
    }

    /// 真机自证（#186 验收）：断言真的落到 IOKit，`pmset` 能看到、释放后消失。
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_assertion_is_visible_to_pmset() {
        const NAME: &str = "dsh-desktop-tauriapp: session running";
        fn has() -> bool {
            let out = std::process::Command::new("/usr/bin/pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("跑 pmset -g assertions");
            String::from_utf8_lossy(&out.stdout).contains(NAME)
        }
        fn wait(want: bool) -> bool {
            for _ in 0..20 {
                if has() == want {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        }

        let before = has();
        hold::acquire();
        assert!(wait(true), "持有后 pmset 应能看到 {NAME}（此前 {before}）");
        // 把 pmset 的原话打出来当证据（`--nocapture` 时可见；#186 结票评论会引它）
        if let Ok(out) = std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            let line = text
                .lines()
                .find(|l| l.contains(NAME))
                .unwrap_or("<pmset 输出里没找到断言行>");
            println!("[power] pmset 看到的断言：{}", line.trim());
        }
        hold::release();
        assert!(wait(false), "释放后 pmset 不应再看到 {NAME}");
    }
}
