import { delimiter } from 'node:path'
import type { ProxyEnv } from './proxy-env.ts'

// 注入给 dsh 子进程的环境与资源条件（规格第 10 条：整表视为「不变」，逐项对照现状）。
//
// 现状壳（Rust desktop/src-tauri）在 spawn 时注入的键，缺一即视为回归：
//   DSH_CLIENT_VERSION / DSH_PROFILE / DSH_HOME（必需）、DSH_PROFILE_DIR / DSH_BUN_PRELOAD_TREES（可选）。
// 另有 NODE_PATH：Bun 下装不了 Node 的 resolver hooks（module.register 是 no-op、Bun.plugin 看不
// 到 node_modules 内的裸说明符），插件解析靠 spawn 时注入 NODE_PATH + profile 树 reconcile（#209）。
// 其中 **DSH_CLIENT_VERSION 缺失即启动致命**：0.2.1-alpha.2 起运行时装配把
// desktop-product-telemetry 的 serviceVersion 设为必填，缺它 → StartupError（#199 二阶根因）。
// 迁移后壳自己拿这个值（app 版本），不再依赖运行时环境里恰好有。

export const CLIENT_VERSION_KEY = 'DSH_CLIENT_VERSION'
export const REQUIRED_ENV_KEYS = [CLIENT_VERSION_KEY, 'DSH_PROFILE', 'DSH_HOME'] as const

/** 端口合法性（子进程只认正经端口；坏值宁可不下发，让宿主插件用它的默认值）。 */
function isValidPortNumber(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535
}
export const OPTIONAL_ENV_KEYS = [
  'DSH_PROFILE_DIR',
  'DSH_BUN_PRELOAD_TREES',
  'NODE_PATH',
  'DSH_DESKTOP_PORT',
  'DSH_MOBILE_LANE_PORT',
  'DSH_MOBILE_ENABLED',
  'DSH_CLOUDFLARED_BIN',
] as const
/** 壳自己消费的内部键（不是 dsh 契约的一部分，不进 REQUIRED/OPTIONAL 表）。 */
export const SHELL_INTERNAL_ENV_KEYS = ['DSH_SHELL_PARENT_PID', 'DSH_SHELL_PATCH_FILES'] as const

/** 壳 → 宿主插件（仓库根 `index.js`）的私有契约：插件读它们回报忙状态与通知。 */
export const SHELL_PLUGIN_ENV_KEYS = [
  'DSH_DESKTOP_NOTIFY_PORT',
  'DSH_DESKTOP_NOTIFY_TOKEN',
  'DSH_DESKTOP_PROFILE',
] as const

/** 除环境变量外的资源条件（缝 ①/② 各有用例；这里显式写出来，避免只活在别人脑子里）。 */
export const CHILD_RESOURCE_CONDITIONS = {
  /** GUI 启动时 cwd 不是家目录，必须显式设成 DSH_HOME */
  cwdIsHome: true,
  /** 隔离区清理必须发生在 spawn 之前（否则新进程会读到最后一次崩溃的现场） */
  quarantineCleanupBeforeSpawn: true,
  /** 文件描述符上限（现状 16384） */
  rlimitNofile: 16384,
} as const

export interface ChildEnvInput {
  base: Record<string, string | undefined>
  clientVersion: string
  profile: string
  home: string
  profileDir?: string | undefined
  preloadTrees?: string | undefined
  /** 插件解析回退：运行时树的 node_modules（Bun 下装不了 Node resolver hooks，见 #209） */
  nodePath?: string | undefined
  /** 看门狗用的父 pid（壳自己的 pid）：壳崩溃/被 SIGKILL 后宿主能自己退出，不留孤儿 */
  parentPid?: number | undefined
  /** `--patch` 注入清单（壳写好的覆盖层；缺省不给，宿主就用 dsh 默认行为） */
  patchFiles?: string[]
  /** 通知口（旧壳 `start_notify_server` 的等价物）：缺省不给，插件就静默降级 */
  notify?: { port: number; token: string } | undefined
  /** dsh web 监听端口（旧壳 `DSH_DESKTOP_PORT`）：手机访问插件靠它找上游 */
  upstreamPort?: number | undefined
  /** 手机访问 lane 端口（旧壳 `DSH_MOBILE_LANE_PORT`，默认 desktop 3092） */
  lanePort?: number | undefined
  /** 代理注入（旧壳 `resolved_proxy_env` + `apply_proxy_env`）：大小写各一份；null/缺省 = 不动基线环境 */
  proxy?: ProxyEnv | null
  /** cloudflared 可执行文件路径（旧壳 `DSH_CLOUDFLARED_BIN`，#164）：空/缺省不注入 */
  cloudflaredBin?: string | undefined
}

export function buildChildEnv(input: ChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.base)) {
    if (value !== undefined) env[key] = value
  }
  env[CLIENT_VERSION_KEY] = input.clientVersion
  env.DSH_PROFILE = input.profile
  env.DSH_HOME = input.home
  if (input.profileDir !== undefined) env.DSH_PROFILE_DIR = input.profileDir
  else delete env.DSH_PROFILE_DIR
  if (input.preloadTrees !== undefined) env.DSH_BUN_PRELOAD_TREES = input.preloadTrees
  else delete env.DSH_BUN_PRELOAD_TREES
  if (input.nodePath !== undefined) env.NODE_PATH = input.nodePath
  else delete env.NODE_PATH
  if (input.parentPid !== undefined) env.DSH_SHELL_PARENT_PID = String(input.parentPid)
  else delete env.DSH_SHELL_PARENT_PID
  if (input.patchFiles !== undefined && input.patchFiles.length > 0) {
    // 用平台分隔符：Windows 的路径自带 `C:`，写死 ':' 会把 C:\… 切成两半（item 3）
    env.DSH_SHELL_PATCH_FILES = input.patchFiles.join(delimiter)
  } else {
    delete env.DSH_SHELL_PATCH_FILES
  }
  if (input.notify !== undefined && input.notify.port > 0 && input.notify.token !== '') {
    env.DSH_DESKTOP_NOTIFY_PORT = String(input.notify.port)
    env.DSH_DESKTOP_NOTIFY_TOKEN = input.notify.token
    env.DSH_DESKTOP_PROFILE = input.profile
  } else {
    delete env.DSH_DESKTOP_NOTIFY_PORT
    delete env.DSH_DESKTOP_NOTIFY_TOKEN
    delete env.DSH_DESKTOP_PROFILE
  }
  // 手机访问（#86/#94）：上游 dsh 端口 + lane 端口 + 开关。旧壳 lifecycle.rs:394 三件套，缺上游端口
  // 插件会照默认值 3080 去代理，手机侧就打到别人家的端口上。
  if (input.upstreamPort !== undefined && isValidPortNumber(input.upstreamPort)) {
    env.DSH_DESKTOP_PORT = String(input.upstreamPort)
  } else {
    delete env.DSH_DESKTOP_PORT
  }
  if (input.lanePort !== undefined && isValidPortNumber(input.lanePort)) {
    env.DSH_MOBILE_LANE_PORT = String(input.lanePort)
    env.DSH_MOBILE_ENABLED = '1'
  } else {
    delete env.DSH_MOBILE_LANE_PORT
    delete env.DSH_MOBILE_ENABLED
  }
  // 代理（旧壳 network/proxy.rs + lifecycle.rs:419-420）：大小写都写——不少工具只认小写；
  // proxy 为 null 时**不动**基线环境（旧壳也只写不删，尊重用户自己在环境里设的代理）。
  if (input.proxy != null) {
    const applyProxy = (name: 'HTTP_PROXY' | 'HTTPS_PROXY' | 'ALL_PROXY' | 'NO_PROXY', value: string | null): void => {
      const lower = name.toLowerCase()
      if (value === null || value === '') {
        delete env[name]
        delete env[lower]
        return
      }
      env[name] = value
      env[lower] = value
    }
    applyProxy('HTTP_PROXY', input.proxy.http)
    applyProxy('HTTPS_PROXY', input.proxy.https)
    applyProxy('ALL_PROXY', input.proxy.all)
    applyProxy('NO_PROXY', input.proxy.no_proxy)
  }
  // cloudflared（旧壳 lifecycle.rs:414-417，#164）：设置里有路径就透传给 dsh，
  // 手机访问插件的公网隧道功能靠它找可执行文件；空/缺省不写。
  if (input.cloudflaredBin !== undefined && input.cloudflaredBin.trim() !== '') {
    env.DSH_CLOUDFLARED_BIN = input.cloudflaredBin.trim()
  } else {
    delete env.DSH_CLOUDFLARED_BIN
  }
  return env
}

export function missingEnvKeys(env: Record<string, string>): string[] {
  return REQUIRED_ENV_KEYS.filter((key) => (env[key] ?? '') === '')
}

export function assertChildEnv(env: Record<string, string>): void {
  const missing = missingEnvKeys(env)
  if (missing.length > 0) {
    throw new Error(`dsh 子进程环境缺键（缺 DSH_CLIENT_VERSION 会让 0.2.1-alpha.2 启动致命）：${missing.join(', ')}`)
  }
}
