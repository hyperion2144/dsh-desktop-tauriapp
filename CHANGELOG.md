# Changelog

本项目所有显著变更记录于此。发布版本的 release notes 从本文件「已发布」段生成。

## 未发布（分支验证中，待实机确认后随下版发布）

- **AI 解读路由修复（#96）**：dsh 目录 provider（如 minimax-cn）的解读改由 dsh 进程内 llm 服务发起（宿主新 RPC `/dsh-desktop-fuse-explain`）；custom 仍走壳 Rust；其它 provider 直达 Rust 时明确报错不再静默错路由
- **系统代理模式隐藏 no_proxy 输入（#102）**：system 模式下后端读系统设置，编辑无效故隐藏并加来源说明；凭证两模式都生效（拼入代理 URL）保持可编辑
- **目录拉取失败降级（#107 + 补）**：目录拉取失败时不再清空列表——已下载版本仍可见/可切换/可卸载并显示失败提示；**降级列表同时纳入内置版本**（原先拉取失败时内置行消失，无法切回内置）
- **壳侧网络统一走代理（#108）**：运行时目录拉取、运行时下载（pnpm 子进程）、应用文件下载均经 `app_client_builder`（系统/手动代理与凭证一致），修复公司代理下 401
- **外部链接分流（#109，含三次修正）**：会话内链接按 dsh 的 linkOpening 分流到右栏浏览器；**仅 desktop profile**（壳经 environment 下发窗口真实 profile，并支持就地切换后按绑定表反查）；**仅会话内容区**（设置弹窗/面板/其它插件 UI 一律系统浏览器）；**抑制同一次点击的双开**（平台 `target=_blank` 新窗绕过 preventDefault 时不再同时弹系统浏览器）
- **卸载运行时不再冻结界面（#110）**：`remove_runtime` 改 async + spawn_blocking；卸载中按钮禁用并显示「卸载中…」
- **中键点击外链恒走系统浏览器（#111）**：与左键分流解耦（中键 = 明确的外部打开意图）
- **侧边栏「在浏览器打开」恢复（#112）**：window.open 覆盖恒转系统（侧边栏分流仅归左键 click 路径）
- **内置版本可直接切换（#113）**：内置行标「内置」，当前使用时显示「使用中」；切内置写 `dsh_runtime: null`
- **下载/卸载运行时不再触发 dsh 插件 rebuilt（#114）**：dsh 客户端插件 rev = sha1(mtime|ctime|size)，pnpm store 与运行树 hardlink 共享 inode → 下载写 store / 卸载删 link 都会改元数据触发重载白屏。修复：运行时安装用独立 store（`runtimes/.pnpm-store`）+ 卸载改 rename 到 `runtimes/.trash`（真实删除推迟到下次启动）
- **profile 迁移依赖重建修复（#115）**：①CI=true 下 pnpm 默认 frozen-lockfile 致迁移失败（三处 install 显式 `--no-frozen-lockfile`）②迁移重建 PATH 被 `join_paths` 静默清空致 pnpm 解析 git 依赖报 `spawn git ENOENT`（改 split_paths + git 候选目录兜底）
- **手机访问隧道地址保存落盘（#116）**：原先写已废除的 dsh settings 命名空间/settings.yaml（保存看似成功实则丢失）；改读写 `$DSH_HOME/desktop-settings.json`（Rust DesktopSettings 补 tunnel_url/ws_* 字段，防其读改写丢弃）
- **点号路径设置保存修复**：`save_desktop_settings` 的 merge 把 `profile_ports.desktop` 当字面顶层键 → 反序列化静默丢弃 → Profile 端口保存无效；新增递归写入（含单测）
- **托盘「切换 Profile（本窗口）」（#117）**：就地切换当前聚焦窗口的 profile（区别于「在新窗口打开」）；不可行时明确提示且不改绑；主窗切换同步并持久化激活 profile；同时移除设置页重复且显示错误的「本地端口」区块
- 保险丝面板 AI 解读 loading 文案改为显示当前设置的模型（原硬编码 deepseek-v4-flash 与实际路由不一致）
- **下载图标兼容 dsh 0.1.7 重命名（#103）**：`IconDownloadOutline16 ?? IconDownloadOutlineRegular` 双名 fallback，修复 0.1.7 下下载按钮消失与 Tab 标题空白
- **运行时版本卸载入口（#104）**：设置页已下载版本列表加卸载按钮（二次确认；使用中/内置灰置+tooltip），复用 #95 既有 remove_runtime，后端零改动
- **手机布局包升级 v3.0.1（#105）**：dsh-web-mobile submodule v2.3.0 → v3.0.1（0.1.6/0.1.7 宿管适配、系统返回退出、文件手势、图标跨代兼容、真机修复）


## 已发布

### v0.9.1（2026-09-22，覆盖重发含托盘切换与签名修复）

#### 新增（#80 地图全量落地 14 张子票 + #98）

- **内置运行时**：Node 24 sidecar + dsh 依赖树随包分发（resources 只读直跑），默认内置、可选外部 CLI（DSH_BIN → PATH → npm 全局）
- **per-profile 端口模型**：web=3080 / desktop=3081 / 其余散列分配并持久化；实例四态认领；保险丝 stderr 按 profile 分桶
- **全新安装默认 desktop profile**（存量用户保持 web）；desktop 非 dsh 出厂模板，经 `--from-default-profile` 初始化
- **profile 全量迁移 A→B**：排除锁/临时/cordis.yml/.dsh-module-fallback、符号链接感知复制、overwrite 备份
- **多窗口与托盘多开**：托盘 PROFILE 分组（聚焦/开新窗/新建/迁移）、窗口↔实例绑定、次实例运行期监督与轻量保险丝
- **设置 Tab 三区块**：dsh 来源（切换立即接管）/ Profile 端口 / 迁移
- **lane 反代跟随焦点窗口**：3091 稳定接入点 → 焦点实例 lane，手机侧零改动
- **运行时管理**（#95）：应用内下载/切换 dsh 运行时版本（github/npm 目录源）
- **托盘直接切换 dsh 运行时版本**（#98）：托盘「运行时版本」子菜单——内置/已装点击即切换，未装点击 = 下载→自动切换；全程通知反馈（开始下载/下载中进度节流推送/切换重启/✅ 启动完成）

#### 修复

- 保险丝设置保存 405：宿主 RPC 已随 #95 拆除，client 改走 Tauri IPC（`get/save_quarantine_settings`），Rust 真正落盘；去掉 provider 白名单
- 壳配置正位：`$DSH_HOME/desktop-settings.json` 单一源（原 app_data 双源收敛）
- builtin 检查路径写错导致「切换内置没反应」静默回退——改显式系统通知
- **macOS CI 包「已损坏，无法打开」**（覆盖重发修复）：`.app` 缺 bundle 级签名（无 `_CodeSignature/`）+ sidecar `dsh-node` 未签，带 quarantine 的下载包 Gatekeeper 校验必败（「任何来源」不豁免签名完整性）。修复：`signingIdentity: "-"` ad-hoc 完整签名。旧包解法：`xattr -cr "/Applications/DeepSeek Harness Desktop.app"`
- **AI 解读路由修复（#96）**：选 dsh 目录 provider（如 minimax-cn）时，解读改由 dsh 进程内 llm 服务发起（路由/密钥/端点单一事实源，宿主新 RPC `/dsh-desktop-fuse-explain`）；custom（自定义端点/密钥）仍走壳 Rust，deepseek 保持默认路由；其它 provider 直达 Rust 命令时明确报错，不再静默打到 api.deepseek.com

#### 工程

- 安装包单变体（PR #97）：#95 运行时管理落地后废弃 latest/alpha 双包，bootstrap 固定 latest，产物名去变体后缀

### v0.9.0（2026-09-18）

- #72 下载管理器（blob/data 拦截 + 管理 Tab）；右键下载、外部链接接管等桌面化体验

### v0.8.x（2026-09-13 ~ 09-16）

- 多窗口布局与 lane 转发器基础（#94 前身）、远程页面 ACL、手机访问修链、桌宠与托盘体验迭代

### v0.7.x（2026-09-10 前）

- 插件保险丝（#58/#59）、启动自愈与状态机、Windows 工具链、README/验收脚本体系
