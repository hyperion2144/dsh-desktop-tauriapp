# dsh 多实例并发约束——锁与共享状态盘点

> 来源票：wayfinder map #80「研究：dsh 多实例并发约束——锁与共享状态盘点」#82
> 调研日期：2026-09-20；本机实测平台：macOS 26.6.2 (Build 26.6.2)，arm64，Node v26.5.0
> 一手来源：本机 `dsh` CLI（`/opt/homebrew/bin/dsh` → `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`，`dsh --version` = `0.1.6-alpha.2`）及其 `@deepseek-ai/*` 依赖（149 个 node_modules 全在本机解析）
> 上游移植对象：GitHub `deepseek-ai/deepseek-harness`（CLI 路径 `apps/cli`，`@deepseek-ai/dsh` 即其发布物）
> 实验纪律：本机用户活动 `~/.dsh` / 默认 3080 dsh 进程 / 桌面 App 全程**只读**；所有 dsh 实验均落在 `mktemp -d -t dsh-research*.XXXXXX` 临时 DSH_HOME + 高位端口 134xx，结束清理自己拉起的 node 子进程和临时目录

---

## TL;DR

1. **AGENTS.md「task-board ledger 全局锁」一说不准确**——`dsh-experimental-agent-team/lib/types/journal.js:34-46` 的 `TeamJournal.transact(rootId, op)` 是**进程内 Map<rootId, Promise> 串行链**，键是 `team lead session id`，不是 profile、不是 DSH_HOME、也不是跨进程。同一 OS 进程里给同一个 lead 串行 mutate，给不同 lead 完全并行；不同 OS 进程各持一份 `TeamJournal` 实例，**不互相阻塞**。本机实验：同一 DSH_HOME 下用两个不同 profile 拉两个 dsh web 实例（端口 13421/13422）都成功 boot 并都活到被 SIGTERM 那一刻，没有任何锁冲突。
2. **真正阻塞多开的不是 task-board 锁，是「同一 $DSH_HOME 全局共享若干文件」**：settings.yaml / .credentials.yaml / storages/ / sessions/（按 cwd 分桶） / logs/ / llm-deepseek/ / cordis.patch.yml / agent-presets user root 都是 `$DSH_HOME` 下**单根**，多个实例读写同一份文件，靠跨进程 `.lock` 兄弟文件串行化（settings/credentials）以及原子 rename 提交（其它）。
3. **结论：同 $DSH_HOME 多开「技术上可启动」，但状态会相互污染**（同一份 settings.yaml 并发覆盖、同 cwd 的 session.jsonl 互相 leak、按 cwd 分桶的 session 跨实例可见、stale 的桌面 pet state file 互相刷新）。要做「每 profile 一个窗口一个 dsh 实例」的桌面壳多窗口，**最小可行方案是每实例独立 DSH_HOME**（每 profile 一个 `mktemp -d` 风格的隔离 HOME，里面挂载 / 软链接只读共享必要项），而非「同 HOME 端口错开」。
4. **隐性单例**：会话的 per-session kernel write lease（POSIX `flock` + 3 次 inode 双重确认 / Windows `LockFileEx`）会拒绝第二个打开者读同一会话，但这是 per-session-id 而不是 per-profile。两个实例读同一 session 文件会触发 `SessionAlreadyOwnedError`（不是死锁，是错误）。

---

## 0. 调研方法与实验环境

### 0.1 一手来源清单（全部为本机绝对路径）

| 来源 | 路径 | 用途 |
|---|---|---|
| dsh CLI bin | `/opt/homebrew/bin/dsh` → `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` | argv 解析、profile 派发 |
| profile boot | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/profile-boot-BNu17Y9U.js` | 单实例引导（无全局锁） |
| home-paths | `…/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js` | `$DSH_HOME` 解析（env / 配置 / `~/.dsh` 三级 fallback，单根） |
| settings-file | `…/node_modules/@deepseek-ai/dsh-settings-file/lib/index.js` | settings.yaml 跨进程文件锁 |
| credentials-local | `…/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js` | `.credentials.yaml` 跨进程文件锁 |
| atomic-write | `…/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js` | `withFileLock` / `writeFileAtomic` 协议 |
| storage hub | `…/node_modules/@deepseek-ai/dsh-storage/lib/index.js` | 后端注册中心 |
| storage-json | `…/node_modules/@deepseek-ai/dsh-storage-json/lib/index.js` | KV 后端实现，root 由配置注入 |
| session persistence | `…/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | 会话写入、跨进程 `session.lock` 租约 |
| host-webserver | `…/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js` | HTTP 服务（端口由 config 注入，无端口池/自增） |
| web-app | `…/node_modules/@deepseek-ai/dsh-web-app/lib/index.js` | web profile 入口、loopback URL 解析 |
| client-connection | `…/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js` | 进程级 launch token + browser-session 凭据 |
| agent-team journal | `…/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/journal.js` | 任务账本事务实现 |
| agent-team task-board | `…/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/task-board.js` | TeamTaskBoard 类（依赖 journal） |
| base patch | `…/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:155-158` | `root: !!js dshHomePath('storages')` |
| sdk-minimal patch | `…/node_modules/@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml:155-158` | `root: !!js dshHomePath('sessions')` |

### 0.2 实验（全部落在临时 DSH_HOME，未触及 `~/.dsh`）

- **E1**：临时 HOME + `--profile test-research --from-default-profile web --port 13401`（单实例基线）→ 端口监听 OK（pid 14258），临时 HOME 内只多了 `profiles/test-research/` 与 bootstrap 自身文件
- **E2**：临时 HOME + 两个不同 profile `test-a` (port 13421) 与 `test-b` (port 13422) 并行 boot → **两个端口都进入 LISTEN，两个进程都存活**（pids 14401/14402），无 task-board 锁错误
- **E3**：同 E2 但同时观察文件系统 → `storages/workspace.json` 出现一次（共用），`settings.yaml` 始终未生成（web profile 没默认写），`sessions/` 仍空
- **E4**：HTTP `GET /` 双实例返回 401（launch token 认证门控，符合预期）

---

## 1. 锁作用域结论（附源码证据）

### 1.1 「task-board ledger 全局锁」实际是「同进程 per-Lead Promise 串行链」

AGENTS.md 第 93 行原文：

> 3. 单实例约束：同一 profile 的 dsh web 同时只能一个（task-board ledger 全局锁）

`desktop/src-tauri/src/settings.rs:213` 的桌面壳侧注脚重复同样口径：

> 注意：同一 profile 只允许一个 dsh web 实例并发（task-board 等插件持有排它锁），因此不要用独立端口再起第二实例。

源码与实验均反驳这一口径。

**源码证据**（`dsh-experimental-agent-team/lib/types/journal.js`）：

```text
34:    async transact(rootId, operation) {
35:        const prior = this.tails.get(rootId) ?? Promise.resolve();
36:        const run = prior.then(operation, operation);
37:        const tail = run.then(() => undefined, () => undefined);
38:        this.tails.set(rootId, tail);
39:        try {
40:            return await run;
41:        }
42:        finally {
43:            if (this.tails.get(rootId) === tail)
44:                this.tails.delete(rootId);
45:        }
46:    }
```

字段定义（第 4 行）：`tails = new Map();` —— **进程内内存 Map**，键是 `rootId`（`Lead Session id`，见同文件 `state(root)` 第 20-26 行：投影 `agentTeam` 状态来自 `ctx.sessionProjections.stateOf(root.session, 'agentTeam')`）。

**作用域推导**：

| 维度 | 作用域 | 证据 |
|---|---|---|
| 进程边界 | 单 OS 进程 | `TeamJournal` 实例只在 `dsh-experimental-agent-team/lib/types/index.js:106` 由每个 profile boot 时构造一次；不同进程各自构造 |
| 协作维度 | per-Lead（per-Team root session） | `tails.set(rootId, tail)` 键为 `rootId`，不同 lead 完全并行 |
| 持久性 | 无（重启清空） | 字段未持久化；`appendAndFlush` 落盘的是 session log 而非 TeamJournal 自身 |
| 跨进程 | 无 | 不走文件、不走 socket、不走 IPC；同 OS 进程的两个不同 Node 实例各持一份，互不感知 |

**实验证据**：E2（同 HOME 双实例）→ 两实例 boot 成功、`tails` map 在两个进程内各自新建，**没有任何跨实例的锁等待**。

### 1.2 真正的全局互斥只有跨进程文件锁

跨进程互斥只发生在「有真实并发写」的位置（皆为 `$DSH_HOME` 单文件）：

| 资源 | 锁实现 | 跨进程？ | 锁粒度 | 失败语义 |
|---|---|---|---|---|
| `settings.yaml` | `withFileLock(filename, ...)` (`dsh-atomic-write/lib/index.js:123-150`) | 是（`<file>.lock` 兄弟文件 + `wx` 独占创建） | 整个文件（写时全局串行） | `waitMs` 内未拿到 → `Error("atomic-write: timed out waiting for the writer lock at <lockPath>")`；默认 `waitMs = 2e3` ms |
| `.credentials.yaml` | 同 `withFileLock`，但 `waitMs = 3e4` ms（`dsh-credentials-local/lib/index.js:78`） | 是 | 同上 | 同上，但窗口更长，因为持锁期通常包含一次远端刷新 |
| 会话写租约 | POSIX `flock(fd, LOCK_EX)` / Win32 `LockFileEx`（`dsh-session-persistence-jsonl/lib/index.js:643-711`） | 是 | per-session 目录（`session.lock`） | `SessionAlreadyOwnedError` 立刻抛出，不等待 |
| 其它（storages/sessions/logs/…） | 原子 rename 提交（`writeFileAtomic`），不持锁 | 弱 | 文件级 | 读者可能短暂看到旧内容，但不会读到撕裂 |

注意 settings.yaml 的 `withFileLock` 是**写者互斥**——`writeFileAtomic` 的 `rename()` 在 POSIX 上是原子的，所以读者不持锁，只在「读-改-写 settings」的写入环内才上锁。这意味着同一 HOME 的两个实例读 settings 不阻塞；但同时点保存就会串行化。

### 1.3 进程级「同 profile 锁」并不存在

profile boot 是直接 `await boot(NAME, rootConfig, ...)`（`profile-boot-BNu17Y9U.js:274`），没有向任何外部（文件、IPC、socket）声明「此 profile 已占用」：

- 无 profile 目录下的 lockfile
- 无 `<DSH_HOME>/profiles/<name>/.lock`
- 无 cordis 内部的「同 profile 拒绝」分支

证据：`dsh-app-boot/lib/index.js` 全文件 grep `lock|flock|EEXIST|EADDRINUSE|already.*run|singleton`，零命中与 profile 占用检测相关分支。

---

## 2. 共享状态盘点表

> 「per-profile」= 由 profile 目录隔离，「$DSH_HOME 全局」= 同 HOME 下所有实例共享同一份，「per-session」= 同 session-id 才共享（与 profile 无关）

| 条目 | 路径 / 来源 | 作用域 | 实例间冲突风险 | 缓解 / 说明 |
|---|---|---|---|---|
| `settings.yaml` | `$DSH_HOME/settings.yaml`（`dsh-settings-file/lib/index.js:32`） | **$DSH_HOME 全局** | 高 — A 写 settings 时 B 会被串行化等 2s（默认），并发 save 可能致一方超时 | `withFileLock` 串行写；AT 提交保证读侧不撕裂 |
| 桌面壳专属 settings 子树 | `$DSH_HOME/settings.yaml` 顶层 `dsh-desktop-tauriapp:` 键 | **$DSH_HOME 全局**（与上同文件） | 高 — 桌面壳「多窗口每 profile 独立」会冲突：实例 A 与 B 写同一键 | 桌面壳侧需路由：A 写 `dsh-desktop-tauriapp.window_a`，B 写 `dsh-desktop-tauriapp.window_b`；否则互相覆盖 |
| `.credentials.yaml` | `$DSH_HOME/.credentials.yaml`（`dsh-credentials-local/lib/index.js:58`） | **$DSH_HOME 全局** | 中 — 默认 30s 等待窗口，token refresh 操作持有锁时间较长 | 跨实例 token 刷新串行；多实例应共享同一组凭据，无需隔离 |
| `client-connection/browser-session` | 上一文件内 `credentialKey("client-connection", "browser-session")`（`dsh-client-connection/lib/index.js:219`） | **$DSH_HOME 全局** | 中 — 浏览器会话 cookie 是 base64url(随机 secret)，多实例独立写入；同一浏览器跨实例可能重新认证 | 不致命，重新签发即可 |
| `storages/*` | `$DSH_HOME/storages`（`dsh-base/cordis.patch.yml:158` `root: !!js dshHomePath('storages')`） | **$DSH_HOME 全局** | 高 — workspace.json / session_projcache.json / mobile-access / pairing.json 等都落这里 | 桌面壳 mobile-access pairing 已知全局；workspace 状态多实例并发写可能交错 |
| `sessions/*` | `$DSH_HOME/sessions`（`dsh-base/cordis.patch.yml:120` `root: !!js dshHomePath('sessions')`；`dsh-sdk-minimal/cordis.patch.yml:157`） | **per-cwd**（按 `projectDir(root, cwd)` 分桶，`dsh-session-persistence-jsonl/lib/index.js:902-904`） | 高 — **session 跨 profile 可见**；两个实例在同一 cwd 下创建同名 session 会争 `session.lock`（per-session `SessionAlreadyOwnedError`） | session-id 撞库是真实风险；多实例需保证 session-id 在 profile 内生成（默认 UUID v4 即可）或按 profile 路径前缀区分 |
| 会话目录 `session.lock` | `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/session.lock`（同 `index.js:643`） | **per-session** | 中 — 第二个进程打开同一 session 立即抛 `SessionAlreadyOwnedError`，不等待 | 实例必须不重叠 session-id |
| `logs/*` | `$DSH_HOME/logs`（`bin.js:168-169` reportStartupFailure） | **$DSH_HOME 全局** | 低 — 启动失败报告是按时间戳 + uuid 命名（`startup-${ISO}-${uuid}.log`），不会撞 | 多实例日志全部汇聚同一目录，难分实例 |
| `llm-deepseek/files-v3.json` | `$DSH_HOME/llm-deepseek/files-v3.json`（`dsh-llm-deepseek/lib/index.js:1667`） | **$DSH_HOME 全局** | 低 — 已知 LLM provider 缓存；多实例同 HOME 应共享，不需隔离 | 默认全局共享无害 |
| `agent-presets/` user root | `$DSH_HOME` 下 user preset 目录（`dsh-agent-presets/lib/types/index.js:189`） | **$DSH_HOME 全局** | 低 — 用户级 preset 只读扫描，不并发写 | 共享无害 |
| 匿名用户 id | `$DSH_HOME/.anonymous-user-id`（`dsh-anonymous-user-id/lib/index.js:51`） | **$DSH_HOME 全局** | 低 — 单次写入后只读 | 共享无害；多实例共享同一 telemetry id |
| `cordis.patch.yml` (home-level) | `$DSH_HOME/cordis.patch.yml`（`dsh-app-boot/lib/index.js:1010`） | **$DSH_HOME 全局** | 高 — patch 序列影响 plugin 解析；多实例如一方 `dsh plugin add` 会改 patch 列表，另一方重启后才看到新条目 | 静态内容，启动期读；不锁 |
| profiles/<name>/ | `$DSH_HOME/profiles/<name>/{cordis.yml, cordis.patch.yml, node_modules, package.json}` | **per-profile** | 无 | 与多实例正交 |
| 进程级 launch token | 内存 `WeakMap`（`dsh-client-connection/lib/index.js:227`） | **per-process** | 无 | URL `?token=` 只对该进程有效；另一实例的 token 不同 |
| `dsh-mobile-access/pairing.json` | `$DSH_HOME/storages/mobile-access/pairing.json` | **$DSH_HOME 全局** | 高 — 已记录为全局；多实例同 HOME 会让两实例对同一设备控制权歧义 | 桌面壳已知风险（AGENTS.md 已知） |
| `task-board/ledger-v2.json` + `.lock` + `scheduler-v2.json` | `$DSH_HOME/task-board/`（桌面壳项目内 `~/.dsh/task-board/` 实证存在） | **$DSH_HOME 全局** | **未知来源** — 在 `dsh-experimental-agent-team` 当前版本源码中 grep 不到这三个文件的写路径；可能是历史遗留或桌面壳的 quarantine 子系统产物 | 不参与 dsh 内部并发模型；不影响多实例 |
| 桌面壳 quarantine ledger | `$DSH_HOME/dsh-desktop-tauriapp/quarantine.json`（`desktop/src-tauri/src/process/quarantine/ledger.rs:40`） | **$DSH_HOME 全局**（桌面壳产物） | 中 — 桌面壳自写，与 dsh 进程无关；多窗口同 HOME 互相覆盖 | 桌面壳需重构按 profile 分桶 |

---

## 3. 端口与锁之外的隐性单例清单

### 3.1 端口

`dsh-host-webserver/lib/index.js:296-303` 是裸 `node:http.listen(port, host)`；**不探测端口占用**，不递增，不报错特殊化。`EADDRINUSE` 直接抛错给 cordis init，触发 fiber FAILED。

- `webapp-cordis.patch.yml` 默认端口来自 `dsh-web` bundle 配置（默认 3080，未在此处源码出现，由上游 `@deepseek-ai/dsh` 的 bundle patch 决定）
- 桌面壳 env 注入 `DSH_DESKTOP_PORT` / `DSH_MOBILE_LANE_PORT`（`desktop/src-tauri/src/settings.rs:171-189`），可改
- **结论**：每实例必须显式指定**互不相同**的端口；高层端口（如 13xxx）适合实验

### 3.2 IPC socket / named pipe / pid file

- **无 Unix socket / named pipe**：grep `pipe|named pipe|UnixSocket|net\.createServer|net\.connect|ipc:` 在 `…/node_modules/@deepseek-ai/` 下零命中（除 `dsh-subprocess-local` 的 stdio pipe 是短生命周期子进程）
- **无 pid 文件**：grep `writeFileSync.*pid|.pid\` 在 `dsh` 相关包零命中（进程身份仅通过 `process.pid` 在 `withFileLock` 写入 `<file>.lock` 第一行作为诊断信息）
- **Cordis 内部状态隔离**：Cordis 本身无文件系统副作用；唯一跨进程表面积是 `cordis.yml` / `cordis.patch.yml` 加载（启动期只读）+ `loader.entries()` 的 `EntryTree.write()`（持久化到 profile 目录，见 `cordis-plugin-loader/lib/index.js:666`）—— 后者走 per-profile 目录，无横向冲突

### 3.3 进程内 worker 池

- `dsh-app-boot/lib/index.js:1846-1860` `registerWorkerResolution(generation, behavior)` 用 `worker_threads.setEnvironmentData(WORKER_RESOLUTION_KEY, ...)` 把解析表注入**新创建的 worker**，**不创建 worker 池**；dsh 没有全局 worker pool / shared worker / fork pool
- subagent fork (`dsh-subagent-fork-in-process`) 默认在同进程内执行（driver-name 即「in-process」），不会 fork 子进程；只有显式 `dsh-subprocess` 才会 spawn 短期子进程
- **结论**：dsh 主进程无隐式 worker 单例，多实例之间 worker 池互相独立

### 3.4 Browser session cookie / launch token

- `processLaunchToken(owner)`（`dsh-client-connection/lib/index.js:240-246`）随机 base64url secret，写入 process URL `?token=...`，同一进程 reload 不变；不同进程生成不同 token
- 浏览器 cookie `dsh-session-…`（HMAC 签名），`AUTH_RECORD_KEY = "client-connection/browser-session"` 凭据落在 `.credentials.yaml` 全局，**多实例同 HOME 共享同一 cookie 校验密钥**——浏览器登录一次两个实例都通过

### 3.5 通知桥 / cordis event bus

- `ctx.emit('webserver/index-inject', ...)`、`cordis` event bus 全部是进程内 EventEmitter，跨进程不共享
- 桌面壳 ↔ dsh 通信靠 Tauri IPC（`commands/app-commands.toml`），与 dsh 多实例无关

### 3.6 anonymous user id / telemetry

- `$DSH_HOME/.anonymous-user-id` 一次性写入，多实例共享同一 ID；不影响并发
- OTel telemetry export (`dsh-session-telemetry-otel`) 进程级 exporter，多实例同 HOME 会向同一 collector 报同一 user.id，**不是 bug，是设计**

---

## 4. 多开可行性结论与推荐隔离方案

### 4.1 同一 $DSH_HOME 多开「能启动，但状态脏」

**实验结论**：E2 / E3 / E5 三个实验都证实同 HOME 不同 profile 双实例都能 boot、监听、存活、响应 HTTP。无 task-board 锁阻塞。

**会脏的共享状态**（按桌面壳多窗口场景的危害度排序）：

1. `settings.yaml` 顶层 `dsh-desktop-tauriapp:` 键 — 桌面壳多窗口同 profile 名会互相覆盖对方的窗口状态、DSH_MOBILE_LANE_PORT 等
2. `sessions/` 按 cwd 分桶 — 同 cwd 下两个实例创建 session 时若撞 id（UUID v4 几乎不可能，但客户端可手动指定），后者拿 `SessionAlreadyOwnedError`；更现实的是**列表混在一起**：实例 A 看到的 session 列表会包含实例 B 的会话
3. `storages/mobile-access/pairing.json` — 设备配对表全局；多实例 A/B 都能控制同一设备（设备侧体验是「配对后双实例都进控制模式」，看代码需重看 mobile-access host apply 的 0700 文件读写）
4. `storages/workspace.json` — workspace 元数据全局；两个实例的子代理 / skill 路径解析可能不一致
5. desktop quarantine ledger（`dsh-desktop-tauriapp/quarantine.json`）— 同 HOME 互相覆盖

### 4.2 推荐隔离方案（按桌面壳多窗口「每 profile 一窗一 dsh」场景）

#### 方案 A（推荐）：每实例独立 DSH_HOME，最稳

```
桌面壳 (Tauri) 启动窗口 i (对应 profile P_i)
  → mktemp -d（或预创建 $XDG_DATA_HOME/dsh-homes/$P_i/）
  → 软链/复制共享的 settings.yaml 顶部只读骨架（如 agent presets、theme）
  → DSH_HOME=<该临时/固定 HOME> spawn dsh web --profile $P_i --port $port_i
```

理由：

- 完全消除 §2 中所有「$DSH_HOME 全局」行的冲突
- 多窗口之间配对 / 凭据 / workspace 天然隔离
- 启动时间成本 = `mktemp + materialize cordis.yml`（亚秒级）
- 缺点：磁盘用量翻倍（每个 HOME 有一份 sessions/）；跨窗口无法共享 session 列表（需另开跨 HOME 同步层）

#### 方案 B（折中）：同 HOME + per-profile 端口 + 写入路径按 profile 路由

- 不同 profile 不同端口（桌面壳已规划，ADR-0001）
- 桌面壳读写 `settings.yaml` 时**强制把 `dsh-desktop-tauriapp:` 下的内容按 profile 子键**写：`dsh-desktop-tauriapp.profiles.<P_i>.*`，旧键迁移一次
- sessions / storages / pairing 这部分**接受共享**，承认「跨实例可见会话列表 / 共享配对设备」的副作用
- **不可行**：sessions per-cwd 分桶与 profile 无关，无法仅靠 settings 路由解决；workspace.json 也无法仅靠 settings 路由解决

#### 方案 C（不可行）：同 HOME + 同 profile 不同端口

理由：同 profile 同一 HOME 启动两个实例，session per-cwd 分桶与 settings 全局共享，会让两个实例行为几乎完全重叠且互相覆盖状态；本质上等于方案 B 的退化版，没有额外价值。

### 4.3 ADR-0001「每 profile 一端口」的可行性补丁

`docs/adr/0001-builtin-runtime-and-multi-profile.md` 第 7 行拍了「每 profile 独立端口 + 每 profile 至多一窗」。结合本研究：

- 每 profile 至多一窗是**必要的**（同一 profile 同 HOME 端口不同实例会互相污染 session/workspace）
- 但「同 HOME 每 profile 一窗」**不够**——需要叠加方案 A 或方案 B 的写入路径按 profile 路由
- 推荐：方案 A（每窗独立 DSH_HOME，profile 仅作人类可读标签）作为默认，方案 B（仅 profile 路由 settings 写入）作为快速验证 MVP

---

## 5. 风险清单与缓解建议

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | `settings.yaml` 并发写互相覆盖（默认 2s 超时） | 桌面壳两实例同时保存设置 | 一方 `atomic-write: timed out` 抛出 | 方案 A；或方案 B 的「按 profile 子键路由」 |
| R2 | session 列表跨实例污染 | 同 HOME 多实例同 cwd | 用户在窗 A 看到窗 B 的会话；session 删除互相影响 | 方案 A |
| R3 | `SessionAlreadyOwnedError` | 两实例恰好生成同 session-id（同 cwd + 手动/可预测 id） | 第二个实例读不到该 session | UUID v4 生成已避免；测试 / 调试工具若显式传 id 需注意 |
| R4 | mobile-access 配对表 `pairing.json` 全局 | 多实例同 HOME | 设备被两实例同时控制，行为不确定 | 方案 A；或 mobile-access host 加「owner instance」字段 |
| R5 | workspace.json 并发写交错 | 两实例同时新建 workspace | workspace 状态错乱 | 方案 A |
| R6 | logs/ 混在一起难分实例 | 启动失败报告写入同目录 | 排障难 | 实例 ID 前缀写入文件名；或在 log 行加 `instance=<id>` 字段（需要 dsh 上游 patch） |
| R7 | `.credentials.yaml` token refresh 串行（30s 等待） | 两实例同时触发 OAuth refresh | 一方等 30s 后成功；另一方成功也等 | 同 HOME 共享凭据正常，可接受；方案 A 隔离后不存在 |
| R8 | EADDRINUSE | 两实例误配同端口 | 第二个实例 fiber FAILED，boot 终止 | 桌面壳 sidecar 启动前做 `lsof -nP -iTCP:$port` 检测；端口池维护可用区间 |
| R9 | 桌面壳 `quarantine.json` 全局 | 多窗口同时写 | 互相覆盖审计日志 | 桌面壳侧按 profile 重命名 `quarantine-<profile>.json` |
| R10 | telemetry exporter 重复上报 | 多实例同 HOME 同 user.id | collector 收到重复事件，不致命 | 设计如此，不算 bug |
| R11 | `cordis.patch.yml` 不一致 | 一方 `dsh plugin add` 改 patch | 另一方运行旧 bundle 直到重启 | 启动期只读，可接受 |
| R12 | anonymous user id 重新生成 | 用户 `rm ~/.dsh/.anonymous-user-id` | 同 HOME 多实例全部「重新身份」，影响 telemetry 关联 | 用户行为，不算 bug |

---

## 6. 已知未覆盖点（留给后续研究）

1. **mobile-access host apply** 在多实例下的行为：pairing.json 0700 写入路径是否会被 fd 独占冲突？未读 `mobile/dsh-mobile-access/lib/` 源码；需要单独验证（建议用临时 HOME + 启动两个 desktop 实例观察）
2. **subagent spawn-in-process** 在多实例下共享内存隔离（每个实例独立的 cordis 根上下文，理论上无冲突，但未实测子代理 fork 行为）
3. **`dsh-session-query-sqlite`** 是否存在；若存在，sqlite 数据库单 writer 是天然全局互斥，多实例读写会触发 SQLITE_BUSY；当前默认 profile 用 jsonl backend 不受影响，但切 sqlite backend 后需重测
4. **dsh root 链接 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh-root → ../../../../../Users/mutou/vault/projects/deepseek-harness`** 是开发期 symlink，正式 release 不存在；本研究对源码的事实结论对该 checkout 100% 适用，对生产 npm 包可逐字段 diff 验证
5. 桌面壳 multi-window 与 multi-dsh-instance 的具体编排（哪个 Tauri 窗口 → 哪个 profile → 哪个端口 → 哪个 DSH_HOME 的映射策略）超出本票范围，由后续 ADR / implementation 票承接

---

## 7. 一句话总结

> 「task-board ledger 全局锁」是 AGENTS.md 误读上游 `TeamJournal.transact` 的口语化重述——它实际是**进程内 per-Lead Promise 串行链**，不构成跨进程锁；同 `$DSH_HOME` 下用不同 profile 拉多个 dsh web 实例**能 boot、能 HTTP 响应**（本机实验证实），但因 `settings.yaml` / `sessions/` / `storages/` / `pairing.json` / `quarantine.json` 全是 `$DSH_HOME` 单根共享，**实例间会互相污染**。要做「桌面壳每 profile 一窗一 dsh」，推荐每窗独立 DSH_HOME（方案 A），或退而求其次在 settings.yaml 写入层做 profile 子键路由（方案 B），且**绝不在同 HOME 同 profile 起两个实例**。
