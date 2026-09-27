# dsh-mobile-access（内部包）

手机访问服务的 host+client 双半区实现，随 DeepSeek Harness Desktop 内置（共享模块池 + --patch 注入，不写 profile bundles）。

能力：Host/Origin 改写反代（HTTP+WS）、配对令牌、设备会话、SSE 状态、cloudflared 隧道、H5 手机壳接入（扫码/输入地址双入口）。

授权模型：一次性限时令牌 + HttpOnly 会话 cookie（无密码，对齐 dsh-remote-web-ui 配对机制）。

## 配对路由与控制端点鉴权

两种访问级别（#145 起）：**已配对设备**（隧道/局域网 + 有效会话 cookie）＝**完整访问**——dsh 端口的一切请求透传，lane 自有控制端点（配对/设备/隧道/事件）读写全部放行；**匿名**＝仅配对入口。属主（同机 loopback 直连、无 X-Forwarded-For）不再是更高一级权限，只决定「无 cookie 也放行」。

lane 自有控制面住在**保留命名空间** `/__dsh-mobile` 下（`lib/lane-routes.mjs` 是路由表的唯一事实源）；`/pair`、`/api/pair/*` 是**冻结别名**，仅为已发出的二维码与旧客户端存活，**不得新增**。

| 路径（规范形态 = `/__dsh-mobile` + 下表） | 已配对设备（隧道/局域网） | 匿名 |
|---|---|---|
| `/pair` | ✅ | ✅ 配对着陆页（凭 URL 令牌种 cookie） |
| `/api/pair/accept`（POST） | ✅ | ✅ 仅凭一次性令牌（错=403） |
| `/api/pair/info`（GET） | ✅ | ❌ 401 |
| `/api/pair/mint`（POST） | ✅ | ❌ 401 |
| `/api/pair/probe`（GET） | ✅ | ❌ 401 |
| `/api/pair/tunnel`（POST） | ✅ | ❌ 401 |
| `/api/pair/devices`（GET） | ✅ | ❌ 401 |
| `/api/pair/remove`（POST） | ✅ | ❌ 401 |
| `/api/pair/stop`（POST） | ✅（执行后自身 cookie 作废） | ❌ 401 |
| `/api/pair/events`（SSE） | ✅ | ❌ 401 |
| `/api/pair/cloudflared`（GET/POST） | ✅ | ❌ 401 |
| **其余所有路径**（含 dsh 的 `/api/*`、插件路由、WS upgrade、SSE） | ✅ **全量透传**（不截胡、不白名单） | ❌ 401 |

注意：
- 属主判定 = loopback Host（127.0.0.1/localhost）且无 `X-Forwarded-For`（隧道必经转发加插此头）；它只决定「无 cookie 也放行」，不产生额外权限（#145）。
- 透传不变式：命名空间（含冻结别名）之外的任何请求都由反代原样转发到 dsh，lane **绝不代答**——包括 `OPTIONS` 预检；`test/lane-routes.test.mjs` 与 `test/service.test.mjs` 锁死这条性质。
- 反代 auth 层不做任何路径前缀豁免——未命中的路径同样要求 cookie，
  防止「前缀豁免 + 上游路径归一化」鉴权绕过。
- 远程端能力位：已配对响应注入 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`（`OWNS_HOST_PATCH`），
  让 dsh 客户端把远程页面按「页面拥有 Host」处理（`ctx.connection.isLoopback === true`）→ 服务端设置 RPC
  正常发起，插件设置/dsh 设置/壳的手机访问信息全部可读可写（#145）。历史 `LOOPBACK_HOSTNAME_PATCH`
  （伪装 `location.hostname`）已被浏览器禁止、属死代码，已删除。
- CORS 仅放行回环源（`http://127.0.0.1:*` / `http://localhost:*`），供桌面设置页跨域读取；`Vary: Origin`。
- HTML 注入遇 gzip/br 压缩响应会跳过并触发 `onInjectSkip` 告警（不静默失败）。
- 设备会话存于内存（重启后需重新配对）；持久化（$DSH_HOME 0600 文件）为待办。
- host 半区 `apply(ctx)`：随 dsh web 进程装载自动监听 lane 并（按 `DSH_CLOUDFLARED_BIN`）启动
  cloudflared；`ctx dispose` 时关闭 lane 并回收隧道子进程。配置经环境变量
  `DSH_MOBILE_ENABLED / DSH_MOBILE_LANE_PORT / DSH_DESKTOP_PORT / DSH_CLOUDFLARED_BIN` 注入。

## 隧道与连接稳定性（WS 保活）

dsh 0.1.7 起网关自身每 2s 对 `/api/remote.mux` 发 Ping、连丢 2 次即 terminate（挂起/弱网极易触发，
见 #144）；中间隧道/代理（cpolar、cloudflared、反代等）对静默连接的空闲超时同样会掐断长连接，
手机端表现为 dsh「连接异常」
反复出现。lane 反代在 upgrade 后对 上游→客户端 方向做帧感知泵：空闲时在帧边界注入
WS ping（浏览器按 RFC 6455 自动回 pong），任意中间环节的空闲计时都会被重置；pong
超时则判定链路死亡并主动断开，让 dsh 客户端秒级重连。

settings.yaml（`dsh-desktop-tauriapp:` 块）：`ws_keepalive_ms`（ping 间隔，默认 15000，
0=关闭）、`ws_pong_timeout_ms`（判死超时，默认 10000）。注意：若隧道服务另有**非空闲类**
限制（如单连接时长上限、带宽限制），保活无法规避，需更换隧道方案或升级服务档位。

## 结构

- lib/index.mjs —— 插件入口（host 半区：装配反代/配对/SSE/隧道）
- lib/proxy.mjs —— 改写反代（HTTP + WebSocket upgrade 透传 + 页面注入）
- lib/pairing.mjs —— 配对令牌生命周期、设备会话、SSE 事件
- lib/links.mjs —— 二维码文本、局域网 IP 挑选、地址归一化
- client/client.js —— settings.section「手机访问」Tab（dsh client 半区）
- test/*.test.mjs —— node:test 单元测试

## 测试

```sh
node --test mobile/dsh-mobile-access/test
```