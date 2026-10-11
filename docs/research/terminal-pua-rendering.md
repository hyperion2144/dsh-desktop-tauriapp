# #208 终端 PUA 字符渲染问题 —— 调查报告

调查者：只读研究子代理｜日期：2026-10-11｜工作位：`/Users/mutou/vault/projects/dsh-desktop-tauriapp/.agents/worktrees/map/204-electrobun-shell`
所有实验在 `/tmp/pua208/` 隔离环境（`DSH_HOME=/tmp/pua208/dsh-home[-node]`，端口 3399/3398）跑，仓库与 `~/.dsh` 未被改动（详见「实验纪律」）。

---

## 一、结论

### 1.1 主结论（Bun 数据链路已排除）

**PUA（U+E000–U+F8FF）字符在 Bun 路径上没有被丢失、没有被替换。** 我逐环做了 Node↔Bun A/B 对照，四环全部一致：

| 环节 | 结论 | 证据 |
|---|---|---|
| PTY 输出（Patch 7 shim vs 真 node-pty） | **完全一致**，含跨 chunk 拆分的 3 字节序列 | 实验 A（下方 §3.2），输出逐码点相同 |
| `TerminalSanitizer` | 只做 CRLF→LF 与 BEL 剔除，对 PUA 无操作 | `dsh-terminal-bash/lib/index.js:237-238` |
| 服务端 headless xterm + serialize | **Node 与 Bun 输出逐字节相同** | 实验 B（§3.3） |
| 主题/字体启动注入（index.html） | **Node 与 Bun 注入内容相同**（仅行序不同） | 实验 D（§3.4） |

⇒ **#208 票里「服务端收到 12 个 PUA、broadcast 原样发出」的旧结论是对的，而且可以再往前推一步：Bun 服务端产出的字节与 Node 服务端逐字节相同。**

### 1.2 「□ 方框」最可能的真因：终端字体栈没有 PUA 字形（与 Node/Bun 无关）

xterm.js 用的字体栈是：

```js
// dsh-client-ui-sidebar-terminal/lib/client.terminal.js:13497-13500
const TERMINAL_FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
function terminalFontFamily(list) {
  return list === "" ? TERMINAL_FONT_STACK : `${list}, ${TERMINAL_FONT_STACK}`;
}
```

`client.terminal.js:13392`：`const fontFamily = terminalFontFamily(theme.fontFamilies.terminal);`
`theme.fontFamilies.terminal` 唯一来源是插件配置 `terminalFontFamily`，**默认 `""`**：

```js
// dsh-client-ui-theme/lib/index.js:194
terminalFontFamily: z.string().default("").volatile()
```

本机实测（§3.5）：**Menlo / SF Mono / Consolas / DejaVu Sans Mono / 系统 `monospace`（实测解析为 Andale Mono）全部不覆盖 U+E0B0。**
本机确实装了 Nerd Font（`FiraCode Nerd Font`、`JetBrainsMono Nerd Font` 等，`fc-match` 可命中），但**默认栈里一个都没有**。

⇒ **`terminalFontFamily` 为空时，侧边栏终端里的每个 PUA 字形必然渲染成 □（tofu）——Node 版同样会 □。**

### 1.3 因此要推翻的前提

「Node 版终端正常、Bun 版才是方框」这个前提，**目前没有任何一条实验支持**。三种可能，按概率排序：

1. **该前提本身不成立**（Node 也一样方框，只是维护者没在 Node 版侧边栏里对比过）——最可能。
2. `terminalFontFamily` 在维护者的 profile 里**已配置**，且该配置在 Bun 启动的实例里没生效（读 settings 失败/落到默认）。我证明了启动注入 HTML 这条路 Node/Bun 一致，但**没验证「持久化 settings → 插件 config」这一段**（见 §4 未验证项）。
3. 真有 Bun 特有的编码问题——我没能复现，且每一环都被我 A/B 排除。

### 1.4 附带发现（真 bug，与 #208 无关但该修）

`desktop/src-tauri/resources/dsh/bun-preload.mjs:328-329` 里留了维护者的 Windows 调试代码：

```js
`        const _cp = [...s].slice(0,20).map(c => c.codePointAt(0)).map(...).join('');`,
`        try { require('fs').appendFileSync('C:/Users/hyperion2144/bun-pty-debug.log', _cp + '\\n'); } catch {}`,
```

- 硬编码 Windows 绝对路径 → macOS 上每个数据块都抛 ENOENT 再被 `catch {}` 吞掉（每 chunk 一次无效 syscall）。
- 每个数据块都无条件做 `[...s].slice(0,20)` 的字符串展开（热路径）。
- **把维护者用户名提交进了仓库**（`C:/Users/hyperion2144`）。

---

## 二、修复方案

### 方案 A（推荐）：让终端字体栈真的带 PUA 字形

**A1｜配置层（零代码，验证根因用）**
在 dsh 桌面设置 → 主题里把「终端字体」设成已装的 Nerd Font，例如 `FiraCode Nerd Font`。若 □ 立刻消失，§1.2 即被证实。
注意：改完**必须硬刷新页面**——`bootstrapFontFamilies()`（`dsh-client-ui-theme/lib/client.js:1876-1889`）只在 store 构造时从 `document.body.style` 读一次 CSS 变量。

**A2｜代码层（上游 dsh，一行）**
把常见 Nerd Font 家族名追加进回退栈；CSS font-family 对未安装家族是静默跳过的，所以零风险零体积：

```js
// dsh-client-ui-sidebar-terminal/lib/client.terminal.js:13497
const TERMINAL_FONT_STACK = `"FiraCode Nerd Font","JetBrainsMono Nerd Font","MesloLGS NF","Hack Nerd Font",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
```
- 代价：改的是 `@deepseek-ai/dsh-client-ui-sidebar-terminal`，**是上游 dsh 包，不在本仓**；本仓只能等上游发版或 `--patch` 覆盖。
- 风险：极低（只是回退链变长）。

**A3｜代码层（本仓可做，兜底）**
桌面壳自带一份 Nerd Font webfont，启动时写 `terminalFontFamily` 设置（走 dsh settings API，durable）。
- 代价：字体子集化后 ~300KB–1MB（只留常用 PUA 区段可再小）。
- 风险：中——要塞进 `build.rs` 的 staging 与 profile materialization 链路；且要处理「先有字体还是先有设置」的顺序。

> ⚠️ **CSS 覆盖不了这条路**：dsh 的 xterm 走 canvas 渲染器（`client.terminal.js:13045` 的 `.xterm-screen canvas` 样式），字体是 JS 设进 canvas 2d context 的（`client.terminal.js:1903` `this._ctx.font = ...`）。因此**只有 `options.fontFamily` 能改**，写 CSS `!important` 无效。任何「注个 CSS 就好」的方案都不要采纳。

### 方案 B：先证伪/证实 §1.3 的前提，再决定动不动代码

在维护者的环境里，**Node 与 Bun 两边各跑一次**侧边栏终端：

```bash
printf '\ue0b0\ue0b2\uf013 icons-ok\n'
node -p "'runtime=' + (process.versions.bun ? 'bun '+process.versions.bun : 'node '+process.version)"
```

判读：
- **两边都显示 □** → 方案 A1/A2，问题与 Bun 无关，#208 应改标题/收敛为「终端字体缺 Nerd Font 回退」。
- **Node 正常、Bun 仍是 □** → §1.3 第 2 条成立，转去查 `terminalFontFamily` 在 Bun 实例的 settings 读取；此时才需要抓帧（浏览器 DevTools 在 `xterm.write` 处断点看 `frame.data` 的码点）。

### 方案 C（不推荐）：改 Patch 7 的编码路径

**没有证据支持。** 实验 A 已证明 shim 的 `TextDecoder(..., {stream:true})`（`bun-preload.mjs:315,326`）与 node-pty 的 `_socket.setEncoding('utf8')`（`node-pty/lib/unixTerminal.js:66,97`，底层是 Node StringDecoder）在跨 chunk 拆分场景下**行为一致**。动它只会引入新风险。

顺带（与 #208 无关，但建议做）：删掉 `bun-preload.mjs:328-329` 的 Windows 调试行。

---

## 三、证据（file:line + 命令输出）

### 3.1 关键代码位置

```
desktop/src-tauri/resources/dsh/bun-preload.mjs:313   const env = { ...options.env, TERM:'xterm-256color', LANG:'en_US.UTF-8' }
desktop/src-tauri/resources/dsh/bun-preload.mjs:315   const _td = new TextDecoder('utf-8')
desktop/src-tauri/resources/dsh/bun-preload.mjs:326   const s = _td.decode(_raw, { stream: true })
desktop/src-tauri/resources/dsh/bun-preload.mjs:328-329 Windows 调试残留（见 §1.4）
desktop/src-tauri/resources/dsh/bun-preload.mjs:330   onDataCb(s)
desktop/src-tauri/resources/dsh/bun-preload.mjs:351-370 Patch 8（headless xterm 同步写；只影响写入时序，不碰字符）

@deepseek-ai/dsh-subprocess-local/lib/index.js:1261   const requireNodePty = createLazyRequire("node-pty", import.meta.url)
@deepseek-ai/dsh-subprocess-local/lib/index.js:1452   terminal = requireNodePty().spawn(file, args, options)
@deepseek-ai/dsh-subprocess-local/lib/index.js:797    this.output.write(Buffer.from(data, "utf8"))   ← seam 要求 onData 给 string
@deepseek-ai/dsh-terminal-bash/lib/index.js:630-631  Buffer.from(chunk,"utf8") → decoder.decode(bytes,{stream:true})
@deepseek-ai/dsh-terminal-bash/lib/index.js:237-238  normalizeTerminalText：只处理 \r\n / \r / \x07
node-pty/lib/unixTerminal.js:66,97                   setEncoding('utf8')（Node StringDecoder，跨 chunk 安全）
@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.terminal.js:13497-13500  TERMINAL_FONT_STACK
@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.terminal.js:13392       fontFamily = terminalFontFamily(theme.fontFamilies.terminal)
@deepseek-ai/dsh-client-ui-theme/lib/index.js:194    terminalFontFamily: z.string().default("").volatile()
@deepseek-ai/dsh-client-ui-theme/lib/index.js:145-158 bootThemeBodyScript（注入 --dsh-font-family-terminal）
@deepseek-ai/dsh-client-ui-theme/lib/client.js:1876-1889 bootstrapFontFamilies() 只在构造时读一次 CSS 变量
```

### 3.2 实验 A：真 node-pty（Node） vs Patch 7 shim（Bun 1.4.0）——逐码点相同

命令：
```bash
# /tmp/pua208/expA-bun.mjs  = Patch 7 spawnPty 的逐行复刻
# /tmp/pua208/expA-node.cjs = 同一负载，走 live runtime 树里的真 node-pty
node expA-node.cjs
~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun run expA-bun.mjs
```
负载：`printf '\ue0b0\ue0b2\uf013 OK\n'` + `printf 'A\xee'; sleep .25; printf '\x80'; sleep .25; printf '\xb0B\n'`（3 字节序列跨 3 次 PTY 写）。

输出：
```
########## NODE + real node-pty ##########
RUNTIME=node + real node-pty v26.5.0
ALL CODEPOINTS: \ue0b0\ue0b2\uf013 OK
AU+E030B
PUA COUNT=1  => U+E030
HAS FFFD=false

########## BUN + Patch7 shim ##########
RAW LEN(chars)=28
ALL CODEPOINTS: \ue0b0\ue0b2\uf013 OK
AU+E030B
PUA COUNT=1  => U+E030
HAS FFFD(U+FFFD)=false
```
**两边逐码点完全一致**；跨 chunk 拆分的 `\xee\x80\xb0` 在两边都被正确重组为 U+E030，无 U+FFFD。

旁证（Bun 的 `terminal.data` 回调实参类型）：
```
[data#1] ctor=Buffer len=25 head=5c 75 65 30 62 30 ...
```
`Buffer` 是 `Uint8Array` 子类 ⇒ `bun-preload.mjs:325` 的 `data instanceof Uint8Array` 分支成立，走原始字节，不会被 `Buffer.from(string)` 二次编码。

### 3.3 实验 B：`@xterm/headless@6.0.0` + `@xterm/addon-serialize@0.14.0`，Node vs Bun

```bash
cd /tmp/pua208/xterm-test && node expB.cjs; ~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun run expB.cjs
```
```
=== NODE ===  RUNTIME=node v26.5.0
SERIALIZED_JSON="a...b...c\r\nnext line\u001b[1B\u001b[9D"
=== BUN  ===  RUNTIME=bun 1.4.0
SERIALIZED_JSON="a...b...c\r\nnext line\u001b[1B\u001b[9D"
PUA_IN=4 PUA_OUT=8  U+E0B0,U+E0B1,U+F8FF,U+EAE8,U+E0B0,U+E0B1,U+F8FF,U+EAE8
```
序列化结果逐字节相同，PUA 全部保留。

### 3.4 实验 D：真实 dsh 实例 Node(3398) vs Bun(3399) 的 `index.html`

隔离启动（`cp -Rc` 克隆 522MB runtime 树到 `/tmp/pua208/rt`，`bun-preload.mjs` 按 `_dshRoot` 解析正好命中克隆树；启动日志确认 `Patch 8: xterm.js sync write applied` 且 `node-pty/lib/index.js` 首行变成 shim）：
```bash
DSH_HOME=/tmp/pua208/dsh-home bun --preload /tmp/pua208/rt/bun-preload.mjs \
  /tmp/pua208/rt/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3399 --no-open
DSH_HOME=/tmp/pua208/dsh-home-node node /tmp/pua208/rt/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3398 --no-open
```
在两份 profile 的 `cordis.patch.yml` 里**同样地**插入 `@deepseek-ai/dsh-client-ui-theme` 并设 `terminalFontFamily: FiraCode Nerd Font`：

```
bun  HTTP=200 bytes=36705
node HTTP=200 bytes=36705
# diff（去掉 token）唯一差异是 setProperty 行的先后顺序，内容一致：
>   document.body.style.setProperty("--dsh-font-family-terminal", "\"FiraCode Nerd Font\"")
<   document.body.style.setProperty("--dsh-font-family-terminal", "\"FiraCode Nerd Font\"")
```
⇒ 主题/字体启动注入这条链 **Node 与 Bun 等价**。

### 3.5 实验 C：字形覆盖（本机 fontconfig）

```bash
for f in Menlo SFMono "SF Mono" Consolas "DejaVu Sans Mono" monospace; do
  echo -n "$f -> "; fc-list ":family=$f:charset=e0b0" family | wc -l; done
fc-match monospace        # → Andale Mono.ttf: "Andale Mono" "Regular"
fc-match "ui-monospace"   # → Verdana.ttf: "Verdana" "Regular"
fc-match "FiraCode Nerd Font"  # → FiraCodeNerdFont-Regular.ttf: "FiraCode Nerd Font" "Regular"
```
输出：上述 6 个候选字体覆盖 U+E0B0 的数量**全部为 0**；Nerd Font 可命中。
⇒ 默认终端字体栈里没有任何一个字形能画 U+E0B0 ⇒ **必然 tofu □**。

---

## 四、未验证项 / 风险

1. **维护者 profile 里的 `terminalFontFamily` 到底配没配**——未验证（按纪律未读 `~/.dsh`）。这是 §1.3 三选一的决定性输入，必须由维护者或 lead 在其环境里跑方案 B 的两行命令确认。
2. **「持久化 settings → 插件 config」这一段在 Bun 下是否等价**未验证。实验 D 只证明了 `cordis.patch.yml` 静态覆盖 + index.html 注入等价；若维护者的字体是存在 dsh settings（`dsh-client-ui-theme/lib/index.js:188` `child.settings.configure({auto:false})`）里，则需另测（我未写 settings.yaml 做 A/B，因为不确定其 schema）。
3. **未在真实 WKWebView 里看过渲染**——没有启动 GUI（禁止碰维护者 live 环境）。「□ 是 tofu」是基于：①数据链路逐环证明无损；②字体栈无 PUA 字形；③□ 的视觉形态。未截图取证。
4. **未验证 Bun 的 PTY 是否让子进程真的看到 tty**。若子进程 `isatty()==false`，某些工具会**不输出**图标（而不是输出 □），是另一种症状。dsh 默认起 `/bin/bash --noprofile --norc -i`（`dsh-terminal-bash/lib/index.js` 的 `DEFAULT_BASH_ARGS`），本身无 prompt 图标，图标只能来自 `eza/btop/lazygit` 之类显式调用的程序——维护者报的图标来源未确认。
5. **Patch 8（headless 同步写）未做 A/B**：我只证明了它在 Node/Bun 下不改变字符，没验证「去掉 Patch 8 会怎样」。若后续发现 Bun 下终端有别的显示异常（空白/缺行），Patch 8 是下一个嫌疑点。
6. 未测 `onData` 在**高频大块输出**（如 `cat` 大文件）下的分片差异；本实验负载很小。
7. 未读 `~/.dsh` 任何文件，未复制任何凭据，未触碰 `/Applications/DeepSeek Harness Desktop.app`，未 kill 维护者任何进程。

---

## 五、实验纪律自查

- 仓库（主检出 + map worktree）**零写入**；所有改动都在 `/tmp/pua208/`。
- 隔离：`cp -Rc` 克隆 runtime 树；`DSH_HOME=/tmp/pua208/dsh-home[-node]`；端口 3399/3398（避开 3080/3081）。
- 我启动的两个 dsh 实例（`lsof -ti :3399` / `:3398` 定位）已全部 kill，端口已释放；bun-preload 的 exit handler 已把克隆树里的 `node-pty/lib/index.js` 与 `@xterm/headless` 恢复原状（已验证：node-pty 首行回到 `"use strict";`，headless 补丁串计数为 1=原始）。
- 实验用脚本：`/tmp/pua208/expA-bun.mjs`、`expA-node.cjs`、`e1b.mjs`、`xterm-test/expB.cjs`；日志 `dsh-bun.log` / `dsh-node.log`；抓到的页面 `idx-bun.html` / `idx-node.html`。