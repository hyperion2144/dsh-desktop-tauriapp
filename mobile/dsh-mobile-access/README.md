# dsh-mobile-access（内部包）

手机访问服务的 host+client 双半区实现，随 DeepSeek Harness Desktop 内置（共享模块池 + --patch 注入，不写 profile bundles）。

能力：Host/Origin 改写反代（HTTP+WS）、配对令牌、设备会话、SSE 状态、cloudflared 隧道、H5 手机壳接入（扫码/输入地址双入口）。

授权模型：一次性限时令牌 + HttpOnly 会话 cookie（无密码，对齐 dsh-remote-web-ui 配对机制）。

## 配对路由与控制端点鉴权

三种访问身份：**属主**（同机 loopback 直连 lane，无 X-Forwarded-For）、**已配对设备**（隧道 + 有效会话 cookie）、匿名。

| 路径 | 属主 loopback | 已配对设备（隧道） | 匿名（隧道） |
|---|---|---|---|
| `/pair` | ✅ | ✅ | ✅ 配对着陆页 |
| `/api/pair/accept`（POST） | ✅ | ✅ | ✅ 仅凭一次性令牌（错=403） |
| `/api/pair/mint`（POST） | ✅ | ❌ 401 | ❌ 401 |
| `/api/pair/devices`（GET） | ✅ | ✅ | ❌ 401 |
| `/api/pair/stop`（POST） | ✅ | ✅（执行后自身 cookie 作废） | ❌ 401 |
| `/api/pair/events`（SSE） | ✅ | ✅ | ❌ 401 |
| 其余所有路径（含 `/api/*`、WS upgrade） | ❌ 401（桌面用 3080 直连） | ✅ 透传 | ❌ 401 |

注意：
- 属主判定 = loopback Host（127.0.0.1/localhost）且无 `X-Forwarded-For`（隧道必经转发加插此头）。
- 反代 auth 层不做任何路径前缀豁免——未在路由表中的 `/api/pair/*` 请求同样 401，
  防止「前缀豁免 + 上游路径归一化」鉴权绕过。
- CORS 仅放行回环源（`http://127.0.0.1:*` / `http://localhost:*`），供桌面设置页跨域读取；`Vary: Origin`。
- HTML 注入遇 gzip/br 压缩响应会跳过并触发 `onInjectSkip` 告警（不静默失败）。
- 设备会话存于内存（重启后需重新配对）；持久化（$DSH_HOME 0600 文件）为待办。
- host 半区 `apply(ctx)`：随 dsh web 进程装载自动监听 lane 并（按 `DSH_CLOUDFLARED_BIN`）启动
  cloudflared；`ctx dispose` 时关闭 lane 并回收隧道子进程。配置经环境变量
  `DSH_MOBILE_ENABLED / DSH_MOBILE_LANE_PORT / DSH_DESKTOP_PORT / DSH_CLOUDFLARED_BIN` 注入。

## 隧道与连接稳定性（WS 保活）

dsh 客户端对 `/api/remote.mux` 复用 WebSocket 无应用层心跳，中间隧道/代理（cpolar、
cloudflared、反代等）对静默连接的空闲超时会揧断长连接，手机端表现为 dsh「连接异常」
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