// 骨架期的窗口 chrome：只做旧桌面壳里最必要的一件事——给 macOS 的红绿灯让出顶部空间。
//
// 背景：Electrobun 用 `titleBarStyle: 'hiddenInset'` 时，原生红绿灯叠在页面左上角（本机实测
// 约 y=13..27），而 dsh 侧栏的品牌行从 y≈24 开始画 ⇒ 两者贴在一起。旧壳的做法是在侧栏顶部
// 留一条自绘拖拽区（`src/client/local-chrome.ts` 的 `STRIP_HEIGHT.darwin = 28px`，侧栏加
// `padding-top` 让位）。
//
// 这里先用 preload 注入的等价最小形态；等桌面客户端插件（local-chrome / 状态条那一套）移植
// 过来之后撤掉，换成与旧壳同一份实现。约定：
//   - 侧栏列通过 ui-layout 的稳定标记定位：`[data-shell-overlay]` 的父元素（frame）的第一个
//     子元素；找到后打 `data-dsh-shell-sidebar`，让位用 CSS 规则而不是内联样式（React 重渲染
//     不会把样式冲掉）；
//   - body 上打 `data-dsh-desktop-platform`，与旧壳的 CSS 契约同名；
//   - 找不到就重试（rAF，最多 ~20 秒）；挂上/没挂上都写 console，不留无痕 no-op。

export type ShellPlatform = 'darwin' | 'win32' | 'linux'

/** 各平台顶部让位高度（CSS px），与旧壳 `STRIP_HEIGHT` 一致。 */
export const TOP_INSET: Record<ShellPlatform, number> = { darwin: 28, win32: 32, linux: 32 }

/** 样式表 id（诊断与卸载用）。 */
export const CHROME_STYLE_ID = 'dsh-desktop-shell-chrome'

/** 侧栏列的稳定标记（我们自己打的，位置见文件头注释）。 */
export const SIDEBAR_MARK = 'data-dsh-shell-sidebar'

/** 平台标记：旧壳 CSS 用的同名属性。 */
export const PLATFORM_MARK = 'data-dsh-desktop-platform'

/** 让位 + 平台标记的 CSS 文本。 */
export function chromeStyleText(platform: ShellPlatform): string {
  return [
    `body[${PLATFORM_MARK}="${platform}"] [${SIDEBAR_MARK}] { padding-top: ${TOP_INSET[platform]}px; }`,
    `[${SIDEBAR_MARK}] { transition: none; }`,
  ].join('\n')
}

/**
 * document-start 注入的 chrome 脚本（纯字符串，随 preload 一起进页面）。
 * 不能用模块作用域：preload 是一段内联 JS，页面里没有 bundler 的模块系统。
 */
export function chromeScript(platform: ShellPlatform): string {
  const inset = TOP_INSET[platform]
  return [
    ';(() => {',
    `  const PLATFORM = ${JSON.stringify(platform)}`,
    `  const STYLE_ID = ${JSON.stringify(CHROME_STYLE_ID)}`,
    `  const SIDEBAR_MARK = ${JSON.stringify(SIDEBAR_MARK)}`,
    `  const PLATFORM_MARK = ${JSON.stringify(PLATFORM_MARK)}`,
    `  const STYLE = ${JSON.stringify(chromeStyleText(platform))}`,
    `  const INSET = ${inset}`,
    '  const selector = "[" + SIDEBAR_MARK + "]"',
    '  let installed = false',
    '  const install = () => {',
    '    if (installed) return true',
    '    const layer = document.querySelector("[data-shell-overlay]")',
    '    const frame = layer && layer.parentElement',
    '    const sidebar = frame ? frame.firstElementChild : null',
    '    if (!sidebar || !document.body) return false',
    '    document.body.setAttribute(PLATFORM_MARK, PLATFORM)',
    '    sidebar.setAttribute(SIDEBAR_MARK, "")',
    '    if (!document.getElementById(STYLE_ID)) {',
    '      const style = document.createElement("style")',
    '      style.id = STYLE_ID',
    '      style.textContent = STYLE',
    '      document.head.appendChild(style)',
    '    }',
    '    installed = true',
    '    console.info("[chrome] 侧栏顶部让位 " + INSET + "px（" + PLATFORM + " 红绿灯区）")',
    '    return true',
    '  }',
    '  let tries = 0',
    '  const tick = () => {',
    '    if (install()) return',
    '    if (++tries < 1200) requestAnimationFrame(tick)',
    '    else console.warn("[chrome] 没找到 ui-layout 侧栏（" + tries + " 次尝试），顶部让位未生效")',
    '  }',
    '  const start = () => {',
    '    if (!install()) tick()',
    '    // React 重渲染可能换掉侧栏节点：标记掉了就重挂（节流到 rAF）',
    '    const observer = new MutationObserver(() => {',
    '      if (installed && !document.querySelector(selector)) { installed = false; requestAnimationFrame(install) }',
    '    })',
    '    observer.observe(document.body, { childList: true, subtree: true })',
    '  }',
    '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true })',
    '  else start()',
    '})()',
  ].join('\n')
}
