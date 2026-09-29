# 远程模式用「前端构建同一性闸门」决定是否使用本地资产

壳连接远程 dsh（另一台机器）时，**先取远程 `/` 的 index.html，抽出它的入口产物名（`assets/index-<hash>.js`，即前端构建标识），与本机**全部**运行时的同一项逐个比对**：命中某个本地运行时 → 锁定那份 dist 出文档与静态资产（数据面仍走远程）；不在本地 → 弹**三选项**让用户决定。

## Status

**accepted（2026-09-28 实现于 `navigation/remote_build.rs`）**。

本闸门曾在 ADR 0004 的「逐文件本地优先叠加」里被标为 superseded——那个方案是「文档也从 Host 出、只在逐文件层做本地叠加」，于是不需要版本闸门。维护者 2026-09-28 修正后，**文档与静态资产都从本地运行时出、Host 只做数据接口**，本地产物与远程不同构建时会直接去拉远程根本没有的 `assets/index-<hash>.js`：闸门因此重新成为必需品，且判据从一个集合简化为**一个入口产物名**（Vite 产物名即内容 hash，同名必同内容）。错误可见性结论（失败一律可解释 + 不阻断使用）保留。

原决策（issue #153；依据 #149 / #150 / #158；维护者拍板「比 index.html 的资源 hash，一致才走本地资产」）在「比对对象」上保持不变，只在「不一致时怎么办」上升级：从「自动回退直接打开远程页面」改为**用户三选项**（下载对应运行时 / 用当前默认运行时并警告 / 直接加载远程桌面）。

## Context

- 远程模式的版本错配是**结构性**的：本地资产与本机对齐，而远程那台机器的 dsh 运行时不在本机。
- 错配是**静默**的（#158）：前端产物自带的平台种子表先于 graph row 被查，命中后 Host 的同名 graph row 永不加载——不报错，只是用错版本（样式 hash 错位、新增 API 缺失才炸）。
- **官方没有任何版本锚**可用于判定：`DshPackageManifest.engines.dsh` 仅声明（`README.zh.md:84`"兼容性仅作声明"）；`__DSH_BOOT__.rev` 是 entries+batches 的整体 hash；`WebBootEntry.rev` 是单资源 cache-buster。官方 Electron 的做法是**不允许错配**（`release.ts` 把壳与内置运行时钉成同一不可变版本，`hostProtocolVersion` 不匹配直接抛）。
- 现成可用的判据：`dsh-web-frontend/dist/index.html` 里引用的构建产物文件名带**内容 hash**（如 `./assets/index-Q6zc2uHV.js`、`./assets/vendor-CCJJTK99.js`），同一份前端构建必然产出同一组文件名。

## Considered Options

- **远程模式也用本地资产、不比对**：否决——直接吃下静默错配。
- **远程模式彻底不做本地资产（一律打开远程页面）**：否决——与地图 Destination"覆盖远程模式"相左。
- **按远程版本从远程拉资产**：否决——破坏"资源随包"的前提，且首启要拉 4.7 MB。
- **比对 `assets/*` 文件名集合作为构建同一性闸门**（选中）：零额外协议、零服务端改动、判据来自 dsh 自己产出的文件名。

## Consequences

- **比对对象是「入口产物名」，不是整页字节、也不是全量文件集**：Host 会往 index.html 里内联启动注入（`__ModuleLoader__` facade、批次 script 行、`__DSH_BOOT__`），字节必然不同；而入口脚本名就是内容 hash，一个字符串就够判同一性（`assets::entry_name` / `assets::build_id`，各带单测）。
- **比对范围是本机全部运行时**（已下载 → 内置 → 外部 CLI 树，`assets::local_dists`），不是「当前选中的那一个」：命中哪个就锁定哪个（`assets::set_dist_override`，只影响本会话，不改用户的本地运行时选择）。
- **不一致时三选项**（原生对话框，`YesNoCancelCustom`；回调用 oneshot 转异步，不在 async 上下文里阻塞）：①下载对应运行时——远程页面只暴露构建标识、推不出 dsh 版本号，所以取发布源里的最新版装上并**立即重比**，命中就用、不命中就如实告知（不假装对齐）；②用当前默认运行时的产物，明示版本不符可能界面异常；③不走壳内 origin，直接以 URL webview 打开远程页面（永远可用的那一条）。
- **读不到远程构建标识**（老版 dsh / 首页非 2xx）时不弹窗、不假装匹配：按当前默认运行时继续并把理由写进日志。
- 代价是远程首屏多一次 index.html 探测（每会话一次，由 `scheme::host_page` 顺带完成）。
- 远程更新 dsh 后需重新判定（下一会话重新取）；判定失败一律走可用路径，**不阻断使用**。
- **cookie 由壳持有**：用远程打印的带 token 启动 URL 换取会话 cookie（对齐官方 `authenticateWebHost`，`apps/desktop/src/web-document.ts:43-50`：要求 303 + `set-cookie`），此后所有转发带它并剥掉响应里的 `set-cookie`。因为页面 origin 是访问端本地的 loopback，**不需要 `SameSite=None; Secure`**（那在局域网 `http://` 下本也无解）。
- **与 #145 的关系**：本地 origin 天然满足 `isLoopback`，远程端在新路径上**不再需要 `ownsHost` 注入**；ADR 0002 已由此 amended（见 ADR 0003）。旧路径（直接打开远程页面）继续沿用注入。
- **失败可见性**：远程不可达 / 版本不符 / 远程未安装本仓插件时，**自动回退 + 一次性通知**（不阻断、不弹错误页），复用壳已有的 `STATUS_*` 与通知服务。
