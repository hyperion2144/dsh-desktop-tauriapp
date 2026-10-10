# Electrobun 桌面壳能力面与限制（调研报告）

> 调研日期：2026-10-10（Asia/Shanghai）。全部结论来自官方仓库源码、仓库内文档源码（`docs/src/content/docs/`）与 GitHub API。
> 标注约定：**【文档明写】** = 官方文档原文；**【源码推断】** = 从 v2.0.3-beta.16 源码读出但文档未明写；**【未确认】** = 读不到，不推测。

---

## 0. 版本基线（必读）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 最新 release tag | **v2.0.3-beta.16**，发布于 **2026-10-10T05:12:00Z** | https://api.github.com/repos/blackboardsh/electrobun/releases |
| 对应 commit | `82eb27854c15b60a80d19ab33a329fbe8e269f12`，`Sat Oct 10 00:39:38 2026` | `git log -1` @ tag |
| 最近 stable release | **v2.0.2**，2026-09-29 | 同上 API |
| CEF 版本（pin，全平台同一版本） | **CEF `147.0.10+gd58e84d`** | https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/cef-version.ts#L4 |
| Chromium 版本 | **147.0.7727.118** | 同上 `#L5` |
| Bun 版本（pin） | **1.4.0** | https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/bun-version.ts#L2 |
| Cottontail 版本（pin） | **0.7.2-canary.6**（当前 beta 是 canary；stable 2.0.2 pin 的是 0.7.1） | `package/src/shared/cottontail-version.ts`；https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/docs/src/content/docs/electrobun/guides/changelog/v2-0-2.mdx |
| Rust / Go / Odin / Zig 工具链 pin | Rust **1.88.0**、Go **1.26.4**、Odin **dev-2026-07a**、Zig **0.17.0** | `package/src/shared/{rust,go,odin}-version.ts`；docs `guides/compatability.mdx` |
| Hutch 配对版本（当前 beta） | **0.28.0-canary.8**（build-time Cottontail 0.7.2-canary.6） | docs `guides/changelog/unreleased.mdx` |

**⚠️ 最重要的一条基线事实**：**当前 HEAD 是 2.0.3 beta 通道，不是 stable。** stable 是 2.0.2（2026-09-29）。所有"最新能力"（Bun 默认主进程、appdata://、Windows ARM64）都属于 2.0.3 beta 序列；stable 2.0.2 的默认主进程仍是 Cottontail（见 compatability.mdx：“Stable 2.0.2 defaults to Cottontail”）。

### 源码可复核性
本次调研在 `/tmp/eb` 做了 `git clone --depth 1 --branch v2.0.3-beta.16`，因此下文所有 `文件:行号` 引用均可在该 tag 上直接复核。仓库文档的公开渲染地址为 `https://framework.blackboard.sh/electrobun/`，其内容与仓库 `docs/src/content/docs/electrobun/` 同源——**引用文档时优先给仓库 raw 链接 + 行号**，比站点 URL 稳定可验证。

---

## 1. 主进程：运行时、版本 pin 方式、API 入口

### 1.1 六种主进程运行时（官方文档明写）

来源：`docs/src/content/docs/electrobun/apis/main.mdx`（"Electrobun exposes the same native core to **six main-process runtimes**: Bun (the default), Cottontail (experimental), Zig, Rust, Go, and Odin"）。

| 运行时 | 状态 | 代价 |
| --- | --- | --- |
| **Bun 1.4.0** | **默认**（2.0.3 beta 通道） | 无。Hutch 下载并打包固定版本 Bun。用户不装 Bun。 |
| **Cottontail 0.7.2-canary.6** | 实验性、需显式 `mainProcess: "cottontail"` | 启动更慢（见下方 benchmark）；标准库是**模块化能力包**，需构建期扫描 + 显式 `capabilities` 补充；`bytecode` 选项**声明了但未接线**（当前是 no-op）。 |
| Zig 0.17.0 | 支持 | 需项目自带 `build.zig`；窗口必须在 worker 线程创建、`runMainThread` 阻塞主线程。 |
| Rust 1.88.0 | 支持 | 需 `Cargo.toml` + binary target `main`；**无 typed RPC（只有裸 JSON bridge）、无 Updater API、无 Warren UI、无下载事件流**。 |
| Go 1.26.4 | 支持 | 同上限制；主 goroutine 在 init 阶段 pin 到 OS 主线程。 |
| Odin dev-2026-07a | 支持 | 同上限制；**Odin 不支持 Windows ARM64**（docs compatability.mdx 明写）。 |

来源：`docs/src/content/docs/electrobun/guides/native-main-process.mdx`、`apis/main.mdx` 的 runtime coverage 表。

### 1.2 版本 pin 方式（三层，且 v2 已收紧）

**【文档明写】** `docs/src/content/docs/electrobun/apis/cli/build-configuration.mdx`：
- `electrobun.config.ts` **不再**选 Electrobun 产品版本；产品版本 pin 移到 `hutch.config.ts` 的 `electrobun.version`（可选，精确版本如 `"2.0.3-beta.14"`）。
- `build.bunVersion` / `build.cefVersion` / `build.wgpuVersion` **在 v2 已删除**——`docs/guides/migrating-to-v2.mdx:115` 列出必须移除的字段。
- **【源码推断】** 强制执行点：`package/src/config/validate.ts:5` 的错误串 `"Per-project Bun runtime version selection is not supported. Electrobun ships one pinned Bun runtime version."`，以及 `assertNoLegacyBunVersionConfig()` 对 `build.bunVersion` / `build.bunnyBun` 直接抛错。

> **对迁移的含义**：Bun 版本不是你能选的。它由 Electrobun release 决定（现在 1.4.0），Hutch 下载并随 app 打包。**没有 `bundleBun: false` 这类选项**（issue #430「bundleBun: false」已 CLOSED，即该方向未采纳）。

### 1.3 主进程 API 入口

**【文档明写】** TypeScript 入口是 `electrobun/main`（运行时中立命名空间），`electrobun/bun` 是**已废弃别名**（`apis/bun.mdx`）。`electrobun/view` 是浏览器侧。
包导出面见 `package/package.json` 的 `exports` 字段：`./main`、`./main/browser-window`、`./main/tray`、`./main/rpc`、`./main/updater`、`./main/ui`、`./main/native`、`./main/paths`、`./view` 等，共约 17 个子路径。

核心符号（`package/src/sdks/main/index.ts`）：
```
BrowserWindow, BrowserView, GpuWindow, WGPUView, Tray,
ApplicationMenu, ContextMenu, Updater, Utils, PATHS, Socket,
BuildConfig, GlobalShortcut, Screen, Session, WGPUBridge, WGPU/webgpu,
createRPC, defineElectrobunRPC, bridge, hasFFI
```

**【文档明写】事件生命周期**（`apis/events.mdx`）：
- 应用级事件只有 5 个：`application-menu-clicked`、`context-menu-clicked`、`open-url`、`reopen`、`before-quit`（`package/src/sdks/main/events/ApplicationEvents.ts` 源码逐字对应）。
- 窗口事件：`close`、`will-close`、`resize`、`move`、`focus`、`blur`、`keyDown`、`keyUp`。
- webview 事件：`will-navigate`、`did-navigate`、`did-navigate-in-page`、`did-commit-navigation`、`dom-ready`、`new-window-open`、`host-message`、`download-started/-progress/-completed/-failed`。
- **⚠️ `before-quit` 不 await 返回的 Promise**（文档用 `caution` 明确警告：不要把 awaited cleanup 放在 await 之后指望它延迟 shutdown）。

**⚠️ 文档自相矛盾（重要）**：`build-configuration.mdx` 第 14 行写「Bun is the default `build.mainProcess`」，但同一文件第 159-160 行写「`build.mainProcess` selects the runtime and compiler. It defaults to `"cottontail"`」。**源码为准**：`package/src/config/ElectrobunConfig.ts:151` 写 `@default "bun"`，`kitchen/src/bun/index.ts:299` 写 `mainProcess: buildConfig.mainProcess ?? "bun"`。即：**beta = bun，stable 2.0.2 = cottontail**，文档未同步更新。

### 1.4 Bun vs Cottontail 启动性能（官方 benchmark）

来源：`docs/src/content/docs/electrobun/guides/changelog/v2-0-2.mdx`（macOS ARM64, M4 Max Virtual, 2026-09-29，中位数 ms，越低越好）：

| Benchmark | Cottontail 0.5.0 | Cottontail 0.7.1 | **Bun 1.4.0** |
| --- | ---: | ---: | ---: |
| Empty startup (wall) | 19.68 | 18.15 | **9.79** |
| 启动访问 `Bun.SQL` (wall) | 323.49 | 124.60 | **13.63** |
| Module resolution (wall) | 317.83 | 270.31 | **11.89** |
| Loop (wall) | 74.82 | 58.51 | **11.35** |

Bun 在全部 6 项 wall-time 上更快，但 Cottontail 更小（见 §6.3 体积对比）。

---

## 2. 窗口与渲染

### 2.1 `renderer` 选项

**【文档明写】** `apis/browser-window.mdx` 构造选项表：

| Option | Type | Default |
| --- | --- | --- |
| `renderer` | `"native" \| "cef"` | 平台构建默认值（`defaultRenderer`，默认 `"native"`） |
| `titleBarStyle` | `"default" \| "hidden" \| "hiddenInset"` | `"default"` |
| `transparent` / `passthrough` | boolean | `false` |
| `spellCheck` | boolean | `false` |
| `hidden` | boolean | `false` |
| `trafficLightOffset` | `{x,y}` | `{0,0}` |
| `navigationRules` | `string \| null` | `null` |
| `sandbox` | boolean | `false` |
| `allowedProtocols` | `{views?, appData?}` | `{views: true, appData: false}` |
| `rpc` | RPC 实例 | none |
| `preload` | `string \| null` | `null` |
| `viewsRoot` | `string \| null` | `null` |

`BrowserWindow` 公开方法面（文档"Public methods"节完整列出）：生命周期 6 个、窗口状态 10 个、几何 6 个、内容 3 个、元数据 2 个 + 静态 `getById`。

### 2.2 `bundleCEF` / `bundleWGPU`：构建期开关

**【文档明写】** `apis/cli/build-configuration.mdx` Platform Options 表格。三平台各自独立配置：

```ts
build: {
  mac:   { bundleCEF, bundleWGPU, defaultRenderer, codesign, notarize, createDmg, chromiumFlags, entitlements, icons },  // codesign/notarize/createDmg 默认 false/true/false
  win:   { bundleCEF, bundleWGPU, defaultRenderer, chromiumFlags, autoGrantPermissions, icon },
  linux: { bundleCEF, bundleWGPU, defaultRenderer, chromiumFlags, icon, flatpak },
}
```
- `bundleCEF` / `bundleWGPU` 默认均为 `false`（三平台一致）。
- `defaultRenderer` 默认 `"native"`。
- **`autoGrantPermissions` 只作用于 Windows WebView2，不影响 CEF**（文档明写）。

**运行期**读取已打包的渲染器元数据（**不要假设 CEF 存在**）：
```ts
import { BuildConfig } from "electrobun/main";
const build = await BuildConfig.get();
// build.defaultRenderer: "native" | "cef"
// build.availableRenderers: ("native"|"cef")[]
// build.mainProcess: "bun"|"cottontail"|"zig"|"rust"|"go"|"odin"|undefined
```
来源：`apis/build-config.mdx` 的 Returned fields 表。

**【文档明写】混用规则**：`apis/bundling-cef.mdx`
- macOS / Windows：包内**可混用** native 与 CEF 视图（每窗口/每 view 可选）。
- **Linux：整个进程只能选一种 webview 实现**——「Do not design a Linux window around mixed native and CEF children」。
- Windows 特例：`<electrobun-webview>` 的 **mask 与 input passthrough 需要 CEF**（WebView2 无法提供）。

### 2.3 `views://` scheme 注册权限位（**源码推断，文档未列权限位**）

用户要求的 `standard`/`secure`/`corsEnabled`/`cspBypassing`/`fetchEnabled`/`codeCache` 这些位，文档**没有**列出；源码有明确值：

**macOS CEF**（`package/src/native/macos/nativeWrapper.mm:5524-5538`）：
```cpp
registrar->AddCustomScheme("views",
    CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_CORS_ENABLED |
    CEF_SCHEME_OPTION_SECURE |        // treat it like https
    CEF_SCHEME_OPTION_CSP_BYPASSING | // allow things like crypto.subtle
    CEF_SCHEME_OPTION_FETCH_ENABLED);
registrar->AddCustomScheme("appdata",
    CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_CORS_ENABLED |
    CEF_SCHEME_OPTION_SECURE | CEF_SCHEME_OPTION_FETCH_ENABLED);
```
**Linux CEF**（`package/src/native/linux/nativeWrapper.cpp:995-1004`）：与 macOS **逐位一致**。

**结论**：
- `views`：STANDARD + CORS_ENABLED + **SECURE** + **CSP_BYPASSING** + FETCH_ENABLED。
- `appdata`：STANDARD + CORS_ENABLED + SECURE + FETCH_ENABLED（**无 CSP_BYPASSING**）。
- **`CEF_SCHEME_OPTION_*_CODE_CACHE` 未设置**——**【源码推断】全仓 grep 无 `codeCache` 任何命中**。即 CEF 下 `views://` 页面**不进代码缓存**。

**macOS/WKWebView 路径**：`views://` 与 `appdata://` 通过 `WKURLSchemeHandler` 注册（`nativeWrapper.mm:3011-3013` 的 `setURLSchemeHandler:forURLScheme:`），响应头固定为（`nativeWrapper.mm:2382-2386`）：
```
Content-Type: <由 getMimeTypeFromUrl 决定>
Access-Control-Allow-Origin: *
X-Content-Type-Options: nosniff
```
JS MIME 为 **`text/javascript`**（`package/src/native/shared/mime_types.h:21`），非 `application/javascript`。

**访问控制**：`allowedProtocols` 逐 webview 授予，默认 `{views: true, appData: false}`。**权限跟随 webview 而非当前页面 origin**——文档用 `caution` 明确警告：开启 appData 的 webview 若导航到远程 URL，该远程页面也能读 `appdata://` 文件（`apis/bundled-assets.mdx`）。两个 scheme 都被限制在各自根目录内，拒绝绝对路径 / `..` 穿越（含编码穿越）/ symlink 逃逸（`package/src/native/shared/views_url.h` 有完整的 `normalizeViewsRelativePath` 校验，含 percent-encoding、NUL、控制字符、非法 UTF-8、盘符前缀等 8 类错误）。

### 2.4 自定义 protocol handler

**【源码推断】**：**没有**面向应用的自定义 protocol 注册 API。`views://` 与 `appdata://` 是硬编码的两个 scheme，应用无法注册第三个。唯一近似能力是 `viewsRoot` 覆盖打包 views 根目录 + `build.copy` 自定义文件。

### 2.5 preload / `webviewTag` / 每窗口独立 renderer

**【文档明写】** preload：
- `BrowserWindow` / `BrowserView` 的 `preload` 选项接受内联 JS 或 `views://` 脚本 URL（`apis/browser-window.mdx` 构造表）。
- `<electrobun-webview>` 有 `preload` 属性（`apis/browser/electrobun-webview-tag.mdx` Attributes 表）。
- 机制（`guides/architecture/webview-tag.mdx`）：「Electrobun injects a preload into each host webview」，preload 注册自定义元素、把 URL/HTML/renderer/partition/sandbox/nav-rules/矩形发给主进程。

**`<electrobun-webview>` / `<electrobun-wgpu>`**（`guides/architecture/webview-tag.mdx`）：宿主 DOM 里是**锚点**，内容由**独立原生 BrowserView** 渲染（不是 iframe、不是 DOM 子节点）。移除元素 = 销毁原生 view；重新插入 = 新 view + 新 ID。宿主 `z-index` **压不住**它（独立合成层），需要 `masks` 选择器打洞。

**每窗口独立 renderer**：支持。`BrowserWindow` 构造参数各自独立，`BuildConfig.availableRenderers` 在运行时可查。**Linux 是例外**（进程级唯一）。

---

## 3. 与页面通信（替代 Tauri IPC）

### 3.1 `electrobun/view` 暴露了什么

**【文档明写】** `apis/browser/electroview-class.mdx`：
- 浏览器侧类是 `Electroview`，构造 `new Electroview({ rpc })`。
- `Electroview.defineRPC<Schema>(config)` 在 webview 侧提供 handler；主进程侧用 `BrowserView.defineRPC<Schema>(config)` / `BrowserWindow` 的 `rpc` 选项。
- **schema 含纯类型、不产运行时代码**，放在被两侧 import 的共享模块里。
- schema 结构：`{ bun: RPCSchema<{requests, messages}>, webview: RPCSchema<{requests, messages}> }`。

**方向语义**（文档明列）：
| | 执行位置 | 调用方 |
| --- | --- | --- |
| `bun.requests` | 主进程 | webview 调用 |
| `bun.messages` | 主进程接收 | webview 发送 |
| `webview.requests` | 浏览器执行 | 主进程调用 |
| `webview.messages` | 浏览器接收 | 主进程发送 |

**类型生成**：**没有**独立的 codegen 步骤——类型由 TS 泛型 `defineRPC<Schema>` 静态推导（`package/src/shared/rpc.ts` 的 `RPCRequestsProxy` / `RPCMessagesProxy` 映射类型）。**【文档明写】明确缺失**：主进程调用浏览器 JS 的返回值**没有**原生等价——TS 侧只能 `executeJavascript()`（不返回值，见 `apis/browser-view.mdx`）。

**【文档明写】浏览器↔浏览器无隐式 RPC**：「Electrobun intentionally has no implicit browser-to-browser RPC. Route communication through the main process or use an explicit web transport.」

### 3.2 消息通道与加密

**【源码推断】**（`package/src/browser/index.ts` + `package/src/preload/encryption.ts`）：

- **主通道**：WebSocket 环回 `ws://127.0.0.1:${HOST_SOCKET_PORT}/socket?webviewId=${id}`（`browser/index.ts` 的 `initSocketToHost`）。注释明写：**故意用 ws:// 而非 wss://，因为「all RPC messages are encrypted with per-webview AES-GCM keys, making TLS redundant」**。
- **加密**：AES-GCM，每 webview 独立密钥。密钥来自 `window.__electrobunSecretKeyBytes`，经 `crypto.subtle.importKey({name:"AES-GCM"})` 导入（`preload/encryption.ts:44-52`）。IV = 12 字节随机；**tag（最后 16 字节）被单独拆出传输**，密文包结构 `{encryptedData, iv, tag}`（全 base64）。
- **回退通道**：socket 不可用（CONNECTING/关闭）时落到 `window.__electrobunHostBridge.postMessage(msg)`（`browser/index.ts` 的 `sendMessageToHostViaFallback`）。Linux 上 socket 分发有专门串行化队列以保帧序（`queueLinuxHostSocketDispatch`）。
- **传输实现细节**：`window.__electrobunPlaintextHostSocket` 为真时**跳过加密**直接发明文（`sendMessageToHostSocket`）——存在明文通道开关。
- **sandbox 模式**：`sandbox: true` 禁用应用 RPC，但事件发射与 `window.__electrobunSendToHost()` 仍可用（`apis/browser/global-properties.mdx`）。

### 3.3 与自定义 scheme 页面的能力边界

**【文档明写】**：
- `views://` 是只读打包内容；可变数据必须放 `Utils.paths.userData` / `userCache` 或用 `appdata://`。
- **页面 JS 永不持有特权 API**（`guides/architecture/overview.mdx`：「page JavaScript never holds privileged APIs directly」）。
- **⚠️ 安全警告**（`apis/browser-window.mdx` 的 `caution`）：「Do not attach privileged RPC handlers to a view that can navigate to untrusted content.」

**【源码推断】** `views://` 页面在 CEF 下因 `CSP_BYPASSING` 可用 `crypto.subtle`；在 WKWebView 下无 CSP 概念但 scheme 非 https。这对 `dsh` 这类需要 `crypto.subtle`/WebCrypto 的页面是硬要求。

---

## 4. 系统集成

| 能力 | 状态 | 细节与来源 |
| --- | --- | --- |
| **Tray** | ✅ TS/Cottontail/Bun 完整 | `new Tray({title,image,template,width,height})` + `setTitle/setImage/setVisible/getBounds/setMenu/on("tray-clicked")/remove/getById/getAll/removeById`。图标可为 `views://` URL 或绝对路径。**【文档明写】Linux AppIndicator 后端支持菜单与动作，但不暴露「主图标点击」**——可移植做法是用 `setMenu()` 显式菜单动作，不要等 icon-only click。**Zig/Rust/Odin 的 tray 点击回调传 null（不支持），Go 的 `TrayOptions.Handler` 支持**；**托盘菜单是 TS-only**。 |
| **Application Menu** | ✅ 全运行时（native 走 JSON） | `ApplicationMenu.setApplicationMenu([...])` + `on("application-menu-clicked")`。项字段：`label`、`action`/`role`、`data`、`submenu`、`enabled`、`checked`、`hidden`、`tooltip`、`accelerator`、`type:"separator"|"divider"`。native SDK 无类型化菜单构造器，走 `showContextMenuJson` 之类 JSON 串。 |
| **Context Menu** | ⚠️ **仅 macOS + Windows** | `ContextMenu.showContextMenu([...])` 在当前全局指针位置弹出。**【文档明写】Linux 尚未实现**。webview 内需自己 preventDefault 再 RPC 回主进程。 |
| **Dock** | ⚠️ 极薄 | 只有 `Utils.setDockIconVisible(bool)` / `Utils.isDockIconVisible()`。**没有** dock 菜单、dock badge、dock 图标动态设置等 API。**【源码推断】全仓无 badge 相关导出**。 |
| **通知** | ⚠️ fire-and-forget | `Utils.showNotification({title, body?, subtitle?, silent?})`。**【文档明写】不支持点击回调**（issue #384 OPEN，请求 `userInfo` + 点击回调 + 前台是否仍显示的控制）。 |
| **全局快捷键** | ✅ 全运行时 | `GlobalShortcut.register(accelerator, cb)` / `unregister` / `unregisterAll` / `isRegistered`。从 `electrobun/main/native` 导出。 |
| **单实例** | ❌ **无此 API** | **【源码推断】全仓 grep `singleInstance` / `secondInstance` / `requestSingleInstanceLock` / `alreadyRunning` 零命中**。仅有 macOS 的 `applicationShouldHandleReopen` → `reopen` 事件（`nativeWrapper.mm:8006`）。 |
| **深链（自定义 URL scheme）** | ⚠️ **仅 macOS** | `app.urlSchemes: string[]` + `app.fileAssociations`（docs 明写「Custom URL schemes are currently registered on macOS」）。**【文档明写】「Windows and Linux URL schemes and file associations are not yet implemented.」**（`build-configuration.mdx`）。事件：`Electrobun.events.on("open-url", e => ...)`，文件走 `file:` URL。macOS 上需装到 `/Applications` 或 `~/Applications` 才能被 Launch Services 注册。 |
| **开机自启** | ❌ **无此 API** | **【源码推断】全仓 grep `openAtLogin` / `autostart` / `loginItem` / `SMLoginItem` 零命中**。需自己写原生层。 |
| 其他 | ✅ | `Utils.openExternal/openPath/moveToTrash/showItemInFolder`、剪贴板（text+image read/write/clear/availableFormats）、`openFileDialog`、`showMessageBox`、`screenCapture`、`quit/requestQuitApproval`；`Screen`（显示器）、`Session`（cookie/partition 会话） |

**对比 dsh 现状的关键缺口**：Tauri 2 侧 dsh 依赖的**单实例约束（#82/#93）、深链、托盘三件套**在 Electrobun 里分别对应「无 API」「macOS-only」「macOS 上 tray click 缺 raw activation」。dsh 的托盘是常驻核心交互面（refresh_tray_mode 重建菜单），这点 TS 侧 `setMenu()` 覆盖得住。

---

## 5. 更新器

### 5.1 形态（文档明写 + 源码）

**【文档明写】** `apis/updater.mdx`：
- **仅 Cottontail 和 Bun 主进程可用**。**Zig/Rust/Go/Odin 完全没有更新 API**（`apis/main.mdx` coverage 表里 Updater 一行 native 全是 `—`）。
- API：`Updater.getLocalInfo()` / `getSync` 形态、`checkForUpdate()`、`downloadUpdate()`、`applyUpdate()`、`updateInfo()`、`onStatusChange()` / `getStatusHistory()` / `clearStatusHistory()`、`Updater.localInfo.{version,hash,channel,baseUrl}`、`channelBucketUrl()`、`appDataFolder()`。
- `getLocalInfo()` 返回 `version, hash, baseUrl, channel, name, identifier`。

**自解压 + BSDIFF**（`guides/architecture/overview.mdx` + `bundling-and-distribution.mdx`）：
- 产物形态 = **自解压 wrapper + Zstandard 压缩 tar**（`.tar.zst`），首启动验证并解压到托管位置再拉起内层 app。
- 补丁链：Hutch 从 `release.baseUrl` 取 `<channel>-<os>-<arch>-update.json` → 下载上一版 `.tar.zst` → 解压 → 对新的未压缩 tar 做 **binary patch** → 命名为 `<previous-hash>.patch`。
- 客户端：从当前 hash 出发，按 `<channel>-<os>-<arch>-<current-hash>.patch` 逐级应用，每级从结果 tar 里读下一个 hash，直到追上 `update.json.hash`；任一环缺失/失败即**丢弃整条链**、退化为下载完整归档。
- **【源码推断】BSDIFF 实现**：v2-x changelog 记录 `zig-bsdiff 0.1.26`（Zig 优化，"can produce kilobyte-scale updates"，见 README）。
- `applyUpdate()` 流程：先走正常 `before-quit` 征询 → 原生 post-exit helper **校验下载的 bundle 身份 → 事务式替换 → 刷新平台集成 → 拉起新版**。**替换失败回滚到旧版**。Windows 用 Task Scheduler 只是为了等被锁进程退出。

### 5.2 与 GitHub Releases 的集成

**【文档明写】** `guides/updates.mdx`：
- **只是"静态托管"的一种**：「Anything that serves files over HTTPS works as the host: R2, S3, **GitHub Releases**, or a plain static host.」**没有 GitHub API 专用的更新器**——没有 release 自动查、没有 asset 自动匹配。
- 可直接用 `baseUrl: "https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download"`。
- **⚠️ 限制**：「GitHub excludes prereleases from `/releases/latest`, so that URL cannot track canary builds.」canary 客户端必须用固定静态 baseUrl。
- 文档给了完整的 GitHub Actions 矩阵（macos-14 / ubuntu-24.04 / ubuntu-24.04-arm / windows-2025），**先构建全部 target，全部成功后才 `softprops/action-gh-release` 建一个 Release**。
- **【文档明写】安全声明**：「The bundle hash is a release-routing identifier, not a code-signing or content-authenticated mechanism. Serve updates over HTTPS and sign distributed applications with the platform's normal code-signing system when authenticity is required.」

### 5.3 自定义更新源/通道

**【文档明写】**：
- 更新源：任意静态 HTTP 主机，`release.baseUrl` 配置，**完全自定义**。
- 通道：**只有两个发布通道**——`stable` 与 `canary`（`hutch electrobun build --env=stable|--env=canary`）。命名规则 `<channel>-<os>-<arch>-`。
- `release.generatePatch` 默认 `true`，可关（不访问 release host）。
- **无回滚 API**：文档只讲"替换失败自动回滚"，**没有**「回到上一版本」的主动 API；静态主机保留旧 patch 会自然形成可追溯链。

---

## 6. 打包与签名

### 6.1 `hutch` 命令

**【文档明写】** `apis/cli/cli-args.mdx` + `guides/hutch.mdx`：
```
hutch electrobun init [name] [--template=] [--channel=stable|beta] [--skip-install]
hutch electrobun config --env=dev|canary|stable      # 打印归一化后的配置
hutch electrobun prepare                             # 只解析/校验/投影 devkit，不构建
hutch electrobun build --env=canary|stable
hutch electrobun dev [--watch]
hutch electrobun run
hutch electrobun update                              # 推进到最新 stable
hutch electrobun sync                                # 让未 pin 的项目跟随当前通道头
hutch install / hutch pm exec / hutch run <task>
```
**【文档明写】Hutch 不进产物**：「Hutch and its compiler toolchains are not shipped inside the finished app.」

### 6.2 产物形态（**与题面假设不同，注意**）

`guides/bundling-and-distribution.mdx` Artifact Names 节：

| 平台 | 安装包产物 | 更新归档 | 补丁 |
| --- | --- | --- | --- |
| macOS ARM64 | `macos-arm64-<Name>.dmg` | `macos-arm64-<Name>.app.tar.zst` | `<prev-hash>.patch` |
| Windows x64 | `win-x64-<Name>-Setup.zip` | `win-x64-<Name>.tar.zst` | 同上 |
| Linux x64 | `linux-x64-<Name>-Setup.tar.gz` | `linux-x64-<Name>.tar.zst` | 同上 |

**❌ 没有 .msi，没有 AppImage，没有 .deb，没有 NSIS/WiX。**
- **Windows = 一个 zip，内含一个可见的 setup exe + 一个隐藏的 installer payload**（文档原文：the visible setup executable and a hidden installer payload）。装出来的是 GUI-subsystem 可执行文件。
- **Linux = `.tar.gz` 自解压安装包 + `flatpak-builder` manifest（可选，Hutch 自己不调用 flatpak-builder）**。
- **macOS = DMG（默认，`createDmg: true`）+ `.app.tar.zst`**。

**⚠️ macOS x64 没有 core 产物**：`docs/guides/bundling-and-distribution.mdx` 明写「Electrobun's current release matrix does not publish a macOS x64 core artifact.」兼容表（`compatability.mdx`）里 macOS 只有 arm64。**Intel Mac 无官方构建目标**。

### 6.3 macOS 公证 / Windows 代码签名

**【文档明写】** `guides/code-signing.mdx`：
- macOS：`build.mac.codesign` + `build.mac.notarize`（默认均 `false`），**仅 canary/stable 生效，dev 构建即使开也不签名**。
- Hutch 会先签嵌套 Mach-O 与 code bundle 再签外层 app，用 `codesign` 验证，提交 app + DMG 到 Apple，**staple** 已接受的 ticket 并校验。
- 凭据：`ELECTROBUN_DEVELOPER_ID`（必需）；公证二选一——App Store Connect API Key（`ELECTROBUN_APPLEAPIKEYPATH` + `ELECTROBUN_APPLEAPIKEY` + `ELECTROBUN_APPLEISSUER`，推荐）或 Apple ID + app-specific password（`ELECTROBUN_APPLEID` + `ELECTROBUN_APPLEIDPASS` + `ELECTROBUN_TEAMID`，三者必须齐全）。
- 调试跳过：`ELECTROBUN_SKIP_NOTARIZATION=1`。
- Entitlements 默认含 JIT 与动态库所需项，可通过 `build.mac.entitlements` 追加。
- **❌「Windows release signing is not currently part of Hutch's packaging pipeline.」（文档首段原文）—— Windows 零代码签名支持。**

**⚠️ 安全 issue #515（OPEN，2026-08-04）**：「Security: code signing setup exposes personal Apple ID credential (iCloud data, identity abuse)」——**未修复**。对 dsh 这种要发公网安装包的场景，用 app-specific password 方案需评估。

### 6.4 CEF 产物体积（**官方数字，本次实测取得**）

来自 v2.0.3-beta.16 GitHub Release 的 `electrobun-artifacts.json`（含官方 SHA-256），单位换算由我计算：

| 平台 | core（系统 webview 路径） | CEF（`bundleCEF: true` 额外） | 倍数 |
| --- | ---: | ---: | ---: |
| macOS ARM64 | **5,666,395 B ≈ 5.4 MiB** | **131,261,355 B ≈ 125.2 MiB** | **23×** |
| Windows x64 | 10,708,936 B ≈ 10.2 MiB | 169,153,871 B ≈ 161.3 MiB | **16×** |
| Windows ARM64 | 11,754,039 B ≈ 11.2 MiB | 166,389,192 B ≈ 158.7 MiB | **15×** |
| Linux x64 | 20,589,880 B ≈ 19.6 MiB | 164,392,851 B ≈ 156.8 MiB | **8×** |
| Linux ARM64 | 19,830,469 B ≈ 18.9 MiB | 167,194,985 B ≈ 159.5 MiB | **9×** |

来源：`https://github.com/blackboardsh/electrobun/releases/download/v2.0.3-beta.16/electrobun-artifacts.json`（core/cef 各带 `size` 与 `sha256`），对应 release assets 的 `.tar.gz` 大小（`gh api .../releases/tags/v2.0.3-beta.16` 亦同）。

**注意**：这些是 **CEF 库归档的压缩体积**，不含 app 自身代码、也不含"打包后安装体积"的官方数字。**官方文档从未给出任何 MB 级体积数字**（全仓 grep 无命中）；唯一的官方体积表是 v2-x changelog 里的**可执行文件抽取大小对比**（Cottontail vs Bun）：macOS ARM64 57,714,960 B vs 63,072,928 B（省 8.5%）、Windows x64 55,587,328 B vs 117,660,760 B（省 52.8%）、Linux x64 59,480,576 B vs 101,814,712 B（省 41.6%）。

**⚠️ issue #359（OPEN）**：macOS release app 首启动**静默自解压** `Contents/Resources/<hash>.tar.zst`，报告者实测 **app 体积变成 4 倍**，且首启动可能失败。这直接冲击 dsh「点开即用、用户不用理解自解压」的产品预期。

---

## 7. 原生扩展面

**【文档明写 + 源码推断】**：

| 能力 | 状态 |
| --- | --- |
| **Bun FFI (`bun:ffi`)** | Bun 主进程就是真 Bun，`bun:ffi` 可用。**【源码推断】** 文档只在 Cottontail 的 capability 列表里出现 `ffi`；Bun 侧无专门文档页（因为不需要——它是 Bun 本身）。`hasFFI` 从 `electrobun/main/native` 导出（`index.ts`）。 |
| **WGPU/Dawn raw FFI** | ✅ 官方支持：`WGPU.native` 暴露生成的 Dawn C 绑定，`WGPU.native.available` 探测（`apis/webgpu.mdx` "Raw Dawn FFI" 节）。`wgpu` / `wgpu-threejs` 模板有可运行的 raw-FFI 实现。 |
| **objc / C++ 绑定** | ❌ **无官方绑定层**。底层是 `libNativeWrapper.dylib`（Obj-C++）+ `libElectrobunCore`（Zig 编译的动态库），Go/Rust/Zig SDK 的做法是 **`dlopen`/`LoadCore()` 加载 core**（Go/Rust hello-world 文档明写）。要走 objc 得自己从 Bun FFI 或 native 主进程切入。 |
| **N-API 原生模块** | ⚠️ **条件支持，文档明确警告**：`guides/compatability.mdx`：「Native addons and code that depends on undocumented runtime internals can still be platform- or runtime-specific. Test the application on every target before a production release.」Cottontail 侧还多一层：Windows ARM64 下「Native npm addons also need Windows ARM64 binaries or a working build from source」。**Electrobun 不打包 node_modules，Hutch 的内置解析器只管 JS 依赖图——原生模块的构建/分发要自己解决。** |
| **spawn 子进程与管道** | ✅ Bun 主进程用 `Bun.spawn`（Bun 原生能力）。**【源码推断】**文档没有任何"Electrobun 提供 spawn API"的说法——这纯粹是运行时自带能力。Cottontail 侧对应能力是 `shell` capability + `Bun.$`（文档明写「including the `Bun.$` shell interface」）。模板里实测有用到 `node:fs` / `Bun.file` / `Bun.write`（`templates/notes-app`、`templates/all`）。 |

**对 dsh 的含义**：dsh 现有壳的核心是「spawn 子 dsh 进程 + 转发 stdout/stderr + 进程 worker 台账」。Bun 主进程可以直接用 `Bun.spawn`/`node:child_process` 做，**能力上不构成阻塞**；但要注意 dsh 是 Node 生态（pnpm workspace、`node:` 前缀 API），Bun 兼容性不是 Electrobun 承诺的——Electrobun 对 Bun 的承诺只是"打包这个固定版本"，**兼容性由 Bun 自己负责，不是 Electrobun 的保证**。

---

## 8. 已知坑（重点）

### ① `renderer:"cef"` 在未打 CEF 时**静默回落系统 webview** ✅ 已从源码确认

这是**明确的静默降级，三平台都如此，无警告、无日志、无异常**：

**macOS**（`package/src/native/macos/nativeWrapper.mm:8359-8360`）：
```cpp
Class ImplClass = (strcmp(renderer, "cef") == 0 && useCEF)
                      ? [CEFWebViewImpl class]
                      : [WKWebViewImpl class];
```
**Windows**（`package/src/native/win/nativeWrapper.cpp:8944-8959`）：
```cpp
if (renderer && strcmp(renderer, "cef") == 0 && isCEFAvailable()) {
    ... createCEFView ...
} else {
    ... createWebView2View ...   // ← 静默走 WebView2
}
```
**Linux**（`isCEFAvailable()` 在 `package/src/native/linux/nativeWrapper.cpp:591-622`）：检查 `<execDir>/cef/libcef.so` 或 `<execDir>/libcef.so` 是否存在，缓存结果。

**后果**：CI 上漏开 `bundleCEF` → 本地/开发一切正常（走 WKWebView）→ 打出来的包在生产悄悄用 WKWebView/WebView2，**你拿到的是原生 webview 的行为，不是 Chromium 的**。而且 `<electrobun-webview>` 的 mask/passthrough 在 Windows 上**必须有 CEF**（文档明写），所以这类功能会直接失效而非报错。

**防御**：构建后必查 `BuildConfig.get().availableRenderers.includes("cef")`（文档给了这个示例），或直接断言产物里有 `Contents/MacOS/cef/...`。**不要靠"设置 renderer:'cef' 就会是 CEF"。**

### ② 升级会清空 CEF cache ✅ 已确认是设计行为

**【源码推断 + 文档明写】** `package/src/native/shared/cache_migration.h` 头部注释把这个机制写得很清楚：

> "One-shot CEF cache folder wipe on Electrobun upgrades. When Electrobun ships a release whose CEF cache folder layout/contents are incompatible with prior releases ... the simplest reliable recovery is to wipe the cache folder. **End users will be logged out of sites they were logged into via the app**, but the app starts cleanly with no dialogs."

- 机制：读 `<cacheFolder>/.electrobun_cef_cache_version`，缺失或 ≠ `CEF_CACHE_FORMAT_VERSION` 就**删掉 cacheFolder 内全部内容**（保留目录本身）并重写哨兵。
- **当前常量：`CEF_CACHE_FORMAT_VERSION = 3`（mac/Linux）、`WINDOWS_CEF_CACHE_FORMAT_VERSION = 4`**（`cache_migration.h:67`、`:73`；测试断言见 `windows_profile_paths_test.cpp:88-89`）。
- **手动 bump，不由 CEF 版本自动触发**——注释明写：「Independent of CEF_VERSION — bumping CEF does not always require a wipe.」**这条意味着：版本号由维护者手工决定何时清，用户无法预测。**
- 安全护栏（任一失败即 no-op，永不清）：空/相对路径、末段不是已知 cache 名、深度 < 3、`std::filesystem` 异常。
- 调用方：`nativeWrapper.mm:7122`（mac）、`nativeWrapper.cpp:7041-7044`（Win）。
- **文档侧的确认**：`guides/changelog/v1-18-0.mdx:19-21`「First launch after upgrading silently wipes the CEF cache once. End users get logged out of any sites they were signed into via your app and **client-side site data (cookies, localStorage, IndexedDB) is reset**. WebView2 storage and your own app data are untouched.」
- **不锁多进程**：注释明写「Multi-process locking is NOT implemented」。

**对 dsh**：如果 dsh 用 CEF，**每次上游 bump 那个常量，用户就登出一次**。dsh 的会话是 127.0.0.1 origin + cookie 体系，这条直接命中。

### ③ 上游 issue #237：macOS CEF 下 `views://` 的 `<script src>` 不执行

**状态：OPEN，无人回复，自 2026-03-02 起零更新。**
- 标题：`CEF on macOS: <script src> tags don't execute on views:// protocol`，创建 2026-03-02T04:42:44Z，`updatedAt` == `createdAt`，**comments: 0**。
- 现象：`views://` 下 `<script src="index.js">` 文件被取到（CEF 日志确认完整响应、正确 MIME `text/javascript`、1.6MB），但脚本**永不执行，console 无任何报错**。`<script src="views://renderer/index.js">` 同样失败；动态创建 `<script>` + `textContent` 也不执行。
- Workaround（issue 内提供，实测可行）：`fetch(url).then(r=>r.text()).then(code => new Function(code)())`。
- 仅影响 CEF；`defaultRenderer:"native"`（WKWebView）不复现——这也是它长期没被报告的原因。
- **【源码推断】** 我核对了 macOS WKWebView handler 的响应头（`Content-Type: text/javascript` + `nosniff`，`nativeWrapper.mm:2382-2386`）与 CEF 侧的 `views` scheme 选项（带 `CSP_BYPASSING`/`FETCH_ENABLED`），**没找到能解释该现象的明显配置错误**——报告者也说「The scheme handler configuration looks correct」。**这更像 CEF 上游行为问题，Electrobun 侧无补丁。**
- 唯一交叉引用是一个已 merged 的无关 PR（#217，macOS resize 修复）。

**对 dsh 的含义（严重）**：如果迁移时选 CEF + `views://` 承载前端，**整个前端 bundle 可能静默不加载**——白屏、零报错。dsh 的 `views://` 页要走 `fetch()+new Function()` 才行，那会破坏 CSP 友好性、打包优化与 sourcemap。**这是我认为迁移最可能"卡住"的技术点之一。**

### ④ 真实 origin / localStorage / session 持久化相关的 open issue

| Issue | 状态 | 标题/要点 |
| --- | --- | --- |
| **#380** | OPEN（2026-04-18） | **macOS CEF persistent partitions using custom request-context cache paths for cookies**：`CefRequestContext::CreateContext` 带自定义 `cache_path` 在 Chrome runtime mode 下失败（"Cannot create profile at path"），**退回全局 context**，cookie 持久化到默认位置。**→ CEF 下 partition 隔离在 macOS 上不成立。** |
| **#408** | OPEN（2026-04-29） | **WKWebView: implement permission delegates for Notifications and Storage Access**：相机/麦克风/地理定位的 UIDelegate 已有，但 **Storage Access API 与 Notifications 的权限 delegate 未实现**。**→ `document.requestStorageAccess()` 在 WKWebView 上走不通。** |
| **#278** | CLOSED（2026-03-08） | CEF persistent partitions 在 macOS 失败，因为 profile 路径嵌在 `Partitions/` 下（已修，但 #380 是同类问题的残留）。 |
| **#186** | CLOSED（2026-02-22） | Linux 上 session/cookie 不工作（已修）。 |
| **#482** | CLOSED（2026-06-30） | Linux 上 OPFS 损坏（已修）。 |
| **#550** | OPEN（2026-09-04/09-09） | **macOS: webview freezes after sleep**——睡眠唤醒若干次后 webview 永久冻结：输入死、页面所有 fetch 永不 resolve、不重绘；原生窗口/菜单/应用自己的服务器照常工作。**唯一恢复手段是 `kill -9` WebContent 进程让 WebKit 重建，而 Electrobun 没有提供对应 API，也没有 sleep/wake 事件。** **→ 对 dsh 这种常驻托盘 + 长时间挂机的应用，这是重大风险。** |

**partition 默认值【源码推断】**：`package/src/sdks/main/proc/native.ts:2013` 写 `toCString(partition || "persist:default")`——**默认 partition 是 `persist:default`（持久化）**，不是 ephemeral。macOS 上 `persist:<id>` 经 SHA-256 转 UUID 后走 `WKWebsiteDataStore dataStoreForIdentifier:`（**需要 macOS 14.0+**，低版本回落 `defaultDataStore`，`nativeWrapper.mm:742-767`）。非 `persist:` 前缀才走 `nonPersistentDataStore`。

---

## 9. 成熟度信号

### 9.1 版本与节奏

- 最新：**v2.0.3-beta.16（2026-10-10）**，即**调研当天仍在发 beta**。最近 30 个 release tag 里有 18 个是 2.0.2-beta.x / 2.0.3-beta.x。
- v2.0.0 之后 **beta 通道跑了约 10 天发了 16+ 个 beta**——迭代极快，**也意味着 API 仍在动**。
- 最新 **stable 是 2.0.2（2026-09-29）**。

### 9.2 提交活跃度（GitHub API 实测）

- 仓库 **12,897 stars / 368 forks / 132 open issues**，创建于 2024-02-28，最后 push **2026-10-10T04:39:40Z**，MIT，**未归档**。
- 贡献者 **30 人**。
- 近 6 个月提交 **≈ 616**；近 3 个月 **≈ 465**；近 30 天 **≈ 123**。
- v2.0 changelog 自称：解决 **138 issues + 47 PRs**，追踪 **8,440 个 Node/Bun 兼容测试文件**（启用 8,436，记录 24 个预期失败），约 **1,800 个一方测试 + Kitchen Sink 场景**。
- 模板目录 **30 个**（hello-world / react-vite / multi-window / multitab-browser / tray-app / sqlite-crud / wgpu-* / rust / go / odin / zig 等）。
- **几乎所有模板的 `bundleCEF: false`**（`templates/*/electrobun.config.ts` 抽查：`all`、`angular`、`bunny`、`go-maze-wgpu` 全是 false）。**官方模板矩阵里没有一个默认开 CEF。**

### 9.3 是否有真实 CEF 形态产品

**README 列了 52 个 App**（`## Apps Built with Electrobun`，[24agents](https://github.com/jhsu/24agents)、[Co(lab)](https://blackboard.sh/colab/)、[Invoke](https://getinvoke.com)、[MarkBun](https://github.com/xiaochong/markbun)、[electrobun-doom](https://github.com/blackboardsh/electrobun-doom) 等）。

**判定【未确认 / 反向证据】**：
- README 里对 CEF 的描述只有一条：`- bundleCEF flag to bundle and pin Chromium for those that want that tradeoff of consistency over file size`——**没有点名任何用 CEF 发布的产品**。
- 官方模板全 false。
- **我未找到可验证的「以 CEF 形态对外发布的真实产品」证据。** 唯一用 CEF 的官方样例是 `kitchen/electrobun.config.ts:33` 里注释掉的 `// cefVersion: "144.0.12+g1a1008c+chromium-144.0.7559.110"`。
- 有真实产品形态的 WGPU 侧证据（electrobun-doom、wgpu 模板族）。

### 9.4 文档完备度评分：**4 / 5**

**加分项（实测优点）**：
- 文档**随源码同仓**（`docs/src/content/docs/`），31 个 API 页 + 25 个 guide 页，**版本 tag 一对应**，不会出现"文档落后于代码"的系统性漂移。
- **诚实度罕见地高**：明确标注实验性（`caution` 块）、明确写未接线（`build.cottontail.bytecode`「declared but **not yet wired** — setting it is currently a no-op」）、明确写没做（Windows signing、Linux context menu、Windows/Linux URL schemes、Updater 不支持 native SDK）。
- 给了可复现的 benchmark（附原始 JSON + 复现脚本）与 SHA-256 绑定的 release manifest。
- 每个平台/运行时的限制都给了具体到文件/行的说明。

**扣分项（实测缺陷）**：
- **同一文件内自相矛盾**：`build-configuration.mdx` 第 14 行说 Bun 是默认、第 159 行说默认是 cottontail（源码 `@default "bun"`）。说明文档**未随 2.0.3 beta 的默认值切换同步更新**。
- **完全没写的东西**：单实例、开机自启、N-API 原生模块打包、objc 绑定、代码体积数字——这些要么缺失要么要靠 grep 源码才能确认，**对"评估能不能迁移"的读者是最大的信息盲区**。
- `apis/main.mdx` 的 coverage 表（谁支持什么）是全文最有价值的一页，但它明确标注「exact native option and callback shapes **vary slightly per language**」，并把"完整参考"推给模板。
- 版本处于 beta 通道且 **10 天发了 16 个 beta**，文档/行为都可能有 churn。

---

## 10. 迁移视角的结论性判断（供架构讨论）

### 明确会「卡住」的点（我的判定，非官方）

1. **CEF + `views://` 的 `<script src>`（issue #237）**：macOS CEF 下前端 bundle 静默不执行，零报错，官方 7 个月零动静。**如果方案是「CEF + views:// 打包前端」，必须先复现验证；workaround 是 `fetch()+new Function()`，代价大。**
2. **`renderer:"cef"` 静默回落**：构建配置漏一处就悄悄换成 WKWebView，且 Windows 上 `<electrobun-webview>` 的 mask/passthrough 直接失效（无报错）。需要在 CI 加断言。
3. **CEF cache 手工 bump → 用户被登出**：`CEF_CACHE_FORMAT_VERSION`（mac/Linux=3，Win=4）由维护者手改，触发即清空 cookies/localStorage/IndexedDB，且**无多进程锁**。dsh 的 127.0.0.1 会话会中招。

### 能力缺口（无 API，只能自己写原生层或绕路）

- **单实例**（dsh 的 #82/#93 同 profile 互斥约束）：**零 API**。要么靠 `open-url`/`reopen` 近似，要么自写原生。
- **开机自启**：**零 API**。
- **深链**：**macOS-only**，Windows/Linux 明写未实现。
- **通知点击回调**（issue #384）：fire-and-forget，dsh 的任务通知服务（`network/notify.rs`）点击跳转做不了。
- **托盘图标直接点击**：Linux AppIndicator 后端不暴露，**必须走显式菜单**（dsh 托盘是核心交互面，需要重构交互模型）。
- **Context menu 无 Linux**（若要支持 Linux）。
- **Windows 代码签名零支持**（公网分发体验问题，与签名无关）。
- **无 macOS x64 目标**（Intel Mac 用户无路）。

### 相对 Tauri 2 的"能力等价性"速查

| dsh 现状（Tauri 2） | Electrobun 对应 | 判定 |
| --- | --- | --- |
| `tauri::generate_handler!` + capabilities + ACL | typed RPC（TS only；native SDK 只有裸 JSON） | ⚠️ 权限模型**不同**：Electrobun 无 ACL 文件，靠 `sandbox: true` + navigationRules + 自身纪律 |
| Tray（三件套） | `Tray` + `setMenu()` | ✅ 够用（TS 主进程） |
| 多窗口 / 次实例 | `BrowserWindow` + `BrowserView` | ✅ |
| **单实例锁** | — | ❌ **无** |
| `urlSchemes` 深链 | macOS only | ⚠️ |
| Windows 签名 | — | ❌ 无 |
| updater（自建） | 内置 `Updater`（TS/Bun only）+ BSDIFF | ✅ **这是 Electrobun 的强项** |
| 下载管理器 | webview download 事件 + `Utils.openPath` | ⚠️ 只有事件，没有 Tauri 那种文件路径/进度控制 |
| Rust 后端（dsh 现有） | Bun 主进程 | ⚠️ **整个 171 例 cargo test 后端要重写为 TS**——这是**迁移工作量的大头，不是 Electrobun 的能力问题** |

---

## 附录 A：本文所有主要来源 URL

**版本与发布**
- Release 列表：https://api.github.com/repos/blackboardsh/electrobun/releases
- Release manifest（core/CEF 官方体积 + SHA-256）：https://github.com/blackboardsh/electrobun/releases/download/v2.0.3-beta.16/electrobun-artifacts.json
- 仓库元数据：https://api.github.com/repos/blackboardsh/electrobun

**版本 pin 源码**
- https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/cef-version.ts
- https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/bun-version.ts
- https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/cottontail-version.ts
- https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/rust-version.ts
- https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/go-version.ts
- https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/package/src/shared/odin-version.ts

**文档（raw，可按行号核对）**
- https://github.com/blackboardsh/electrobun/blob/v2.0.3-beta.16/docs/src/content/docs/electrobun/apis/main.mdx
- .../apis/build-config.mdx · .../apis/bundling-cef.mdx · .../apis/browser-window.mdx · .../apis/browser-view.mdx
- .../apis/tray.mdx · .../apis/application-menu.mdx · .../apis/context-menu.mdx · .../apis/events.mdx
- .../apis/updater.mdx · .../apis/bundled-assets.mdx · .../apis/paths.mdx · .../apis/bun.mdx · .../apis/webgpu.mdx
- .../apis/browser/electroview-class.mdx · .../apis/browser/global-properties.mdx · .../apis/browser/electrobun-webview-tag.mdx
- .../apis/cli/build-configuration.mdx · .../apis/cli/cli-args.mdx
- .../guides/architecture/overview.mdx · .../guides/architecture/webview-tag.mdx
- .../guides/native-main-process.mdx · .../guides/cottontail.mdx · .../guides/compatability.mdx · .../guides/code-signing.mdx
- .../guides/bundling-and-distribution.mdx · .../guides/updates.mdx · .../guides/hutch.mdx · .../guides/hot-reloading.mdx
- .../guides/migrating-to-v2.mdx · .../guides/what-is-electrobun.mdx · .../guides/quick-start.mdx
- .../guides/changelog/v2-x.mdx · .../guides/changelog/v2-0-2.mdx · .../guides/changelog/unreleased.mdx · .../guides/changelog/v1-18-0.mdx
- 在线：https://framework.blackboard.sh/electrobun/

**关键源码位置（本文引用的行号均可在 v2.0.3-beta.16 复核）**
- 渲染器静默回落：macOS `package/src/native/macos/nativeWrapper.mm:8359`；Windows `package/src/native/win/nativeWrapper.cpp:8944`；Linux `package/src/native/linux/nativeWrapper.cpp:591-622`
- CEF scheme 注册：macOS `nativeWrapper.mm:5524-5538`；Linux `nativeWrapper.cpp:995-1004`
- WKWebView scheme handler：macOS `nativeWrapper.mm:1046`（声明）、`2305-2411`（实现）、`3011-3013`（注册）、`2382-2386`（响应头）
- CEF cache 清除：`package/src/native/shared/cache_migration.h:1-30`（注释）、`:67`（version 3）、`:73`（Windows version 4）、`:168-`（实现）；调用点 `nativeWrapper.mm:7122`、`nativeWrapper.cpp:7041-7044`
- partition 默认：`package/src/sdks/main/proc/native.ts:2013`（`persist:default`）；`nativeWrapper.mm:742-767`（data store 选择）
- RPC 传输与加密：`package/src/browser/index.ts`（transport）、`package/src/preload/encryption.ts:44-99`（AES-GCM）、`package/src/sdks/main/core/Socket.ts`（host 侧）
- Utils API 全表：`package/src/sdks/main/core/Utils.ts:10-410`
- 默认主进程：`package/src/config/ElectrobunConfig.ts:151`（`@default "bun"`）
- Bun 版本强制：`package/src/config/validate.ts:5,35-43`
- views URL 校验：`package/src/native/shared/views_url.h`
- MIME 表：`package/src/native/shared/mime_types.h:21`

**Issue**
- #237 https://github.com/blackboardsh/electrobun/issues/237 （OPEN，2026-03-02，0 评论）
- #380 https://github.com/blackboardsh/electrobun/issues/380 （OPEN，macOS CEF partition cookies）
- #408 https://github.com/blackboardsh/electrobun/issues/408 （OPEN，WKWebView 权限 delegate）
- #550 https://github.com/blackboardsh/electrobun/issues/550 （OPEN，macOS 睡眠后 webview 永久冻结）
- #384 https://github.com/blackboardsh/electrobun/issues/384 （OPEN，通知点击回调）
- #515 https://github.com/blackboardsh/electrobun/issues/515 （OPEN，签名凭据安全）
- #359 https://github.com/blackboardsh/electrobun/issues/359 （OPEN，macOS 首启动自解压、app 变 4 倍）
- #267 https://github.com/blackboardsh/electrobun/issues/267 （OPEN，view 跨窗口 re-parent）

## 附录 B：明确「未确认」清单（不推测）

1. **Electrobun 是否有以 CEF 形态发布的真实产品** —— 未找到证据；README 未点名，官方模板全 `bundleCEF: false`。
2. **打包后应用的最终安装体积 / 下载体积官方数字** —— 官方从未发布；我给出的仅为 release 归档体积（core/CEF `.tar.gz`）。
3. **`bundleCEF: true` 时实际安装体积增量** —— 未确认（归档体积 ≠ 安装体积；且 issue #359 报告首启动自解压后体积变化）。
4. **Bun 1.4.0 对 dsh 依赖的 pnpm/node 生态兼容性** —— Electrobun 不作保证；需实测。
5. **`<electrobun-webview>` 在 Windows 上非 CEF 路径的 mask/passthrough 具体失效表现** —— 文档只说"require CEF on Windows"，无细节。
6. **`views://` 在 WKWebView 与 CEF 下的 origin 是否满足 `crypto.subtle` / WebCrypto 要求** —— CEF 侧有 `CSP_BYPASSING` 明证；WKWebView 侧未找到明文说明，需实测。
7. **Windows/Linux 上 `Session`（cookie API）跨重启持久化行为** —— 有 #186 已修，但未找到完整的官方行为声明。