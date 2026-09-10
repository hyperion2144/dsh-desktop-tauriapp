/**
 * 高级模式局部 chrome 样式（最小自包含）：
 * - body 标记：识别桌面高级模式；
 * - fixed host：覆盖视口、pointer-events 全关，只有条带子元素局部开；
 * - 自绘 caption 条与窗口按钮。
 */
const ADVANCED_STYLES = `
body[data-dsh-desktop-tauriapp-mode="advanced"] { margin: 0; }
.dshDesktopChromeHost { position: fixed; inset: 0; z-index: 45; pointer-events: none; }
.dshDesktopChromeStrip { position: absolute; display: flex; align-items: stretch; pointer-events: auto; }
/* 拖拽条背景：按平台匹配所覆盖区域的主题背景（macOS 覆盖侧边栏、Win/Linux 覆盖中间区）。
   对齐 better-sidebar 做法：注入元素显式设 --dsw-alias-bg-* / --dsw-specific-* 而非透明依赖底层透出。 */
body[data-dsh-desktop-platform="darwin"] .dshDesktopChromeStrip { background: var(--dsw-specific-sidebar-fill); }
body[data-dsh-desktop-platform="win32"] .dshDesktopChromeStrip,
body[data-dsh-desktop-platform="linux"] .dshDesktopChromeStrip { background: var(--dsw-alias-bg-base); }
/* macOS 折叠加宽区两侧装饰条（local-chrome 折叠时定位在顶部条与状态条之间）：
   与顶部条/状态条同一层主题填充，保证整条轨道叠加层数一致（皮肤为半透明叠加主题，见 #37）。
   display:none 兼作展开态默认；折叠态由内联样式显式 display:block 打开。 */
.dshDesktopRailPad { position: absolute; display: none; background: var(--dsw-specific-sidebar-fill); pointer-events: none; }
.dshDesktopChromeDrag { user-select: none; }
.dshDesktopStatusBar { position: absolute; background: var(--dsw-specific-sidebar-fill); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary, currentColor); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); pointer-events: auto; user-select: none; }
.dshDesktopStatusDot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
/* 设置弹窗左侧 tab 列可滚动（dsh 上游 navList 无 overflow，tab 多了被截断）：
   用弹窗稳定标记定位，不依赖 hash 类名。 */
[role="dialog"][aria-modal="true"] nav { min-height: 0; overflow: hidden; }
[role="dialog"][aria-modal="true"] nav > div:last-child { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.dshDesktopWindowControls { position: absolute; top: 0; right: 0; height: 100%; display: flex; align-items: stretch; }
.dshDesktopCaptionButton { width: 46px; border: none; margin: 0; padding: 0; background: transparent; color: var(--dsw-alias-label-primary, currentColor); display: grid; place-items: center; cursor: default; }
.dshDesktopCaptionButton:hover { background: rgba(128, 128, 128, 0.18); }
.dshDesktopCaptionButton-close:hover { background: #e81123; color: #fff; }
.dshDesktopCaptionButton svg { width: 12px; height: 12px; display: block; }
/* 侧边栏内容区滚动（local-chrome.ts ensureSidebarScroll 打稳定标记；内联 overflow
   已覆盖 stock 的 hidden，这里只做滚动条观感与滚动链收敛）。 */
[data-dsh-desktop-scroll] { overscroll-behavior: contain; scrollbar-width: thin; }
[data-dsh-desktop-scroll]::-webkit-scrollbar { width: 8px; height: 8px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,0.4)); border-radius: 4px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(128,128,128,0.6)); }
`

/** Install and remove the advanced shell's local-window-chrome styles. @returns the style disposer. */
export function installAdvancedStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-desktop-tauriapp'
  style.dataset.pluginCss = 'dsh-desktop-tauriapp/local-chrome'
  style.textContent = ADVANCED_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
