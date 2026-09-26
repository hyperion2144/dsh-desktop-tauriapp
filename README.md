# DeepSeek Harness Desktop（dsh-desktop-tauriapp）

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![npm](https://img.shields.io/npm/v/dsh-desktop-tauriapp)](https://www.npmjs.com/package/dsh-desktop-tauriapp)

> 主人好呀～ 这是 **DeepSeek Harness Desktop**：把 DeepSeek Harness 的 Web GUI 封装成 macOS / Windows 桌面应用——**内置运行时开箱即用**（无需自己装 Node 和 dsh）、托盘常驻、多 profile 多窗口、退出自动回收子进程。
> 一键安装：`dsh plugin add dsh-desktop-tauriapp`（npm）或 `dsh plugin add github:hyperion2144/dsh-desktop-tauriapp`（GitHub）。

> **来源与致谢**：本仓库 fork 自 [happpsee/dsh-desktop-app](https://github.com/happpsee/dsh-desktop-app)，现由 [hyperion2144/dsh-desktop-tauriapp](https://github.com/hyperion2144/dsh-desktop-tauriapp) 独立演进维护；感谢原作者的开创性工作。

## 主要看点

1. **内置运行时，零前置依赖**：Node sidecar + dsh 依赖树随安装包分发，双击即用；也可随时切换到自己装的外部 `dsh`
2. **多 profile、多窗口**：每个 profile 独立端口与实例，托盘一键开新窗 / 就地切换；手机访问经 lane 反代跟随焦点窗口
3. **桌面化体验**：插件式桌面 chrome（macOS 原生红绿灯 / Windows 自绘标题栏）、任务完成通知、鲸鱼娘桌宠、下载管理器、侧边栏浏览器 guest 载体（#118）
4. **国内网络友好**：rustup / cargo / npm / GitHub / NSIS 全套镜像配置与「哨兵」超时判定，Windows 无管理员工具链方案（见 [skill/](skill/) 与 [docs/](docs/)）

## 安装

### 直接下载（推荐）

从 [Releases](../../releases) 下载对应平台安装包：

| 平台 | 产物 |
|---|---|
| macOS（Apple Silicon） | `DeepSeek.Harness.Desktop_<版本>_aarch64.dmg` |
| Windows | `DeepSeek.Harness.Desktop_<版本>_x64_zh-CN.msi`（或 `_x64-setup.exe`） |

macOS 首次打开若非公证版本，需右键「打开」；Windows 网络下载的 exe 可能触发 SmartScreen 提示（本地构建不触发）。

### 从源码构建

```bash
npm run build:client        # 先构建插件 client（lib/client.js）
cd desktop && npm install
npm run build               # 等价 tauri build：macOS 出 .app/.dmg，Windows 出 .msi/.exe
```

内置 dsh 运行时由 `desktop/scripts/prepare-builtin-runtime.mjs` 准备（版本在脚本顶部 `BUILTIN_DSH_VERSION` 精确 pin，pnpm 亦精确 pin；本地与 CI 一致可复现）：

```bash
node desktop/scripts/prepare-builtin-runtime.mjs --variant latest   # 装内置依赖树 + Node sidecar
node desktop/scripts/prepare-builtin-runtime.mjs --variant latest --skip-node   # 只重装依赖树
```

发布链：提交 → 三处升版本（`package.json` / `desktop/src-tauri/tauri.conf.json` / `desktop/src-tauri/Cargo.toml`）→ `git tag vX.Y.Z && git push` → CI 双平台构建并出 draft release → `gh release edit vX.Y.Z --draft=false --latest`。

### 作为 DSH 插件 / 技能使用

```bash
# DSH 插件（npm / GitHub）
dsh plugin add dsh-desktop-tauriapp
dsh plugin add github:hyperion2144/dsh-desktop-tauriapp

# 技能包（Claude Code / Claude Agent 兼容格式）
cp -r skill ~/.claude/skills/dsh-desktop-tauriapp
# DSH：复制到所运行 profile 的 skills 目录后加载 dsh-desktop-tauriapp 技能
```

## 特性

### 运行时与进程

- **内置运行时（默认）**：Node 24 sidecar + dsh 依赖树随包分发，经内部 API 代码路径启动（不走 CLI）；也可切换外部 dsh CLI（`DSH_BIN` → PATH → npm 全局）
- **运行时版本管理**：应用内下载 / 切换 / 卸载 dsh 运行时版本（目录源可配 github / npm）；托盘「运行时版本」子菜单——已装点击即切，未装点击 = 下载→自动切换，全程系统通知反馈；内置版本可直接切回
- **进程守护**：连接级健康探测（TCP 连不上才判异常），异常自动回启动页重建，自愈 3 次封顶（持续健康 ≥2 分钟才重置计数）；复用外部实例/远程只提示不代拉
- **单实例 + 窗口状态记忆 + 退出回收**：重复双击聚焦已有窗口；位置大小自动恢复；只回收本次 spawn 的子进程，stdout/stderr 落盘日志

### 多 profile 与多窗口

- **per-profile 端口**：`web=3080`、`desktop=3081`，其余散列分配并持久化；设置页可改
- **全新安装默认 `desktop` profile**（存量用户保持 `web`）；`desktop` 非 dsh 出厂模板，经 `--from-default-profile` 初始化
- **托盘 Profile 分组**：聚焦已有窗口 / 在新窗口打开 / **就地切换本窗口的 profile** / 新建 / 全量迁移 A→B（排除锁与临时文件、符号链接感知、覆盖前备份）
- **lane 反代跟随焦点窗口**：3091 稳定接入点指向焦点实例，手机侧零改动

### 桌面化体验

- **桌面 chrome（插件式局部注入）**：由内置插件的 client 在标准布局内注入局部拖拽区/状态条（不禁用 stock ui-layout）——macOS 用 `titleBarStyle: Overlay` 保留原生红绿灯；Windows 用 `decorations: false` 自绘标题栏按钮；配色随主题 token
- **托盘常驻**：关闭窗口仅隐藏，托盘左键唤起、菜单退出，拦截 Cmd+Q 防误退；托盘含「重启 dsh 服务」「切换 Profile（本窗口）」「运行时版本」「dsh 服务地址」「本地端口…」「显示/隐藏桌宠」
- **任务完成通知**：监听会话「忙碌→空闲」翻转，结束时 Dock 角标 +1；窗口失焦时弹系统通知（前台不打扰），回窗口自动清零；三平台通知权限 best-effort 申请并统一落日志
- **鲸鱼娘桌宠**：透明置顶无边框小窗（纯 CSS 动画）、拖拽移动、左键唤起主窗、右键菜单（穿透/隐藏/退出）、任务完成弹气泡、位置记忆（多屏钳位）
- **外链策略（对齐 dsh 官方桌面语义）**：新窗请求（`window.open` / `target=_blank`）→ 系统默认浏览器（应用内不开新窗）；异源顶层导航 → 阻止；`mailto:` / `tel:` → 系统。会话内链接的路由由 dsh 自己做（侧边栏/新标签），宿主不插手
- **下载管理器**：blob/data 下载拦截 + 管理 Tab（分块写入、进度、完成通知）
- **启动控制台**：加载页实时显示 dsh 子进程 stdout/stderr，可展开/收起/清空，启动失败直接看原因
- **系统代理**：system 模式读系统设置（含凭证），manual 模式手填；壳侧所有网络（目录拉取、运行时下载、文件下载）统一走代理
- **健壮定位**：Finder/资源管理器启动的 GUI 无终端 PATH，内置 nvm / npm-global / npx / Homebrew / 非标准盘符多级兜底探测

### 设置与维护

- **设置页区块**：dsh 来源（内置/外部，切换立即接管）· dsh 服务地址（本地/远程）· Profile · Profile 端口 · 迁移 Profile · dsh 运行时（下载/切换/卸载）· 下载 · 代理设置 · **依赖状态** · 手机访问
- **依赖状态自检与一键重建**：dsh 的插件安装/卸载由内置 pnpm 执行，其 store 大版本必须与 profile 的 `node_modules` 一致；面板列出各 profile 记录的 pnpm / 内置版本 / 是否需重建（运行中禁重建），壳启动时后台检查，不一致仅弹提示、由用户手动重建（#124 起不再自动重建）
- **诊断**：webview 控制台镜像到 `$DSH_HOME/dsh-desktop-webview.log`，应用日志在 `~/Library/Logs/com.arcreel.dsh-desktop-tauriapp/`

## 仓库结构

```
src/client/   本仓库作为 dsh 插件的浏览器半区（esbuild → lib/client.js）
desktop/      Tauri 2 桌面壳（Rust，macOS + Windows）；scripts/ 含运行时准备与验收脚本
mobile/       手机访问（dsh-mobile-access 服务 + Expo 原生壳 + 鸿蒙骨架）
skill/        Claude/DSH 兼容技能包（SKILL.md + resources/ + Windows 实战笔记）
docs/         设计与审计文档（含 Windows 无管理员实测报告）
lib/          插件 client 构建产物（随包分发）
```

## 移动端壳（Android / iOS / 鸿蒙）

仓库 `mobile/` 下有手机访问壳（配对桌面 dsh 后进入 WebView 使用）：

| 平台 | 目录 | 构建/发布 |
|------|------|-----------|
| **Android + iOS** | `mobile/expo-app/`（Expo/RN 共用一套代码） | **随 GitHub CI 自动出包**：Android `app-debug.apk`（可直接安装）、iOS `DeepSeek.ipa`（未签名，用 [AltStore](https://altstore.io) 等免费签名侧载） |
| **鸿蒙** | `mobile/harmony/`（ArkTS + ArkWeb） | **不随 CI 发布**——需本地 DevEco Studio 构建 + 华为账号签名，见 [mobile/harmony/README.md](mobile/harmony/README.md) |

本地构建移动端：

```bash
# Android APK
cd mobile/expo-app
npm ci
npx expo prebuild -p android
cd android && ./gradlew assembleDebug   # 产物 app/build/outputs/apk/debug/app-debug.apk

# iOS IPA（未签名）
npx expo prebuild -p ios
cd ios && pod install
xcodebuild -workspace DeepSeek.xcworkspace -scheme DeepSeek -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
# 打包 Payload/DeepSeek.app → DeepSeek.ipa
```

## 平台实测状态

| 平台 | 状态 |
|------|------|
| macOS | ✅ 实测（内置/外部/受限 PATH 三条验收路径全绿） |
| Windows | ✅ 实测（Win11 无管理员环境完整构建+打包+验收，见 [docs/windows-audit-report.md](docs/windows-audit-report.md)） |
| Android | ✅ 实测（模拟器 + 真机安装运行） |
| iOS/iPad | ✅ 实测（模拟器 + AltStore 侧载） |
| 鸿蒙 | ✅ 实测（Mate 80 RS 真机扫码配对 + 浅色主题） |

## 许可

- 代码与文档：**MIT**（见 [LICENSE](LICENSE)）
- 应用图标来源：`/Applications/DeepSeek Harness.app/Contents/Resources/icon.icns`（复用已安装客户端原图以保证一致）
- 鲸鱼娘素材：CC BY-NC-SA 4.0 非商用素材随仓库保留（`skill/resources/whale-girl-LICENSE.txt`）
- 另请注意：DeepSeek 鲸鱼为官方商标，本应用是非官方客户端

## 已知限制

- **任务完成通知**为 DOM 启发式（监听 `data-state` 运行中标记），分不清成功/失败/被停，拿不到标题与 token；权威信号的语义化升级见 docs/
- **桌宠**：macOS 打包（DMG）后透明可能丢失（tauri issue #13415，dev 正常）；置顶仅 Floating 级、盖不过全屏应用；Cmd+Tab 会出现桌宠条目（`skipTaskbar` 仅 Windows 生效）
- **未签名分发**：macOS 非公证包需右键打开（`xattr -cr "/Applications/DeepSeek Harness Desktop.app"` 可解）；Windows 网络下载的 exe 触发 SmartScreen
- **安装包体积**：内置运行时（Node 24 + dsh 依赖树）使 macOS dmg 约 200 MB 量级，Windows msi 约 240 MB
- **侧边栏浏览器**：dsh 官方按 profile 名开关（仅 `desktop` profile 默认启用）；web profile 需在自己的 `cordis.patch.yml` 里 opt-in。宿主已实现独立 webview guest 载体（v0.10.0，[#118](https://github.com/hyperion2144/dsh-desktop-tauriapp/issues/118)）：侧边栏浏览器改为同窗子 webview，不再受 macOS 上 iframe 导航被守卫取消的影响
