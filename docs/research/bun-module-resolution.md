# #209 Bun 模块解析适配方案 —— 只读调研报告

- 调研对象：Bun **1.4.0**（`~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun`，`bun --version` → `1.4.0`），macOS arm64。
- 仓库只读位：`/Users/mutou/vault/projects/dsh-desktop-tauriapp/.agents/worktrees/map/204-electrobun-shell`
- 运行时树只读位：`~/Library/Application Support/com.arcreel.dsh-desktop-tauriapp/runtimes/0.2.1-alpha.2/node_modules`（**540** 个顶层包名，全平铺真实目录，`.pnpm` 只有 1 项 ⇒ 纯 hoisted）
- 所有实验都在 `/tmp/mod209/**` 隔离目录；未写仓库、未写 `~/.dsh`、未 kill 任何进程。唯一"联网面"的实验（G3b/H6/H7）用 `npm_config_registry=http://127.0.0.1:1/` 把 registry 指向本机废端口，**没有真实外网出口**，且都在 `/tmp`。

---

## 一、结论

1. **Node 的 `register` / `registerHooks` 在 Bun 1.4.0 上没有任何等价物。** `module.register` 是**静默 no-op**（连报错都没有），`module.registerHooks` 不存在。想在 Bun 里"按裸说明符改写解析目标"，唯一看起来对的 API（`Bun.plugin.onResolve`）**永远看不到裸说明符**，且对 `node_modules` 内部的**静态** import **根本不触发**——这正是 dsh 模块图的绝大部分。它只能事后改写"已经被 Bun 解析成绝对路径"的结果。
2. **`NODE_PATH` 在 Bun 1.4.0 完整可用**，语义与 Node 一致（对真实运行时树做过 Node 对照，6/6 结果相同）：裸说明符、`@scope/*`、`require()`、`Bun.resolveSync`、多个冒号分隔条目、`exports` 子路径全部命中；**包括从 `node_modules` 内部发起的 import**。唯一差异是它是 **node_modules 走查之后的兜底**，所以 **profile 树里存在的旧副本会遮蔽运行时树**。
3. **要复刻现有 `resolver-hooks.mjs` 的"内置树赢"语义，Bun 下只能靠改 profile 树**（合并/reconcile），没有纯环境变量或纯 hook 的解法。而这不是假想问题：当前 `desktop` profile 就有 **26 个包名与运行时树碰撞、其中 8 个版本不一致**（`web` 是 49/13），含 dsh 核心自己在用的 `@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`。
4. **推荐方案 = `NODE_PATH`（补"profile 里根本没有"）+ reconcile（治"profile 里有旧副本"）两者都要**，已端到端实测通过（下面 K 节三跑对照：单用任一个都不成立，两个一起 4/4 命中运行时树）。
5. **合并树（spike 的做法）可行但更贵**，而且它的"profile 更新后是否还成立"答案是：**外条目会被 pnpm 保留，但它自己 lockfile 拥有的同名条目会被 pnpm 覆盖**（实测）。所以合并树也必须 reconcile，和推荐方案是同一套机制，只是作用范围更大。

---

## 二、证据

### A. 现状代码：钩子到底在做什么

`desktop/src-tauri/src/runtime/builtin/launcher.mjs:32-42`

```js
process.env.DSH_DESKTOP_BUNDLED_MODULES = bundledNmRoot
const mod = await import("node:module")
const hooksSpec = new URL("./dsh-resolver-hooks.mjs", import.meta.url).href
if (typeof mod.registerHooks === "function") { mod.registerHooks(hooksSpec) } else { mod.register(hooksSpec) }
```

`desktop/src-tauri/src/runtime/builtin/resolver-hooks.mjs:16-38` 的语义（逐字）：

```js
function isBareSpecifier(specifier) { ... }
export async function resolve(specifier, context, nextResolve) {
  ...
  const scopeRoot = specifier.startsWith('@') ? join(bundledNm, specifier.split('/')[0], specifier.split('/')[1]) : join(bundledNm, specifier)   // :28
  if (!existsSync(join(scopeRoot, 'package.json'))) { ...; return nextResolve(specifier, context) }                                   // :29-31
  const resolved = await nextResolve(specifier, { ...context, parentURL: bundledNmUrl })                                                // :33
  return { ...resolved, shortCircuit: true }                                                                                           // :35
}
```

要点（决定了 Bun 侧必须复刻什么）：
- 判定发生在 **裸说明符阶段**，用 `existsSync(<运行时树>/<pkg>/package.json)` 决定接管。
- 接管后**强制以运行时树为 parent 重新解析** → 运行时树版本赢，profile 旧副本被压掉。
- 不在运行时树里的包（profile 插件自己的第三方依赖）走默认链 —— 这一条要保留。
- `builtin.rs:19` 内嵌该文件，`builtin.rs:131-132` 在启动目录写出 `dsh-resolver-hooks.mjs`。

既有背景记录：`docs/research/spike-219-electrobun/README.md:90-92` 已记 "Bun 没有 `module.registerHooks`，`Bun.plugin({onResolve})` 对 `node_modules` 内的 import 不生效"，本次把边界量化了。

### B. 实验 1 — Bun 钩子面（`/tmp/mod209/apisurface.mjs`, `apisurface2.mjs`）

```
module.register        = function
module.registerHooks   = undefined
module.registerHooksSync= undefined
createRequire          = function
Bun.resolveSync        = function
Bun.plugin             = function
register() threw? NO (silently accepted / no-op)
```

> `module.register()` 传一个**不存在**的路径也不报错 ⇒ 真的 no-op。壳在 Bun 下"装上钩子"会打印成功横幅但一点作用没有，这是最危险的失败模式。

可用的解析相关 CLI 开关（`bun --help`）：`--conditions=<val>`、`--main-fields=<val>`、`--no-install` / `--install=auto|fallback|force`、`--prefer-offline`、`-r/--require`、`--import`、`--cwd`、`-l/--loader`。
**没有任何一个能做"路径重定向"**：`--conditions` 只改 `exports` 条件，`--main-fields` 只改包内入口字段。

`bunfig.toml` 探测（`/tmp/mod209/exp14`）：
- `preload = ["./pre.mjs"]` **有效**（输出 `[BUNFIG-PRELOAD] loaded`）。
- 未知键被静默忽略。
- `BUNFIG=<path>` 环境变量**不生效**（preload 没被加载）⇒ 壳只能靠显式 `--preload`。
- bunfig 无法设置环境变量 / `NODE_PATH`。

### C. 实验 2 — `Bun.plugin` 拦截边界（这是最关键的一张表）

`/tmp/mod209/exp2`（`lib-p` 静态 import `q-s`；`local.mjs` 是非 node_modules 文件）。

**C1｜onResolve 能改写吗？** 能，但只对"已经被解析成绝对路径"的项：

```
[P5] REDIRECT (plain path)
STATIC_FROM_ENTRY lib-p lib-p->HIJACKED      ← lib-p 内部的静态 import 被改写成功
LOCAL {"stat":"lib-p","dyn":"HIJACKED"}
DYNAMIC_FROM_ENTRY HIJACKED
```

返回 `file://` URL 会炸，必须给**普通文件系统路径**：

```
[P4] REDIRECT q-s abs path: /private/.../node_modules/q-s/index.mjs
error: ENOENT reading "file:///private/tmp/mod209/exp2/redir.mjs"
```

**C2｜onResolve 看到的是什么？**（`/tmp/mod209/exp2/plugin2.mjs`）

```
onResolve spec=/private/tmp/mod209/exp2/entry2.mjs         imp=bun:main
onResolve spec=./local.mjs                                  imp=/private/tmp/mod209/exp2/entry2.mjs
onResolve spec=/private/.../node_modules/q-s/index.mjs       imp=            ← 已经是绝对路径，裸说明符丢了
onResolve spec=/private/.../node_modules/lib-p/index.mjs    imp=
```

`importer` 对 node_modules 内的文件恒为空串；**裸说明符 `q-s` / `lib-p` / `pkg-b` 一次都没出现过**。同一个模块会被回调多次（预扫 + 运行时各一遍）。

**C3｜能救"解析失败"吗？不能。**（`/tmp/mod209/exp3`，运行时树里有 `ghost-pkg`，profile 树里分两种）

```
CASE A  profile 有旧副本:  [P6] onResolve spec=.../app/node_modules/ghost-pkg/index.mjs   → RESOLVED_TO RUNTIME-GHOST   ✅
CASE B  profile 什么都没有: [P6] onResolve spec=.../app/entry3.mjs
                           error: Cannot find package 'ghost-pkg' from '.../entry3.mjs'  ❌ 钩子根本没被问
```

**C4｜静态 vs 动态（决定性）**（`/tmp/mod209/exp6`，profile 树里放 `@deepseek-ai/dsh-foo@1.0.0`，运行时树 `@9.9.9`，同时开 `NODE_PATH` 与 merge plugin）

```
C1b  静态裸 import，profile 有旧副本，只有 NODE_PATH          → PLUGIN_SAW PROFILE-STALE-1.0.0   （旧副本赢）
C2b  静态裸 import，profile 无副本，只有 NODE_PATH            → PLUGIN_SAW RT-9.9.9             ✅
D1   静态裸 import from ENTRY + onResolve merge plugin        → ENTRY_STATIC_SAW PROFILE-STALE-1.0.0  ❌ 钩子没触发
D2   动态裸 import from ENTRY + onResolve merge plugin        → [MERGE] .../app/.../dsh-foo/index.mjs -> .../rt/.../dsh-foo/index.mjs
                                                                   ENTRY_DYNAMIC_SAW RT-9.9.9     ✅
C3b  静态裸 import from node_modules 内部 + onResolve        → PLUGIN_SAW PROFILE-STALE-1.0.0   ❌ 钩子没触发
```

汇总：

| import 场景 | 形式 | onResolve 看到裸说明符 | onResolve 看到绝对路径 | 返回 path 生效 |
|---|---|---|---|---|
| 入口 | — | ✔ | ✔ | ✔ |
| 用户文件 → 相对路径 | 静态 | ✔（原样） | ✔ | ✔ |
| 用户文件 → 裸说明符 | 静态 | ✘ | ✔ | ✔ |
| 用户文件 → 裸说明符 | `await import()` | ✘ | ✔ | ✔ |
| **node_modules 包 → 裸说明符** | **静态** | ✘ | **✘** | **✘** |
| node_modules 包 → 裸说明符 | `await import()` | ✘ | ✔ | ✔ |
| `require()` | — | ✘ | ✘ | ✘ |

> dsh 的模块图（`profile-boot.js` / `dsh-app-boot` / cordis loader / 每个插件包的内部）**几乎全是"node_modules 包里的静态裸 import"** ⇒ `onResolve` 方案对它是无效的，不是边角情况。

**C5｜`onLoad` 边界**：与 onResolve **不同**，它**会**拦 node_modules 内部文件（`/tmp/mod209/exp7/entry14.mjs` 报 `Export named 'seenB' not found` —— 内容被整份替换了）。但：
- 必须返回 `{contents, loader}`；返回 `undefined` → `TypeError: onLoad() expects an object returned`；返回 `{}` → `error: Expected "contents" to be a string or an ArrayBufferView`。
- 只能替换**源码文本**，没有 `path` 字段，**无法改解析目标**。拿它改写 dsh 包源码不可接受。
- 它的 filter 会连入口文件一起匹配（实测把 `entry12.mjs` 自己也替换掉了，输出全丢）。

**C6｜CJS 世界可以打补丁，但和 ESM 分离**（`/tmp/mod209/exp7`）

```
E1  bun -r hijack.cjs, require('cjs-dep')                → [HIJACK] _resolveFilename cjs-dep → REQUIRE_SAW RT-9.9.9   ✅
E3  同一 patch 下 await import('cjs-dep')               → ESM_DYNAMIC_SAW PROFILE-STALE
                                                          [HIJACK] ... → REQUIRE_SAW RT-9.9.9                      ❌ 对 ESM 无效
E2  NODE_OPTIONS="--require=..."                          → REQUIRE_SAW PROFILE-STALE   （Bun 不认 NODE_OPTIONS）
```

> 即 `Module._resolveFilename` 猴补丁只覆盖 CJS，Bun 的 ESM 走另一套。C1/E3 两条合起来说明 Bun 存在**两个互不相通的解析世界**。

### D. 实验 3 — `NODE_PATH` 边界（`/tmp/mod209/exp4`，`app` 树 = profile，`rt` 树 = 运行时）

```
T0 无 NODE_PATH：   root=APP-stale-np-pkg  sub=ERR Cannot find package 'np-pkg'  scoped=APP-stale-@np/s
T1 有 NODE_PATH：   root=APP-stale-np-pkg  sub=RT-np-pkg-sub  hidden=RT-np-pkg-hidden  scoped=APP-stale-@np/s
T2 profile 无副本： root=RT-np-pkg         sub=RT-np-pkg-sub  hidden=RT-np-pkg-hidden  scoped=RT-@np/s
T3 多条目（冒号分隔，含两个不存在目录）：同 T2
```

- **能**：裸说明符、`@scope/name`、`require()`、`Bun.resolveSync`、`exports` 显式子路径、多个冒号分隔条目。
- **不能**：压过 profile 树里已存在的副本（T1 的 `root` / `scoped`）。它是**兜底**，不是覆盖。
- **分裂风险**：T1 的 `sub` / `hidden` 是从 RT 拿的、`root` 是从 profile 拿的 ⇒ **同一个包被实例化两份**。这是 NODE_PATH 独有的失败模式，比"整体用旧版"更难查。

**D1｜`NODE_PATH` 是进程启动快照，运行时改无效**

```
G1  脚本内 process.env.NODE_PATH = ... 再 import   → error: Cannot find module '@deepseek-ai/dsh-base'
G1b 启动时给了 NODE_PATH，脚本内 delete 后再 import → CLEARED_AT_RUNTIME_STILL_RESOLVED -> YES (start-time snapshot)
```

⇒ 壳必须在 **spawn 时**把它放进子进程 env，host 脚本内部再设是无效的。

**D2｜对真实运行时树的 Node/Bun 对照**（`/tmp/mod209/exp8/prof/probe-real.mjs` vs `probe-node.cjs`）

| 裸说明符 | Bun 1.4.0 + NODE_PATH | Node + NODE_PATH | 一致 |
|---|---|---|---|
| `@deepseek-ai/dsh-app-boot` | `<RT>/lib/index.js` | `<RT>/lib/index.js` | ✔ |
| `@deepseek-ai/cordis` | `<RT>/lib/index.js` | `<RT>/lib/index.js` | ✔ |
| `@deepseek-ai/dsh-base` | `<RT>/lib/index.js` | `<RT>/lib/index.js` | ✔ |
| `yaml` | `<RT>/dist/index.js` | `<RT>/dist/index.js` | ✔ |
| `@deepseek-ai/dsh` | `Cannot find package` | `No "exports" main defined` | ✔（**都失败**，因为 `@deepseek-ai/dsh` 的 `exports` 没有 `"."`，与 `NODE_PATH` 无关） |
| `cordis` / `react` | `Cannot find package` | `Cannot find module` | ✔（运行时树里确实没有） |

**D3｜从 node_modules 内部发起也生效**（`/tmp/mod209/exp5`：profile 里的 `plug-x` import 运行时树独有的 `rt-dep`）

```
PLUGIN_SAW RT-rt-dep | ALSO RT-rt-dep
```

**D4｜对真实运行时树 + 模拟 profile 插件**（`/tmp/mod209/exp11`）

```
J1 无旧副本：  cordis -> <RT>/@deepseek-ai/cordis/lib/index.js   (26 exports)   base -> <RT>      ✅
J2 有旧副本：  cordis -> <PROF>/@deepseek-ai/cordis/index.js     (2 exports)    base -> <RT>      ❌ 被遮蔽
```

### E. 实验 4 — 真实 profile 的碰撞面（只读统计，`~/.dsh/profiles/*`）

用一次性 node 脚本对比「运行时树顶层包名集合」与「profile 树顶层包名集合」：

```
runtime top-level package names: 540
profile desktop: 151 pkgs | collide with runtime: 26 | version-skewed: 8
   @deepseek-ai/cosmokit   profile=1.8.5    runtime=1.8.6-alpha.1
   @deepseek-ai/schemastery profile=3.18.4  runtime=3.18.5-alpha.1
   @deepseek-ai/dsh-experimental-{agent-team-profile,auto-review,voice-input-bundle} 0.2.0-rc.2 vs 0.2.1-alpha.2
   commander 8.3.0 vs 15.0.0 | fflate 0.8.3 vs 0.8.2 | undici 8.10.0 vs 8.11.2
profile web:     221 pkgs | collide: 49 | version-skewed: 13   (多出 open / type-fest 0.13.1 vs 4.41.0 / ws / wsl-utils)
profile smoke:   10 pkgs | collide: 7  | version-skewed: 1   (zod 4.1.8 vs 4.6.5)
```

形态（`ls -la`）：

```
cosmokit   v=1.8.5    [REAL DIR]        ← 真副本，会遮蔽
schemastery v=3.18.4  [REAL DIR]        ← 真副本，会遮蔽
dsh-experimental-*  [SYMLINK -> ../../../../../../<APP>/Contents/Resources/dsh/node_modules/@deepseek-ai/dsh-experimental-*]
```

所有 profile 的 `pnpm-workspace.yaml` 都带 **`autoInstallPeers: false`**，且 profile 的 `@deepseek-ai/*` 插件包一律用 `link:` 指向运行时树 ⇒ **核心 `@deepseek-ai/*` peer 不会被自动装进 profile 树**（这是 dsh 上游 profile bootstrap 的设计），碰撞面因此被压在两位数而不是 540。**但它没有归零**：`cosmokit` / `schemastery` 就是活的碰撞。

### F. 实验 5 — pnpm 对合并树的影响（`/tmp/mod209/exp12`，pnpm 11.16.0，`nodeLinker: hoisted`，纯 `file:` 依赖、全程 `--offline`，无外网）

```
前置：proj/node_modules/my-dep -> /tmp/mod209/exp12/other/my-dep   （模拟运行时树软链）
pnpm install  ⇒  my-dep 变成 REAL DIR，内容 = FROM-DEPSRC    ← pnpm 把自己 lockfile 拥有的同名条目【覆盖】掉了
```

```
前置：再放一个 lockfile 不认识的 foreign-dep 软链
pnpm install（lockfile 未变）        ⇒ foreign-dep 软链【存活】，my-dep 保持真实目录
改动 package.json 后 pnpm install（lockfile 变化）⇒ foreign-dep 软链【仍存活】
```

⇒ **合并树的两个事实**：
1. 合并进来的"外来"软链**不会被 pnpm 清掉**，profile 装/更新插件后仍然成立（比预期好）。
2. 但只要插件的依赖树里有一个**与运行时树同名的包**（`commander`、`zod`、`@deepseek-ai/cosmokit`…），pnpm 会用自己 lockfile 的版本**覆盖**合并条目 ⇒ **合并树也必须 reconcile**，与推荐方案是同一套机制，只是作用范围更大（540 个 vs 26/49 个）。

### G. 实验 6 — 自动安装与副作用（`/tmp/mod209/exp9`）

```
H1 package.json 有缺失依赖、无 node_modules、默认 install 模式   → error: Cannot find package 'is-odd'   （没有触发安装）
H2 node_modules 存在但依赖缺失、默认模式                        → 同上
H3 同 H2 但 --no-install                                        → 同上
H5 bun run ./t.mjs 形式                                         → 同上
H6 bun x cowsay@1.6.0（bogus registry）                          → Resolving dependencies / Resolved, downloaded and extracted [6] / ConnectionRefused
H7 bun --no-install x cowsay@1.6.0                              → Could not find an existing 'cowsay' binary to run. Stopping because --no-install was passed.
H4 安装前后目录清单                                            → 未写入任何文件
```

⇒ Bun **1.4.0** 里自动安装只在 `bun x` 这条面触发，`bun run <script>` 的裸 import 缺失不会去装。`--no-install` 仍然要带：它能挡住 `bun x` 面（若 dsh 或插件内部用 `bun x` 跑包二进制），而且零成本。

### H. 实验 7 — 符号链接与 `import.meta.url`（`/tmp/mod209/exp10`）

```
SYMLINKED_PKG_RESOLVED -> RT-sym-pkg
import.meta.url      -> file:///private/tmp/mod209/exp10/rt/node_modules/sym-pkg/index.mjs
import.meta.dirname  -> /private/tmp/mod209/exp10/rt/node_modules/sym-pkg
```

⇒ Bun 解析软链后取 **realpath**，`import.meta.url` 也是 realpath。这与 spike 的观察一致（`spike-219-electrobun/README.md:93-96`：`bun-preload.mjs` 按 `dirname(import.meta.url)` 找 `node_modules`，所以补丁文件必须放进 profile 目录、那 4 个被补丁包必须真拷贝）。**软链农场和 NODE_PATH 在这一点上完全等价**，都不会让 `import.meta.url` 指回 profile。

### I. 缓存

- Bun 解析结果按进程缓存；dsh 每次启动是新进程 ⇒ profile 插件更新后重启即生效，**没有跨进程陈旧缓存**。本轮所有实验里没有观察到 Bun 在 profile 目录或 `~/.bun` 写任何东西（H4 已核对清单未变）。
- `resolver-hooks.mjs` 自己的 `const cache = new Map()`（:14、:26、:34）是进程内缓存，语义随进程走，无风险。

### K. 实验 8 — 推荐组合的端到端三跑对照（`/tmp/mod209/exp13`，用**真实运行时树** + 合成 profile 插件）

profile 树里放一个 `@deepseek-ai/cosmokit@1.8.5` 的真副本（模拟今天 desktop profile 的实况），`fake-plugin` 依次 resolve 4 个裸说明符：

```
run 1  只有 NODE_PATH（碰撞项未处理）
cosmokit     <PROF>/@deepseek-ai/cosmokit/index.js      ← 旧副本遮蔽   ❌
schemastery  <RT>/node_modules/@deepseek-ai/schemastery/lib/index.cjs
dshBase      <RT>/node_modules/@deepseek-ai/dsh-base/lib/index.js
yaml         <RT>/node_modules/yaml/dist/index.js

run 2  reconcile（把碰撞项换成指向运行时树的软链） + NODE_PATH
cosmokit     <RT>/node_modules/@deepseek-ai/cosmokit/lib/index.js      ← 已改写     ✅
schemastery  <RT>/node_modules/@deepseek-ai/schemastery/lib/index.cjs
dshBase      <RT>/node_modules/@deepseek-ai/dsh-base/lib/index.js
yaml         <RT>/node_modules/yaml/dist/index.js

run 3  只有 reconcile，没有 NODE_PATH
error: Cannot find module '@deepseek-ai/schemastery' from '.../fake-plugin/index.mjs'   ❌
```

⇒ **两个机制缺一不可**：NODE_PATH 覆盖"profile 树里根本没有"（540 里的大多数），reconcile 覆盖"profile 树里有旧副本"（今天 desktop 8 个 / web 13 个版本不一致）。这是推荐方案的核心证据。

---

## 三、推荐实现路径

### 方案定名：**NODE_PATH 兜底 + profile 树 reconcile（合并只做碰撞项）**

三段职责：

#### 1) 构建期（打包 / 运行时下载，与今天一致，不变）
- 运行时树继续以 **hoisted 平铺真实目录** 形态落盘（`registry.rs:344` 的 `runtime_workspace_yaml`，`packages: []` / `nodeLinker: hoisted` / `storeDir` / `allowBuilds` 四项必须写齐，见 AGENTS.md 血泪坑 #10）。这条已经是硬约束，不动。
- 不再需要 `resolver-hooks.mjs` 与 `launcher.mjs` 的 `register/registerHooks` 分支：Bun 下它们分别是 no-op 和 undefined。**建议保留 Node 路径**（Tauri/外部 Node 仍用），只在 Bun 宿主分支里跳过，并让横幅明确打印走的是哪条路（避免"装上了但没用"的静默失败）。

#### 2) 运行时（每次 spawn dsh 前）
```
env.DSH_DESKTOP_BUNDLED_MODULES = <运行时树>            # 保留，reconcile 脚本用
env.NODE_PATH = "<运行时树>/node_modules"                # 新增；必须在 spawn 的 env 里，不能在脚本里设
args: --no-install                                        # 保留，挡 bun x 自动安装
```
- host 脚本（对齐 `spike-219-electrobun/host-official-style.mjs`）**不再尝试注册任何 loader 钩子**；`Bun.plugin` 也不用（对静态裸 import 无效，反而是维护负担）。
- `NODE_PATH` 只放运行时树一棵。实测多条目冒号分隔也支持，但没必要。

#### 3) reconcile（幂等、可重跑、O(碰撞数)）
在**三个触发点**跑同一个函数：
1. **启动前**（壳拉起 / 守护器自愈 / 切 profile）；
2. **profile 插件 add / update / remove 之后**（dsh plugin manager 返回后，或壳的 plugin 命令返回后）；
3. **运行时切换 / 下载新运行时之后**（`registry.rs` 装完新运行时后）。

算法（对齐 `resolver-hooks.mjs:22-38` 的判定）：
```
for (name, version) in readdir(profile/node_modules)   # 含 @scope/*
    if not exists(<运行时树>/<name>/package.json): 跳过        # 规则②：插件自有第三方依赖照常走默认解析
    r = realpath(profile/node_modules/<name>)
    if r 已指向 <运行时树>/<name>: 跳过（幂等）                  # 规则①：内置树赢
    否则：rename 到 .reconcile-bak-<ts>，在原位建指向 <运行时树>/<name> 的软链
          （下一步 dsh 启动成功后删 bak；启动失败则回滚）
```
- **不要全量物化 540 个包**：只处理与运行时树同名的条目（今天 desktop 26 / web 49），其余保持 profile 现状。这样 profile 的 `pnpm install` 行为、`link:` 依赖、原生包的 `import.meta.url` 都不受影响。
- **软链 vs 真拷贝**：软链即可（实验 H 证明 Bun 跟随 realpath）；只有像 spike 那样被 `--patch` 依赖 `dirname(import.meta.url)` 定位的包（node-pty、dsh-ptc-runtime-node、dsh-win32-process、@xterm/headless，见 spike README :93-96）需要真拷贝一份到 profile 目录 —— 这部分**保持 spike 现有做法不变**。
- 已知偏差（要写进 ADR）：`commander 8.3.0 vs 15.0.0`、`type-fest 0.13.1 vs 4.41.0`、`undici 7 vs 8`、`zod 4.1.8 vs 4.6.5` 这类大版本差会被强制拉到运行时树版本。**这与今天的 Node 行为一致**（钩子对所有裸说明符全局生效），所以不是新风险，但冒烟门禁必须覆盖到（见 E 与 Gate B4）。

#### 为什么不用其他候选

| 候选 | 否决理由 |
|---|---|
| `Bun.plugin.onResolve` | 永远看不到裸说明符；对 node_modules 内的静态 import 完全不触发（C4）。dsh 模块图的主体正是这一类。 |
| `Bun.plugin.onLoad` | 能进 node_modules，但只能换源码文本、不能改解析目标；且必须返回 `{contents, loader}`。改 dsh 包源码不可接受。 |
| 猴补丁 `Module._resolveFilename` | 只对 CJS 生效，对 ESM `import()` 无效（E3）。Bun 里 CJS/ESM 是两套解析器。 |
| `module.register` | 静默 no-op，连报错都没有（B）。 |
| `bunfig.toml` / `BUNFIG` | 只有 `preload` 有用且必须落在 cwd；不能设 `NODE_PATH`，`BUNFIG` 环境变量不生效（B）。 |
| `--conditions` / `--main-fields` | 只影响包内入口选择，不能改"去哪棵树找"。 |
| **纯 NODE_PATH** | 压不住 profile 里的旧副本（J2），且会产生"root 走 profile、subpath 走 RT"的分裂实例（T1）。 |
| **纯合并树（spike 现状）** | 能work，但要把 540 个包全铺进每个 profile 树；pnpm 会覆盖它自己 lockfile 拥有的同名条目（F），仍需 reconcile；铺全量还会让原生包的 `import.meta.url` 语义变复杂（H）。**它其实是推荐方案的超集**，推荐方案是它的最小充分子集。 |

### 可直接落地的最小改动清单（供拆票）
1. `desktop/src-tauri/src/runtime/builtin/launcher.mjs`：按 `process.versions.bun` 分叉 —— Bun 跳过 `register/registerHooks`，改设 `NODE_PATH`（同时 `launcher.mjs` 目前只设 `DSH_DESKTOP_BUNDLED_MODULES`，需要新增 NODE_PATH 的 spawn 侧注入，因为脚本内设无效，实验 G1/G1b）。
2. 新增 `desktop/src-tauri/src/runtime/reconcile.rs`（或并入 `registry.rs`）：上面的 reconcile 函数 + 三个触发点 + 单测（幂等 / 规则②不误伤 / bak 回滚）。
3. 冒烟脚本 `desktop/scripts/resolution-smoke.mjs`（用 bun 跑，`DSH_HOME` 指向隔离目录），断言见第四节。

---

## 四、冒烟门禁建议（最小断言集）

**Gate A — 解析面（不起 Host，秒级，可进 CI）**
- `A1`：`Bun.resolveSync` 对关键裸说明符全部命中**当前生效**的运行时树：`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-base`、`@deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`、`yaml`，外加一条子路径 `@deepseek-ai/dsh/lib/profile-boot.js`（验 `exports` 子路径）。
- `A2`：遍历 profile 树，对每个与运行时树同名的条目断言 `realpath` 落在运行时树下（reconcile 生效）。已知碰撞数 desktop=26 / web=49 作为基线，允许只增不减的断言：`skewed === 0`。
- `A3`：`--no-install` 下跑完，profile 树与 `~/.bun` 的清单快照前后一致（证明没触发安装、没留垃圾）。

**Gate B — 起 Host（对齐 spike 的 `HOST-READY`）**
- `B1`：`runProfile({ args:['--no-open','--host','127.0.0.1','--port','0'] })` 返回，`ctx.webServer.port > 0`。
- `B2`：`ctx.webServer.collectIndexInjections()` 非空（≥ 基线条数）。
- `B3`：`ctx.connection.authenticatedUrl(base)` → 壳侧 `fetch(url,{redirect:'manual'})` 必须拿到 `303 + set-cookie`。
- `B4`：关键插件激活（取 2~3 个已知插件名断言其 service 可取），专门压 `commander` / `cosmokit` / `schemastery` 这三个已知 skew 点。

**Gate C — 变更后仍成立（本 issue 的核心验收）**
- `C1`：隔离 profile 里装一个**新插件**（带一个自有第三方依赖 + 一个 `@deepseek-ai/*` peer）→ 重跑 reconcile → `A1 + A2 + B1 + B4` 全绿。
- `C2`：切到另一个运行时版本 → 重跑 reconcile → `A1 + A2` 断言全部指向**新**树（旧路径一个都不剩）。
- `C3`：reconcile 幂等性：连跑两次，第二次 changed==0。

---

## 五、未验证项

1. **没有真的在 Bun 1.4.0 下用隔离 `DSH_HOME` 起过完整 dsh Host**。K 节的端到端验证是"真实运行时树 + 合成 profile 插件"的解析层验证，不是完整 Host 起停。spike-219 已经证明完整 Host 能起（README 验收点 ⑤），但那是**合并树**下的；NODE_PATH + reconcile 组合下的完整 Host 起停、插件加载、worker 子上下文**未实测**。
2. **没有验证 dsh 的 plugin loader 是否走 Bun 的解析器**。如果 cordis-plugin-loader 自己按路径字符串找插件入口（而不是 `import()`），reconcile 的作用面要重新划。未读 loader 源码确认。
3. **pnpm 行为实验用的是 `file:` 本地依赖 + `--offline`**，没有用真实 registry 依赖重跑。"pnpm 覆盖 lockfile 拥有的同名条目 / 保留外来条目"这个结论在真实 registry 包上**大概率一致但未实证**。
4. **`--patch` 文件与软链的交互**未重测。spike 明确要求被 patch 的 4 个包在 profile 目录里真拷贝（H 节印证了 `import.meta.url` 取 realpath），reconcile 若把它们换成软链可能破坏 patch 定位。**需要在实施时把这 4 个包列入 reconcile 的"真拷贝白名单"**，但我没实测过软链形态下会怎样坏。
5. **Windows / Linux 未验证**（本机只有 macOS arm64）。`NODE_PATH` 在 Windows 是 `;` 分隔，这条必须分支处理，未测。
6. **`bun x` 自动安装面**：实测 `bun run <script>` 不触发、`bun x` 触发。没验证 dsh 或其插件内部是否会调 `bun x`。
7. **reconcile 与 pnpm 并发**：插件安装进行中触发 reconcile 会怎样（bak 目录与 pnpm 写同一路径）没测；建议加锁但未验证锁的粒度。
8. **`Bun.plugin` onResolve 的多次回调**（预扫 + 运行时各一遍，实测同模块触发 2~4 次）没有深究它的缓存语义；如果将来真要用它做部分改写，需要先弄清幂等性。
9. **profile 树里 `link:` 依赖指向 `<APP>/Contents/Resources/dsh/node_modules/...`（Electrobun 打包形态下的绝对路径）** 在换成运行时切换后是否还成立，未测；这条可能与「运行时被替换」直接相关。
10. **`@deepseek-ai/dsh` 根说明符解析失败是正常的**（其 `exports` 没有 `"."`），我没有确认壳里是否有任何地方依赖根导入；如果有，换 Bun 也一样会坏，与本次方案无关。