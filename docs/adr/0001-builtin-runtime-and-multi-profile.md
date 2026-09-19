# 内置 Node/dsh 运行时与 dsh 来源两态、per-profile 端口

桌面壳此前依赖用户系统里的 node/npm/dsh（PATH/DSH_BIN 查找），且是单窗口单 dsh 实例、全局单端口 3080。2026-09 wayfinder map #80 拍板三项相互纠缠的结构决策，一旦实现便难以低成本回退：

1. **内置 = 完全打包**：官方 Node 二进制做 Tauri sidecar + dsh npm 包进 resources，首启解压到应用数据目录。拒绝了两条替代路径——首启下载（首启需网络，桌面「双击即用」定位不保）与复用系统 node（回到了「依赖外部环境」的老问题）。
2. **dsh 来源两态：内置（默认）/ 外部**，不设「自动」三态。外部模式的「自动检测」（DSH_BIN → PATH → npm 全局）只用于定位与版本展示。拒绝三态的理由：「自动」让「到底在跑哪个 dsh」变模糊，排障成本高于便利。
3. **每 profile 独立端口**（web=3080 不变、desktop=3081、其余递增；lane 反代同规则错开）+ **托盘按 profile 多开窗口**（每 profile 至多一窗）。这把「全局单端口 configured_port()」的隐含假设升级为显式的 profile→端口→实例绑定。

默认 profile 只对全新安装切 desktop，存量用户保持 web 不动——存量环境的插件/手机配对/脚本都挂在旧 profile 习惯上，静默搬家违背「无缝」初衷；但 dsh 来源默认内置对所有用户生效（#53 保险丝兜插件兼容风险）。

## Consequences

- 安装包体积预计 +80~150MB（Node + dsh 依赖树）；mac 签名公证与 Windows Defender 误报需在 CI 处理。
- 多开隔离已拍板（#93）：方案 B——直接用默认 DSH_HOME，不做独立 HOME/派发；多窗口 = 同 HOME 多 profile 实例不同端口，数据共享是设计本意；唯一主动解决项是 lane 反代目标跟随焦点窗口（#94）；硬约束：同 HOME 同 profile 双实例绝对禁止、quarantine 按 profile 分桶；方案 A（含壳设置搬迁前置）留 map 雾区。
- 存量用户升级后 dsh 版本可能从外部版跳到内置版，插件兼容问题由 #53 启动保险丝兜底。
