// profile 脚手架写盘：`<DSH_HOME>/profiles/<name>/` 四份文件（模板在 `src/shared/profile-template.ts`）。
//
// 旧壳在 `profiles.rs` 里写同样四份；新壳只要「缺了就补」的语义：
// 已存在的文件**一律不动**——用户的 `cordis.patch.yml` 是他自己的地盘。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { profileFiles } from '../shared/profile-template.ts'

export interface ScaffoldResult {
  dir: string
  /** 本次真的写下去的文件 */
  created: string[]
  /** 本来就在、原样保留的文件 */
  kept: string[]
}

export function profileDirOf(home: string, profile: string): string {
  return join(home, 'profiles', profile)
}

/** 幂等：只补缺失文件，返回补了哪些、留了哪些（日志与测试都用它）。 */
export function scaffoldProfile(home: string, profile: string): ScaffoldResult {
  const dir = profileDirOf(home, profile)
  mkdirSync(dir, { recursive: true })
  const created: string[] = []
  const kept: string[] = []
  for (const file of profileFiles(profile)) {
    const target = join(dir, file.name)
    try {
      readFileSync(target)
      kept.push(file.name)
      continue
    } catch {
      // 不存在 → 写
    }
    writeFileSync(target, file.content)
    created.push(file.name)
  }
  return { dir, created, kept }
}

/** profile 是否已经「可被 dsh 认出来」（`loadProfile` 只认 package.json 存在）。 */
export function profileExists(home: string, profile: string): boolean {
  try {
    readFileSync(join(profileDirOf(home, profile), 'package.json'))
    return true
  } catch {
    return false
  }
}
