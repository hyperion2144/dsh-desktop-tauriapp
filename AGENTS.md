# AGENTS.md —— DeepSeek Harness Desktop（dsh-desktop-tauriapp）

给 AI 编码代理的工作手册。所有条目均来自代码/构建/日志验证，未验证的不写。

## 项目简介

把 DeepSeek Harness Web GUI（dsh）封装成 Tauri 2 桌面应用（macOS + Windows）：
双击启动 → 探活/拉起本地 dsh web（每 profile 独立端口：web=3080、desktop=3081、
其余自动分配；可在设置中改）→ 主窗口加载 Web GUI → 托盘常驻 → 退出回收子进程。
#85 起支持内置运行时（默认）：Node+dsh 依赖树随包分发，经内部 runProfile API 代码
路径启动（不走 CLI，不分版本）；也可切换外部 dsh CLI（DSH_BIN → PATH → npm 全局）。
仓库同时是 dsh 插件包（根 package.json 的 dsh.client 声明

## 常用命令

- npm run build:client        （根目录；必先于桌面构建，build.rs 会把根 lib/ 内嵌进应用）
- cd desktop && npm run tauri dev   （开发运行）
- cd desktop && npm run build       （等价 tauri build，产 release .app/.dmg）
- cd desktop/src-tauri && cargo check  （快速编译检查）
- desktop/scripts/acceptance.sh       （macOS 三条路径验收：复用/拉起回收/受限 PATH）
- desktop/scripts/acceptance.ps1      （Windows 对应）
- 发布链：提交 → 三处升版本 → git tag vX.Y.Z && push → CI（.github/workflows/release.yml）
  → CI 出 draft release 后：gh release edit vX.Y.Z --draft=false --latest

## 版本号三处同步

- desktop/src-tauri/Cargo.toml（version）
- desktop/src-tauri/tauri.conf.json（version）
- 根 package.json（version）
提交信息风格：feat(desktop): ... / fix(desktop): ... / chore: 0.x.y。

## 代码风格与约定

- Rust 注释用中文；桌面壳后端为子目录化模块结构（desktop/src-tauri/src/ 下按功能域分 ui/、process/、network/、runtime/、download/、navigation/ 六组 + 根级 settings.rs / commands.rs / profiles.rs / platform.rs），lib.rs 保留 run() 入口 + DshState 构造 + generate_handler! 聚合，具体功能在各域模块内。
- 异步统一走 tauri::async_runtime::spawn；阻塞操作（如 dsh plugin add）用 spawn_blocking。
- 托盘菜单「刷新」= refresh_tray_mode（现在重建整个菜单，不是只刷标签）。
- 状态机只有两态：STATUS_STARTING(1) / STATUS_READY(2) + set_status（写 DshState + emit dsh-status
  事件）；外部/远程来源是「当前信息」而非生命周期状态（#135 收敛，前端 0-4 映射表不变）。
- 新 Tauri 命令必须三步：generate_handler! 注册 + permissions/app-commands.toml 加 allow-*
  （标识符连字符、commands.allow 用下划线命令名）+ capabilities（default/pet/remote-desktop
  按需）+ 提交时带上 gen/schemas 变更（构建自动再生成，需一起入库）。
- client 用 esbuild（scripts/build-client.mjs）产 lib/client.js；DOM 注入式 UI 放
  src/client/local-chrome.ts（侧边栏状态条等），槽位注入处用 React 组件。

## 目录结构

- src/client/ —— 浏览器侧插件 client（index.ts 注册入口 / advanced-shell 局部拖拽 chrome /
  desktop-settings.tsx 桌面设置 Tab / downloads-tab.tsx 下载 Tab / theme-select.tsx 主题 /
  local-chrome.ts 状态条等 DOM 注入 / download-intercept.ts 下载拦截 / desktop-browser-bridge.ts
  （#118 桥实现 + webview 标签兼容层）/ environment.ts 环境）。
  esbuild 产 lib/client.js；槽位注入处用 React 组件，禁 document.createElement 拼 UI。
- desktop/src-tauri/ —— Rust 桌面壳主体
  - src/lib.rs 入口聚合（run() + DshState 构造 + generate_handler!）；build.rs 构建期 staging
    内嵌插件（embedded/，gitignore）
  - src/ui/ —— 窗口与交互：tray.rs（托盘）、multiwin.rs（多窗口/次实例）、window.rs（错误页）、
    nav_guard.rs（导航守卫，browser-guest-* label 豁免）、pet.rs（桌宠）、browser_guests/（#118
    侧边栏浏览器 guest 载体：DesktopBrowserBridge 桥 + 子 webview 管理 + client 侧
    webview 标签兼容层对应命令）
  - src/process/ —— 子进程：lifecycle.rs（spawn/stdout/stderr 转发）、probing.rs（探活）、
    plugin.rs（插件注入物化）、stderr_buf.rs（stderr 环形缓冲，退出通知用）、worker.rs（per-profile dsh 进程 worker：句柄唯一持有者 + 全壳唯一 spawn 入口，latest-wins epoch；重启/切 Profile/守护器自愈全经它）
  - src/network/ —— proxy.rs（代理）、web_token.rs（process token/cookie）、remote.rs（远程访问）、
    notify.rs（任务通知服务）、forwarder.rs
  - src/runtime/ —— 运行时核心：state.rs（DshState + STATUS_*/MODE_* 常量）、phase.rs（#135 后仅留说明注释）、error.rs、
    builtin.rs + builtin/（内置 Node/dsh 启动器）、registry.rs（运行时目录/回收站）、instances.rs（实例台账）、paths.rs
  - src/download/ —— 下载管理器（#72）：manager/commands/model/persist/transfer
  - src/navigation/mod.rs —— 就绪导航等待（token→cookie→200 三步）
  - 根级：settings.rs（desktop-settings.json 读写）、commands.rs（IPC 命令）、profiles.rs（profile 管理）、platform.rs（open_external）
  - capabilities/ —— default.json（主窗本地）、pet.json（桌宠）、remote-desktop.json（远程页 ACL；
    dsh 页面 origin 是 127.0.0.1:308x，remote origin 强制 ACL，自命令须两文件都 allow）
  - permissions/app-commands.toml —— 应用自命令权限清单
- mobile/ —— 手机访问（设计稿 docs/mobile-access-design.md）
  - dsh-mobile-access/ —— 手机访问服务（host+client 半区）：改写反代、配对/控制路由、
    SSE、cloudflared 隧道；host apply(ctx) 随 dsh 装载启动 lane；client.js = 设置「手机访问」Tab
  - shell-web/ —— 浏览器 H5 壳纯逻辑（parsePairInput/buildEnterUrl/createPairStore，被 Expo/Harmony 移植）
  - dsh-mobile-nav/ —— 上游移动布局插件 dsh-web-mobile 的 git 子模块（.gitmodules；mexiaosqwq/dsh-web-mobile，当前 v3.0.3，MIT；测试 npm run test:core；CI checkout 需 submodules: recursive）
  - expo-app/ —— Android/iOS 原生壳（Expo/RN，用户确认的技术栈；src/lib/pair.ts 为逻辑源）
  - harmony/ —— 鸿蒙壳源码骨架（ArkTS + ArkWeb，需 DevEco 编译）
- docs/ —— 设计与审计；docs/desktop-guardian-profile-remote-design.md 为托盘三件套设计稿；docs/mobile-access-design.md 为移动端设计稿，原型见 docs/prototypes/；docs/agents/ 为 agent 协作文档
- .github/workflows/release.yml —— tag v* 双平台构建 + draft release + 自动 release notes
- SKILL.md / README.md —— README 面向人类（安装/特性/实测状态），SKILL.md 为技能包正文；二者的架构
  描述与代码冲突时以代码为准（README 已于 2026-09-24 重写对齐 --patch 注入 + 局部 chrome）。

## 手机访问（mobile）关键契约

- 三种访问身份：属主（同机 loopback 直连 lane、无 X-Forwarded-For）＝控制端点
  （mint/devices/stop/events/probe）放行；已配对设备（隧道 + 会话 cookie）＝代理全量；
  匿名（隧道）= 仅 /pair 与 /api/pair/accept。反代 auth 无路径前缀豁免（防归一化绕过）。
- lane 改写反代默认 127.0.0.1:3091（settings.yaml dsh-desktop-tauriapp: lane_port，env
  DSH_MOBILE_LANE_PORT 优先）；桌面 spawn dsh 时注入 DSH_MOBILE_LANE_PORT /
  DSH_MOBILE_ENABLED / DSH_DESKTOP_PORT / DSH_CLOUDFLARED_BIN。
- WS 空闲保活：lane 反代对 upgrade 后的 WebSocket 空闲时在帧边界注入 ping（防中间代理空闲
  超时揧断 dsh /api/remote.mux 复用长连接——手机端「连接异常」循环的对策）；pong 超时判死主动
  断开触发 dsh 客户端快速重连。settings.yaml dsh-desktop-tauriapp: ws_keepalive_ms（ping 间隔
  ms，0=关闭，默认 15000）、ws_pong_timeout_ms（判死超时 ms，默认 10000），改动重启 lane 生效。
- 桌面三包注入链路：build.rs staging 内嵌（desktop + dsh-mobile-access + dsh-web-mobile）
  → materialize 挂共享池 → desktop-plugin-inject.yml（运行时写入 app 数据目录）三行 --patch。
 - 设备会话持久化：$DSH_HOME/storages/mobile-access/pairing.json（0600），重启后设备表恢复，手机无需重扫（前提手机侧会话 cookie 未丢；该 cookie 无 Max-Age，浏览器/WebView 清掉则需重新配对）。
 - 测试：mobile-access `npm test`（node 53 例，含 WS 空闲保活帧泵 7 例）、shell-web 3 例、
   dsh-mobile-nav `npm run test:core` 191 例、expo-app `npm test`（vitest 8 例）；cargo test 94 例；
   桥契约仿真（#118 guest 载体，手动）：
   `desktop/scripts/bridge-contract/run.sh` 产测试页，读 window.__RESULTS__ 期望 22/22 PASS。

## 已知注意事项（血泪坑）

1. settings.yaml 键名：持久化用 $DSH_HOME/settings.yaml 顶层键 dsh-desktop-tauriapp:。
   绝不要写 desktop:（历史 bug：save/load 键不一致导致配置失效与互相覆盖；已有
   legacy_desktop_block 迁移 + 保存清理）。当前实现整体 serde_yaml 回写会丢注释，
   若 dsh 配置出现注释需改行级合并。
2. spawn 参数顺序：--patch 必须排在 --no-open / --host / --port 之前（dsh CLI
   passThrough 会把靠后的 --patch 透传给 web-app 报 unknown option）。
3. 单实例约束（#82/#93 修正）：同一 profile 的 dsh web 同时只能一个——同 HOME
   同 profile 双实例会互污共享状态，绝对禁止；但「task-board ledger 全局锁」的
   旧说法不准确（实为进程内锁），不同 profile 实例可并存（多窗口，#89）。
   已有外部实例时 web profile 走「复用/兼容」路径，其它 profile 端口被占则提示不代拉。
4. 守护器判活：健康=TCP 连接成功即可（勿改回 HTTP 判死——会因 EOF/慢响应误重启，
   曾引发无限自愈循环）；复用外部/远程只提示不代拉；自愈 3 次封顶。
5. 远程页面 IPC：Tauri 2.11 对 remote origin 强制 ACL，应用自命令也需在
   remote-desktop.json 显式 allow；远程高级模式需远程已装本插件（navigate_remote 有预检提示）。
6. Windows：本地无 windows 编译目标（交叉 cargo check 被 tauri-winres 需 llvm-rc、externalBin 缺
   dsh-node-*.exe 挡死），Windows 编译/产物只能靠 CI 把关；cfg(windows) 分支在本机被编译掉，
   分支内引用的参数名绝不能带下划线前缀（write_shim 的 _win_body → E0425，v0.10.0 CI 才爆），
   新增 Windows 代码须静态核对接口签名（webview2-com-sys bindings 为准）；open_external 走
   ShellExecuteW（windows-sys 已启用 Win32_UI_Shell / WindowsAndMessaging）。
7. 本地 dmg 打包时常失败（bundle_dmg.sh，hdiutil 残留挂载），.app 不受影响，dmg 以
   CI 产物为准；失败时 hdiutil detach 清理 bundle/macos/rw.*.dmg 再试。
8. 注入样式慎用 hash 类名：dsh 各 client 包的 css module 类名随版本漂移；优先用稳定标记
   （role/aria、data-*），例：设置弹窗 tab 列滚动修复即用 role=dialog + nav 结构定位。
9. webview 会话建立链本机/远程必须同构，勿只改一边：换 cookie（SameSite=Lax 原生种入）→ 服务端
   验证已落库 → 导航**不带 token 的根路径**。dsh 对带 token 参数的 URL 优先走 token 校验分支，
   webview 跨站 303 链过不去（浏览器能过）→ cookie 已种入仍 401（#136 终局；navigation/mod.rs 注释）。
10. 内置运行时的依赖树安装（profile 初始化/迁移、运行时下载）必须一次写齐 pnpm-workspace.yaml 四项：
   packages:[]（截断向上 workspace 搜索）/ nodeLinker: hoisted（平铺、与内置树同构）/ storeDir
   （#114 独立 store）/ allowBuilds 白名单（PNPM_ALLOW_BUILDS 单一常量）——pnpm 10+ 以 yaml 为准，
   .npmrc 的 node-linker/store-dir 在 pnpm 11 被无视（实测落 isolated 布局 + 全局 store）；且内置
   node 是 sidecar（名 dsh-node），pnpm 生命周期脚本按 `node` 名找解释器，须造垫片目录并前置 PATH
   （runtime/registry.rs，含单测）。

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo; use the `gh` CLI for all operations. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one optional `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Project memory

Agent 侧项目记忆即本文件；知识变更审计日志见 `docs/CHANGELOG-MEMORY.md`，共享词汇表见 `CONTEXT.md`；
设计与审计长文在 `docs/`（`docs/agents/` 为 agent 协作说明）。
