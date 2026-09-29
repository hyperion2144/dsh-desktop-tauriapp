# 前端资产取自「当前生效的那个运行时」，插件链保持 Host 注入，新旧路径并存可回退

"前端产物随包"在实现上不是"壳构建期内嵌一份 dist"，而是**读当前生效的那个运行时/CLI 自己树里的 `@deepseek-ai/dsh-web-frontend/dist`**——内置运行时、下载的运行时、外部 dsh CLI 三种来源都自带这份产物。这样"运行时自由切换"与"外部 dsh"两条路上前后端版本**天然一致**。插件链不变（三个插件继续经 `--patch` 注入 Host，client 半区由 Host 侧载），布局插件在 Host 未安装时回退"随包 + 增补启动图"。旧的"直接打开 dsh 地址"路径保留为兜底。

## Status

accepted（2026-09-27；issue #152 决策；依据 #149 / #150 / #158 三张研究票；维护者逐条拍板）

## Context

- **拍板④**：前端资产用运行时自带的 dist，保留运行时自由切换，新运行时版本沿用官方那套内部弹窗检测。
- **实测事实**：`@deepseek-ai/dsh-web-frontend` 是 `@deepseek-ai/dsh-web-app` 的依赖，因此三种运行时来源都自带 dist——内置运行时（`~/Library/Application Support/com.arcreel.dsh-desktop-tauriapp/runtimes/0.1.7-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist`）、pnpm 安装的运行时树、外部全局 CLI 树（实测 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist`）。
- **版本耦合是静默的**（#158 查实）：前端产物自带的**平台种子表**（9 个包：`react`、`react-dom`、`cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit` 等）先于 graph row 被查；命中后 **Host 的同名 graph row 永不加载**——不报错、不降级，只是用错版本（CSS 类名 hash 随版本变化 → 静默丢样式；用到新增 API 才 `undefined is not a function`）。而**没有任何版本锚**：`engines.dsh` 仅声明，`__DSH_BOOT__.rev` 是 entries+batches 的 hash，`WebBootEntry.rev` 是 cache-buster。
- **插件 roster 由 Host 运行时组装**（`dsh-client-modules` node 半区扫描 `dsh.client` → `__DSH_BOOT__` → `/plugins/<pkg>/client.js`），所以"本地渲染"不会冻结插件集合；但**激活只认启动图**：`parseBootManifest` 逐行由 `graph.entries` 构造插件列表，前端 `HS()` 只遍历 `manifest.plugins`——只注册 factory 不产生 Loader entry，插件不会 `apply`。

## Considered Options

- **壳构建期内嵌一份 dist**：否决——切换运行时或使用外部 dsh 后与 Host 版本错配，且错配是静默的（见上）。
- **读当前生效运行时的 dist，缺失时回退壳内嵌副本**（选中）：主路径版本天然一致，回退路径保证永远能启动。
- **读当前运行时的 dist，缺失即报错**：否决——外部 CLI 布局异常时用户完全无法启动。
- **一律 Host 注入布局插件（放弃拍板③"随包"）**：部分采纳——作为**默认**路径（版本天然一致），但不作为唯一路径。
- **一律随包布局插件 + 增补启动图**：部分采纳——作为 Host 未安装时的**回退**路径。
- **新架构一步替换旧路径**：否决——新链路出问题时用户被锁死。

## Consequences

- 壳需要一条"定位当前生效运行时/CLI 的 dist"的路径解析逻辑，覆盖内置运行时 / 下载运行时 / 外部 CLI 三种来源，并对"目录缺失""profile 切换后路径变化"写单测。
- "随包"在 macOS 上的实际语义 = **随运行时**（内置运行时本身随包分发）；下载运行时与外部 CLI 场景是"随当前使用的那个运行时"。
- **三个插件（`dsh-desktop-tauriapp` / `dsh-mobile-access` / `dsh-web-mobile`）继续经 `--patch` 注入 Host**——它们是 Host 端 cordis 插件，client 半区由 Host 侧载，无需为本地渲染做任何改动。
- **lane 的 `<head>` 注入（`OWNS_HOST_PATCH` / `THEME_SYNC_PATCH` / `POLYFILL`）在本地资产路径上退场**（页面不再经过 lane 的 HTML 改写），仅在旧路径保留。
- **布局插件（拍板③）的落地形态**：Host 装了就用 Host 的（版本与 Host 天然一致）；Host 未装时用随包副本，由访问端在投递 injections 时**增补一行 entry + 一个 application batch**（字段与不变量见 #150 结票评论；`url` 用应用目录相对形式、由访问端本地应答，独占一个 batch，不能塞进 Host 的 combo batch）。
- **升级检测**：复用已有的 GitHub releases 运行时目录（`runtime/registry.rs`），检测到比当前更新的版本时**应用内弹一次（可关闭）**，不自动下载；下载/切换仍由用户在设置页触发。
- **回滚**：旧路径保留为兜底——新链路启动失败时**自动降级**，并在设置里留一个可见开关；发版验证后再评估是否移除。
- **手机端不走本 ADR 的"读本地运行时"路径**（它连的是另一台机器的 dsh，没有本地运行时树）：随包资产的正确性由 #153 的**远程版本闸门**保证——先比对远程 `index.html` 引用的资源 hash，一致才用本地资产，否则回退旧路径。
