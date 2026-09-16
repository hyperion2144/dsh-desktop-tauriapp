# dsh-mobile-harmony（鸿蒙壳）

HarmonyOS NEXT 手机访问壳（ArkTS + ArkWeb），与 H5 壳 / Expo RN 壳共用设计令牌
（`common/Theme.ets` = DeepSeek 官方配色浅色主题）。

- 配对管理页（列表/添加/删除）→ ArkUI 原生实现（`pages/Index.ets`）
- 添加配对 → `pages/AddPair.ets`：扫码（ScanKit 相机）或输入地址
- dsh 页面 → ArkWeb 组件（`pages/WebPage.ets`）；移动布局由页面内注入的 dsh-mobile-nav
  生效，ArkWeb 不做 DOM 注入
- 配对输入：`dsh-mobile://pair?token=..&base=..` 深链（EntryAbility 透传）或
  `host:端口` + 独立令牌；解析逻辑 `common/PairLogic.ets`（自 shell-web/lib.mjs 移植）
- 权限：`ohos.permission.INTERNET` + `ohos.permission.CAMERA`（扫码配对）

## 结构

```
AppScope/app.json5                    应用名/包名 app.dsh.mobile
build-profile.json5                   工程构建配置（无签名，签名本地自配）
hvigorfile.ts / oh-package.json5      hvigor 工程文件
entry/src/main/module.json5           module 配置 + INTERNET/CAMERA/KEEP_BACKGROUND_RUNNING/GET_NETWORK_INFO 权限 + backgroundModes
entry/src/main/ets/entryability/     EntryAbility（深链透传 + 状态栏/系统栏配置 + 前后台生命周期）
entry/src/main/ets/common/           Theme.ets（设计令牌）、PairLogic.ets（配对逻辑）
                                     SessionGuard.ets / GuardScript.ets / NetworkWatcher.ets / BackgroundKeeper.ets（#67 连接自愈）
entry/src/main/ets/pages/            Index.ets（配对管理）、AddPair.ets（扫码/输入）、WebPage.ets（ArkWeb）
entry/src/main/resources/             media 图标（桌面鲸鱼同款）、string/color、profile（pages）
```

## 构建

> 鸿蒙构建链依赖 DevEco Studio / HarmonyOS SDK，**不随 GitHub CI 发布**（Android/iOS 由
> CI 出包，鸿蒙需本地用 DevEco 构建）。源码骨架已随仓库提交。

### 方式一：DevEco Studio（推荐，自动签名）

1. DevEco Studio 打开 `mobile/harmony/`
2. File → Project Structure → Signing Configs → 登录华为账号自动签名
3. 运行 `entry` module 到真机/模拟器

### 方式二：命令行 hvigorw（构建 HAP）

```sh
cd mobile/harmony
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export JAVA_HOME=/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home
export PATH="$JAVA_HOME/bin:/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin:/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin:$PATH"
ohpm install
# 项目内没有 hvigorw 包装脚本，用的是 DevEco 自带的（已在上面 PATH 里）
hvigorw --mode module -p module=entry@default assembleHap
# 产物：entry/build/default/outputs/default/entry-default-signed.hap（配了签名时）
```

> 无签名配置时产出 `-unsigned.hap`（模拟器可用）；真机安装需先在
> `build-profile.json5` 配置自己的签名（DevEco 自动签名会写入，仓库内**不提交**签名
> 材料与密码）。命令行构建需 `hvigor/hvigor-config.json5` 保持 `daemon: false`（否则
> 后台 daemon 缓存旧 PATH 导致 java 找不到）。

## 连接自愈（#67）

dsh 页面的 `/api/remote.mux` WebSocket 由页面 JS 在 ArkWeb 内部创建，壳拿不到句柄；
而 dsh 客户端只在 `close`/`error` 到达时才重连。退后台时连接会被判死（dsh mux 服务端
2s ping、连丢 2 次即 `terminate()`），回前台页面不一定收到 `close`——于是「连接异常」
不自愈。壳侧四道防线（均以 `SessionGuard` 为中心）：

| 机制 | 文件 | 作用 |
|---|---|---|
| 后台长时任务 | `BackgroundKeeper.ets` + `module.json5` | 退后台尽量不挂起，连接不断 |
| 回前台自愈 | `SessionGuard.ets` | 离开 ≥10s 直接重载；短暂离开探针确认 |
| 网络换代接管 | `NetworkWatcher.ets` | Wi-Fi ↔ 蜂窝 / 断网恢复时探针 + 重载 |
| 渲染崩溃重载 | `WebPage.ets` + `SessionGuard` | 白屏时重载（探针读不到任何东西） |

防风暴：连续失败退避（2s → 翻倍 → 上限 30s）+ 重载后 5s 静默期（避开「刚修好又判它坏」）。
所有判定与动作都写 hilog（TAG = `SessionGuard` / `NetworkWatcher` / `BackgroundKeeper`）。

### 真机验收清单

需真机（`hdc list targets` 能看到设备）；用 `hdc hilog | grep -E 'SessionGuard|NetworkWatcher'` 看判定。

- [ ] 退后台 60s 回前台：连接自愈（dsh 健康指示器由「连接异常」回正常），日志出现 `suspend -> reload`；
- [ ] Wi-Fi ↔ 蜂窝互切 3 次：连接自愈，且 hilog 无密集 reload（去抖 + 退避生效）；
- [ ] 弱网 60s：不出现永久「连接异常」；
- [ ] 长时任务验收：日志 `continuous task started` = 通过；`refused (code=9800005)` = 模式不被白名单接受，
      此时应确认回前台自愈仍能兜住（记录结论，必要时换 `backgroundModes` 或改走纯自愈路径）。

## 待办

- 明文 HTTP 访问策略（module.json5 网络安全配置）待 DevEco 真机联调按当前 SDK 补全；
- ArkWeb 对 WS 长连接与大 DOM 性能需真机验证（design §5 开放问题）。
- `setSocketIdleTimeout` 需 API ≥ 21（工程 compatibleSdkVersion 为 12），低版本走 try/catch 降级。
- 工程 `targetSdkVersion`/`compatibleSdkVersion` 仍为 `5.0.0(12)`，本机 SDK 已是 API 26，待定是否升级。
