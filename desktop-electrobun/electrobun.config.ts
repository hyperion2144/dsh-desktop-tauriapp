import type { ElectrobunConfig } from 'electrobun'
import { APP_NAME } from './src/shared/app.ts'
import { DEFAULT_UPDATE_BASE_URL } from './src/shared/update.ts'

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
      // macOS 通知桥（旧壳 notify_un.rs 的等价物）：dylib 由 `bun run build:native` 编出来，
      // 先编后打（见 package.json 的 build 链），装完才有真授权状态与真投递
      'native/libdsh-notify.dylib': 'runtime/libdsh-notify.dylib',
    },
    // 关窗不退出：托盘在的时候，关掉最后一个窗口只是隐藏（与旧 Tauri 壳同行为）。
    // 没有托盘时（Linux 某些桌面环境）隐藏后就再也叫不回来了，所以 index.ts
    // 会在没有托盘时把「关窗」当成真退出处理。
    runtime: { exitOnLastWindowClosed: false },
  },
  // 应用更新（#220 决策 11）：Electrobun 按 `<baseUrl>/<buildEnvironment>-<os>-<arch>-update.json`
  // 取清单，再按「补丁链优先、失败回落整包」换掉整个 `.app`。这里指到 GitHub Releases
  // 的 `latest/download` 别名（资产名稳定指向最新一版）。
  // 注意：`release` 是**顶层**字段（ElectrobunConfig.ts:642），不是 `build` 的子项——
  // 放错层会被静默忽略（实测构建日志会打 “no release.baseUrl configured; skipping delta patch”）。
  release: {
    baseUrl: DEFAULT_UPDATE_BASE_URL,
    // 我们还没发过 Electrobun 版，补丁链没有可比对的上一版 ⇒ 先关掉补丁生成，只出整包
    generatePatch: false,
  },
} satisfies ElectrobunConfig
