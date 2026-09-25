# Changelog

本项目所有显著变更记录于此。发布版本的 release notes 从本文件「已发布」段生成。

## 未发布

- **托盘运行时菜单支持切换到外部 dsh（#126）**：托盘「运行时版本」原先只有 内置版本 / 已下载版本 / 目录下载项，切外部 dsh 只能进设置页；且托盘选中标记只看版本不看来源，外部来源下仍显示「● 内置」。修复：①把「外部 dsh」当成运行时列表里的又一个同级单选条目（紧跟「内置 …」，探测不到就不列——与已下载版本一样「存在才列出」）②`switch_runtime` 参数化目标来源（`DshMode`），点击外部条目写设置页同一份 `dsh_mode` 配置并重启；**切来源不改写 `dsh_runtime`**（切回内置可恢复上次选中的下载版本）③选中标记 ● 跟随当前生效来源，external 下内置/已装一律 ○④来源回退补成双向对称：外部 dsh 不可用时启动回退到**随包内置**运行时（非「已下载版本优先」那棵）并通知，不再直接落到「未找到 dsh 命令」错误页；回退只作用于本次运行不改写设置（与既有「内置不可用→回退外部」对称）⑤`DshMode` 补 `as_str()` 收敛字符串映射（`get_dsh_source` 去重）。新增 3 个菜单条目单测（外部可用/不可用 × 来源 builtin/external），cargo 118 全绿
- **运行时下载失败修复（#135，共三层）**：托盘/设置页「下载并切换 dsh x.y.z」连续暴露三个问题，逐层修复。**第一层**：`pnpm add` exit 1 `[ERR_PNPM_IGNORED_BUILDS]`——两条装依赖树路径的 pnpm 配置漂移：profile 侧 yaml 带 `allowBuilds` 白名单而运行时下载没有；pnpm 钉到 11.16.0（#119）后对未批准构建脚本直接 exit 1。**第二层**：白名单生效后构建脚本真跑起来，报 `sh: node: command not found`——内置 node 是 sidecar（文件名 `dsh-node`），旧逻辑前置 sidecar 目录到 PATH，脚本按 `node` 名字找解释器必然落空（pnpm 10 时代脚本不执行从未暴露）。**第三层**：下载能完成但启动报 `Cannot find module '@deepseek-ai/dsh-app-boot'`——pnpm 10+ 配置以 `pnpm-workspace.yaml` 为准，`.npmrc` 的 `node-linker=hoisted` 在 pnpm 11 被无视（`.modules.yaml` 实落 `isolated` 布局，顶层只有直接依赖），且 `store-dir` 同样被无视直接写进全局 store（9.8G，违反 #114 隔离）。修复：①白名单收敛为单一常量 `PNPM_ALLOW_BUILDS` 三处统一引用②运行时下载的 `pnpm-workspace.yaml` 抽 `runtime_workspace_yaml(store_dir)` 一次写齐 pnpm 11 必需四项：`packages: []`（截断向上搜 workspace）/ `nodeLinker: hoisted`（平铺同构内置树）/ `storeDir`（#114 独立 store）/ `allowBuilds`（白名单）；`.npmrc` 保留仅兼容旧 pnpm③`node_shim_dir` 垫片：运行时根目录造 `node` 硬链指向 sidecar 并前置 PATH（Windows 回退拷贝）④托盘重复触发（`restarting` 互斥窗口内连点）从静默吞掉改为弹「正在重启 / 切换中」提示——验证反馈错误页期间连点毫无反馈像卡死⑤新增单测锁定 yaml 四项关键配置与垫片提供 `node` 命令。cargo 121 全绿

## 已发布

### v0.9.4（2026-09-24）

- **Windows 内置运行时启动失败修复（#123，发布阻塞级）**：v0.9.3 在 Windows 上内置模式完全不可用——Tauri 的 `resource_dir()` 返回带 `\\?\\` verbatim 前缀的扩展路径，原样传给 dsh-launcher.mjs 后 `pathToFileURL` 生成无效 URL，所有 `profile-boot*.js` 候选 import 静默失败（空 catch 吞错）→ `runProfile not found`。修复：①新增 `runtime/paths.rs` 统一归一入口（`deverbatim` 去 `\\?\\`/`\\?\\UNC\\` 前缀；`resources_dir` / `resources_dsh_root`）②全部 10+ 个把资源路径传给 Node/子进程的消费点接入（launcher 链路、pnpm shim/cjs 三处、bin.js 定位两处、运行时下载安装、bundle 补链、内嵌插件目录三处），顺带消除三处内联重复统一走 `pnpm_cjs_path` ③launcher.mjs 入口纵深防御归一（Rust 侧已归一，兑底防新增调用点遗漏）④候选 import 空 catch 改为打印真实失败原因（本次排障最大摩擦点就是错误被吞）⑤新增 3 个 deverbatim 单测；cargo 113 全绿。macOS 不受影响（无此前缀概念，归一为直通）
- **启动时依赖自动重建改为仅提示（#124）**：#122 引入的启动后台自动重建在实际环境不可靠且不必要（外部 pnpm 与内置只差小版本时也触发；重建链路在某些平台问题下不生效则每次启动重复）。修复：①启动块删除自动重建，大版本不一致时仅弹提示（引导去设置页「依赖状态」手动重建，入口 #122 已有）②不一致判据由精确版本放宽为 pnpm **大版本**——对齐 ERR_PNPM_UNEXPECTED_STORE 的真实机制（storeDir 含 v<major>，小版本差异 store 同代、根本不触发该错误），小版本差异不再提示不再重建；附 major 判据单测


### v0.9.3（2026-09-23）

- **内置运行时升级到 dsh 0.1.7-rc.1（对齐官方 RC）**：`prepare-builtin-runtime.mjs` 的内置 dsh 版本改为**精确 pin**（顶部 `BUILTIN_DSH_VERSION`，支持 `--dsh-version` 临时覆盖），不再跟随 npm 的浮动 `latest` tag——此前 `latest` 指向旧的 0.1.5-rc.3，使内置树长期落后于官方 RC。本地与 CI 共用同一脚本，内置版本从此一致且可复现
- **依赖状态命令的 ACL 修正**：新增的 `list_profile_dependency_status` / `rebuild_profile_dependencies` 原先只加进 `capabilities/default.json`，而本壳页面 origin 是 `http://127.0.0.1:308x`（Tauri 视作 remote origin）→ 实际生效的 `remote-desktop.json` 未授权 → 面板报「读取失败：Command … not allowed by ACL」。修复：两个 capability 同步补齐（`remote.urls` 仅本机回环，本机维护类命令加入也安全）；`default.json` 窗口范围同时扩为 `["main", "profile-*"]`
- **依赖状态失败不再吞错**：读取失败时把真实原因显示在面板并写 console（原提示「仅桌面壳可用」会掩盖 ACL/命令错误）
- **诊断**：`get_desktop_client_environment` 记录实际窗口 label，便于定位 ACL 类问题

### v0.9.2（2026-09-23）

本版集中修复桌面壳体验与三类链路问题：外链路由（回归官方语义）、配置持久化（隧道地址/端口保存）、运行时依赖（pnpm store 一致性），并新增依赖状态自检、托盘 Profile 切换与面板错误边界。

- **AI 解读路由修复（#96）**：dsh 目录 provider（如 minimax-cn）的解读改由 dsh 进程内 llm 服务发起（宿主新 RPC `/dsh-desktop-fuse-explain`）；custom 仍走壳 Rust；其它 provider 直达 Rust 时明确报错不再静默错路由
- **系统代理模式隐藏 no_proxy 输入（#102）**：system 模式下后端读系统设置，编辑无效故隐藏并加来源说明；凭证两模式都生效（拼入代理 URL）保持可编辑
- **目录拉取失败降级（#107 + 补）**：目录拉取失败时不再清空列表——已下载版本仍可见/可切换/可卸载并显示失败提示；**降级列表同时纳入内置版本**（原先拉取失败时内置行消失，无法切回内置）
- **壳侧网络统一走代理（#108）**：运行时目录拉取、运行时下载（pnpm 子进程）、应用文件下载均经 `app_client_builder`（系统/手动代理与凭证一致），修复公司代理下 401
- **链接处理回归官方语义（#109 收尾，方案 A）**：**删除 client 侧全部自创外链逻辑**（`external-links.ts` 整文件：click/中键 capture、window.open 覆盖、双开抑制、profile/区域门控、会话区探针）——会话内链接的侧边栏路由本就是 **dsh 自身**做的（chat openExternalLink → sidebarRight.openTab），宿主不插手。壳只守两条边界（对齐 dsh 官方 Electron 桌面 `apps/desktop/src/main.ts:210-281`）：**新窗请求（window.open / target=_blank）→ 系统浏览器 + 应用内不开新窗**；**异源顶层导航 → 阻止**（官方为“阻止+系统浏览器”，按用户要求只阻止，避免 frame-busting 把用户甩走）。一并修掉自创层带来的误拦（web profile / 设置弹窗）、双开、解锁沙箱被甩到浏览器等一串问题
- **卸载运行时不再冻结界面（#110）**：`remove_runtime` 改 async + spawn_blocking；卸载中按钮禁用并显示「卸载中…」
- **中键点击外链 → 系统浏览器（#111）**：现由平台新窗钩子统一接管（不再需要 client 侧独立分支）
- **侧边栏「在浏览器打开」→ 系统浏览器（#112）**：同上，由新窗钩子接管（原 client window.open 覆盖已随方案 A 移除）
- **内置版本可直接切换（#113）**：内置行标「内置」，当前使用时显示「使用中」；切内置写 `dsh_runtime: null`
- **下载/卸载运行时不再触发 dsh 插件 rebuilt（#114）**：dsh 客户端插件 rev = sha1(mtime|ctime|size)，pnpm store 与运行树 hardlink 共享 inode → 下载写 store / 卸载删 link 都会改元数据触发重载白屏。修复：运行时安装用独立 store（`runtimes/.pnpm-store`）+ 卸载改 rename 到 `runtimes/.trash`（真实删除推迟到下次启动）
- **profile 迁移依赖重建修复（#115）**：①CI=true 下 pnpm 默认 frozen-lockfile 致迁移失败（三处 install 显式 `--no-frozen-lockfile`）②迁移重建 PATH 被 `join_paths` 静默清空致 pnpm 解析 git 依赖报 `spawn git ENOENT`（改 split_paths + git 候选目录兜底）
- **手机访问隧道地址保存落盘（#116）**：原先写已废除的 dsh settings 命名空间/settings.yaml（保存看似成功实则丢失）；改读写 `$DSH_HOME/desktop-settings.json`（Rust DesktopSettings 补 tunnel_url/ws_* 字段，防其读改写丢弃）
- **点号路径设置保存修复**：`save_desktop_settings` 的 merge 把 `profile_ports.desktop` 当字面顶层键 → 反序列化静默丢弃 → Profile 端口保存无效；新增递归写入（含单测）
- **托盘「切换 Profile（本窗口）」（#117）**：就地切换当前聚焦窗口的 profile（区别于「在新窗口打开」）；不可行时明确提示且不改绑；主窗切换同步并持久化激活 profile；同时移除设置页重复且显示错误的「本地端口」区块
- 保险丝面板 AI 解读 loading 文案改为显示当前设置的模型（原硬编码 deepseek-v4-flash 与实际路由不一致）
- **dsh 自带插件卸载/安装报 ERR_PNPM_UNEXPECTED_STORE（#119）**：内置模式下壳给 dsh 的 PATH 是用户登录 shell 的 PATH（含 /opt/homebrew/bin），dsh 的插件管理裸调 `pnpm` 时命中**系统 pnpm**（实测 11.16.0，store/v11），而 profile 的 node_modules 由内置 pnpm（10.34.5，store/v10）安装 → store 大版本不匹配直接拒绝操作。修复：内置模式下把**仅含 pnpm 的 shim 目录**（`runtime/bin-pnpm`）**前置**到 dsh 的 PATH——pnpm 钉回内置 pnpm.cjs（store 一致），但**不劫持 node**（用户项目仍用登录 PATH 的 node；实测系统 v26 与内置 v24 不同版本）
- **插件保险丝面板空白（#120）**：`QuarantineDetail` 作用域内引用了不存在的 `settings`（其为 `FusePanel` 的 state）→ 渲染即 `ReferenceError: Can't find variable: settings` → React 卸载整棵树致面板全空。修复：`explainModel` 改由 `FusePanel` 通过 prop 传入；同时保留面板错误边界（异常直接显示可读错误 + 写入应用日志）
- **保险丝面板 AI 解读无限 loading（#121）**：走 dsh 路由的解读链路（宿主 RPC → `llm.stream`）宿主侧与前端均无超时——provider 无响应时 `await next()` 永不返回，面板一直「AI 解读中」且无任何可诊断信息。修复：宿主侧改为逐次 `next()` + `Promise.race` 看门狗（45s 无新数据即收尾并报「模型无响应（已收到 N 个数据块）」）+ `[fuse-explain]` 过程日志（provider/model/块数/字数）；前端 `rpc.call` 加 75s 超时兜底
- **依赖状态 + 内置 pnpm 升级（#122）**：dsh 的插件安装/卸载由**内置 pnpm** 执行，它的 store 大版本决定 profile 依赖能否被操作——历史遗留（web 由系统 pnpm 11 装、desktop 由内置 pnpm 10 装）导致切换 profile 后总有一方报 `ERR_PNPM_UNEXPECTED_STORE`。修复：①`prepare-builtin-runtime.mjs` 把浮动的 `pnpm@10` 改为**精确 pin `pnpm@11.16.0`**（与既有 web profile 的 store/v11 对齐；同时构建可复现，不再随构建时间漂移小版本）②设置页新增**「依赖状态」**区块（各 profile 记录的 pnpm / 内置版本 / 是否需重建 / 运行中禁重建 + 一键重建）③壳启动后台检查：不一致且未运行 → 自动用内置 pnpm 重建并通知；运行中的 profile 只提示不重建（避免破坏运行实例的 node_modules）
- **下载图标兼容 dsh 0.1.7 重命名（#103）**：`IconDownloadOutline16 ?? IconDownloadOutlineRegular` 双名 fallback，修复 0.1.7 下下载按钮消失与 Tab 标题空白
- **运行时版本卸载入口（#104）**：设置页已下载版本列表加卸载按钮（二次确认；使用中/内置灰置+tooltip），复用 #95 既有 remove_runtime，后端零改动
- **手机布局包升级 v3.0.1（#105）**：dsh-web-mobile submodule v2.3.0 → v3.0.1（0.1.6/0.1.7 宿管适配、系统返回退出、文件手势、图标跨代兼容、真机修复）



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
