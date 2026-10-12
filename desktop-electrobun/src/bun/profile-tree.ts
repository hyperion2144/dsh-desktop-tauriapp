// profile 树的 reconcile：把运行时树里的包按需软链进 `profiles/<name>/node_modules`。
//
// 为什么需要：Bun 下装不了 Node 的 resolver hooks（`module.register` 是 no-op，
// `Bun.plugin({onResolve})` 既看不到 node_modules 内的裸说明符、也拿不到
// `@scope/pkg/subpath` 这种 exports 子路径），而 dsh 的 profile 装配本来靠 pnpm 把依赖摊到
// `profiles/<name>/node_modules`。空 DSH_HOME（CI 的缝 ①）没有这棵树，插件会整片
// `failed to import`（含 `@deepseek-ai/dsh-web-app/startup` 这类子路径导入）。
//
// 结论来自 #209 调研：NODE_PATH 只能兜住「包根」这一层，子路径必须有一棵真树。
// 碰撞策略：只收运行时自己的包（`@deepseek-ai/*`）；第三方包以 profile 里已有的为准。

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface ReconcileInput {
  /** 运行时树的 node_modules，如 <runtime>/node_modules */
  runtimeModules: string
  /** profile 的 node_modules，如 <DSH_HOME>/profiles/<name>/node_modules */
  profileModules: string
  onLog?: (line: string) => void
}

export interface ReconcileResult {
  /** 新链上的包 */
  linked: number
  /** 指错方向、被重新指向运行时树的包 */
  repointed: number
  /** profile 自己那份保持不动 */
  kept: number
}

/** 运行时树里所有包的包名（含 `@scope/name` 两段形式，跳过 `.bin`/`.pnpm` 之类）。 */
export function runtimePackageNames(runtimeModules: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(runtimeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(join(runtimeModules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory() && !child.name.startsWith('.')) names.push(`${entry.name}/${child.name}`)
      }
      continue
    }
    names.push(entry.name)
  }
  return names.sort()
}

export function reconcileProfileTree(input: ReconcileInput): ReconcileResult {
  const onLog = input.onLog ?? (() => {})
  const result: ReconcileResult = { linked: 0, repointed: 0, kept: 0 }
  if (!existsSync(input.runtimeModules)) {
    onLog(`[profile-tree] 运行时没有 node_modules，跳过 reconcile：${input.runtimeModules}`)
    return result
  }

  for (const name of runtimePackageNames(input.runtimeModules)) {
    const source = join(input.runtimeModules, name)
    const dest = join(input.profileModules, name)
    const runtimeOwned = name.startsWith('@deepseek-ai/')
    try {
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true })
        symlinkSync(source, dest, 'dir')
        result.linked += 1
        continue
      }
      const stat = lstatSync(dest)
      if (stat.isSymbolicLink()) {
        const pointsTo = resolve(dirname(dest), readlinkSync(dest))
        if (pointsTo !== source && runtimeOwned) {
          rmSync(dest, { recursive: true, force: true })
          symlinkSync(source, dest, 'dir')
          result.repointed += 1
        } else {
          result.kept += 1
        }
        continue
      }
      result.kept += 1
    } catch (error) {
      onLog(`[profile-tree] ${name} 处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onLog(
    `[profile-tree] 收 ${String(result.linked)} 个新链、${String(result.repointed)} 个重指、${String(result.kept)} 个保留（运行时 ${input.runtimeModules}）`,
  )
  return result
}
