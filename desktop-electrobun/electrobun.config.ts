import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'DeepSeek Harness Desktop',
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
  },
} satisfies ElectrobunConfig
