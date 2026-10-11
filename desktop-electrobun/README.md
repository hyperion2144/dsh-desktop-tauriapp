# desktop-electrobun —— 迁移后的桌面壳（骨架）

这是 #220（地图 #204）的**骨架里程碑**：用 Electrobun（Bun 主进程 + CEF 渲染）重写桌面壳，
跑通「Bun 起 dsh → 壳自建 loopback 出页面 → 数据面反代 → 注入走 ctx → 窗口（CEF）」这条主链。
旧 Rust/Tauri 壳（`desktop/`）在切换前仍是发布形态，两边并存。

## 跑起来

```bash
# 依赖（只有 @types/bun）
bun install

# 无窗口：只起服务面，打印一行 SHELL-READY {json} 后留在前台（缝 ①/CI 用）
DSH_HOME=/tmp/shell-home DSH_SHELL_PROFILE_MODE=fresh DSH_SHELL_PAGE_PORT=6391 \
  bun run src/bun/serve.ts

# 有窗口：hutch 起 dev 包（Electrobun 自带 Bun + CEF）
hutch electrobun dev

# 门禁：纯逻辑单测（缝 ②）+ 进程级黑盒（缝 ①；没给运行时则整段跳过）
bun test
DSH_SHELL_TEST_RUNTIME=<runtime>/node_modules/.. bun test
```

`SHELL-READY {json}` 里的 `origin` / `token` / `pageUrl` 就是页面地址：
`http://127.0.0.1:6391/<token>/`。`/__shell__/health` 是壳的自检视图（上游、注入行数、转发计数）。

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/bun/index.ts` | Electrobun 主进程：CEF 断言（`availableRenderers` 必须含 cef）→ 起服务面 → 建窗 |
| `src/bun/serve.ts` | 无窗口入口（**不 import electrobun**）：给缝 ① 与 CI 用 |
| `src/bun/service.ts` | 服务面：运行时就位、profile 树 reconcile、端口认领、起宿主、取 cookie、起 loopback |
| `src/bun/host.ts` | spawn dsh 宿主（同一份 Bun），读 `HOST-READY {url,injections}` |
| `src/bun/shell-server.ts` | loopback HTTP：准入 → 壳自答端点 → 静态（文档类）→ 数据面反代 + WS 隧道 |
| `src/bun/preload.ts` | document-start preload：`globalThis.dshDesktopBoot`（同官方契约，换载体） |
| `src/bun/profile-tree.ts` | 把运行时树的包软链进 `profiles/<name>/node_modules`（#209 的 reconcile） |
| `runtime/dsh-host.mjs` | 官方 `apps/desktop-host` 的 Bun 等价物：`runProfile(--port 0)` → `{url, injections}` |
| `src/shared/*.ts` | 准入、资产路径、转发头、端口台账、子进程环境（纯逻辑，缝 ② 全在这层） |
| `test/*.test.ts` | 缝 ②（`ports`/`policy`）+ 缝 ①（`blackbox`，真进程真 HTTP/WS） |

## 与官方的对齐点（规格第 2/3 条）

- **文档本地优先**：页面文档来自本机运行时的 `dsh-web-frontend/dist/index.html`，注入只加官方那一行
  `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`；注入 rows 由宿主进程经 **ctx**
  （`ctx.webServer.collectIndexInjections()`）取，通过 `dshDesktopBoot.ready()` 交给页面。
- **两类准入**：文档与静态资产必须带每次启动的 token 前缀（`/<token>/...`，不匹配 404）；
  数据面（`/api/*`、`/plugins/*`、插件自带根路由）走根绝对路径、不要 token，改用同源校验
  （`Sec-Fetch-Site` / `Origin`，跨站 403）。
- **cookie 由壳持有**：宿主 `--port 0` 自己拿端口并上报；壳用 `fetch(url, { redirect: 'manual' })`
  走 303 + `set-cookie` 取会话 cookie（不解析 stdout 里的 token 行——那是 Tauri 时代的做法）。
- **协议层不变量**：源映射 `.map` 一律 204；路径穿越 404；`/api/*` 与 `/plugins/*` 响应补
  `cache-control: no-store`；转发时剥 `set-cookie` 与 hop-by-hop 头、改写 Host。
- **删掉的东西**（规格第 4 条）：`page_shim` 的 6 个猴补丁、`<base>` 改写、OPTIONS 预检本地应答、
  SSE 30 分钟寿命上限、`dshapp://` origin 判据、Tauri IPC。
- **外观与语言对齐旧壳**：窗口 `titleBarStyle` 按旧壳形态选（macOS `hiddenInset`＝红绿灯叠在内容上，
  对应旧壳 `TitleBarStyle::Overlay`；Windows/Linux `hidden`＝无原生标题栏，caption 行由插件 client 自绘）；
  页面语言取系统 locale（`LC_*`/`LANG` > macOS `defaults read -g AppleLocale` > Intl > en-US）写在
  preload 里——CEF 默认报 en-US，不改的话中文系统上也出英文界面（`src/bun/locale.ts`）。

## 已知简化（骨架期，后续增量）

1. 宿主就绪握手用 stdout 的 `HOST-READY {json}` 行（官方走 Node IPC）。契约同形，换通道不影响调用方。
2. boot 载荷先用壳自己的同源端点 `/__shell__/boot`（官方走 IPC handle 返回同样两个字段）。
3. 窗口在宿主就绪之后创建（文档本身是本地出，首屏不依赖上游）。
4. `profile-tree.ts` 的碰撞策略只收 `@deepseek-ai/*`，第三方包以 profile 里已有的为准；
   首启（空 DSH_HOME）会先让 dsh 脚手架 profile，失败一次后摊平再重试——这一步会写日志说明。
5. 授权层、单实例、防休眠、托盘、通知、下载管理器、插件 staging 等仍未迁移（见 #220 决策 12）。

## 打包注意

- **Bun 兼容层是仓内单一来源**：`desktop/src-tauri/resources/dsh/bun-preload.mjs`。开发与 CI 直接指它；
  打包时必须物化进 app 包内（`DSH_SHELL_PRELOAD` 可覆盖路径）。
- **运行时树不进包**：`DSH_SHELL_RUNTIME_DIR` 指当前生效运行时（默认读 app support 下 `runtimes/` 最大版本）。
- **CEF 三处开关**：构建期 `bundleCEF`、`defaultRenderer`、建窗时的 `renderer: 'cef'`；
  运行期还有 `availableRenderers.includes('cef')` 断言，缺了就拒绝启动（否则会静默回落系统 webview）。

## 门禁现状

- 缝 ②：`bun test` 里的 `ports.test.ts` + `policy.test.ts`（24 例）。
- 缝 ①：`blackbox.test.ts`（10 例，起真壳打真 HTTP/WS）——需要 `DSH_SHELL_TEST_RUNTIME`，没给就跳过。
- 缝 ③（CEF 引擎断言）是 #219 的一次性验收，不进常规 CI。
