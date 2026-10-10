//! 窗口「最小化 → 还原」后的重绘恢复（#161）。
//!
//! 现象（Windows 实测）：把窗口最小化再还原回来，内容区整片黑屏，只剩 `position:fixed`
//! 的注入 chrome（「运行中」状态条 + 自绘窗口按钮）还画得出来，必须手动刷新（F5）才恢复。
//!
//! 根因（上游）：WebView2 的合成面（composited surface）在宿主窗口最小化时被丢弃，还原后
//! 的**第一帧**不重绘——空白一直留着，直到别的事情（点一下别处、改窗口大小）逼它画第二帧。
//! Microsoft 自己的指引是宿主必须在最小化/还原的**那一刻**手动翻转
//! `ICoreWebView2Controller.IsVisible`；见
//! <https://github.com/MicrosoftEdge/WebView2Feedback/issues/5171>（blank screen on restore）
//! 与 <https://github.com/MicrosoftEdge/WebView2Feedback/issues/1252>。
//!
//! 为什么本仓会中招：Tauri/tao 的窗口事件里**没有** `Minimized` / `Restored` 变体
//! （只有 `Resized` / `Moved` / `Focused` / `CloseRequested` / `Destroyed` / `ScaleFactorChanged`
//! / `DragDrop` / `ThemeChanged`，见 tauri 2.11 `WindowEvent`），所以没有任何地方响应还原动作。
//! 更关键的是：还原**不是**一次尺寸变化。最小化时 tao 的 `WM_SIZE` 报的是 `0×0`，还原回到
//! 原来的尺寸——而尺寸与最小化前一致，就没有任何「重新布局」的理由。
//! wry 的子类过程（`WM_SIZE`）虽然会跳过 `SIZE_MINIMIZED` 那一拍，还原拍也确实会走
//! `SetBounds`（wry 0.55.1 对 `WM_SIZE` 是无条件调用的，没有同值守卫），但**同尺寸的
//! `SetBounds` 唤不醒已经被丢掉的合成面**——上游反馈里那两条绕过办法（宿主翻
//! `IsVisible`、还原时先给个 loading）本质都是在制造一次「非尺寸变化的重绘信号」。
//!
//! 修法：还原那一刻人为制造一次**真实的尺寸变化**——两拍，先把窗口缩 1px，
//! 一帧之后再拨回真实尺寸。1px 是刻意选的最小扰动：`SetWindowPos` 的尺寸确实变了，
//! WebView2 必须重算并重建合成面（tao 的 `set_inner_size` 到 `SetWindowPos` 之间也没有
//! 同值守卫，见 `platform_impl/windows/util.rs`），而 1px 又不至于让人眼看见中间态。
//!
//! 状态机是纯的（[`Transition`]），驱动部分才碰窗口：这样「哪些 Resized 该触发微调」可以
//! 单元测试钉死，不必在 Windows 上手测。

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, PhysicalSize, WebviewWindow, Window};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::IsZoomed;

/// 「刚被最小化」标记：窗口尺寸塌成零时置位，还原微调时消费掉。
const TINY_SEEN: u8 = 1 << 0;
/// 「微调已下单」标记：两拍之间防止重复下单（Resized 会来好几次）。
const NUDGED: u8 = 1 << 1;

/// 还原拍（第二拍）的等待：够合成器提交一帧，又不至于让人眼看见。
const RESTORE_DELAY_MS: u64 = 16;
/// 最大化窗口「收窗 → 再最大化」两拍之间的等待：让收窗那拍先落定。
const REZOOM_DELAY_MS: u64 = 16;

/// 窗口每报告一次尺寸，状态机给出的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transition {
    /// 与还原无关（普通缩放/拖动改尺寸）。
    Idle,
    /// 检测到「最小化 → 还原」：调用方应当下单一次重绘微调。
    Nudge,
}

/// 纯状态机：把一串尺寸事件压成「该不该微调」。
#[derive(Default)]
pub(crate) struct RestoreNudge {
    flags: AtomicU8,
}

impl RestoreNudge {
    /// 窗口每报一次 `Resized` 就调用一次。
    ///
    /// `is_minimized` 是此刻 `window.is_minimized()` 的读数：与尺寸塌陷互为佐证（两条独立证据
    /// 只要一条成立就算「进过最小化」，避免个别 Windows 上 `WM_SIZE` 时机差异漏判）。
    pub(crate) fn observe_resized(
        &self,
        size: PhysicalSize<u32>,
        is_minimized: bool,
    ) -> Transition {
        if is_degenerate(size) || is_minimized {
            self.flags.fetch_or(TINY_SEEN, Ordering::SeqCst);
            return Transition::Idle;
        }
        // 已经有一次微调在途：这一拍同样算「还原事件」，但绝不叠加第二次微调。
        // 注意顺序——先判在途，**不能**在判在途之前就把欠账读掉：那会让一次失败的在途微调
        // 把下一次还原的欠账一起吞掉（#161 对抗式复查 M2）。
        if self.flags.load(Ordering::SeqCst) & NUDGED != 0 {
            return Transition::Idle;
        }
        let pending = self.flags.fetch_and(!TINY_SEEN, Ordering::SeqCst) & TINY_SEEN != 0;
        if !pending {
            return Transition::Idle;
        }
        self.flags.fetch_or(NUDGED, Ordering::SeqCst);
        Transition::Nudge
    }

    /// 窗口重新获得焦点时调用：先看有没有在途微调（有就什么都别动，免得把在途那次
    /// 的收尾标记弄乱），再回答此刻是否仍有一次「进了最小化、还没微调」的欠账。
    ///
    /// 兜底思路与 `observe_resized` 不同：有些机器上窗口可能先还原、后补发尺寸事件，
    /// 也可能压根没补发，所以焦点回来时也认一次账——只要尺寸已经是有宽高的真实尺寸。
    pub(crate) fn observe_focused(&self) -> bool {
        let flags = self.flags.load(Ordering::SeqCst);
        if flags & NUDGED != 0 || flags & TINY_SEEN == 0 {
            return false;
        }
        self.flags.fetch_or(NUDGED, Ordering::SeqCst);
        true
    }

    /// 放弃一次已下单的微调（窗口又最小化了 / 尺寸被外部改了 / 调度失败）。
    ///
    /// 只回滚「在途」标记：欠账不是这次微调欠下的，下一次还原该修还得修。
    fn release_inflight(&self) {
        self.flags.fetch_and(!NUDGED, Ordering::SeqCst);
    }

    /// 读内部标记位（仅供单测断言：一轮完整生命周期后应当归零）。
    #[cfg(test)]
    pub(crate) fn raw(&self) -> u8 {
        self.flags.load(Ordering::SeqCst)
    }
}

/// 是否属于「尺寸塌陷」——最小化时 tao 把客户区尺寸报成 0×0
/// （tao `WM_SIZE` 无条件上报 lparam 的宽高，`SIZE_MINIMIZED` 时即 0）。
pub(crate) fn is_degenerate(size: PhysicalSize<u32>) -> bool {
    size.width == 0 || size.height == 0
}

/// 第二拍该怎么收：普通窗口把尺寸拨回真实值，最大化窗口「收窗再最大化」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestoreStep {
    /// 把窗口尺寸写回 [`NudgePlan::target`]。
    Resize,
    /// 最大化窗口专用：第一拍取消最大化（真实尺寸变化），第二拍重新最大化。
    Rezoom,
}

/// 一次还原的重绘微调计划。
#[derive(Debug, Clone, Copy)]
pub(crate) struct NudgePlan {
    /// 第一拍写进去的尺寸。
    middle: PhysicalSize<u32>,
    /// 第二拍要恢复的真实尺寸。
    target: PhysicalSize<u32>,
    /// 第二拍的动作。
    step: RestoreStep,
}

/// 微调的两拍尺寸：先偏离真实尺寸 1px（逼 WebView2 重算布局），再回到真实尺寸。
///
/// `armed_target` 是还原事件的真实尺寸，`is_maximized` 是还原那一刻窗口是否处于最大化。
/// 返回 `None` 表示这个尺寸没法安全微调（尺寸本身已塌陷、会撞 0，或两拍等价）。
///
/// 最大化窗口不缩 1px：tao 的 `set_inner_size` 会先同步清掉 MAXIMIZED 并
/// `ShowWindow(SW_RESTORE)`，那一刻的矩形会被系统记成「还原尺寸」，之后再也回不去
/// （#161 对抗式复查 M3）。它改用「收窗 → 再最大化」——`SW_RESTORE`/`SW_MAXIMIZE`
/// 只消费、不改写 `rcNormalPosition`，两拍也都是真实的尺寸变化。
pub(crate) fn nudge_plan(armed_target: PhysicalSize<u32>, is_maximized: bool) -> Option<NudgePlan> {
    if is_degenerate(armed_target) {
        return None;
    }
    if is_maximized {
        // 收窗那拍不改尺寸，没有「两拍必须不同」的约束；但目标尺寸本身必须是真的。
        return Some(NudgePlan {
            middle: armed_target,
            target: armed_target,
            step: RestoreStep::Rezoom,
        });
    }
    let middle = nudged(armed_target);
    if is_degenerate(middle) || middle == armed_target {
        return None;
    }
    Some(NudgePlan {
        middle,
        target: armed_target,
        step: RestoreStep::Resize,
    })
}

/// 1px 偏移：小尺寸（1/2px）往内偏，其余往外偏——始终避开 0，也始终不同于原值。
pub(crate) fn nudged(value: PhysicalSize<u32>) -> PhysicalSize<u32> {
    PhysicalSize::new(nudge_offset(value.width), nudge_offset(value.height))
}

fn nudge_offset(value: u32) -> u32 {
    if value > 1 {
        value - 1
    } else {
        value + 2
    }
}

/// 此刻窗口是否真的处于最大化（Windows 专用）。
///
/// 不用 tao 的 `is_maximized()`：它由 `WM_SIZE` 的 wparam 派生，窗口最小化那一拍会把标记
/// 清掉，还原首拍报的是 `SIZE_RESTORED` ⇒ 一个「最小化前是最大化」的窗口会被读成普通窗口，
/// 于是走缩 1px 那条路，窗口停在「未最大化」，用户就掉出最大化态了。
/// `IsZoomed` 读的是窗口真实状态，图标化时依然保持（#161 对抗式复查 M3）。
#[cfg(windows)]
fn is_zoomed(window: &Window) -> bool {
    window
        .hwnd()
        .map(|hwnd| unsafe { IsZoomed(windows::Win32::Foundation::HWND(hwnd.0)) }.as_bool())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_zoomed(_window: &Window) -> bool {
    false
}

/// Windows 才需要这个 workaround（上游 WebView2 的坑在 Windows）；其余平台直接不动窗口。
pub(crate) const fn windows_only() -> bool {
    cfg!(target_os = "windows")
}

/// 给指定窗口装一个重绘恢复状态机。
///
/// 由建窗处（主窗 / profile 次窗）调用：主窗口的 `Resized` / `Focused` 事件在 `lib.rs`
/// 里已经挤满页签，逻辑收取这里。
pub(crate) fn attach(app: &AppHandle, window: &WebviewWindow) {
    if !windows_only() {
        return;
    }
    let app = app.clone();
    let label = window.label().to_string();
    // 状态机要跨三处用：窗口事件闭包、第二拍、放弃时的回滚。用 Arc 共享同一份
    // （tauri 的事件闭包与 run_on_main_thread 都要求 'static）。
    let nudge = Arc::new(RestoreNudge::default());
    window.on_window_event(move |event| {
        use tauri::WindowEvent;
        // 必须用 `get_window` 而不是 `get_webview_window`：后者要求「窗口下所有 webview 的
        // label 都等于窗口 label」（tauri `Window::is_webview_window`），而侧边栏浏览器是
        // `add_child` 出来的子 webview，它的 `window_label()` 也取宿主窗口名 ⇒ 只要侧边栏
        // 浏览器开着，`get_webview_window("main")` 就返回 None，整个恢复逻辑静默失效
        // （#161 对抗式复查 M1，正是本票的复现前提）。
        let Some(w) = app.get_window(&label) else {
            return;
        };
        match event {
            WindowEvent::Resized(size) => {
                let minimized = w.is_minimized().unwrap_or(false);
                if nudge.observe_resized(*size, minimized) == Transition::Nudge {
                    request_nudge(&w, Arc::clone(&nudge));
                }
            }
            WindowEvent::Focused(true) => {
                // 尺寸仍处于塌陷态 = 窗口还没真还原；仍是最小化态（尺寸可能保留着旧值）同理。
                // 这时给的焦点事件不代表有可用画面，别把最小化的窗口当还原窗口去拨尺寸。
                let degenerate = w.inner_size().map(is_degenerate).unwrap_or(true);
                let minimized = w.is_minimized().unwrap_or(true);
                if !degenerate && !minimized && nudge.observe_focused() {
                    request_nudge(&w, Arc::clone(&nudge));
                }
            }
            _ => {}
        }
    });
}

/// 一次还原的重绘微调：第一拍制造真实尺寸变化，第二拍恢复原状。
fn request_nudge(window: &Window, nudge: Arc<RestoreNudge>) {
    let Ok(current) = window.inner_size() else {
        return;
    };
    let Some(plan) = nudge_plan(current, is_zoomed(window)) else {
        return;
    };
    match plan.step {
        RestoreStep::Resize => log::info!(
            "[restore] 最小化还原：重绘微调 {}x{} → {}x{}",
            current.width,
            current.height,
            plan.middle.width,
            plan.middle.height
        ),
        RestoreStep::Rezoom => log::info!(
            "[restore] 最小化还原：最大化窗口重绘恢复（收窗后重新最大化，不回写还原尺寸）"
        ),
    }

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let first = match plan.step {
        RestoreStep::Resize => window.set_size(plan.middle),
        RestoreStep::Rezoom => window.unmaximize(),
    };
    if let Err(e) = first {
        log::warn!("[restore] 重绘微调（第一拍）失败：{e}");
        nudge.release_inflight();
        return;
    }
    // 第二拍要重新落到主线程上执行，这里的闭包把 AppHandle 移进去；状态机再克隆一份给闭包，
    // 外层留一份给「调度本身失败」的回滚用。
    let inflight = Arc::clone(&nudge);
    let inflight_for_abort = Arc::clone(&nudge);
    if let Err(e) = app.clone().run_on_main_thread(move || {
        let Some(w) = app.get_window(&label) else {
            return;
        };
        // 这一拍只确认「事情还朝着原计划走」；真正的判断留给第二拍（那时才谈得上取消）。
        if w.is_minimized().unwrap_or(false) {
            log::info!("[restore] 微调中断：窗口又回到最小化");
            inflight_for_abort.release_inflight();
            return;
        }
        restore_later(&app, &label, plan, inflight);
    }) {
        log::warn!("[restore] 重绘微调调度失败：{e}");
        nudge.release_inflight();
    }
}

/// 第二拍：等一帧后把窗口恢复原状（普通窗口拨回尺寸，最大化窗口重新最大化）。
///
/// `nudge` 是 [`attach`] 的每窗状态机：这一拍可能因为「尺寸被外部改过」而整条放弃，
/// 那时必须在原地把在途标记还回去，否则下一次还原会被误判成「已有微调在途」而彻底不修。
fn restore_later(app: &AppHandle, label: &str, plan: NudgePlan, nudge: Arc<RestoreNudge>) {
    let app = app.clone();
    let label = label.to_string();
    let (middle, target) = (plan.middle, plan.target);
    let wants_rezoom = plan.step == RestoreStep::Rezoom;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(RESTORE_DELAY_MS)).await;
        log::info!("[restore] 重绘微调收尾：调度到主线程");
        let inner_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = inner_app.get_window(&label) else {
                log::info!("[restore] 重绘微调收尾中止：窗口已销毁");
                return;
            };
            if window.is_minimized().unwrap_or(false) {
                log::info!("[restore] 重绘微调收尾中止：窗口又回到最小化");
                return;
            }
            // 尺寸已经不是我们写进去的那个（用户/DPI/壳自己的 set_size 改过）⇒ 不硬掰回去。
            match window.inner_size() {
                Ok(current) if current != middle => log::info!(
                    "[restore] 重绘微调收尾中止：尺寸已被外部改为 {}x{}",
                    current.width,
                    current.height
                ),
                Ok(_) => {
                    if wants_rezoom {
                        rezoom(&window);
                    } else if let Err(e) = window.set_size(target) {
                        log::warn!("[restore] 重绘微调（第二拍）失败：{e}");
                    }
                }
                Err(e) => log::warn!("[restore] 重绘微调（第二拍）读不到尺寸：{e}"),
            }
        });
    });
}

/// 最大化窗口的收尾：隔一拍重新最大化。
///
/// 为什么走两拍：`ShowWindow(SW_MAXIMIZE)` 只把窗口置为最大化，**不改写 `rcNormalPosition`**，
/// 所以窗口不会永远丢掉原来的几何；而拆成两拍是为了让系统真的看到一次尺寸变化
/// （一帧内连发，中间那拍可能被合并掉）。
fn rezoom(window: &Window) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(REZOOM_DELAY_MS)).await;
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(w) = inner.get_window(&label) else {
                return;
            };
            if let Err(e) = w.maximize() {
                log::warn!("[restore] 重绘微调（重新最大化）失败：{e}");
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(w: u32, h: u32) -> PhysicalSize<u32> {
        PhysicalSize::new(w, h)
    }

    /// 最小化把尺寸压成 0×0（tao `WM_SIZE` 原样上报 lparam）；还原报回真实尺寸。
    #[test]
    fn minimize_then_restore_asks_for_one_nudge() {
        let sm = RestoreNudge::default();
        assert_eq!(
            sm.observe_resized(size(0, 0), true),
            Transition::Idle,
            "0×0 不该触发微调"
        );
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge,
            "还原该触发一次微调"
        );
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Idle,
            "第二次真实尺寸不该重复触发"
        );
    }

    /// 只报「此刻最小化 = true」也能记上账（个别环境 `WM_SIZE` 尺寸不为零时的兜底证据）。
    #[test]
    fn minimized_flag_alone_arms_the_nudge() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(1280, 840), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1290, 850), false),
            Transition::Nudge
        );
    }

    /// 普通拖动/缩放（从没最小化过）一律不打扰。
    #[test]
    fn plain_resizes_never_nudge() {
        let sm = RestoreNudge::default();
        for (w, h) in [(1280, 840), (1, 1), (1024, 768), (2000, 1200)] {
            assert_eq!(
                sm.observe_resized(size(w, h), false),
                Transition::Idle,
                "{w}x{h} 不该微调"
            );
        }
    }

    /// 还原后连续多帧 Resized（Windows 还原常发好几拍）只许一次微调。
    #[test]
    fn burst_of_restore_resizes_yields_single_nudge() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );
        for _ in 0..5 {
            assert_eq!(sm.observe_resized(size(1280, 840), false), Transition::Idle);
        }
    }

    /// 微调在途时又最小化：标记要重新武装，下一次还原还得能修。
    #[test]
    fn re_minimize_during_flight_rearms() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );
        // 微调真正落地 → 在途标记被回收。
        sm.release_inflight();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge,
            "第二轮回合仍要能修"
        );
    }

    /// 宽度或高度任一塌陷都算最小化信号。
    #[test]
    fn degenerate_size_covers_either_axis() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 840), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );

        let sm2 = RestoreNudge::default();
        assert_eq!(sm2.observe_resized(size(1280, 0), true), Transition::Idle);
        assert_eq!(
            sm2.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );
    }

    /// 焦点回来的兜底：进过最小化、且尺寸已经是真尺寸 → 仍要认一次账。
    #[test]
    fn focus_fallback_reports_pending_debt_once() {
        let sm = RestoreNudge::default();
        assert!(!sm.observe_focused(), "从没最小化过不该认账");

        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert!(sm.observe_focused(), "欠账该被认一次");
        assert!(!sm.observe_focused(), "认过就不许重复");
    }

    /// 在途微调不该吞掉欠账：第二次还原必须还能触发（#161 对抗式复查 M2）。
    #[test]
    fn second_restore_still_nudges_without_a_focus_in_between() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );
        sm.release_inflight(); // 第一轮微调落地
                               // 没有焦点事件参与（焦点可能先到、那时窗口还是 0x0 被前门挡掉）。
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge,
            "在途标记不该把下一次还原的欠账一起吞掉"
        );
    }

    /// 在途期间到来的焦点事件不得弄乱标记（否则会把在途那次微调的收尾一起取消）。
    #[test]
    fn focus_during_flight_leaves_flags_alone() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );
        assert!(!sm.observe_focused(), "在途时焦点不认新账");
        assert_eq!(sm.raw(), NUDGED, "在途标记必须原样留着");
    }

    /// 放弃一次在途微调只回滚「在途」标记，不制造欠账。
    #[test]
    fn releasing_inflight_clears_only_the_inflight_flag() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );
        sm.release_inflight();
        assert_eq!(sm.raw(), 0);
        assert!(!sm.observe_focused(), "放弃不产生欠账");
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Idle,
            "没有新的最小化，就不该空转微调"
        );
    }

    /// 微调计划的尺寸约束：怎么都得给出一对合法尺寸（避开 0、两拍不等）。
    #[test]
    fn nudge_plan_never_produces_degenerate_sizes() {
        for (w, h) in [
            (1, 1),
            (1, 840),
            (1280, 1),
            (2, 2),
            (1280, 840),
            (3840, 2160),
        ] {
            let plan =
                nudge_plan(size(w, h), false).unwrap_or_else(|| panic!("{w}x{h} 该给出计划"));
            assert!(
                plan.middle.width > 0 && plan.middle.height > 0,
                "{w}x{h}: 中间态不许撞 0"
            );
            assert_ne!(
                plan.middle, plan.target,
                "{w}x{h}: 两拍必须真的不同，否则 WebView2 不会重算布局"
            );
            assert_eq!(plan.target, size(w, h), "{w}x{h}: 第二拍必须回到真实尺寸");
            assert_eq!(
                plan.step,
                RestoreStep::Resize,
                "{w}x{h}: 普通窗口走尺寸微调"
            );
        }

        assert!(
            nudge_plan(size(0, 0), false).is_none(),
            "已经塌陷的尺寸不该给出计划（否则会写出 2x2 这种假中间态）"
        );
        assert!(nudge_plan(size(0, 840), false).is_none());
        assert!(nudge_plan(size(1280, 0), false).is_none());
        assert!(
            nudge_plan(size(0, 0), true).is_none(),
            "最大化分支同样不许拿塌陷尺寸当目标"
        );
    }

    /// 偏移量契约：尺寸大于 1px 时**恰好**偏 1px（大跳会被人眼看见，也会破坏窗口几何）。
    #[test]
    fn nudge_offset_is_exactly_one_pixel() {
        for (w, h) in [(2, 2), (1280, 840), (3840, 2160)] {
            let plan = nudge_plan(size(w, h), false).expect("大尺寸必须可微调");
            assert_eq!(
                (plan.target.width as i64 - plan.middle.width as i64).abs(),
                1,
                "{w}x{h}: 宽度必须恰好偏 1px"
            );
            assert_eq!(
                (plan.target.height as i64 - plan.middle.height as i64).abs(),
                1,
                "{w}x{h}: 高度必须恰好偏 1px"
            );
        }
    }

    /// 最大化窗口走「收窗 → 再最大化」，绝不缩 1px（缩了会把还原矩形写坏、还会掉出最大化态）。
    #[test]
    fn maximized_window_rezooms_instead_of_resizing() {
        let plan = nudge_plan(size(2560, 1400), true).expect("最大化窗口也要修");
        assert_eq!(plan.step, RestoreStep::Rezoom);
        assert_eq!(plan.middle, plan.target, "收窗那拍不改尺寸，改的是最大化态");
        assert_eq!(plan.target, size(2560, 1400));
    }

    /// 小尺寸（1/2px）往内偏，其余往外偏：两种都躲开 0。
    #[test]
    fn nudge_offset_avoids_zero_from_both_sides() {
        assert_eq!(nudge_offset(0), 2);
        assert_eq!(nudge_offset(1), 3);
        assert_eq!(nudge_offset(2), 1);
        assert_eq!(nudge_offset(1280), 1279);
    }

    /// 最大化窗口最小化 → 还原：还原报告的是最大化尺寸（与最小化前不同），仍要修一次。
    #[test]
    fn restore_into_maximized_size_still_nudges() {
        let sm = RestoreNudge::default();
        assert_eq!(
            sm.observe_resized(size(0, 0), true),
            Transition::Idle,
            "最小化本身不触发"
        );
        assert_eq!(
            sm.observe_resized(size(2560, 1400), false),
            Transition::Nudge,
            "还原到最大化尺寸也要修"
        );
    }

    /// 同一尺寸重复上报（tao 也会转发「尺寸未变」的事件）不该再触发。
    #[test]
    fn repeated_same_size_is_a_noop() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(1280, 840), false), Transition::Idle);
        assert_eq!(sm.observe_resized(size(1280, 840), false), Transition::Idle);
    }

    /// 平台门：非 Windows 一律不微调（那些平台没有这个上游 bug，不引入新变量）。
    #[test]
    fn nudge_is_gated_to_windows() {
        if cfg!(target_os = "windows") {
            assert!(windows_only());
        } else {
            assert!(!windows_only(), "非 Windows 不该开这个 workaround");
        }
    }

    #[test]
    fn flags_clean_after_full_cycle() {
        let sm = RestoreNudge::default();
        assert_eq!(sm.observe_resized(size(0, 0), true), Transition::Idle);
        assert_eq!(
            sm.observe_resized(size(1280, 840), false),
            Transition::Nudge
        );
        sm.release_inflight();
        assert_eq!(
            sm.raw(),
            0,
            "一整轮（进最小化 → 还原 → 微调落地）之后不该残留标记"
        );
    }
}
