# 嵌入式 / 独立 HTML-CSS-JS 渲染引擎调研（只读调研，2026-10-11）

调研问题：是否存在「内核不是浏览器（非 Chromium / WebKit / Gecko）＋ 能直接跑现有复杂 React 前端」的组合？
先验结论是「不存在」。本报告的结论：**基本成立，但有 2 个需要写清的例外**（Ultralight、Coherent Gameface/Cohtml）。

调研范围与取证方式：官方站点 / 官方仓库 README / 官方 release / 官方 docs；并额外用本机 dsh-web-frontend 产物核对了「dsh 前端到底用了哪些 Web 能力」（见第 3 节）。

---

## 1. 主表

| 名称 | 内核是否浏览器引擎 | JS 引擎 | 能否跑现有复杂 React 前端 | GPU 渲染方式 | 三平台 | 授权/价格 | 成熟度（版本/日期/限制） | 来源 |
|---|---|---|---|---|---|---|---|---|
| **Ultralight** | **是**·WebKit 分支（WebCore=WebKit fork，LGPL/BSD）+ UltralightCore/Ultralight 专有 | **JavaScriptCore**（README 明写 JSC API；FAQ 称与 Safari 同引擎） | **官方称可以**：FAQ「Can I use it with React/Vue.js/Angular/etc? Yep! ... modern frameworks run as-is」。**未逐项验证 dsh 的 SSE/Worker/Canvas/现代 CSS** | 双渲染器：CPU（Skia+SIMD，BGRA 位图）/ GPU（渲染到纹理，display list + 像素着色器；2.0 新增纯 GPU 矢量渲染器 Photon） | Win/macOS(x64+arm64)/Linux；另 Xbox/PS4/PS5/Switch | 免费档（年营收&融资均 <$200K，限 60FPS、**无 JIT**、无媒体）；Indie $395/标题（<$1M，年续 $99）；Pro $4,500/标题（<$10M）；Enterprise 定制（含主机平台+源码） | 站点标示最新 **2.0**，官方博客 **2026-10-06**「Ultralight 2.0 Out Now」；1.4（2025-04-21）把内核升到 **WebKit 615.1.18.100.1**；GitHub 仓 ultralight-ux/Ultralight 最后 push **2024-04-22**（仓只放 SDK/样例，最新 tag v1.4.0-beta）；**2.0 太新（发布 5 天）**，生态/踩坑记录少 | ultralig.ht；ultralig.ht/pricing；ultralig.ht/blog；github.com/ultralight-ux/Ultralight |
| **Servo** | 是·自有引擎（Rust，非 Chromium/WebKit/Gecko），但定位就是浏览器引擎 | **SpiderMonkey**（mozjs；v0.7.0 release notes：升级到 FIREFOX_153_3_0esr_RELEASE） | **当前不可行**：官方 Servo Book 明确「Work is still ongoing to make Servo consumable as a webview library」，推荐嵌 Servo 走 tauri-runtime-verso 或 servo-gtk；README 自称 prototype | WebRender（GPU，合成器架构） | Linux/macOS/Windows/Android/OpenHarmony（64 位为主） | MPL-2.0（开源） | **v0.7.0（2026-10-05）**，月更；`libservo`/`WebView` API 在推进中（issue #34522「Tracking issues: embedding API」仍 open）；Tauri×Servo 合作自 2023 起（2024-01-19 博客：offscreen 渲染、多 webview 原型；「definitely not production-ready yet」） | github.com/servo/servo；book.servo.org；github.com/servo/servo/releases/tag/v0.7.0；github.com/servo/servo/issues/34522；servo.org/blog/2024/01/19/embedding-update/；v2.tauri.app/blog/tauri-verso-integration/ |
| **CEF**（对照组） | **是**·Chromium（自带 Chromium 二进制，不依赖系统浏览器） | **V8** | 可以（Chromium 能跑什么它就能跑什么） | Chromium GPU（Skia/GPU 合成） | Win/macOS/Linux | BSD-3 类（CEF 自身）+ Chromium 各自许可；免费 | 与 Chromium 同步，仓库 push 2026-10-10 | github.com/chromiumembedded/cef；chromiumembedded.github.io/cef/ |
| **WebF**（openwebf/webf） | **否**·自研：Flutter 渲染管线 + 纯 Dart CSS/布局引擎，不用系统 WebView | **QuickJS**（ES6+，单实例持久 context） | **需大改**：官方称 React/Vue/Svelte/Solid/Qwik + Vite/Tailwind「just works」，但文档同时写明 **Grid 布局 coming soon**，只覆盖 Flex/positioned/flow/inline-block；无 Web Worker/WebGL 等；运行宿主必须是 **Flutter 应用**（桌面=Flutter desktop） | 直接走 Flutter 渲染管线（硬件加速合成），无独立 GPU 后端 API | iOS/Android/Windows/macOS/Linux（Flutter 支持面） | **GPL-3.0**（含 OpenWebF Enterprise Exception）+ 企业授权（闭源商用/上架需买）；见官方 Licensing | 最新 release **0.24.19（2026-03-20）**，仓库 push 2026-06-24，★2517；仍是 0.x，公开发行节奏放缓 | github.com/openwebf/webf；openwebf.com/en/docs/learn-webf；openwebf.com/en/licensing |
| **Sciter** | **否**·完全自研（自有 CSS 解析器、HTML/DOM、layout managers、input behaviors；见官方架构页） | **QuickJS++**（Sciter 5/6 的 script 模块，ES2020，含内置 JSX/NoSQL 持久化）；历史上是 TIScript 方言 | **不可行**：Sciter 的 CSS 是方言（`flow:`、`behavior:`、`window-*`、`horizontal-align`…），官方期望你**为 Sciter 专门写文档**；不支持完整 Web CSS/DOM 规范；前端需重写样式与部分 DOM 适配 | 自研图形抽象层：Direct2D/DirectWrite、**Skia（OpenGL/Vulkan/Metal/DX12）**、GDI+、CoreGraphics、Cairo | Windows / macOS / Linux（引擎架构页；部分授权档只覆盖 Windows） | Free（二进制按原样用）；Indie $310、Indie+ $620、Business $1620、Business+ $2720、Ad-hoc $2400、Enterprise++/OEM 面议（价格页更新日期 2022-03-16，可能滞后） | CHANGELOG 顶部版本 **6.0.5.2**（条目无日期；站点博客最新 2026-09-03，仍在维护）；产品老（2006 起，460M 装机，AV 厂商在用） | sciter.com/developers/engine-architecture/；sciter.com/prices/；gitlab.com/sciter-engine/sciter-js-sdk/-/raw/main/CHANGELOG.md |
| **RmlUi** | **否**·自研（libRocket 的 fork；XHTML1+CSS2 标准子集 + 部分 HTML5/CSS3） | **无内置 JS 引擎**；官方仅提供 **Lua 插件**（"Easily integrated and extensible with the Lua scripting plugin"） | **不可行**：官方明确「We do not aim to be fully compliant with CSS or HTML… Users are generally expected to author documents specifically for RmlUi」；要跑 React 得自己塞 JS 引擎 + 重写全部样式 | 无渲染后端，只产出 vertices/indices/textures/draw commands，由宿主引擎绘制（天然可接任意 GPU 后端） | Windows/Linux/macOS/Android/iOS/Switch 等 | **MIT** | **6.3（2026-08-22）**，push 2026-10-08，★4501；活跃但定位是游戏内 UI，不是 web 运行时 | github.com/mikke89/RmlUi（README）；mikke89.github.io/RmlUiDoc/ |
| **Blitz**（DioxusLabs） | **否**·自研（组合式：Stylo 样式 + Taffy 布局 + Parley 文本 + anyrender/Vello 绘制 + html5ever 解析） | **无 JS 引擎**（README：尚无 JS/Python 绑定；roadmap issue #119 里 `[ ] JavaScript suport` 仍未勾选） | **不可行**：官方状态页自称 **beta**，能渲染常见 no-JS 站点；目标明确排除 web 全量特性（无 websocket/localstorage 等），交互靠 Dioxus 虚拟 DOM 而非页面 JS | `blitz-renderer-vello` / anyrender（wgpu → Vulkan/Metal/DX12） | Windows/macOS/Linux/Android（官方 downloads 页） | Apache-2.0 + MIT（stylo_taffy 追加 MPL-2.0） | 无任何 release；最后提交 2026-10-09，push 2026-10-10，★4250；「bleeding edge」 | github.com/DioxusLabs/blitz（README）；blitz.is/status/css；github.com/DioxusLabs/blitz/issues/119 |
| **Coherent Gameface / Cohtml** | **否**·完全专有：Cohtml（HTML 引擎，自研）+ Renoir（渲染引擎）。官方原文：「Cohtml is not a "WebView" and is **not based on WebKit/Chromium/Gecko/IE**」 | **未确证**：官方文档未点名 JS 引擎（只列出 `cohtml::ScriptCompiler`、JS DOM API、Chrome DevTools 调试支持）。查过：overview / technical overview / API 索引，均无引擎名 → 不猜 | **需大改 / 商务不确定**：文档有 React、Preact、SolidJS、Tailwind、Shadow DOM、Redux DevTools 专页，DOM API 表含 MutationObserver/ResizeObserver/Canvas 2D/SVG/WebSocket；但它是**游戏 UI 中间件**（Unreal/Unity/自研引擎集成），不是桌面应用外壳，且**无公开定价** | 自研 Renoir：GPU 路径细分曲面、SDF on GPU、Dx12 后端、HDR、外部渲染库可接管 | 主机/PC/移动（游戏平台优先）；桌面应用非主打 | 商业授权（闭源，价格不公开） | 文档版本 **3.1.4.1**，release 列表到 3.1.4；产品线延续 Coherent Browser/GT，长期商用 | docs.coherent-labs.com/cpp-gameface/what_is_gfp/overview/；.../integration/technicaloverview/；.../content_development/reactsupport/；coherent-labs.com/products/coherent-gameface/ |
| **Kraken**（openkraken） | 否·自研（Flutter 渲染） | 未确证（已停更，无必要） | 不可行：**项目已死**，官方 README 直接建议 Flutter 3.x 用户改用其 fork 项目 **WebF** | Flutter 渲染管线 | 移动/桌面（当年） | Apache-2.0 | 最后 push **2022-12-30**；最后 release 0.11.0（2022-04-07） | github.com/openkraken/kraken |
| **Ladybird** | 是·自有引擎（LibWeb + LibJS，非三大内核），但**是浏览器不是库** | LibJS（自研） | 不可行：README 自称 **pre-alpha**，「only suitable for use by developers」；无嵌入 API | 自研（GPU） | Linux/macOS/Windows（开发中） | BSD-2-Clause | push 2026-10-10，★66k；无嵌入定位 | github.com/LadybirdBrowser/ladybird |
| **Electrobun** | **是**·默认用**系统 WebView**（macOS=WKWebView→JSC；Windows=WebView2→Chromium/V8）；可选 `bundleCEF` 改为打包 Chromium，另有 `bundleWGPU`（Bun TS→WGPU 原生 GPU 表面，不是 HTML 渲染器） | 默认系统 WebView 的 JSC/V8；主进程 JS 走 Bun（默认）/Cottontail(JSC) | 可以，但**不解决 mac 上的 JSC 问题**（默认走系统 WKWebView）；要换族必须开 bundleCEF（=自带 Chromium） | 系统 WebView 合成；`<electrobun-wgpu>` 可把原生 GPU 表面合成进 UI | macOS/Windows/Linux | MIT | v2.0.3-beta.16（2026-10-10），push 2026-10-10，★12890；活跃但仍是 beta | github.com/blackboardsh/electrobun（README） |
| **Slint** | 排除 | — | — | — | — | — | 非 HTML/CSS 渲染器（原生 DSL），不满足「直接渲染现有前端」 | （明确排除项） |

补充对照组（都不是「非浏览器内核」，列出以免遗漏）：Electron（Chromium+V8）、Tauri/Wails/Neutralino（系统 WebView）、Qt WebEngine（Chromium）、WebKitGTK/WPE（WebKit）、DotNetBrowser、CEF 系商业封装（如 Ultimate++/Sciter 之外的 Coherent UI 旧产品）。它们的共同点：**能跑现有前端，但渲染路径仍属于浏览器内核族**。

---

## 2. 三个必答问题

### Q-A 分档：内核是否浏览器引擎

**A 档：内核是浏览器引擎（或其分支/打包）→ 能跑现有前端**
- CEF / Electron / WebView2（Chromium + V8）
- Tauri / Wails / Neutralino / Electrobun 默认（系统 WebView：WKWebView=JSC，或 WebView2/Chromium）
- Qt WebEngine、WebKitGTK/WPE（WebKit + JSC）
- **Ultralight（WebKit fork + JavaScriptCore）** ← 关键点：它是「精简、单进程、可嵌入、渲染到纹理的 WebKit 移植」，内核仍属浏览器引擎族
- Ladybird（自有引擎，但形态是浏览器，无嵌入 API）

**B 档：内核不是浏览器引擎 → 分两类**
- B1 可商用但**面向游戏 UI 中间件**：Coherent Gameface/Cohtml（完全自研，明确非 WebKit/Chromium/Gecko；文档列出 React/Tailwind/Shadow DOM 支持）——**唯一一个「全自研引擎 + 官方声明可跑 React 系框架」的成熟产品**，但它是闭源商业中间件、无公开价格、集成面向 Unreal/Unity/自研引擎，不是桌面 App 外壳。
- B2 开源自研：Servo（SpiderMonkey，嵌入 API 仍在做）、WebF（Flutter+QuickJS，Grid 未实现）、Sciter（CSS 方言）、RmlUi（无 JS）、Blitz（无 JS）、Kraken（已死）、Ladybird（pre-alpha，非库）。

**「能跑现有前端」与「内核不是浏览器」是否互斥？**
- 严格意义上**不互斥**，因为存在 Cohtml（全自研 + 宣称跑 React）与 Ultralight（WebKit 分支，若把「WebKit 分支」算作浏览器内核则属 A 档）两个反例。
- 但在**开源 + 通用桌面外壳 + 不改前端**这个交集里，**互斥成立**：没有任何开源非浏览器内核引擎具备 Chromium/WebKit 级别的 Web 平台覆盖度；而具备覆盖度的（Chromium/WebKit/JSC）本质上都是浏览器内核。原因是 Web 平台覆盖度（CSS 全量 + DOM/Selection/Range + 事件循环 + Canvas/WebGL + Worker + SSE/WS + 字体/文本整形 + 无障碍 + contenteditable）是数十年工程量，任何自研引擎都必须先复刻它才能「不改代码直接跑」。
- 结论修正版：**先验结论「不存在」应写成「不存在（开源、通用桌面、免改前端）的组合；仅两个例外：Ultralight 属浏览器内核分支，Cohtml 属闭源商用游戏中间件」。**

### Q-B JS 引擎族与你那族 JSC JIT 崩溃的关系

- **Ultralight = JavaScriptCore = 与 WKWebView 同引擎族**。官方 README：「direct access to the JavaScriptCore API」；站点 FAQ：「Ultralight uses the same JavaScript engine as WebKit/Safari」。你遇到的崩溃栈（`JSC::ScriptExecutable::newReplacementCodeBlockFor` 等 DFG/FTL tier-up）就是 JSC 自身代码。
  - **差异点**：Ultralight 内含**自己编译的 JSC**，来自它 fork 的 WebKit 快照——1.4 = **WebKit 615.1.18.100.1**（官方博客 2025-04-21），对应 Safari 17.x 时代；2.0 的快照基线未见明文（**未确证**）。而 macOS 上 WKWebView 用的是**系统自带 JSC**（随 macOS/Safari 更新）。因此：**同族、同模块、不同版本/不同构建**。你那族崩溃若源于系统 JSC 某个版本的回归，Ultralight 未必复现；反之若源于 JSC tier-up 的通用缺陷（或你们的代码触发了特定 tier-up 路径），则**同族风险依然存在**——不能因为「换掉 WKWebView」就认为消除。
  - 免费档还有一条硬限制：**Free 档不含 JavaScript JIT**（官方 pricing 表），即免费档跑的是解释器模式——这反而会「顺带」规避 JIT 崩溃，但性能不可接受；付费档才开 JIT，也就回到 JSC JIT 路径。
- **换族（真换 JS 引擎）的选项**：
  - **V8**：CEF、Electron、WebView2（Windows 上的 Tauri 也走 V8，因为 WebView2 是 Chromium）。内核也一起换成 Chromium。
  - **SpiderMonkey**：Servo（mozjs，v0.7.0 对齐 Firefox 153 ESR）。
- **不换族但换内核**：WebF/Sciter/Blitz/RmlUi/Cohtml（QuickJS/无 JS/未确证）——JS 引擎不是 JSC，但代价是 Web 平台覆盖度（见 Q-C）。

### Q-C 逐项「跑 dsh 前端」的现实成功率

先给出 dsh 前端的真实依赖（本机产物实测，见第 3 节）：ResizeObserver（多包）、IntersectionObserver、MutationObserver、**EventSource(SSE)**（`dsh-api-session-controller/lib/client.js`）、Web Worker（pdf/excel 预览、inspector）、**xterm.js**（`dsh-client-ui-sidebar-terminal/lib/client.terminal.js`，Canvas/WebGL 终端）、Canvas 2D（`getContext`，conversation/pdf/excel 预览）、CSS `:has()`×15、`color-mix()`×10、`backdrop-filter`×7、`mask-image`×9、`position:sticky`、`scrollbar-width`、`display:grid`、大量 `@keyframes/animation/transition`。

| 方案 | 判定 | 要改什么 / 关键风险 |
|---|---|---|
| CEF / Electron / WebView2 | **可行** | 前端零改；改的是壳（Rust→C++/Node 或换 Electron 主进程），体积/内存上升。**这不是「非浏览器内核」，只是换到 V8 族** |
| **Ultralight** | **可行但需大改宿主**（最值得做一次冒烟） | ①宿主必须 C/C++（或社区 C#/Java/Rust/Go 绑定）——dsh 的 Node 后端 + Tauri IPC（`generate_handler!` 那套命令）要用 C++/JS 桥重写；②前端资源改成 Ultralight 的 file:// 或自定义加载器；③必须逐项验证 SSE、Worker、Canvas/xterm、`:has()/color-mix()/backdrop-filter/mask-image`、contenteditable（Lexical）在 WebKit 615/2.0 快照下的表现；④**内核仍是 JSC（Q-B 风险）**；⑤2.0 发布仅 5 天，且付费档才有 JIT。**建议 first step**：用官方 SDK 的 Browser 样例加载本机 dsh 页面（http://127.0.0.1:308x）跑通「渲染 + SSE + 输入」三件事 |
| Servo / tauri-runtime-verso / tauri-runtime-servo | **当前不可行（方向性可行）** | Servo Book 自述嵌入仍在进行中；即便用 tauri-runtime-verso（MIT，★141，push 2026-09-10）保住 Tauri 壳与 Rust 生态，仍需把 dsh 前端**降级到 Servo 支持的 Web 子集**（SSE/Worker/Canvas/xterm/现代 CSS 逐项核对，未确证 Servo 是否支持，建议用 servoshell 打开 dsh 页面看控制台报错作为 30 分钟预判） |
| WebF | **需大改** | ①宿主换成 Flutter 桌面应用（Tauri 壳全部重写）；②**GPL-3.0**：闭源分发须买企业授权；③Grid 布局未实现（dsh 前端大量 grid）；④xterm/Worker/WebGL 类能力缺失或需插件替代；⑤QuickJS 生态与 V8 的差异（Shiki/oniguruma wasm、Intl 等） |
| Sciter | **不可行** | CSS 方言 + DOM 子集：需要为 Sciter 重写全部样式与部分 DOM 适配；QuickJS++ ES2020 与 dsh 依赖的现代 API 差异；macOS/Linux 只在较高授权档 |
| RmlUi | **不可行** | 无 JS 引擎（只有 Lua 插件）→ 现有 React 前端没有执行环境；HTML/CSS 子集需重写 |
| Blitz | **不可行** | 无 JS 引擎（roadmap 未勾选）→ 同上；且官方定位不是浏览器 |
| Cohtml/Gameface | **需大改 + 商业不确定** | 官方有 React/Tailwind 支持文档，但集成形态是游戏引擎中间件；闭源、无公开价格、桌面应用案例不明；**未确证**其 JS 引擎与 ES 版本 |
| Kraken | **不可行** | 2022 停更，官方指向 WebF |
| Ladybird | **不可行** | pre-alpha、浏览器形态、无嵌入 API |
| Electrobun | **可行但不解决你的问题** | 默认系统 WebView（macOS 仍是 WKWebView/JSC）；只有 `bundleCEF` 才换到 V8（=自带 Chromium，等价 CEF 路线） |
| Slint | 排除 | 非 HTML |

---

## 3. 附加证据：本机 dsh 前端实际用到的 Web 能力（自测，非营销）

产物：`~/Library/Application Support/com.arcreel.dsh-desktop-tauriapp/runtimes/0.2.1-alpha.2/node_modules/@deepseek-ai/dsh-web-frontend/dist`（5.9MB；`assets/index-*.js` 635KB + `assets/vendor-*.js` 741KB + `index-*.css` 77KB + `vendor-*.css` 30KB）。

- 顶层 JS 包出现次数：`ResizeObserver`=24、`IntersectionObserver`=5、`MutationObserver`=2、`requestAnimationFrame`=5、`shiki`=10、`light-dark(`=7；`webgl/webgpu/OffscreenCanvas/EventSource/new Worker`=0（说明这些能力在按需加载的 chunk / 各 client 包中）。
- 各 client 包（`@deepseek-ai/*/lib/*.js`）：`dsh-api-session-controller/lib/client.js` → **EventSource=4（SSE 流式）**；`dsh-client-ui-sidebar-terminal/lib/client.terminal.js` → **@xterm=6、getContext=3**；`dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js` → getContext=35、Worker=7、IntersectionObserver=2；`client.excel.js` → getContext=9、Worker=11；`dsh-client-ui-primitives/lib/index.js` → ResizeObserver=19、IntersectionObserver=7；`dsh-client-ui-conversation/lib/client.js` → getContext=2、ResizeObserver=3。
- CSS（`index-*.css`）：`:has(`=15、`color-mix(`=10、`mask-image`=9、`backdrop-filter`=7、`display:grid`=8、`grid-template`=4、`position:sticky`=4、`scrollbar-width`=2、`@supports`=1、`@keyframes`=14；无 `@container`、无 `@layer`、无 `subgrid`。

→ **任何自研引擎要「直接渲染 dsh 现有前端」的最低门槛清单**：SSE(EventSource)、Web Worker、Canvas 2D + xterm 用的 canvas/WebGL 路径、ResizeObserver/IntersectionObserver/MutationObserver、CSS `:has()/color-mix()/backdrop-filter/mask-image/grid/sticky/scrollbar-width`、contenteditable+Selection/Range（Lexical）、以及可靠的字体/文本整形。

---

## 4. 未确证项（不猜）

1. Ultralight 2.0 的 WebKit 快照基线版本（1.4 有明文 615.1.18.100.1，2.0 官方博客未写）→ 查过 ultralig.ht/blog、ultralig.ht/、GitHub README/tags。
2. Cohtml/Gameface 的 JS 引擎型号与 ES 版本 → 查过 overview、technical overview、API 索引（只有 `cohtml::ScriptCompiler`，无引擎名）。
3. Servo 对 EventSource / Web Worker / `:has()` / `color-mix()` 的逐项支持状态 → 查过 Servo Book、README、v0.7.0 release notes；servo.org/wpt 的通过率是 JS 图表，未能取到数值（可人工打开 https://servo.org/wpt/ 复核）。
4. Gameface 官方「Differences to traditional browsers」页正文未取到（页面为前端渲染，抓回只有导航）→ 该页具体缺失清单未确证。
5. Sciter 6.0.5.2 的发布日期（CHANGELOG 条目无日期；价格页更新日期停在 2022-03-16）。

---

## 5. 一页结论

1. 你的先验「不存在」**方向正确**：在「开源 + 通用桌面外壳 + 不改前端」的交集里，确实不存在「非浏览器内核却能直接跑现有复杂 React 前端」的方案。
2. 唯一需要修正的措辞：**Ultralight 是「浏览器内核分支（WebKit/JSC）但非 Chromium、可渲染到纹理」**；**Cohtml/Gameface 是「完全非浏览器内核、官方声明可跑 React」但闭源商用、游戏中间件形态**。
3. 想「换族」就得换 JS 引擎：V8 = CEF/Electron/WebView2；SpiderMonkey = Servo（嵌入未成熟）。想「不换族但换壳」= 仍吃 JSC 风险。
4. 换渲染路径**不改变** dsh 前端对 SSE/Worker/Canvas/现代 CSS 的硬需求——这是所有非 Chromium/WebKit 方案的第一道墙。
5. 最小成本验证顺序建议：① CEF/Electron 路线（前端零改，确认「换 V8 是否消灭崩溃」这一因果）；② Ultralight 2.0 冒烟（若必须「非 Chromium + GPU 纹理渲染」）；③ Servo/verso 只做技术预研，不进主线。
