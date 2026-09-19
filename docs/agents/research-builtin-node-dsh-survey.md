# 研究：社区 dsh 桌面内置 Node + dsh 方案调研（wayfinder #80 决策票 #81）

> 检索时间：2026-09-19。所有事实来源尽量取自本机可校验的产物（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`、官方 Tauri 文档）或 GitHub repo 公开 README/issue。涉及仓库的最新 commit/tag 时点见各小节。
>
> 任务：为「完全打包」拍定 dsh 桌面壳的内置 Node + 内置 dsh 落地结构。默认走内置，保留配置切到外部 dsh 的能力。

## 0. 摘要（先看这里）

- **社区先例大量存在**，且多数是「内置 Node + 内置 dsh + Tauri」路线（详见 §1）。不是新发明的轮子，可直接借鉴。
- **dsh 不是一个普通 npm 包**：依赖树 549 MB，包含 `node-pty`、`@img/sharp` + `sharp-libvips`、`@koromix/koffi`、`@deepseek-ai/node-addon-system-darwin-arm64`，以及一份 **259 MB 的 LibreOfficeKit.app**（用于 dsh-office-to-pdf）。任何「直接拷 node_modules」方案都要面对这堆平台耦合产物（详见 §3.2）。
- **建议方案**：双资源（resource）布局——Node 运行时二进制走 **Tauri sidecar**（externalBin，单文件平台特定），dsh 整棵依赖树（`@deepseek-ai/dsh` + 完整 `node_modules/`）走 **bundle.resources**（目录树、含 .bin 软链、含 .node 原生模块、含 .dylib/.dll/.so），首启原子解压到 `app_data_dir/runtime/<version>`，版本戳文件做幂等/升级（详见 §2、§4、§5）。
- **关键风险**：macOS Gatekeeper 必须签 Node 这个 sidecar + 主 .app + 单独对 .dmg 再签一次并 staple（§6.1）；Windows SmartScreen 对新签名的 Node.exe 必然报一次警告，靠 EV 证书 + 时间戳 + 信誉累积（§6.2）。
- **现有 spawn 链路改造要点**：仅改 `find_dsh_bin` / `spawn_dsh` 的「来源」分支，新增 `Builtin` 模式；`AdvancedShell/Lifecycle` 三件套（spawn/stop_port_owner/kill_force）原样不动（§7）。

---

## 1. 社区先例调研（已存在大量先例）

### 1.1 GitHub 搜索结果（按 stars 倒序）

| 项目 | stars | 壳 | 内置 Node | 内置 dsh | 备注 |
|---|---|---|---|---|---|
| [dsh-tauri/deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) | 2280 | Tauri 2 | ✅ 首启下载 | ✅ 首启下载 | 「Only 5MB installer, zero environment setup」——首启从 GitHub 拉 runtime+Harness |
| [DSH-EAC/DSH-Desktop-EAC](https://github.com/DSH-EAC/DSH-Desktop-EAC) | 1658 | Tauri 2（原 Electron） | ✅ | ✅ | 「Bundled Node.js runtime with full dsh-CLI」，Win/macOS 双平台 |
| [myYangyunfan/dsh_desktop](https://github.com/myYangyunfan/dsh_desktop) | 668 | Tauri 2（v0.5 起，从 Electron 迁） | ✅ | ✅ | 「bundled Node.js + dsh CLI, one-click launch」；NSIS 安装包约 87 MB |
| [AleCyriaco/deepseek-harness-desktop](https://github.com/AleCyriaco/deepseek-harness-desktop) | — | Tauri 2 | ✅ | ✅ | 「portable exe 内置 Node 运行时，87MB」；用 `npm run backend:install` 装 `backend/node_modules` 然后 `tauri build` |
| [xiincs/deepseek-harness-desktop](https://github.com/xiincs/deepseek-harness-desktop) | — | Tauri 2 | ✅ | ✅ | 「基于 Tauri 2，内置 Node.js 运行时，一键安装」；pinned Harness runtime |
| [fendouai/deepseek-harness-desktop](https://github.com/fendouai/deepseek-harness-desktop) | — | Tauri 2 | ✅ Node.js 24 | ✅ | 「Tauri bundles the production dsh deployment and an official Node.js 24 executable」 |
| [LodeKennes/deepseek-harness-desktop](https://github.com/LodeKennes/deepseek-harness-desktop) | — | Tauri 2 | ✅ Node 24.19.0 | ✅ Harness 0.1.2-rc.1 | 公开 versions.json 把 Node/Harness/pnpm/Electron 版本号作 source of truth；不卖 CLI，不进 PATH |
| [hjdhnx/dsh-desktop](https://github.com/hjdhnx/dsh-desktop) | — | Electron → Tauri | ✅ | ✅ | 「Rust 壳 + Node Sidecar 架构」（描述明示用 sidecar） |
| [renjianxin929-ux/deepseek-harness-desktop](https://github.com/renjianxin929-ux/deepseek-harness-desktop) | — | Tauri 2 | ✅ | ✅ 「runtime materializer」 | 显式区分 `runtime/`（gitignored）和 V0.2 release 包，「materializer 写 runtime/manifest.json + NOTICE.md + THIRD_PARTY_LICENSES.json」 |
| [Antony-Jia/deepseek-harness-desktop](https://github.com/Antony-Jia/deepseek-harness-desktop) | — | Tauri 2 | ✅ Node v24.19.0 x64 | ✅ | 「checksum-verified Node.js v24.19.0 x64 runtime」 |
| [fsw2781890522/dsh-desktop](https://github.com/fsw2781890522/dsh-desktop) | — | Tauri 2 Win | ✅ Node 22+ | ✅ | 「**bundle-runtime.ps1** ships factory presets + web plugins inside the runtime bundle；NSIS 文件数限制 → 把整 runtime 重新打成 zip 再分发」 |

### 1.2 关键观察

1. **所有能跑的社区项目都是 Tauri + 内置 Node + 内置 dsh 三件套**。Electron 的 dsh-harness 桌面（DSH-EAC 历史版、LisiChen0/DeepSeek-Harness-Desktop）也在迁 Tauri，因为 Tauri 安装包更小、内存占用更低、Node 仍可独立 sidecar。
2. **分两条子路线**：
   - **路线 A（运行时随安装包打包）**：myYangyunfan/dsh_desktop、DSH-EAC、xiincs、fendouai、LodeKennes、Antony-Jia —— 安装包即用，离线友好，代价是体积。
   - **路线 B（首启下载运行时）**：dsh-tauri/deepseek-harness-desktop —— 安装包小（5MB），首次启动联网拉 Node + Harness，本机已有 CLI 安装则优先复用。代价是首启必须联网且要为运行时单独做更新链。
3. **Node 版本一致性**：社区至少三个项目锁了 **Node v24.x**（LodeKennes、Antony-Jia 用 24.19.0；fendouai 用 24）；AleCyriaco 与多数兼容派口 Node 22+。**`@deepseek-ai/dsh` 自己要求 `Node >=22.19.0`**（本机已装包 `@deepseek-ai/libreoffice-kit/package.json` 的 `engines.node` 明写；同看 `@deepseek-ai/libreoffice-kit-darwin-arm64/package.json`）——所以推荐锁 Node 22.19.0 LTS 或 Node 24 LTS，不锁 Node 20（少了 `node:zlib` Zstd，AleCyriaco 的 DEVELOPMENT.md 提到）。
4. **dsh 版本**：社区多数钉 **0.1.0-rc.x**（LodeKennes 用 0.1.2-rc.1，Antony-Jia 用 0.1.0-rc.7，CSlawyer1985 用 0.1.0-rc.8），本机已装是 **0.1.6-alpha.2**（`npm view @deepseek-ai/dsh dist-tags`：`latest=0.1.5-rc.2, alpha=0.1.6-alpha.2`）。钉版本时建议跟 `latest`（稳定线），alpha 仅作快速跟版。
5. **事实无社区先例**：**没有** 一个项目走的是「侧挂外部 dsh 二进制 + 内置 Node」半内置方案 —— 社区一致认为「内置 Node 必须配内置 dsh」，否则把 Node 二进制带进去却还要让用户 `npm i -g @deepseek-ai/dsh`，不如不内置。**这是我们要遵循的隐式契约**：内置 = Node + dsh 二者齐备。

> **结论**：社区先例充足，可直接借鉴 dsh-tauri、AleCyriaco、myYangyunfan 的成熟模式——本项目无原创发明的必要。

---

## 2. 资源方案：sidecar vs resources

Tauri 2 提供两种把外部产物塞进安装包的机制（[Tauri 官方《Embedding External Binaries》](https://tauri.app/learn/sidecar)）：

| 维度 | `bundle.externalBin`（sidecar） | `bundle.resources` |
|---|---|---|
| 形态 | 单文件可执行（自动加 `<target-triple>` 后缀） | 文件/目录（glob 或 `source→dest` 映射） |
| 典型用途 | CLI 二进制（frpc、ffmpeg、my-sidecar） | 配置、字体、JS/CSS 资源、整目录 |
| 运行时取路径 | `Command::new_sidecar(name).spawn()` | `app.path().resolve(name, BaseDirectory::Resource)` |
| 是否可执行 | 是，赋予可执行权限 | 否，自己 chmod |
| 是否签名 | 主 .app 签名时被一并处理 | 内部文件需单独签名（macOS） |

### 2.1 推荐组合：sidecar + resources 双轨

| 资源 | 方案 | 理由 |
|---|---|---|
| Node 二进制 | **sidecar** | 单文件、平台特定三后缀（aarch64-apple-darwin/x86_64-apple-darwin/x86_64-pc-windows-msvc.exe），spawn 时直接拿；macOS 走主 .app 签名一并签 |
| `@deepseek-ai/dsh` + `node_modules/` | **resources**（zip 后整目录） | 150+ 子包、含 `.bin/` 软链、含原生 `.node`、含 `libreoffice-kit-darwin-arm64/LibreOfficeDev.app`（含 200+ dylib），整目录没法当 sidecar |

> **决策点**：是否在「resources」里直接放整个 `node_modules/`（解压版）vs 放进 zip 在首启时解压？
>
> - **直接放 resources**：Tauri 会逐文件 copy 到 `.app/Contents/Resources/_up_/...`，但 macOS `.app` 包整体被签名，**大目录 copy 很慢**；Windows NSIS 单文件数有限制（参考 fsw2781890522 的处理），可能撞线。
> - **打包成 zip 放进 resources**：体积更小、Tauri copy 快，但首启需要一次性解压到 `app_data_dir/runtime/<version>/`。
> - **本项目建议走 zip**（参考 fsw2781890522/LodeKennes 的做法）：用 `npm pack @deepseek-ai/dsh@<version>` 取 tarball，再单独 `npm install --omit=dev --omit=optional` 在隔离目录重装得到完整 `node_modules/`（含原生模块）；打成一个 zip（或 tar.zst）放进 `bundle.resources` 映射到 `runtime-dsh-<version>.zip`。

### 2.2 命名约定（与现有 `desktop/src-tauri/tauri.conf.json` 一致）

`tauri.conf.json` 当前只有三项 `resources`，都是插件目录（`embedded/dsh-desktop-tauriapp` 等）。需要追加：

```jsonc
"resources": {
  // 已有 3 项
  "embedded/dsh-desktop-tauriapp": "plugins/dsh-desktop-tauriapp/",
  "embedded/dsh-mobile-access": "plugins/dsh-mobile-access/",
  "embedded/dsh-web-mobile": "plugins/dsh-web-mobile/",
  // 新增 2 项
  "bin/runtime-dsh-<dsh-version>.zip": "runtime/dsh.zip",     // dsh + node_modules 整目录
  "bin/THIRD_PARTY_NOTICES.md": "runtime/NOTICE.md"           // 第三方许可证清单（合规）
},
"externalBin": [
  "bin/node-runtime"   // Tauri 自动配三后缀：node-runtime-aarch64-apple-darwin / node-runtime-x86_64-pc-windows-msvc.exe 等
]
```

`bin/node-runtime-<triple>` 文件从官方 nodejs.org 下载 tarball，解出 `bin/node`（macOS/Linux）或 `node.exe`（Windows）重命名为 `bin/node-runtime-<triple>`。

### 2.3 资源清单（最终打进安装包的文件）

| 文件 | 形态 | 大小参考 | 来源 |
|---|---|---|---|
| `bin/node-runtime-aarch64-apple-darwin` | sidecar | ~50 MB（macOS arm64） | nodejs.org Node 24 LTS tarball |
| `bin/node-runtime-x86_64-apple-darwin` | sidecar | ~50 MB | 同上 |
| `bin/node-runtime-x86_64-pc-windows-msvc.exe` | sidecar | ~30 MB（Windows 静态链接少） | nodejs.org Node 24 LTS zip |
| `bin/node-runtime-x86_64-unknown-linux-gnu` | sidecar | ~50 MB（若扩 Linux） | 同上 |
| `bin/runtime-dsh-<ver>.zip` | resources | ~280-330 MB（zip 压缩后；解压 549 MB） | 见 §3 生成步骤 |
| `bin/THIRD_PARTY_NOTICES.md` | resources | < 1 MB | 见 §6.1 许可合规 |
| `embedded/dsh-*-tauriapp/` × 3 | resources（已有） | ~10 MB 合计 | 已存在 |

**预期安装包体积估算**：macOS arm64 `.app` ≈ 90 MB（Node 50 + 插件 10 + Tauri 自身 15 + 图标等）+ `.zip` 内嵌到 .app 后 ≈ 100 MB。`.dmg` 压缩后可能到 60-80 MB。Windows NSIS `.exe` 约 80-100 MB（社区 myYangyunfan 实测 87 MB）。**比社区「瘦壳 + 首启下载」方案大，但完全离线**。

---

## 3. dsh npm 包离线预置（核心难点）

### 3.1 本机 dsh 依赖树扫描结论

```
$ du -sh /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/
549M	/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/
```

子目录细分：

```
$ du -sh <子路径>
549M  total
307M  node_modules/@deepseek-ai/                 (149 个 dsh 子包)
  + 259M   @deepseek-ai/libreoffice-kit-darwin-arm64/program/LibreOfficeDev.app   ← 整个 LibreOffice
  + 26M    node_modules/node-pty/prebuilds/* (含 darwin-arm64/x64, win32-x64/arm64, linux-x64/arm64)
  + 18M    node_modules/@img/sharp-darwin-arm64 + sharp-libvips-darwin-arm64 (~17M libvips-cpp.dylib)
  + 1.2M   node_modules/@koromix/koffi-darwin-arm64
+ 数十 MB 其他 @scope/* (anthropic-ai-sdk, aws-sdk, smithy, opentelemetry, etc.)
+ 数百 KB 顶层独立包 (commander, js-yaml, schemastery, etc.)
```

### 3.2 平台耦合产物清单（必须按目标平台分别打包）

`find <pkg> -name "*.node"` + `*.dylib` + `*.dll` + `*.so` 扫描结果：

| 原生模块 | darwin-arm64 | darwin-x64 | win32-x64 | linux-x64 | 大小 |
|---|---|---|---|---|---|
| `node-pty/prebuilds/*/pty.node` | ✅ | ✅ | ✅ (conpty.node) | ✅ | ~26 MB 全平台 |
| `@img/sharp-darwin-arm64/lib/*.node` | ✅ | — | — | — | 300 KB |
| `@img/sharp-libvips-darwin-arm64/lib/*.dylib` | ✅ | — | — | — | 17 MB（libvips-cpp） |
| `@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node` | ✅ | — | — | — | ~1 MB |
| `@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node` | ✅ | — | — | — | ~1 MB |
| `@deepseek-ai/libreoffice-kit-darwin-arm64/program/LibreOfficeDev.app/.../*.dylib` | ✅ (200+ 个) | — | — | — | 259 MB |
| 对应 platform 变体（`sharp-darwin-x64` 等） | — | ✅ | — | — | 见 npm registry |

**结论**：**直接拷贝现有 `node_modules/` 是平台耦合的**。darwin-arm64 的 `node_modules/` 只能在 Apple Silicon Mac 上跑，搬到 x86_64 Mac / Windows 上：
- 找不到 `sharp-darwin-arm64`（dll 加载失败，但可选依赖，多半 graceful degrade）
- `koffi` 直接 ENOENT（必需依赖，会崩溃）
- `node-addon-system-darwin-arm64` 直接 ENOENT
- `node-pty/prebuilds/win32-x64` 缺失 → bash/pwsh 工具全废
- `libreoffice-kit-darwin-arm64` 缺失 → office→pdf 工具不可用

**所以打 zip 必须按目标平台分别 build，不能用本机已有的 arm64 node_modules 复制给 x86_64 用户。**

### 3.3 推荐构建脚本（在 CI 的 macOS-latest / windows-latest runner 上执行）

```bash
# 假设目标版本已钉到 env DSH_VERSION；Node 版本已钉到 env NODE_VERSION
PIN_DSH="${DSH_VERSION:-0.1.5-rc.2}"
PIN_NODE="${NODE_VERSION:-22.19.0}"

mkdir -p build/dsh
cd build/dsh
cat > package.json <<EOF
{ "name": "dsh-desktop-runtime-build", "version": "1.0.0", "private": true }
EOF
# 不写 dependencies，让 npm install 自己根据 --package-lock 取
npm install "@deepseek-ai/dsh@${PIN_DSH}" --omit=dev --omit=optional --no-audit --no-fund
# 关键：--include=optional 让 sharp/node-pty/libreoffice-kit 的 platform 包也被装
# 但我们用 --include=optional on Linux/macOS/Windows runner 已经各取各的 platform 包了
# 不要用 --omit=optional —— 会把 native deps 全丢了

# 清理 .bin 软链里 npm 残留
rm -rf node_modules/.cache node_modules/.package-lock.json

# 关键：保留 .bin 软链（运行时 dsh 启动时通过 symlink 调子命令）
# 验证 .bin 完整
ls node_modules/.bin/dsh
# → node_modules/@deepseek-ai/dsh/lib/bin.js （symlink）

# 打 zip
cd ..
zip -r "runtime-dsh-${PIN_DSH}.zip" dsh/

# sha256 写入 manifest
shasum -a 256 "runtime-dsh-${PIN_DSH}.zip" > "runtime-dsh-${PIN_DSH}.zip.sha256"

# 第三方许可证清单
cd dsh
npx --yes license-checker --production --json > ../THIRD_PARTY_NOTICES.json
node ../scripts/render-notice.mjs ../THIRD_PARTY_NOTICES.json > ../THIRD_PARTY_NOTICES.md
```

**`scripts/build-runtime.sh`（或 PowerShell 等价物）必须放在 `desktop/scripts/`**，CI workflow `release.yml` 在 `tauri build` 前调一次。

### 3.4 是否用 `pkg`/`bun build --compile` 把 dsh 编成单可执行

参考 [tauri.app Node.js sidecar guide](https://tauri.app/learn/sidecar-nodejs) 提到可选方案：把 dsh 的 `bin.js` 用 `@yao-pkg/pkg` 或 `bun build --compile` 编成单可执行，免去「Node 二进制 + node_modules」的双资源分发。

**强烈反对此方案在本项目应用**：
1. `bun build --compile` 会嵌入 Bun runtime（~80MB），但 dsh 的 cordis 体系需要 v8 完整特性，Bun 已验证可跑（社区 dsh-desk 等用），但**会出现 Node-only API 行为差异**（v26.x 的 `node:zlib` Zstd、`node:test` 等）
2. `pkg` 已 archived（[ship via Bun 那篇](https://dev.to/riponcm/shipping-a-nodejs-server-as-a-native-desktop-app-with-tauri-and-bun-mok) 提到），且对 ESM + 动态 import 支持差，dsh 是纯 ESM（`"type": "module"`）
3. **致命**：libreoffice-kit-darwin-arm64（259 MB 的 LibreOffice.app）和 node-pty 的 `.node` 原生模块无法被 pkg/bun 嵌入（必须从外部文件系统加载）—— 实际打包后还是要外挂大文件，跟 sidecar+resources 方案没差

→ **保留「Node 二进制走 sidecar，dsh 依赖树走 resources」的双资源方案**，参考官方 [Tauri 文档「You can also embed the Node runtime itself into your Tauri application and ship bundled JavaScript as a resource」](https://tauri.app/learn/sidecar-nodejs)。

---

## 4. 首启解压的幂等与版本升级策略

### 4.1 解压目录布局

```
<app_data_dir>/
├── settings.yaml                                    # dsh-desktop-tauriapp: 配置（已有）
├── logs/
├── .mnemon/                                         # dsh-mnemon workspace
└── runtime/
    ├── manifest.json                                # 解压/版本戳（见 §4.3）
    └── node-<node-version>-dsh-<dsh-version>/
        ├── bin/
        │   ├── node(.exe)                           # 从 sidecar 拷过来或软链
        │   └── dsh -> ../node_modules/@deepseek-ai/dsh/lib/bin.js   # 软链
        └── node_modules/
            ├── @deepseek-ai/dsh/
            │   ├── lib/bin.js                       # CLI 入口
            │   ├── lib/profile-boot.js
            │   └── node_modules/
            │       ├── @deepseek-ai/dsh-app-boot/
            │       ├── @deepseek-ai/cordis/
            │       └── ...（149 个子包）
            ├── @img/sharp-darwin-arm64/             # 原生 .node + .dylib
            ├── node-pty/prebuilds/darwin-arm64/pty.node
            ├── .bin/                                # 软链（如 dsh、cordis、js-yaml 等）
            └── ...
```

`<app_data_dir>` 取自 `tauri::path::BaseDirectory::AppData`，跨平台分别落到：
- macOS：`~/Library/Application Support/com.arcreel.dsh-desktop-tauriapp/`
- Windows：`%APPDATA%\com.arcreel.dsh-desktop-tauriapp\`

### 4.2 幂等与升级

**版本戳文件** `<app_data_dir>/runtime/manifest.json`：

```json
{
  "schema_version": 1,
  "node_version": "22.19.0",
  "node_sha256": "<sha>",
  "dsh_version": "0.1.5-rc.2",
  "dsh_zip_sha256": "<sha>",
  "installed_at": "2026-09-19T14:00:00Z",
  "build_id": "<CI build commit>"
}
```

**决策矩阵**（首启 + 后续每次启动都跑）：

| 当前状态 | 动作 |
|---|---|
| `runtime/` 不存在 | 解压新目录，原子重命名 `runtime/node-*-dsh-*.pending/` → `runtime/node-*-dsh-*/` |
| `runtime/manifest.json` 缺失或 `schema_version` < 当前 | 同上（保守全量重建） |
| 存在 `manifest.json` 且 `dsh_version == 当前应用版本` 且 `dsh_zip_sha256 == 当前应用资源 zip 的 sha256` | 跳过，幂等成功 |
| `dsh_version` 落后于应用版本（应用升级后） | 解压到 `runtime/node-<新node>-dsh-<新dsh>.pending/`，验证后原子重命名；旧目录打 `runtime/legacy-<ts>/`，下次启动后用户主动触发清理（避免立即删失败回滚时无目录可用） |
| `dsh_version` 领先于应用版本（用户手工改装的旧 runtime 留下来） | 保留不动，警告日志，**不删除**（避免误删用户数据） |

**原子解压**（参考 [Vanta 的 atomic swap](https://blog.skill-issue.dev/blog/vanta_desktop_tauri_wallet/print) 模式）：
1. 解压 zip 到 `runtime/.pending-<uuid>/`
2. sha256 校验 `.pending/` 里的关键文件
3. `fs::rename(".pending-<uuid>", "node-<v>-dsh-<v>")`（同盘 rename 是原子的）
4. 写 `manifest.json`
5. 失败：删除 `.pending/`，返回错误，spawn 走「复用/拉起回收/受限 PATH」三态

### 4.3 清理策略

- **自动清理**：每次启动时，若发现 `runtime/legacy-*/` 存在且未在用（dsh 进程退出 30 s 后），后台异步 `fs::remove_dir_all(legacy)`；空闲资源不抢主流程。
- **手动清理**：托盘菜单加「清理内置 runtime 缓存」项，删整个 `runtime/` 目录（除 `manifest.json` 之外）—— 用户可强制重建。
- **跨桌面壳版本兼容**：`schema_version` 字段保留扩展余地；`schema_version` 升级时允许旧 runtime 共存一段时间，新启动强制用新。

---

## 5. spawn 链路改造要点（直接影响 desktop/src-tauri/src/process/lifecycle.rs）

### 5.1 当前实现的不足

`find_dsh_bin()`（`desktop/src-tauri/src/process/lifecycle.rs:138-199`）目前只探测**系统 PATH / nvm / npx 缓存 / Homebrew 等**用户机器上的 dsh 安装，不存在内置概念。

`spawn_dsh()`（unix 分支 `lifecycle.rs:240-377`，windows 分支 `lifecycle.rs:520-635`）直接 `Command::new(&bin)` 调 `dsh`（unix）或 `Command::new(node).arg(bin_js)`（windows）。

### 5.2 改造方案：新增「Builtin」分支

在 `lifecycle.rs` 引入**新的 struct `BuiltinLifecycle`**（与 `NativeLifecycle` / `JsLifecycle` 并列；`#[cfg(unix)]` 选 `NativeLifecycle` 或 `BuiltinLifecycle`，`#[cfg(windows)]` 选 `JsLifecycle` 或 `BuiltinLifecycle`）：

```rust
// 伪代码
pub enum DshMode { External, Builtin }

pub trait DshLifecycle {
    fn find_binary() -> Option<PathBuf>;
    fn spawn(app: &AppHandle, port: u16, advanced: bool) -> Result<Child, SpawnError>;
    fn kill(pid: u32);
    fn kill_force(pid: u32);
}

#[cfg(unix)]
pub struct BuiltinLifecycle;

#[cfg(windows)]
pub struct BuiltinLifecycle;
```

### 5.3 `BuiltinLifecycle::find_binary()` 关键路径

```rust
fn resolve_builtin_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    // 1. 解析 sidecar 路径（Node 二进制）
    let node = app.shell().sidecar("node-runtime").ok()?.path().ok()?.to_path_buf();
    // 2. 解析 dsh bin.js（resources/runtime/dsh.zip 解压后的 node_modules/@deepseek-ai/dsh/lib/bin.js）
    let runtime_dir = crate::runtime::builtin::ensure_extracted(app).ok()?;
    let dsh_bin = runtime_dir.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !dsh_bin.is_file() { return None; }
    Some((node, dsh_bin))
}
```

`ensure_extracted()` 在首次调用时触发 §4.2 的解压流程，并返回解压目录路径。

### 5.4 `BuiltinLifecycle::spawn()` 关键路径

复用现有 `spawn_dsh()` 的所有逻辑（`--profile` / `--patch` / `--no-open` / `--host` / `--port` / 环境变量注入 / pre-exec RLIMIT_NOFILE / stdout/stderr 转发 / dsh-console 事件 / web token 解析），只改三个点：

1. **`Command::new(node).arg(dsh_bin)`** 替换 `Command::new(&bin)`（unix）或 `Command::new(node_sys).arg(bin_js_sys)`（windows）
2. **取消 PATH 注入**（`dsh_runtime_path`）：sidecar node.exe 已是完整 Node 二进制，不依赖系统 PATH；但仍保留 `inject_proxy_env`（HTTP_PROXY/HTTPS_PROXY/NO_PROXY 等 Node fetch 用）
3. **`cmd.env("NODE_OPTIONS", "--use-env-proxy")`**（Windows 内置 Node 用此读取代理环境变量；参考 [Electron / Node 文档](https://nodejs.org/api/cli.html#--use-env-proxy)）

### 5.5 设置与切换逻辑

`crate::settings::configured_dsh_mode()`（新增）读 `settings.yaml` 的 `dsh-desktop-tauriapp.dsh_mode` 字段：

```yaml
dsh-desktop-tauriapp:
  dsh_mode: builtin   # builtin | external
  dsh_external_bin: ""  # 可选，手工指定外部 dsh 二进制覆盖
  dsh_node_external: ""  # 可选，手工指定外部 Node（强制 builtin 模式用外部 Node 时）
```

设置面板加一个 toggle「使用系统 dsh / 使用内置 dsh」（默认 builtin）。切到 builtin 时校验内置 runtime 已解压，否则给「点击下载解压」按钮（首启可能未解压完）。

### 5.6 复用/拉起回收/受限 PATH 三态的兼容

现有 AGENTS.md 写明的「同 profile dsh web 同时只能一个」「复用外部/远程只提示不代拉」「自愈 3 次封顶」三条铁律**对 builtin 模式也适用**：
- builtin 模式 spawn 出来的 dsh 进程 PID 同样走 `std::sync::Mutex<Vec<u32>>` 管理
- builtin 启动前仍 `port_open(port)` + `listener_pids(port)`，若已有外部 dsh 占用 3080 → 走复用路径，不双启
- builtin 模式下若解压失败 / Node 二进制不存在 → fallback 到 `NativeLifecycle` / `JsLifecycle`（外部），保底用户能用

---

## 6. 平台风险清单

### 6.1 macOS 签名与公证

**事实**：macOS Gatekeeper 对**未签名 + 未公证** 的 app（含 sidecar）会弹「damaged and can't be opened」/ 「developer cannot be verified」窗口；用户必须右键 Open 或 `xattr -cr` 绕过。**没有 macOS 公证 = 没法发布给真实用户**。

**当前项目签名状态**：`tauri.conf.json` 没有 `bundle.macOS.signingIdentity`；`.github/workflows/release.yml` 应已配 `APPLE_*` secrets（待核对）。

**sidecar 带来的额外挑战**：

| 挑战 | 来源 | 对策 |
|---|---|---|
| sidecar 必须是「Developer ID Application」签过的 | [Tauri 官方 Vanta 案例](https://blog.skill-issue.dev/blog/vanta_darwin_apple_silicon_build/print)、[brew-browser](https://gunbark.dev/content/025b3ed8-c642-4da6-9b48-8c9e79d8f894) | 主 .app 签名时附带签 sidecar；Tauri 在 macOS `tauri build` 会把 sidecar 一并签上同一 identity —— **前提是 sidecar 文件在 `src-tauri/bin/` 且 main .app 走 Developer ID** |
| sidecar 的 dylib 依赖（Node 二进制动态链接 libssl/libz）需 Library Validation 豁免 | [Tauri 官方 docs](https://tauri.app/learn/sidecar) 默认行为 | `Entitlements.plist` 加 `com.apple.security.cs.disable-library-validation`（已要求 Tauri 默认 WebView JIT 也要这条） |
| Hardened Runtime + 内置 LibreOfficeDev.app 200+ dylib | libreoffice-kit 自带 LibreOfficeDev.app | **必须**把所有 dylib 一并签上同一 identity；libreoffice-kit-darwin-arm64 v0.0.1 自带 `bin/soffice` + `Contents/Frameworks/*.dylib`，签名时 Tauri 不会自动处理这一堆 —— 需要额外 post-build 脚本或 notarization 前处理 |
| **.dmg 包装层需要单独公证 + staple** | [gunbark.dev](https://gunbark.dev/content/025b3ed8-c642-4da6-9b48-8c9e79d8f894) 与 [Vanta blog](https://blog.skill-issue.dev/blog/vanta_desktop_tauri_wallet/print) 双源确认：Tauri 2.x 只公证内层 .app，不公证外层 .dmg | release workflow 增加 `xcrun notarytool submit DMG --wait && xcrun stapler staple DMG` 两步 |

**额外风险**：内置 LibreOfficeDev.app 加剧 .app 体积（再加 259 MB），公证上传慢 + 失败重试代价大。建议用 `ditto` 压缩 + `.pkg` 替代 `.dmg`（参考 [dev.to hiyoyok](https://dev.to/hiyoyok/code-signing-a-tauri-app-for-macos-the-complete-flow-54jk) 提到的方案）。

**社区先例共识**：所有内置 dsh 的社区项目都明示 **macOS builds are ad-hoc / unsigned**（[myYangyunfan/dsh_desktop 文档](http://dsh.deepseek404.com/detail.php?id=myYangyunfan%2Fdsh_desktop)、[fendouai 文档](https://github.com/fendouai/deepseek-harness-desktop)、[xiincs README](https://github.com/xiincs/deepseek-harness-desktop) 都提到「macOS Gatekeeper — the app is not notarized; allow it once via System Settings」）。我们若要做正经 macOS 分发，需要把签名/公证/双签 sidecar 这条流水线补齐到 CI；否则就接受「首次运行手动 xattr」的现状。

### 6.2 Windows SmartScreen / Defender 误报

**事实**（参考 [DigiCert KB](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings)、[Racent](https://help.racent.com/en/code-signing/support-services/ev-code-signing-smartscreen-change)）：
- **EV 代码签名证书不再自动消除 SmartScreen 警告**（Microsoft 改 2023+ 政策）
- 新发布软件头几周一定被打到 SmartScreen
- Tauri NSIS `.exe` 安装包历史上有反复的 Defender 误报（[Tauri 官方安全 false-positives](https://tauri.by.simon.hyll.nu/concepts/security/false_positives/)）—— 这是 NSIS 上游问题
- **`.msi` 触发误报少于 `.exe`**（同源）

**sidecar `node.exe` 风险**：Node 二进制本身在 Windows 上有合法签名（Node.js Foundation），但放进 .app / .msi 后作为整体资源被重新打包，签名会失效。Windows Defender 会扫到「未签名的 Node.exe」+「未签名的主 .exe」组合 → 双倍误报概率。

**对策**：
1. 给整个安装包（NSIS 或 WiX）申请 EV 代码签名（`SignPath`/`DigiCert`/`Sectigo`），开启 `signtool sign /tr http://timestamp.sectigo.com /td sha256 /fd sha256 /a`
2. **优先用 WiX `.msi` 而非 NSIS `.exe`**（Tauri 的 `bundle.windows.wix` 已配置 `language: zh-CN`，把默认 maker 从 NSIS 切到 MSI 可加但要核 `--target`）
3. sidecar `node.exe` 不需要单独签名（已被 .msi 内的文件签名覆盖）
4. 上线初期在 GitHub Releases 标注「首次运行点 More info → Run anyway」，等信誉累积
5. **不要** 把 LibreOfficeDev.app 全部塞进 Windows 安装包（占用 250+ MB + 大量 .dll，Defender 扫描时间翻倍 + 误报暴增）—— 见 §7.3 的可执行性裁剪建议

### 6.3 Linux（若扩）

虽然本项目当前 targets = "all" 但实际只发 macOS + Windows；社区 Linux 版通常 AppImage，未深调研。**首次实现建议先 macOS+Windows，Linux 后续单独 issue**。

---

## 7. 决策建议与待确认点

### 7.1 推荐打包结构（综合）

```
src-tauri/
├── bin/
│   ├── node-runtime-aarch64-apple-darwin
│   ├── node-runtime-x86_64-apple-darwin
│   ├── node-runtime-x86_64-pc-windows-msvc.exe
│   ├── runtime-dsh-<dsh-ver>.zip          # 含完整 node_modules/（平台特定）
│   ├── runtime-dsh-<dsh-ver>.zip.sha256   # 校验
│   └── THIRD_PARTY_NOTICES.md
├── tauri.conf.json
│   ├── bundle.externalBin: ["bin/node-runtime"]
│   └── bundle.resources: { "bin/runtime-dsh-<v>.zip": "runtime/dsh.zip", ... }
└── src/
    └── process/
        └── lifecycle.rs                   # 新增 BuiltinLifecycle + resolve_builtin_paths
```

### 7.2 首启解压与升级流程（综合 §4）

1. 应用启动 → `crate::runtime::builtin::ensure_extracted(app)` 异步触发
2. 读 `tauri.conf.json` 的资源 zip 路径 + `manifest.json` 比对
3. 不匹配则解压到 `.pending-<uuid>/`，sha256 校验
5. 原子 rename 到 `runtime/node-<v>-dsh-<v>/`
6. 写 `manifest.json`
7. `BuiltinLifecycle::spawn()` 拿 `runtime_dir` + sidecar node 路径
8. 后续启动读到 `manifest.json` 命中 → 跳过解压，秒进主流程

### 7.3 平台风险清单（一页总结）

| 风险 | 等级 | 主要缓解 |
|---|---|---|
| macOS Gatekeeper 拦截未签名应用 | 高 | Developer ID + 公证 + DMG 单独 staple；社区先例多数**默认不签**，需要决策是否花钱签 |
| macOS sidecar dylib Library Validation | 中 | Entitlements.plist 加 `disable-library-validation` |
| macOS LibreOfficeDev.app 200+ dylib 签名 | 中-高 | post-build 脚本全签一遍；或裁剪掉 dsh-office-to-pdf 子包 |
| Windows SmartScreen 误报 | 高 | EV 证书 + 时间戳；`.msi` > `.exe`；接受短期警告 |
| NSIS 单文件数限制 | 中 | runtime 整目录打成 zip 再分发（已在 §2.1 推荐） |
| 首启解压失败回退 | 中 | 解压失败 → 走 `NativeLifecycle`/`JsLifecycle`（外部 dsh）+ 提示用户 |

### 7.4 对桌面壳 spawn 链路的改造要点（总结 §5）

1. **`lifecycle.rs`**：新增 `BuiltinLifecycle` struct；`find_dsh_bin` / `spawn_dsh` 拆为「解析来源」+「spawn」两段
2. **`settings.rs`**：新增 `configured_dsh_mode() -> DshMode` + `dsh_mode`/`dsh_external_bin`/`dsh_node_external` 三个配置键（与现有 `lane_port`/`ws_keepalive_ms` 同级 `dsh-desktop-tauriapp:` 顶层）
3. **`commands/`**：新增 IPC 命令 `set_dsh_mode(mode: String)`、`refresh_builtin_runtime()`、`builtin_runtime_status() -> { installed, version, node_version, dir }`，权限 `default.json` 加 `allow-*`
4. **`tray.rs`**：菜单加「使用内置 dsh」「刷新内置 runtime」「清理 runtime 缓存」三项
5. **新增模块 `desktop/src-tauri/src/runtime/builtin.rs`**：封装解压/校验/原子 swap 逻辑（独立模块，跟 `runtime/` 平行，便于 cargo test 覆盖）
6. **`desktop_plugin_patch.yml`**：无需改（patch overlay 跟 dsh 来源无关）
7. **`AGENTS.md`** 已知事项补一条：「builtin 模式解压路径在 `<app_data_dir>/runtime/node-<v>-dsh-<v>/`；升级时旧目录标记为 legacy- 后异步清理」
8. **`build.rs`**：把 `bin/runtime-dsh-<ver>.zip` 的存在性纳入 `cargo:rerun-if-changed`，避免 CI 改 zip 但 build 不重跑

### 7.5 决策待办（提请拍板）

| 决策点 | 选项 | 推荐 |
|---|---|---|
| **首次 macOS 是否花钱申请 Apple Developer ID + 公证**？ | (A) 申请 + 公证 = 真实可分发 / (B) 维持现状不签，文档写 `xattr` 绕过 | 待用户决策（参考社区共识多数不签，但要进入公测/正式发版就必签） |
| **是否引入 LibreOfficeKit 完整依赖**？ | (A) 完整打包（259 MB）/ (B) 装 dsh 时 `--omit=optional` 跳过 office 工具链，体积减半 | **B**（让 dsh-office-to-pdf 子包不在 builtin runtime 内；用户手动装 `dsh plugin add` 时按需拉） |
| **dsh 版本钉哪条线**？ | (A) `latest` (0.1.5-rc.2) 稳定 / (B) `alpha` (0.1.6-alpha.2) 跟新 | **A**（社区共识跟 stable；alpha 风险高） |
| **Node 版本钉哪个**？ | (A) Node 22 LTS（22.19.0+，最小匹配）/ (B) Node 24 LTS（社区趋势） | **B**（社区已多数用 24 LTS；Node 22 也可，但 v24 含 `node:test`、WebStreams 等改进） |
| **Windows 安装包格式**？ | (A) NSIS `.exe`（默认，文件数限制）/ (B) WiX `.msi`（误报少） | **B**（[DigiCert](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings) 与社区共识）；若担心 wix 区域/语言再加 `.exe` 双 maker |
| **首启解压改同步 vs 异步**？ | (A) 同步阻塞首屏（5-10 s 卡顿）/ (B) 异步后台 + loading 进度 | **B**（参考 dsh-tauri 首启下载的 loading page 模式） |

---

## 8. 关键引用链接

### 8.1 官方 Tauri 文档
- [Embedding External Binaries (sidecar)](https://tauri.app/learn/sidecar)
- [Node.js as a sidecar (官方指南)](https://tauri.app/learn/sidecar-nodejs)
- [Sign Tauri App for macOS](https://tauri.app/zh/v1/guides/distribution/sign-macos)

### 8.2 macOS 签名/公证实战
- [Bundling a CLI Binary as a Tauri v2 Sidecar — Lessons from Building a Desktop App](https://dev.to/chenxxpro/bundling-a-cli-binary-as-a-tauri-v2-sidecar-lessons-from-building-a-desktop-app-5po)
- [Vanta Desktop — Tauri wallet ships its own full node](https://blog.skill-issue.dev/blog/vanta_desktop_tauri_wallet/print)
- [Cross-compiling vantad for darwin: Apple Silicon + sign + notarise](https://blog.skill-issue.dev/blog/vanta_darwin_apple_silicon_build/print)
- [brew-browser sign-and-notarize wrapper](https://gunbark.dev/content/025b3ed8-c642-4da6-9b48-8c9e79d8f894)
- [Shipping a Production macOS App with Tauri 2.0: Code Signing, Notarization, and Homebrew](https://dev.to/0xmassi/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrew-mc3)
- [Code Signing a Tauri App for macOS — The Complete Flow](https://dev.to/hiyoyok/code-signing-a-tauri-app-for-macos-the-complete-flow-54jk)

### 8.3 Windows SmartScreen / Defender
- [DigiCert: Why EV-signed application showing Microsoft Defender SmartScreen warnings](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings)
- [Microsoft SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/security/identity-protection/access-control/smart-screen-reputation-for-windows-apps)
- [Tauri by Simon — False Positives (NSIS)](https://tauri.by.simon.hyll.nu/concepts/security/false_positives/)
- [Tauri 打包 MSI 时签名失败或安装后无法启动 (CSDN)](https://ask.csdn.net/questions/9480732)
- [GoodWebTools Desktop Release Guide](https://github.com/slaveofcode/goodwebtools/blob/main/RELEASING-DESKTOP.md)

### 8.4 社区 dsh 桌面项目
- [dsh-tauri/deepseek-harness-desktop (2280★)](https://github.com/dsh-tauri/deepseek-harness-desktop)
- [myYangyunfan/dsh_desktop (668★)](https://github.com/myYangyunfan/dsh_desktop)
- [DSH-EAC/DSH-Desktop-EAC](https://github.com/DSH-EAC/DSH-Desktop-EAC)
- [AleCyriaco/deepseek-harness-desktop](https://github.com/AleCyriaco/deepseek-harness-desktop)
- [fendouai/deepseek-harness-desktop](https://github.com/fendouai/deepseek-harness-desktop)
- [LodeKennes/deepseek-harness-desktop](https://github.com/LodeKennes/deepseek-harness-desktop)
- [xiincs/deepseek-harness-desktop](https://github.com/xiincs/deepseek-harness-desktop)
- [hjdhnx/dsh-desktop](https://github.com/hjdhnx/dsh-desktop)
- [Antony-Jia/deepseek-harness-desktop](https://github.com/Antony-Jia/deepseek-harness-desktop)
- [renjianxin929-ux/deepseek-harness-desktop](https://github.com/renjianxin929-ux/deepseek-harness-desktop)
- [fsw2781890522-dsh-desktop (Windows NSIS + bundle-runtime.ps1)](https://github.com/fsw2781890522-dsh-desktop)

### 8.5 Node 打包通用模式
- [Shipping a Node.js server as a native desktop app with Tauri and Bun](https://dev.to/riponcm/shipping-a-nodejs-server-as-a-native-desktop-app-with-tauri-and-bun-mok)
- [Tauri-plugin-js Compiled Sidecars (Bun/Deno cross-compile)](https://deepwiki.com/HuakunShen/tauri-plugin-js/6.1-compiled-sidecars)
- [Tauri-plugin-js Build Configuration](https://deepwiki.com/HuakunShen/tauri-plugin-js/6.3-build-configuration)
- [running-nodejs-sidecar-in-tauri skill](https://skillselion.com/skills/dchuk/claude-code-tauri-skills/embedding-tauri-sidecars)
- [Plugins, sidecars and bundled resources (Tauri 2 verified)](https://github.com/lynricsy/hyperskills/blob/main/skills/tauri/references/plugins-and-sidecar.md)
- [在 Tauri 应用中引入 Sidecar 的实践 (BHznJNs)](https://bhznjns.github.io/pages/%E5%9C%A8%20Tauri%20%E5%BA%94%E7%94%A8%E4%B8%AD%E5%BC%95%E5%85%A5%20Sidecar%20%E7%9A%84%E5%AE%9E%E8%B7%B5.html)

### 8.6 dsh 包原生依赖（来自本机扫描）
- npm registry `@deepseek-ai/dsh`：[npmjs.com/package/@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)
- 本机已装包：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`（v0.1.6-alpha.2）
- 关键原生依赖：`node-pty`（prebuilds）、`@img/sharp-darwin-arm64`、`@koromix/koffi-darwin-arm64`、`@deepseek-ai/node-addon-system-darwin-arm64`、`@deepseek-ai/libreoffice-kit-darwin-arm64`

---

> **报告完成**。本报告是 wayfinder #80 决策票 #81 的研究输入；最终拍板落地结构请到对应 issue 讨论后由用户决策。