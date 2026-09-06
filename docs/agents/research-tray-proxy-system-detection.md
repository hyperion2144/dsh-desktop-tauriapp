# 系统代理检测机制事实调查（macOS / Windows）

> 来源票：GitHub issue #30《系统代理检测机制事实调查（macOS/Windows）》
> 调研日期：2026-09-06；本机实测平台：macOS 26.6.2 (Build 25G83)
> 目标：dsh spawn 时「继承系统代理」——在 macOS / Windows 上用 Rust 读出当前生效的系统代理，
> 优先零新增依赖（标准库 Command / 既有 windows-sys）。

## TL;DR（推荐机制一句话）

**macOS 用 `std::process::Command` 调 `scutil --proxy` 解析输出（零新依赖）；Windows 用既有依赖 windows-sys 加一个 feature `Win32_System_Registry` 走 `RegGetValueW` 读 HKCU\…\Internet Settings（零新增 crate）；读到 PAC（`ProxyAutoConfigEnable=1` / `AutoConfigURL` 存在）时不注入具体代理 URL，只保证 NO_PROXY 含本地回环。**

---

## 1. macOS 事实

### 1.1 命令是 `scutil --proxy`（单数），不是 `--proxies`

本机（macOS 26.6.2）实测 `scutil --proxies` 报错：`scutil: unrecognized option '--proxies'`，
其 usage 明确列出 `or: scutil --proxy` / `show "proxy" configuration`。
网络上不少文章误写为 `--proxies`，实现时以 `--proxy` 为准。

- 本机 usage 输出（一手实测，见 §1.2/§1.3）
- scutil man page 源码（apple-oss-distributions/configd）：https://github.com/apple-oss-distributions/configd/blob/main/scutil.tproj/scutil.8
- ss64 命令参考（二手交叉印证）：https://ss64.com/mac/scutil.html

### 1.2 真实输出样例（本机实测，代理全关——配置过但未启用）

```
$ scutil --proxy
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
```

### 1.3 真实输出样例（本机实测，实验性开启 HTTP/HTTPS/SOCKS/PAC 后；实验已即时恢复原状并校验）

```
$ scutil --proxy
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:33331/commands/pac
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}
```

### 1.4 键语义

| scutil 键 | 类型 | 语义 |
|---|---|---|
| `HTTPEnable` / `HTTPProxy` / `HTTPPort` | int / string / int | HTTP 代理开关 / 主机 / 端口 |
| `HTTPSEnable` / `HTTPSProxy` / `HTTPSPort` | int / string / int | HTTPS 代理开关 / 主机 / 端口 |
| `SOCKSEnable` / `SOCKSProxy` / `SOCKSPort` | int / string / int | SOCKS 代理开关 / 主机 / 端口 |
| `ProxyAutoConfigEnable` / `ProxyAutoConfigURLString` | int / string | PAC 开关 / PAC 脚本 URL |
| `ExceptionsList` | string array | 代理例外（bypass）列表，可混含域名、`*.wildcard`、CIDR、`<local>` |
| `FTPEnable` / `FTPProxy` / `FTPPort` | 同上 | FTP 代理（本机从未配置 FTP，键完全缺席） |
| `FTPPassive` | int | FTP 被动模式，与代理选择无关 |

观察到的输出规则（本机实测）：
- 未配置过的协议族（本例 FTP）**整组键缺席**；
- 配置过但禁用的协议（本例 HTTP/HTTPS/SOCKS/PAC）输出 `XxxEnable : 0`，此时 Host/Port 键可能仍在（启用样例可见）也可能不在（全关样例中 HTTPProxy/HTTPPort 缺席）——**读取时必须以 `XxxEnable == 1` 为准，不得假设 Host/Port 键存在**；
- 输出是 NeXT 风格 plist 字典，文本行格式 `<key> : <value>`，数组为缩进块，文本解析简单可靠。

### 1.5 「全局当前生效」如何取：PrimaryService 规则

macOS 的代理设置按**网络服务**（Wi-Fi、Ethernet…）存储，但 `scutil --proxy` 返回的是
**当前主网络服务（拥有默认路由的服务）的生效代理配置**。本机实测证据：

```
$ networksetup -listnetworkserviceorder
(1) Ethernet   (Device: en0)
(2) Thunderbolt Bridge (Device: bridge0)
(3) Wi-Fi      (Device: en1)
(4) Tailscale  (Device: )

$ echo "show State:/Network/Global/IPv4" | scutil
<dictionary> {
  PrimaryInterface : en1
  PrimaryService : 98673024-DD19-4925-A8F4-01DB03CFFD1E   ← Wi-Fi
  Router : 192.168.3.1
}
```

服务序第一的 Ethernet 并不是主服务（无链路）；`scutil --proxy` 返回的是 Wi-Fi（en1）的配置，
与 `State:/Network/Global/IPv4 → PrimaryService` 一致。**结论：调 `scutil --proxy` 即得
「全局当前生效」值，无需自己枚举服务。**

键的正式定义见 Apple SystemConfiguration schema：
- `kSCNetworkProtocolTypeProxies`：https://developer.apple.com/documentation/systemconfiguration/kscnetworkprotocoltypeproxies
- System Configuration 框架：https://developer.apple.com/documentation/systemconfiguration
- 等价程序内 API：`SCDynamicStoreCopyProxies`（scutil --proxy 的库形态）

### 1.6 networksetup 是否更可靠？

不。两者读同一套数据但视角不同：

| 维度 | `scutil --proxy` | `networksetup -getwebproxy <service>` 等 |
|---|---|---|
| 读到的是 | **动态存储当前生效值**（主服务） | Setup: 偏好中**指定服务**的配置值 |
| 需要服务名 | 否 | 是（名字必须精确匹配，如 "Wi-Fi"；改名/本地化即翻车） |
| 输出格式 | plist 字典，易解析 | 人类可读键值（`Enabled: Yes/No`、`Server`、`Port`），也可解析 |
| 一次拿全 | 是（HTTP/HTTPS/SOCKS/PAC/Exceptions 一次返回） | 否，每种协议一条命令（-getwebproxy / -getsecurewebproxy / -getsocksfirewallproxy / -getautoproxyurl / -getproxybypassdomains） |
| MDM/描述文件锁定场景 | 反映生效值 | 可能与生效值不一致 |

结论：**「读当前生效」用 scutil；networksetup 只在需要按服务读/写配置时才有意义。**
（本机 networksetup 交叉验证：Wi-Fi 的 web/secure/socks 均为 Enabled: No 但残留
Server 127.0.0.1 Port 7897——正是「配置过但禁用」形态，与 scutil 的 Enable:0 对应。）

### 1.7 Rust 零新依赖读取途径

```rust
use std::process::Command;

fn scutil_proxy_dict() -> std::io::Result<String> {
    let out = Command::new("scutil").arg("--proxy").output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
```
解析：逐行 `split_once(" : ")` 取标量键；`ExceptionsList` 数组块取缩进行（`N : value`）。
备选（不推荐现在做）：`system-configuration` crate（https://docs.rs/system-configuration）
是 SystemConfiguration 的高级绑定，但官方 README 明言「only implements a small part」，
其模块（dynamic_store 等）**不含代理读取 API**，用它仍要自己写 `SCDynamicStoreCopyProxies` FFI，
相对 Command 方案无收益。

---

## 2. Windows 事实

### 2.1 注册表位置与键语义

键：`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings`

官方依据（Microsoft Learn, Handling Authentication）：
> "INTERNET_OPEN_TYPE_PRECONFIG looks at the registry values ProxyEnable, ProxyServer, and ProxyOverride.
> These values are located under HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings."
> https://learn.microsoft.com/en-us/windows/win32/wininet/handling-authentication

| 值 | 类型 | 语义 |
|---|---|---|
| `ProxyEnable` | REG_DWORD | `1`=启用手动代理，`0`=停用（残留的 ProxyServer 字段不代表生效） |
| `ProxyServer` | REG_SZ | 手动代理服务器，两种格式见 §2.2 |
| `ProxyOverride` | REG_SZ | 代理例外（bypass）列表，**分号分隔**；`<local>` 特殊条目=「不对不含点号的简单主机名走代理」（对应设置界面 "Don't use the proxy server for local addresses" 勾选）；支持 `*.domain.com` 通配符 |
| `AutoConfigURL` | REG_SZ | PAC 脚本 URL；实践上该值存在即「Use setup script」生效（取消勾选会移除值） |

补充：组策略可把代理改为每机（HKLM）并锁定——
`HKLM\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings`（如 `ProxySettingsPerUser=0`、
`HKLMProxyEnable` 等，见 https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-ie-clientnetworkprotocolimplementation-hklmproxyenable ）。
企业受管机器上 HKCU 值可能非生效值（见 §5 边界情形）。

### 2.2 ProxyServer 的两种取值格式

1. **单一格式**：`"host:port"`（如 `127.0.0.1:7897`）——对 http/https/ftp 全部协议生效；省略端口时按协议默认（http=80，https=443）。
2. **分协议格式**：`"http=h:p;https=h:p;ftp=h:p;socks=h:p"`（分号分隔、`协议=主机:端口`；旧式 `secure=` 等价 `https=`）——只写出的协议走对应代理；`socks=` 条目为 SOCKS 代理。

官方语系佐证：
- Microsoft Edge（Chromium 同语法族）`--proxy-server` 文档：
  "Provide a semicolon-separated mapping of scheme to url/port pairs. For example, --proxy-server="http=proxy1:8080;ftp=ftpproxy" …"
  https://learn.microsoft.com/en-us/deployedge/edge-learnmore-cmdline-options-proxy-settings
- WinHTTP 的代理/绕过字符串文档（分号分隔列表语义）：
  https://learn.microsoft.com/en-us/windows/win32/api/winhttp/ns-winhttp-winhttp-proxy_info
- WinINet 按连接读取这些值的机制（INTERNET_PER_CONN_PROXY_SERVER 等）：
  https://learn.microsoft.com/en-us/windows/win32/api/wininet/ns-wininet-internet_per_conn_optiona

### 2.3 ProxyOverride 能否直接当 NO_PROXY 用？

**结论：语义同源、可直接映射，但要先做三处规范化（`;`→`,`、`<local>`、`*.` 通配），不能原样赋值。**

- 依据一（语义同源）：`ProxyOverride` 就是 WinINet 的 bypass 列表，`NO_PROXY` 是 Unix 世界的同一概念；
  bypass 列表格式为分号分隔（https://learn.microsoft.com/en-us/windows/win32/api/winhttp/ns-winhttp-winhttp-proxy_info ）。
- 依据二（`<local>` 语义）："In the name ProxyOverride … at the end also enter <local> … in this way you will see
  that the check will be activated on the box 'Don't use the proxy server for local (intranet) addresses'"
  （Microsoft Learn Q&A：https://learn.microsoft.com/en-in/answers/questions/1180951/registry-option-do-not-use-proxy-server-for-local ；Server Fault 同题：https://serverfault.com/questions/1122990/registry-option-do-not-use-proxy-server-for-local-addresses ）。
- 规范化规则：
  - 分号 `,`：`ProxyOverride` 用 `;`，`NO_PROXY` 用 `,`；
  - `<local>` → 展开为 `localhost,127.0.0.1,::1`（NO_PROXY 消费者不识别 `<local>`）；
  - `*.example.com` → `.example.com`（多数 NO_PROXY 消费者的后缀匹配语义；curl/Go 均按「等于或以 .entry 结尾」匹配）；
  - 裸 `*`（绕过一切）→ 保留 `*`（NO_PROXY 的 `*` 同义，curl/Go 识别）。
  - macOS 侧 ExceptionsList 中的 CIDR（如 `192.168.0.0/16`）NO_PROXY 无标准语义，多数消费者不支持 → 建议丢弃并记日志（字面透传通常无害但也不生效）。

### 2.4 PAC（AutoConfigURL）场景与降级

PAC 的正牌求值方式是 per-URL 调用 `WinHttpGetProxyForUrl`（下载并执行 PAC 脚本，返回 WINHTTP_PROXY_INFO）：
https://learn.microsoft.com/en-us/windows/win32/winhttp/winhttp-autoproxy-api 、
https://learn.microsoft.com/en-us/windows/win32/api/winhttp/ns-winhttp-winhttp_autoproxy_options

但桌面壳的诉求只是给子进程注入环境变量，**环境变量体系表达不了 PAC**。
官方未给「Manual 与 PAC 同时勾选时的静态优先级」文档；工程共识（参考 aws/amazon-ssm-agent 的
proxy_windows.go、bruno 的 system-proxy 解析等实现）是：读到 PAC 时放弃静态求值。

**降级建议（按优先级）：**
1. `AutoConfigURL` 存在（或 macOS `ProxyAutoConfigEnable=1`）时，**不注入 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY**——注入一个猜错的具体代理比不注入更糟；
2. 仍注入 `NO_PROXY=localhost,127.0.0.1,::1`，保证桌面壳↔本机 dsh web 链路绝不进代理；
3. 日志记一条「系统代理为 PAC（<url>），已跳过代理注入」，给用户可见的提示钩子；
4. 未来若要完整 PAC：Windows 加 feature `Win32_Networking_WinHttp` 用 `WinHttpGetProxyForUrl` 按目标 URL 求值（只能按 URL 逐个求，不适合做全局 env），或引入 `sysproxy` crate。

---

## 3. 字段映射表

### 3.1 macOS（scutil --proxy → env）

| scutil 键 | 条件 | 注入 env |
|---|---|---|
| `HTTPEnable=1` + `HTTPProxy` + `HTTPPort` | 端口缺省按 80 | `HTTP_PROXY`/`http_proxy` = `http://<host>:<port>` |
| `HTTPSEnable=1` + `HTTPSProxy` + `HTTPSPort` | 端口缺省按 443 | `HTTPS_PROXY`/`https_proxy` = `http://<host>:<port>` |
| `SOCKSEnable=1` + `SOCKSProxy` + `SOCKSPort` | 端口缺省按 1080 | `ALL_PROXY`/`all_proxy` = `socks5://<host>:<port>`（多数 CLI 工具才认，属尽力而为） |
| `ProxyAutoConfigEnable=1` | — | 不注入代理 env（降级，见 §2.4） |
| `ExceptionsList` | 去重、去 CIDR、`*.x`→`.x`、`<local>`→localhost 组 | `NO_PROXY`/`no_proxy`（**始终合并** `localhost,127.0.0.1,::1`） |

### 3.2 Windows（HKCU\…\Internet Settings → env）

| 注册表值 | 条件 | 注入 env |
|---|---|---|
| `ProxyEnable=1` + `ProxyServer`（单一格式 `h:p`） | — | `HTTP_PROXY`、`HTTPS_PROXY`（大小写各一）= `http://h:p` |
| `ProxyEnable=1` + `ProxyServer`（分协议格式） | 仅取 `ProxyEnable=1` 且分协议条目存在的协议 | `http=`→`HTTP_PROXY`；`https=`→`HTTPS_PROXY`；`socks=`→`ALL_PROXY`（`socks5://`）；未写出的协议不注入 |
| `ProxyOverride` | 规范化见 §2.3 | `NO_PROXY`/`no_proxy`（**始终合并** `localhost,127.0.0.1,::1`） |
| `AutoConfigURL` 存在 | — | 不注入代理 env（降级，见 §2.4）；`ProxyOverride` 若同时存在仍可注入 NO_PROXY |

---

## 4. Rust 封装选型

| 方案 | 新增依赖 | 评价 |
|---|---|---|
| **macOS：`Command("scutil")` + 文本解析**（推荐） | 0 | std::process::Command，~50 行；直接拿「生效值」；scutil 系统自带、接口稳定 |
| macOS：`system-configuration` crate | +1 crate | 无代理 API，仍要手写 `SCDynamicStoreCopyProxies` FFI，无收益（https://docs.rs/system-configuration ） |
| **Windows：windows-sys 0.61.2 加 feature `Win32_System_Registry`**（推荐） | 0 crate / +1 feature | 仓库已依赖 windows-sys 0.61.2（Cargo.toml 现有 features：`Win32_Foundation`、`Win32_System_Threading`、`Win32_UI_Shell`、`Win32_UI_WindowsAndMessaging`）；`RegGetValueW` 一次读一个值，REG_SZ/REG_DWORD 各一次调用，~60 行。模块存在性已核实：https://docs.rs/windows-sys/latest/windows_sys/Win32/System/Registry/index.html |
| Windows：`Command("reg.exe query …")` | 0 | 连 feature 都不加；但 spawn 进程 + 解析输出更脆（字段间距/转义），作为备选 |
| 跨平台 crate `sysproxy`（zzzgydi/clash-verge 系） | +1 crate | 仅 401 行/16KB（https://lib.rs/crates/sysproxy ），get+set 全平台；本票只需「读」，自写更省供应链面。**若后续要做「托盘设置系统代理」（写），sysproxy 就值得引入**（https://github.com/zzzgydi/sysproxy-rs ） |
| Windows crate `winreg` | +1 crate | 成熟但 windows-sys 已在依赖里，没必要 |

**选型结论：macOS Command 调 scutil；Windows windows-sys + `Win32_System_Registry` feature（`RegGetValueW`）。零新增 crate。**

### 注入点（贴合本仓库现状）

`desktop/src-tauri/src/lib.rs` 两处 dsh spawn 已有 `.env(...)` 注入链（约 L524-530、L771-776，
`.env("PATH", …)` / `DSH_MOBILE_*` / `DSH_DESKTOP_PORT`），代理继承只需在链上追加
`cmd.env("HTTP_PROXY", …)` 等；`Command` 默认继承父进程环境，未命中任何代理时无需动作。
注意桌面壳自身对 dsh web 的健康检查是裸 TCP 连接（不走代理代理栈），lane 反代同理，
不受系统代理影响；`NO_PROXY` 里的回环条目是给子进程（node/dsh 及其派生 CLI 工具）保底用的。

---

## 5. 边界情形清单（每条一句处理建议）

1. **代理关闭但字段残留**（ProxyEnable=0 / HTTPEnable=0 但 Host/Port 有值）：以 Enable 标志为准，禁用即整体不注入。
2. **macOS 多网络服务/VPN**：`scutil --proxy` 已按默认路由主服务返回生效值，不要自己枚举服务（Tailscale 类不分流默认路由时不会干扰结果）。
3. **Windows 企业策略锁定**（HKLM Policies / ProxySettingsPerUser=0）：HKCU 值可能非生效值；可选先查策略键，读到策略托管时照常读但记日志（v1 可忽略，家用场景为主）。
4. **分协议部分启用**：只注入「Enable=1 且分协议条目存在」的协议；`ProxyEnable=1` 但 ProxyServer 为分协议格式且缺 `http=` 条目时，HTTP 不注入。
5. **单一格式 vs 分协议格式判定**：含 `=`（如 `http=`）即分协议格式；否则整体视为 `h:p` 应用到 http/https。
6. **缺端口**：`host` 无端口按 http=80/https=443/socks=1080 补全；macOS 恒有 Port 键，此规则主要为 Windows。
7. **PAC 场景**：不注入具体代理 env，只注入保底 NO_PROXY 并记日志（§2.4）。
8. **SOCKS-only**（macOS 只开 SOCKS / Windows 仅 `socks=` 条目）：注入 `ALL_PROXY`，但注明部分工具不识别，属尽力而为。
9. **ExceptionsList/ProxyOverride 规范化**：`;`→`,`、`*.x`→`.x`、`<local>`→localhost/127.0.0.1/::1、CIDR 丢弃并记日志、始终合并回环四件套。
10. **带认证的代理**：两平台的凭据都不在可读配置里（Windows 在凭据库、macOS 走 keychain/弹窗），env 无法携带 → 不注入该协议并记日志，交由子进程自行处理。
11. **大小写兼容**：env 同时设 `HTTP_PROXY`/`http_proxy`、`HTTPS_PROXY`/`https_proxy`、`NO_PROXY`/`no_proxy`（Windows 侧工具对大小写约定不一）。
12. **代理主机是 IPv6 字面量**：注入 URL 时用 `http://[::1]:port` 方括号形式。
13. **scutil 输出解析容错**：键缺失视为未启用；解析失败不阻塞 spawn（吞错降级 + 日志），代理继承是增强不是前提。

---

## 6. 推荐实现（关键 Rust 伪代码）

```rust
#[derive(Default)]
struct SystemProxy { http: Option<String>, https: Option<String>, socks: Option<String>, no_proxy: String }

#[cfg(target_os = "macos")]
fn detect() -> Option<SystemProxy> {
    // 1) Command::new("scutil").arg("--proxy").output()
    // 2) 逐行解析 "Key : Value"；HTTPEnable==1 → http = http://{HTTPProxy}:{HTTPPort}
    //    HTTPSEnable==1 → https；SOCKSEnable==1 → socks5://…
    // 3) ProxyAutoConfigEnable==1 → 返回 None（仅保底 no_proxy），日志提示 PAC
    // 4) ExceptionsList 规范化后并入 no_proxy
}

#[cfg(windows)]
fn detect() -> Option<SystemProxy> {
    // Cargo.toml: windows-sys features 追加 "Win32_System_Registry"
    // use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ, RRF_RT_REG_DWORD};
    // subkey = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
    // ProxyEnable = RegGetValueW(HKEY_CURRENT_USER, subkey, w!("ProxyEnable"), RRF_RT_REG_DWORD, …) == 1
    // ProxyServer = RegGetValueW(…, RRF_RT_REG_SZ, …)
    //   含 '=' → 分协议解析 "http=…;https=…;socks=…"；否则整体为 host:port
    // ProxyOverride → §2.3 规范化；AutoConfigURL 存在 → 只返回保底 no_proxy
}
```

交付时注意：解析逻辑放独立模块并配单测（用 §1.2/§1.3 样例做 fixture）；Windows 编译由 CI 把关
（本地无 windows 目标）。

## 7. 参考来源

- scutil man page 源码（apple-oss-distributions）：https://github.com/apple-oss-distributions/configd/blob/main/scutil.tproj/scutil.8
- ss64 scutil 参考：https://ss64.com/mac/scutil.html
- Apple `kSCNetworkProtocolTypeProxies`：https://developer.apple.com/documentation/systemconfiguration/kscnetworkprotocoltypeproxies
- Apple System Configuration：https://developer.apple.com/documentation/systemconfiguration
- Microsoft Learn「Handling Authentication」（HKCU 三键出处）：https://learn.microsoft.com/en-us/windows/win32/wininet/handling-authentication
- Microsoft Learn Edge `--proxy-server` 分协议语法：https://learn.microsoft.com/en-us/deployedge/edge-learnmore-cmdline-options-proxy-settings
- WINHTTP_PROXY_INFO（bypass 列表分号分隔）：https://learn.microsoft.com/en-us/windows/win32/api/winhttp/ns-winhttp-winhttp-proxy_info
- WinHTTP AutoProxy（PAC 正牌求值）：https://learn.microsoft.com/en-us/windows/win32/winhttp/winhttp-autoproxy-api
- WINHTTP_AUTOPROXY_OPTIONS：https://learn.microsoft.com/en-us/windows/win32/api/winhttp/ns-winhttp-winhttp_autoproxy_options
- INTERNET_PER_CONN_OPTIONA：https://learn.microsoft.com/en-us/windows/win32/api/wininet/ns-wininet-internet_per_conn_optiona
- `<local>` 语义（MS Q&A）：https://learn.microsoft.com/en-in/answers/questions/1180951/registry-option-do-not-use-proxy-server-for-local
- `<local>` 语义（Server Fault）：https://serverfault.com/questions/1122990/registry-option-do-not-use-proxy-server-for-local-addresses
- HKLM 代理策略键：https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-ie-clientnetworkprotocolimplementation-hklmproxyenable
- windows-sys Registry 模块：https://docs.rs/windows-sys/latest/windows_sys/Win32/System/Registry/index.html
- system-configuration crate（无代理 API）：https://docs.rs/system-configuration
- sysproxy crate：https://lib.rs/crates/sysproxy 、https://github.com/zzzgydi/sysproxy-rs
- 参考实现：aws/amazon-ssm-agent proxy_windows.go（https://github.com/aws/amazon-ssm-agent/blob/mainline/agent/proxyconfig/proxy_windows.go ）、bruno system-proxy（https://github.com/usebruno/bruno/pull/6273 ）
- 本机一手实测：macOS 26.6.2 `scutil --proxy` / `networksetup` / `scutil` 动态存储（§1.2、§1.3、§1.5 样例）
