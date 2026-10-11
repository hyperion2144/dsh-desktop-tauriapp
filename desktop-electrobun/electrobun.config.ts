import type { ElectrobunConfig } from 'electrobun'
import { APP_NAME } from './src/shared/app.ts'

export default {
  app: {
    name: APP_NAME,
    identifier: 'com.arcreel.dsh-desktop-tauriapp',
    version: '0.1.0',
  },
  build: {
    // 规格第 1 条：stable 2.0.2 默认主进程运行时是 cottontail，必须显式选 bun
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    // 渲染一律不用系统 webview：三处开关（构建期打 CEF、默认渲染器、每窗口请求）
    // 这里落前两处，第三处在 src/bun/index.ts 建窗时显式 renderer: 'cef'，
    // 并在启动时断言 BuildConfig.availableRenderers 含 cef（否则静默回落 WKWebView）。
    mac: { bundleCEF: true, defaultRenderer: 'cef' },
    linux: { bundleCEF: true, defaultRenderer: 'cef' },
    win: { bundleCEF: true, defaultRenderer: 'cef' },
    // 包内资源：宿主脚本（Bun 跑 dsh 的等价物）与 Bun 兼容层（由 scripts/prepare-bundle.mjs
    // 从仓内单一来源物化到 runtime/）。落地位置＝<app>/Contents/Resources/app/<dest>，
    // 与 runtime.ts 的 packagedRoot() 约定一致。
    copy: {
      'runtime/dsh-host.mjs': 'runtime/dsh-host.mjs',
      'runtime/parent-watch.mjs': 'runtime/parent-watch.mjs',
      'runtime/bun-preload.mjs': 'runtime/bun-preload.mjs',
      // 托盘图标：prepare:bundle 把旧的 32x32.png 拷到 resources/tray.png，再落进包内 runtime/
      'resources/tray.png': 'runtime/tray.png',
    },
    // 关窗不退出：托盘在的时候，关掉最后一个窗口只是隐藏（与旧 Tauri 壳同行为）。
    // 没有托盘时（Linux 某些桌面环境）隐藏后就再也叫不回来了，所以 index.ts
    // 会在没有托盘时把「关窗」当成真退出处理。
    runtime: { exitOnLastWindowClosed: false },
  },
} satisfies ElectrobunConfig
