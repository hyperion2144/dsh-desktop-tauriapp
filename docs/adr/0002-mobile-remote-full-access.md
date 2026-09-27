# 远程端＝完整访问：已配对设备按「页面拥有 Host」处理（`ownsHost`），lane 控制面迁入保留命名空间

经隧道/局域网访问的**已配对设备**与同机属主**同级**：dsh 端口的一切请求全量透传，lane 自有控制端点（配对/设备/隧道/事件）读写全放行，唯一门禁是配对本身（匿名仅 `/pair` 与 `/api/pair/accept`）。技术上不靠伪装浏览器内建对象，而是用 dsh 官方能力位：已配对响应注入 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`，使 `ctx.connection.isLoopback` 无视页面 authority 为真，服务端设置类 RPC 恢复发起。

## Status

accepted（2026-09-27，issue #145；维护者原话：「所有都开放，我说了远程端所有都要能访问，只要是 dsh 的东西。远程不是轻量，是完整访问」）

## Context

dsh 0.1.7 客户端按**页面 hostname** 判定特权面：

```js
isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)
```

`isLoopbackHostname` 只认 `localhost` / `[::1]` / `127.x`。经 cpolar / 局域网域名访问时 hostname 是外部域名 → 判为「远程浏览器」→ 上游注释原文 `remote browsers stay process-local because settings RPCs are loopback-only` → `settingsScope` 落 memory 模式，插件设置、dsh 服务端设置、壳的「手机访问」信息全部读不到。

lane 早年试图把 `Location.prototype.hostname` 伪装成 `127.0.0.1`，但浏览器不允许伪造该属性，该补丁早已是死代码（源码注释自认「保留仅为记录」）。

## Considered Options

- **继续伪装 hostname**：浏览器禁止改写 `Location.prototype.hostname`——不可行（已被实测否证）
- **让上游放宽 loopback 栅栏**：改动 dsh 自身信任模型，且本仓无法控制版本节奏——否决
- **服务端开关（允许远程设置 RPC）**：dsh 0.1.7 无此配置项，等于自造协议——否决
- **远程只读设置（读开放、管受限）**：维护者明确否决——「远程不是轻量，是完整访问」
- **注入 `__DSH_TRANSPORT__ = { ownsHost: true }`**（选中）：dsh 官方契约 `ClientTransportHooks.ownsHost` 的语义正是「页面拥有 Host，特权面可达」；且只给该字段时 `rpc ?? createWebConnectionRpc(fetch, openStream)` 回落到默认 HTTP+WS 载体，请求仍全部经 lane 反代，不引入第二套通道

## Consequences

- 信任边界收敛为**配对**：设备会话（HttpOnly cookie，`$DSH_HOME/storages/mobile-access/pairing.json` 0600）即完整权限，可 mint 令牌、改第三方隧道地址、停隧道、移除设备；撤销靠「停止访问 / 移除设备」（立即作废设备表）。
- 匿名与未配对请求行为不变（仅配对入口），公网扫描拿不到任何特权面。
- lane 自有路由必须住在**保留命名空间** `/__dsh-mobile`（`lib/lane-routes.mjs` 是路由表唯一事实源），`/pair` 与 `/api/pair/*` 冻结为兼容别名（已发出的二维码与旧客户端），**不得新增**；命名空间（含别名）之外的一切路径——含 dsh 自有路由与 `OPTIONS` 预检——原样透传，lane 绝不代答（单测锁死）。
- 远程端 `isLoopback` 为真意味着**服务端设置可写**：手机改主题/语言会改到 Host 的共享设置（与桌面一致），这是选中该方案的必然代价，不是缺陷。
- 相关：连接稳定性与会话自愈见 #144（心跳覆盖 + 页面内轻量重连），与本决策正交。
