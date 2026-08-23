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
entry/src/main/module.json5           module 配置 + INTERNET/CAMERA 权限
entry/src/main/ets/entryability/     EntryAbility（深链透传 + 状态栏/系统栏配置）
entry/src/main/ets/common/           Theme.ets（设计令牌）、PairLogic.ets（配对逻辑）
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
hvigorw --mode module -p module=entry@default assembleHap
# 产物：entry/build/default/outputs/default/entry-default-unsigned.hap
```

> 无签名配置时产出 `-unsigned.hap`（模拟器可用）；真机安装需先在
> `build-profile.json5` 配置自己的签名（DevEco 自动签名会写入，仓库内**不提交**签名
> 材料与密码）。命令行构建需 `hvigor/hvigor-config.json5` 保持 `daemon: false`（否则
> 后台 daemon 缓存旧 PATH 导致 java 找不到）。

## 待办

- 明文 HTTP 访问策略（module.json5 网络安全配置）待 DevEco 真机联调按当前 SDK 补全；
- ArkWeb 对 WS 长连接与大 DOM 性能需真机验证（design §5 开放问题）。
