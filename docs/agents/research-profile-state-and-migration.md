# dsh profile 状态构成与迁移语义研究报告

> 来源票：wayfinder map #80 / research 票 #83「研究：profile 状态构成与迁移语义」
> 调研日期：2026-09-19；本机实测平台：macOS 26（Apple Silicon）
> 调研路径：本机 `~/.dsh/profiles/<name>` 实测 + dsh 安装源码 `which dsh` = `/opt/homebrew/bin/dsh`（即 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`）+ 桌面壳现有 `desktop/src-tauri/src/profiles.rs` & `commands.rs` & `settings.rs` & `process/quarantine/ledger.rs`
> 目标：盘点 dsh profile 的完整状态构成 → 划定「所有东西」的真实边界 → 给出「复制 profile」的安全操作序列

---

## TL;DR（一句话结论）

「把 A profile 的所有东西复制到 B profile，得到等价环境」**可达成**，但「所有东西」≠ `~/.dsh/profiles/A/` 整目录拷贝。完整等价的 A→B 迁移需要：

1. 复制 `$DSH_HOME/profiles/A/{package.json, pnpm-lock.yaml, pnpm-workspace.yaml, cordis.yml, cordis.patch.yml, node_modules/, .plugin-manager/, .dsh-module-fallback/, <dot-plugin-data-dirs>}` 到 `$DSH_HOME/profiles/B/`，**排除** `.plugin-manager/logs/`、`.plugin-manager/lock*`、`.dsm-market/snapshots/`、`*.lock`、`*.tmp`、`*.swp`、macOS 资源叉 `._*`、`node_modules/.cache/`、`node_modules/.pnpm-store/`、pprof 类大临时文件；
2. **不复制**任何 HOME 级状态：session 账本（`storages/session_projcache/`）、会话事件日志（`sessions/`）、任务看板账本（`task-board/`）、记忆（`memory/`）、配额账本（`.dsh-usage-*.json`）、视觉工具缓存（`cache/dsh-vision-toolkit/`）、`.credentials.yaml`、`settings.yaml`、`cordis.patch.yml`（HOME 层）、手机配对（`storages/mobile-access/`）、壁纸（`.dsh-any-background-data/`）、托盘隔离台账（`dsh-desktop-tauriapp/quarantine.json`）——这些是 HOME 全局、跨 profile 共享，不属于「profile 的东西」；
3. **直接拷贝 node_modules 可行但脆弱**——`.bin` 是相对符号链接（portable），`.pnpm/.pnpm-store/` 在 macOS 上是 content-addressable 硬链接池（portable），但 `.dsh-module-fallback/node_modules/*` 是**绝对路径符号链接**（不 portable）；`@deepseek-ai/*` 等 first-party bundle 走 `resolveBundleDir` 的「installation-first」优先级，源机器的 dsh 安装路径会写进目标机器的 `installAnchor` 解析；
4. **停机时序**：迁移前必须停 active_profile 实例（或任何正在使用该 profile 的 dsh web 进程）；目标 profile 已存在时只能走「合并/覆盖前确认」，因为 dsh 的 `loadProfile()` 对同名 profile 不会重建 manifest（只有 `initProfile()` 会），但 `initProfile()` 会拒绝已存在路径；
5. **无缝切换 = 迁移完成 + 写 `active_profile=B` + restart_dsh_in_mode**：cordis 启动时按 `prepareProfile()` 流程重新生成空的 `cordis.yml`（dsh 源码注释明确：root 永远被重写），所以 copy 完 cordis.yml 也无害；pnpm 锁文件随包迁移而不需重 install。

---

## 1. profile 内部构成（`$DSH_HOME/profiles/<name>/`）

下表为**实测**目录 + 对应代码出处。判定列说明该路径是 per-profile 还是 HOME 全局。

| 路径 | 类型 | 作用 | 判定 | 关键代码/来源 |
|------|------|------|------|---------------|
| `package.json` | 文本 | profile manifest；`dsh.profile.bundles` 数组声明层叠的 bundle 顺序；`dependencies` 列插件；postinstall/postuninstall 钩子 | **per-profile** | `dsh-app-boot/lib/index.js:393-408` `initProfile()` 写 manifest 模板；本机 `~/.dsh/profiles/web/package.json` 见 39 个 `dsh.profile.bundles` 条目 |
| `cordis.yml` | 文本 | profile 的 cordis root config（**永远只有 `[]`** —— dsh 启动时按 bundle+patch 栈重新生成） | **per-profile（生成态）** | `dsh/lib/profile-boot-BNu17Y9U.js:121-127, 188` `PROFILE_ROOT_CONFIG = "[]"`；`prepareProfile()` `writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)` |
| `cordis.patch.yml` | 文本 | profile 自有的 user patch layer（在 bundles 之后、HOME patch 之前、`--patch` 之前叠加）；用户自定义的 disable/insert/override | **per-profile** | `dsh-app-boot/lib/index.js:341` `PROFILE_PATCH_FILENAME = "cordis.patch.yml"`；`loadProfileDirectory()` lines 929-936 读 `existsSync(patchPath) && options.userLayer !== false` 时挂入 |
| `pnpm-workspace.yaml` | 文本 | profile 的 pnpm workspace 配置（`nodeLinker: hoisted`、`allowBuilds` 白名单、版本放行） | **per-profile** | `dsh-app-boot/lib/index.js:380-385` `PROFILE_PNPM_WORKSPACE` 模板 |
| `pnpm-lock.yaml` | 文本 | pnpm 锁文件（lockfileVersion 9.0；记录每个 dependency 的 codeload tarball URL 或 registry version） | **per-profile** | 本机 `~/.dsh/profiles/web/pnpm-lock.yaml` lockfileVersion: '9.0'，165 KB |
| `node_modules/` | 目录 | pnpm hoisted 安装的实际插件包；`.bin/` 是相对符号链接到 `../<pkg>/bin/`；`.pnpm/` 是 pnpm 内部 store + lock | **per-profile（核心安装）** | dsh plugin-manager 通过 pnpm 写入；`dsh-app-boot/lib/index.js:659-690` `healProfilesModuleFallback` |
| `node_modules/.bin/<cmd>` | 符号链接 | 插件暴露的 CLI（如 `beauticode-dsh`、`dsh-cost-meter-repair-sessions`、`dsh-mnemon-repair-session`） | **per-profile** | 本机 `~/.dsh/profiles/web/node_modules/.bin/beauticode-dsh` → `../beauticode-dsh/bin/beauticode-dsh`（**相对路径**，portable） |
| `node_modules/.pnpm/` | 目录 | pnpm content-addressable store；里头每个包是硬链接到 `~/.local/share/pnpm/store/v3/files/<hash>`（macOS pnpm 8+ 默认） | **per-profile（数据）** | pnpm 自己管理；硬链接指向 `$HOME/.local/share/pnpm/store`（**HOME 全局 cache**，与 DSH_HOME 无关） |
| `.dsh-module-fallback/` | 目录 | profile 私有的 module fallback 链接池（`node_modules/<pkg>` 为 dsh-owned 安装包符号链接，路径是绝对指向 `$DSH_HOME/profiles/<name>/node_modules/<pkg>`） | **per-profile**（但含绝对路径，不 portable） | `dsh-app-boot/lib/index.js:252` `PROFILE_MODULE_FALLBACK_DIR = ".dsh-module-fallback"`；本机 `~/.dsh/profiles/web/.dsh-module-fallback/node_modules/@antfu/install-pkg -> /Users/mutou/.dsh/profiles/web/node_modules/@antfu/install-pkg` |
| `.plugin-manager/logs/` | 日志 | dsh plugin-manager 每次 `plugin add/remove` 写 `operation-<random>/pnpm.log`（含完整 pnpm 输出） | **per-profile**（可排除） | `dsh-plugin-manager/lib/index.js:80-86` `logRoot = join(dir, ".plugin-manager", "logs")` |
| `.plugin-manager/operation-*/pnpm.log` | 日志 | 每次 plugin 操作的完整输出（栈追踪、错误、--registry metadata） | **per-profile**（**迁移排除**） | 同上 |
| `.dsh-market/` | 目录 | dsh-market 插件私有数据：`state.json`、`snapshots/`、`discovery-compatibility-v1.json`、`log.ndjson`、`presets.json` | **per-profile** | `~/.dsh/profiles/web/node_modules/dshmarket/lib/presets.js:60-78` `presetsFile(profileDir) = join(profileDir, '.dsh-market', 'presets.json')` |
| `.dsh-market/snapshots/` | 目录 | 插件市场快照；可能很大（按需缓存） | **per-profile**（可考虑排除重建） | 同上 plugin 实现 |
| `.dsh_hashline_edittool/hash-store.sqlite` | sqlite | hashline 编辑工具存储（SQLite 单文件） | **per-profile** | 本机实测 `~/.dsh/profiles/web/.dsh_hashline_edittool/hash-store.sqlite` |
| `.mnemon/` | 目录 | mnemon 插件私有：默认 `runtime` 子目录（mnemon runtime memory 来源于 HOME `.mnemon/`，但 plugin 数据本身在 profile 内） | **per-profile（plugin-owned 视图层）** | 本机实测 `~/.dsh/profiles/web/.mnemon/` 存在 |
| `.dsh-mattskillsdeck-cache/` | 缓存 | mattskillsdeck 插件的本地缓存（按依赖项目分目录） | **per-profile**（可排除，重建无害） | 本机实测 `~/.dsh/profiles/web/.dsh-mattskillsdeck-cache/` 5 个子目录 |
| `.dsh-pending-updates.json` | 文本 | plugin-manager 待更新清单（`packages: [{ packageName, version }, ...]`） | **per-profile** | 本机实测 `~/.dsh/profiles/web/.dsh-pending-updates.json` |
| `thinking-effort-loaded.json` | 文本 | `dsh-thinking-effort` 插件最近一次 apply 事件记录 | **per-profile** | 本机实测 |
| `.dsh-mattskillsdeck-cache/<project-key>.json` | 文本 | mattskillsdeck 缓存每项目一个 JSON | **per-profile** | 同上 |

**关键观察**：

- profile 的「身份」主要落在 `package.json`（bundles + dependencies）+ `cordis.patch.yml`（用户叠加）；其他都是这两个源派生出来的「运行时/缓存态」。
- `cordis.yml` 永远是 `[]`，由 `prepareProfile()` 在每次启动时**重写**——这意味着迁移该文件是「无害的」；但反过来，**目标 profile 已存在的 `cordis.yml` 不应保留**旧的（即便 dsh 会覆盖，留它也是噪声）。
- `.plugin-manager/logs/` 是**纯诊断日志**（操作历史），不是状态——迁移应排除；保留它会无谓膨胀目标 profile。

---

## 2. profiles 目录之外但语义上相关的状态

下表覆盖 `profiles/` 之外、与 profile 关系密切、迁移时**容易误以为属于 profile**的状态。判定列明确给出每项是 per-profile 还是 HOME 全局。

| 路径 | 作用 | 判定 | 迁移策略 | 关键代码/来源 |
|------|------|------|----------|---------------|
| `$DSH_HOME/cordis.patch.yml` | HOME 级 user patch layer，**每个** profile 启动时都被叠加（`readProfilePatches()` 排在 profile patch 之后、`--patch` 之前） | **HOME 全局** | **不迁移**（它跨 profile 共享；用户级偏好应在 HOME 而非 profile） | `dsh-app-boot/lib/index.js:1005-1016` `readProfilePatches`；`profile-boot-BNu17Y9U.js:115-117` `homePatchPath()` |
| `$DSH_HOME/settings.yaml` | dsh 设置（含 dsh 启动参数、`plugins:` 列表、自定义配置） | **HOME 全局** | **不迁移** | `dsh-app-boot/lib/index.js:649` `mirrorModuleFallbacks`；desktop 壳写 `settings.yaml` 的 `dsh-desktop-tauriapp:` 顶层键 |
| `$DSH_HOME/settings.yaml` 下的 `dsh-desktop-tauriapp:` 块 | 桌面壳设置：`active_profile`、`port`、`lane_port`、`cloudflared_bin`、`proxy_*` 等 | **HOME 全局**（属于桌面壳，不是 profile） | **不迁移** | `desktop/src-tauri/src/settings.rs:10-53` `DesktopSettings`；`active_profile` 由桌面壳管 |
| `$DSH_HOME/.credentials.yaml` | 凭证 ref（refs） + grant records（`client-connection/browser-session` 等）；AI 密钥 ref 也存这里 | **HOME 全局** | **不迁移**（凭证跨 profile 共享，否则切换 profile 要重新登录） | `desktop/src-tauri/src/network/ai.rs:5-92`；本机实测 `~/.dsh/.credentials.yaml` 含 7 个 API key refs |
| `$DSH_HOME/storages/` | JSON-backed KV 存储的根（base bundle 配 `storage-json` 的 `root: dshHomePath('storages')`）；每个 plugin 通过 `storage-domain` 打开自己的 domain 表 | **HOME 全局** | **不迁移**（`storages` 整个目录跨所有 profile 共享） | `dsh-base/cordis.patch.yml:148-164` `storage/storage-json root: dshHomePath('storages')` |
| `$DSH_HOME/storages/session_projcache/` | 会话投影缓存（每次会话的 checkpoint JSON） | **HOME 全局** | **不迁移** | 同上 + `session-projection-cache` line 165-174 |
| `$DSH_HOME/storages/<domain>/<key>.json` | 各插件自管 domain 表：`cost-meter/ledger.json`、`downloads/tasks.json`、`mobile-access/pairing.json`、`session_projcache_archive_manager_v2/sessions/...` | **HOME 全局** | **不迁移** | 本机实测 `storages/` 含 5 个 domain |
| `$DSH_HOME/sessions/` | JSONL 会话事件持久化根（`@deepseek-ai/dsh-session-persistence-jsonl` 配置 `root: dshHomePath('sessions')`）；按项目路径 base62 编码分桶，每个会话一目录 `session.v3.jsonl.zstd` + `.lock` | **HOME 全局** | **不迁移** | `dsh-base/cordis.patch.yml:117-120` `session-persistence-jsonl root: dshHomePath('sessions')` |
| `$DSH_HOME/storages/session_projcache.json` | 单文件投影注册表（兼容旧版） | **HOME 全局** | **不迁移** | 本机实测 22 MB |
| `$DSH_HOME/task-board/` | dsh-task-board 的 Host 权威账本：`ledger-v2.json`、`ledger-v2.lock`（PID 锁，**未启动实例时可能残留**）、`scheduler-v2.json` | **HOME 全局** | **不迁移** | `~/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/index.js:1572` `constructor(dir = join(dshHome(), "task-board"), ...)`；`2121-2148` lockFile + PID 检查 |
| `$DSH_HOME/cache/` | dsh 通用缓存根；`cache/dsh-vision-toolkit/` 含 Python runtime、UV cache、python-bootstrap、home、uv-cache 子目录 | **HOME 全局** | **不迁移**（重建成本低；vision-toolkit 自己管） | `~/.dsh/profiles/web/node_modules/@anionex/dsh-vision-toolkit/lib/runtime-install.js:698-702` `visionToolkitStateRoot() = join(base, 'cache', 'dsh-vision-toolkit')` |
| `$DSH_HOME/cache/dsh-openpencil/` | dsh-openpencil 的本地 cache | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/cache/vision-router/` | vision-router 的本地 cache | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/.mnemon/` | mnemon runtime memory 来源（`MEMORY.md` / `USER.md` hot memory） | **HOME 全局** | **不迁移**（mnemon 用户身份/偏好跨 profile） | mnemon runtime memory 配置；不参与 profile 切换 |
| `$DSH_HOME/memory/memory.db` | mnemon 当前 Memory Body 主库（`@deepseek-ai/dsh-mnemon` 后端 SQLite） | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/.dsh-usage-ledger.json` + `.bak` | dsh 用量台账 | **HOME 全局** | **不迁移** | 本机实测 752 KB + .bak |
| `$DSH_HOME/.dsh-usage-stats.json` + `.bak` | dsh 用量统计 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/.dsh-usage-reconcile.json` | dsh 用量对账 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/skin-center/` + `skin-center-active.json` | dsh-skin-center 插件主题仓库（图片、配置）；`active.json` 标记当前激活主题 | **HOME 全局** | **不迁移**（跨 profile 共享主题） | 本机实测 |
| `$DSH_HOME/dsh-pet/` | dsh-pet 桌宠数据 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/mobile-access/` + `mobile-access.log` | dsh-mobile-access 内部态（不是 `storages/mobile-access/`） | **HOME 全局** | **不迁移** | `~/.dsh/profiles/web/node_modules/dsh-mobile-access/lib/settings.mjs:11` `home = process.env.DSH_HOME \|\| path.join(os.homedir(), '.dsh')` |
| `$DSH_HOME/storages/mobile-access/pairing.json` | 移动访问设备配对（0600 权限） | **HOME 全局** | **不迁移**（设备关系跨 profile） | `dsh-mobile-access/lib/pairing.mjs:14` `path.join(..., 'storages', 'mobile-access', 'pairing.json')` |
| `$DSH_HOME/.dsh-any-background-data/` | `theme-config.json` + `wallpaper.mp4`（deepseek-harness-background 插件的壁纸数据） | **HOME 全局** | **不迁移** | 本机实测 8 MB wallpaper.mp4 |
| `$DSH_HOME/.dsm-mattskillsdeck-cache/` | mattskillsdeck 的全局缓存（注：profile 目录里也有同名子目录，是同一插件分别缓存） | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/deepseek-harness-background/` | deepseek-harness-background 插件的某些额外数据 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/telemetry/` | dsh-telemetry 插件数据 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/attachments/` | 全局附件 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/rewind-snapshots/` | dsh-rewind-plugin 快照 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/skills-manager/` | dsh-skills-manager 全局仓库索引 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/sessions/.../session-*.lock` | JSONL 会话锁（活动写入者持有） | **HOME 全局**（per-会话） | **不迁移**（运行态锁，且不跨 profile） | `dsh-session-persistence-jsonl/lib/index.js:667` `path = join(dir, LEASE_FILENAME)` |
| `$DSH_HOME/data/` | 一些插件私有数据 | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/bin/` | dsh 安装级别的可执行（如 `cloudflared` 镜像） | **HOME 全局** | **不迁移** | `~/.dsh/profiles/web/node_modules/dsh-mobile-access/lib/cloudflared.mjs:41-43` |
| `$DSH_HOME/profiles/node_modules/` | **共享** module fallback 池：所有 profile 共享的 dsh 安装依赖 closure（绝对路径符号链接到 dsh 安装的 `node_modules`） | **HOME 全局但 per-安装**（所有 profile 共用；不可拆分） | **不迁移**（dsh 启动时按 installAnchor 重生） | `dsh-app-boot/lib/index.js:659-690` `healProfilesModuleFallback`；line 649-655 注释明确：`$DSH_HOME/profiles/node_modules mirrors the dsh installation dependency closure` |
| `$DSH_HOME/.anonymous-user-id` | dsh-anonymous-user-id 插件分配的匿名用户 ID | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/.dsh-viewer-asset-key` | dsh-viewer 插件的 asset key | **HOME 全局** | **不迁移** | 本机实测 |
| `$DSH_HOME/dsh-desktop-tauriapp/quarantine.json` | 桌面壳的隔离台账（按 profile 名分桶；profile `web` 里有 `dsh-subagent-pro` 等被隔离的插件） | **HOME 全局**（按 profile 字段分桶） | **不迁移**（属于桌面壳运维；旧 profile 的隔离记录带不到新 profile） | `desktop/src-tauri/src/process/quarantine/ledger.rs:33-42` `Ledger { version: 1, profiles: BTreeMap<String, Vec<QuarantineEntry>> }`；`ledger_path = base.join("dsh-desktop-tauriapp").join("quarantine.json")` |

**总结**：「profile 的所有东西」**严格落在** `$DSH_HOME/profiles/<name>/` 内 + dsh 安装自身（`which dsh`）。HOME 下所有其他目录都是跨 profile 共享的应用态——**不参与「profile 迁移」**，由对应插件自己管。

---

## 3. 迁移安全时序

### 3.1 必须先停对应实例

**结论：必须。** 原因：

1. `cordis.patch.yml` 在 profile 启动时被 `loadProfileDirectory()` 读进 patch 栈（`dsh-app-boot/lib/index.js:929-936`），运行期由 Loader 持有；中途改动源文件可能让 patch 状态不一致。
2. `package.json` 在 plugin-manager 启动时 `readProfileManifest()`（`dsh-app-boot/lib/index.js` `readProfileManifest`），中途覆盖 manifest 等同于让 pnpm 在错的依赖图上继续操作。
3. `.plugin-manager/lock` / `.plugin-manager/logs/` 可能持有当前进程的写句柄，覆盖会破坏在飞的写入。
4. **task-board 账本锁**：`$DSH_HOME/task-board/ledger-v2.lock` 是 PID 锁（`task-board/lib/index.js:2121-2148`）—— 但这是 HOME 级账本，不属于 profile，迁移不需要碰它；只是说如果目标 profile 同时在跑，原 profile 也没必要担心 task-board 锁。
5. **desktop 壳已知约束**：`settings.yaml` 上 `active_profile` 切换会触发 `restart_dsh_in_mode()`（`profiles.rs:67-69`），且同一 profile 的 dsh web 实例全局唯一（`task-board ledger` 全局锁——`settings.rs:213-214` 注释「同一 profile 只允许一个 dsh web 实例并发」）。迁移期间如果 A profile 仍在跑、B profile 被切换为 active，desktop 守护器会判活失败并触发自愈（最多 3 次）——参见 AGENTS.md「血泪坑 #3/4」。

**桌面壳侧做法**：

```text
1. 当前 active_profile = A 时，先 switch_profile(A→A 自身) 不重启无效；
   正确做法：先 switch 到不存在的占位 profile（或先关闭托盘）→ 停 dsh web
   → 再迁移文件 → switch_profile(B) → restart_dsh_in_mode()
2. 或者：用户主动「Quit」托盘后再做（避免自愈循环）
```

### 3.2 复制排除项（必排）

| 路径模式 | 排除原因 | 处理 |
|----------|----------|------|
| `.plugin-manager/locks/*`、`*.lock`、`*.pid` | 进程锁，复制后旧进程的句柄引用失效 | 删除整个 `.plugin-manager/locks/` |
| `.plugin-manager/logs/operation-*/pnpm.log` | 纯诊断日志，体积可能累计数十 MB | 删除整个 `.plugin-manager/logs/` |
| `.plugin-manager/logs/operation-*/pnpm.log.tmp` | 写入中的临时文件 | 同上 |
| `*.tmp`、`*.swp`、`*.swx`、`*~`、`.#*` | 文本编辑器/进程残留 | rsync `--exclude` |
| `._*` | macOS 资源叉（Finder Copy 留下） | rsync `--exclude` |
| `.DS_Store` | macOS Finder 目录元数据 | rsync `--exclude` |
| `node_modules/.cache/` | 构建产物缓存（esbuild、tsc） | 重 install 时 pnpm 会重建 |
| `node_modules/.pnpm-store/` | pnpm store（如果用 hardlink 模式且路径不变） | rsync 后保持硬链接即可；若换设备则需重 install |
| `.dsh-market/snapshots/` | 体积可能很大且可重建 | 视情况，可考虑排除 |
| `.dsh-mattskillsdeck-cache/` | 缓存可重建 | 视情况 |
| `cordis.yml` | dsh 启动时永远覆盖为 `[]`，复制无意义 | rsync 后删除（或复制后无事，dsh 启动会重写） |
| `.dsh-module-fallback/node_modules/` 的绝对路径符号链接 | 指向绝对 `/Users/<user>/.dsh/...` 路径，跨用户/机器失效 | 见 §4 直接拷贝 vs plugin add 的取舍 |

### 3.3 目标已存在时的覆盖语义

dsh CLI 在 `initializeProfileFromDefault()`（`profile-boot-BNu17Y9U.js:139-167`）的语义：
- mkdir 抛 `EEXIST` 时，**再检查 `package.json` 是否存在**：
  - 存在 → 抛错 `profile <name> already exists at <path>`（不重建）
  - 不存在（仅有空目录） → 也抛错 `profile directory <dir> already exists`
- `loadProfile()` 对已初始化（`package.json` 存在）的 profile 只做 `normalizeShippedProfile()`，不重建 manifest。

**结论**：桌面壳的「把 A 复制到 B」必须**先确认 B 不存在**（或**先备份 B**再覆盖）。

推荐语义：

| 场景 | 语义 |
|------|------|
| B 不存在 | 直接复制 A 的内容（去掉 §3.2 排除项）到 B 路径 |
| B 存在但 profile.json 中 `dsh.profile.bundles` 与 A 相同 | 弹窗确认：「覆盖 B（会保留 B 独有的 cordis.patch.yml？还是连 patch 一起覆盖？）」 |
| B 存在但 bundles 不同 | 拒绝覆盖（dsh 已经把 bundles 写进 manifest 了，再覆盖会跨身份）或弹窗「整目录替换」（先 mv B 到 `B.bak-<timestamp>`，再 copy） |
| B 存在但是 desktop `active_profile` | **强拒绝**——不能覆盖当前激活 profile（settings.rs 中 `valid_profile_name` + `switch_profile` 已隐含这一约束） |

`initProfile()` 是幂等的：`mkdirSync({recursive})` + 检查 `package.json/patchPath/workspacePath` 各自存在性；它**不会**重写已存在的 manifest。所以「在 B 已存在的前提下覆盖其 bundle 列表」必须**手工 `writeProfileManifest()`** 或直接文本编辑 `package.json`——不要试图让 dsh CLI 重建。

### 3.4 复制 node_modules 的可行性与脆弱性

| 子项 | 跨用户/机器移植性 | 备注 |
|------|--------------------|------|
| `node_modules/<pkg>/` 实体包 | ✅ portable（自包含 npm 包） | 标准 npm/pnpm 包 |
| `node_modules/.bin/<cmd>` | ✅ portable（相对符号链接） | 例：`beauticode-dsh -> ../beauticode-dsh/bin/beauticode-dsh` |
| `node_modules/.pnpm/` | ⚠️ macOS pnpm 8+ 硬链接到 `~/.local/share/pnpm/store/v3/files/<sha1>`，**硬链接是 inode 引用，跨机器失效** | rsync `-H` 保留硬链接；跨设备需 `pnpm install --frozen-lockfile` 重做 |
| `node_modules/<first-party-pkg>/`（如 `@deepseek-ai/dsh-base` 不在 profile 内） | n/a | first-party bundle 由 dsh 安装本身通过 `resolveBundleDir(installAnchor, ...)` 解析（`dsh-app-boot/lib/index.js:899-904`），**第一个 anchor 就是 install 路径**——profile 不持有 first-party |
| `.dsh-module-fallback/node_modules/*` | ❌ **绝对路径符号链接** | 本机实测 `@antfu/install-pkg -> /Users/mutou/.dsh/profiles/web/node_modules/@antfu/install-pkg`；移到另一用户/机器会断 |
| `<pkg>/node_modules/.pnpm/...` 嵌套的 pnpm 内部目录 | ⚠️ 同上（硬链接） | |
| 跨 OS（macOS → Windows / 反之） | ❌ native bindings 失败（`sharp`、`@swc/core`、`cpu-features` 等） | dsh 的 `pnpm-workspace.yaml` 里 `allowBuilds:` 已经白名单了 native 构建；纯拷贝不重 install 会留下 `*.node` 不兼容 |

**结论**：

- **同机同用户**：直接 `cp -a A/* B/` 后**修 `.dsh-module-fallback/` 的绝对链接**（脚本遍历并重写为新路径），即可启动。这是推荐做法——保留 pnpm 锁文件避免重装大包。
- **跨用户（同机）**：上面的 + 调整权限（profile 的 `package.json` 默认 0o644，但 pnpm install 时期望 0o700 写目录；rsync 用 `-p` 即可）。
- **跨设备（不同 OS）**：建议**不直接拷 node_modules**——`.pnpm/` 硬链接 + native bindings（sharp、onnxruntime-node、cpu-features）都会失败。改为：只拷 `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` + `cordis.patch.yml` → 在目标机执行 `dsh plugin --profile B install`（即 pnpm install）。这等价于「重新装，但锁文件保证依赖图与 A 一致」。
- **跨设备（同 OS / 同架构）**：直接拷 + `-H` 保留硬链接 + 重写 `.dsh-module-fallback/` 链接。

---

## 4. 「无缝切换」的可行定义

**TL;DR：可以做到「迁移后切 active_profile 重启即得完整等价环境」——前提是把「等价」严格限定为「相同的插件 + 相同的 patch 叠加 + 相同的运行时数据」**。

### 4.1 「等价」包含什么

✅ 包含（拷贝后等价）：

- 插件集合（`package.json.dependencies` + `dsh.profile.bundles`）
- 用户 patch 叠加（`cordis.patch.yml`）
- pnpm 工作区配置（`pnpm-workspace.yaml`）
- pnpm 锁图（`pnpm-lock.yaml`）
- 已安装的 `node_modules/`（同机）
- 插件私有 per-profile 数据（`.dsh-market/`、`.dsh_hashline_edittool/`、`.mnemon/`、`.dsh-mattskillsdeck-cache/`、`.dsh-pending-updates.json`、`thinking-effort-loaded.json`）
- HOME 级 patch layer（`$DSH_HOME/cordis.patch.yml`）—— 注意这个**不是从 A 拷到 B**，它是 HOME 全局的，所有 profile 启动时都会叠加。

❌ 不包含（迁移后**会有差异**，但**绝大多数是有意的**）：

- 会话历史（`$DSH_HOME/sessions/`）：新 profile 是干净会话视图——但任务看板账本仍是 HOME 级，新 profile 启动后能看见同样的 task-board 内容（**这是有意设计**：任务看板跨 profile 共享）。
- 配额账本（`.dsh-usage-*.json`）：跨 profile 共享——这是合规设计。
- 移动访问配对（`storages/mobile-access/`）：跨 profile 共享——设备关系。
- 壁纸（`.dsh-any-background-data/`）：跨 profile 共享——视觉偏好。
- 凭证（`.credentials.yaml`）：跨 profile 共享——避免重新登录。
- 隔离台账（`dsh-desktop-tauriapp/quarantine.json`）：**新 profile 名空间下是空的**——B profile 启动时若它加载了同样出错的 plugin（很少见），会再次触发隔离。

### 4.2 无缝切换流程

```text
前置：用户已在桌面壳托盘 / 设置面板选好 A 和 B
1. desktop 壳调用 profiles.rs::clone_profile(A, B)（新函数，本次新增）
2. profiles.rs 校验：
   a. valid_profile_name(B) 通过
   b. active_profile != B（若 == 抛错：当前激活 profile 不能覆盖）
   c. dsh_home/profiles/B 不存在；若存在弹窗确认（合并/覆盖前备份/取消）
3. profiles.rs 调 spawn_blocking 走 dsh CLI `plugin --profile A list --depth 0` 冻结 A 视图（可选，仅用作「即将迁移什么」预览）
4. profiles.rs 调 spawn_blocking 调用 dsh CLI `plugin --profile A remove <pkg>` *仅当* B 存在且要严格替换（不建议；推荐走文件复制）
5. profiles.rs 调 spawn_blocking 执行文件复制：
   cp -a "$DSH_HOME/profiles/A/." "$DSH_HOME/profiles/B/"
   --exclude=.plugin-manager/logs
   --exclude=*.lock --exclude=*.tmp --exclude=*.swp --exclude=._*
   --exclude=.DS_Store
   --exclude=cordis.yml  (dsh 启动会覆盖)
   复制后：find . -type l -lname '*/.dsh/profiles/A/*' -exec bash -c 'ln -sf "$(echo {} | sed s/A/B/)" "{}"' \;
   或更简单：rm -rf B/.dsh-module-fallback && 在 B 启动时让 dsh 自动重建（参考 §4.3）
6. profiles.rs 校验目标 manifest：解析 B/package.json，确认 dsh.profile.bundles 与 A 一致
7. 切 active_profile：B → save_desktop_settings → restart_dsh_in_mode()
8. dsh 启动：prepareProfile() 重写 cordis.yml = [] → 加载 patch 栈 → 启动 dsh web
9. 用户看到的新 dsh web 实例与 A 等价（仅会话历史/任务账本保留 HOME 级共享）
```

### 4.3 关于 `.dsh-module-fallback/` 的自动重建

`unlinkProfileModuleFallback()` + `healProfileModuleFallback()`（`dsh-app-boot/lib/index.js:732, 788`）在 profile 启动时会按 `profileContext` + `installAnchor` 重新创建 fallback 链接。这意味着：

- **最简单方案**：复制时直接**不复制 `.dsh-module-fallback/`**，让 B 启动时 dsh 自己重建。代价是首次启动稍慢（建几百个 symlink）。
- **进阶方案**：复制并重写符号链接 target（sed 替换 A→B）。代码量小，但 rsync 已能保留符号链接的属性；只需写一段 `find -type l -lname '*/A/*' -exec sed-replace` 脚本。

推荐第一种——简单可靠，且 dsh 启动时总会做这个动作。

### 4.4 「无缝切换」的边界（用户必须知情）

迁移后**与 A 不一致的部分**（桌面壳 UI 提示文案建议）：

1. **会话历史**：sidebar 里看不到 A 的会话记录（B 干净），但 storage jsonl 文件仍在 `$DSH_HOME/sessions/`；若希望 B 也能看到，可以建议用户使用 dsh 的「会话切换」而**不是** profile 切换（这不是本票范围）。
2. **任务看板**：B 看到与 A 一样的任务（账本 HOME 级）；这是有意设计——否则 cron 任务在切换 profile 时丢失。
3. **已配对的手机设备**：B 启动后，手机端无需重新配对（`pairing.json` HOME 级）。
4. **壁纸 / 主题**：B 看到与 A 一样（HOME 级）。
5. **API 凭证**：B 看到与 A 一样（HOME 级）。
6. **隔离台账**：B 是干净台账——若 A 有被隔离的插件且 B 的 bundle 列表里也包含该插件，理论上会重新触发隔离。

---

## 5. 直接拷贝 vs plugin add 的取舍

| 维度 | 直接拷贝（`cp -a`） | plugin add（逐包 `pnpm add`） |
|------|---------------------|--------------------------------|
| **速度** | GB 级 profile 秒级复制 | 重 install 分钟级（pnpm 下载 + native 构建脚本） |
| **一致性** | 字节级一致（同机），含 plugin-owned data dirs | 仅恢复 `dependencies`，**plugin-owned data dirs 不会恢复**（除非插件自己运行初始化逻辑） |
| **portability** | 同机 OK；跨 OS/架构失败（native bindings） | 跨平台都 OK（pnpm 会重新跑 `prepare` 脚本） |
| **可逆性** | 复制前 cp 一份到 `B.bak-<ts>` 即可回滚 | 必须 pnpm 卸载逐包；难精确回滚 |
| **cordis patch 迁移** | ✅ 自动随文件拷过去 | ❌ `plugin add` 不动 `cordis.patch.yml`（必须单独 copy） |
| **pnpm-lock 一致性** | ✅ 锁文件原样保留 | ✅ 重新 add 也用同一锁文件 |
| **pnpm-workspace allowBuilds** | ✅ 文件原样保留 | ❌ add 不复制 workspace.yaml（但同一安装的 dsh 通用 workspace 在 `$DSH_HOME/profiles/node_modules/.pnpm-workspace-state-v1.json`） |
| **plugin-owned data dirs（如 `.dsh-market/`, `.dsh_hashline_edittool/`）** | ✅ 自动拷 | ❌ 完全不拷 |
| **node_modules 大小** | 1.8 GB（实测本机 web profile） | 同等大小但需重下 |

**推荐**：

- **桌面壳 profile 迁移 UI 默认走直接拷贝**（含 patch 与 plugin data）；排除项见 §3.2。
- **跨设备场景**（用户从 mac 拷到 win）走 **「只拷 package.json + pnpm-lock.yaml + pnpm-workspace.yaml + cordis.patch.yml」+ 在目标机执行「plugin install」**——这把 native bindings 留给 pnpm 重做；代价是首次 install 时长 + 失去 plugin-owned per-profile data（迁移纯「环境配置」语义）。
- **混合场景**（同机但用户想刷新依赖）走「备份 cordis.patch.yml + 删除 node_modules + pnpm install --frozen-lockfile」——但这是「刷新」而非「迁移」，不在本票范围。

---

## 6. 风险清单

| 风险 | 触发场景 | 影响 | 缓解 |
|------|----------|------|------|
| **数据丢失**（覆盖已存在 B） | 用户误选目标名 | B 的 `cordis.patch.yml` / plugin-owned data 被 A 内容覆盖 | 复制前 `mv B B.bak-<ts>`；UI 强提示 |
| **跨用户/机器路径断裂** | `.dsh-module-fallback/` 含绝对路径 | profile 启动时 dsh 找不到 fallback 包 | 复制时排除 `.dsh-module-fallback/`，让 dsh 重建（§4.3） |
| **pnpm 硬链接失效** | 跨设备拷贝 `.pnpm/` | 包找不到实体 | 跨设备用 `pnpm install --frozen-lockfile` 重做 |
| **native bindings 不兼容** | 跨 OS/架构拷贝 `*.node` 文件 | sharp、onnxruntime-node、cpu-features 等崩溃 | 跨设备走 plugin install 而非拷贝 |
| **`.pnpm-store/` 大小爆炸** | 拷贝整个 `.pnpm/` | 实际不需要那么大（硬链接重复） | rsync `-H` 保留硬链接；或拷贝后用 `pnpm store prune` |
| **desktop 守护器自愈循环** | active_profile 是 A 时迁移 A 的副本到 B 触发重启但 A 仍在 | 重启失败、判活失败、自愈 3 次封顶 | 迁移前先 `switch_profile(B 占位)` 或退出托盘 |
| **task-board 全局锁冲突** | 用户在 A 迁移前未停 dsh web，B 启动后 task-board 锁可能指向已死 PID | task-board 加载失败（`task-board/lib/index.js:2121` 有 `UNREADABLE_LOCK_GRACE_MS` 软退避） | 迁移前主动 kill 旧 dsh；或在 UI 提示「请先退出 A 的 dsh web」 |
| **隔离台账漂移** | B 是新 profile 名，quarantine.json 把它视为新桶；但若 A 有隔离记录且 B 重新装上同样坏插件，会重新触发隔离 | 短暂错误状态（非数据丢失） | 文档说明：迁移是配置快照，不是隔离快照 |
| **隐私泄漏** | A 含敏感 cordis patch（如嵌了 `!!js` 表达式读 HOME 路径） | 复制到 B 后 B 看到 A 的私人 patch | UI 提示「请检查 B/cordis.patch.yml 是否含敏感信息」；默认复制 |
| **磁盘空间** | 复制 1.8 GB profile 是普通量级；多个备份会膨胀 | 用户机器满 | 复制后立即清理 B.bak-<ts>（除非用户显式保留）；rsync `--link-dest=../A.bak-<prev>` 做增量 |
| **当前激活 profile 被覆盖** | 用户选 B = 当前 active_profile | settings.yaml.active_profile 在迁移过程中被改；mid-flight 重启 | profiles.rs::clone_profile 入口直接 `if active == target_name { return Err("不能覆盖当前激活 profile") }` |
| **pnpm `--config.minimumReleaseAge` 触发** | 桌面壳现 `run_profile_plugin_add` 默认加 `--config.minimumReleaseAge=0`；直接拷贝绕开 pnpm 不存在此问题；走 plugin add 时仍会触发 | 某些最小发布龄期被跳过的包可能装不上 | 直接拷贝绕开 |
| **desktop `desktop_plugin_inject.yml` 的 --patch 注入** | `--patch` 在 `desktop/src-tauri/src/process/plugin/` 由 build.rs 注入到每个 spawn 调用；与 profile 独立 | 不影响 profile 迁移（patch 是叠加层，不属于 profile 内部） | 无需处理 |

---

## 7. 给桌面壳实现的建议（不写代码，仅设计要点）

基于以上分析，桌面壳 `desktop/src-tauri/src/profiles.rs` 新增 `clone_profile(source: &str, dest: &str)` 函数的设计契约：

```text
pub(crate) async fn clone_profile_flow(app: AppHandle, source: String) {
    1. prompt_input 获取 dest 名称
    2. valid_profile_name(dest)
    3. valid_profile_name(source)
    4. 检查 dsh_home/profiles/source 存在且 package.json 有 dsh.profile.bundles
    5. 检查 active_profile != dest
    6. 检查 dsh_home/profiles/dest 不存在；存在则弹窗「覆盖前先备份到 B.bak-<ts>？」
    7. spawn_blocking:
       a. mkdir -p dest
       b. cp -a source/. dest/ + 排除项（§3.2）
       c. rm -rf dest/.dsh-module-fallback  (让 dsh 启动时重建)
       d. rm -f dest/cordis.yml  (dsh 启动时覆盖为 [])
       e. 校验 dest/package.json parse OK 且 dsh.profile.bundles 与 source 一致
    8. show_notification("克隆成功", "已创建 {dest}（未自动切换）")
    9. refresh_tray_mode()
}
```

需注册的 IPC 命令（按桌面壳约定）：

- `generate_handler!` 添加 `clone_profile(app, source, dest)`（settings 类型）
- `permissions/app-commands.toml` 加 `clone-profile = ["allow-from-cmd", ...]`
- `capabilities/default.json` 加 `"clone-profile": ["allow"]`

UI 入口：托盘右键 → 「克隆当前 Profile...」（弹输入对话框输入目标名），或设置面板 Profile 下拉旁的「克隆」按钮。

---

## 8. 参考来源（按引用顺序）

1. `desktop/src-tauri/src/profiles.rs:1-160` —— 现有扫描/切换/plugin add 实现
2. `desktop/src-tauri/src/settings.rs:1-292` —— `active_profile` 持久化、`dsh-desktop-tauriapp:` 顶层键
3. `desktop/src-tauri/src/commands.rs:642-707` —— `get_desktop_settings_data`、`switch_profile_command`
4. `desktop/src-tauri/src/process/quarantine/ledger.rs:33-145` —— 隔离台账路径 `$DSH_HOME/dsh-desktop-tauriapp/quarantine.json` + per-profile 分桶
5. `desktop/src-tauri/src/network/ai.rs:5-92` —— `.credentials.yaml` 读取与 `refs` 优先级
6. `/opt/homebrew/bin/dsh` → `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` —— CLI 入口（`--profile`, `--from-default-profile`, `--patch`, `plugin` 子命令）
7. `…/@deepseek-ai/dsh/lib/profile-boot-BNu17Y9U.js:115-303` —— `homePatchPath()`, `PROFILE_ROOT_CONFIG`, `initProfile()`, `prepareProfile()`, `runProfile()`
8. `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`：
   - `:252` `PROFILE_MODULE_FALLBACK_DIR = ".dsh-module-fallback"`
   - `:339-341` `PROFILES_DIR = "profiles"`, `PROFILE_PATCH_FILENAME = "cordis.patch.yml"`
   - `:348-351` `resolveProfileDir(name, home)`
   - `:353-359` `PROFILE_TEMPLATES`（acp / web / headless / sdk / sdk-minimal）
   - `:367` `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`
   - `:393-409` `initProfile()`（幂等；只写不存在文件）
   - `:659-690` `healProfilesModuleFallback()` —— `$DSH_HOME/profiles/node_modules` 共享池
   - `:732-735` `unlinkProfileModuleFallback()` —— 启动时清 profile-owned fallback 链接
   - `:899-905` `resolveBundleDir()` —— **installation-first** 解析 first-party bundle
   - `:916-938` `loadProfileDirectory()` —— 读 manifest + bundles + user patch layer
   - `:953-961` `loadProfile()` —— 自动 init 当 package.json 不存在（模板）
   - `:1005-1016` `readProfilePatches()` —— bundle layers → profile patch → **HOME patch** → `--patch` overlays → telemetry switch
9. `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js` —— `resolveDshHome(configured, env)`：`DSH_HOME` env > `~` 展开 > `~/.dsh`
10. `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:77-152` —— `runProfilePnpm()` 调 pnpm，写 `.plugin-manager/logs/operation-*/pnpm.log`
11. `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:117-120, 152-164` —— `session-persistence-jsonl root: dshHomePath('sessions')`、`storage-json root: dshHomePath('storages')`
12. `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:902-914, 2283-2290` —— `projectDir()`、`sessionDir()`、`this.root = resolve(config.root)`
13. `~/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/index.js:1572` —— `constructor(dir = join(dshHome(), "task-board"))`；`:2121-2148` lock file 与 PID 检查
14. `~/.dsh/profiles/web/node_modules/@anionex/dsh-vision-toolkit/lib/runtime-install.js:697-702` —— `visionToolkitStateRoot() = join(base, 'cache', 'dsh-vision-toolkit')`
15. `~/.dsh/profiles/web/node_modules/dshmarket/lib/presets.js:60-78` —— `presetsFile(profileDir) = join(profileDir, '.dsh-market', 'presets.json')`
16. `~/.dsh/profiles/web/node_modules/dsh-mobile-access/lib/settings.mjs:11-15`、`pairing.mjs:14`、`proxy.mjs:16`、`cloudflared.mjs:41-43` —— `process.env.DSH_HOME || path.join(os.homedir(), '.dsh')` 全局回退
17. `~/.dsh/profiles/web/node_modules/@michengai/dsh-agency-agents/lib/src-CtqSbp2k.js:618-639` —— `profileDir = resolve(process.env.DSH_PROFILE_DIR ?? resolve(homedir(), ".dsh", "profiles", "web"))`，运行时通过 ctx.get("desktopProfiles") 优先用桌面壳注入
18. 本机实测 `~/.dsh/profiles/{smoke,web}/` 目录结构、`~/.dsh/profiles/web/package.json` 39 个 `dsh.profile.bundles`、`~/.dsh/profiles/web/node_modules/.bin/beauticode-dsh` → `../beauticode-dsh/bin/beauticode-dsh`（相对符号链接）、`~/.dsh/profiles/web/.dsh-module-fallback/node_modules/@antfu/install-pkg` → `/Users/mutou/.dsh/profiles/web/node_modules/@antfu/install-pkg`（绝对符号链接）
19. `~/.dsh/profiles/web/.plugin-manager/` 仅含 `logs/`（无锁）、`~/.dsh/profiles/web/.dsh-market/{state.json,snapshots/,log.ndjson,discovery-compatibility-v1.json}`、`~/.dsh/profiles/web/.dsh_hashline_edittool/hash-store.sqlite`、`~/.dsh/profiles/web/.dsh-mattskillsdeck-cache/<project>.json` × 5
20. `~/.dsh/.credentials.yaml` —— 7 个 API key refs + `client-connection/browser-session` grant record
21. `~/.dsh/dsh-desktop-tauriapp/quarantine.json` —— `profiles.web[].id = "dsh-subagent-pro"`，按 profile 分桶
22. 仓库 `AGENTS.md` 「已知注意事项」 #3（单实例约束）/ #4（守护器判活）/ #5（远程页面 IPC）/ 移动访问「设备会话持久化」条款
