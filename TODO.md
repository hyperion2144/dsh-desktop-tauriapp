# TODO / Roadmap

> 发布后的收尾与后续方向。完成项勾选后随 commit 更新。
>
> **状态：历史文档（0.4.0 时代，最后维护于 2026-08-20）**——下方清单已不代表当前状态：
> Rust 单测、Windows 合流与 CI 产物等条目早已完成或已变化。当前路线图以 GitHub issues 为准，
> 发布内容见 `CHANGELOG.md`，项目记忆见 `AGENTS.md`。

## 质量与合流

- [ ] **补 Rust 单元测试**：探测逻辑（find_dsh_bin / find_node / find_dsh_bin_js）、
      `version_key` semver 排序、端口就绪判断、SpawnError 分类——目标是 CI 可跑
- [ ] **Windows 侧最终合流**：让 Windows 机器拉取本仓库 0.4.0+ 代码重跑
      acceptance.ps1，确认 mac 仓库代码在 Windows 实测通过（消除"两线代码"状态）
- [ ] **Releases 补 Windows 产物**：0.4.0 的 .msi / -setup.exe 上传至 Releases

## 已实现（0.4.0）

- [x] **任务完成通知修复**：修掉 0.3.0 三处硬伤——① 通知桥补 CORS（OPTIONS +
      Access-Control-Allow-* 头，否则浏览器 preflight 直接拦截）；② 注入脚本从
      setup 提前注入改为"导航完成后注入"（冷启动不再随加载页销毁）；③ busy 检测
      从扫描"停止"文案（编译产物 0 次，永远判不出）改为 `data-state="ongoing"`
      运行中标记
- [x] **桌宠（透明置顶小窗）**：鲸鱼娘漂浮桌宠，CSS 呼吸/漂浮动画 + 椭圆阴影，
      JS 手动拖拽（4px 阈值区分点击）、左键唤起主窗、右键菜单（显示主窗/穿透开关/
      隐藏/退出）、任务完成气泡（pet-say 事件）、位置持久化（pet.json 多屏钳位 +
      400ms 防抖）、托盘"显示/隐藏桌宠"项、window-state 插件 denylist 排除 pet

## 已知限制（遗留）

- [ ] **品牌注入刷新丢失**：窗口内 Cmd+R 刷新后样式还原，需 webview on_page_load
      钩子自动重注入（同时可把任务监听脚本也改为 on_page_load 重注入，更稳）
- [ ] **任务通知仍是 DOM 启发式**：0.4.0 已从"扫文案"升级为 `data-state` 标记，
      但仍分不清"成功/失败/被停/超限"、拿不到标题/token/耗时。权威信号是 DSH 的
      `turn/end` 会话事件（reason 六种），升级方案见 docs/next-tasks.md 第五节
- [ ] **托盘点击验收**（Windows 无头环境未实测）：需要真机手工确认
- [ ] **桌宠 macOS 打包后透明丢失风险**：tauri issue #13415（open），dev 正常、
      `tauri build --bundles dmg` 后透明可能丢失，需真机双验
- [ ] **防睡眠开关**：方案见 docs/next-tasks.md 第二节（caffeinate /
      SetThreadExecutionState + 托盘勾选项），尚未实现

## 生态化（可选方向）

- [x] **dsh.bundle 化改造**：已做成 `dsh plugin add` 可安装的 bundle（index.js +
      cordis.patch.yml + package.json dsh.bundle），npm 发布 0.3.0，awesome-dsh-plugin
      收录（PR #695 已合并，dsh-market 自动聚合）
- [x] **插件市场机会盘点**：docs/plugin-market-desktop-opportunities.md（审批/提问
      通知、截图问DeepSeek Harness Desktop Desktop、托盘状态中心、预定任务+防睡眠、通知气泡等，含完整对照表）
- [ ] **中文技术社区文章**：《把 DeepSeek Harness 包成桌面应用》实操文
      （掘金/知乎/B 站），挂仓库链接
- [x] **图像理解接入**：dsh-vision-router 插件已安装并验证（页面注入 ✓，视觉工具
      已挂载，OVH 免费链 + 可选自有视觉模型）
