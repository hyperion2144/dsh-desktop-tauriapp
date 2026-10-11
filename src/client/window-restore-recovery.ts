/**
 * 窗口「最小化 → 还原」后的页面侧重排钩子（#161）。
 *
 * 背景：Windows 上把桌面窗口最小化再还原，WebView2 的合成面会丢掉一整帧——页面看起来
 * 整片黑屏，只剩 `position:fixed` 的注入 chrome（「运行中」状态条 + 自绘窗口按钮）还在。
 * Rust 侧的修法见 `desktop/src-tauri/src/ui/window_recovery.rs`（还原那一刻做一次两拍尺寸
 * 微调，逼宿主与 WebView2 重算布局/重绘）；本模块是页面侧的配合：
 *
 * 1. 还原那一刻把「按视口尺寸写内联样式」的 chrome 重算一遍（`local-chrome` 的 sync）——
 *    黑屏期间若窗口尺寸变了（还原到最大化、或换过 DPI），旧内联值就是错的，光重绘也还是错的位置。
 * 2. 给壳留一个确定性入口：`window.__dshShellRestoreImpl.restore(reason)`。注意 Rust 侧目前
 *    **不**调它——本票的修法在壳侧（尺寸微调逼 WebView2 重绘），页面侧只需要上面那条重排；
 *    这个入口是为「将来要做更重的动作（强制重挂载）」和外部调试准备的，装了就一直有效。
 *
 * 触发源（三路互相兜底，任一成立即算一次「回到可见」）：
 * - `visibilitychange`：页面从 hidden 变回 visible（浏览器语义下的还原）；
 * - `focus`：窗口在失去焦点期间被隐藏过，回来时即使 visibility 没变也算（WebView2 在
 *   最小化时不一定发 visibilitychange，这是本票的关键不确定性）；
 * - `pageshow`：从 bfcache 恢复（`event.persisted === true`；首次加载不算「还原」）。
 *
 * 纯决定逻辑（[`restoreReasons`]）与 DOM 副作用分离：判定可以单测钉死，接线只在真窗口里跑。
 */

/** 处于 hidden 状态时记下的「欠账」原因，回到可见时按它决定要不要重排。 */
const HIDDEN_REASON: RestoreReason = 'visibility-restore'

/**
 * 还原原因集合（位掩码，可组合）：
 * - `visibility-restore`：由 `visibilitychange` 触发（页面自己从 hidden 回来）；
 * - `focus-recovery`：由 `focus` 触发，且失去焦点期间页面确曾 hidden（错过 visibilitychange 的兜底）；
 * - `page-show`：由 `pageshow` 触发（bfcache/重导航）；
 * - `shell-command`：外部经 `__dshShellRestoreImpl` 显式要求（壳侧当前不调，留给调试与后续扩展）。
 */
export type RestoreReason =
  | 'visibility-restore'
  | 'focus-recovery'
  | 'page-show'
  | 'shell-command'

/** 页面状态的最小投影：判定只看这三项，不依赖真 DOM。 */
export interface RestoreSignalState {
  /** `document.visibilityState === 'visible'`。 */
  visible: boolean
  /** `document.hasFocus()`：本次事件到达时页面是否拿到焦点。 */
  focused: boolean
  /** 焦点到达前页面是否处于 hidden（`visibilitychange` 漏发时的兜底依据）。 */
  hiddenWhileBlurred: boolean
}

/** 一次重排请求。 */
export interface RestoreRequest {
  reason: RestoreReason
  /** 本次请求由哪几路信号同时印证（`shell-command` 走壳自己那一拍）。 */
  signals: RestoreReason[]
}

/** 重排订阅者：做实际的重排动作，返回值忽略。 */
export type RestoreHandler = (request: RestoreRequest) => void

/**
 * 已订阅的重排动作（`local-chrome` 的 sync 等）。
 *
 * 挂在 window 上而不是模块作用域：`lib/client.js` 被 esbuild 重打包后（HMR / 壳重载插件），
 * 模块会被重新求值——若表在工作区里，旧订阅者留在一份没人驱动的数组里（静默失效 + 泄漏），
 * 新订阅者又进了另一份。挂 window 让重装后的新代码接着驱动同一份表。
 */
/** 无 window（纯 node 单测）时的兜底表：行为与浏览器一致，只是不跨重装存活。 */
const nodeHandlers: RestoreHandler[] = []

function handlerTable(): RestoreHandler[] {
  const w = typeof window === 'undefined' ? undefined : (window as unknown as RestoreWindow)
  if (!w) return nodeHandlers
  if (!w.__dshShellRestoreHandlers) w.__dshShellRestoreHandlers = []
  return w.__dshShellRestoreHandlers
}

/**
 * 判定一次事件要不要触发重排。纯函数：不给信号 → 不给理由，绝不在隐藏期间做无谓重排。
 * @param signals - 本次事件可用的信号。
 */
export function restoreReasons(signals: RestoreSignalState): RestoreReason[] {
  if (!signals.visible) return []
  const reasons: RestoreReason[] = [HIDDEN_REASON]
  if (signals.focused && signals.hiddenWhileBlurred) reasons.push('focus-recovery')
  return reasons
}

/**
 * 订阅一次重排动作（幂等按引用去重，重复订阅同一个函数只留一份）。
 * @param handler - 订阅者。
 * @returns 退订函数（HMR/停用后干净移除，不留悬挂回调）。
 */
export function onWindowRestore(handler: RestoreHandler): () => void {
  const table = handlerTable()
  if (!table.includes(handler)) table.push(handler)
  return () => {
    const index = table.indexOf(handler)
    if (index >= 0) table.splice(index, 1)
  }
}

/**
 * 依次调用所有订阅者，返回是否至少有一个订阅者真正跑过。
 *
 * 单个订阅者抛错不许连坐：后面的订阅者（可能是唯一的重排者）仍要跑完。
 * @param request - 重排请求。
 */
export function runRestoreHandlers(request: RestoreRequest): boolean {
  let ran = false
  for (const handler of [...handlerTable()]) {
    try {
      handler(request)
      ran = true
    } catch {
      /* 一个订阅者出错不影响其余重排；它也不算「跑过」 */
    }
  }
  return ran
}

/** 壳侧调用形状（与 `desktop-browser-bridge` 的 `__dshShellBridgeImpl` 同风格）。 */
export interface DesktopRestoreBridgeImpl {
  /** 壳要求页面重排一次；返回是否真的做了（无订阅者时 false，便于壳侧日志）。 */
  restore: (reason?: string) => boolean
}

interface RestoreWindow {
  __dshShellRestoreImpl?: DesktopRestoreBridgeImpl
  __dshShellRestoreInstalled?: boolean
  __dshShellRestoreHandlers?: RestoreHandler[]
}

/** 全局入口名：壳（Rust/webview init script）可以按这个键找页面侧的还原钩子。 */
const BRIDGE_GLOBAL = '__dshShellRestoreImpl'

/**
 * 安装还原钩子（重复调用幂等；纯浏览器里没有窗口事件也安全）。
 *
 * 副作用只有三处：装三个窗口监听、把 `window.__dshShellRestoreImpl` 挂上、在还原时
 * 顺序调用已订阅的 handler。**不**主动刷新页面、不重新导航——重绘由 Rust 侧的尺寸微调负责，
 * 页面侧只保证 chrome 的内联几何与当前视口一致。
 */
export function installWindowRestoreRecovery(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as RestoreWindow
  if (w.__dshShellRestoreInstalled === true) return
  w.__dshShellRestoreInstalled = true

  // 焦点到达前页面是否 hidden：focus 兜底路径唯一的依据，仅在 blur 时置位、判定后清除。
  let hiddenWhileBlurred = false
  const hidden = (): boolean => document.visibilityState === 'hidden'

  const announce = (reason: RestoreReason): void => {
    const signals = restoreReasons({
      visible: !hidden(),
      focused: document.hasFocus(),
      hiddenWhileBlurred,
    })
    if (signals.length === 0) return
    if (reason === 'shell-command' && !signals.includes(reason)) signals.unshift(reason)
    hiddenWhileBlurred = false
    runRestoreHandlers({ reason, signals })
  }

  document.addEventListener('visibilitychange', () => {
    if (hidden()) {
      // 记下欠账：还原时即便 visibilitychange 只来一次、focus 先到，也认得出「刚从隐藏回来」。
      hiddenWhileBlurred = true
      return
    }
    announce('visibility-restore')
  })

  window.addEventListener('blur', () => {
    if (hidden()) hiddenWhileBlurred = true
  })

  window.addEventListener('focus', () => {
    if (!document.hasFocus()) return
    // 页面自己没发 visibilitychange 时的兜底：焦点回来 + 曾隐藏 ⇒ 已经回到可见。
    if (hidden()) return
    if (!hiddenWhileBlurred) return
    hiddenWhileBlurred = false
    runRestoreHandlers({ reason: 'focus-recovery', signals: ['visibility-restore', 'focus-recovery'] })
  })

  window.addEventListener('pageshow', (event) => {
    // 只有 bfcache 恢复才算「回到可见」；首次加载/普通重导航不触发（否则白白重排一次）。
    if (!event.persisted) return
    if (hidden()) return
    hiddenWhileBlurred = false
    runRestoreHandlers({ reason: 'page-show', signals: ['page-show'] })
  })

  // 已有实现（旧 bundle 装的那份 / 别的插件装的）不覆盖：挂上我们的，同时把调用委托过去。
  const previous = w[BRIDGE_GLOBAL]?.restore
  w[BRIDGE_GLOBAL] = {
    restore: (reason?: string): boolean => {
      const picked: RestoreReason =
        reason === 'focus-recovery' || reason === 'page-show'
          ? reason
          : 'shell-command'
      const signals = restoreReasons({
        visible: !hidden(),
        focused: document.hasFocus(),
        hiddenWhileBlurred,
      })
      const delegated = typeof previous === 'function' ? previous(reason) : false
      if (signals.length === 0) return delegated
      if (!signals.includes(picked)) signals.unshift(picked)
      hiddenWhileBlurred = false
      return runRestoreHandlers({ reason: picked, signals }) || delegated
    },
  }
}

/** 仅供测试/诊断：当前订阅者数量。 */
export function restoreHandlerCount(): number {
  return handlerTable().length
}
