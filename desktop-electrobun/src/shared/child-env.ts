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
export const OPTIONAL_ENV_KEYS = ['DSH_PROFILE_DIR', 'DSH_BUN_PRELOAD_TREES', 'NODE_PATH'] as const

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
    env.DSH_SHELL_PATCH_FILES = input.patchFiles.join(':')
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
