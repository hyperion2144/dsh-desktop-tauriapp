# 壳迁 Electrobun：CEF 渲染 + Bun 主进程 + loopback 作页面 origin

壳从 Tauri（系统 webview）迁到 Electrobun，渲染引擎换成 **bundleCEF**（Chromium/Blink/V8），主进程与 dsh 后端统一跑 **Bun**，页面 origin 改由**壳自建的 loopback HTTP** 充当（读本地 dist、同源反代到 dsh 数据面）。目标是让 `#200` 那族 JSC 崩溃在原理上消失，并顺手拿回页面该有的 origin 能力。决策由 `#218` 的 grilling（Q1–Q12）定案，服务于地图 `#204`；可行性实证独立成票 `#219`。

## Status

accepted（2026-10-11；决策记录于 `#218`，地图 `#204`）。这是**选定架构**，其可行性由先验票 `#219` 验证——`#219` 若证伪「换到 V8 即消灭崩溃族」，本 ADR 需要 amended 或 superseded。

## Context

- **触发**：macOS 上 WebContent 进程反复死亡（累计 13+ 份 `.ips`）。栈只有两类，且都在引擎内部：`EXC_BAD_ACCESS/SIGSEGV` @ `JSC::ScriptExecutable::newReplacementCodeBlockFor`（野指针），以及 `EXC_BREAKPOINT` @ `JSC::CodeBlock::setOptimizationThresholdOnCompilationResult` ← `JSC::JITToDFGDeferredCompilationCallback::compilationDidComplete` ← `JSC::DFG::Plan::finalize`。栈下方总压着 async generator 帧（`asyncIteratorNextWithDriver` / `asyncGeneratorUnwrapYieldResumption`）——即 JavaScriptCore 的 DFG/FTL tier-up 缺陷族，不是我们的代码。页面越重（会话 DOM 常驻 1.3–1.8 GB、逐 token 流式刷新），热代码越多、tier-up 越频繁，撞上的概率越高。
- **现状壳**：Tauri 2.11.5 + 系统 webview（macOS = WKWebView = JSC）。页面 origin 是自定义协议 `dshapp://localhost`——选它的理由见 ADR 0003：Tauri 的 `is_local_url` 把自定义协议判为本地 origin（完整 capability），换成 `http://127.0.0.1` 会被判 `Origin::Remote`、只剩精简权限（`#154` 设置面板转圈）。
- **自定义协议的代价**（本决策要清算的部分）：页面不是安全上下文 ⇒ `localStorage === null`，前端 store 每次变更都白跑一次 `JSON.stringify` 后抛错（持久化从未成功）；页面里写裸绝对路径 URL 非法 ⇒ 必须用 `page_shim.js` 猴补丁改写 `WebSocket` / `fetch` / `XMLHttpRequest.open` / `EventSource` / `window.open` 与 `__DSH_TRANSPORT__`；协议处理器无流式、wry 无出站头钩子 ⇒ 需另开 loopback 流代理、剥 `set-cookie`、给每个非简单请求回 OPTIONS 预检、并用 30 分钟 SSE 寿命上限规避 WebKit 回收。
- **「不用系统 webview」的候选路径都已试过**：Warren 主进程自绘（`#216`：元素只有 `box`/`row`/`column`/`text`，官方自列「无文本换行/截断」，非 macOS 退回 5×7 点阵字体 ⇒ 表达不了会话流 + 代码高亮 + 中文）；`views://` 本地静态（上游 `#237`：macOS CEF 下 `<script src>` 静默不执行，2026-03-02 起零进展；且 Electrobun 无面向应用的自定义 protocol 注册 API）；非浏览器内核渲染器（`docs/research/html-renderer-survey.md`：九家候选里，「免改现有前端」与「内核不是浏览器」在开源 + 通用桌面壳的交集里互斥——Web 平台覆盖度是几十年工程量）。

## Considered Options

- **保持系统 webview（Tauri 或 Electrobun 默认）**：否决——崩溃族原样保留（macOS 仍是 JSC），非安全上下文的代价继续付。
- **`views://` 本地静态 + preload 绕过**：否决——上游 `#237` 卡住 `<script src>`，等于拿产品赌一个六个月无人回应的 issue。
- **Electrobun + bundleWGPU + Warren 自绘**：否决——`#216`，表达不了现有前端，且 Cottontail/Bun 都建在 JavaScriptCore 上，换进程不换引擎。
- **非浏览器内核渲染器（Ultralight / Servo / WebF / Sciter / RmlUi / Blitz / Cohtml）**：否决——Ultralight 内核仍是 WebKit + JavaScriptCore（且 Free 档禁 JIT、限 60FPS）；Servo 嵌入 API 仍在做；其余只吃 HTML/CSS 子集（无 JS 或 QuickJS），跑不了 React + 浏览器全量 CSS 的现有前端；Cohtml 闭源商用、无公开报价。
- **Electrobun + bundleCEF + Bun 主进程 + loopback 页面 origin（选中）**。

## Consequences

- **换族**：渲染与页面 JS 移到 V8（CEF 渲染进程）。#200 那族崩溃在原理上失去生存环境——但**必须实证**（`#219`），且三平台都会把 `renderer:"cef"` 静默回落成系统 webview，因此启动时必须断言 `availableRenderers.includes("cef")`。
- **页面拿到真实 origin**（`http://127.0.0.1:<随机端口>/<token>/`，文档来自本机磁盘）：`localStorage` 可写、cookie/SSE/WS 原生、secure context 成立。随之可删：`page_shim.js` 整套、出站头钩子、OPTIONS 预检、SSE 30 分钟寿命上限、`dshapp://` 相关的 origin 判据依赖。
- **运行时统一**：壳主进程与 dsh 后端都是 Bun（不再有 Node sidecar，省 ~56 MB 的二进制），渲染不在 Bun——Bun 负责窗口/表面/RPC/子进程/更新器，像素由 CEF 与系统 GPU 完成。
- **要在 Bun/TS 侧重写的壳能力**：资产服务与同源反代、导航守卫、单实例（自写）、防休眠（自写）；以及「当前远程模式与移动端能力必须保留」这条硬约束涉及的桌面壳实现（lane 转发、隧道、远程窗口 `ownsHost` 注入、ADR 0005 构建闸门、`DSH_MOBILE_*` env 注入、插件 staging）。移动 App 与 dsh 插件链路本身不受影响，只做回归验收。
- **产物形态变化**：dmg / Setup.zip / tar.zst（无 MSI、无 AppImage/deb，另票处理）。
- **风险**：Electrobun 固定 pin Bun 版本（stable 2.0.2 → Bun 1.4.0，不可 per-project 选）；CEF cache 格式号 bump 会清空 cookies/localStorage/IndexedDB（维护者手工 bump，属「升级即被登出」级）；Electrobun 用 `bundleCEF` 的产品案例尚无可确认者，我们走的是别人没走的路。
- **与既有 ADR 的关系**：ADR 0003 的 loopback 方案当年被 Tauri 的 origin 判据逼回自定义协议，而 Electrobun 的权限跟着 webview 走、不跟 origin——**那条惩罚在新框架里不存在**，本决策即该思路的复活；ADR 0004 的本地 dist 来源继续适用（壳从磁盘读运行时 dist）；ADR 0005 的远程构建标识闸门继续适用（数据面仍可能来自远程主机）。

## 取证材料

- 现有壳能力盘点 236 条：`docs/research/shell-capability-inventory.md`
- Electrobun 能力面与限制（逐条带来源与版本号）：`docs/research/electrobun-capability-surface.md`
- 嵌入式 HTML 渲染引擎横向清单：`docs/research/html-renderer-survey.md`
- Bun 运行时兼容性（N-API 阻塞）：`docs/research/bun-runtime-feasibility.md`
