# 第四插件包（代码编辑器）接入 --patch 注入链路 · 复核报告

> 研究子代理产出（research skill 流程）。全部结论基于本仓库源码逐文件核对，
> 给出文件:行号与代码摘录作证据。复核时间以仓库当前 HEAD 为准
> （`ae73dab fix(mobile): 鸿蒙壳按 harmony-next 离线参考修正 ArkTS API 用法`）。
>
> 结论速览：接入第四包总共要动 **4 个文件、6 处必改点**（build.rs 数组/注释、
> lib.rs 注入清单字符串、lib.rs materialize 挂载、lib.rs spawn_dsh 两处 env、
> tauri.conf.json resources、插件包自身 package.json/cordis.patch.yml/client），
> 另发现一个**既有打包缺口**：mobile 两包未进 `bundle.resources`（见 §4.2）。
>
> **状态：历史快照（锚定 HEAD `ae73dab`）**——文中 `mobile/vendor/dsh-mobile-nav` 路径与
> `vendor.test.mjs`（1 例）**已不存在**：该上游包已改为 git 子模块 `mobile/dsh-mobile-nav`
> （包名 `dsh-web-mobile`，测试 `npm run test:core`，191 例，见仓库根 `.gitmodules` 与 `AGENTS.md`）。
> 下文结论仅代表当时（0.6.x）的仓库形态，引用路径前请先核对当前代码。

---

## 1. build.rs 内嵌（desktop/src-tauri/build.rs，全文件 68 行）

### 1.1 当前三包 staging 写法

- `build.rs:1-7` 开头注释明确三包：`dsh-desktop-tauriapp`（仓库根）、
  `dsh-mobile-access`（mobile/dsh-mobile-access）、`@dsh-external/dsh-mobile-nav`
  （mobile/vendor/dsh-mobile-nav）。
- `build.rs:25` `let dest = manifest.join("embedded");` —— 内嵌目标根目录
  `desktop/src-tauri/embedded/`（`desktop/.gitignore:25` 有 `embedded/`，不入库）。
- `build.rs:28-37` packages 数组是**定长元组数组**：

  ```rust
  let packages: [(&str, &str, &[&str], &[&str]); 3] = [
      ("dsh-desktop-tauriapp", ".", &["package.json", "index.js", "cordis.patch.yml", "README.md", "LICENSE"], &["lib"]),
      ("dsh-mobile-access", "mobile/dsh-mobile-access", &["package.json", "cordis.patch.yml", "README.md", "LICENSE"], &["lib", "client"]),
      (
          "@dsh-external/dsh-mobile-nav",
          "mobile/vendor/dsh-mobile-nav",
          &["package.json", "cordis.patch.yml", "README.md", "LICENSE"],
          &["lib"],
      ),
  ];
  ```

  四元组语义 = `(内嵌目录名/包引用名, 源相对仓库根路径, 需复制的文件列表, 需复制的子目录列表)`。
- `build.rs:39-67` 遍历：`pkg_dest = dest.join(name)`（`build.rs:40`）——**内嵌目标目录名 = 包名 name**；
  文件逐个 copy（`build.rs:47-54`），目录整目录 copy 但**只复制顶层条目**（`build.rs:55-65`，
  `read_dir` 后逐文件复制到 `ddest`），每项先 `println!("cargo:rerun-if-changed={src}")`
  （`build.rs:49` 文件、`build.rs:57` 目录）。
- 幂等：`build.rs:41` `remove_dir_all(&pkg_dest)` 先清后建。

### 1.2 加第四包的改动点

1. `build.rs:28` 数组长度 `[(&str,&str,&[&str],&[&str]); 3]` → `; 4]`，并追加一行元组；
2. `build.rs:1-7` 注释补第四包说明（纯文档，非必需）；
3. 内嵌目标目录名规则不变：**嵌入目录名 = 包 name 字段**（它同时是
   `materialize_pool_package` 的链接名与 inject.yml 的 `name`，三处必须一致，见 §2.2）。
   例：包名 `dsh-editor` → `embedded/dsh-editor/`；
4. files/dirs 列表按包内容填：host 半区源码目录（如 `lib`）+ client 半区目录
   （如 `client` 或 esbuild 产物所在目录）+ `package.json` + `cordis.patch.yml`
   + README/LICENSE（照抄 dsh-mobile-access 结构 `build.rs:30`）。

### 1.3 rerun-if-changed 处理

- 自动覆盖：`build.rs:49/57` 已对**每个文件与每个目录**输出 `cargo:rerun-if-changed`，
  新包随循环自动获得，无需额外改。
- 注意：**只对目录内的顶层条目 rerun**（`build.rs:62` 复制的是 `entry.file_name()`）；
  若编辑器包 client 侧是 esbuild 产物（如 `lib/client.js`），源码变更不会直接触发 cargo
  重建 —— 与仓库根包同一约定（AGENTS.md：「client 用 esbuild 产 lib/client.js」，
  build.rs 注记 `dsh-desktop-tauriapp` 的 lib 目录只含 `client.js`/`client.js.map`，
  embedded 实况核对一致），需先跑 `npm run build:client` 再 cargo build。

---

## 2. lib.rs 注入（desktop/src-tauri/src/lib.rs，2878 行）

### 2.1 desktop_plugin_patch_path（`lib.rs:1133-1150`）

- 位置：`app_data_dir()/desktop-plugin-inject.yml`（`lib.rs:1142-1143`）。
- 当前内容（`lib.rs:1144`）是**一个字符串常量**，含一条 `- insert:` + 三个 `- id/name` 条目：

  ```rust
  let content = "- insert:\n    - id: dsh-desktop-tauriapp\n      name: dsh-desktop-tauriapp\n    - id: dsh-mobile-access\n      name: dsh-mobile-access\n    - id: dsh-mobile-nav\n      name: @dsh-external/dsh-mobile-nav\n";
  ```

- 加第四行：在该字符串末尾追加 `\n    - id: dsh-editor\n      name: dsh-editor`。
- 幂等机制：`lib.rs:1145-1148` 读旧内容比对，`stale` 才重写 —— 字符串变了自动落盘。
- 格式与 `mobile/dsh-mobile-access/lib/inject.mjs:2-8` 的 `generateInjectionPatch`
  产出一致（`'    - id: ' + e.id + '\n      name: ' + e.name`），并有单测
  `test/inject.test.mjs:5-11` 锚定该格式 —— 新包行格式不可自创。

### 2.2 materialize_desktop_plugin / mobile_package_dir / materialize_pool_package

- `mobile_package_dir(app, name, rel)`（`lib.rs:1154-1175`）：
  - 优先 `resource_dir()/plugins/<name>` 内嵌副本（`lib.rs:1155-1160`）；
  - 回退：从 `current_exe` 向上 10 层找 `package.json.name == dsh-desktop-tauriapp`
    的仓库根，再 `join("mobile").join(rel)`（`lib.rs:1161-1174`）。
    **注意 rel 是相对 mobile/ 的路径**：mobile-access 传 `"dsh-mobile-access"`，
    nav 传 `"vendor/dsh-mobile-nav"`（`lib.rs:1218/1223`）。若编辑器放独立目录
    （非 mobile/ 下），此回退路径不适用，需要新参数化或等价函数（见 §5）。
- `materialize_pool_package(pool, link_name, dir)`（`lib.rs:1179-1206`）：
  - **link_name = 池内链接名**，unix 符号链接、windows 整包复制（`lib.rs:1192-1205`）；
  - 幂等：已链接且 target 相同则跳过（`lib.rs:1182-1187`）。
- `materialize_desktop_plugin`（`lib.rs:1210-1228`）目前**三段 `if let` 挂载**：
  `link_name` 分别 `dsh-desktop-tauriapp` / `dsh-mobile-access` / `@dsh-external/dsh-mobile-nav`
  —— **链接名与 inject.yml 的 name 必须一致**（否则 profile 池里解析不到 `name`）。
  加第四包的挂载点就在此函数内追加一段 `if let Some(dir) = ...`（照抄 1218-1222 结构）。
- 调用时机：`lib.rs:2500`（自拉起分支 `materialize_desktop_plugin(app.handle())`，
  紧跟 `strip_web_profile_plugin_bundle()` 迁移旧 bundle 注册，`lib.rs:2501`）。

### 2.3 spawn_dsh（unix `lib.rs:487-` / windows `lib.rs:705-`）env 注入

- `--patch` 参数：两处都是 `launcher_args.push("--patch"); push(desktop_plugin_patch_path(app))`
  （unix `lib.rs:505-506`，windows `lib.rs:728-729`），**且排在 --no-open/--host/--port 之前**
  （unix `lib.rs:514-520`、windows `lib.rs:738-744`）——对应 AGENTS.md 血泪坑 2。
- 环境变量注入块（**编辑器专属 env 应加在这里，两处对称**）：
  - unix：`lib.rs:521-529`
    ```rust
    cmd.args(&launcher_args)
        .env("PATH", dsh_runtime_path(&bin))
        .env("DSH_MOBILE_LANE_PORT", configured_lane_port().to_string())
        .env("DSH_MOBILE_ENABLED", "1")
        .env("DSH_DESKTOP_PORT", port.to_string());
    let cloudflared = configured_cloudflared_bin();
    if !cloudflared.is_empty() { cmd.env("DSH_CLOUDFLARED_BIN", cloudflared); }
    ```
  - windows：`lib.rs:745-752` 等价块。
  - 若编辑器要 LSP 端口 env（如 `DSH_EDITOR_LSP_PORT`），建议：
    (a) 仿 `configured_lane_port()`（`lib.rs:155-162`：env > settings.yaml > 默认值）加一个
    `configured_editor_lsp_port()`；(b) 在上面两个 env 块各加一行
    `.env("DSH_EDITOR_LSP_PORT", ...)`。host 半区经 `process.env` 读取
    （样板：`mobile/dsh-mobile-access/lib/index.mjs:228-233` 读
    `DSH_MOBILE_ENABLED / DSH_MOBILE_LANE_PORT / DSH_DESKTOP_PORT`）。
  - client 半区读取方式：mobile-access 是 client 读 `globalThis.__DSH_MOBILE_LANE_PORT__`
    （`client/client.js:18`，缺省 3091）；仓库内**唯一**引用该全局变量的地方就是这一行
    （全仓 grep 命中 1 处），即该全局由 host 侧注入脚本提供（`lib/proxy.mjs:8-11`
    的 `desktopEnvPatchScript` 只打 URL 参数，不设该全局）——编辑器如需类似端口传递，
    建议由 host 半区注入同构的全局或直接复用 `__DSH_*` 约定，并在注入脚本中写死。

---

## 3. 插件包自身形态（host+client 双半区样板）

### 3.1 dsh-mobile-access/package.json（39 行，双半区包样板）

关键字段（逐条核对）：

| 字段 | 值 | 行号 | 说明 |
|---|---|---|---|
| `type` | `module` | 5 | ESM |
| `main` | `lib/index.mjs` | 6 | host 半区入口（含 `export function apply(ctx)`） |
| `exports["."]` | `{default: "./lib/index.mjs"}` | 7-10 | host 读取 |
| `exports["./client"]` | `{default: "./client/client.js"}` | 11-13 | client 半区入口 |
| `exports["./package.json"]` | `./package.json` | 14 | |
| `files` | `["lib","client","cordis.patch.yml"]` | 16-20 | 发布物（= build.rs files/dirs 交集） |
| `dsh.bundle.patch` | `"./cordis.patch.yml"` | 21-24 | --patch 清单来源 |
| `dsh.client` | `{platform:"web", inject:["@deepseek-ai/dsh-client-runtime"]}` | 25-30 | client 半区装载声明 |
| `scripts.test` | `node --test test/*.test.mjs` | 32-34 | node 单测（18 例） |
| `engines.node` | `>=22` | 35-37 | |

> 仓库根包 `package.json:40-51` 的 dsh.client 多注入 `@deepseek-ai/dsh-client-ui-theme`
> （桌面 client 依赖 React 类），dsh-mobile-access 纯 DOM 不依赖 —— 编辑器若用 Monaco +
> React 集成，可参考根包声明（`package.json:40-51`）+ `src/client/index.ts:12-17` 的
> `inject: ['slots','sessions','theme','workspaces']`。

### 3.2 client 半区 slots 注入样板（client/client.js:1-16）

```js
export function apply(ctx) {
  const slots = ctx?.slots;
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    ctx?.logger?.warn?.('dsh-mobile-access: slots 服务不可用，跳过设置入口');
    return;
  }
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'dsh-mobile-access',
    order: 20,
  }, MobileAccessPanel));
}
```

- 关键：`apply(ctx)` 握手 + `slots.inject('settings.section', ...)`
  （`client.js:11`）+ `slots.register({name, id, order}, Panel)`（`client.js:12-15`）。
- 面板 = 普通函数返回 DOM（`client.js:38-179`），无 React 依赖；样式走 dsh 主题
  CSS 变量（`client.js:43-53`，`--dsw-alias-*`，对应 AGENTS.md 血泪坑 8 的"稳定标记"原则）。
- 编辑器若注册进 better-sidebar 右侧栏（仓库根 CONTEXT.md 已定义该方向），
  slot 目标会不同（可能是布局类 slot），但**注入协议（ctx.slots.inject/register）同构**。

### 3.3 单测怎么跑

- 各包目录 `npm test`：
  - `mobile/dsh-mobile-access`：`node --test test/*.test.mjs`（5 文件 18 例）：
    inject 1 + links 3 + pairing 3 + proxy 5 + service 6 = **18**（与 AGENTS.md 一致）。
  - `mobile/shell-web`：`node --test test/*.test.mjs`（`lib.test.mjs` 3 例）。
  - `mobile/expo-app`：`vitest run`（`src/lib/pair.test.ts` 7 例）。
  - `mobile/vendor/dsh-mobile-nav`：无 `test` 脚本，只有 `test:core`
    `node --test tests/reconciler-core.test.ts`（package.json:32，**该路径实际不存在**）；
    实际验收用仓库根的 `vendor.test.mjs`（1 例，`mobile/vendor/dsh-mobile-nav/vendor.test.mjs`）。
  - 新包建议照抄 dsh-mobile-access 的 `scripts.test` 结构。

---

## 4. 验收与风险

### 4.1 cargo 覆盖与 node 测试分布

- `cargo check`：快速编译检查（AGENTS.md 常用命令）。
- `cargo test`：10 例，全部在 `desktop/src-tauri/src/lib.rs` 两个测试模块：
  `unit_tests`（`lib.rs:2762-2841`：version_key 2、random_token、DshState 默认值、
  pre_zoom_geom、SpawnError Display）+ `tests`（`lib.rs:2844-2877`：legacy_desktop_block 2、
  DesktopSettings serde roundtrip）。**未覆盖**注入链路的集成行为
  （inject.yml 内容与 materialize 不在单测内）。
- node 侧与注入链路相关的只有 `test/inject.test.mjs`（generateInjectionPatch 格式锚定）。

### 4.2 既有打包缺口（新增才发现，需拍板）

- `desktop/src-tauri/tauri.conf.json:70-72` `bundle.resources` 只映射一个包：
  ```json
  "resources": { "embedded/dsh-desktop-tauriapp": "plugins/dsh-desktop-tauriapp/" }
  ```
- schema 确认 `resources` 支持数组（glob，保留目录结构）或 map（源→目标）
  （`@tauri-apps/cli@2.11.4` config.schema.json `definitions.BundleConfig.properties.resources`）。
- 实况核对：`target/release/bundle/macos/.../Contents/Resources/plugins/` 下**只有
  dsh-desktop-tauriapp**；`embedded/` 下虽有三个包，但 mobile 两包**不会**被打进 .app。
- 后果：打包版 .app 里 `mobile_package_dir` 的 embedded 分支（`lib.rs:1155-1160`）取不到
  mobile 包，回退到"向上找仓库根"（`lib.rs:1161-1174`）在安装目录下也找不到 → **发布版
  不挂载 mobile 两包**（开发/仓库内运行才工作）。若这是既定取舍无需改；**若第四包要在
  发布版生效，必须给 tauri.conf.json resources 加一行**（且建议顺手补上 mobile 两包）。

### 4.3 acceptance.sh 是否要动

- `desktop/scripts/acceptance.sh` 三条路径（复用 A / 拉起回收 B / 受限 PATH C）只检查
  进程与端口回收、日志关键行（`acceptance.sh:32` grep `已导航到|正在停止 dsh|复用|拖拽区`），
  **不校验注入清单内容** → 加第四包不必改 acceptance.sh（Windows 对应 acceptance.ps1 同理）。
- 可选增强：追加一步断言 `desktop-plugin-inject.yml` 含四包行、或检查共享池
  `$DSH_HOME/profiles/node_modules/dsh-editor` 链接存在。

### 4.4 已知坑（AGENTS.md 血泪坑）对新包的影响

1. settings.yaml 键名：编辑器设置持久化必须用顶层 `dsh-desktop-tauriapp:` 键
   （AGENTS.md 血泪坑 1；`lib.rs:2844+` 的 DesktopSettings serde 结构当前不含编辑器字段，
   若加字段注意 serde 默认与 roundtrip 测试 `lib.rs:2861-2877`）。
2. `--patch` 顺序：新包不新增 spawn 参数行，只要保持现有顺序即无影响；
   若用 `DSH_DESKTOP_EXTRA_PATCH` 调试 overlay（unix `lib.rs:507-512`、windows
   `lib.rs:731-736`），同样必须在 --no-open 之前。
3. 单实例约束：编辑器 host 半区（LSP 服务）跑在 dsh 进程内，随 lane 机制自然符合
   "同 profile 单实例"；若 LSP 另起子进程监听端口，注意随 ctx dispose 回收
   （样板：`lib/index.mjs:264-268` 的 `ctx.on('dispose', ...)`）。
4. 远程页面 IPC：编辑器若暴露 Tauri 命令，需走
   generate_handler + permissions/app-commands.toml + capabilities
   （default/pet/remote-desktop 按需，AGENTS.md 三步）；但 LSP 桥若全在 dsh 进程内
   （与 mobile-access 同模式），则**不需要** Tauri 命令，也无 ACL 负担。
5. 注入样式稳定标记（血泪坑 8）：编辑器 UI 沿用 `--dsw-alias-*` 或 data-/role 标记。

---

## 5. 结论：加第四包的完整改动清单（文件级）

假设编辑器包名 `dsh-editor`、目录 `mobile/dsh-editor/`（可复用现有 mobile_package_dir
回退路径；若放独立目录则需等价调整，见标注）。

| # | 文件 | 改动 | 必须/可选 |
|---|---|---|---|
| 1 | 新包 `mobile/dsh-editor/package.json` | name=dsh-editor、type=module、main=host 入口、exports `./client`、files、`dsh.bundle.patch` → `./cordis.patch.yml`、`dsh.client {platform:web,inject:[@deepseek-ai/dsh-client-runtime]}`、scripts.test | **必须** |
| 2 | 新包 `mobile/dsh-editor/cordis.patch.yml` | `- insert: - id: dsh-editor, name: dsh-editor`（格式对齐 `inject.mjs`/`build.rs` 嵌入名/池链接名） | **必须** |
| 3 | 新包 host 入口（如 `lib/index.mjs`） | `export function apply(ctx)`（LSP 服务启动 + `ctx.on('dispose')` 回收；env 读 `process.env.DSH_EDITOR_*`） | **必须** |
| 4 | 新包 client 半区（如 `client/client.js`） | `apply(ctx)` + slots 注入（settings.section 或 better-sidebar 布局 slot） | **必须** |
| 5 | `desktop/src-tauri/build.rs` | `:28` 数组改 `; 4]` 并追加元组（name=dsh-editor、rel=mobile/dsh-editor、files=package.json/cordis.patch.yml/README/LICENSE、dirs=lib/client）；`rerun-if-changed` 自动覆盖；`embedded/` 为 gitignore 无需管 | **必须** |
| 6 | `desktop/src-tauri/src/lib.rs` | ① `:1144` 注入清单字符串追加 `dsh-editor` 行；② `materialize_desktop_plugin`（`:1210-1228`）追加一段 `mobile_package_dir(app,"dsh-editor","dsh-editor")` + `materialize_pool_package(pool,"dsh-editor",...)`（链接名=inject 名=嵌入名）；③ 若放非 mobile/ 目录需把 `mobile_package_dir` 的 rel 语义泛化（可选重构） | **必须**（①②）；可选（③） |
| 7 | `desktop/src-tauri/src/lib.rs` spawn_dsh env | unix `:521-529` 与 windows `:745-752` env 块各加编辑器专属 env（如 `DSH_EDITOR_LSP_PORT`），并新增 `configured_editor_lsp_port()`（仿 `:155-162`） | 可选（若 host 半区要端口） |
| 8 | `desktop/src-tauri/tauri.conf.json` | `:70-72` resources 加 `"embedded/dsh-editor": "plugins/dsh-editor/"`（及建议补 mobile 两包） | **必须**（发布版生效）；可选（仅开发） |
| 9 | 新包 `test/*.test.mjs` | node --test 单测（host 逻辑可纯 Node 测，仿 mobile-access 18 例结构） | 必须（AGENTS.md 约定） |
| 10 | `desktop/scripts/acceptance.sh` / `.ps1` | 不改；可选加 inject.yml/池链接断言 | 可选 |
| 11 | 仓库根 `CONTEXT.md` | 已描述编辑器插件方向（better-sidebar 右侧栏 + LSP），可补"装配接线"条目 | 可选 |
| 12 | AGENTS.md | `:71-72` 三包链路说明改四包；`文档目录结构` 增补编辑器目录 | 可选（文档一致性） |

### 一致性约束（易错点）

`inject.yml 的 name` == `materialize_pool_package 的 link_name` == `build.rs 的 name`
== `package.json 的 name`，四处必须一字不差（scoped 包如 `@dsh-external/...` 也按全名）。

---

## 附：证据文件索引

- `desktop/src-tauri/build.rs`（68 行）— §1
- `desktop/src-tauri/src/lib.rs`（2878 行，关键段 487-564 / 700-759 / 1085-1284 / 2494-2519 / 2758-2877）— §2、§4.1
- `desktop/src-tauri/tauri.conf.json`（74 行，resources 在 70-72）— §4.2
- `mobile/dsh-mobile-access/package.json`（39 行）— §3.1
- `mobile/dsh-mobile-access/client/client.js`（179 行）— §3.2
- `mobile/dsh-mobile-access/lib/index.mjs`（269 行，apply 在 228-269）— §2.3、§3.3
- `mobile/dsh-mobile-access/lib/inject.mjs`（8 行）— §2.1
- `mobile/dsh-mobile-access/lib/proxy.mjs`（117 行）— §2.3
- `mobile/vendor/dsh-mobile-nav/package.json`（65 行）— §3.3
- `desktop/scripts/acceptance.sh`（66 行）— §4.3
- `AGENTS.md`（血泪坑 1-8）— §4.4
- 仓库根 `CONTEXT.md`（untracked，编辑器插件/LSP 运行时定义）— §3.2、§5