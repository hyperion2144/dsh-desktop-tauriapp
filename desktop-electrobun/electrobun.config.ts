import type { ElectrobunConfig } from 'electrobun'
import { APP_NAME } from './src/shared/app.ts'
import { DEFAULT_UPDATE_BASE_URL } from './src/shared/update.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoDir = resolve(import.meta.dir, '..')

/** 递归列文件（返回相对给定目录的 POSIX 相对路径；目录不存在就空数组）。 */
function listFiles(root: string, rel = ''): string[] {
  const abs = rel === '' ? root : join(root, rel)
  if (!existsSync(abs)) return []
  const out: string[] = []
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(root, child))
    else out.push(child)
  }
  return out
}

/**
 * 把仓内的插件包摊成 `build.copy` 映射（源 → 包内 `plugins/<name>/…`）。
 *
 * 为什么要逐文件列、并且只列真的存在的：
 *   · 打包态的壳插件必须住在 `Contents/Resources/app/plugins/<name>/`，否则 runtime.ts 的
 *     `packagedResources()` 返回 null，`stagePlugins()` 找不到包 —— 界面上就是「装了新包但桌面插件
 *     没注入、各项设置全空」（维护者实机报的）；
 *   · Electrobun 的 copy 没有「源缺就跳过」，写死一个不存在的路径就 `CopySourceMissing`
 *     直接构建失败（Windows/Linux CI 上踩过）；
 *   · `mobile/dsh-mobile-nav` 是子模块，本地常常是空的。
 */
function pluginCopy(sourceDir: string, packageName: string, files: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const rel of files) {
    const source = join(sourceDir, rel)
    if (existsSync(source)) map[source] = `plugins/${packageName}/${rel}`
  }
  return map
}

const desktopPluginDir = repoDir
const desktopPluginFiles = ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'LICENSE', ...listFiles(repoDir, 'lib')]
const mobileAccessDir = join(repoDir, 'mobile', 'dsh-mobile-access')
const mobileAccessFiles = ['package.json', 'cordis.patch.yml', ...listFiles(mobileAccessDir, 'lib'), ...listFiles(mobileAccessDir, 'client')]

export default {
  app: {
    name: APP_NAME,
    identifier: 'com.hyperion.dsh-desktop-bun',
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
    win: { bundleCEF: true, defaultRenderer: 'cef', icon: 'resources/app-icon.ico' },
    // 包内资源：宿主脚本（Bun 跑 dsh 的等价物）与 Bun 兼容层（由 scripts/prepare-bundle.mjs
    // 从仓内单一来源物化到 runtime/）。落地位置＝<app>/Contents/Resources/app/<dest>，
    // 与 runtime.ts 的 packagedRoot() 约定一致。
    copy: {
      'runtime/dsh-host.mjs': 'runtime/dsh-host.mjs',
      'runtime/parent-watch.mjs': 'runtime/parent-watch.mjs',
      'runtime/bun-preload.mjs': 'runtime/bun-preload.mjs',
      // 托盘图标：prepare:bundle 把旧的 32x32.png 拷到 resources/tray.png，再落进包内 runtime/
      'resources/tray.png': 'runtime/tray.png',
      // Windows 托盘：shell tray 用 .ico（win32 原生格式），资源同上链路
      'resources/tray.ico': 'runtime/tray.ico',
      // macOS 通知桥（旧壳 notify_un.rs 的等价物）：dylib 由 `bun run build:native` 编出来，
      // 先编后打（见 package.json 的 build 链），装完才有真授权状态与真投递。
      // 只在 darwin 上声明：Linux/Windows 上根本没这个产物，写死会让 `hutch electrobun build`
      // 报 `error: CopySourceMissing`（Electrobun 的 copy 不会「源缺就跳过」）。
      ...(process.platform === 'darwin'
        ? { 'native/libdsh-notify.dylib': 'runtime/libdsh-notify.dylib' }
        : {}),
      // 壳插件与手机访问插件：装到 `<app>/Contents/Resources/app/plugins/`，运行时再挂进 profile 池。
      ...pluginCopy(desktopPluginDir, 'dsh-desktop-tauriapp', desktopPluginFiles),
      ...pluginCopy(mobileAccessDir, 'dsh-mobile-access', mobileAccessFiles),
      // 内置 dsh 运行时（随包发出，item 1）：prepare:bundle 把一棵可用的运行时树物化到
      // builtin-runtime/（来源：仓内 Tauri 树 / 已下载运行时 / DSH_SHELL_BUILTIN_SOURCE）。
      // 只在真的物化成功时声明：Electrobun 的 copy 不会「源缺就跳过」，写死会 CopySourceMissing。
      ...(existsSync(join(import.meta.dir, 'builtin-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
        ? { 'builtin-runtime': 'dsh' }
        : {}),
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
