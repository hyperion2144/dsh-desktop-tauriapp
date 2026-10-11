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
