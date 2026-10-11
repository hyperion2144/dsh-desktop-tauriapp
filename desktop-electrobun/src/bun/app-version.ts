// 壳自己的版本号（诊断快照里报「哪一版」）。
//
// 单一来源是构建配置 `electrobun.config.ts` 的 `app.version`：它被打进
// `<app>/Contents/Resources/version.json`（Electrobun 自己也是从这里读的）。
// 这里只做「按几个候选位置找 version.json」，找不到就 `unknown`——诊断里宁可写
// unknown，也不要编一个数字。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 候选位置（dev 与打包态的相对关系不同，逐个试）。 */
export function appVersionCandidates(importDir: string, execPath: string, cwd: string): string[] {
  return [
    join(importDir, '..', '..', 'version.json'),
    join(importDir, '..', '..', 'Resources', 'version.json'),
    join(execPath, '..', '..', 'Resources', 'version.json'),
    join(execPath, '..', 'Resources', 'version.json'),
    join(cwd, '..', 'Resources', 'version.json'),
    join(cwd, 'Resources', 'version.json'),
  ]
}

export function resolveAppVersion(input: {
  env?: Record<string, string | undefined>
  importDir?: string
  execPath?: string
  cwd?: string
  exists?: (path: string) => boolean
  read?: (path: string) => string
} = {}): string {
  const env = input.env ?? process.env
  const override = env.DSH_SHELL_APP_VERSION
  if (override !== undefined && override !== '') return override
  const exists = input.exists ?? existsSync
  const read = input.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const candidates = appVersionCandidates(
    input.importDir ?? import.meta.dir,
    input.execPath ?? process.execPath,
    input.cwd ?? process.cwd()
  )
  for (const path of candidates) {
    try {
      if (!exists(path)) continue
      const parsed = JSON.parse(read(path)) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch {}
  }
  return 'unknown'
}

