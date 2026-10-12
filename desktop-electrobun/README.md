# DeepSeek Harness Desktop（Electrobun 版，`desktop-electrobun/`）

新栈桌面壳：**Electrobun（Bun 主进程）+ CEF 渲染**，替代旧 Rust/Tauri 壳（`desktop/`，切换前仍是发布形态）。
迁移动机与全程记录见 issue [#220](https://github.com/hyperion2144/dsh-desktop-tauriapp/issues/220)（地图 [#204](https://github.com/hyperion2144/dsh-desktop-tauriapp/issues/204)）；
迁往独立仓库 `dsh-desktop-bun` 的执行方案见 [`docs/research/electrobun-repo-migration.md`](../docs/research/electrobun-repo-migration.md)。

> 给使用者的安装 / 日常使用 / 故障排查说明在 [GUIDE.md](GUIDE.md)；本文件面向构建与开发。

## 它解决什么

- **引擎级修复 #200**：旧壳在 macOS 上用系统 WKWebView（JavaScriptCore），长会话高吞吐下撞 JSC JIT 崩溃（`DFG::Plan::finalize` 一族，24h 实测 17 次白屏刷新）。CEF = Blink/V8，该崩溃族整体消失（60 分钟长跑 0 崩溃、RSS 0.52→0.57GB，对照 WebKit 1.36–1.85GB）。
- **修掉 `localStorage === null`**：旧壳自造 `dshapp://` 协议导致页面非 secure context，快照持久化每次写入都失败。现在页面跑在壳自建的 loopback HTTP origin 上，存储真实可写。
- **启动链对齐官方桌面**：宿主进程自己 `--port 0` 拿端口并上报 `url + collectIndexInjections()`；壳用 `303 + set-cookie` 换会话 cookie；文档与静态资产本地 dist 优先，注入走 `dshDesktopBoot.ready()`（不再抓上游 HTML、不再猴补 `page_shim`、没有 30 分钟 SSE 寿命上限）。

## 跑起来

```bash
bun install                          # 只有 @types/bun 一个 devDep

# 无窗口：只起服务面，打印一行 SHELL-READY {json}（CI / 缝① 黑盒用）
DSH_HOME=/tmp/shell-home DSH_SHELL_PROFILE_MODE=fresh DSH_SHELL_PAGE_PORT=6391 \
  bun run src/bun/serve.ts

# 有窗口（开发）：hutch 起 dev 包（Electrobun 自带 Bun 1.4.0 + CEF）
hutch electrobun dev

# 出正式包：macOS = .app/.dmg + 封装签名（带 entitlements）；Windows = 构建树 + NSIS 安装器
bun run build

# 门禁
bun run typecheck                             # tsc --noEmit
DSH_SHELL_TEST_RUNTIME=<运行时树> bun test     # 609 例；不给运行时则黑盒段整段跳过
bun run assert:artifact                       # 产物断言（CI 里跑）
```

`SHELL-READY {json}` 的 `origin/token/pageUrl` 就是页面地址（`http://127.0.0.1:<port>/<token>/`）；
`/__shell__/health` 是壳的自检视图（上游、注入行数、转发计数、watchdog 状态）。

## 环境变量（常用）

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | dsh 主目录（profile/凭据/运行时台账都在这下面） |
| `DSH_SHELL_RUNTIME_DIR` | 强制指定 dsh 运行时树（开发时指向本地构建） |
| `DSH_SHELL_BUILTIN_DIR` | 内置运行时树（打包后是 `Resources/app/dsh`） |
| `DSH_SHELL_PAGE_PORT` | 页面 origin 端口（缺省按公式分配） |
| `DSH_SHELL_NO_WINDOW=1` | 只起服务面不建窗（无显示器/CI） |
| `DSH_SHELL_OPEN_PROFILES=a,b` | 启动时顺带打开其他 profile 窗口（多窗口探针） |
| `DSH_SHELL_RESOLVE_ONLY=1` | 干跑：只打印运行时选择结果就退出 |
| `DSH_DESKTOP_NO_SINGLETON=1` | 跳过单实例互斥（并行探针用） |
| `DSH_DESKTOP_AUTO_QUIT[=ms]` | 服务面就绪后延迟自动退出（探针收尾） |

## 结构（谁管什么）

| 路径 | 职责 |
|---|---|
| `electrobun.config.ts` | 三平台 `bundleCEF` + `defaultRenderer`、bundle id `com.hyperion.dsh-desktop-bun`、资源拷贝清单 |
| `src/bun/index.ts` | Electrobun 主进程：CEF 断言 → 启动界面 → 模式弹框（兼容/高级）→ 多 profile 窗口 → 托盘 → 单实例 → 退出回收 |
| `src/bun/serve.ts` | 无窗口入口（不 import electrobun）：缝① 与 CI 用 |
| `src/bun/service.ts` | 服务面编排：布局→端口认领→起宿主→换 cookie→loopback→守护器/watchdog→通知口→防休眠 |
| `src/bun/shell-server.ts` | 同源 HTTP 面：准入（token 前缀壳面 / 根路径数据面）、静态优先反代、WS 隧道、`/__shell__/*` 自答端点（rpc/boot/mode/window/profile-op/input-confirm） |
| `src/bun/host.ts` + `runtime/dsh-host.mjs` | Bun 起 dsh 宿主（官方 desktop-host 的等价物），`HOST-READY` 握手；壳退出看门狗防孤儿 |
| `src/bun/commands.ts` | RPC 命令表（旧壳 62 条 Tauri 命令的等价物，经 `/__shell__/rpc`） |
| `src/bun/{tray,tray-menu}.ts` | 托盘（事件驱动 `setMenu` 不重建、左键聚焦最后窗口、运行时/profile/远程分组、注册命令条件项） |
| `src/bun/{profile-manager,plugin-staging,profile-scaffold,profile-dialog}.ts` | profile 脚手架 / 插件 staging / `--patch` 注入 / 依赖重建 / 新建与迁移对话框 |
| `src/bun/{downloads,notifications,keep-awake,lane-forwarder,watchdog,register-cli}.ts` | 下载管理器 / 通知（14 场景策略 + 免打扰 + 音效）/ 防休眠（caffeinate / SetThreadExecutionState）/ 手机 lane 转发器 / 服务健康 TCP 自愈（3 次封顶）/ 注册 dsh 命令 |
| `src/bun/{runtime-store,runtime.ts}` + `src/shared/runtime-catalog.ts` | 运行时三来源（内置/已下载/外部 CLI）发现、下载安装（pnpm 树 + 进度）、回收站卸载、外部 dsh 定位（DSH_BIN→PATH→包管理器→nvm） |
| `src/bun/{system-proxy,keybindings,window-state,single-instance,splash,stages}.ts` | 系统代理检测（scutil/注册表）/ 快捷键偏好存取 / 每窗几何记忆 / 单实例锁 / 启动界面 / 阶段进度 |
| `src/shared/*.ts` | 纯逻辑（无 IO，缝②直接单测）：设置归一化（27 字段双键名）、端口公式与认领判定、准入、导航规则、代理解析、远程 URL、FNV、watchdog 裁决 |
| `runtime/bun-preload.mjs` | Bun 兼容层（node-pty shim / xterm 同步写 / koffi 探测等），随 dsh 版本维护 |
| `test/*.test.ts` | 缝① 进程级黑盒（起真壳真 HTTP）+ 缝② 纯逻辑单测 |
| `scripts/{prepare-bundle,sign-app,build-windows-installer,assert-artifact}.mjs` | 打包物料 / 封装签名（entitlements）/ NSIS 安装器 / 产物断言 |

## 测试缝（规格 #220 定稿）

1. **进程级黑盒（进 CI）**：起真壳（临时 `DSH_HOME` + 独立端口段），真 HTTP 打 loopback 面：两类准入、静态资产、RPC、WS、模式五分支（free / ours / foreign-web / foreign-unknown / compat / advanced）。
2. **纯逻辑单测（进 CI）**：`src/shared/*` 与可注入 IO 层——端口公式（FNV 已知向量）、认领四分支、设置归一、导航规则、补丁应用、通知策略、watchdog 裁决、代理解析（scutil/注册表文本）。
3. **引擎断言**：属一次性验收（#219 已结案：CEF 起 dsh、UA Chrome/147、60 分钟长跑零崩溃），不进常规 CI。

CI（`.github/workflows/shell-electrobun.yml`）：三平台矩阵 `build:native → prepare:bundle → typecheck → bun test → hutch electrobun build --env=stable → assert:artifact`；Windows job 追加 NSIS 安装器（每用户安装 + 可选目录 + 卸载器）并上传 `setup.exe`。

## 与官方 / 旧壳的对齐与有意差异

**对齐**：注入与 boot 走官方契约（`__DSH_BOOT_READY__` + ctx 注入 + `dshDesktopBoot.ready()`）；两类准入（token 前缀文档面 / 同源校验数据面）；协议层不变量（`.map` 204、路径穿越 404、`/api/*` `/plugins/*` no-store、剥 set-cookie 与 hop-by-hop、改写 Host）；外链走系统浏览器（原生 `navigationRules` 守卫：`^*` 阻断 + 页面 origin 白名单，覆盖 location 赋值/表单提交/meta refresh）。

**有意差异**：
- 多窗口不做就地切换 profile——每 profile 一份服务面与窗口，托盘「PROFILE 窗口」子菜单开/聚焦/停止实例。
- 托盘不周期重建——事件驱动 `setMenu`，内容不变不下发（菜单开着不被顶掉）。
- 代理独立窗口不做——设置面板承担（`get_proxy_settings` + `save_proxy_settings` 语义同旧壳）。
- 桌宠不做（维护者口径）；`dsh-mobile-nav` 布局插件随包，`desktop_layout_on_phones=false` 时不注入。
- 兼容/高级模式照旧壳：端口被外部 dsh 占用时启动页弹框询问；兼容 = 不杀进程复用外部实例（可粘贴 token URL），高级 = 清场后壳自己拉起。

## 已知边界

- 通知授权需要封装签名（sign-app 已绑 Info.plist + entitlements；**Developer ID 公证仍在 Out of Scope**——ad-hoc 签名在 macOS 26+ 上部分场景拿不到通知授权）。
- Windows 侧实机验证（窗口 chrome / 托盘 ico / 通知音 / lane）待真机确认；CI 只保证构建与产物断言。
- `rlimit` 无法在 `Bun.spawn` 前设置（无 pre_exec），子进程 fd 上限沿用继承值。
