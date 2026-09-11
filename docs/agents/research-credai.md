# dsh `.credentials.yaml` 格式与 AI 密钥读取（一手源码调查）

> 来源票：GitHub issue #56《研究：dsh .credentials.yaml 格式与 AI 密钥读取》
> 调研日期：2026-09-11；本机实测平台：macOS 26.6.2 (Build 25G83)，arm64
> 目标：为 Wayfinder map #53 的实现票 #60（AI 解读 explain + repair 建议、正则识别不出坏插件时的兜底）
> 落地：搞清凭据在哪、怎么读、能不能不自己发 HTTP、发 HTTP 要付多少代价。

## 0. 证据来源与路径约定

本文所有结论均为**本机一手核对**，不使用二手转述。为节省篇幅，路径用两个前缀缩写：

| 缩写 | 展开 |
|---|---|
| `PKG/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` |
| `CLI/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/` |
| `DESK/` | `/Users/mutou/vault/projects/dsh-desktop-tauriapp/desktop/src-tauri/` |

本机环境（实测）：

```
$ dsh --version
0.1.5-rc.1
$ which dsh
/opt/homebrew/bin/dsh
$ ls -la ~/.dsh/.credentials.yaml
-rw-------  1 mutou  staff  712 Sep 10 21:06 /Users/mutou/.dsh/.credentials.yaml
```

> **特别说明（与旧报告的关系）**：本票声称完成的旧报告 `docs/wayfinder/research-credai.md` 在本仓库
> **完全不存在**——`docs/wayfinder/` 目录本身都不存在，`git log --all -- docs/wayfinder/research-credai.md`
> 为空输出。故本报告不继承旧结论，全部重新取证；旧结论仅在 §8 作为被核对对象列出。
>
> 另：`gh issue view 56` 与 `gh issue view 60` 至今均为 `OPEN`。

---

## TL;DR

1. **AI 密钥在 `refs:` 区，键名就是 provider 声明的环境变量名**（DeepSeek 官方路由 = `DEEPSEEK_API_KEY`）；
   `records:` 区是**插件作用域**记录（`<scope>/<id>`），本机实际只有一条 `client-connection/browser-session`
   （`kind: grant`），不含 AI 密钥。本机确有 5 个 refs 键，其中 4 个是第三方 provider 的密钥。
2. **优先级链已被源码逐行确认**：`process.env` > `$DSH_HOME/.credentials.yaml` > `<调用方 cwd>/.env` > `$DSH_HOME/.env`。
   Windows 对**环境变量名**大小写不敏感（YAML 文档里的键名仍按原样匹配）。
3. **dsh 没有任何"读回密钥值"的官方途径**——官方 Remote 接口 `credentials.describe` 明确只返回
   `{configured, source, writable}`，源码注释逐字写着 "no read path returns it"。桌面壳**必须**直接读文件。
   `dsh_home()` 已存在（`DESK/src/settings.rs:157`），`serde_yaml` 已是依赖（`DESK/Cargo.toml:26`）。
4. **端点 = OpenAI 兼容 `POST {base}/chat/completions` + `Authorization: Bearer <key>`**，
   默认 `https://api.deepseek.com`，可用 `DEEPSEEK_BASE_URL` 覆盖。默认模型目录含
   `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`；
   产品层事实默认是 **`deepseek-v4-flash`**。注意 dsh 自己发的是**流式**请求。
5. **dsh 确实有可复用的 AI 入口，但都不是"裸补全"**：`dsh --profile headless "<task>"`
   （一次性 Agent，stdout 出最终文本）与 `dsh --profile sdk`（stdio NDJSON JSON-RPC）。
   两者都是**完整 agent loop**（带 persona、工具、会话持久化），对"解释一段 stderr"而言过重；
   **推荐仍然自己发 HTTP**，headless 作为"不想自己管密钥/端点"的兜底路径。
6. **reqwest 方案可行但要显式关默认 feature**：`reqwest` 默认 features 会引入 **+49 个 lock 包**
   （含需 CMake 的 `aws-lc-sys` 与 HTTP/3 的 `quinn`）。推荐
   `reqwest = { version = "0.13", default-features = false, features = ["json", "native-tls"] }`，
   实测 **+16 个 lock 包、macOS 走 Security.framework / Windows 走 Schannel、两平台均不编译 OpenSSL**。
   **降级策略必须是"任何失败静默返回 None，绝不阻塞隔离主流程"**。
7. **密钥永不出现在日志/UI**：只显示来源标签 + `sk-***`；发送给模型前把 home 绝对路径替换为 `~`。

---

## 1. `.credentials.yaml` 的精确格式（对应问题 1）

### 1.1 文件位置与权限

解析器 `PKG/dsh-credentials-local/lib/index.js`：

- `:49` `const CREDENTIALS_FILENAME = ".credentials.yaml";`
- `:58` `filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), ".credentials.yaml"))`

即默认位于 `$DSH_HOME/.credentials.yaml`；`$DSH_HOME` 由 `DSH_HOME` 环境变量决定，否则 `~/.dsh`
（`PKG/dsh-home-paths/lib/index.js:73-75`，且 `expandHomePath` 会展开 `~` 前缀）。

权限方面 `:63-64` 定义 `GROUP_OTHER_BITS = 63`（即 `0o77`），`:92-106` 的 `assertOwnerOnly()`
在 **POSIX** 上拒绝任何 group/other 可读的凭据文件并直接抛错；`:102` 在 `win32` 上**直接 return 跳过检查**
（源码注释：Windows 的 ACL 无法用 mode 表达，宁可不做也不假装做）。

### 1.2 真实结构样例（已脱敏，键名保留、值全部替换）

对本机 `~/.dsh/.credentials.yaml`（712 字节，0600，14 行）做**逐行键名提取**后的结构如下。
**所有密钥值均替换为占位符，本报告不含任何明文**：

```yaml
version: 1                      # 整数 1，必填（空文档例外）
refs:                           # 区一：环境变量名 → 密钥值（非空字符串）
  COMMANDCODE_API_KEY: sk-***   # 本机存在（93 字符）
  MINIMAX_CN_API_KEY: sk-***    # 本机存在（125 字符）
  ANIONEX_FREE_VISION: sk-***   # 本机存在（125 字符）
  ZAI_CODING_CN_API_KEY: sk-*** # 本机存在（49 字符）
  DEEPSEEK_API_KEY: sk-***      # 本机存在（35 字符）← dsh 官方 DeepSeek 路由读这个
records:                        # 区二：<scope>/<id> → 凭证记录
  client-connection/browser-session:
    kind: grant                 # 本机该记录为 grant（非 api-key）
    payload:
      version: 1
      secret: "***"             # 43 字符
```

> 上表中的值长度仅用于说明"确实有值"，**不构成任何明文泄漏**；报告全篇不含密钥内容。

### 1.3 顶层 schema 与解析规则（全部逐行取证）

`PKG/dsh-credentials-local/lib/index.js`：

| 规则 | 行号 | 内容 |
|---|---|---|
| 文档版本常量 | `:124` | `const DOCUMENT_VERSION = 1;` |
| 空文档 = 空存储 | `:146-149` | `if (keys.length === 0) return { refs: new Map(), records: new Map() }`（**不需要 version**） |
| version 必填 | `:150` | 无 `version` → 抛"pre-release flat layout"错误 |
| version 必须 === 1 | `:151` | `declares version ${...}; this build reads version 1` |
| 顶层键白名单 | `:152` | 只允许 `version` / `refs` / `records`，未知顶层键**直接抛错** |
| refs 区 | `:191-201` | 键过 `credentialRef()` 校验；值必须是 `string`；**空字符串被拒绝** |
| records 区 | `:202-210` | 键过 `parseCredentialKey()`；值过 `parseRecord()` |
| api-key 记录字段 | `:237-251` | 允许 `kind` / `key` / `env`；`key` 非空字符串；`env` 是 `{NAME: 非空字符串}` |
| grant 记录字段 | `:252-260` | 允许 `kind` / `payload`；`payload` 必须是可 JSON 往返的值 |
| 未知 kind | `:261-262` | 无 `kind` 或无匹配 → 抛错 |
| 未知字段 | `:265-266` | `assertFields()` 拒绝 typo，**不静默丢弃** |
| 重复键 | `:137-141` | `uniqueKeys: true`，重复键成为解析错误 |

键名两侧的语法（`PKG/dsh-credentials/lib/index.js`）：

- `:13` `const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;` → **refs 的键必须是 POSIX 环境变量名形态**
- `:15` `const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;` → records 的 scope 与 id 都必须是**小写连字符标识符**
- `:67-72` `parseCredentialKey()` 要求**恰好两段** `<scope>/<id>`

> **一个重要的健壮性事实**：解析器对未知顶层键、未知 kind、未知字段一律**抛错而非忽略**
> （`:126-131` 注释原文："Everything is rejected rather than skipped … because this file holds
> nothing but credentials and a silently ignored entry reads as 'the credential I stored has no effect'"）。
> 这意味着 **dsh 未来版本一旦扩展文档格式，任何"照抄严格性"的 Rust 解析器都会连带失效**——
> Rust 侧必须宽松解析（见 §3.3）。

### 1.4 预发布扁平布局的自动迁移

`:171-190` `renderFlatLayoutMigration()` + `:672-689` `migrateFlatDocument()`：
无 `version` 键、顶层直接是 `名字: 值` 的旧布局会被**自动就地升级**为 `version: 1` + `refs:` 嵌套，
且在写锁内重读后执行（`:673-688`）。因此 Rust 侧**可能**遇到无 `version` 的旧文件——但只在本机 dsh
从未启动过的情况下；本机该文件已是 version 1。

### 1.5 AI 密钥到底在哪个区、是否区分 provider

**结论：官方 DeepSeek 路由的 AI 密钥在 `refs` 区，键名 = `DEEPSEEK_API_KEY`；provider 区分靠"每个
provider 插件各自声明自己的 `apiKeyEnv`"。**

- `PKG/dsh-llm-deepseek/lib/index.js:1838` `const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";`
- `:1885` `apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),`
- `:2038-2043` 解析路径：
  ```js
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-deepseek", ref);
  ```
- 第三方 provider 走 `PKG/dsh-llm-pi-ai/lib/index.js:984` `apiKeyEnv: z.string().role("credential-ref"),`，
  文档示例（`:2493-2506`）给出 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `ACME_GATEWAY_API_KEY`。

**`records` 区也具备承载 API key 的能力**，但语义不同——它是**插件作用域**的：
`PKG/dsh-llm-pi-ai/lib/index.js:1927` `const RECORD_SCOPE = "llm-pi-ai";`，
`:1933-1935` `recordKeyFor(providerId)` → `llm-pi-ai/<provider-id>`，
`:1967-1973` 把 `kind: api-key` 记录翻译成 pi-ai 的 `{ type: "api_key", key, env }`。

> 所以旧结论 a 的"AI 密钥在 refs 区"**对本机当前配置成立**，但要注意它**不是普遍真理**：
> 若用户走 pi-ai 路由（OpenAI/Anthropic 等），密钥可能在 `records/llm-pi-ai/<provider>` 里。
> 实现票 #60 若只读 `refs` 会漏掉这部分用户。

---

## 2. dsh 如何解析它 / 优先级链（对应问题 2）

### 2.1 权威文档：模块头注释

`PKG/dsh-credentials-local/lib/index.js:13-21` 逐字：

```text
 * File-backed credentials provider over `$DSH_HOME/.credentials.yaml`, layered
 * against the environment by how much each layer is trusted:
 *
 * inherited process environment      (read-only, wins)
 * > $DSH_HOME/.credentials.yaml      (provider-managed, writable)
 * > <invocation cwd>/.env            (read-only fallback)
 * > $DSH_HOME/.env                   (read-only fallback)
```

### 2.2 实现：`resolve()` 的三级短路

`PKG/dsh-credentials-local/lib/index.js:473-490`：

```js
resolve(ref) {
  const inherited = this.inherited(ref);                       // ① process.env
  if (inherited !== void 0) return Promise.resolve({ value: inherited, source: "env" });
  const stored = this.values.get(ref);                          // ② .credentials.yaml refs
  if (stored !== void 0) return Promise.resolve({ value: stored, source: "file" });
  const fallback = this.dotenvFallback(ref);                    // ③ project-env → user-env
  if (fallback !== void 0) return Promise.resolve({ value: fallback.value, source: fallback.source });
  return Promise.resolve(void 0);
}
```

- `:428-431` `inherited()` → `launchEnvironmentOf(this.ctx).getFrom(ref, ["process"])`，且要求 `value.length > 0`
- `:437-440` `dotenvFallback()` → `getFrom(ref, ["project-env", "user-env"])`（同一函数内已按 `SOURCE_ORDER` 排序）

### 2.3 两个 `.env` 层分别是什么文件

`PKG/dsh-app-boot/lib/index.js:1074-1099` `loadLayeredEnv()`：

```js
const home = resolveDshHome();
const inherited = { ...process.env };
const project = readEnvLayer(binName, cwd, warn, home);              // :1077 → <cwd>/.env
const user = home === resolve(cwd) ? void 0 : readEnvLayer(binName, home, warn, home);  // :1078 → <$DSH_HOME>/.env
```

注释 `:1064` 写明："inherited > invoking-directory `.env` > Harness-home `.env`"，
`:1069` 说明 `cwd` 是"the invoking directory whose `.env` is the project layer"。

层级顺序常量 `PKG/dsh-launch-environment/lib/index.js:10-14`：
```js
const SOURCE_ORDER = [ "process", "project-env", "user-env" ];
```

### 2.4 Windows 大小写敏感性（本票特别要求核实）

`PKG/dsh-launch-environment/lib/index.js:21-24`：

```js
function lookupKey(name) {
  /* v8 ignore next -- native Windows coverage exercises the folding arm; POSIX covers the exact one */
  return process.platform === "win32" ? name.toUpperCase() : name;
}
```
`:16-17` 注释："Windows treats environment names case-insensitively; every other platform does not."

**确切边界（重要，容易误读）**：大小写折叠发生在**环境层**（`process.env` / 两个 `.env` 文件的
层快照，`:34` 建索引时统一折叠）。而 `refs` 区的键是存进 `Map` 后按**原样** `this.values.get(ref)`
查的（`:479`），`ref` 来自 provider 配置里的品牌化名字。所以：

- Windows 上 shell 里 `deepseek_api_key=xxx` **能**被识别（环境层折叠）；
- 但 YAML 里写成 `deepseek_api_key: sk-***` **不能**被识别——`parseRefs()` 会先过
  `credentialRef()`（`PKG/dsh-credentials/lib/index.js:13` 的 `REF_PATTERN` 允许小写字母），
  语法上**通过**，但 `DEEPSEEK_API_KEY` 查不到它。此点属"语法允许但语义不匹配"的静默陷阱。

### 2.5 空值的语义

`:99`（`PKG/dsh-credentials/lib/index.js` 文档）："an empty stored value is absent everywhere
— `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a
configured secret." 与 `:430` 的 `value.length > 0`、`:196-197`（空值直接拒绝写入）一致。
**Rust 侧应复刻"空值 = 未配置"**。

### 2.6 继承环境会"遮蔽"写入

`PKG/dsh-credentials-local/lib/index.js:636-638` `assertUnshadowed()`：若继承环境已提供该 ref，
写入会被拒绝并提示 "is supplied read-only by the launching environment"。这是 dsh 的行为，
桌面壳**只读**，不受影响，但解释了为什么"环境变量永远优先"。

---

## 3. 从 Rust 后端读取它的最佳方式（对应问题 3）

### 3.1 先说结论：**没有比直接读文件更稳的官方途径，因为官方根本不给读**

逐个排查了所有可能的"官方途径"：

**(a) 官方 Remote 接口 `credentials.*` —— 只能写、不能读。**
`PKG/dsh-api-settings-controller/lib/types/credentials.js`：

- `:104` `super(ctx, 'credentialsController', { namespace: 'credentials' });`
- `:116-122` `describe(refs)` → 返回 `projectCredentialInfo(...)`，即 `{configured, source, writable}`
  （见 `PKG/dsh-credentials-local/lib/index.js:491-512`）——**不含 value**
- `:123-135` `set(ref, value)`，`:124-125` 注释原文：

  > "Store one value from a configuration surface. **The value crosses the wire in this direction
  > only: no read path returns it.**"

**(b) CLI 子命令 —— `dsh --help` 全量输出里没有任何凭据查询命令：**

```
$ dsh --help
Usage: dsh [options] [command] [args...]
...
Commands:
  web [options] [args...]        boot the web profile (alias of --profile web);
                                 the web app's own flags follow
  plugin [options] [args...]     manage a profile's plugins by forwarding the
                                 remaining arguments to pnpm in the profile
                                 directory
```
（完整输出见 §5.1。只有 `web` 与 `plugin`，加上 `--profile <name>` 透传到 app 自身。）

**(c) 结论**：桌面壳**必须**直接读 `$DSH_HOME/.credentials.yaml`。这不是退而求其次，而是唯一路径。

### 3.2 可直接复用的既有代码

- `DESK/src/settings.rs:156-168` 已有 `dsh_home()`（`pub(crate)`）：

  ```rust
  /// dsh 数据目录（$DSH_HOME 或 ~/.dsh）。
  pub(crate) fn dsh_home() -> PathBuf {
      if let Ok(h) = std::env::var("DSH_HOME") {
          if !h.trim().is_empty() {
              return PathBuf::from(h);
          }
      }
      #[cfg(windows)]
      let base = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_default();
      #[cfg(not(windows))]
      let base = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
      base.join(".dsh")
  }
  ```

- `DESK/src-tauri/Cargo.toml:26` 已有 `serde_yaml = "0.9"`；`:24-25` 已有 `serde` / `serde_json`。
  即**解析 YAML 不需要新增任何依赖**。

> **⚠️ 与 dsh 的一处真实分歧**：dsh 的 `resolveDshHome()` 会 `expandHomePath()` 展开 `~`
> （`PKG/dsh-home-paths/lib/index.js:73-75`），而 Rust 的 `dsh_home()` 直接 `PathBuf::from(h)`，
> **不展开 `~`**。若用户设 `DSH_HOME=~/my-dsh`，dsh 会用 `/Users/mutou/my-dsh`，
> 桌面壳会去找字面量 `~/my-dsh` 而失败。建议在 #60 里顺手加 `~` 展开（或在文档里记为已知限制）。

### 3.3 实现要点与风险

推荐用一个**独立的、只读的、尽力而为**的小模块（例如 `DESK/src/ai/credentials.rs`），三条铁律：

1. **解析必须宽松，不能照抄 dsh 的严格性。**
   dsh 对未知顶层键 / 未知 kind / 未知字段一律抛错（§1.3）。桌面壳若同样严格，则 dsh 一旦升版扩展
   格式，桌面壳的 AI 功能就会连带失效。**Rust 侧应只提取自己认识的字段，其余静默忽略**，
   并用 `#[serde(default)]` 兜底。
2. **只读、绝不回写**。`records` 区含 `grant.payload.secret` 这类 OAuth 凭据；
   桌面壳没有任何理由写这个文件（dsh 自己用 `writeFileAtomic` + 跨进程文件锁写入，`:549`、`:557-560`，
   写锁等待上限 `:78` `DOCUMENT_LOCK_WAIT_MS = 3e4`）。
3. **复刻"空值 = 未配置"**，且**环境变量优先**（§2.2）。

| 风险 | 事实依据 | 处置建议 |
|---|---|---|
| 文件权限 | dsh 自己会拒绝 `0o077` 以外的位（`:92-106`）；Windows 跳过检查（`:102`） | 桌面壳**不要**做这个校验（我们是读者不是密钥经纪人），更不能 `chmod` 放宽；只要求"能打开" |
| 并发写导致读到半个文件 | dsh 用 `writeFileAtomic`（`:557-560`、`:620-623`），是原子替换而非就地改写 | 正常情况不会撕裂；仍建议解析失败时**重试一次**再判定失败 |
| 文件不存在 | `loadInitial()` `:647-655` 把 ENOENT 当作空存储 | 同样当作"无凭据"，**不是错误**，不要弹错误 |
| 旧扁平布局 | 自动迁移 `:171-190`、`:672-689` | 顺手兼容：无 `version` 时把顶层键直接当 refs |
| 解析失败降级 | — | 返回 `None`，UI 显示"AI 解读不可用（凭据不可读）"，**隔离主流程照常进行** |
| `~` 不展开 | §3.2 | 建议补 `~` 展开 |
| 密钥进日志 | 见 §7 | 结构化类型上不要实现 `Debug`/`Display` 直出，或实现为脱敏版本 |

### 3.4 推荐 crate 与 feature 组合

```toml
# DESK/src-tauri/Cargo.toml
# YAML：无需新增（serde_yaml 0.9 已在 :26）
# HTTP：仅此一项新增直依赖，且必须关闭默认 features
reqwest = { version = "0.13", default-features = false, features = ["json", "native-tls"] }
```

实测代价见 §6。**绝不要**写成 `reqwest = "0.13"`（默认 features）。

---

## 4. AI API 端点与模型（对应问题 4）

全部出自 `PKG/dsh-llm-deepseek/lib/index.js`：

| 项 | 值 | 行号 |
|---|---|---|
| provider 路由名 | `deepseek-official` | `:1840` |
| 默认 API key 环境变量 | `DEEPSEEK_API_KEY` | `:1838` |
| 端点覆盖环境变量 | `DEEPSEEK_BASE_URL` | `:1913` |
| 公开默认端点 | `https://api.deepseek.com` | `:1911` |
| 端点解析顺序 | `config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? "https://api.deepseek.com"` | `:1993` |
| 请求路径 | `${connection.baseURL}/chat/completions` | `:1770` |
| 鉴权头 | `"authorization": \`Bearer ${apiKey}\`` | `:1661` |
| 其它头 | `content-type: application/json`、`accept: text/event-stream` | `:1660-1663` |
| 默认 maxTokens | `256000`（`DEFAULT_MAX_TOKENS = 256e3`） | `:1394` / `:1998` |
| 默认上下文窗口 | `1000000`（`DEFAULT_CONTEXT_WINDOW = 1e6`） | `:1392` / `:1999` |
| 流空闲超时 | `300000`ms（`DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5`） | `:1390` / `:1966` |
| 可配置项 | `apiKeyEnv`(`:1885`) / `baseURL`(`:1886`) / `thinking`(`:1887`) / `reasoningEffort`(`:1888`) / `maxTokens`(`:1894`) / `models`(`:1896`) | — |

**默认模型目录**（`:1841-1871` `DEFAULT_MODELS`）：

```js
const DEFAULT_MODELS = [
  { id: "deepseek-flash",              name: "DeepSeek-V41-Flash",           inputModalities: ["text","image"], systemPromptUpdate: "in-history" },
  { id: "deepseek-v4-flash",           name: "DeepSeek-V4-Flash",            description: "Fast, efficient, and economical; suited to focused, routine, or parallel tasks." },
  { id: "deepseek-v4-pro",             name: "DeepSeek-V4-Pro",              description: "Stronger agentic coding, knowledge, and difficult reasoning; …" },
  { id: "deepseek-v4-flash-vision-exp",name: "DeepSeek-V4-Flash-Vision-Exp", inputModalities: ["text","image"] },
];
```

> 目录里**没有**"哪个是默认"的标记；`models` 只是"advisory model catalog"（`:1914` 注释）。
> **产品层的事实默认是 `deepseek-v4-flash`**，三处独立证据：
> - `PKG/dsh-acp-app/cordis.patch.yml:21` → `model: deepseek-v4-flash`
> - `PKG/dsh-web-search-deepseek/lib/index.js:23` → `const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";`
> - `PKG/dsh-client-connection/lib/client.js` 多处（`:2421`、`:3553`、`:5338`、`:5518`、`:6022`）

**是 DeepSeek 官方还是 OpenAI 兼容？** 两者皆是：协议是 **OpenAI 兼容**的
`POST /chat/completions` + Bearer；默认**指向 DeepSeek 官方**；端点**可被覆盖**
（`DEEPSEEK_BASE_URL` 环境变量，或 profile 里的 `baseURL` 配置）。
`:1956-1959` 注释说明设计意图："Every layer may supply an endpoint: the product trusts the project
it is launched in, so a checkout can point its own agent at the gateway that checkout is meant to use."

**一处与 dsh-safe 的重要差异**：dsh 官方适配器发的是**流式**请求
（`accept: text/event-stream`，`:1663`），而 dsh-safe 的 `ai.js:41` 是
`{ model, messages, temperature: 0, stream: false }` **非流式**。桌面壳做一次性
explain 用**非流式**更简单（无需 SSE 解析），两者对同一端点都合法。

### 4.1 端点可达性实测（不帶密钥、不产生费用）

```bash
$ curl -s -o /dev/null -w '%{http_code}' -X POST https://api.deepseek.com/chat/completions \
    -H 'content-type: application/json' -d '{"model":"x","messages":[]}' --max-time 20
401
$ curl -s -o /dev/null -w '%{http_code}' https://api.deepseek.com/ --max-time 20
401
$ curl -s -o /dev/null -w 'connect=%{time_connect}s tls=%{time_appconnect}s' https://api.deepseek.com/ --max-time 20
connect=0.002727s tls=0.027659s
```

**结论**：本机网络可达 `api.deepseek.com`，TLS 握手正常（约 28ms）。
**未发送任何密钥**，服务端在鉴权前即返回 401，故**没有产生任何计费请求**。
（本次调研全程未发出带 Authorization 头的真实调用。）

---

## 5. dsh 是否存在可复用的 AI 调用接口（对应问题 5）

**结论：有，而且是官方一等公民；但都是完整 agent loop，不是裸补全。**
因此"桌面壳必须自己发 HTTP"作为**推荐路径**成立，作为**唯一可能**不成立。

### 5.1 实证一：`dsh --help` 全量输出

```bash
$ dsh --help
Usage: dsh [options] [command] [args...]

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.

Arguments:
  args                           arguments for the booted profile's app (see:
                                 dsh --profile <name> --help)

Options:
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  initialize a new custom profile from a shipped
                                 profile template
  --patch <path>                 extra patch-list overlay applied after the
                                 profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-default-config          print the profile tree without its user layer
                                 or --patch overlays and exit

Commands:
  web [options] [args...]        boot the web profile (alias of --profile web);
                                 the web app's own flags follow
  plugin [options] [args...]     manage a profile's plugins by forwarding the
                                 remaining arguments to pnpm in the profile
                                 directory

Examples:
  dsh --profile web                          boot the web profile (same as: dsh web)
  dsh --profile rescue --from-default-profile web
                                             create rescue from the shipped web template, then boot it
  dsh --profile headless "run the tests"     answer one task, print the result, and exit
  dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsh --profile web --help                   the web app's own flags and help
  dsh plugin --profile tui add <package>     install a plugin into the tui profile
```

注意 `Examples` 里的官方示例（`CLI/bin.js:37`）：
`dsh --profile headless "run the tests"  answer one task, print the result, and exit`。

### 5.2 实证二：`headless` 是**出厂内置** profile（无需初始化）

`PKG/dsh-app-boot/lib/index.js:328-349`：

```js
const PROFILE_TEMPLATES = {
  acp:  { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"],   patchReload: "startup" },
  web:  { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],  patchReload: "live" },
  headless: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"], patchReload: "startup" },
  sdk:  { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],  patchReload: "startup" },
  "sdk-minimal": { bundles: ["@deepseek-ai/dsh-sdk-minimal"],              patchReload: "startup" }
};
```

且**首次使用会自动初始化**（`PKG/dsh-app-boot/lib/index.js:886-895`）：

```js
function loadProfile(binName, name, installAnchor, home = resolveDshHome(), options = {}) {
  const dir = resolveProfileDir(name, home);
  if (!existsSync(join(dir, "package.json"))) {
    const template = PROFILE_TEMPLATES[name];
    if (template === void 0) throw new Error(`${binName}: profile ${JSON.stringify(name)} does not exist; …`);
    initProfile(dir, template.bundles, template.patchReload);
  }
  …
}
```

即 `dsh --profile headless "<task>"` **开箱可用**，不需要 `--from-default-profile`。
（本机 `~/.dsh/profiles/` 下当前只有 `web` 与 `smoke` 两个目录，`headless` 尚未初始化——
首次调用会创建它。**注意这会写入 `$DSH_HOME`**，本次调研**没有执行**该命令。）

### 5.3 headless 的确切行为

`PKG/dsh-headless/lib/index.js:9-17` 模块文档逐字：

> `@deepseek-ai/dsh-headless` — one-shot direct Agent driver. The bundle patch
> rides over dsh-base without Host, HTTP, or browser plugins; this runner
> creates one Agent through the core registry, drives the task to quiescence,
> streams provider reasoning to stderr, flushes its Session, prints the final
> assistant text to stdout, and exits.

即：**stdout = 最终 assistant 文本**，**stderr = 推理流**，进程一次性退出。配置 `Config` 仅
`:26` `z.object({ task: z.string().required() })`。

### 5.4 实证三：`sdk` profile = stdio NDJSON JSON-RPC

`PKG/dsh-sdk-app/README.md` 模块头：

> SDK stdio application profile for users and maintainers launching a JSON-RPC harness runtime.
> … Stdout is reserved for newline-delimited JSON-RPC frames.

协议方法（`PKG/dsh-sdk-jsonrpc-server/lib/index.js:196-201`）：

```js
async handleRequest(method, params) {
  switch (method) {
    case "initialize": return this.initialize(params);
    case "session/prompt": return this.prompt(params);
    case "shutdown": return this.shutdown();
    default: throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`);
  }
}
```

`initialize` 接受的参数（`:110-132`）：`cwd`、`provider`、`model`、`reasoningEffort`、`maxTokens`；
`:114-118` 在未注册 adapter 时，对 `provider === "deepseek-official"` 会**自动挂载 DeepSeek 适配器**：

```js
if (!this.hasAdapterFor(provider)) {
  if (provider !== "deepseek-official") throw new Error(`no adapter registered for provider "${provider}"`);
  this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {});
}
```

`session/prompt`（`:139-155`）接受 `sessionId` + `contentBlocks`，返回 `{ messageId }`。

### 5.5 三条路径的取舍

| 路径 | 凭证处理 | 依赖 | 代价 | 适合 |
|---|---|---|---|---|
| **自己发 HTTP**（推荐） | 需自己读 `refs`/env | +1 直依赖（reqwest） | 一次 HTTP 往返；完全可控 | explain/repair 这种单轮、小输入的调用 |
| `dsh --profile headless "<task>"` | **完全复用 dsh 的凭据链**，零密钥处理 | 需 dsh 已装；首跑会在 `$DSH_HOME/profiles/headless` 落盘 | 起一整个 agent（persona + 工具 + 会话持久化），秒级~十秒级启动，token 开销远大于单轮 | 兜底路径；或希望"顺带用上用户配好的模型/端点" |
| `dsh --profile sdk` + JSON-RPC | 同上 | 同上 | 需常驻子进程 + NDJSON 协议实现 | 需要复用**同一个** agent 会话做多轮 |

> 由于 headless/sdk 都会起完整 agent，而 #60 的 explain 输入只是一段 stderr + 失败类型，
> **推荐主路径自己发 HTTP**；headless 作为"用户没有显式配置但 dsh 能用"的兜底。
> 另注：`dsh --profile headless` 会与正在运行的 `dsh web` 争用同一个 `$DSH_HOME`，
> 首次初始化有写盘副作用，实现时要意识到这一点（本机 3080 上的 web 实例**未被本次调研触碰**）。

---

## 6. Rust 移植代价核实（对应问题 6）

### 6.1 现状核实

`DESK/src-tauri/Cargo.toml` **没有 reqwest**（全文 38 行，见 `:18-38` 的 `[dependencies]` 段）：
已有 `tauri 2`（`:19`，features `tray-icon`/`image-png`/`macos-private-api`）、
`tauri-plugin-log`/`notification`/`single-instance`/`window-state`（`:20-23`）、
`serde`/`serde_json`/`serde_yaml`（`:24-26`）、`log`（`:27`）、
`tokio`（`:28`，features `time`/`net`/`io-util`/`sync`/`rt-multi-thread`）、
`base64`（`:29`）、`netstat2`（`:30`）、`libc`（`:31`）、`cookie`（`:32`）、
`thiserror`/`anyhow`（`:35-36`）；windows-sys 仅 windows target（`:37-38`）。

**全仓无任何 HTTP 客户端**——`grep -rn "reqwest\|hyper\|ureq\|curl" --include=*.rs` 无命中；
现有网络代码只有**裸 TCP**（`DESK/src/network/web_token.rs:54`、`DESK/src/network/notify.rs:58`、
`DESK/src/network/remote.rs:221`、`DESK/src/process/probing.rs:12`）。

> **�“Cargo.lock 里已经有 reqwest”是一个陷阱。** `DESK/src-tauri/Cargo.lock:3088` 确实有
> `reqwest 0.13.4`，而且依赖图里写着 `tauri -> reqwest`。但 tauri 2.11.5 的
> `Cargo.toml:321-327` 把它声明在**目标条件**下：
> ```toml
> [target.'cfg(any(target_os = "android", all(target_vendor = "apple", not(target_os = "macos"))))'.dependencies.reqwest]
> version = "0.13"
> features = ["json", "stream"]
> default-features = false
> ```
> 即 **Android 与"Apple 但非 macOS"（iOS 等）**——**macOS 桌面与 Windows 都被排除**。
> Cargo.lock 收录所有 target 的依赖，所以"lock 里有"**不等于**"会被编译"。
> 实测确认：在未加依赖的基线上
> ```bash
> $ cargo tree -e normal --target aarch64-apple-darwin | grep -ciE "reqwest|native-tls|rustls"
> 0
> ```
> 所以新增 reqwest 在**两个 CI 目标上都是真·第一次编译**，代价是真实的。

### 6.2 四种方案的实测代价

方法：把 `DESK/src-tauri`（排除 `target/`）复制到 `/tmp/ds-probe`，逐个 `cargo add` 并对比
`Cargo.lock` 的 `[[package]]` 数量（基线 **519**），再用 `cargo tree --target` 看**真实编译进树**的 crate。
工具链 `cargo 1.96.0`。（探针目录已删除，**仓库未被修改**。）

| 方案 | lock 包数 | 增量 | 实际引入的 TLS/重物 |
|---|---|---|---|
| 基线（无 reqwest） | 519 | — | 无（`cargo tree` 0 命中） |
| **A.** `cargo add reqwest --features json`（默认 features） | 568 | **+49** | **`aws-lc-rs` + `aws-lc-sys`**（需 CMake + C 工具链）、`ring`、`rustls`、**`quinn`/`quinn-proto`/`quinn-udp`**（HTTP/3）、`h2`、`security-framework`、`schannel`、`jni` |
| **B.** `--no-default-features --features json,rustls` | 558 | **+39** | 仍含 `aws-lc-sys`+`cmake`、`quinn`、`ring`、`rustls-platform-verifier` |
| **C.** `--no-default-features --features json,native-tls` | 535 | **+16** | `native-tls`、`security-framework`、`schannel`、`hyper-tls`、`vcpkg` |
| **D.** `cargo add tauri-plugin-http` | 563 | **+44** | `rustls`+`ring`+`quinn`+`cookie_store`+`publicsuffix`+`tauri-plugin-fs` |

方案 A 的重物实测（`cargo tree --target aarch64-apple-darwin`）：

```
$ cargo tree -e normal --target aarch64-apple-darwin | grep -iE "aws-lc-sys|aws-lc-rs|quinn"
│   │   │   │   │   │           └── string_cache v0.9.0
│   │   │   │   ├── aws-lc-rs v1.18.1 (*)
│   │   │   │   ├── aws-lc-sys v0.45.0
│   │   │   ├── aws-lc-rs v1.18.1
```

### 6.3 关键发现：`native-tls` **不会**让 macOS/Windows 编译 OpenSSL

方案 C 的 lock 里**出现了 `openssl-sys`**，但它是 **target-gated** 的——用 `cargo tree --target`
分别看两个 CI 目标，实际编译链是：

```
=== macOS aarch64 ===
├── native-tls v0.2.18
├── security-framework v3.7.0
└── security-framework-sys v2.17.0

=== Windows x86_64-msvc ===
├── native-tls v0.2.18
└── schannel v0.1.29
```

即：**macOS 走系统 Security.framework，Windows 走系统 Schannel，两者都不编译 OpenSSL、
不需要 CMake、不需要 vendored C 工具链**。`openssl-sys` 只落在 Linux 分支上（在 lock 里可见，
但不进我们两个目标的编译树）。

对比方案 B/A 会拉进 **`aws-lc-sys`**——它需要 **CMake + C 编译器**在构建期编译密码学库，
这是 Windows CI（`windows-latest`，见 `.github/workflows/release.yml:9-16` 的 matrix）最容易翻车的地方。

### 6.4 明确推荐

```toml
# DESK/src-tauri/Cargo.toml
reqwest = { version = "0.13", default-features = false, features = ["json", "native-tls"] }
```

**理由**：
1. 增量最小（**+16** 个 lock 包，vs 默认 features +49 / plugin-http +44）；
2. 两平台都走**操作系统 TLS 栈**，无 CMake、无 aws-lc-sys、无 OpenSSL 编译，CI 风险最低；
3. Windows 用 Schannel 意味着**自动信任企业根证书**——对需要经过公司 MITM 代理的用户更友好
   （反之 rustls 用内置根证书，会在这类环境失败）；
4. 复用已有的 `serde_json`，不需要额外 `json` 之外的 feature；
5. 它是**唯一**需要新增的直依赖（`serde`/`serde_json`/`serde_yaml`/`tokio` 都已在 `Cargo.toml:24-28`）。

**不推荐 `tauri-plugin-http`**：它比裸 reqwest 更重（+44 且额外拉 `tauri-plugin-fs`、`cookie_store`、
`publicsuffix`），而且它主要为**前端 JS 侧**发起请求设计，需要在
`capabilities/*.json` + `permissions/` 里做权限接线（本项目 `AGENTS.md` 对新命令有"三步注册"要求），
对一个纯后端、单次、非流式的调用是**过度工程**。

**Cargo.lock 影响**：基线锁定 `reqwest 0.13.4`；新增直依赖后解析到 `0.13.5`（本次实测），
连同 16 个新条目一并写入。因为 `DESK/src-tauri/Cargo.lock` **是入库的**（`ls` 显示 133931 字节，
且被 CI 的 `Swatinem/rust-cache` 使用），这次 churn 需要随 PR 一起提交。

### 6.5 离线 / 无密钥 / 请求失败的降级行为（硬要求）

**explain 不可用绝不能阻塞隔离主流程。** 建议逐条对齐 dsh-safe 的既有契约
（`hyzyn/dsh-safe` `lib/ai.js:9-11` 注释原文）：

> 原则：任何失败（无 key / 网络 / 超时 / 响应异常）都静默返回 null，绝不
> 影响主流程；模型只是"多一个识别器/解释器"，不获得任何写权限

具体降级矩阵（建议实现）：

| 情形 | 行为 |
|---|---|
| 无 `DEEPSEEK_API_KEY`（env 与 refs 都没有） | 不显示"AI 解读"按钮，或置灰并提示"未配置 AI 凭据"；**不报错** |
| `.credentials.yaml` 不存在 / 不可读 / 解析失败 | 同上；记一条 `warn` 日志（**不含任何值**） |
| 文件权限异常导致读失败 | 同上；**不要**尝试 chmod 修复 |
| 网络不可达 / DNS 失败 / TLS 失败 | 返回 `None`，UI 显示"AI 解读暂时不可用"；**可重试** |
| HTTP 401/403 | 返回 `None`，提示"AI 凭据无效或已过期"（**不要**打印响应体，可能回显 key 片段） |
| HTTP 429 / 5xx | 返回 `None`，建议稍后重试；不要自动重试超过 1 次 |
| 超时 | 返回 `None`（超时值见 §7.3） |
| 模型返回非 JSON / 空 | 返回 `None`，走"AI 未给出可用建议"分支 |
| 以上任意情形 | **隔离/禁用坏插件的主流程照常完成**；AI 只是附加信息 |

---

## 7. 密钥读取顺序与脱敏（对应问题 7）

### 7.1 推荐读取顺序（严格复刻 dsh，见 §2.2）

```
DEEPSEEK_API_KEY (process env)
  → .credentials.yaml  refs.DEEPSEEK_API_KEY
  → <$DSH_HOME>/.env   DEEPSEEK_API_KEY
  → <cwd>/.env         DEEPSEEK_API_KEY
```

注意 dsh 的顺序里 `project-env`(cwd/.env) 优先于 `user-env`($DSH_HOME/.env)
（`PKG/dsh-credentials-local/lib/index.js:437-440` +
`PKG/dsh-launch-environment/lib/index.js:10-14`）。桌面壳的 cwd 是应用自身，通常无 `.env`，
所以实际有效的是前两级；但**为一致性建议全实现**，且**遇到空值视为未配置**（§2.5）。

### 7.2 伪代码（可直接改写为 Rust）

```rust
/// AI 凭据来源标签（用于 UI 展示，不含值）。
enum CredentialSource { Env, CredentialsFile, ProjectDotEnv, UserDotEnv }

/// 解析顺序与 dsh 完全一致；任何一步失败都不致命。
fn resolve_api_key(ref_name: &str) -> Option<(String, CredentialSource)> {
    // ① process env（Windows 上环境变量名大小写不敏感 → 此处按平台折叠比较）
    if let Some(v) = lookup_env_case_aware(ref_name) {
        if !v.is_empty() {
            return Some((v, CredentialSource::Env));
        }
    }

    // ② $DSH_HOME/.credentials.yaml 的 refs 区
    //    —— 解析必须宽松：只取 refs，忽略 version 之外的未知顶层键与所有 records
    if let Ok(text) = std::fs::read_to_string(dsh_home().join(".credentials.yaml")) {
        if let Some(v) = parse_refs_lenient(&text, ref_name) {
            if !v.is_empty() {
                return Some((v, CredentialSource::CredentialsFile));
            }
        }
    }

    // ③ <cwd>/.env  （project-env，优先）
    // ④ $DSH_HOME/.env（user-env）
    for (path, src) in [
        (std::env::current_dir().ok()?.join(".env"), CredentialSource::ProjectDotEnv),
        (dsh_home().join(".env"),                  CredentialSource::UserDotEnv),
    ] {
        if let Ok(v) = parse_dotenv_key(&path, ref_name) {
            if !v.is_empty() {
                return Some((v, src));
            }
        }
    }

    None // 无凭据 → AI 功能降级，不报错
}

/// 宽松解析：只认 refs 下的标量字符串；未知顶层键 / 未知 kind / 未知字段一律忽略。
/// 与 dsh 的严格解析（未知键即抛错）刻意相反 —— 见 §1.3 与 §3.3。
fn parse_refs_lenient(yaml_text: &str, key: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Doc {
        #[serde(default)]
        refs: std::collections::BTreeMap<String, String>,
        // records / version / 未来新增的顶层键全部忽略
    }
    let doc: Doc = serde_yaml::from_str(yaml_text).ok()?; // 解析失败 → None
    doc.refs.get(key).cloned()
}
```

**类型设计建议**：把密钥包成一个不实现 `Display`/`Debug` 的 newtype，
例如 `struct Secret(String);` 且 `impl std::fmt::Debug for Secret { … write!(f, "sk-***") }`，
从类型上阻断"随手 `{:?}` 进日志"。

### 7.3 日志 / UI 防泄漏清单

1. **绝不打印**：密钥值、`Authorization` 头、请求体、完整响应体（401/400 的响应可能回显 key 片段）。
2. **只展示**：来源标签（"来自环境变量" / "来自 `~/.dsh/.credentials.yaml`"）+ 固定占位符 `sk-***`。
   dsh 自己的 `describe` 就是这个语义（`{configured, source, writable}`，见 §3.1），可以直接照搬成 UI 模型。
3. **发送前脱敏**：把 home 绝对路径替换为 `~`。这是 dsh-safe 的既有做法
   （`hyzyn/dsh-safe` `lib/ai.js:25-27`）：
   ```js
   export function redact(text) {
     return String(text ?? '').split(homedir()).join('~');
   }
   ```
   桌面上还应考虑脱敏用户名、以及 stderr 里可能出现的其它路径。
4. **错误链**：reqwest 的错误可能带 URL；确认 URL 里不含密钥（我们的 URL 是 `${base}/chat/completions`，
   密钥只在 header，安全）。但**不要**把 `err` 原样 `{:?}` 出去——用 `anyhow` 包装时注意保留上下文但剥离敏感字段。
5. **UI 权限**：密钥值不应跨 IPC 到前端。若必须传，只传 `configured: bool` + `source` 字符串。
6. 本报告自身已遵守：全文无任何密钥明文，值一律 `sk-***`。

---

## 8. 对实现票 #60 的直接影响（最容易踩的坑）

1. **只能自己读文件，没有官方读取 API。**
   `credentials.describe` 明确 "no read path returns it"
   （`PKG/dsh-api-settings-controller/lib/types/credentials.js:124-125`）。
   不要浪费时间去接 Remote/WebSocket 或找 CLI 子命令——`dsh --help` 里只有 `web`/`plugin`。

2. **解析要宽松，不要照抄 dsh 的严格性。**
   dsh 对未知顶层键、未知 kind、未知字段一律**抛错**（`PKG/dsh-credentials-local/lib/index.js:126-131`、
   `:152`、`:261-266`）。桌面壳若同样严格，dsh 一次格式扩展就会连带打断 AI 功能。
   Rust 侧只取 `refs`，其余 `serde(default)` + 忽略。

3. **别只读 `refs` 就以为覆盖了所有用户。**
   第三方 provider（pi-ai 路由：OpenAI/Anthropic 等）的密钥可能在
   `records/llm-pi-ai/<provider-id>`（`PKG/dsh-llm-pi-ai/lib/index.js:1927`、`:1933-1935`、`:1967-1973`）。
   本机恰好只有官方路由，所以只读 refs 在本机"看起来"够用——这是**最容易验证不出来**的坑。

4. **reqwest 必须写 `default-features = false`。**
   `reqwest = "0.13"` 默认会带进 **+49 个包**，含需要 **CMake** 的 `aws-lc-sys` 与 HTTP/3 的 `quinn`
   （§6.2 实测）。推荐 `features = ["json", "native-tls"]`（+16，两平台均不编译 OpenSSL）。
   另外**不要**因为 `Cargo.lock:3088` 已有 reqwest 就以为零代价——那是 tauri 对 android/iOS 的
   target-gated 依赖，macOS/Windows 上 `cargo tree` 实测 0 命中（§6.1）。

5. **`dsh_home()` 不展开 `~`，与 dsh 本身不一致。**
   `DESK/src/settings.rs:157-168` 直接 `PathBuf::from(h)`，而 dsh 的 `resolveDshHome()` 会
   `expandHomePath()`（`PKG/dsh-home-paths/lib/index.js:73-75`）。用户设 `DSH_HOME=~/x` 时两者会分叉。

6. **降级必须是"静默 None"，且首次 headless 调用有写盘副作用。**
   任何失败（无凭据/读失败/网络/超时/非 2xx/非 JSON）都只能让 AI 面板变灰，
   **绝不能影响隔离主流程**（对齐 dsh-safe `ai.js:9-11` 的既有契约）。
   若选择 headless 兜底路径，注意 `dsh --profile headless` 首次运行会在
   `$DSH_HOME/profiles/headless/` 落盘并初始化（`PKG/dsh-app-boot/lib/index.js:886-895`），
   而且会与正在运行的 `dsh web` 共用同一个 `$DSH_HOME`。

---

## 9. AI explain 输入/输出约定建议（可直接改写成 prompt）

### 9.1 输入（发给模型的内容）

建议把 dsh-safe `ai.js:60-74`（`explainFailure`）与 `:86-111`（`detectFailureWithAI`）两条路径
**合并为一次结构化调用**，因为 #60 同时需要"解释"与"兜底识别"：

```jsonc
{
  "failureKind": "boot-failed" | "quarantined" | "regex-miss",
  "profile": "web",
  "dshVersion": "0.1.5-rc.1",
  "stderrExcerpt": "<截断并脱敏后的 stderr>",
  "knownRows": [                       // 仅 regex-miss 时提供，用于降低幻觉
    { "id": "row-3", "name": "@scope/pkg" }
  ],
  "quarantined": [                     // 仅 quarantined 时提供
    { "id": "…", "name": "@scope/pkg", "reason": "<脱敏后原因>" }
  ]
}
```

**必须做的输入处理**：
- `redact()`：home 绝对路径 → `~`（含用户名时一并处理）。
- **截断 stderr**：建议**头部 2KB + 尾部 6KB**（启动失败的关键信息通常在尾部），
  中间用 `\n…[truncated N bytes]…\n` 标记。避免把整个 panic backtrace 灌进去。
- **已知行白名单**：`regex-miss` 场景必须给出 `knownRows`，并要求模型**只能**从里面选，
  这是 dsh-safe 已验证的抗幻觉手段（`ai.js:87-93`）。

### 9.2 输出（要求结构化 JSON）

建议要求模型只返回一个 JSON 对象（**不要** markdown 代码块），字段如下：

```jsonc
{
  "likelyCause": "一句话说明最可能的失败原因",
  "suspect": {                       // 无把握时整个字段可为 null
    "packageName": "@scope/name",    // 必须逐字取自 knownRows，否则拒绝
    "entryId": "row-3",
    "confidence": "high" | "medium" | "low"
  },
  "advice": [                        // 1-3 条，按推荐度排序
    { "action": "reinstall" | "upgrade-dsh" | "disable" | "fix-config" | "retry",
      "detail": "具体命令或配置修改",
      "risk": "low" | "medium" | "high" }
  ],
  "uncertain": false                 // true = 模型自认证据不足
}
```

**关键约定**：
- `suspect.packageName` / `entryId` **必须**在调用方用 `knownRows` 反查校验；不在白名单里就丢弃该字段
  （这是 dsh-safe `ai.js:10-11` 注释强调的"输出必须由调用方经 matchFailures 对照真实 patch 行后才生效"）。
- 模型**不得获得任何写权限**：只产出建议文本，隔离/恢复动作仍由确定性的 Rust 代码执行。
- 用 `temperature: 0` + `stream: false`（对齐 dsh-safe `ai.js:41`），保证可复现与实现简单。

### 9.3 token 与超时限制

| 项 | 建议值 | 依据 |
|---|---|---|
| 请求超时（总） | **20-30s** | dsh-safe `ai.js:30` 用 `timeoutMs = 30_000` |
| `max_tokens` | **800-1200** | 输出是结构化 JSON，实测需求很小；远低于 dsh 默认 256000（§4） |
| 输入上限 | **8KB 文本**（即上面的 2KB+6KB 截断） | 单次 explain 的输入本质很小 |
| `temperature` | `0` | 对齐 dsh-safe |
| `stream` | `false` | 对齐 dsh-safe；避免 SSE 解析 |
| 重试 | 最多 1 次，仅对 429/5xx/网络错误 | 避免放大失败 |
| 并发 | 同一时刻最多 1 个 explain 请求 | 避免失败风暴时打爆配额 |

### 9.4 请求形状（非流式，直接可用的最小集）

```
POST {base}/chat/completions
authorization: Bearer <key>          ← 只在此处出现，绝不进日志
content-type: application/json

{
  "model": "deepseek-v4-flash",      ← 产品层默认（§4）；可配置
  "messages": [ { "role": "user", "content": "<§9.1 的 prompt>" } ],
  "temperature": 0,
  "stream": false,
  "max_tokens": 1000
}
```

`base` 的解析顺序应与 dsh 一致：**显式配置 → `DEEPSEEK_BASE_URL` → `https://api.deepseek.com`**
（对齐 `PKG/dsh-llm-deepseek/lib/index.js:1993`）。

---

## 10. 旧结论核对表

对丢失报告残留评论中的 a–f 逐条核对。证据均见前文各节。

| # | 旧结论 | 判定 | 证据与说明 |
|---|---|---|---|
| **a** | `.credentials.yaml` 是 version 1 YAML；`refs` 区是环境变量名→密钥值；`records` 区是 `<scope>/<id>` → 凭证记录；AI 密钥在 refs 区 | **证实**（附 1 处补正） | version 1：`PKG/dsh-credentials-local/lib/index.js:124`、`:151`；refs 结构：`:191-201` + `PKG/dsh-credentials/lib/index.js:13`；records 结构：`:202-210` + `PKG/dsh-credentials/lib/index.js:15`、`:67-72`；本机真实文件 5 个 refs 键含 `DEEPSEEK_API_KEY`。**补正**：records 也能承载 API key（`kind: api-key`，`PKG/dsh-llm-pi-ai/lib/index.js:1967-1973`），pi-ai 路由的密钥可能在 `records/llm-pi-ai/<provider>`，故"AI 密钥一定在 refs"只对官方 DeepSeek 路由成立 |
| **b** | 优先级 `process.env` > `.credentials.yaml` > 项目 `.env` > `$DSH_HOME/.env`；环境变量永远优先 | **证实** | 文档：`PKG/dsh-credentials-local/lib/index.js:16-21`；实现：`:473-490` `resolve()` 三级短路；层构造：`PKG/dsh-app-boot/lib/index.js:1074-1099`（project = `<cwd>/.env`，user = `<$DSH_HOME>/.env`）；顺序常量：`PKG/dsh-launch-environment/lib/index.js:10-14`。Windows 折叠：`:21-24` |
| **c** | `serde_yaml` 直接解析即可，`dsh_home()` 已存在于 settings.rs；不需要调 dsh 命令 | **证实**（附 2 处修正） | `DESK/src/settings.rs:157` 确有 `dsh_home()`；`DESK/Cargo.toml:26` 确有 `serde_yaml = "0.9"`；官方确无读取路径（§3.1），故"不需要调 dsh 命令"成立。**修正 1**：`dsh_home()` 不做 `~` 展开，dsh 的 `resolveDshHome()` 会（`PKG/dsh-home-paths/lib/index.js:73-75`）。**修正 2**：Rust 必须**宽松**解析——dsh 对未知顶层键/未知 kind/未知字段直接抛错（`:152`、`:261-266`），照抄会把 dsh 的格式演进变成桌面壳的故障 |
| **d** | OpenAI 兼容，默认 `https://api.deepseek.com`，`POST /chat/completions` + Bearer；可用 `DEEPSEEK_BASE_URL` 覆盖；默认模型 `deepseek-v4-flash` / `deepseek-v4-pro` | **证实**（"deepseek-v4-pro 是默认"这一半需更正） | 端点默认 `:1911`；覆盖变量 `:1913`；解析顺序 `:1993`；路径 `:1770`；Bearer `:1661`；目录含两者 `:1852`、`:1858`。产品层事实默认是 **`deepseek-v4-flash`**（`PKG/dsh-acp-app/cordis.patch.yml:21`、`PKG/dsh-web-search-deepseek/lib/index.js:23`、`PKG/dsh-client-connection/lib/client.js:2421` 等）；`deepseek-v4-pro` 在目录里但**没有任何"默认"标记**。另注：dsh 官方发的是**流式**（`accept: text/event-stream`，`:1663`），与 dsh-safe 的非流式不同 |
| **e** | dsh 无可复用的独立 AI 接口（深度绑定 agent loop，无 CLI/HTTP 入口），桌面 app 必须自己实现 | **推翻** | 有官方、一等公民的入口：`headless` 与 `sdk` 均在出厂 `PROFILE_TEMPLATES` 里（`PKG/dsh-app-boot/lib/index.js:337-344`），首用自动初始化（`:886-895`）；`dsh --profile headless "<task>"` 在官方 help 示例中（`CLI/bin.js:37`），行为见 `PKG/dsh-headless/lib/index.js:9-17`；`dsh --profile sdk` 是 stdio NDJSON JSON-RPC，方法 `initialize`/`session/prompt`/`shutdown`（`PKG/dsh-sdk-jsonrpc-server/lib/index.js:196-201`）。**成立的部分**：确实**没有**"裸 chat completion"的 CLI/HTTP 入口，且这些入口都是完整 agent loop。故"必须自己发 HTTP"作为**推荐路径**成立，作为**唯一可能**被推翻 |
| **f** | reqwest + serde_json 约 50 行，只需新增 reqwest 一个依赖 | **部分推翻** | **成立**：reqwest 确是唯一需要新增的**直依赖**（`serde_json` 已在 `DESK/Cargo.toml:25`）；最小 happy path 约 50 行合理。**推翻**："只需新增一个依赖"在**成本**意义上不成立——默认 features 会引入 **+49 个 lock 包**，含需 **CMake** 的 `aws-lc-sys` 与 HTTP/3 的 `quinn`（§6.2 实测），必须显式 `default-features = false`。另需注意 `Cargo.lock:3088` 里的 reqwest 是 tauri 对 android/iOS 的 **target-gated** 依赖，macOS/Windows 上 `cargo tree` 实测 0 命中，**不能据此认为零代价** |

### 未能验证 / 存疑事项（诚实标注）

- **本机凭据是否真的能被模型消费**：本次调研**没有**发出任何带 `Authorization` 头的真实请求
  （按要求不产生计费调用），因此 `.credentials.yaml` 里 `DEEPSEEK_API_KEY` 的**有效性未经实际验证**。
  只验证了端点可达（401）与解析逻辑正确。
- **`headless` / `sdk` profile 的实际运行行为**：仅做**源码级**取证，未实际执行
  （执行会在 `$DSH_HOME/profiles/` 下落盘，且 headless 会真实调用模型产生费用）。
  「stdout 出最终文本」等行为来自 `PKG/dsh-headless/lib/index.js:9-17` 的模块文档，非实测。
- **Windows 实机行为**：本机为 macOS，Windows 侧结论（Schannel、大小写折叠、无权限检查）
  均来自**源码 + `cargo tree --target x86_64-pc-windows-msvc` 交叉编译解析**，非 Windows 实机验证。
- **dsh 0.1.5-rc.1 之后版本**：本报告基于当前安装版本；`version: 1` 文档格式与
  `release` 前的扁平布局迁移逻辑（`:171-190`）明确标注了"first tagged release 时移除"，
  升级 dsh 后需重新核对。
