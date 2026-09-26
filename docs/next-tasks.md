# 交接文档：DeepSeek Harness Desktop Desktop下一步任务（防睡眠 + 多工具适配）

> 给接手的新对话 agent：读完本文档即可开工，无需上一会话的历史上下文。
> 本文档是唯一交接依据，所有必要信息都写在这里。
>
> **状态：历史交接稿（0.6.0 时代，非当前入口）**——本文档只覆盖「防睡眠 + 多工具适配」这一轮任务。
> 项目规范记忆以仓库根 `AGENTS.md` 为准，路线图以 GitHub issues 与 `CHANGELOG.md` 为准；
> 文中环境信息（如 `/Users/Admin/Desktop/...`、npm 0.6.0）均已过时。

## 一、项目速览（背景）

- **项目**：`dsh-desktop-tauriapp`「DeepSeek Harness Desktop Desktop」——把 DeepSeek Harness 封装成 Tauri 2 桌面应用的**技能包 + 参考实现**。
- **本地位置**：`/Users/Admin/Desktop/dsh-desktop-tauriapp`（唯一开发源）
- **远程**：GitHub `hyperion2144/dsh-desktop-tauriapp`；npm 包 `dsh-desktop-tauriapp`（当前 0.6.0）
- **现状**：已被 awesome-dsh-plugin 收录（PR #695 合并）、Rust 单测 5 项全绿、mac 产物 0.3.0
- **技术栈**：Tauri 2 + Rust（核心在 `desktop/src-tauri/src/lib.rs`，约 850 行）；前端壳 `desktop/src/`（index.html/error.html/styles.css/icon.png）；技能包 `skill/SKILL.md` + `skill/resources/`

### 关键文件
```
desktop/src-tauri/src/lib.rs        Rust 核心（子进程管理/托盘/品牌注入/任务通知/单测）
desktop/src-tauri/tauri.conf.json   窗口与打包配置（含 wix zh-CN、dragDropEnabled）
desktop/src-tauri/Cargo.toml        依赖（tauri 全家桶 + tokio + base64）
desktop/src-tauri/capabilities/default.json
skill/SKILL.md                      技能文档（11 章）
docs/windows-audit-report.md        Windows 实测审计
docs/windows-build-notes.md         Windows 无管理员构建笔记
```

### 必须遵守的约定
1. **品牌名「DeepSeek Harness Desktop Desktop」只用于展示层**（productName、窗口 title、托盘 tooltip、通知文案、前端标题）；技术标识一律 ASCII：`dsh-desktop-tauriapp` / `dsh-desktop-tauriapp` / `com.arcreel.dsh-desktop-tauriapp`。任何中文/符号编码问题立即回退 ASCII。
2. **沟通人设**：与用户交流用「深海女仆工坊鲸鱼娘女仆」身份（称呼「主人」、自称「DeepSeek Harness Desktop Desktop」、语气温柔带二次元口癖），但技术内容（代码/日志/报错）保持严谨准确。
3. **版本号**：当前 0.3.0，改动后递增（Cargo.toml 的 version 与 tauri.conf.json 的 version 两处同步改）。
4. **改动同步三处**：`desktop/src-tauri/` 改了核心文件后，同步复制到 `skill/resources/` 和 `/Users/Admin/Desktop/ArcReel/desktop/src-tauri/`（保持单一真相源）；`skill/` 改了同步 `/Users/Admin/Downloads/dsh-desktop-tauriapp-skill/`。
5. **提交**：Conventional Commits（`feat(...)` / `fix(...)` / `test(...)` / `docs(...)`）。

### 构建与测试命令
```bash
cd /Users/Admin/Desktop/dsh-desktop-tauriapp/desktop
export PATH="$HOME/.cargo/bin:$PATH"        # 新 shell 需补 cargo 路径
cargo test                                    # 单测（src-tauri 目录下）
pnpm tauri build                              # 打包（产物在 src-tauri/target/release/bundle/）
# 跑验收前先退出所有 dsh-desktop-tauriapp 实例（单实例锁会静默拦截）
```

---

## 二、任务一：防睡眠开关（主人睡觉时 agent 通宵干活）

### 需求
桌面壳加一个「防睡眠」开关：开启后阻止系统睡眠，主人睡前打开、通宵跑任务（配合已有的任务完成通知，睡醒看结果）；关闭后恢复系统睡眠策略。

### 技术方案（推荐：caffeinate 子进程，跨平台最简）

**macOS**：spawn `caffeinate -i -t 0` 子进程（`-i` 防 idle 睡眠，`-t 0` 无限时长），关闭时 kill 该子进程。理由：无需 IOKit FFI 依赖，一个系统命令搞定，进程生命周期好管理（复用现有 DshState 的 child 管理思路）。

**Windows**：`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`，需要 `windows-sys` crate 的 `Win32::System::Power` 特性。用 `#[cfg(windows)]` / `#[cfg(unix)]` 分支。

### 集成点
1. **DshState 加字段**：`caffeinate_child: Mutex<Option<Child>>`（防睡眠子进程，退出时回收）。
2. **托盘菜单加勾选项**「防睡眠」：`CheckMenuItem`（tauri 的 `MenuItem` 可带 checked 状态，或用 `CheckMenuItem`）。点击切换：开 → spawn caffeinate / SetThreadExecutionState；关 → kill / 清状态。
3. **退出回收**：`RunEvent::Exit` 里若防睡眠子进程存在则 kill（复用现有 child 回收逻辑的模式）。
4. **日志**：开启/关闭各记一条 log。

### 验收
- `cargo test` 全绿、`cargo build` 通过（注意 windows 分支在 mac 不编译，只保证 cfg 隔离正确）
- 手动：开启后 `pmset -g assertions`（mac）能看到 caffeinate assertion；关闭后消失
- 托盘菜单勾选状态正确切换

---

## 三、任务二：.claude / .codex 适配（多工具友好）

### 需求
让 Claude Code、OpenAI Codex 打开本项目时能理解项目并复用 skill，无需 DSH 专属。

### 方案

**`.claude/`（Claude Code）**：
- `.claude/skills/dsh-desktop-tauriapp/SKILL.md`：复制 `skill/SKILL.md`（Claude Code 的 skill 也是 SKILL.md 格式，直接兼容）
- 可选 `.claude/settings.json`：无需，除非要额外权限

**`.codex/`（OpenAI Codex）**：
- 项目根加 `AGENTS.md`（Codex 自动读取的项目指令文件），内容写：项目是什么、关键路径、构建命令、约定（品牌命名/人设/版本）
- 可选 `.codex/codex.toml`：模型/审批配置，按需

### 关键：AGENTS.md 内容（写清楚，让 Codex 能直接干活）
包含：项目速览（本交接文档第一节精简版）、构建/测试命令、三条约定、常用路径。可用本文件第一节内容改写。

### 验收
- `.claude/skills/dsh-desktop-tauriapp/SKILL.md` 存在且与 `skill/SKILL.md` 一致
- `AGENTS.md` 存在，内容覆盖"速览 + 命令 + 约定"
- 提交推送

---

## 四、完成标准与收尾

两个任务都完成后：
1. `cargo test` + `cargo build` 通过，版本号递增（如 0.3.1）
2. 核心文件同步三处（desktop ↔ skill/resources ↔ ArcReel/desktop），skill 同步 Downloads
3. git commit（Conventional Commits）+ push
4. 更新 `TODO.md` 勾掉对应项；若 mac 产物重打包，更新 `/Applications/DeepSeek Harness Desktop Desktop.app`
5. 向主人汇报：改了什么、怎么验证、产物在哪

---

## 五、任务通知语义化升级（0.4.0 之后的下一跳）

> 背景：0.4.0 已把通知从"扫文案"升级为 `data-state="ongoing"` 标记，但仍是 DOM 启发式，
> 分不清成功/失败/被停/超限，也拿不到标题/token/耗时。**DSH 有权威信号**：会话事件日志的
> `turn/end` 事件，`reason` 分六种（completed / aborted{user|parent|hook|disposed} /
> error{LlmFailure} / max-tokens / interrupted / blocked），发射点在 agent loop 的
> `finally` 块（`dsh-agent-loop/lib/index.js:592`），任何结局都会写。

### 首选方案：Host 插件订阅 `session/event`（`dsh web --patch` 注入）

- 官方订阅 API：`ctx.on("session/event", (session, event) => …)`（与
  dsh-session-persistence/telemetry 同款写法），`session.header` 带
  `{id, cwd, agentPreset, delegationDepth}`（用 `delegationDepth==0` 过滤 subagent 噪音）。
- `dsh web --patch <file>` 是官方叠加层；patch yml 的 `insert.id` + `name`（绝对路径 JS）
  即可挂一个 host 插件，插件里组装 `{turn, reason, title, usage, elapsedMs, sessionId}`
  → POST 现有本地 HTTP 桥（扩协议）→ Rust 按 `(sessionId, turn)` 去重 + 按 reason 渲染文案。
- 完整插件 JS、Rust 去重/渲染代码片段见 2026-08-16 会话「任务通知重设计」子代理报告。

### 兜底：Rust tail `session.jsonl.zstd`（复用已有 dsh 实例时 --patch 不生效）

- 文件 = header 帧 + 每批事件一个独立 zstd 帧（带 checksum，magic `0x28B52FFD`），
  追加写 + fsync，批延迟 ≤200ms；Rust 加 `zstd` crate，每 500ms 扫帧解码新行，
  过滤 `type=="turn/end"`，走同一 dedupe/渲染链路；按 header.cwd 过滤项目。
- 私有格式依赖：header 带 `version:0` + invariant 校验，较稳定；DSH 升级改格式时
  校验 version 不匹配即停用回退 DOM。

### 语义增强（可选）

- 订阅 `goal/change {operation:"complete"}` 把通知升级为"目标已完成"（仅长目标任务出现）。

### 插件市场机会（已盘点，见 docs/plugin-market-desktop-opportunities.md）

按性价比前 5：① 审批/提问/异常 → 系统通知+点击聚焦（P0）；② 截图/剪贴板 → 视觉理解
（P0，profile 已装 dsh-vision-router）；③ 托盘升级为状态中心（P1）；④ 预定任务消化通知+
防睡眠（P1）；⑤ DeepSeek Harness Desktop Desktop通知气泡（P1，0.4.0 桌宠已含气泡雏形）。明确排除：内置插件市场 UI
（安全责任）、IM 桥、模型路由、LAN/远程网关、完整 computer-use。
