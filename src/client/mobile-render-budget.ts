// 移动端渲染预算（#147 路线 B）：**只在本仓实现**，不改 dsh-mobile-nav 子模块。
//
// 背景：宿主前端在会话渲染时整段挂载 + 逐块 Shiki 高亮（审计见 dsh-mobile-nav 的
// docs/audits/2026-09-23-session-switch-jank-handover.md），手机主线程被长任务占满，
// 键盘回声排在后面 → 「打个字半天才反应」。
//
// 这里不动宿主 JS（碰不到 Shiki 的调用点），只做**视觉窗口化**：找到会话滚动容器，给它
// 的直接子元素加 `content-visibility: auto` + `contain-intrinsic-size`，让屏幕外的块
// 跳过布局与绘制。命中不了容器就整体 no-op——宁可零收益，不可乱改 DOM。
//
// 作用面：本模块随根 client 插件分发，凡是加载了本插件的 dsh 页面都生效（手机经 lane 或
// 直连都在内），与布局插件无关；仅在移动断点 + 触摸指针下安装。

/** 打给滚动容器的标记（跨模块契约；勿改）。 */
const MARK = 'data-dsh-desktop-mobile-budget'
/** 注入样式表的 id（幂等）。 */
const STYLE_ID = 'dsh-desktop-mobile-budget-style'
/** 与会话可达的移动断点一致：窄屏 + 触摸指针（鼠标驱动的窄窗口保持桌面行为）。 */
const MOBILE_QUERY = '(max-width: 1023px) and (pointer: coarse)'

const CSS = `[${MARK}="scroller"] > *{content-visibility:auto;contain-intrinsic-size:auto 320px;}`

/** 视口外的块按此估算高度（`auto` 关键字会在块渲染过后记住真实尺寸）。 */
const INTRINSIC_HINT = 'auto 320px'

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.setAttribute('data-plugin', 'dsh-desktop-tauriapp')
  style.textContent = CSS.replace('auto 320px', INTRINSIC_HINT)
  document.head.appendChild(style)
}

/**
 * 找会话滚动容器：可纵向滚动、占据视口大部分宽度、子元素足够多的那个。
 *
 * 用「最大可滚动区域」而不是猜类名/结构：宿主的 DOM 结构随版本漂移（哈希类名不可依赖），
 * 而「一个装了很多子元素的大滚动区」在任何一代都是会话正文。找不到就返回 null（no-op）。
 */
function findScroller(): Element | null {
  const candidates: Element[] = []
  const all = document.querySelectorAll('div, main, section')
  for (const el of Array.from(all)) {
    const style = getComputedStyle(el)
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = el.getBoundingClientRect()
    if (rect.width < window.innerWidth * 0.6) continue
    if (rect.height < 200) continue
    if (el.scrollHeight <= el.clientHeight + 120) continue
    if (el.childElementCount < 2) continue
    candidates.push(el)
  }
  if (candidates.length === 0) return null
  // 取面积最大的那个（会话正文；抽屉/侧栏更窄或更矮，已被上面的宽度门槛滤掉大半）
  candidates.sort((a, b) => {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return rb.width * rb.height - ra.width * ra.height
  })
  return candidates[0] ?? null
}

/**
 * 当前是否应该做视觉窗口化。
 *
 * 移动断点（窄屏 + 触摸）恒开；**桌面也开**——依据 2026-09-29 的实机证据：页面 WebContent
 * 常驻 1.2 GB，被系统回收后新进程启动时 JSC 在 async-iterator 上 SIGSEGV（详见 CHANGELOG 与
 * `~/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent-*.ips`），表现为“白屏 + 自动刷新”。
 * 桌面开关由壳下发（设置项 `desktop_render_budget`，缺省开；关掉则退回只对移动断点生效）。
 */
// 缺省**开**：这个 client 只随桌面壳加载（移动端有自己的包），而它修的是实机崩溃——
// 页面 WebContent 常驻 1.2 GB → 被系统回收 → 新进程启动时 JSC 在 async-iterator 上 SIGSEGV
// （表现为“白屏 + 自动刷新”）。关掉可用 setRenderBudgetForDesktop(false)（设置项接线在后续批次）。
let desktopAllowed = true


/** 壳下发开关后重新判定，并触发一次已安装实例的重算。 */
export function setRenderBudgetForDesktop(allowed: boolean): boolean {
  desktopAllowed = allowed

  return allowed
}


function isMobile(): boolean {
  return desktopAllowed || (typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches)
}
/**
 * 安装视觉窗口化。幂等；在窗口尺寸/输入方式变化时自动装卸。
 *
 * @returns 卸载函数（移除标记、样式与监听器）
 */

export function installMobileRenderBudget(): () => void {
  let applied: Element | null = null
  const timers: number[] = []

  const detach = (): void => {
    if (applied !== null) {
      applied.removeAttribute(MARK)
      applied = null
    }
    document.getElementById(STYLE_ID)?.remove()
  }

  const evaluate = (): void => {
    if (!isMobile()) {
      detach()
      return
    }
    const scroller = findScroller()
    if (scroller === null) return
    if (applied !== null && applied !== scroller) applied.removeAttribute(MARK)
    injectStyle()
    scroller.setAttribute(MARK, 'scroller')
    applied = scroller
  }

  // 首屏 + 页面晚挂载（dsh 是 SPA，会话容器可能在 boot 后才出现）分几拍评估
  evaluate()
  for (const delay of [1000, 3000, 6000]) {
    timers.push(window.setTimeout(evaluate, delay))
  }

  const onResize = (): void => evaluate()
  window.addEventListener('resize', onResize)
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null
  mq?.addEventListener?.('change', evaluate)

  return () => {
    for (const t of timers) window.clearTimeout(t)
    window.removeEventListener('resize', onResize)
    mq?.removeEventListener?.('change', evaluate)
    detach()
  }
}
