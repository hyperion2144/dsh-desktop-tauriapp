// dsh-desktop-tauriapp bundle：注册「DSH 桌面壳」技能（SKILL.md 正文内联）。
// 完整参考实现（Rust 源码、脚本、审计报告）在 GitHub 仓库：
// 本仓库 fork 自 happpsee/dsh-desktop-app，现独立演进；完整参考实现见 https://github.com/hyperion2144/dsh-desktop-tauriapp

export const name = 'dsh-desktop-tauriapp'

// 注意：不可为 skills 声明 export const inject——skills 在本插件作用域不可见，
// 声明后 Cordis 会无限期挂起 apply（实测），技能与 RPC 桥接全部失效。
// 改为 apply 内探测降级：skills 不可用只跳过技能注册，RPC 桥接不受影响。

const CONTENT = [
  '# DSH 桌面壳「DeepSeek Harness Desktop Desktop」',
  '',
  '把 DeepSeek Harness Web GUI 封装成 Tauri 2 桌面应用（macOS + Windows 双平台）：',
  '双击启动 → 自动拉起本地 `dsh web` → 窗口加载 Web GUI → 托盘常驻 → 退出回收子进程。',
  '完整源码与脚本见 https://github.com/hyperion2144/dsh-desktop-tauriapp （desktop/ 源码、skill/ 技能包、docs/ 审计报告；原 fork 自 happpsee/dsh-desktop-app）。',
  '',
  '## 一、安装 DeepSeek Harness（前提，分平台）',
  '',
  'Node.js ≥ 20，然后 `npm i -g @deepseek-ai/dsh`（国内先 `npm config set registry https://registry.npmmirror.com`）。',
  'macOS：`brew install node@22` 或 nvm；验证 `dsh --version`、`which dsh` 指向全局 bin。',
  'Windows：nvm-windows（`winget install CoreyButler.NVMforWindows`）或官方 msi 任意盘符；',
  'PowerShell 执行策略 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`（拦 .ps1 shim）；',
  '首次 `dsh web` 约 4s 就绪，profile 在 ~/.dsh（mac）/ %USERPROFILE%\\.dsh（win）。',
  '',
  '## 二、国内镜像（Windows 新环境必做，否则所有下载卡死）',
  '',
  '- rustup：`RUSTUP_DIST_SERVER=https://rsproxy.cn`、`RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup`',
  '- cargo（~/.cargo/config.toml）：replace-with rsproxy-sparse（sparse+https://rsproxy.cn/index/）',
  '- npm/pnpm：registry.npmmirror.com',
  '- GitHub raw 被墙：用 gh-proxy.com 前缀（`https://gh-proxy.com/https://raw.githubusercontent.com/...`）',
  '- 验证 cargo 源：`cargo search serde --registry crates-io`（裸 cargo search 会因 replace 报错）',
  '- **subagent 哨兵**：重量级下载派 subagent，主 agent 按预期时长表轮询——单文件 30s、',
  '  npm 全局 2min、rustup 5min、cargo fetch 5min（编译另计，首次 release 约 5min）；',
  '  超时=源未配好，中断→复核→换源→重派；测速探针必须用 ≥10MB 大文件（小文件会误杀健康源）',
  '',
  '## 三、Windows 无管理员工具链（无 VS Build Tools 也能构建 Tauri）',
  '',
  '全部用户级：xwin 取 CRT/SDK 头库 + rustup 自带 rust-lld 作链接器 + LLVM 安装器 7-Zip',
  '解压出 clang-cl + NuGet Microsoft.Windows.SDK.BuildTools 取**真 rc.exe**（llvm-rc 编不了',
  '中文 #pragma code_page(65001)）。cargo config 固化 INCLUDE/LIB/CC/CXX/RC/linker。',
  '模板与脚本见仓库 desktop/scripts/cargo-config-no-admin.toml.example、build-env.ps1。',
  '',
  '## 四、项目骨架（Tauri 2）',
  '',
  '```bash',
  'npm create tauri-app@latest desktop -- --name dsh-desktop-tauriapp \\',
  '  --identifier com.arcreel.dsh-desktop-tauriapp --template vanilla --manager pnpm --yes',
  '```',
  '核心 Rust（desktop/src-tauri/src/lib.rs，仓库有完整参考）：',
  '- 状态 DshState：child/spawned_this_run/spawn_failed/quitting/tray_tip_shown/unread',
  '- 启动：TcpStream 探测 127.0.0.1:3080（DSH_DESKTOP_PORT 可覆盖），spawn 带 --no-open 不自动开浏览器；',
  '  复用外部实例时启动页弹「兼容/高级」模式选择（兼容=标准布局+系统原生标题栏；高级=停用外部实例、',
  '  用桌面 overlay 实例重启并启用桌面 chrome）；空闲 spawn 桌面 overlay 实例直接进高级；',
  '  spawn 失败按 SpawnError NotFound/Other 分类，失败后轮询任务直接 return 不二次导航',
  '- 探测兜底：DSH_BIN→PATH→Homebrew/npm-global→nvm glob（semver 排序，勿字符串 sort）→npx',
  '- 托盘：关闭即隐藏、拦截 Cmd+Q、退出只回收本次 spawn 的子进程；单实例；窗口状态记忆',
  '- 品牌注入：窗口 eval 注入 CSS 替换左上角 logo/字标；任务完成通知：本地 HTTP 桥',
  '  （含 CORS 预检应答）+ data-state 忙碌检测 + Dock 角标/跳动（失焦才打扰）',
  '- 桌宠：透明置顶无边框小窗（鲸鱼娘）+ JS 手动拖拽（4px 阈值区分点击）/左键唤起',
  '  主窗/右键菜单/任务完成气泡（pet-say 事件）/位置持久化（pet.json 多屏钳位）；',
  '  `macOSPrivateApi:true` 开 mac 透明，window-state 插件 `with_denylist(["pet"])`',
  '- Windows 分支：find_node + find_dsh_bin_js，`node <bin.js>` 直跑（dsh.cmd 引号坑），',
  '  CREATE_NO_WINDOW 防闪黑窗',
  '',
  '## 五、构建与验收',
  '',
  '`pnpm tauri build`（mac 出 .app/.dmg，win 出 .msi/-setup.exe）。',
  '仓库 desktop/scripts/acceptance.sh / .ps1 自动跑三条路径：A 复用（3080 已有 dsh web，降级接入、退出不杀）、',
  'B 拉起+回收（端口空闲 spawn，退出 kill+端口释放）、C 受限 PATH（模拟双击，验证兜底探测）。',
  '**跑验收前先退出所有 dsh-desktop-tauriapp 实例**（单实例锁会静默拦截造成假通过）。',
  '',
  '## 六、已知坑',
  '',
  '- 中文 productName 必须配 `bundle.windows.wix.language: "zh-CN"`，否则 MSI 打包 LGHT0311',
  '- SmartScreen 只针对网络下载带 MOTW 的 exe，本地构建不触发',
  '- 产物 exe 名是 crate 名 dsh-desktop-tauriapp.exe（非「DeepSeek Harness Desktop Desktop.exe」）',
  '- tauri icon 不生成 256x256.png，用 128x128@2x.png',
  '- mac dmg 打包失败留 rw 挂载：hdiutil detach 后删 bundle/macos/rw.*.dmg 再全量 build',
  '- PowerShell 5.1 读 UTF-8 日志：`[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)`',
  '',
  '## 七、桌面端与会话的关系',
  '',
  '桌面壳与浏览器/终端共用同一个 dsh web（单实例、同后端、同会话存储 ~/.dsh）；由桌面壳拉起的实例带桌面 overlay 启用桌面 chrome，复用的外部实例降级接入；托盘「重启 dsh 服务」可切换到桌面壳实例。避免两边同时操作同一会话。',
  '完整 SKILL.md 与实测审计见仓库 https://github.com/hyperion2144/dsh-desktop-tauriapp',
].join('\n')

export function apply(ctx) {
  const skills = ctx.get('skills')
  // 技能注册与 RPC 桥接解耦：技能服务不可用不能阻断桥接（否则设置面板拿不到
  // provider/model——实测根因，见 #61）。
  if (skills !== undefined && typeof skills.register === 'function') {
    ctx.effect(() =>
      skills.register({
        name: 'dsh-desktop-tauriapp',
        title: 'DSH 桌面壳「DeepSeek Harness Desktop Desktop」',
        description:
          '把 DeepSeek Harness Web GUI 封装成 Tauri 2 桌面应用（macOS + Windows 双平台），含托盘常驻、单实例、子进程生命周期、任务完成通知、鲸鱼娘透明置顶桌宠；内置 DSH 安装分平台、国内镜像加速（rustup/cargo/npm/GitHub/NSIS）、subagent 哨兵下载判定、Windows 无管理员工具链方案。当用户想把 DSH 做成桌面应用、搭 Tauri 项目、或在 Windows 新环境配置 Rust/Node 工具链时使用。',
        whenToUse:
          '用户想把 DeepSeek Harness 或任意本地 Web 应用封装成桌面应用；需要给桌面应用加托盘常驻、任务完成系统通知、透明置顶桌宠；需要在 Windows 新环境配置 Rust/Node 工具链（含国内镜像加速）；需要无管理员权限构建 Tauri 项目；遇到 dmg/MSI 打包、SmartScreen、单实例锁等桌面壳坑时。',
        source: 'dsh-desktop-tauriapp',
        content: CONTENT,
        invocation: { modelInvocable: true, userInvocable: true },
      }),
      'dsh-desktop-tauriapp: skill',
    )
  } else {
    ctx.logger?.warn('dsh-desktop-tauriapp: skills 服务不可用，跳过技能注册（RPC 桥接不受影响）')
  }

  // ── dsh settings 服务：注册桌面壳命名空间 + 供 RPC 读写（不直接读写 settings.yaml）──
  let settingsSvc
  ctx.inject(['settings'], (c) => {
    settingsSvc = c.get('settings')
    if (settingsSvc === void 0) return
    try {
      // 透传型 schema：保留全部既有键（port/proxy/remote 等），不丢 Rust 侧字段
      settingsSvc.register('dsh-desktop-tauriapp', (raw) => {
        const v = raw !== null && typeof raw === 'object' ? raw : {}
        return { ...v }
      })
    } catch (e) {
      ctx.logger?.warn?.(`dsh-desktop-tauriapp: settings 命名空间注册失败：${e?.message ?? e}`)
    }
  })

  // 保险丝面板：桥接 dsh llm 目录到浏览器（同 dsh-mnemon 的 connection RPC 模式）。
  // 必须在技能守卫之外：两者无依赖关系。
  ctx.inject(['connection'], (webContext) => {
    if (webContext.connection === void 0) return
    // connection RPC 的 handler 必须自带 {ok, value} 信封——fullResponse 不包裹
    // （mnemon 的 success$1 同理），返回裸对象会导致客户端报
    // TypeError: connection: invalid server-response result。
    webContext.connection.rpc.handle('/dsh-desktop-models', async (_endpoint) => {
      const llm = ctx.get('llm')
      if (llm === void 0) throw new Error('llm service unavailable')
      const providers = llm.listProviders()
      const result = []
      for (const p of providers) {
        const models = await llm.listModels(p.id)
        result.push({ id: p.id, name: p.name, models })
      }
      return { ok: true, value: { providers: result } }
    }, { authority: 'trusted-host' })
    // 桌面壳设置读写：经 dsh settings API（namespace 已在上方注册）。
    webContext.connection.rpc.handle('/dsh-desktop-fuse-settings', async (endpoint, payload) => {
      const settings = settingsSvc
      if (settings === void 0) throw new Error('settings service unavailable')
      if (endpoint === 'get') {
        const value = settings.get('dsh-desktop-tauriapp')
        return { ok: true, value: value ?? {} }
      }
      if (endpoint === 'save') {
        const ops = Object.entries(payload.patch).map(([path, value]) => ({
          op: 'set', path: path.split('.'), value,
        }))
        await settings.mutate('dsh-desktop-tauriapp', ops)
        return { ok: true }
      }
      throw new Error(`unknown endpoint: ${endpoint}`)
    }, { authority: 'trusted-host' })
  })
}
