# dsh-desktop-tauriapp 上下文

把 DeepSeek Harness（dsh）经由本仓库的桌面壳与移动壳，装配成可编辑代码的跨平台 AI 代码工作台：dsh 生态插件（第三方 + 自研）经 --patch 注入链路集成，better-sidebar 右侧栏承载代码编辑器。

## Language

**工作台 Workbench**:
dsh 内的一组插件装配结果：左侧栏 + 对话区（dsh 原生）与右侧栏（better-sidebar）共同构成的代码编辑体验；本仓库只做装配与补缺（LSP 桥），不重做布局。
_Avoid_: IDE、三栏布局（暗示自建布局）

**编辑器插件 Editor Plugin**:
注册进 better-sidebar 右侧栏的自研插件，提供带 LSP 的代码编辑（桌面/浏览器）；移动端不装此插件。
_Avoid_: 代码编辑器面板、工作区插件

**LSP 运行时 LSP Runtime**:
语言服务器进程所在的执行位置（服务端进程 / 浏览器内 WASM / 远端），决定编辑器插件的能力边界；本仓库桌面与浏览器承诺 LSP，移动端不承诺。
_Avoid_: 语言服务器（那是进程本身，不是位置）

**移动端编辑器 Mobile Editor**:
better-sidebar 自带的文本编辑器（未接 LSP），手机壳直接复用。
_Avoid_: 轻量编辑器、简易编辑器

**移动端布局 Mobile Layout**:
移动端窄屏适配（<1024px 抽屉/浮层/sheet、安全区、composer 重排）由上游插件
`mexiaosqwq/dsh-web-mobile`（git 子模块 `mobile/dsh-mobile-nav`，上游 v2.3.0 起包名
`dsh-web-mobile`，前名 `@dsh-external/dsh-mobile-nav`）原样提供，本仓库不再自研移动布局；桌面 ≥1024px 完全 no-op。
_Avoid_: 移动端自建布局（重做布局）、移动三页导航（已废弃）