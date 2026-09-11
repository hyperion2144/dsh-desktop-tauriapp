# cordis.patch.yml 格式、加载语义与 dsh 启动失败 stderr 事实调查（重做版）

> 来源票：GitHub issue #54《研究：cordis.patch.yml 格式 / patch 语义 / dsh 启动失败 stderr 形态》
> 调研日期：2026-09-11；本机实测平台：macOS 26.6.2 (Build 26.6.2)，arm64
> 一手来源：本机 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`（`dsh --version` = `0.1.5-rc.1`，Node v26.5.0）
> 上游移植对象：GitHub `hyzyn/dsh-safe`，main HEAD `d2c23ff197f6`（2026-09-10T04:54:39Z），`package.json` 版本 **0.16.0-rc.2**
> 重做说明：原票 #54 指向的 `docs/wayfinder/research-patchfmt.md` 已丢失，本报告全部结论重新取一手证据，**每一条都附 `文件:行` 或真实命令输出**。

## TL;DR

**`cordis.patch.yml` 是「对已合成条目树的增量补丁列表」而非配置本身**——顶层必须是 YAML 数组，元素是 `PatchOptions`；`id` 匹配不到目标行时 dsh **只 warn 并跳过、进程照常启动**（源码 `dsh-app-boot/lib/index.js:93-97`），所以在 `disabled: true` 条目旁追加托管区块是安全的；但这条 warn 在真实启动时**根本不会输出到 stderr**（被 cordis logger 的默认级别 1 过滤掉，实测 `warn` 连内存缓冲都进不去），只能靠 `dsh --dump-config` 看到；而 patch 文件本身解析失败（YAML 语法错误 / 顶层非数组 / 注释-only）是**未捕获异常直接 exit 1**，且 dsh-safe 的 5 类正则**一条都匹配不到**这类输出。

---

## 0. 调研方法与实验环境

### 0.1 一手来源清单

| 来源 | 路径 / 命令 | 用途 |
|---|---|---|
| dsh 包本体 | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/` | CLI 分发、profile boot |
| patch 实现核心 | `…/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（1575 行） | schema、`parsePatchList`、`applyEntryPatches`、`boot`、两个审计 |
| loader 实现 | `…/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js` | `updateError`、`duplicate loader entry id` |
| logger 实现 | `…/dsh/node_modules/@deepseek-ai/cordis/lib/index.js` | 级别过滤、`%C` formatter |
| 原子写 | `…/dsh/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js` | `.tmp`+rename、`withFileLock` |
| 上游 dsh-safe | `gh api repos/hyzyn/dsh-safe/contents/lib/<f> --jq .content \| base64 -d` | failures / patchfile / knownrows / dedupe |
| 真实 patch 实例 | `~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/profiles/smoke/cordis.patch.yml` | 真实形状 |

### 0.2 实验方式（真实启动实验，全程未触碰真实 profile）

**采用 scratch profile 方案**，未使用临时 `DSH_HOME`（避免联网装包）：

```bash
cp -R ~/.dsh/profiles/smoke ~/.dsh/profiles/wy-research     # bundle 实体走共享池 ~/.dsh/profiles/node_modules
dsh --profile wy-research --patch <自造 overlay> --no-open --port 3199
```

- 独立端口 **3199**，`--no-open`，每次实验由脚本硬超时（`kill -TERM` → 2s → `kill -KILL`，再按端口兜底清杀）。
- 真实 profile `web` 全程只读；`smoke` 只读；`~/.dsh/settings.yaml` 未改。

**清理确认（已完成）**：

```
$ rm -rf ~/.dsh/profiles/wy-research
$ ls ~/.dsh/profiles/
node_modules  smoke  web
$ lsof -nP -iTCP:3199 -sTCP:LISTEN        # 无输出 = 已释放
$ lsof -nP -iTCP:3080 -sTCP:LISTEN
COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    22680 mutou   20u  IPv4 0xb64d33206a183477      0t0  TCP 127.0.0.1:3080 (LISTEN)   # 原实例未受影响
```

真实 profile 校验和（实验前 = 实验后）：

```
49da21f8e04711961c9586f747f2010812fe122c  ~/.dsh/profiles/web/cordis.patch.yml   (mtime Sep  8 19:06)
194cd85640a83af29c5bbbaf819e4e7c54d199c8  ~/.dsh/profiles/web/package.json
a6def63f0ae509453a22639fef07f522f80ced32  ~/.dsh/profiles/smoke/cordis.patch.yml
b76c9eb21138444b4216b13d27beb1170b59b1e7  ~/.dsh/profiles/smoke/package.json
```

### 0.3 ⚠️ 一条重要的实验陷阱（会导致假结论）

**dsh 在 loader tree settle 之前就把 web 端口打开了。** 实测：

```
$ bash timing.sh T-boom --profile wy-research --patch <会抛错的 overlay> --no-open --port 3199
### label=T-boom port_open_at=2900ms process_exit_at=14000ms
$ bash timing.sh T-ok --profile wy-research --no-open --port 3199
### label=T-ok   port_open_at=2900ms process_exit_at=still-alive
```

即：**端口在 ~2.9s 打开，启动失败在 ~14.0s 才报出**——中间有约 **11 秒**「端口开着但注定失败」的窗口。
本次调研最早一批实验用「探测到端口就 kill」的脚本，导致 7 个本该失败的用例全部被误判为「启动成功」；
改为「探测到端口后再 hold 20-25s」后才复现出真实失败。**所有涉及失败的结论都以长 hold 实验为准。**

（~14s 这个常量在 E1/E2/E3/E4/E18/E19/E20 七次实验中稳定复现；其精确成因未进一步定位，属**未实验验证、仅现象记录**。）

---

## 1. cordis.patch.yml 的精确 YAML 结构（对应问题 1）

### 1.1 顶层结构

**顶层必须是 YAML 数组**，每个元素是一个 `PatchOptions`。强制点：

- `dsh-app-boot/lib/index.js:1199`
  ```js
  if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);
  ```
- `dsh-app-boot/lib/index.js:1200-1202` 每个元素必须是 mapping：
  ```js
  parsed.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`);
  });
  ```

### 1.2 PatchOptions 字段

字段集合由 `applyEntryPatches` 的解构决定——**`id` / `insert` / `name` 是控制字段，其余全部是「覆盖写入目标行的键」**：

`dsh-app-boot/lib/index.js:70-71`
```js
for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
```

`dsh-app-boot/lib/index.js:102-105`（覆盖语义：整体赋值，**不是深合并**）
```js
for (const [key, value] of Object.entries(overrides)) {
    if (key === "id") continue;
    target[key] = value;
}
```

| 字段 | 角色 | 说明 |
|---|---|---|
| `id` | 控制 | 目标行 id；`insert` 无 `id` 时表示追加到顶层 |
| `insert` | 控制 | 要插入的行数组 |
| `name` | 控制（断言） | **不是重命名**，是与目标行 name 比对，不等则整条跳过 |
| `config` | 覆盖 | **整体替换**（`target.config = value`），不是 merge |
| `disabled` | 覆盖 | 置 `true` 即禁用该行；也可写 `!!js` 表达式 |
| `inject` | 覆盖 | 同 `config`，整体替换 |

> 官方对 `PatchOptions` 的措辞见 `dsh-app-boot/lib/index.js:1181-1183`：`a top-level YAML array of @deepseek-ai/cordis-plugin-include PatchOptions (id-targeted config overrides and insert lists, !!js expressions allowed)`。

### 1.3 三种模式的行为（源码逐行）

**(A) `insert` 模式** —— `dsh-app-boot/lib/index.js:72-88`

```js
if (insert) {
    if (id) {
        const target = entryMap.get(id);
        if (!target) {
            warn("patch insert: entry %C not found", id);       // 行 76：warn + 跳过
            continue;
        }
        if (!target.group) {
            warn("patch insert: entry %C is not a group", id);  // 行 80：warn + 跳过
            continue;
        }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);                          // 插到 group 的 config 里
    } else data.push(...insert);                                 // 无 id：追加到顶层数组
    buildMap(insert);                                            // 新插入的行立即可被后续 patch 命中
    continue;
}
```

**(B) 覆盖模式** —— `dsh-app-boot/lib/index.js:89-105`

```js
if (!id) {
    warn("patch: id is required for non-insert patches");        // 行 90
    continue;
}
const target = entryMap.get(id);
if (!target) {
    warn("patch: entry %C not found", id);                       // 行 95：warn + 跳过（★本票关键）
    continue;
}
if (name && name !== target.name) {
    warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);  // 行 99
    continue;
}
```

**(C) 未匹配** —— 即上面的 `行 76 / 80 / 95`，全部是 **`warn` + `continue`，不 throw、不影响启动**。
源码注释对此有明确设计说明（`dsh-app-boot/lib/index.js:1183-1185`）：

> `a single patch whose target row is absent stays a per-entry Loader warning, so one overlay shared across surfaces does not have to match every tree.`

### 1.4 与 profile `package.json` 里 `dsh.profile.bundles` 的关系

**bundles 是「层来源」，patch 文件是「层内容」。** 合成顺序（后者覆盖前者）：

`dsh/lib/profile-boot-Dk-7KqJc.js:213-220`
```js
function allPatches(composed) {
	return [
		...composed.bundlePatches,   // 1. 各 bundle 的 patch，按 bundles 数组顺序
		...composed.profile.patches, // 2. profile 自己的 cordis.patch.yml
		...composed.homePatches,     // 3. $DSH_HOME/cordis.patch.yml（机器级）
		...composed.overlays         // 4. --patch 覆盖层 + telemetry 开关
	];
}
```

每个 bundle 的 patch 来自其 `package.json` 的 `dsh.bundle.patch`（`dsh-app-boot/lib/index.js:849-859`）：

```js
const layers = bundles.map((packageName) => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
    const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
    if (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
    ...
});
```

**关键点 1：四个层是拍平成一个 patch 列表、对空数组一次性应用的**，不是逐层 apply：

`dsh-app-boot/lib/index.js:904-909`
```js
function composeEntries(layers, warn = () => {}) {
	return applyEntryPatches([], structuredClone(layers.flat()), (message, ...args) => {...});
}
```

**关键点 2：profile 的根配置是一个恒为空的占位文件**（`[]`），每次 boot 都被重写：

`dsh/lib/profile-boot-Dk-7KqJc.js:124-128`
```js
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;
```

`dsh/lib/profile-boot-Dk-7KqJc.js:206-211`
```js
function prepareProfile(name, userLayer = true, fromDefaultProfile) {
	...
	const profile = loadProfile(NAME, name, INSTALL_ANCHOR, void 0, { userLayer });
	writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG);
	return profile;
}
```

> ⚠️ **`dsh --dump-config` 也会走 `prepareProfile`**（`dsh/lib/dump-config-lFgMwK8i.js:25`），因此它同样会**重写该 profile 的 `cordis.yml`**。本次调研为遵守「不修改 `~/.dsh/profiles/web/`」的约束，**没有对 web profile 跑过 dump-config**；对 scratch profile 跑过（已随 profile 删除）。

### 1.5 本机真实实例（一手）

`~/.dsh/profiles/web/cordis.patch.yml`（163 字节，mtime Sep 8 19:06）：

```yaml
- insert:
    - id: dsh-ui-progress
      name: "@dsh-external/dsh-ui-progress"
- id: dsh-at-file
  disabled: true
- id: archify-skill-filesystem
  disabled: true
```

三种形态都出现了：**无 id 的 `insert`（追加到顶层）** + **两条 `id` + `disabled: true` 覆盖**。

`~/.dsh/profiles/smoke/cordis.patch.yml`（空模板，`[]`）——**这正是 `initProfile` 写入的出厂模板**：

`dsh-app-boot/lib/index.js:360-364`
```js
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
```

---

## 2. dsh 如何解析它（对应问题 2）

### 2.1 具体文件与调用链

解析函数是 `parsePatchList`，位于 **`dsh-app-boot/lib/index.js:1192-1204`**。

调用链（profile 层）：
`loadProfileDirectory`（`:861-862`）→ `loadOverlayPatches`（`:1160-1168`）→ `parsePatchList`。

```js
// dsh-app-boot/lib/index.js:861-862
const patchPath = join(dir, PROFILE_PATCH_FILENAME);          // "cordis.patch.yml"（常量在 :314）
const patches = options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [];
```

注意 `existsSync` 守卫：**profile 的 `cordis.patch.yml` 缺失 = 空层，不报错**；但**显式指定的 `--patch` 文件缺失会 throw**（`loadOverlayPatches` 不做 ENOENT 兜底，`:1160-1166`），对比 `loadOptionalPatches` 有 ENOENT → `undefined` 分支（`:1141-1150`）。

### 2.2 js-yaml + 什么 schema

```js
// dsh-app-boot/lib/index.js:1195
parsed = yaml.load(content, { schema: userPatchesSchema });
```

```js
// dsh-app-boot/lib/index.js:1101
const userPatchesSchema = entryListSchema;
```

```js
// dsh-app-boot/lib/index.js:30
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
```

依赖声明：`@deepseek-ai/dsh/package.json` → `"js-yaml": "^4.2.0"`。

**结论：`JSON_SCHEMA` + 自定义 `!!js` tag**（不是 `DEFAULT_SCHEMA`、不是 `CORE_SCHEMA`）。用 `JSON_SCHEMA` 的直接后果是 **YAML 1.1 的隐式类型不生效**（例如 `yes`/`no`/`on`/`off` 不会被当布尔值），且**只认显式 `!!js`**。

### 2.3 `!!js` tag 如何处理

```js
// dsh-app-boot/lib/index.js:17-23
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
	kind: "scalar",
	resolve: (data) => typeof data === "string",
	construct: (data) => ({ __jsExpr: data }),
	predicate: isJsExpr,
	represent: (data) => data["__jsExpr"]
});
```

即 `!!js <expr>` 解析为一个**不求值的表达式节点** `{__jsExpr: "<expr 源文本>"}`，由 Loader 在条目激活时才求值。
`kind: "scalar"` + `resolve: typeof data === "string"` 意味着 **`!!js` 只能用于标量**。

实测（`!!js` 在 patch 文件里可用，dump 时原样打印不求值）：

```
$ dsh --profile wy-research --patch /tmp/wy-exp/jsmodes.yml --dump-config
（stderr 为空，exit=0）
$ grep -n -A2 "id: skill-filesystem" jsdump.yml
175:- id: skill-filesystem
176-  name: '@deepseek-ai/dsh-skill-filesystem'
177-  disabled: !!js process.platform === 'win32'
```

同时可见 dsh 官方 bundle 自己就在用它（`dumpB1.yml:114`，来自 `dsh-base`）：

```yaml
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
```

### 2.4 对注释的宽容度

**完全宽容**——js-yaml 常规行为，注释、空行、文档内注释均不影响。`smoke` 模板本身就是 3 行注释 + `[]`；
`web/cordis.patch.yml` 无注释但 `dsh-safe` 的托管区块依赖注释标记（见 §8），实测可用。

### 2.5 解析失败的后果：**未捕获异常 → exit 1**（不是 warn）

三层失败点全部 `throw`，且 **`composeProfile` 调用处没有 try/catch**，异常一路冒泡到顶层：

```js
// dsh-app-boot/lib/index.js:1196-1199
} catch (error) {
    throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);   // YAML 语法错误
}
if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);
```

**实验 A：`--patch` 顶层非数组**

```
$ cat bad-nonarray.yml
# comment line
this is: not a top-level array
foo: bar

$ dsh --profile wy-research --patch /tmp/wy-exp/bad-nonarray.yml --no-open --port 3199
### port3199_listening=no after 1s   alive=no   exit_code=1
### --- stderr ---
file:///opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1199
	if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);
	                                  ^

Error: dsh: overlay /tmp/wy-exp/bad-nonarray.yml must be a top-level YAML array of loader patch entries
    at parsePatchList (…/dsh-app-boot/lib/index.js:1199:36)
    at loadOverlayPatches (…/dsh-app-boot/lib/index.js:1167:9)
    at file:///…/dsh/lib/profile-boot-Dk-7KqJc.js:239:48
    at Array.flatMap (<anonymous>)
    at composeProfile (file:///…/dsh/lib/profile-boot-Dk-7KqJc.js:239:30)
    …
Node.js v26.5.0
```

**实验 B：YAML 语法错误**

```
$ cat bad-yaml.yml
- id: skill-filesystem
  disabled: true
  bad: [unclosed

$ dsh --profile wy-research --patch /tmp/wy-exp/bad-yaml.yml --no-open --port 3199
### port3199_listening=no after 1s   alive=no   exit_code=1
Error: dsh: failed to parse overlay /tmp/wy-exp/bad-yaml.yml: YAMLException: unexpected end of the stream within a flow collection (4:1)

 1 | - id: skill-filesystem
 2 |   disabled: true
 3 |   bad: [unclosed
 4 | 
-----^
    at parsePatchList (…/dsh-app-boot/lib/index.js:1197:9)
```

**注意**：报错前缀是 `dsh: overlay <绝对路径>`（走 `--patch`）或 `dsh: patches <路径>`（home 层，label 参数为 `"patches"`），
但 **profile 自己的 `cordis.patch.yml` 也走 `loadOverlayPatches`，label 同为 `"overlay"`**（`:1167`）——因为 `loadProfileDirectory` 调的就是 `loadOverlayPatches`。

**副作用**：上述失败全部发生在 `composeProfile` 阶段（**早于 boot、早于任何 loader 参与**），所以任何依赖「loader entry 失败文案」的解析器都**不可能**识别它们。

---

## 3. 在 `disabled: true` 条目旁追加托管区块是否安全（对应问题 3，硬证据）

### 3.1 源码证据

`dsh-app-boot/lib/index.js:93-97`（覆盖模式，目标 id 不存在）：

```js
const target = entryMap.get(id);
if (!target) {
    warn("patch: entry %C not found", id);
    continue;
}
```

`warn` 由 `Include.applyPatches` 注入——**它不是异常，是日志**：

`dsh-app-boot/lib/index.js:200-204`
```js
applyPatches(data, patches) {
    return applyEntryPatches(data, patches, (message, ...args) => {
        this.ctx.root.logger?.("loader").warn(message, ...args);
    });
}
```

### 3.2 实验证据（`--dump-config` 路径，能看见 warn）

构造：一个 `disabled: true` 的真实条目 + 一个 dsh-safe 形状的托管区块（含**不存在的 id**）：

```yaml
- id: skill-filesystem
  disabled: true

# --- dsh-safe managed (auto-generated; do not edit) ---
# 2026-09-11T08:20:00Z · no-such-plugin-xyz · simulate: startup failure
- id: no-such-plugin-xyz
  name: 'no-such-plugin-xyz'
  disabled: true
# --- end dsh-safe managed ---
```

```
$ dsh --profile wy-research --dump-config 2>dumpB1.err >dumpB1.yml; echo "exit=$?"
exit=0
$ cat dumpB1.err
dsh: [/Users/mutou/.dsh/profiles/wy-research/cordis.patch.yml] patch: entry "no-such-plugin-xyz" not found
```

**结论：只 warn、exit 0、其余条目照常合成。**

### 3.3 实验证据（真实启动）

```
$ dsh --profile wy-research --no-open --port 3199
### port3199_listening=yes after 3s
### SURVIVED 20s        # 长 hold 复核，非「探测到端口就杀」
### exit_code=0
### --- stderr ---
dsh-hashline-edittool: settings service unreachable from this context — hashline section NOT registered; …
dsh-hashline-edittool: settings service became visible after 1039ms (3 attempt(s)) — …
```

**服务正常起来，patch 里 id 不存在不影响启动。**

### 3.4 ⚠️ 关键陷阱：这条 warn 在真实启动时**根本不会输出到 stderr**

`Include.applyPatches` 走的是 `ctx.root.logger?.("loader").warn(...)`。cordis logger 有级别过滤：

`cordis/lib/index.js:459-460`
```js
for (const exporter of this.service.exporters.values()) {
    if ((exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? 1) < level) continue;
```

`warn` 的 level = **2**（`cordis/lib/index.js:469-471`：`error=0, info=1, warn=2, debug=3`），
未配置时阈值取 **1**，故 `1 < 2` → **`continue`，连 exporter 都不进**。

**实测证明（在真实启动里注入探针，读 `ctx.logger.buffer`）**：

```
$ dsh --profile wy-research --patch <探针 overlay> --no-open --port 3199
（stderr 中没有任何 PROBE_ 行）
=== buffer content（哪些级别活下来了？）===
error: PROBE_ERROR_L0
info: PROBE_INFO_L1
```

`warn`（L2）与 `debug`（L3）**既不在 stderr、也不在内存 ring buffer**。
并且整个 dsh 后端**没有任何插件注册 stderr exporter**：

```
$ grep -rn "exporter({" --include=*.js node_modules/@deepseek-ai/ | wc -l
2      # 一个是 cordis 自己的内存 buffer exporter，一个是浏览器端前端 dist
```

**因此对实现票 #57 的直接含义**：**不要指望从 dsh web 的 stderr 里读到 `patch: entry "x" not found`**。
这条信息只在 `dsh --dump-config` 的 stderr 上出现（该路径用的是直写 sink）：

`dsh-app-boot/lib/index.js:1236`
```js
function renderConfigDump(binName, absoluteConfigPath, layers, warn = (line) => void process.stderr.write(`${line}\n`)) {
```

### 3.5 六种 patch 失配文案逐字表（真实捕获）

命令：

```
$ cat modes.yml
# mode probes
- id: skill-filesystem
  disabled: true
- id: no-such-row-abc
  disabled: true
- insert:
    - id: child-1
      name: '@deepseek-ai/dsh-llm'
  id: no-such-group-xyz
- insert:
    - id: child-2
      name: '@deepseek-ai/dsh-llm'
  id: llm
- insert:
    - id: child-3
      name: '@deepseek-ai/dsh-llm'
  id: skill-filesystem
- disabled: true
- id: llm
  name: '@wrong/package-name'
  disabled: true

$ dsh --profile wy-research --patch /tmp/wy-exp/modes.yml --dump-config 2>&1 >/dev/null; echo "exit=$?"
dsh: [/tmp/wy-exp/modes.yml] patch: entry "no-such-row-abc" not found
dsh: [/tmp/wy-exp/modes.yml] patch insert: entry "no-such-group-xyz" not found
dsh: [/tmp/wy-exp/modes.yml] patch insert: entry "llm" is not a group
dsh: [/tmp/wy-exp/modes.yml] patch insert: entry "skill-filesystem" is not a group
dsh: [/tmp/wy-exp/modes.yml] patch: id is required for non-insert patches
dsh: [/tmp/wy-exp/modes.yml] patch: name mismatch for "llm" (expected "@deepseek-ai/dsh-llm", got "@wrong/package-name"), skipping
exit=0
```

| # | 源码 行 | 文案（源码格式串） | 触发条件 |
|---|---|---|---|
| 1 | `:95` | `patch: entry %C not found` | 覆盖模式，id 不存在 |
| 2 | `:76` | `patch insert: entry %C not found` | insert + id，目标不存在 |
| 3 | `:80` | `patch insert: entry %C is not a group` | insert + id，目标不是 group |
| 4 | `:90` | `patch: id is required for non-insert patches` | 非 insert 且无 id |
| 5 | `:99` | `patch: name mismatch for %C (expected %C, got %C), skipping` | `name` 断言不匹配 |
| 6 | — | （无 warn） | id 存在且无 name 断言 → 静默应用 |

`%C` 是 cordis 的 formatter（`cordis/lib/index.js:400-411` 的 `defaultFormatters.C`），输出带 ANSI 颜色码的加引号值。

---

## 4. 有没有 patch include 子文件机制（对应问题 4）

**结论：没有「patch 文件 include 另一个 patch 文件」的机制。** 取而代之的是四个**固定层**（§1.4 的顺序）：

| 层 | 来源 | 影响面 |
|---|---|---|
| 1. bundle 层 | 各 bundle 的 `dsh.bundle.patch`（`dsh-app-boot/lib/index.js:849-859`） | 该 bundle 被列进 `bundles` 的所有 profile |
| 2. profile 层 | `<profile>/cordis.patch.yml`（`:861-862`） | **只影响该 profile** ✅ |
| 3. home 层 | `$DSH_HOME/cordis.patch.yml`（`dsh/lib/profile-boot-Dk-7KqJc.js:111-118, 238`） | **影响该机器上所有 profile** ⚠️ |
| 4. 覆盖层 | `--patch <path>`，**可重复**（`dsh/lib/bin.js:101`、`:53-54`），外加 telemetry 开关 | 只影响该次启动 |

- **改 profile 的 `cordis.patch.yml` 只影响该 profile** —— 证实。home 层在本机**不存在**：
  ```
  $ ls -la ~/.dsh/cordis.patch.yml
  ls: /Users/mutou/.dsh/cordis.patch.yml: No such file or directory
  ```
- `--patch` 是**唯一**的「临时叠加」手段，且桌面壳正是走这条路（见根 `AGENTS.md`：桌面壳把插件经 `--patch` 注入 dsh web profile，不写 profile bundles）。
- 需要「子文件」时只能靠 `--patch a.yml --patch b.yml` 多次传入（`:24-25` 注释明确 `--patch` 是 repeatable 但**非变参**，避免吞掉 inner args）。

---

## 5. dsh 启动审计在什么条件下拒绝整棵树（对应问题 5）

`boot()` 的主干（`dsh-app-boot/lib/index.js:1525-1547`）：

```js
await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl);
await ctx.get("loader")?.await();                    // 阶段 1：等整棵树 settle
if (ctx.get("loader") === void 0) return ctx;        // 表面自行销毁 → 正常返回
await assertEntriesActivated(ctx, binName);          // 阶段 2：审计
return ctx;
} catch (cause) {
    await ctx.fiber.dispose();                       // 失败 → 销毁半成品上下文
    ...
    throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause });
}
```
`stage` 只有两个取值：`"host preparation failed"`（`:1527`）与 `"plugin tree failed to load"`（`:1533`）。

### 5.1 `assertEntriesLoaded`（判据 A）

`dsh-app-boot/lib/index.js:1434-1440`
```js
function assertEntriesLoaded(ctx, binName) {
	const failed = [...ctx.loader.entries()].filter((entry) => entry.fiber === void 0 && !entry.disabled);
	if (failed.length > 0) {
		const names = failed.map((entry) => entry.options.name).join(", ");
		throw new Error(`${binName}: plugin(s) failed to load: ${names}; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)`);
	}
}
```
判据：**`fiber === undefined` 且 `!disabled`**。注释（`:1428-1430`）原文：`Disabled entries are the only valid fiber-less state.`

### 5.2 `assertEntriesActivated`（判据 B）

`dsh-app-boot/lib/index.js:1465-1494`
```js
async function assertEntriesActivated(ctx, binName) {
	assertEntriesLoaded(ctx, binName);
	const failures = [];
	const rejectionReasons = [];
	for (const entry of ctx.loader.entries()) {
		const fiber = entry.fiber;
		if (fiber === void 0 || entry.disabled) continue;      // ★ disabled 直接跳过
		const state = fiber.state;
		if (state === FIBER_ACTIVE) continue;                  // 2 = 活跃，唯一通过态
		if (state === FIBER_FAILED) {                          // 3 = 失败
			try { await fiber.await(); }
			catch (error) { rejectionReasons.push(error); failures.push(`${entry.options.name}: ${formatActivationError(error)}`); }
			continue;
		}
		if (state === FIBER_PENDING) {                         // 0 = 挂起
			const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === void 0);
			const subject = missing.length === 1 ? "service" : "services";
			failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(", ") || "unknown"})`);
		} else failures.push(`${entry.options.name}: fiber state ${String(state)}`);
	}
	if (failures.length > 0) {
		if (rejectionReasons.length > 0) await observeLoaderRejectionCheckpoint(rejectionReasons);
		const noun = failures.length === 1 ? "entry" : "entries";
		throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join("\n")}`);
	}
}
```

**判据汇总**：settle 后，任何 **非 disabled** 的条目只要不是 `state === 2 (ACTIVE)` 就计入 failures；
`FAILED` 会 await 拿到原始栈，`PENDING` 会列出缺失的 service；只要有 1 条 → 整棵树失败。

### 5.3 `disabled: true` 是否跳过审计 —— **是，两处都跳**

- `assertEntriesLoaded:1435`：`entry.fiber === void 0 && !entry.disabled`
- `assertEntriesActivated:1471`：`if (fiber === void 0 || entry.disabled) continue;`

即 **`disabled: true` 的行既不需要有 fiber，也不需要 ACTIVE，完全不参与审计**。这正是「启动保险丝」能生效的机制基础。

### 5.4 存在「部分启动」这种状态吗？

**作为最终状态：不存在。** 任何失败都会 `await ctx.fiber.dispose()` 销毁半成品上下文再抛出（`:1540`），进程 exit 1。

**但作为进程的中间状态：存在，而且窗口很大（~11 秒）。** 见 §0.3 实测：
端口在 ~2.9s 就 LISTEN，而失败在 ~14.0s 才让进程退出。**在这个窗口里，从外部看（端口存活、TCP 可连）它「像是启动成功了」。**

另外有一个**正常返回**的例外分支：`if (ctx.get("loader") === void 0) return ctx;`（`:1536`）——当某个 surface 在启动过程中主动销毁了整棵树时，`boot()` 正常返回而不是抛错。

---

## 6. dsh 启动失败时 stderr 的完整格式（对应问题 6）

### 6.1 dsh-safe 的 5 类检测正则（**逐字原文抄出**）

文件：`hyzyn/dsh-safe` main @ `d2c23ff197f6`，`lib/failures.js`（共 111 行）。

顶部注释（`failures.js:1-26`）自述 5 类：

```
 * 1. assertEntriesLoaded:
 *    `dsh: plugin(s) failed to load: @a/x, @b/y; Cordis startup failed ...`
 * 2. assertEntriesActivated:
 *    `dsh: 2 entries did not activate` 之后每行一条 `@a/x: <错误>` / `@a/x: pending (waiting for service(s): xxx)`
 * 3. loader entry 更新失败：
 *    `failed to (apply|import|dispose|rollback) loader entry <id> (<name>): <原因>`
 * 4. 外层栈（getOuterStack）：
 *    `    at file:///…/profiles/web/#<entryId>`
 * 5. 重复挂载：
 *    `duplicate loader entry id: <id>`
```

字符类与正则字面（`failures.js:29-31, 39-40, 57-60`）：

```js
const NAME_CLASS = '[\\w@][\\w@./\\-]*'
const ID_CLASS = '[\\w:\\-]+'

/**
 * 环境类失败的 errno 特征。用 errno 而非错误文案匹配…
 */
const ENV_ERRNO =
  /\b(?:EADDRINUSE|EADDRNOTAVAIL|EACCES|EPERM|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EMFILE|ENFILE)\b/

const isPluginName = (s) => NAME_REGEX.test(s)
const NAME_REGEX = new RegExp(`^${NAME_CLASS}$`)

export function parseFailureReport(text) {
  const names = new Map()
  const entryIds = new Map()
  const environmental = new Map()
  const lines = text.split(/\r?\n/)
  const reEntry = new RegExp(`failed to (?:apply|import|dispose|rollback) loader entry (${ID_CLASS}) \\(([^)]+)\\)`)
  const reStackId = new RegExp(`^\\s*at \\S+#(${ID_CLASS})`)
  const reLoadList = /plugin\(s\) failed to load:\s*([^;\n]+);/
  const reDupId = new RegExp(`duplicate loader entry id: (${ID_CLASS})`)
```

第 2 类的「块扫描」（`failures.js:93-101`）：

```js
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('did not activate')) continue
    for (let j = i + 1; j < lines.length; j++) {
      const m = new RegExp(`^\\s*(${NAME_CLASS}):\\s`).exec(lines[j])
      if (!m || !isPluginName(m[1])) continue
      if (ENV_ERRNO.test(lines[j])) environmental.set(m[1], lines[j])
      else names.set(m[1], lines[j])
    }
  }
```

外加第 5 类的短路（`failures.js:63-69`）：命中 `duplicate loader entry id` 时 `continue`，**抑制同线的第 3 类记录**，避免把 `include` 这类机制行当元凶。

### 6.2 逐条：dsh 侧文案来源 + 真实捕获样例

| 类 | dsh 侧源码出处（本机 `0.1.5-rc.1`） | 本机真实样例（是否复现） |
|---|---|---|
| 1 | `dsh-app-boot/lib/index.js:1438` | ❌ **未复现**（见下） |
| 2 | `dsh-app-boot/lib/index.js:1486`（pending）、`:1479`（failed） | ✅ E16 |
| 3 | `cordis-plugin-loader/lib/index.js:309`（`updateError`） | ✅ E1/E2/E3/E4/E18/E19/E20 |
| 4 | cordis fiber 外层栈（`file://…/#<id>`） | ✅ E3/E17 |
| 5 | `cordis-plugin-loader/lib/index.js:91` | ✅ E15 |

**第 3 类 dsh 侧出处（`cordis-plugin-loader/lib/index.js:307-309`）**：

```js
function updateError(stage, options, cause) {
	return new Error(`failed to ${stage} loader entry ${options.id} (${options.name}): ${detail}`, { cause });
}
```
四种 stage 的抛出点：`:440 dispose` / `:455 rollback` / `:458 apply` / `:468 import`。

**真实样例——第 3 类（import 失败）**：

```
$ dsh --profile wy-research --patch /tmp/wy-exp/E2-insert-relpath.yml --no-open --port 3199
# E2-insert-relpath.yml: - insert: [ {id: wy-ghost-plugin2, name: './definitely-not-here.js'} ]
### CRASHED after 14s (port3199_listening=no)
### exit_code=1
### --- stderr ---
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry wy-ghost-plugin2 (file:///tmp/wy-exp/definitely-not-here.js): Cannot find module '/tmp/wy-exp/definitely-not-here.js' imported from /Users/mutou/.dsh/profiles/wy-research/
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/wy-exp/definitely-not-here.js' imported from /Users/mutou/.dsh/profiles/wy-research/
    at finalizeResolution (node:internal/modules/esm/resolve:272:11)
    …
  [cause]: Error: failed to apply loader entry include (cordis:include): failed to import loader entry wy-ghost-plugin2 (…): Cannot find module …
    [cause]: Error: failed to import loader entry wy-ghost-plugin2 (…): Cannot find module …
        at updateError (…/cordis-plugin-loader/lib/index.js:309:9)
```

**真实样例——第 4 类（外层栈给行 id）**（同一份 stderr 里）：

```
    at file:///Users/mutou/.dsh/profiles/wy-research/#wy-boom
    at file:///Users/mutou/.dsh/profiles/wy-research/#include
```

**真实样例——第 2 类（pending）**：

```
$ dsh --profile wy-research --patch /tmp/wy-exp/E16-pending2.yml --no-open --port 3199
# overlay: - insert: [ {id: wy-pending, name: '/tmp/wy-exp/pending2.js'} ]；插件 apply.inject = { required: ['wyMissingService'] }
### CRASHED after 4s (port3199_listening=no)
### exit_code=1
### --- stderr ---
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
file:///tmp/wy-exp/pending2.js: pending (waiting for service: required)
  [cause]: Error: dsh: 1 entry did not activate
  file:///tmp/wy-exp/pending2.js: pending (waiting for service: required)
      at assertEntriesActivated (…/dsh-app-boot/lib/index.js:1492:9)
```

**真实样例——第 5 类（重复 id）**：

```
$ dsh --profile wy-research --patch /tmp/wy-exp/E15-dup.yml --no-open --port 3199
# overlay: - insert: [ {id: llm, name: '@deepseek-ai/dsh-llm'} ]   ← 与 bundle 层已有的 llm 行撞 id
### port3199_listening=no after 1s   alive=no   exit_code=1
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: llm
TypeError: duplicate loader entry id: llm
    at EntryGroup.update (…/cordis-plugin-loader/lib/index.js:91:28)
```

（第 5 类**在 1s 内即失败**，比其他类快得多——因为 `duplicate` 检查在 `Promise.allSettled` 之前的同步循环里，`:88-93`。）

**第 1 类：未实验验证，仅源码推断。** 尝试过 7 种构造（insert 不存在的包名 / 不存在的相对路径 / apply 抛错 / 模块语法错误 / 无 default 导出 / default 为 number / import 顶层抛错），**全部以第 3 类文案报出**，没有一次走到 `assertEntriesLoaded`。
源码层面的解释是：import 失败会在 `EntryGroup.update` 的 `Promise.allSettled` 结果检查处先抛（`cordis-plugin-loader/lib/index.js:97-101`），从 `mountRootInclude` 冒泡出去，`boot()` 根本走不到 `assertEntriesActivated`；而 `assertEntriesLoaded` 只在「settle 成功但有条目无 fiber」时才可能命中。
**因此第 1 类的实现在当前 dsh 版本下可能是难以触达的防御分支——移植时保留它无害，但不要把它当作主力识别路径。**

### 6.3 用**真实解析器**跑**真实 stderr**：覆盖矩阵

把本机捕获的全部 stderr 喂给 dsh-safe 真正的 `parseFailureReport`：

```js
import { parseFailureReport } from '/tmp/dsh-safe/failures.js'   // 直接取 main@d2c23ff 的 lib/failures.js
```

结果：

```
DETECTED     E1-final.err                   insert 裸包名不可解析
DETECTED     E2-relpath-final.err           insert 相对路径不存在
DETECTED     E3-final.err                   apply 抛错
DETECTED     E4-final.err                   模块 JS 语法错误
DETECTED     E18-emptymod-final.err         无 default 导出
DETECTED     E19-notaplugin-final.err       default 为 number
DETECTED     E20-toplevel.err               import 顶层抛错
DETECTED     E15-dup.err                    duplicate loader entry id
*** MISSED *** E16-pending-final.err        pending（file:// 名）
*** MISSED *** D1-badyaml.err               YAML 语法错误
*** MISSED *** C1-nonarray.err              顶层非数组
```

命中明细（节选）：

```
--- E2-relpath-final.err
    DETECTED=YES  names=[]  entryIds=[["include", …],["wy-ghost-plugin2", …]]
--- E3-final.err
    DETECTED=YES  names=[]  entryIds=[["include","          at file:///…/wy-research/#include"],
                                      ["wy-boom","          at file:///…/wy-research/#wy-boom"]]
--- E15-dup.err
    DETECTED=YES  names=[]  entryIds=[["llm","    [cause]: TypeError: duplicate loader entry id: llm"]]
--- E16-pending-final.err
    DETECTED=*** NO ***  names=[]  entryIds=[]  environmental=[]
```

### 6.4 覆盖不全的具体形态（逐条给结论）

**(1) 第 2 类对「非 npm 包名」的条目完全失效 —— 这是最严重的漏检。**

第 2 类的行正则 `^\s*(NAME_CLASS):\s`，`NAME_CLASS = [\w@][\w@./\-]*` **不含 `:`**，因此 `file:///…` 与绝对路径开头的行**完全不匹配**。实测：

```
npm-scoped name      => regexMatch: "@scope/pkg" | accepted by isPluginName: true
bare npm name        => regexMatch: "dsh-better-sidebar" | accepted by isPluginName: true
file:// path name    => regexMatch: NO | accepted by isPluginName: n/a
abs path name        => regexMatch: NO | accepted by isPluginName: n/a
```

后果：**`file://` / 路径式插件在 `did not activate` 块里报出时，5 类正则一条都不命中**（该块里也没有 `#id` 栈行可给第 4 类抓）。
这对本仓库**尤其致命**——桌面壳的插件正是通过 `--patch` 以路径方式注入的（`anchorInsertedPluginNames` 会把相对/绝对路径转成 `file://` URL，`dsh-app-boot/lib/index.js:1170-1178`），并且 dsh 自己的报错就用这个 URL 作为 name。

**(2) patch 文件解析类失败完全不在 5 类覆盖内（且这是「正确」的）。**
`D1-badyaml`（YAML 语法错误）、`C1-nonarray`（顶层非数组）都是 exit 1 的致命失败，但**没有坏插件可归因**。dsh-safe 全部 MISSED → 原样透传退出码，行为正确，但意味着**保险丝对这类「配置写坏了」的自伤场景完全无自愈能力**。

**(3) 第 3 类会同时把机制行 `include` 记成 entryId（误伤风险）。**
真实样例里 `entryIds` 总是同时含 `include`（`cordis:include`）与真凶。因为 `reEntry.exec` 取最左匹配：

```
class3 on real line: id="include" name="cordis:include"
```

dsh-safe 用三道闸门挡住：`isReservedEntry`（保留 id `include` / `webserver` / name 前缀 `cordis:`）、`isMountedByOfficialBundle`、`isFirstParty`（前缀 `@deepseek-ai/`），见 `lib/dedupe.js:28-31, 36-62, 78-79`，并额外用 `hasUnknownPackage` 做 **fail-closed**（名字解析不出来就当核心，`dedupe.js:81-85`）。
**移植物必须把这几道闸门一起移植**，否则会把加载机制本身禁掉。

**(4) 端口占用（EADDRINUSE）等环境类失败** 由 `ENV_ERRNO` 单独收进 `environmental`，不参与隔离——**设计正确**。
但本机**未实测** EADDRINUSE 的 dsh 文案（需要先占住 3199 再启动，未做），标为**未实验验证，仅源码/上游注释推断**。

**(5) 其他 5 类覆盖不到、但 dsh 会打印的失败形态**（源码可定位，未逐一实验）：
- profile manifest 配错：`profile bundle "x" declares no dsh.bundle in its package.json`（`dsh-app-boot/lib/index.js:852`）
- `--patch` 文件不存在：`failed to read overlay <path>: …`（`:1165`）
- profile 不存在：`profile "x" does not exist; create it with 'dsh plugin --profile x add <package>'`（`:890`）
- `patchReload` 取值非法：`dsh.profile.patchReload must be "live" or "startup"`（`:847`）

---

## 7. 这 5 条 JS 正则改用 Rust `regex` crate 复刻（对应问题 7）

**总判定：可以做等价复刻——5 条正则 + `ENV_ERRNO` 全部使用「无 lookaround / 无反向引用 / 无原子组 / 无条件组」的子集。**
但**不能逐字照抄**：`\w` 与 `\b` 的默认语义在 JS 与 Rust 之间**确实不同**（下方实测），必须显式化字符类。

### 7.1 语义差异（本机实测，Node v26.5.0 vs `regex` 1.x / rustc 1.96.0）

同一输入分别跑 JS 与 Rust：

| 特性 | 输入 | JS | Rust（默认） | 是否一致 |
|---|---|---|---|---|
| `\w` | `插件名` 对 `^[\w@][\w@./\-]*$` | `false` | **`true`** | ❌ **不一致** |
| `\w` | `abc插件` | `false` | **`true`** | ❌ **不一致** |
| `\b` | `中EADDRINUSE中` 对 `\b(?:EADDRINUSE\|EACCES)\b` | `true` | **`false`** | ❌ **不一致** |
| `\b` | `x EADDRINUSE x` | `true` | `true` | ✅ |
| `\s` | `a\u00a0b`（NBSP） | `true` | `true` | ✅ |
| `\s` | `a\ufeffb`（BOM） | `true` | `true` | ✅ |
| `\s` | `a\u2028b`（LS） | `true` | `true` | ✅ |
| `.` | `a\u2028b` 对 `a.b` | `false` | **`true`** | ❌ **不一致** |
| `.` | `a\nb` 对 `a.b` | `false` | `false` | ✅ |

**原因**：JS 的 `\w`/`\b` 以 **ASCII** 词字符定义；Rust `regex` 默认 **Unicode-aware**（`\w` = `\p{Word}`，`\b` 是 Unicode 词边界）。
JS 的 `.` 排除全部 line terminator（`\n \r \u2028 \u2029`），Rust 默认只排除 `\n`。

**Rust 不支持的特性实测**（本机 `regex::Regex::new` 结果）：

```
  REJECTED  lookahead: foo(?=bar)        -> regex parse error
  REJECTED  lookbehind: (?<=foo)bar      -> regex parse error
  REJECTED  backreference: (\w)\1        -> regex parse error
  REJECTED  atomic: (?>a)                -> regex parse error
  REJECTED  conditional: (?(1)a|b)       -> regex parse error
  OK        named-group: (?P<x>\w+)
  OK        lazy: a+?
  OK        possessive: a++
  OK        (?m) inline
```

上游 5 条正则**一个都没用到被拒特性**，所以不存在「必须换算法」的情况。

### 7.2 每条正则的 Rust 等价写法

```rust
// 显式 ASCII 字符类：替代 JS 的 \w（Rust 默认 \w 是 Unicode，语义不同，必须展开）
const NAME_CLASS: &str = r"[A-Za-z0-9_@][A-Za-z0-9_@./\-]*";
const ID_CLASS:   &str = r"[A-Za-z0-9_:\-]+";
```

| # | JS 原文 | Rust 等价写法 | 改动说明 |
|---|---|---|---|
| 1 | `` new RegExp(`failed to (?:apply\|import\|dispose\|rollback) loader entry (${ID_CLASS}) \\(([^)]+)\\)`) `` | `Regex::new(&format!(r"failed to (?:apply\|import\|dispose\|rollback) loader entry ({ID_CLASS}) \(([^)]+)\)"))` | 逐字等价（`ID_CLASS` 已 ASCII 化） |
| 2 | `` reStackId = new RegExp(`^\\s*at \\S+#(${ID_CLASS})`) `` | `Regex::new(&format!(r"^\s*at \S+#({ID_CLASS})"))` | 逐条一行匹配时等价；若对整段文本用，需加 `(?m)` |
| 3 | `reLoadList = /plugin\(s\) failed to load:\s*([^;\n]+);/` | `Regex::new(r"plugin\(s\) failed to load:\s*([^;\n]+);")` | 等价（`\s` 语义已验证一致） |
| 4 | `` reDupId = new RegExp(`duplicate loader entry id: (${ID_CLASS})`) `` | `Regex::new(&format!(r"duplicate loader entry id: ({ID_CLASS})"))` | 等价 |
| 5 | `` new RegExp(`^\\s*(${NAME_CLASS}):\\s`) `` | `Regex::new(&format!(r"^\s*({NAME_CLASS}):\s"))` | **ASCII 化后与 JS 行为一致，且更严格**（原 JS 也是 ASCII，见 §7.1） |
| 6 | `NAME_REGEX = /^${NAME_CLASS}$/` | `Regex::new(&format!(r"^{NAME_CLASS}$"))` | 同上，必须 ASCII 化 |
| 7 | `ENV_ERRNO = /\b(?:EADDRINUSE\|…\|ENFILE)\b/` | ⚠️ **不能直译**，见下 | `\b` 语义不同，需替换 |

**第 7 条的替代实现（本机已验证编译 + 行为对齐）**：

```rust
// 替代 JS 的 \b：不依赖 Unicode 词边界，显式排除 ASCII 词字符。
// 注意：这会"吃掉"边界字符，用于"本行是否环境类失败"的布尔判定完全够用；
//       若需要多次相邻匹配，改用 find_iter + 手工推进上界。
const ENV_ERRNO: &str =
    r"(?:^|[^0-9A-Za-z_])(?:EADDRINUSE|EADDRNOTAVAIL|EACCES|EPERM|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EMFILE|ENFILE)(?:[^0-9A-Za-z_]|$)";
```

实测边界行为（本机复核，含 `(?-u)` 变体）：

| 输入 | JS `\b`（基准） | 本 ASCII 展开版 | Rust 默认 `\b` |
|---|---|---|---|
| `中EADDRINUSE中` | `true` | **`true`** ✅ | `false` ❌ |
| `x EADDRINUSE x` | `true` | `true` ✅ | `true` ✅ |
| `EADDRINUSE` | `true` | `true` ✅ | `true` ✅ |
| `aEADDRINUSE` | `false` | `false` ✅ | `false` ✅ |
| `EADDRINUSEa` | `false` | `false` ✅ | `false` ✅ |

> ⚠️ **澄清一个容易写错的点**：上表里 `中EADDRINUSE中` 返回 `false` 的是 **Rust 默认的 Unicode 词边界 `\b`**（见 §7.1 表），**不是**本节的 ASCII 展开版。
> 原因：ASCII 展开版用 `(?:^|[^0-9A-Za-z_])` 判边界，`中` 不属于 `[0-9A-Za-z_]`，因此**照样构成边界**——JS 把 CJK 视为非词字符，两者结论一致。
> 即 **ASCII 展开版在全部 5 个用例上与 JS 逐字对齐**，并不比 JS 更严格，不存在「漏判环境类失败」的顾虑。
>
> `(?-u)` 写法（本节初稿标为未验证）**本机已验证**：`Regex::new(r"(?-u)\b(?:EADDRINUSE|…)\b")` **编译通过，且 5 个用例全部与 JS 一致**，可直接使用。
> 但**不要**把 `(?-u)` 与否定字符类混用：`(?-u)(?:^|[^0-9A-Za-z_])…` 会以 `pattern can match invalid UTF-8` **编译失败**；二者择一即可（推荐不带 `(?-u)` 的 ASCII 展开版，行为等价且不引入字节模式）。

**其他移植注意点（非正则）**：

| JS 写法 | Rust 对应 | 备注 |
|---|---|---|
| `text.split(/\r?\n/)` | `text.lines()` | `"a\n".split(/\r?\n/)` → `["a",""]`（2 个）；`"a\n".lines()` → `["a"]`（1 个）。**尾部空元素差异**，对逐行扫描无影响 |
| `list[1].split(/,\s*/)` | `s.split(',').map(str::trim)` | 语义等价（实测 `"@a/x, @b/y,@c/z"` → `["@a/x","@b/y","@c/z"]`） |
| `new RegExp` 动态拼接 | `format!` + `Regex::new` | 建议 `once_cell::sync::Lazy` 编译一次 |
| `\s*` / `\S` | 直接保留 | 已实测语义一致 |

**验证方式（本机真实执行）**：把 6 条 pattern 喂给 `regex::Regex::new` 全部 `COMPILE_OK`，并用真实捕获行回归：

```
class3 on real line: id="include" name="cordis:include"
class4 on stack line: Some("wy-boom")
class1 on synthesized: Some("@a/x, @b/y")
```

---

## 8. 可直接用于 Rust 实现的托管区块规格

以下规格与 dsh-safe 0.16.0-rc.2 的 `lib/patchfile.js` 对齐，并已在本机用真实 dsh 验证。

### 8.1 标记行与逐字样例

标记（`patchfile.js:9-10`，**逐字**）：

```
# --- dsh-safe managed (auto-generated; do not edit) ---
# --- end dsh-safe managed ---
```

写入块（`buildManagedBlock`，`patchfile.js:65-77`）——**标记行顶格、无缩进；条目 `- id:` 顶格；同级键 2 空格缩进**：

```yaml
# --- dsh-safe managed (auto-generated; do not edit) ---
# 由 dsh-safe 自动写入：启动失败的插件被置为 disabled，避免拖垮整个启动。
# 恢复：dsh-safe restore --profile <name> [--id <id> ... | --all]
# 2026-09-11T08:20:00Z · no-such-plugin-xyz · simulate: startup failure
- id: no-such-plugin-xyz
  name: 'no-such-plugin-xyz'
  disabled: true
# --- end dsh-safe managed ---
```

字段写法要点：
- `id` 用**裸标量**（不带引号）；含特殊字符时 dsh-safe 不引号，实际包名都是 `[A-Za-z0-9_@./-]`，安全。
- `name` 用**单引号**（`patchfile.js:72`：`` out.push(`  name: '${e.name}'`) ``）——因为 scoped 包名 `@a/b` 以 `@` 开头，YAML 里建议引号。
- `disabled: true` 必须是**布尔 true**，不是字符串 `'true'`。
- 注释行 `# <时间> · <名字> · <原因>` 是**人类可读行**，dsh 完全忽略。

⚠️ **`name` 是断言而非重命名**（§1.3 B）：若写入的 `name` 与目标行实际 `name` 不等，该条 patch 会被 **静默跳过**（只 warn，且该 warn 在 boot 时不可见，§3.4）。
**因此 `name` 字段要么写准，要么干脆不写。** 尤其注意：**路径式插件在 dsh 内部会被规范化为 `file://` URL**（`dsh-app-boot/lib/index.js:1170-1178`），写原始路径会导致 name mismatch。

### 8.2 空模板 `[]` 怎么处理

`smoke/cordis.patch.yml` 的出厂内容就是 3 行注释 + 独立的 `[]` 行。**若不删掉 `[]` 直接追加块序列，YAML 直接解析失败**：

```
$ cat t-a.yml
[]

- id: skill-filesystem
  disabled: true
$ dsh --profile wy-research --patch /tmp/wy-exp/t-a.yml --dump-config; echo "exit=$?"
exit=1
Error: dsh: failed to parse overlay /tmp/wy-exp/t-a.yml: YAMLException: end of the stream or a document separator is expected (3:1)
    at parsePatchList (…/dsh-app-boot/lib/index.js:1197:9)
```

反向也要处理：**摘除托管区块后若文档只剩注释/空白，必须补回 `[]`**，否则解析成 `undefined` → 非数组 → 同样致命：

```
$ printf '# just a comment\n# another\n' > t-b.yml
$ dsh --profile wy-research --patch /tmp/wy-exp/t-b.yml --dump-config; echo "exit=$?"
exit=1
Error: dsh: overlay /tmp/wy-exp/t-b.yml must be a top-level YAML array of loader patch entries
    at parsePatchList (…/dsh-app-boot/lib/index.js:1199:36)

$ : > t-c.yml          # 完全空文件，同样 exit=1，同一个 1199 行
$ printf '[]\n' > t-d.yml
$ dsh --profile wy-research --patch /tmp/wy-exp/t-d.yml --dump-config; echo "exit=$?"
exit=0                 # 只有 [] 是合法空层
```

`patchfile.js:117-133` 的 `applyManagedBlock` 正是按这个逻辑写的：写入前 `filter((l) => l.trim() !== '[]')` 删掉裸 `[]` 行；摘除后若无「非注释非空行」则补 `[]`。

### 8.3 行级扫描规则（避开 `config:` 子树）

需求：定位 `- id: xxx` 及其**同级**的 `name:` / `disabled:`，并跳过 `config:` 子树里可能出现的同名键。

dsh-safe 的做法（`patchfile.js:23-53`）是维护一个「已打开的 `config:` 缩进栈」：

```js
const openConfigs = []                       // 已打开 config: 键的缩进
let current = null                           // { id, name, disabled, keyIndent }
for (const line of lines) {
  const indent = /^\s*/.exec(line)[0].length
  while (openConfigs.length && openConfigs[openConfigs.length - 1] >= indent) openConfigs.pop()
  if (openConfigs.length) continue           // 在某个 config: 子树里 → 整行忽略
  const trimmed = line.trim()
  const rowM = /^-\s+id:\s*(\S+)$/.exec(trimmed)
  if (rowM) { flush(); current = { id: rowM[1], …, keyIndent: indent + 2 }; continue }
  if (!current || indent !== current.keyIndent) continue
  const nameM = /^name:\s*(.+?)\s*$/.exec(trimmed)
  if (nameM) { current.name = unquote(nameM[1]); continue }
  if (/^disabled:\s*true\s*$/.test(trimmed)) { current.disabled = true; continue }
  if (/^config:(\s|$)/.test(trimmed)) openConfigs.push(indent)
}
```

**Rust 移植要点**：
1. `indent` 用**字节/字符计数**（`line.len() - line.trim_start().len()`）即可，patch 文件是 ASCII 缩进。
2. `keyIndent = indent + 2`：假定同级键恰好缩进 2 空格——这与 dsh 出厂模板、`web/cordis.patch.yml` 一致，但对 4 空格缩进的用户文件会漏读。**建议 Rust 版改为「记录 `- id:` 所在行的缩进 `indent`，同级键取 `indent + 2`」并额外接受 `> indent` 的任意缩进作为同级键**（更宽容，且不会误读 `config:` 子树，因为子树已被栈排除）。
3. **`- id:` 用了 `^-\s+id:\s*(\S+)$` 且要求 `- ` 后有空格**；dsh 自身对 `- id: x` 与 `-id: x` 都接受（YAML 层面），但托管区块只写标准形式，扫描只认标准形式即可。
4. `disabled:` 只认 `true`，**注意 dsh 也允许 `!!js …` 表达式**（§2.3）；扫描到表达式时应保守处理（视为「不确定」而非「未禁用」）。
5. 是否需要读 `insert:` 子树？**需要**——`insert` 里也是行（`web/cordis.patch.yml` 第一条就是 `- insert:` + 嵌套行）。但「行 id ↔ 包名」对照表要按**嵌套层**处理，不能当成顶层行。

### 8.4 原子写策略与并发 / HMR 注意事项

**dsh 自己的写文件实现可以直接照抄思路**（`dsh-app-boot/lib/index.js:245-257`）：

```js
await writeFile(this.filename + ".tmp", this.content);
for (let retry = 0;; retry++) try {
    await rename(this.filename + ".tmp", this.filename);        // ★ 同目录 .tmp + rename = 原子替换
    return;
} catch (error) {
    if (!retryableWriteError(error) || retry >= WRITE_RETRY_LIMIT) throw error;
    await setTimeout$1((retry + 1) * WRITE_RETRY_DELAY_MS);     // EACCES/EBUSY/EPERM → 退避重试
}
```
`retryableWriteError` 只认 `EACCES | EBUSY | EPERM`（`:40-43`），重试上限 10 次、退避 50ms 递增（`:38-39`）。

dsh 另有更完善的跨进程写锁 + 随机后缀临时文件（`dsh-atomic-write/lib/index.js:65, 122-145`）：
`temp = ${filename}.${randomBytes(6).toString("hex")}.tmp`，`withFileLock(lockPath = ${filename}.lock, …, { waitMs })` 默认等待 `DEFAULT_LOCK_WAIT_MS = 2000`（`:105`），`wx` 创建、指数退避、超时抛错、**从不删除他人锁**。

**Rust 建议**：`.tmp`（带随机后缀）+ `rename`（同目录，保证同文件系统）+ 可选 `.lock`（`OpenOptions::new().write(true).create_new(true)` 模拟 `wx`）。
注意 **Windows 上 `rename` 不能覆盖已存在目标**——需 `fs::rename` 前先尝试删除或用 `ReplaceFile` 语义；本仓库 `knownrows` 场景可参考 CI 覆盖（本机为 macOS，**Windows 行为未实验验证**）。

**并发 / HMR 竞争（重要）：**

1. **`web` profile 的 patch 文件默认是 live 热重载的。** `PROFILE_TEMPLATES.web.patchReload = "live"`（`dsh-app-boot/lib/index.js:333-336`），且 `loadProfileDirectory` 在 manifest 未声明时兜底 `patchReload = "live"`（`:848`）；本机 `web/package.json` 的 `dsh.profile` **确实没有** `patchReload` 字段（只列了 `bundles`），所以走兜底 = **live**。
2. live 模式下 `runProfile` 会注册两个 watcher（`dsh/lib/profile-boot-Dk-7KqJc.js:321-338`）：
   ```js
   if (composed.profile.patchReload === "live" && …) try {
       if (ctx.get("hmr") === void 0) { … await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } }); }
       await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
       await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(), compose: composeLive });
   } catch (error) { suppressShutdownError(ctx, signalShutdown.signal, error); }
   ```
   `watchUserPatches`（`dsh-app-boot/lib/index.js:1109-1122`）在回调里重新 `loadOptionalPatches` 并 `entry.update({ config: { …, patches } })` ——**即写 patch 文件会让运行中的 dsh 立刻重算整棵树**。
3. **`--patch` 覆盖层不被 watch**（watcher 只注册 profile 层与 home 层）。所以桌面壳走 `--patch` 注入的插件**改了必须重启 dsh**；反之**若保险丝改写 profile 的 `cordis.patch.yml`，运行中的实例会立即 re-apply**。
4. **写入时机建议**：保险丝的工作流是「dsh 已经退出（exit 1）→ 写 patch → 重启」，此时**没有并发读者**，最安全。若要做「不停机热禁用」，必须接受 HMR 会立即重算树，且 `Include.enqueue`（`dsh-app-boot/lib/index.js:159-163`）会把并发 apply 串行化——**不要与 HMR 抢写**。
5. **临时文件必须与目标同目录**（`.tmp` 同目录 rename 才是原子的），且**命名不要以 `.yml` 结尾**，否则可能被目录扫描当成 config。

---

## 9. 对实现票 #57 的直接影响

1. **端口不是就绪信号，别用它判活。** dsh **在 settle 前 ~2.9s 就 bound 端口**，失败要等到 **~14.0s** 才 exit（§0.3 实测）。保险丝必须**以「进程退出 + exit code ≠ 0」为触发点**，并把 stderr 完整捕获到自建缓冲（参考 dsh-safe `wrap.js:27, 72-75` 的 512KiB 上限做法）。**若照搬桌面壳现有的「TCP 可连即健康」判活（见根 `AGENTS.md` 血泪坑 #4），会在 11 秒窗口内误判为健康并放弃自愈。**

2. **不要指望从 stderr 拿到 patch 失配警告。** `warn` 级别（L2）默认被 cordis 阈值 1 过滤，**连内存 buffer 都进不去**（§3.4 实测）。任何依赖「dsh 会告诉我 patch 没匹配上」的设计都必须改用 `dsh --dump-config`（直写 stderr），或自己做组件级校验。同理，**别把 `patch: entry "x" not found` 写进失败分类器**——它在 boot stderr 里永不出现。

3. **托管区块的 `[]` 处理是硬性的两个方向。** 追加前必须删掉裸 `[]` 行（否则 YAML 直接报错，§8.2）；摘除后若只剩注释必须补回 `[]`（否则 `undefined` → 非数组报错）。这两个错误都会让 dsh **在 composeProfile 阶段就 exit 1，且 5 类正则全都不命中**——即保险丝自己把 dsh 写坏了，且**自愈不了**。建议每次写入前先做一次「解析自检」（本地 YAML 解析 + 顶层是数组）。

4. **行扫描要按「栈 + 缩进」严格排除 `config:` 子树，并且 `disabled` 要能识别 `!!js` 表达式。** dsh 官方 bundle 里就有 `disabled: !!js process.platform === 'win32'`（`dsh-app-boot` dump 第 114 行）。把这种表达式行误判为「已禁用」，会让保险丝以为插件已被关掉而实际上平台判断为 false。
   （且注意 `!!js` 是 `JSON_SCHEMA.extend` 的自定义 tag，**普通 YAML 库解析会直接报错**——Rust 侧若要解析 patch 文件，需要一个能容忍未知 `!!js` tag 的解析器，或只做行扫描不解析。）

5. **必须移植 dsh-safe 的三道「永不隔离」闸门 + fail-closed。** 真实 stderr 里 `entryIds` **总是同时包含机制行 `include`**（`class3 on real line: id="include" name="cordis:include"`）。需要保留：保留 id 集合（`include` / `webserver`）、`cordis:` 名字前缀、`@deepseek-ai/` 前缀、以及「由官方 bundle 挂载」的结构信号；名字解析不出来时**按核心处理**（`dedupe.js:28-31, 36-62, 78-85` 的注释记录了上游一次真实事故：官方 webserver 被误禁、台账记成 `name: null`）。

6. **第 2 类检测对 `file://` / 路径式条目名失效，而这正是本仓库插件的形态**（§6.4(1)）。若保险丝只照抄 5 条正则，**对本仓库自己注入的插件在 `did not activate` 场景下会漏检**。至少要把第 2 类的行正则扩展为「非空白的 `key:` 前缀」而不是 `NAME_CLASS`，或在 Rust 侧额外用第 4 类的 `#id` 栈行兜底。

---

## 10. 旧结论核对表

| # | 旧结论（来自丢失报告的残留评论） | 判定 | 证据 |
|---|---|---|---|
| **a** | 「顶层 YAML 数组，元素为 PatchOptions（id/insert/name/config/disabled/inject）；三种模式 insert/override/未匹配(warn 跳过)」 | ✅ **证实**（字段清单需补一条限定） | 顶层数组：`dsh-app-boot/lib/index.js:1199`；`id/insert/name` 为控制字段、其余为覆盖键：`:70-71, 102-105`；三模式与 warn 跳过：`:72-105`；真实实例 `~/.dsh/profiles/web/cordis.patch.yml`。**限定**：`config`/`inject` 是**整体替换**不是合并（`:104`），`name` 是**断言**不是重命名（`:98-101`） |
| **b** | 「js-yaml + 自定义 schema（JSON_SCHEMA + !!js tag）；解析失败 → exit(1)」 | ✅ **证实**（补：不是优雅退出） | `yaml.load(content, { schema: userPatchesSchema })` = `JSON_SCHEMA.extend(JsExpr)`：`dsh-app-boot/lib/index.js:1195, 1101, 30`；`!!js` tag 定义：`:17-23`；实测 `!!js` 可用（`dump` 原样打印 `disabled: !!js process.platform === 'win32'`）；解析失败实测 **exit 1 + 裸 Node 栈**（`bad-nonarray.yml` / `bad-yaml.yml`，`:1197/:1199`）。**修正**：机制是**未捕获异常冒泡**（早于 boot、早于 loader），不是 dsh 有意的优雅退出 |
| **c** | 「在 disabled 条目旁追加托管区块 dsh 只 warn 不报错，行级扫描可行，不需要 YAML 库；空模板 [] 需先移除」 | ✅ **证实**（三条子结论全部独立复现） | (1) 只 warn 不报错：源码 `:93-97`；实测 `dumpB1.err` = `dsh: […/cordis.patch.yml] patch: entry "no-such-plugin-xyz" not found` 且 `exit=0`；真实启动 survive 20s。(2) 行级扫描可行：`patchfile.js:23-53` 的栈式扫描 + 本报告 §8.3 规格；**但发现了新的坑**：该 warn 在 boot 时不可见（§3.4）。(3) `[]` 需先移除：实测 `[]` + 块序列 → `YAMLException: end of the stream or a document separator is expected (3:1)` exit 1；反向「只剩注释」→ `must be a top-level YAML array` exit 1 |
| **d** | 「无子文件 include；patch 层通过 bundles 数组顺序合成；改 profile 的 cordis.patch.yml 只影响该 profile」 | ✅ **证实**（补：还有 home 层与 `--patch` 层） | 无 include 机制：层来源只有 4 处，`dsh/lib/profile-boot-Dk-7KqJc.js:213-220`；bundles 顺序合成：`:240-247` + `dsh-app-boot/lib/index.js:849-859, 904-909`；只影响该 profile：profile 层独立（`:861-862`）。**补充**：`$DSH_HOME/cordis.patch.yml` 会**影响全部 profile**（`:111-118`，本机不存在），`--patch` 可重复叠加且**不被 watch** |
| **e** | 「两阶段审计：任何 entry import/activation 失败 → 整棵树失败；disabled: true → 跳过审计；不存在部分启动」 | ✅ **证实**（「不存在部分启动」需限定） | 两阶段：`boot` 的 `loader.await()` + `assertEntriesActivated`（`:1534-1537`）；整棵树失败 + dispose：`:1539-1546`；disabled 跳过两处：`:1435` 与 `:1471`；无部分启动的**最终状态**。**限定**：**进程层面存在 11 秒的「端口已开但注定失败」中间态**（§0.3 实测：端口 2.9s 开、14.0s 才 exit）；另有「surface 自行销毁树 → 正常返回」分支（`:1536`） |
| **f** | 「stderr 5 类格式已实验捕获；Rust regex crate 可直接复刻（无 JS 特有特性）」 | ⚠️ **部分推翻** | **5 类格式**：4 类已本机实验捕获（2/3/4/5，见 §6.2 各真实样例），**第 1 类 `plugin(s) failed to load` 7 种构造均未复现，仅源码可寻**（`dsh-app-boot/lib/index.js:1438`）→ 第 1 类判**无法验证（未实验验证，仅源码推断）**。**「无 JS 特有特性」被推翻**：`\w` 与 `\b` 在 JS（ASCII）与 Rust（Unicode）之间**实测语义不同**（`插件名` 在 Rust 默认 `\w` 下匹配、JS 下不匹配；`中EADDRINUSE中` 的 `\b` JS=true / Rust=false），`.` 也不一致（U+2028）。**可以复刻，但必须把字符类 ASCII 显式化，`\b` 需改写**（§7.1/§7.2） |

---

## 附录 A：本次实验清单（全部在 scratch profile `wy-research` + 端口 3199）

| 编号 | 目的 | overlay | 结果 |
|---|---|---|---|
| baseline | 基线：scratch profile 能正常起 | 无 | LISTEN @3s，20s 存活 |
| B1 | **Q3 主实验**：disabled 旁追加含假 id 的托管块 | profile patch 内联 | 20s 存活，exit 0 |
| C1 | `--patch` 顶层非数组 | `bad-nonarray.yml` | exit 1，`:1199` |
| D1 | `--patch` YAML 语法错误 | `bad-yaml.yml` | exit 1，`:1197` |
| t-a…t-d | `[]` 与注释边界 | 4 个小文件 | `[]`+序列=exit 1；注释-only=exit 1；空文件=exit 1；`[]`=exit 0 |
| E1 | insert 裸包名不可解析 | `no-such-module-xyz` | exit 1 @14s，第 3 类 |
| E2 | insert 相对路径不存在 | `./definitely-not-here.js` | exit 1 @14s，第 3 类 |
| E3 | apply 抛错 | `boom.js` | exit 1 @14s，第 3+4 类 |
| E4 | 模块 JS 语法错误 | `syntaxerr.js` | exit 1 @14s，第 3 类 |
| E15 | 重复 loader entry id | `id: llm` 二次挂载 | exit 1 @1s，第 5 类 |
| E16 | pending（缺 service） | `pending2.js` | exit 1 @4s，**5 类全漏** |
| E18/E19/E20 | 无 default / default=number / import 顶层抛错 | 3 个小模块 | exit 1 @14s，第 3 类 |
| E21/E22/E23 | logger 级别探针 + buffer dump | `probe3/4/5.js` | `warn`/`debug` 被过滤；`error`/`info` 存活 |
| modes.yml | 六种 patch 失配文案 | `modes.yml` | 6 条 warn 逐字捕获，exit 0 |
| timing | 端口 vs 失败时间线 | `E3-boom.yml` | 端口 2.9s / exit 14.0s |

**清理**：`rm -rf ~/.dsh/profiles/wy-research` 已执行；端口 3199 已释放；`web` / `smoke` profile 校验和与 mtime 均未变；3080 原实例（PID 22680）未受影响。

## 附录 B：`dsh-safe` 0.15.0 → 0.16.0-rc.2 的失败检测/隔离逻辑变化（问题背景要求）

`gh api repos/hyzyn/dsh-safe/compare/v0.15.0...v0.16.0-rc.2` 结果（节选 lib/ 与 test/）：

```
modified  +31 -6   lib/failures.js
modified  +63 -2   lib/dedupe.js
modified  +47 -13  lib/knownrows.js
added    +151 -0   lib/dshpkg.js
added    +130 -0   test/env-failure.test.js
modified  +33 -0   test/failures.test.js
```

**结论（可确定的部分）**：

- **`lib/patchfile.js`（patch 文件读写 / 托管区块 / 行扫描）在 0.15.0 → 0.16.0-rc.2 之间完全没变**（`diff` 无输出）。
  → 本报告 §3、§8 关于托管区块与行扫描的结论对两个版本同样成立。
- **`lib/failures.js` 有变化，但 5 类正则本身没变**：新增的是 `ENV_ERRNO` 环境类失败识别（`failures.js:39-40`）与 `environmental` 返回值。
  `diff` 显示这 4 条匹配正则（`reEntry`/`reStackId`/`reLoadList`/`reDupId`）与第 2 类块扫描的**正则表达式文本逐字未改**，仅在第 2 类里增加了 `ENV_ERRNO` 分支。新增 `test/env-failure.test.js`（+130 行）对应此改动。
  → **本报告 §7 的 Rust 等价写法对两版通用**。
- **`lib/knownrows.js`（行 id ↔ 包名对照）有较大改动**（+47 -13），并新增 `lib/dshpkg.js`（+151）——从 `knownrows.js` 顶部注释与 `bundleDirCandidates` 可见是**新增了「dsh 安装目录下的官方 bundle」候选路径**（否则只按 profile 目录找会把官方 bundle 的行整表漏掉），以及 `internal` 标记用于区分官方来源。这**改进了误隔离防护**（配合 `dedupe.js` 的 `isMountedByOfficialBundle`）。
- **`lib/dedupe.js` 亦有改动**（+63 -2）——结合 `isReservedEntry` / `isCoreEntry` / `hasUnknownPackage` 的存在与注释，方向是**加强「永不隔离」保护**。

**无法确定的部分**：0.15.0 与 0.16.0-rc.2 之间 **`lib/wrap.js` 的重试/隔离决策主流程是否改变了判定顺序**（`wrap.js` 也有 +26 -6 的改动），本报告只核对了 `lib/` 中「失败检测正则」与「patch 文件读写」两块与本票直接相关的文件，**未逐行审阅 `wrap.js`/`repair.js`/`quarantine.js` 的全部决策分支** → 标为**无法确定**。
另：map 里记录的 **v0.15.0 已过时**，当前 main 为 **0.16.0-rc.2**（`package.json` 实测），本报告一律以 main @ `d2c23ff197f6` 为准。

## 附录 C：复现命令速查

```bash
# 1) 看 patch 层的真实合成结果（会重写该 profile 的 cordis.yml！勿对生产 profile 跑）
dsh --profile <name> --dump-config
# 2) patch 文件坏掉时的恢复诊断：不解析用户层
dsh --profile <name> --dump-default-config
# 3) 安全实验：复制 profile + 独立端口 + --no-open
cp -R ~/.dsh/profiles/smoke ~/.dsh/profiles/wy-research
dsh --profile wy-research --patch <overlay.yml> --no-open --port 3199
# 4) 结束后务必清理
rm -rf ~/.dsh/profiles/wy-research
```
> ⚠️ 同 profile 的 dsh web 同时只能一个（单实例约束，见根 `AGENTS.md` 血泪坑 #3）——实验必须换 profile 名或换 `DSH_HOME`。
