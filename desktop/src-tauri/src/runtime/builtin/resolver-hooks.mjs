// dsh-resolver-hooks.mjs —— 内置运行时的 Node 模块解析钩子（wayfinder #90）。
// 机制照搬 anywhere-labs/dsh-desktop：桌面 own「安装自有包」的解析——凡内置
// node_modules 里存在的裸说明符（@deepseek-ai/* 与运行时依赖），一律解析到
// 内置版本，profile 本地残留的旧版副本（用户此前 CLI 装的）不再遮蔽；
// profile 插件自身的第三方依赖不在内置树里，照常走默认解析。
// 由 dsh-launcher.mjs 在导入 dsh 入口之前 module.register() 安装。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 内置 node_modules 根：launcher 通过 env 传入（dsh_lib 向上三级）。
const bundledNm = process.env.DSH_DESKTOP_BUNDLED_MODULES ?? ''
const bundledNmUrl = bundledNm ? pathToFileURL(join(bundledNm, '_anchor_')) : undefined
const cache = new Map()

function isBareSpecifier(specifier) {
  if (specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('file:')) return false
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false
  return !specifier.includes(':') || specifier.startsWith('@')
}

export async function resolve(specifier, context, nextResolve) {
  try {
    if (!bundledNmUrl || !isBareSpecifier(specifier)) return nextResolve(specifier, context)
    const cached = cache.get(specifier)
    if (cached !== undefined) return { ...cached, shortCircuit: true }
    // 内置树里存在该包才接管；否则交回默认链（profile 自有依赖）。
    const scopeRoot = specifier.startsWith('@') ? join(bundledNm, specifier.split('/')[0], specifier.split('/')[1]) : join(bundledNm, specifier)
    if (!existsSync(join(scopeRoot, 'package.json'))) {
      cache.set(specifier, null)
      return nextResolve(specifier, context)
    }
    const resolved = await nextResolve(specifier, { ...context, parentURL: bundledNmUrl })
    cache.set(specifier, resolved)
    return { ...resolved, shortCircuit: true }
  } catch {
    return nextResolve(specifier, context)
  }
}

// 诊断辅助：launcher 启动横幅里带上钩子状态，便于日志定位。
if (process.env.DSH_DESKTOP_BUNDLED_MODULES) {
  process.stdout.write(`[desktop-resolver] bundled modules: ${fileURLToPath(bundledNmUrl)}\n`)
}
