# Bun 替代 Node.js 启动 DSH 桌面应用——可行性与方案研究

> 研究日期：2026-10-10
> 参考项目：[dsh-bun-compat-patch](https://github.com/MonshinYu/dsh-bun-compat-patch)
> 研究范围：dsh-desktop-tauriapp 桌面壳使用 Bun runtime 替代 Node.js 启动 DSH 和渲染前端的可行性
> Bun 版本基准：v1.4.0（2026-08-20 发布） | Node.js 基准：v24（sidecar）/ v26（系统）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [当前架构分析：Node.js 在 DSH 桌面壳中的角色](#2-当前架构分析nodejs-在-dsh-桌面壳中的角色)
3. [参考项目 dsh-bun-compat-patch 分析](#3-参考项目-dsh-bun-compat-patch-分析)
4. [Bun 与 DSH 技术栈兼容性评估](#4-bun-与-dsh-技术栈兼容性评估)
5. [替代方案设计](#5-替代方案设计)
6. [风险评估](#6-风险评估)
7. [优劣势对比](#7-优劣势对比)
8. [实施路线图](#8-实施路线图)
9. [结论与建议](#9-结论与建议)

---

## 1. 执行摘要

**结论：当前不可行——存在致命阻塞项，但 Bun 在部分领域有显著优势，建议采用混合方案。**

参考项目 `dsh-bun-compat-patch` 已证明 DSH **核心 JS 运行时**可以在 Bun 1.3.14+ 上运行，仅需两处兼容性补丁。然而，深入调研发现 DSH 依赖的**多个原生插件（N-API）在 Bun 下确认不可用**，构成致命阻塞：

| 阻塞项 | 状态 | 影响 |
|--------|------|------|
| `node-pty` 不可用 | 🔴 崩溃/数据丢失 | DSH 终端功能完全依赖，不可妥协 |
| `koffi` 不可用 | 🔴 N-API panic | FFI 功能失效 |
| `ssh2` 不可用 | 🔴 buffer 损坏 | SSH 功能失效 |
| `module.register` 是 no-op | 🔴 静默失效 | ESM loader hooks 不工作 |
| `pnpm-workspace.yaml` 不支持 | 🟡 需迁移 | 包管理配置需重写 |

**Bun 的优势领域**（可独立采用，不涉及原生插件）：
- WebSocket 吞吐量 7x、启动速度 2.6-5.3x、内存占用 2-3x 更少、包安装 8x 更快

**推荐策略**：不替换 Node.js 运行时；在非运行时环节（包管理、构建、测试）探索 Bun 优势。

---

## 2. 当前架构分析：Node.js 在 DSH 桌面壳中的角色

### 2.1 整体架构

```
┌─────────────────────────────────────────────────┐
│              Tauri 2 桌面壳 (Rust)               │
│                                                   │
│  ┌─────────────┐    ┌──────────────────────────┐ │
│  │  WebView     │    │  dsh web 服务             │ │
│  │  (前端 GUI)  │◄──►│  (Node.js sidecar)        │ │
│  └─────────────┘    │                           │ │
│                      │  node dsh-launcher.mjs    │ │
│                      │    → runProfile()         │ │
│                      │    → HTTP Server :308x    │ │
│                      └──────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 2.2 Node.js Sidecar 机制

**配置位置**：`desktop/src-tauri/tauri.conf.json:68-70`
```json
"externalBin": [
  "binaries/dsh-node"
]
```

**Sidecar 定位**：`desktop/src-tauri/src/runtime/builtin.rs:113-133` (`find_builtin_node()`)
1. `DSH_NODE_BIN` 环境变量
2. 应用可执行文件旁的 `dsh-node` / `dsh-node.exe`
3. 系统 PATH 中的 `node` / `node.exe`（开发模式）

**Sidecar 准备**：`desktop/scripts/prepare-builtin-runtime.mjs`
- 从 `nodejs.org/dist` 下载 Node.js 二进制（当前 pin `latest-v24.x`）
- 重命名为 `dsh-node-<triple>[.exe]` 放入 `binaries/` 目录
- CI 按 target triple 打包进安装包

### 2.3 启动流程

**内置模式启动命令**（`desktop/src-tauri/src/process/lifecycle.rs`）：
```bash
# Unix
dsh-node --heapsnapshot-near-heap-limit=2 dsh-launcher.mjs <dshLibDir> <profile> <port> [--patch <path>]...

# Windows
dsh-node.exe --use-env-proxy --heapsnapshot-near-heap-limit=2 dsh-launcher.mjs <dshLibDir> <profile> <port> [--patch <path>]...
```

**启动器** (`desktop/src-tauri/src/runtime/builtin/launcher.mjs`)：
1. 安装模块解析钩子（`node:module` 的 `registerHooks` / `register`）
2. 用 `createRequire` 解析 `@deepseek-ai/dsh-app-boot`
3. 导入 `profile-boot-*.js`，调用 `runProfile()` 启动 DSH
4. `runProfile()` 内部启动 HTTP 服务器、WebSocket、Cordis 框架等

**模块解析钩子** (`desktop/src-tauri/src/runtime/builtin/resolver-hooks.mjs`)：
- 使用 `node:module` 的 ESM loader hooks（`resolve` 函数）
- 将裸说明符（bare specifiers）解析到内置 `node_modules`
- 防止 profile 本地旧版副本遮蔽内置版本
- **关键**：通过 `mod.register(hooksSpec)` 注册——此 API 在 Bun 下是 no-op

### 2.4 依赖管理

**包管理器**：pnpm（精确 pin `11.16.0`）

**pnpm 配置**（`desktop/src-tauri/src/runtime/registry.rs:runtime_workspace_yaml()`）：
```yaml
packages: []                    # 自声明 workspace root
nodeLinker: hoisted             # 平铺布局（与内置树同构）
storeDir: <独立 store 路径>     # #114 隔离
allowBuilds:                    # pnpm 11 构建脚本白名单
  node-pty: true
  protobufjs: true
  git-hosted: true
  cloudflared: true
  sharp: true
  ssh2: true
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': true
  koffi: true
```

**原生插件清单**（`desktop/src-tauri/src/runtime/builtin.rs:42` `PNPM_ALLOW_BUILDS`）：

| 插件 | 用途 | 类型 |
|------|------|------|
| `node-pty` | 伪终端（内嵌终端） | N-API native addon |
| `sharp` | 图像处理 | N-API native addon (libvips) |
| `koffi` | FFI（外部函数接口） | N-API native addon |
| `ssh2` | SSH 客户端 | N-API native addon (libssh2) |
| `protobufjs` | Protocol Buffers | 含 native 可选依赖 |
| `cloudflared` | 隧道二进制 | 外部二进制分发 |
| `git-hosted` | Git 仓库托管 | 纯 JS |
| `@deepseek-ai/dsh-subprocess-local` | 本地子进程 | DSH 内部包 |
| `@google/genai` | Google GenAI SDK | 纯 JS |

### 2.5 客户端构建

**构建工具**：esbuild（`scripts/build-client.mjs`）
```javascript
build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react-dom', '@deepseek-ai/cordis', ...]
})
```

### 2.6 Node.js 特有 API 使用

| API | 使用位置 | Bun 兼容性 |
|-----|---------|-----------|
| `node:module.createRequire` | `launcher.mjs:29` | ✅ 支持 |
| `node:module.register` | `launcher.mjs:32` | ❌ **no-op（静默失效）** |
| `node:module.registerHooks` | `launcher.mjs:31` | ❌ **缺失** |
| `node:module.stripTypeScriptTypes` | DSH worker-thread | ❌ 不支持（需补丁） |
| `node:worker_threads` | DSH code runtime | 🟡 部分支持 |
| `node:fs` / `node:path` / `node:url` | 多处 | ✅ 支持 |
| `node:child_process` | DSH 插件管理 | 🟡 部分支持 |
| ESM loader hooks (`resolve`) | `resolver-hooks.mjs` | ❌ **register 是 no-op** |
| `--heapsnapshot-near-heap-limit` | Node CLI flag | ❌ Bun 无此 flag |
| `--use-env-proxy` | Node CLI flag (Windows) | ❌ Bun 无此 flag |
| Cordis HMR (ESM loader hooks) | DSH profile-boot | ❌ 需禁用 |

---

## 3. 参考项目 dsh-bun-compat-patch 分析

### 3.1 项目概述

`dsh-bun-compat-patch` 是一个 Node API 兼容层，让 DSH 在 Bun 1.3.14+ 上运行，无需 Node 桥接。

**核心发现**：Bun 1.3.14 已覆盖 DSH 使用的**大部分纯 JS Node API**，仅有两处需要补丁。但该补丁**不解决原生插件兼容性**。

### 3.2 两处兼容性补丁

#### 补丁 1：`node:module.stripTypeScriptTypes`

**问题**：`dsh-code-runtime-worker-thread/lib/index.js` 导入 `node:module` 的 `stripTypeScriptTypes` 函数，Bun 的 `node:module` shim 不导出此函数。

**解决方案**（`src/node-module.ts`）：
```typescript
import { Transpiler } from "bun";
const transpiler = new Transpiler({ loader: "ts" });

export function stripTypeScriptTypes(code: string, options: { sourceUrl?: string } = {}): string {
  const stripped = transpiler.transformSync(code);
  return options.sourceUrl ? `${stripped}\n//# sourceURL=${options.sourceUrl}` : stripped;
}
```

**机制**：用 `Bun.Transpiler` 的 `transformSync` 语义等价地替代 `stripTypeScriptTypes`，保持同步调用契约。

#### 补丁 2：Cordis 服务端 HMR

**问题**：`dsh/lib/profile-boot-*.js` 中的 Cordis HMR 循环依赖 Node 内部 ESM loader hooks，Bun 不提供。

**解决方案**（`src/shadow.ts:patchHmrGuards()`）：
在 HMR 循环的 guard 表达式前添加环境变量门控：
```javascript
// 原始：
if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {

// 补丁后：
if (!process.env.DSH_BUN_COMPAT_DISABLE_HMR && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {
```

### 3.3 补丁机制

**In-place patching**（`src/shadow.ts`）：

1. `prepareInPlacePatch()`：读取目标文件 → 备份到 `$TMPDIR` → 重写 `from "node:module"` 为 `from "file:///path/to/node-module.js"` → 添加标记注释
2. `patchHmrGuards()`：遍历 `profile-boot-*.js` → 备份 → 添加 HMR 禁用 guard
3. `restorePatch()`：进程退出时从备份恢复原始文件

**安全保证**：
- 干净退出时自动恢复
- `SIGINT` / `SIGTERM` 转发并恢复
- `kill -9` 会留下脏状态（需重装 DSH）
- 二次运行检测标记注释，跳过已打补丁的文件

### 3.4 启动方式

```bash
bun --preload ./lib/preload.js ./node_modules/@deepseek-ai/dsh/lib/bin.js web --port 39881
```

**Preload 流程**（`src/preload.ts`）：
1. 检测 DSH 入口（`argv[1]` 以 `@deepseek-ai/dsh/lib/bin.js` 结尾）
2. 定位兼容层 lib 目录
3. 应用 in-place 补丁
4. `Bun.spawn()` 子进程（设置 `DSH_BUN_COMPAT_CHILD=1` 防递归）
5. 转发信号
6. 退出时恢复补丁

### 3.5 已验证兼容的 API

参考项目明确指出以下 API 在 Bun 1.3.14+ 已原生支持：

- `node:worker_threads`：`Worker`、`workerData`、`parentPort`、`resourceLimits`、`stdout`/`stderr`（注意：`eventLoopUtilization` 是 stub 返回 0）
- 无需 fork Node 进程
- 无需 `node` 二进制在 PATH 上
- 无需影子目录

### 3.6 参考项目的局限性

**关键**：`dsh-bun-compat-patch` 仅解决**纯 JS 层面**的兼容性（`stripTypeScriptTypes` + HMR guard）。它**不涉及**：
- 原生插件（node-pty、koffi、ssh2 等）的 N-API 兼容性
- ESM loader hooks（`module.register`）的功能性——仅禁用 HMR，不解决 resolver hooks 失效
- 桌面壳的 sidecar/shim/pnpm 等基础设施

---

## 4. Bun 与 DSH 技术栈兼容性评估

### 4.1 Node.js API 兼容性

> 来源：[Bun Node.js Compatibility](https://bun.com/docs/runtime/nodejs-compat) | [Bun 1.4 Blog](https://bun.com/blog/bun-v1.4)

Bun 1.4 新增 +1,517 个 Node.js 测试用例通过，`node:http`、`node:fs`、`node:cluster`、`node:timers`、`node:zlib`、`node:vm`、`node:stream` 通过 97%+ 测试。

| API | Bun 支持状态 | 来源 | 对 DSH 影响 |
|-----|-------------|------|------------|
| `node:worker_threads` | 🟡 部分实现 | Bun 1.4 blog | `resourceLimits` 已支持；`eventLoopUtilization` 是 stub 返回 0；`AsyncLocalStorage` 不跨 Worker 传播 |
| `node:module.createRequire` | ✅ 支持 | Bun 官方文档 | 可用 |
| `node:module.register` | ❌ **no-op** | Bun 官方文档 | **严重**：resolver-hooks.mjs 静默失效，模块解析回退默认 |
| `node:module.registerHooks` | ❌ **缺失** | Bun 官方文档 | 不可用 |
| `node:module.stripTypeScriptTypes` | ❌ 不支持 | dsh-bun-compat-patch | 需补丁（已有方案） |
| `node:fs` | ✅ 98% 通过 | Bun 官方文档 | 可用 |
| `node:path` | ✅ 完全实现 | Bun 官方文档 | 可用 |
| `node:url` | ✅ 完全实现 | Bun 官方文档 | 可用 |
| `node:os` | ✅ 完全实现 | Bun 官方文档 | 可用 |
| `node:child_process` | 🟡 部分实现 | Bun 官方文档 | IPC 不能发送 server sockets；`serialization: "advanced"` 仅 Bun↔Bun |
| `node:http` | ✅ 完全实现 | Bun 官方文档 | `keepAlive` 是 no-op |
| `node:crypto` | 🟡 部分实现 | Bun 官方文档 | 缺 ed448/x448/rsa-pss/dsa/dh 密钥类型 |
| ESM loader hooks | ❌ **不兼容** | Bun 官方文档 | `module.register()` 是 no-op；替代 `Bun.plugin()` API 不同 |
| `Bun.Transpiler` | ✅ 原生 API | Bun 官方文档 | 可替代 stripTypeScriptTypes |

### 4.2 原生插件（N-API）兼容性——致命阻塞

> 来源：[Bun Node-API 文档](https://bun.com/docs/runtime/node-api) | 各 GitHub issues

Bun 从头实现了 Node-API，可以 `require()` `.node` 文件。但实现不完整，**多个 DSH 关键依赖确认不可用**。

#### node-pty（伪终端）——🔴 不可用

- [node-pty#632](https://github.com/microsoft/node-pty/issues/632)：明确报告 "Does not work with bun"
- [oven-sh/bun#25822](https://github.com/oven-sh/bun/issues/25822)：PTY spawns but onData callback never fires——**open 状态**
- [oven-sh/bun#30454](https://github.com/oven-sh/bun/issues/30454)：Windows N-API crash with zigpty prebuild

**影响**：DSH 的内嵌终端功能（terminal_open/send/read 等）**完全依赖 node-pty**。这是不可妥协的致命阻塞。

#### koffi（FFI）——🔴 不可用

- [oven-sh/bun#39263](https://github.com/oven-sh/bun/issues/39263)：`napi: finalizer calling napi_delete_reference aborts with panic: napi_reference_unref` (koffi unusable)
- 在 Bun 1.3.14、1.3.13、1.3.9、1.2.23 上均复现

**影响**：FFI 功能完全失效。Bun 有自己的 `Bun.FFI` API 可作替代，但需重写所有 FFI 调用代码。

#### ssh2（SSH 客户端）——🔴 不可用

- [mscdex/ssh2#1416](https://github.com/mscdex/ssh2/issues/1416)：用户请求 Bun 支持，未解决
- [oven-sh/bun#13581](https://github.com/oven-sh/bun/issues/13581)：`buffer.utf8Write` 问题导致 SSH 公钥损坏，密钥交换失败

**影响**：SSH 相关功能失效。

#### sharp（图像处理）——🟡 不稳定

- [lovell/sharp#4283](https://github.com/lovell/sharp/issues/4283)：`bun build --compile` 不包含 sharp 原生二进制
- [oven-sh/bun#25635](https://github.com/oven-sh/bun/issues/25635)：`bun build --compile` fails on linux/arm64
- Bun 提供原生替代 `Bun.Image`：支持 JPEG/PNG/WebP/HEIC/AVIF 解码、缩放、旋转

**影响**：可能可运行（非 --compile 模式），但不稳定。可用 `Bun.Image` 替代部分功能。

#### 其他插件

| 插件 | 状态 | 来源 |
|------|------|------|
| `protobufjs` | 🟡 性能差 | [oven-sh/bun#16803](https://github.com/oven-sh/bun/issues/16803)：显著慢于 Node.js |
| `cloudflared` | 🟢 可能可用 | 外部二进制 spawn，非 N-API |
| `git-hosted` | 🟢 纯 JS | 无 N-API 依赖 |
| `@google/genai` | 🟡 可能可用 | 社区请求中，非官方支持 |

#### 原生插件兼容性总结

| 插件 | 状态 | 阻塞级别 |
|------|------|----------|
| **node-pty** | 🔴 不可用 | **致命** — DSH 终端功能完全依赖 |
| **koffi** | 🔴 不可用 | **致命** — FFI 功能不可用 |
| **ssh2** | 🔴 不可用 | **严重** — SSH 功能不可用 |
| sharp | 🟡 不稳定 | 中等 — 可用 Bun.Image 替代 |
| protobufjs | 🟡 性能差 | 低 — 功能可用但慢 |
| cloudflared | 🟢 可能可用 | 低 |
| @google/genai | 🟡 可能可用 | 低 |

### 4.3 包管理器兼容性

> 来源：[Bun Workspaces](https://bun.com/docs/pm/workspaces) | [Bun Isolated Installs](https://bun.com/docs/pm/isolated-installs)

| 方面 | pnpm (under Node) | bun install | 评估 |
|------|-------------------|-------------|------|
| workspace 配置 | ✅ `pnpm-workspace.yaml` | ❌ **不支持** `pnpm-workspace.yaml` | Bun 用 `package.json` 的 `"workspaces"` 字段 |
| nodeLinker: hoisted | ✅ | ✅ `bunfig.toml: linker = "hoisted"` | 需迁移配置格式 |
| 独立 store | ✅ `storeDir` | ⚠️ `install.globalStore` | 机制不同 |
| 构建脚本白名单 | ✅ `allowBuilds` | ✅ `trustedDependencies` in `package.json` | 配置格式不同 |
| 生命周期脚本 | ✅ | ✅ | 都支持 postinstall |
| 安装速度 | 基准 | 🚀 **8x 更快** vs pnpm | Bun 官方基准 |
| isolated installs | ✅ pnpm 默认 | ✅ `--linker isolated` | 类似 pnpm 的中央 store + symlinks |

**关键**：DSH 的 `pnpm-workspace.yaml` 四项配置（packages/nodeLinker/storeDir/allowBuilds）在 Bun 下全部需要迁移到 `package.json` workspaces + `bunfig.toml`。

**方案选择**：
- **方案 A**：保留 pnpm under Bun（pnpm 是纯 JS，可在 Bun 下运行）——最小改动
- **方案 B**：切换到 `bun install`——更快，但需迁移全部配置

### 4.4 构建工具兼容性

| 工具 | Bun 兼容性 | 说明 |
|------|-----------|------|
| esbuild | ✅ 可运行 | esbuild 是纯 JS/Go，Bun 可直接运行；也可迁移到 `bun build`（快 1.75x） |
| Vite | 🟡 有风险 | [oven-sh/bun#18347](https://github.com/oven-sh/bun/issues/18347)：dev server 启动问题（open）；Bun 1.4 改善 |
| TypeScript | ✅ 原生支持 | Bun 内置 TypeScript 转译，无需 tsc |

**客户端构建**（`scripts/build-client.mjs`）：esbuild 在 Bun 下可直接运行，无需修改。

### 4.5 WebSocket 兼容性——Bun 优势领域

> 来源：[Bun WebSockets](https://bun.com/docs/runtime/http/websockets)

**Bun 原生 WebSocket 支持卓越**：
- `Bun.serve()` 内置 WebSocket，基于 uWebSockets
- **7x 吞吐量**：Bun ~700,000 msg/s vs Node.js + ws ~100,000 msg/s（16 clients）
- 内置 Pub/Sub API、per-message compression、backpressure
- Bun 1.4 新增 `ws` 兼容层的 `'upgrade'` 和 `'unexpected-response'` 事件

**对 DSH 的影响**：DSH 使用 WebSocket 进行移动端通信、mux 网关等。**这是 Bun 的明确优势领域。**

### 4.6 Windows 支持

> 来源：[Bun Installation](https://bun.com/docs/installation) | [Bun 1.4 Blog](https://bun.com/blog/bun-v1.4)

- Windows x64 和 ARM64 均可用（Bun 1.1 起正式支持）
- Bun 1.4 Windows 启动速度：**15.5ms**（vs Node.js 26 的 40.1ms，2.6x 更快）
- Bun 1.4 Windows 峰值内存：**16.8MB**（vs Node.js 26 的 32.5MB）
- **风险**：[oven-sh/bun#30454](https://github.com/oven-sh/bun/issues/30454)：Windows N-API crash with zigpty prebuild——原生插件在 Windows 上更容易崩溃
- DSH 的 AGENTS.md 已记录"Windows 编译/产物只能靠 CI 把关"——引入 Bun 会增加更多 Windows 不确定性

### 4.7 性能优势——Bun 数据

> 来源：[Bun 1.4 Blog](https://bun.com/blog/bun-v1.4) | [tech-insider.org](https://tech-insider.org/bun-vs-node-2026)

| 指标 | Node.js | Bun 1.4 | 提升 |
|------|---------|---------|------|
| 冷启动 (Linux) | 27.2ms | **5.1ms** | 5.3x |
| 冷启动 (Windows) | 40.1ms | **15.5ms** | 2.6x |
| 峰值内存 (Linux hello.js) | 44.5MB | **14.6MB** | 3x 更少 |
| 峰值内存 (Windows hello.js) | 32.5MB | **16.8MB** | 1.9x 更少 |
| HTTP 服务器内存 | 107MB | **81MB** | 24% 更少 |
| WebSocket 吞吐量 | ~100K msg/s | **~700K msg/s** | 7x |
| 包安装 | pnpm 基准 | **8x 更快** | 8x |
| Bundler | esbuild 基准 | **1.75x 更快** | 1.75x |

**注意事项**：[tech-insider.org](https://tech-insider.org/bun-vs-node-2026) 指出 Bun 的 GC 对 72+ 小时长运行进程不够成熟；加入数据库和序列化后 HTTP 性能差距缩小到 ~3%。

---

## 5. 替代方案设计

### 5.1 方案 A：全面替换（当前不可行）

由于 node-pty、koffi、ssh2 确认不可用，**全面替换 Node.js 为 Bun 运行时当前不可行**。以下改造点仅作参考，待阻塞项解决后可启用。

#### 5.1.1 Sidecar 替换

**文件**：`desktop/src-tauri/tauri.conf.json`
```json
// 改前
"externalBin": ["binaries/dsh-node"]
// 改后
"externalBin": ["binaries/dsh-bun"]
```

**文件**：`desktop/scripts/prepare-builtin-runtime.mjs`
- 从 `github.com/oven-sh/bun/releases` 下载 Bun 二进制替代 Node.js

**文件**：`desktop/src-tauri/src/runtime/builtin.rs`
- `find_builtin_node()` → `find_builtin_bun()`
- sidecar 名从 `dsh-node` 改为 `dsh-bun`

#### 5.1.2 启动器适配

**文件**：`desktop/src-tauri/src/runtime/builtin/launcher.mjs`

关键修改：
1. **模块解析钩子**：`module.register()` 在 Bun 下是 no-op，需迁移到 `Bun.plugin()` API
2. **兼容补丁 preload**：集成 `dsh-bun-compat-patch`
3. **Node CLI flags 移除**：`--heapsnapshot-near-heap-limit`、`--use-env-proxy`

#### 5.1.3 其他改造点

- Shim 机制更新（`profiles.rs`、`registry.rs`）
- 依赖管理适配（保留 pnpm under Bun 或切换 bun install）
- Entitlements.plist 更新（Bun/JavaScriptCore JIT 豁免）
- `DshSource` 枚举扩展增加 `RuntimeKind`

### 5.2 方案 B：混合方案（推荐）

**不替换 Node.js 运行时**，在非运行时环节利用 Bun 优势：

#### 5.2.1 用 Bun 做包管理器

将 `pnpm install` 替换为 `bun install`：
- 安装速度 8x 更快
- 需迁移 `pnpm-workspace.yaml` → `package.json` workspaces + `bunfig.toml`
- **风险**：需验证所有原生插件的 postinstall 在 `bun install` 下正常工作
- **适用范围**：开发环境 + CI，不影响运行时

#### 5.2.2 用 Bun 做构建工具

将 `node scripts/build-client.mjs` 替换为 `bun scripts/build-client.mjs`：
- esbuild 在 Bun 下可直接运行
- 构建速度提升
- **适用范围**：客户端构建，不影响运行时

#### 5.2.3 用 Bun 做测试运行器

将测试运行器从 Node 切换到 Bun：
- `bun test` 比 vitest/node 更快
- **适用范围**：开发/CI 测试，不影响运行时

### 5.3 方案 C：双运行时支持（中期目标）

在桌面壳中同时支持 Node 和 Bun 运行时，用户可在设置中切换：

1. 扩展 `DshSource` 枚举，增加 `RuntimeKind`（Node / Bun）
2. 新增 `find_builtin_bun()` 函数
3. 修改 `prepare-builtin-runtime.mjs` 支持 `--runtime bun` 参数
4. 集成 `dsh-bun-compat-patch` 作为 preload
5. 设置 Tab 新增运行时选择

**前提条件**：node-pty 和 koffi 在 Bun 下可用（目前不可用）。

---

## 6. 风险评估

### 6.1 确认的致命阻塞项

| # | 阻塞项 | 严重性 | 证据 | 缓解可能 |
|---|--------|--------|------|---------|
| 1 | **node-pty 不可用** | 致命 | [node-pty#632](https://github.com/microsoft/node-pty/issues/632)、[bun#25822](https://github.com/oven-sh/bun/issues/25822) | 需 Bun 修复 N-API 或重写 node-pty |
| 2 | **koffi 不可用** | 致命 | [bun#39263](https://github.com/oven-sh/bun/issues/39263) | 需 Bun 修复 N-API 或迁移到 Bun.FFI |
| 3 | **ssh2 不可用** | 严重 | [ssh2#1416](https://github.com/mscdex/ssh2/issues/1416)、[bun#13581](https://github.com/oven-sh/bun/issues/13581) | 需 Bun 修复 buffer 处理 |
| 4 | **module.register 是 no-op** | 严重 | Bun 官方文档 | 需迁移到 Bun.plugin() API |
| 5 | **pnpm-workspace.yaml 不支持** | 中等 | Bun 官方文档 | 需迁移到 package.json workspaces |

### 6.2 其他风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Cordis HMR 禁用 | 开发模式热更新失效 | 生产无影响；开发回退手动刷新 |
| sharp 不稳定 | 图像处理可能失败 | 可用 `Bun.Image` 替代 |
| Bun Windows N-API 成熟度 | Windows 原生插件崩溃 | 保留 Node fallback |
| in-place patch 脏状态 | kill -9 后 DSH 文件残留补丁 | 启动时检测恢复 |
| Bun GC 长运行成熟度 | 72h+ 进程可能内存问题 | [tech-insider.org](https://tech-insider.org/bun-vs-node-2026) 报告 |

---

## 7. 优劣势对比

### 7.1 优势

```dsh-ui
{"title":"Bun 替代 Node.js 优势","gap":12,"items":[
{"type":"stat","label":"冷启动速度","value":"2.6-5.3x","delta":"↑ 快 2.6-5.3 倍"},
{"type":"stat","label":"内存占用","value":"2-3x 更少","delta":"↓ 降 50-67%"},
{"type":"stat","label":"WebSocket 吞吐","value":"7x","delta":"↑ 7 倍"},
{"type":"stat","label":"包安装速度","value":"8x","delta":"↑ vs pnpm"},
{"type":"callout","content":"Bun 单二进制运行时：原生支持 TypeScript、JSX、WebSocket、HTTP 服务器，减少外部依赖。","tone":"success","title":"架构简化"}
]}
```

### 7.2 劣势与阻塞

```dsh-ui
{"title":"Bun 替代 Node.js 劣势与阻塞","gap":12,"items":[
{"type":"callout","content":"node-pty 不可用（崩溃/数据丢失）：DSH 内嵌终端完全依赖此插件，这是不可妥协的致命阻塞。来源：node-pty#632、bun#25822。","tone":"error","title":"致命阻塞：node-pty"},
{"type":"callout","content":"koffi 不可用（N-API panic）：FFI 功能完全失效。来源：bun#39263，在 Bun 1.2-1.3 多版本复现。","tone":"error","title":"致命阻塞：koffi"},
{"type":"callout","content":"ssh2 不可用（buffer 损坏）：SSH 密钥交换失败。来源：ssh2#1416、bun#13581。","tone":"error","title":"严重阻塞：ssh2"},
{"type":"callout","content":"module.register 是 no-op：ESM loader hooks 静默失效，resolver-hooks.mjs 不工作。需迁移到 Bun.plugin() API。","tone":"error","title":"严重阻塞：ESM hooks"},
{"type":"callout","content":"Cordis HMR 需禁用：开发模式热更新失效。pnpm-workspace.yaml 不支持：需迁移配置。","tone":"warning","title":"其他限制"},
{"type":"callout","content":"Bun N-API 生态不如 Node.js 成熟，~2% npm 包不兼容，集中在原生插件。单一公司控制开发方向。","tone":"info","title":"生态风险"}
]}
```

### 7.3 综合对比

| 维度 | Node.js (当前) | Bun | 评价 |
|------|---------------|-----|------|
| 启动速度 | ★★☆ | ★★★★★ | Bun 大幅领先 |
| 内存效率 | ★★☆ | ★★★★ | Bun 领先 |
| 原生插件兼容 | ★★★★★ | ★☆☆☆ | **Node 绝对领先** |
| WebSocket 性能 | ★★☆ | ★★★★★ | Bun 大幅领先 |
| 开发体验 (HMR) | ★★★★ | ★★☆ | Node 领先 |
| 包管理速度 | ★★☆ | ★★★★★ | Bun 大幅领先 |
| Windows 稳定性 | ★★★★★ | ★★★☆ | Node 领先 |
| 社区生态 | ★★★★★ | ★★★☆ | Node 领先 |

---

## 8. 实施路线图

### 阶段 0：混合方案探索（当前可执行，1-2 周）

**目标**：在不影响运行时的前提下，利用 Bun 优势加速开发和构建。

1. **用 Bun 做包管理器**（开发环境）：
   - 迁移 `pnpm-workspace.yaml` → `package.json` workspaces + `bunfig.toml`
   - 验证 `bun install` 能正确安装所有原生插件（postinstall 在 Bun 下运行）
   - 仅影响开发/CI，不影响用户运行时
2. **用 Bun 做构建工具**：
   - `bun scripts/build-client.mjs` 替代 `node scripts/build-client.mjs`
   - 验证 esbuild 在 Bun 下产出一致
3. **用 Bun 做测试运行器**：
   - 评估 `bun test` 替代当前测试方案

### 阶段 1：监控 Bun N-API 进展（持续）

**目标**：跟踪 Bun 对关键原生插件的修复进展。

监控以下 GitHub issues：
- [oven-sh/bun#25822](https://github.com/oven-sh/bun/issues/25822)（node-pty onData 不触发）
- [oven-sh/bun#39263](https://github.com/oven-sh/bun/issues/39263)（koffi N-API panic）
- [oven-sh/bun#13581](https://github.com/oven-sh/bun/issues/13581)（ssh2 buffer 损坏）
- [node-pty#632](https://github.com/microsoft/node-pty/issues/632)（node-pty Bun 支持）

**决策门**：当 node-pty 和 koffi 在 Bun 下确认可用后，进入阶段 2。

### 阶段 2：双运行时支持（条件触发，2-3 周）

**前提**：node-pty 和 koffi 在 Bun 下可用。

1. 扩展 `DshSource` 枚举，增加 `RuntimeKind`（Node / Bun）
2. 新增 `find_builtin_bun()` 函数
3. 修改 `prepare-builtin-runtime.mjs` 支持 `--runtime bun` 参数
4. 将 `module.register()` 迁移到 `Bun.plugin()` API
5. 集成 `dsh-bun-compat-patch` 作为 preload
6. 更新 shim 机制
7. 设置 Tab 新增运行时选择（Node / Bun），默认仍为 Node

### 阶段 3：Bun 为默认（验证充分后，1-2 周）

1. 修改默认运行时为 Bun
2. 更新 CI 构建脚本，打包 Bun sidecar
3. 全面回归测试
4. **决策门**：用户验证通过后合入

---

## 9. 结论与建议

### 9.1 可行性判定

**当前不可行**——存在三个致命/严重阻塞项（node-pty、koffi、ssh2 确认不可用），且 `module.register` 是 no-op 导致 ESM loader hooks 失效。参考项目 `dsh-bun-compat-patch` 仅解决纯 JS 层面兼容性，不涉及原生插件。

### 9.2 阻塞项详情

| 阻塞项 | 状态 | 影响范围 |
|--------|------|---------|
| **node-pty** | 🔴 崩溃/数据丢失 | DSH 内嵌终端（核心功能） |
| **koffi** | 🔴 N-API panic | FFI 功能 |
| **ssh2** | 🔴 buffer 损坏 | SSH 功能 |
| **module.register** | ❌ no-op | 模块解析钩子（resolver-hooks.mjs） |
| **pnpm-workspace.yaml** | ❌ 不支持 | 包管理配置 |

### 9.3 建议策略

**推荐：混合方案（方案 B）**

1. **不替换 Node.js 运行时**——保持 DSH 主进程在 Node.js 上运行
2. **在非运行时环节采用 Bun**：
   - 包管理：`bun install` 替代 `pnpm install`（8x 更快）
   - 客户端构建：`bun scripts/build-client.mjs`（esbuild 在 Bun 下运行）
   - 测试运行：`bun test`（更快）
3. **持续监控 Bun N-API 修复进展**——当 node-pty 和 koffi 可用后重新评估

**理由**：
- 原生插件不兼容是硬阻塞，无法绕过
- Bun 在包管理、构建、WebSocket 等领域有明确优势，可独立采用
- 混合方案零风险：不影响用户运行时，仅改善开发/CI 效率
- 符合项目已有的「内置/外部」双模式架构理念

### 9.4 长期展望

如果 Bun 修复了 N-API 兼容性（特别是 node-pty 和 koffi），则：
- 可实施双运行时方案（方案 C），让用户选择
- Bun 的启动速度（5.3x）、内存效率（3x）、WebSocket 性能（7x）将带来显著体验提升
- 需将 `module.register()` 迁移到 `Bun.plugin()` API
- 需迁移 `pnpm-workspace.yaml` 到 `package.json` workspaces

### 9.5 如果原生插件修复后的 Plan B

一旦 node-pty 和 koffi 在 Bun 下可用：
- **双运行时**：用户在设置中切换 Node / Bun，默认 Node
- **渐进迁移**：验证充分后将 Bun 设为默认
- **全面迁移**：移除 Node sidecar，简化分发

---

## 附录 A：关键文件路径

| 文件 | 作用 | 改造类型 |
|------|------|---------|
| `desktop/src-tauri/tauri.conf.json` | Tauri 配置（externalBin） | 修改 |
| `desktop/src-tauri/src/runtime/builtin.rs` | 运行时来源解析 | 修改 |
| `desktop/src-tauri/src/runtime/builtin/launcher.mjs` | DSH 启动器 | 修改/新增 |
| `desktop/src-tauri/src/runtime/builtin/resolver-hooks.mjs` | 模块解析钩子 | 修改 |
| `desktop/src-tauri/src/process/lifecycle.rs` | 进程启动逻辑 | 修改 |
| `desktop/src-tauri/src/process/worker.rs` | 进程 worker | 修改 |
| `desktop/src-tauri/src/runtime/registry.rs` | 运行时仓库管理 | 修改 |
| `desktop/src-tauri/src/profiles.rs` | Shim 机制 | 修改 |
| `desktop/src-tauri/build.rs` | 构建脚本 | 可能修改 |
| `desktop/src-tauri/Entitlements.plist` | macOS 权限 | 修改 |
| `desktop/scripts/prepare-builtin-runtime.mjs` | 运行时准备脚本 | 修改 |
| `scripts/build-client.mjs` | 客户端构建 | 无需修改（esbuild 兼容 Bun） |

## 附录 B：参考项目源码结构

```
dsh-bun-compat-patch/
├── src/
│   ├── preload.ts      # Bun --preload 入口；编排补丁 + 子进程 spawn
│   ├── node-module.ts  # stripTypeScriptTypes 实现（基于 Bun.Transpiler）
│   ├── shadow.ts       # in-place 补丁 / 恢复 / HMR guard 辅助
│   └── diagnostic.ts   # 可选的错误树打印器
├── build.ts            # 打包 preload + 生成 node-module.js
├── package.json        # 依赖 @deepseek-ai/dsh ^0.1.1-rc.2
└── tsconfig.json       # 严格 TS 配置
```

## 附录 C：环境变量

| 变量 | 设置者 | 用途 |
|------|--------|------|
| `DSH_BUN_COMPAT_CHILD` | preload | 标记子进程，防递归补丁 |
| `DSH_BUN_COMPAT_DISABLE_HMR` | preload | 禁用 Cordis HMR 循环 |
| `DSH_BUN_COMPAT_LIB` | preload (可选) | 覆盖兼容层 lib 目录 |
| `DSH_BUN_COMPAT_DEBUG` | 用户 | 打印未捕获错误树 |
| `DSH_BUN_BIN` | 用户/壳 | Bun sidecar 路径覆盖 |

## 附录 D：关键 GitHub Issues 追踪

| Issue | 描述 | 状态 |
|-------|------|------|
| [node-pty#632](https://github.com/microsoft/node-pty/issues/632) | node-pty does not work with bun | — |
| [bun#25822](https://github.com/oven-sh/bun/issues/25822) | PTY onData callback never fires | open |
| [bun#30454](https://github.com/oven-sh/bun/issues/30454) | Windows N-API crash with zigpty | — |
| [bun#39263](https://github.com/oven-sh/bun/issues/39263) | koffi N-API panic | — |
| [ssh2#1416](https://github.com/mscdex/ssh2/issues/1416) | ssh2 Bun support request | — |
| [bun#13581](https://github.com/oven-sh/bun/issues/13581) | buffer.utf8Write SSH key corruption | — |
| [bun#18347](https://github.com/oven-sh/bun/issues/18347) | Vite dev server not starting | open |
| [bun#16803](https://github.com/oven-sh/bun/issues/16803) | protobufjs significantly slower | open |

## 附录 E：Bun 版本信息

- 当前稳定版：v1.4.0（2026-08-20 发布）
- Bun 1.4 从 Zig 重写为 Rust
- 2025 年底 Anthropic 收购 Bun，用于 Claude Code 核心基础设施
- MIT 许可证，开源
- Engines 要求：`bun >= 1.3.14`（dsh-bun-compat-patch），推荐 `>= 1.4.0`

---

*本研究报告基于 dsh-desktop-tauriapp 仓库代码分析、[dsh-bun-compat-patch](https://github.com/MonshinYu/dsh-bun-compat-patch) 项目研究、以及 Bun 官方文档和 GitHub issues 调研编写。*
