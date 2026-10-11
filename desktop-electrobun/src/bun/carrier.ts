// `globalThis.dshDesktop` 载体标记（旧壳 `desktop_carrier_init_script` 的等价物）。
//
// 为什么必须有：dsh 前端的浏览器 guest 桥（`src/client/desktop-browser-bridge.ts`）只在
// `globalThis.dshDesktop` 存在时安装 `__dshShellBridgeImpl`；没有它，侧边栏浏览器会退回 iframe
// 模式（在自带前端的壳里没有宿主页面可嵌，永远停在「正在打开…」）。
//
// 时序：本脚本 document-start 跑（preload），`__dshShellBridgeImpl` / `__dshShellKeyboardImpl`
// 由 client 插件稍后安装 ⇒ 方法体**惰性转发 + 轮询等待**，与旧壳同一套做法（轮询 4s / 30s 超时
// 干净报错，页面不炸）。
//
// 与旧壳的差异：旧壳要按 origin 判定「是不是壳内页面」（`dshapp://localhost` / loopback）；
// 我们的页面 origin 就是壳自己的 loopback，preload 也只会进壳内窗口，所以不再需要判定——
// 但仍然只在没有 dshDesktop 时装一次（远程窗口不装，见 #220 决策 5）。

export type CarrierPlatform = 'darwin' | 'win32' | 'linux'

/** 键盘/快捷键桥的等待上限（旧壳 30s：实现由 client 插件装载，可能晚于服务构造）。 */
export const CARRIER_BRIDGE_WAIT_MS = 4_000
export const CARRIER_KEYBOARD_WAIT_MS = 30_000

/**
 * 生成载体脚本（纯字符串，随 preload 一起进页面；不用模块作用域——preload 是一段内联 JS）。
 */
export function carrierScript(platform: CarrierPlatform): string {
  return `;(() => {
  if (globalThis.dshDesktop) return
  const PLATFORM = ${JSON.stringify(platform)}
  const BRIDGE_WAIT = ${CARRIER_BRIDGE_WAIT_MS}
  const KEYBOARD_WAIT = ${CARRIER_KEYBOARD_WAIT_MS}
  const bridge = () => globalThis.__dshShellBridgeImpl
  const keyboard = () => globalThis.__dshShellKeyboardImpl
  const when = (get, waitMs, what) => new Promise((resolve, reject) => {
    let waited = 0
    const tick = () => {
      const impl = get()
      if (impl) { resolve(impl); return }
      if (waited >= waitMs) { reject(new Error(what + '-not-ready')); return }
      waited += 100
      setTimeout(tick, 100)
    }
    tick()
  })
  const forward = (method) => function () {
    const args = Array.prototype.slice.call(arguments)
    return when(keyboard, KEYBOARD_WAIT, 'keyboard-bridge').then((impl) => impl[method].apply(impl, args))
  }
  const forwardSubscribe = (method, listener) => {
    let off = null
    let cancelled = false
    when(keyboard, KEYBOARD_WAIT, 'keyboard-bridge').then((impl) => {
      if (cancelled) return
      off = impl[method](listener)
    }).catch(() => {})
    return () => {
      cancelled = true
      if (typeof off === 'function') off()
    }
  }
  const browserForward = (method) => function (arg) {
    return when(bridge, BRIDGE_WAIT, 'bridge').then((impl) => impl[method](arg))
  }
  globalThis.dshDesktop = {
    protocolVersion: 1,
    browser: {
      acquire: browserForward('acquire'),
      release: browserForward('release'),
      onOpenRequested: (lease, listener) => {
        const impl = bridge()
        return impl ? impl.onOpenRequested(lease, listener) : () => {}
      },
    },
    keyboard: {
      subscribe: (listener) => forwardSubscribe('subscribeInput', listener),
      closeWindow: forward('closeWindow'),
    },
    shortcuts: {
      get: forward('get'),
      edit: forward('edit'),
      subscribe: (listener) => forwardSubscribe('subscribeConfig', listener),
      recording: forward('recording'),
    },
  }
  // 平台标记：dsh 读它决定桌面档（document-start 时 documentElement 可能还没建好，重试一次）
  const markPlatform = () => {
    if (!document.documentElement) { setTimeout(markPlatform, 0); return }
    document.documentElement.dataset.platform = PLATFORM
  }
  markPlatform()
})()`
}
