# Changelog

本项目所有显著变更记录于此。发布版本的 release notes 从本文件「已发布」段生成。

## 未发布

（无——当前主干即 v0.9.1 覆盖重发内容，见下）


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
