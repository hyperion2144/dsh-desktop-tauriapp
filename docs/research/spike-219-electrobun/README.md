# spike-219：Electrobun + CEF + Bun 起真壳（#219 的可复用最小工程）

本目录是地图 [#204](https://github.com/hyperion2144/dsh-desktop-tauriapp/issues/204) 子票
[#219](https://github.com/hyperion2144/dsh-desktop-tauriapp/issues/219) 的产出：
一个**最小、可复跑**的工程，用来回答「把桌面壳换到 Electrobun（CEF 渲染）+ Bun 运行时之后，
JSC/WebKit 那族崩溃是否消失、官方那套启动与注入链路在 CEF 下是否照常成立」。

**结论：两条都成立**（验收证据见下与 #219 的结案评论）。这不是产品代码，也不进任何安装包。

## 文件

| 路径 | 作用 |
| --- | --- |
| `app/electrobun.config.ts` | Electrobun 配置：`mainProcess: "bun"`、三平台 `bundleCEF: true`、`defaultRenderer: "cef"` |
| `app/src/bun/index.ts` | spike 主进程：CEF 断言 → Bun 起 dsh host → 取 cookie → `Bun.serve` 出页面并反代 → 内联 `preload` 注入桥 → 开窗口 |
| `host-official-style.mjs` | 与官方 `apps/desktop-host/src/index.ts` 同构的最小 host：`loadProfileDirectory` → `runProfile(--port 0)` → 打印 `HOST-READY {url, injections}` |
| `probes/sample.mjs` | 经 CDP 采页面状态（root 子节点数、正文长度、正文块数、`streamBaseUrl`） |
| `probes/drive.mjs` | 经 CDP 驱动真实一轮对话（新建会话 → 聚焦输入框 → `Input.insertText` → 点发送 → 采样增长） |
| `probes/cdp2.mjs` | 页面运行时状态 + 控制台/异常（`Runtime.enable` / `Log.enable`） |
| `probes/cdp3.mjs` | 网络面：reload 后收集 4xx/5xx 与 `loadingFailed` |
| `probes/longrun.sh` | 长跑监控：每分钟采渲染进程 RSS / `.ips` 增量 / 页面状态，每 7 分钟发一条消息 |
| `probes/shot.mjs`、`probes/inspect.mjs` | 截图（`Page.captureScreenshot`，用 bun 跑）、输入区 DOM 盘点 |

## 复跑

```bash
# 1) 工具链（一次性）：Hutch 自带 pinned 的 Electrobun + Bun 1.4.0
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh

# 2) 建工程（或直接用本目录的 app/）
hutch electrobun init spike-cef --template=hello-world --channel=stable
# 把 app/electrobun.config.ts 与 app/src/bun/index.ts 覆盖进去
hutch install --frozen-lockfile

# 3) 隔离的 dsh home：避免动到日常那个 ~/.dsh
#    需要：profiles/desktop/{package.json,cordis.patch.yml}、合并好的 node_modules、
#    .credentials.yaml（否则模型调用会报 no API key）、storages/workspace.json（否则没有工作区可选）
#    补丁文件放哪都行：bun-preload.mjs 按 dirname(import.meta.url) + DSH_BUN_PRELOAD_TREES（冒号分隔的树根）
#    + 入口脚本与 cwd 各向上 8 层找 node_modules，把每个存在的 node-pty / @xterm/headless 都补上（realpath 去重），
#    退出时恢复原样；若崩溃残留，下次运行会先复原再重打（node-pty 是 dispatcher，Node 路径不受影响）。

# 4) 跑
cd spike-cef && SPIKE_PORT=6390 SPIKE_DSH_HOME=/tmp/spike-219/dsh-home hutch electrobun dev
```

`app/src/bun/index.ts` 里的路径（运行时树、dist、隔离 home、Bun 1.4.0）都可以用 `SPIKE_*` 环境变量覆盖；
`SPIKE_PORT` **固定端口很关键**，理由见下。

## 验收结果（#219 六条）

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| ① CEF 真在用 | ✅ | `BuildConfig.availableRenderers = ["native","cef"]` 断言通过；页面 UA `Chrome/147.0.0.0`（Chromium 147.0.7727.118）；进程树只有 `bun Helper`（gpu-process / utility / renderer），**没有任何 WebKit/WebContent 进程** |
| ② loopback 页面 | ✅ | `Bun.serve` 从当前生效运行时的 `dsh-web-frontend/dist` 出文档与资产；`crypto.subtle` 可用；整页 UI 起（515 元素 / 240 样式表 / 侧栏与插件全在） |
| ③ localStorage 跨重启 | ✅（有前提） | 固定端口两次启动：第二次 `lsPrev = "1791677410328"`；随机端口时每次都是新 origin，`lsPrev` 恒为 `null` |
| ④ ≥1h 流式不崩 | ✅ | 见下表：60 分钟、8 轮真实模型流、`.ips` 0 新增、无重载无白屏 |
| ⑤ Bun 起 dsh | ✅ | Bun **1.4.0**（Electrobun pin）起完整 Host：13 条注入、插件加载完成、`--port 0`、`303 + set-cookie`；Bun 1.3.14 起不来（见下） |
| ⑥ CEF 缓存风险 | 记录未触发 | CEF cache 落在 `~/Library/Application Support/spike.cef.dshr/<channel>/CEF`（本项目从未跨 Electrobun 版本升级，格式号 bump 清空缓存的风险未实测） |

## 长跑（验收 ④）

60 分钟，8 轮真实对话（每 7 分钟一条：模型 `DeepSeek V4.1 Flash (CC)`，144–154 tok/s，单轮输出 2.3K→6.6K tok）：

| 时刻 | 渲染进程 RSS | 页内正文块 | 正文长度 | `.ips` 累计 |
| --- | --- | --- | --- | --- |
| t=1m | 519 MB | 10 | 4,202 | 17 |
| t=10m | 553 MB | 16 | 5,076 | 17 |
| t=20m | 568 MB | 22 | 5,832 | 17 |
| t=30m | 574 MB | 34 | 7,705 | 17 |
| t=40m | 594 MB（峰值） | 40 | 8,451 | 17 |
| t=50m | 555 MB | 52 | 10,008 | 17 |
| t=60m | 566 MB | 58 | 10,724 | 17 |

- `document.getElementById("root").childElementCount` 全程恒为 1，URL/令牌未变 ⇒ **没有自动重载、没有白屏**。
- 对照：同一台机器上仍在使用的 Tauri 壳，其 WebContent 在 08:01:50 又崩了一次（`com.apple.WebKit.WebContent-2026-10-11-080151.ips`，进程起于 10-10 21:55:44，**存活 10h06m**），磁盘累计 17 份；CEF 侧这一小时 0 新增。
- 内存量级对照：CEF 渲染进程 0.52→0.57 GB；Tauri/WebKit 的 WebContent 是 1.36–1.85 GB。

## 关键发现（都已实测，不是推断）

1. **注入要走 ctx，不要爬上游 HTML**：宿主在进程内 `ctx.webServer.collectIndexInjections()` 出 13 行 rows
   （`style` / `script` / `script-preload` / `script-src` / `global`），经壳的 `preload` 桥
   （`globalThis.dshDesktopBoot = { ready, failed }`，等价官方 `preload-app.ts`）交给页面，页面自己 apply。
   本地 dist 的 index.html 只需插一行 `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`。
2. **反代不能按 URL 前缀白名单**：插件路由（`/smooth-stream/*`、`/dsh-mnemon-settings/*`、`/dsh-ui-progress/*`）
   和带令牌前缀的相对路径（`/<token>/plugins/??…`）都会落空 ⇒ 正解是**静态优先**：
   `dist` 里真有这个文件就从磁盘出（对齐官方 `protocol.handle`），其余一律转发给 dsh。
3. **loopback origin 必须跨启动稳定**：`localStorage` 按 origin 隔离，随机端口 = 每次新 origin = 状态全丢。
   本次固定 `SPIKE_PORT=6390` 后，二次启动能读到上一次写下的值。
4. **Bun 1.4.0 与 1.3.14 是两个世界**：1.3.14 在宿主准备期就死
   （`node-addon-require-builtin unsupported: Unsupported/no-context (required V8 current-context symbols were not found)`），
   1.4.0 起完整 Host。Bun **没有** `module.registerHooks`，且 `Bun.plugin({onResolve})` 对 `node_modules` 内的
   import 不生效 ⇒ 官方 launcher 的 Node resolver hooks 装不上，profile 的 peer 依赖要靠合并 node_modules 树解决；
   Bun 默认会自动安装缺失包，必须 `--no-install`。
5. **`bun-preload.mjs` 的定位语义**：补丁目标不假设「补丁文件就在被补丁的树里」——按 `dirname(import.meta.url)`
   → `DSH_BUN_PRELOAD_TREES`（冒号分隔的树根）→ 入口脚本与 cwd 各向上 8 层，收集所有存在的
   `node_modules/<pkg>`，按 realpath 去重后逐个补（早期只补同级 `node_modules`，在「补丁文件随壳、运行时在外」的
   真实布局下静默失效）。被补丁的文件在 `exit`/`SIGINT`/`SIGTERM` 恢复原样；node-pty 还额外改成 dispatcher
   （`typeof Bun === "undefined"` → `index.original.js`，否则 `bun-shim.js`），所以崩溃残留也不会把 Node 路径带坏。
   早期做法（把补丁文件与 4 个包真拷贝进 profile 目录）曾把未激活条目从 7 条降到 3 条（`desktop-product-telemetry`、
   `product-analytics`、`experimental-inspector`——最后一条的栈在 `dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`，
   即 **worker 上下文没被 Patch 2 覆盖**）。
6. **Electrobun 的 `preload` 支持内联 JS 源码**（经原生层作 C 字符串传入）⇒ 不需要额外的注入通道就能立起 `dshDesktopBoot`。
7. 官方启动/取 cookie 的等价物：`runProfile({ args: ['--no-open','--host','127.0.0.1','--port','0'] })` →
   `ctx.connection.authenticatedUrl(base)` → 壳侧 `fetch(url, { redirect: 'manual' })` 期待 `303 + set-cookie`。
8. **终端：node-pty 在 Bun 上必须换实现**。真 node-pty（N-API addon）在 Bun 1.4.0 下 `spawn` 成功、退出码正常，
   但 `onData` 永不触发（实测 `/bin/echo hello`：Bun 0 块 / Node 1 块；`bash -i` 0 块 / 7 块）⇒ DSH 侧表现为
   「进程已退出（1）」、终端点开即关，而宿主进程本身活着。`Bun.spawn({ terminal })` 走同一套字节流，垫片转发即可；
   另外 DSH 的实现依赖 `onData`/`onExit` **返回 disposable**（`this.dataDisposable.dispose()`）与
   `pause`/`resume`/`clear`，早期垫片这三处都缺。
   不需要（也不该）解析 stdout 里的 `?token=`——那是 Tauri 期的妥协。

## 未做 / 边界

- 只跑 macOS arm64；Windows / Linux 未验证（Electrobun 与 CEF 的支持矩阵另见 `docs/research/electrobun-capability-surface.md`）。
- 未跨 Electrobun 版本升级 ⇒ CEF cache 格式号 bump 导致清缓存的路径**未实测**。
- 未做深链、单实例、防休眠、通知点击回调等 OS 集成项的替身验证（Electrobun 侧缺 API）。
- `Bun.spawn` 子进程能否直接复用 Electrobun 自带的那个 Bun 可执行文件（而不随包再带一份 ~60–90 MB），
  本次只实测了「用同一个 1.4.0 二进制起 dsh」，打包形态下的 `process.execPath` 行为仍未验证。
