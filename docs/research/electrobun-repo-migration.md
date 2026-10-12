# A8 迁移规划：`desktop-electrobun` → 独立仓库 `dsh-desktop-bun`

状态：规划（未执行）。执行时机＝PR #222 评审后、由维护者拍板建仓时。本文是执行清单，
按序做完即可完成整体迁移；每步都标注了涉及的文件与将发生的变化。

## 1. 迁移范围（移什么）

| 内容 | 现路径（本仓） | 新仓路径 |
| --- | --- | --- |
| 壳本体（TS/Bun/Electrobun） | `desktop-electrobun/` | 仓库根（或 `desktop-electrobun/` 原名保留） |
| Bun 兼容层（单一来源） | `desktop/src-tauri/resources/dsh/bun-preload.mjs` | 随壳仓 `resources/dsh/bun-preload.mjs`（构建时拷进 payload） |
| 随包内置运行时装配脚本 | `desktop/scripts/prepare-builtin-runtime.mjs` | 随壳仓 `scripts/prepare-builtin-runtime.mjs` |
| CI（Electrobun 三平台） | `.github/workflows/shell-electrobun.yml` | 新仓 `.github/workflows/build.yml` |
| 仓库根 AGENTS.md 中壳相关段 | 根 `AGENTS.md` | 新仓 `AGENTS.md`（重写，见 C 段文档任务） |

**留在本仓不动的**：Tauri 壳全量（`desktop/`）、客户端插件（`src/`、`lib/`）、`mobile/`。
当前壳以「桌面插件」形态随包（`dsh-desktop-tauriapp` 包，staging 自仓库根）；迁移后该插件
一并搬去新仓（A10 改名，见 §3）。

## 2. 功能性外部引用清单（迁移时必须改的代码，非注释）

`grep -rn 'src-tauri\|dsh-desktop-tauriapp\|hyperion2144' desktop-electrobun/src desktop-electrobun/scripts`
里除注释外的实际引用：

1. `scripts/prepare-bundle.mjs`：图标与内置运行时的**回退拷贝源**都指向
   `desktop/src-tauri/icons|resources/dsh`。迁移后新仓自带 `resources/`（icon.png、
   app-icon.ico、tray 图标、内置运行时走下载装配），删除对旧仓路径的回退。
2. `src/bun/runtime.ts`：开发态回退路径 `desktop/src-tauri/resources/dsh`（内置树）与
   仓内 icons；同上改为新仓布局。
3. `src/shared/update.ts:21`：更新基址
   `https://github.com/hyperion2144/dsh-desktop-tauriapp/releases/latest/download`
   → 新仓 releases；`prepare-bundle` 写进 version.json 的 baseUrl 同步。
4. `src/bun/plugin-staging.ts`：`DESKTOP_PLUGIN_PACKAGE='dsh-desktop-tauriapp'` 与 staging
   源路径（仓库根插件包、`mobile/dsh-mobile-access`、`mobile/dsh-mobile-nav`）。
5. `.github/workflows/shell-electrobun.yml`：整个文件搬走；其中 `bun-preload.mjs`/
   profile 模板的单测输入路径随 §1 调整。

## 3. A10 插件包改名（与迁移同批）

`dsh-desktop-tauriapp`（桌面插件，`index.js` + `dsh.client.inject` + `cordis.patch.yml`）
→ `dsh-desktop-bun`。影响面：

- `package.json` name（本仓根）与新仓对应包。
- `plugin-staging.ts` 常量与 `inject-yml.ts` 的 insert 行 id/name。
- `settings-store.ts` 的旧设置迁移键 `dsh-desktop-tauriapp:`（**保留只读识别**，写入用新键）。
- 应用日志路径 / app-support 目录已在 A7 改为 `com.hyperion.dsh-desktop-bun`
  （`src/bun/runtime.ts` `APP_SUPPORT`）；首次启动时如需沿用旧目录数据，做一次
  `com.arcreel.dsh-desktop-tauriapp` → `com.hyperion.dsh-desktop-bun` 的**只读搬迁**并留标记。

## 4. 执行顺序（建议）

1. 建仓 `hyperion2144/dsh-desktop-bun`（空仓，默认分支 main）。
2. 复制 `desktop-electrobun/` 全量 + §1 列出的资源/脚本，改 §2 引用（一次提交）。
3. A10 改名（一次提交，含 §3 清单）。
4. 新仓 CI 首跑：mac/win/linux 三平台 build + 产物断言 + 安装器（沿用现有 job 结构）。
5. 本仓：`shell-electrobun.yml` 删除或改为「只跑测试不打包」；`desktop-electrobun/` 目录删除；
   README 指向新仓；#204/#220 留结案评论与跳转链接。
6. 发首个 release（update 基址生效），旧壳 v0.12.0 保持可用作回退。

## 5. 风险与回退

- **更新链切换**：老包（本仓基址）永远收不到新仓的更新广播 ⇒ 需要在旧仓发一个「末版」
  指引更新（或接受旧包用户手动迁移）。
- **设置/数据位置**：app-support 目录名已变；未做搬迁时用户设置与窗口几何会重置一次
  （§3 的只读搬迁可避免）。
- **插件注入链**：staging 的三个桌面插件随包路径变化后，`inject-yml` 契约不变
  （webStartup/webRuntime 按版本切换已内建），首启黑盒缝 ①（`bun test` 里的 blackbox）
  必须在新仓保持全绿。
