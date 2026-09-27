# 移动端访问设计：手机访问 Tab · 配对 · 三端壳（Android/iOS/HarmonyOS）

状态：设计稿（研究阶段）。目标平台：Android / iOS（WebView 套壳，共用一套前端）、
HarmonyOS NEXT（ArkUI 原生 + ArkWeb(WebView) 组件，UI 尽量与另两端一致）。
范围：研究结论 → 架构 → 注入方式 → 配对与传输 → 安全 → 实施顺序。实现待评审后另行进行。

## 0. 目标与形态

- 桌面端 dsh web 注入「设置 → 手机访问」Tab：生成配对二维码/链接，支持局域网、
  公网（cloudflared 隧道）、以及任意第三方隧道（cpolar 等）。
- 手机壳（Android/iOS 共用一套 HTML 前端；鸿蒙 ArkUI 单独实现但同一视觉）：
  首页 = 配对管理（多配对、选一个进入）→ 进入 dsh web 的 WebView 套壳，
  加载桌面 dsh 全量 UI + 移动布局插件（移植 dsh-web-mobile）。
- 第三方移动布局依赖（mexiaosqwq/dsh-web-mobile = @dsh-external/dsh-mobile-nav，MIT）：
  内置到本应用，按不安装方式注入（共享模块池 + --patch 包名行，同 dsh-desktop-tauriapp）。

## 1. 上游研究与结论（均为源码验证）

### 1.1 为什么 pocket+cloudflared 正常、cpolar 直连无法加载会话（根因）

- dsh web 的 /api 浏览器信任栅栏只认 loopback（127.0.0.1）或 --trusted-host 白名单；
  官方禁用 0.0.0.0 绑定（证据：dsh-pocket lib/proxy.mjs 注释原文；dsh-remote-web-ui README
  的「/api 仅 loopback、默认远程不走 --trusted-host」条文互相印证）。
- cpolar 隧道把外部域名/Origin 原样透传给 dsh web → 栅栏看到非 loopback Host →
  /api 与 /api/events.host（WebSocket）被拒 → 页面能开但会话/实时数据为空。
- pocket 解法（采纳）：Host/Origin 改写反向代理——监听 0.0.0.0:<lanePort>，
  入站请求 Host/Origin 统一改写成 127.0.0.1:<dshPort>，HTTP+WS 全透传；
  栅栏永远看到 loopback，任意域（cpolar/cloudflared/LAN-IP）都能进，不改 dsh 配置。
- 推论：cpolar 也能用，条件是隧道指向改写代理端口而非 dsh 端口。

### 1.2 额外兼容点（pocket 已踩坑，照搬）

- 非安全上下文（http://<LAN-IP>）缺 crypto.randomUUID → 注入 polyfill（mint RPC id）。
- 桌面壳插件读 URL 参数 dsh-desktop-mode/platform，缺失会崩 → 手机入口 URL 补
  compatibility 参数（不启用桌面 advanced，避免与移动布局叠加）。
- 压缩：大 JSON 响应 gzip/brotli（长会话 17MB→~1MB 级别），省流量。
- 配对授权（对齐 dsh-remote-web-ui，非密码方式）：一次性限时令牌 + QR；设备接受后种 HttpOnly 会话 cookie；无任何密码输入。

### 1.3 注入方式（不安装注入，延续现有机制）

- @dsh-external/dsh-mobile-nav 是标准 client 插件：cordis.patch.yml 单行 insert
  （id+包名），browser 半区走 package.json 的 dsh.client 声明——与已验证的
  「共享模块池 + --patch 包名行」机制完全同构。
- 接入动作：构建/获取该包 → 内嵌资源 → 启动时挂入 $DSH_HOME/profiles/node_modules
  （符号链接/复制）→ spawn 的 --patch 增加 dsh-mobile-nav 行 → 壳内 dsh 页面自动
  获得移动布局（窄屏抽屉等）。
- 手机访问 Tab 与配对服务同样做成内部包 dsh-mobile-access，一并 --patch 注入；
  不往 profile bundles 里注册任何东西。

### 1.4 配对参考（dsh-remote-web-ui，取其骨架简化）

- 入口：设置按钮旁手机图标 + 新「手机访问」设置 Tab（settings.section 行）。
- 两种配对入口（对齐 dsh-remote-web-ui 的「手机链接/电脑链接」形态）：
  a) 扫码配对：桌面显示二维码（含一次性令牌），手机壳内置扫码直接扫取；
  b) 输入配对地址配对：手动粘贴/输入配对链接（dsh-mobile://pair?token=..&base=..），
     或输入 host[:port] + 桌面显示的令牌（自动补全 base 与协议）发起配对。
- 令牌：一次性、限时（如 10 分钟）；QR 编码链接：
    dsh-mobile://pair?token=...&base=<候选地址>（手机壳唤起）
    https://<lan|tunnel>/pair?token=...（浏览器兜底）
- 状态：SSE 实时镜像（等待/已连接/已断开）+ 已配对设备列表（名称/在线/最近活动/
  取消配对，名称按 User-Agent 推断）。
- 安全：刷新令牌使旧链接作废；已接受令牌不可复用；停止=撤销全部设备与令牌。

## 2. 架构

### 2.1 桌面端（本仓库扩展）

- 内部包 dsh-mobile-access（host+client 双半区，参照 dsh-pocket 结构）
  host：改写反代（HTTP+WS，Host/Origin→loopback）+ cloudflared 快速隧道（二进制随包
  分发：GitHub latest + 国内镜像 + 多线程分块下载，参照 pocket tunnel.mjs）
  + 配对令牌/设备会话 + `/__dsh-mobile/api/pair` 路由族（历史别名 `/api/pair`，冻结）+ SSE 状态（$DSH_HOME 下 0600 文件存令牌；授权=cookie 会话，无密码）。
  client：settings.section「手机访问」Tab（二维码/刷新/停止/已配对设备列表/状态）。
  转发目标默认 127.0.0.1:<当前配置端口>（读 settings.yaml 的 dsh-desktop-tauriapp:port）。
- 反代监听：127.0.0.1:<lanePort>（仅隧道用）与 0.0.0.0:<lanePort>（局域网直连）；
  注意 0.0.0.0 是**我们自己的反代**，宿主 dsh 仍只面 loopback，安全面可控。
- cpolar/第三方隧道：Tab 内提供地址输入与校验（GET 探活 + WS 探测），通过即生成
  二维码；引导用户在 cpolar 面板把隧道指向 本机IP:<lanePort>。

### 2.2 候选地址优先级（二维码内容）

1. 公网：cloudflared 快速隧道 URL（https，配对二维码）——人在外面可用；
2. 局域网：http://<物理网卡 IPv4>:<lanePort>（RFC1918 优先、物理网卡加分、
   VPN 名减分，参照 pocket selectLanIPv4）；
3. 第三方隧道：用户输入（如 cpolar 域名），指向 lanePort。

### 2.3 传输路径

手机壳 WebView ── HTTPS(隧道)/HTTP(LAN) ──> 改写反代(0.0.0.0:lanePort)
  ├─ Host/Origin→127.0.0.1:dshPort
  ├─ WS /api/events.host 全透传（流式）
  ├─ HTML 注入：randomUUID polyfill（LAN HTTP 必需）
  └─ 配对门禁：未接受令牌的访问仅见配对页；接受后种 HttpOnly 会话 cookie → SPA 自动携带

### 2.4 手机壳

- Android：原生 WebView（INTERNET 权限、明文 HTTP 开关按需、外链交系统浏览器、
  返回键后退栈、安全区适配）加载内置 H5 壳前端 → 配对管理页 → 进入 dsh 页 WebView。
- iOS：WKWebView 同构（ATS 例外：LAN HTTP 需说明配置或走 HTTPS 隧道）。
- HarmonyOS NEXT：ArkUI 实现配对管理页（列表/添加/删除/状态点）+ ArkWeb 组件加载 dsh；
  与 H5 壳共用设计令牌（色板/字号/间距/圆角），保证三端视觉一致；ArkWeb 不做 DOM 注入，
  移动布局由页面内插件（dsh-mobile-nav）生效。权限：ohos.permission.INTERNET；
  明文 HTTP 需网络安全配置。
- 壳内配对页提供两个入口：扫码（调相机扫描桌面二维码）与输入配对地址（粘贴链接或
  host[:port]+令牌）；已配对列表独立于桌面端存储；令牌一次一用，换设备需桌面重新生成。

### 2.5 三端 UI 一致性

- 定义设计令牌：色板（浅/深）、字号、间距、圆角、按钮态 → H5 壳与 ArkUI 各实现一份；
- 两个原型 HTML 先行评审（docs/prototypes/）：
    settings-mobile-tab.html：桌面端「手机访问」设置 Tab
    mobile-shell.html：手机壳首页（配对管理）+ 进入 dsh 界面示意

## 3. 安全与边界

- dsh /api 只面 loopback：改写反代是唯一入口，公网与局域网一律过配对令牌门禁；
- 配对令牌一次性+限时；刷新/停止即时作废；设备会话与令牌分开存；
- 无访问密码：授权完全由一次性令牌+HttpOnly cookie 承担；令牌仅存本机 0600；
- cloudflared 生命周期随 dsh 子进程重启自动恢复（参照 pocket）；
- 已配对设备＝**完整访问**（#145）：dsh 端口全量透传（含 dsh 自有 `/api/*`、插件路由、WS upgrade、SSE），
  lane 控制端点在 `/__dsh-mobile` 命名空间下读写全放行；属主判定只免除 cookie 要求，不再多一级权限。

## 4. 实施顺序（评审通过后）

1. 接入 dsh-mobile-nav：内置→共享池→--patch 行→壳内验证移动布局；
2. 建 dsh-mobile-access 包（host 反代+配对令牌+设备会话 SSE+隧道；client Tab）；
3. 桌面壳扩展：Tab 注入 + 隧道生命周期托管（随 dsh 重启）+ 第三方隧道地址校验；
4. 手机壳：Android/iOS 共用 H5 壳；鸿蒙 ArkUI 壳；
5. 联调矩阵：局域网 / cloudflared 公网 / cpolar（指向 lanePort）/ 压缩 / 断线重连。

## 5. 开放问题（实施时确认）

- cloudflared 二进制国内分发策略：**已实测**（§11：gh-proxy.com / ghproxy.net / GitHub 可用，gh.ddlc.top 429 弃用）；实施时固定镜像清单与回退序；
- dsh-mobile-nav 与 dsh 版本的兼容面（窄屏阈值 1024 等）；
- 鸿蒙 ArkWeb 对 WS 长连接与大 DOM 性能；三端壳签名与分发策略。
## 6. 目标-覆盖对照（评审用）

| 目标条款 | 文档位置 | 状态 |
|---|---|---|
| Android/iOS 套壳打包 + 鸿蒙 Ark 套 WebView | §2.4 手机壳 | 已设计 |
| 内置 dsh-web-mobile（第三方引用）+ 不安装注入 | §1.3 | 已设计（与 --patch 注入同构，机制已验证） |
| 设置 UI 注入「手机访问」Tab | §2.1 client 半区 | 已设计 |
| 配对方式连接手机 | §1.4 / §2.2 | 已设计（一次性限时令牌 + QR；扫码/输入地址两种入口） |
| 局域网 + 公网 + 内网穿透（cpolar 也要能用） | §1.1/§2.1/§2.3 | 已设计（Host 改写反代；cpolar 指向 lanePort） |
| cpolar 直连失败根因 | §1.1 | 已结论（/api 信任栅栏仅 loopback） |
| 手机壳首页=配对管理、多配对、选一进入 | §0/§2.4 | 已设计（原型 mobile-shell.html） |
| 鸿蒙与另两端 UI 一致 | §2.5 | 已设计（共享设计令牌，见 §7） |
| 两个原型 HTML | docs/prototypes/ | 已交付 |

## 7. 三端设计令牌（H5 壳 / ArkUI 共用基线）

| 令牌 | 值（浅色/深色） | 用途 |
|---|---|---|
| --color-bg | #f4f6fa / #0f1115 | 页面底 |
| --color-panel | #ffffff / #171a21 | 卡片 |
| --color-line | #e3e9f2 / #2a2f3a | 分隔 |
| --color-text | #1b2230 / #e7eaf0 | 主文 |
| --color-text2 | #66748c / #9aa4b2 | 次文 |
| --color-accent | #4d6bfe | 主操作 |
| --color-ok / warn / err | #2fbf71 / #e5a13a / #e5484d | 状态 |
| --radius-card / --radius-btn | 14px / 10px | 圆角 |
| --sp-* | 4/8/12/16/24 | 间距 |
| --safe-top/bottom | env(safe-area-inset-*) | 安全区 |

实现时 H5 用 CSS 变量、ArkUI 用资源枚举（同一套值）；评审重点之一是确认基线。

## 8. 端口与命名约定（实施时统一）

- lanePort 默认 3091（写入 settings.yaml 的 dsh-desktop-tauriapp: 键 lane_port）；
- 配对协议：dsh-mobile://pair?token=<一次性令牌>&base=<候选地址，逗号分隔>（对齐 remote-web-ui 的 /m/?pair= 形态）；
- 内部包名：dsh-mobile-access；第三方布局包：@dsh-external/dsh-mobile-nav（保留 LICENSE 出处）；
- 令牌与设备会话存储：$DSH_HOME/dsh-mobile-access/ 下 0600 文件；接受配对后设备侧为 HttpOnly cookie 会话（无密码）。

## 9. 许可与依赖面（评审必读）

- 本仓库 LICENSE：**MIT**。
- dsh-pocket：**GPL-2.0** → 其代理/隧道代码**不可直接抄入本仓库**。策略：参照其
  行为**自行重实现** Host/Origin 改写反代与 cloudflared 下载（概念简单：node http +
  ws 透传 + Host 改写；多镜像/分块下载另写），或作为独立 GPL 子包分发。
- dsh-remote-web-ui（@linxin666）：**BSD-3-Clause** → 配对令牌/SSE 设备列表等设计
  模式可参考，附出处即可。
- dsh-web-mobile（@dsh-external/dsh-mobile-nav）：**MIT** 且**无运行时依赖**
  （lib/client.js 自包含）→ 可整包 vendor（lib/ + package.json + LICENSE 保留出处），
  走共享模块池 + --patch 注入。
- 信任栅栏佐证（本机 dsh-api-gateway/lib/index.js 实测 grep 命中 loopback/trusted
  相关引用）：与 pocket/remote-web-ui 文档相互印证；实施时以实测探活为准。

## 10. 信任栅栏与本方案的实测佐证（2026-08-22 本机 3080 实跑）

- 外部 Host 直连（模拟 cpolar）：页面根 200，/api/* 一律 **403**（栅栏拒绝）；
- loopback 直连：/api/* 为 404（放行，仅路由不存在）；
- 同一外部 Host 经「Host/Origin 改写反代」（127.0.0.1:3091 → 127.0.0.1:3080）：
  根 200、/api/* **404**（放行）——改写反代即 cpolar 场景的修复方案，机理验证闭环；
- 结论：页面能开=静态 200；会话/数据全空=/api 被 403。文档 §1.1 由此成立。
- cloudflared 下载镜像实测（darwin-arm64 asset，HEAD/跟随跳转 6s 超时）：
- 200 2.269636s :: github.com
- 200 2.206618s :: ghproxy.net
- 429 0.789682s :: gh.ddlc.top
- 200 1.042253s :: gh-proxy.com
- 
## 11. 补充实测与供应面
- WebSocket 栅栏：外部 Host 直连 WS upgrade → 403；经改写反代 → 400（栅栏已放行，
  400 系探针升级帧不完整/路径不同，实施时以 ws 客户端实测确认 101 与流式）。
- @dsh-external/dsh-mobile-nav npm 注册表 **404（未发布）**：vendor 只能走
  GitHub 仓库（mexiaosqwq/dsh-web-mobile）git archive/克隆，保留 LICENSE（MIT）；
  仓库内 lib/client.js ≈ 120KB，自包含。

## 12. 传输矩阵实测总结（2026-08-22 本机 3080/3091/3092）

| 请求 | 直连（外部 Host/Origin 模拟 cpolar） | 经改写反代 |
|---|---|---|
| GET / | 200 | 200 |
| GET /api/* | **403**（栅栏拒） | 404（放行） |
| WS /api/events.host | **403** | **101 OPEN**（upgrade 透传） |

结论：Host/Origin 改写反代（含 upgrade 处理）在 HTTP 与 WebSocket 两个层面
均可把外部域访问归一到 loopback 形态——§1.1 根因与 §2.3 传输路径全部实测闭环。

## 13. 实施依赖与前置清单（均为本轮已验证的事实）
- Node >= 22（本机 26.7.0）／npm 正常（本机 registry 可达；注意 @dsh-external/dsh-mobile-nav
  未在 npm 发布，走 git archive：gh repo archive 或 codeload tarball）。
- cloudflared 二进制：darwin-arm64/amd64、linux、windows 资产均存在于
  github.com/cloudflare/cloudflared releases latest；实测可用镜像：
  github 直连(2.3s) / ghproxy.net(2.2s) / gh-proxy.com(1.0s)；gh.ddlc.top 429 弃用；
  下载实现建议多线程分块 + 测速切换（参照 pocket tunnel.mjs 行为，自行重实现）。
- 测试工具：node ws 客户端（本机已临时安装于 /tmp 验证 WS 101；实施测试可
  devDependencies 引入 ws）。
- dsh 依赖面：dsh CLI 需支持 --profile/--patch/--trusted 相关（本机已验证
  --profile web --patch 组合）；profile 机制与 settings.yaml 键约定见 AGENTS.md。
- 设计-实现映射：§4 实施顺序的五步；每步验收锚点参见 §10/§12 实测基线。
