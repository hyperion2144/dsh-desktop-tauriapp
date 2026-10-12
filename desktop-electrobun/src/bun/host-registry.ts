// 宿主进程台账 + 启动时的孤儿清扫。
//
// 为什么需要：壳被 SIGKILL / 崩溃时来不及停宿主。**本次**壳起的宿主有看门狗兜底
// （runtime/parent-watch.mjs，子进程自己盯着壳），但**上一次壳**留下的孤儿只能靠台账
// 在下次启动时清掉——实机现象就是这个孤儿一直占着会话（用户得手动 kill 才能继续用）。
//
// 台账文件：<DSH_HOME>/shell-hosts.json（可用 DSH_SHELL_HOST_REGISTRY 覆盖），内容为 HostRecord[]。
// 语义：host-gone ⇒ 只清条目；shell-gone ⇒ 宿主是孤儿，杀掉再清条目。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export interface HostRecord {
  hostPid: number
  shellPid: number
  profile: string
  startedAt: string
}

function isRecord(value: unknown): value is HostRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<HostRecord>
  return (
    typeof record.hostPid === 'number' &&
    typeof record.shellPid === 'number' &&
    typeof record.profile === 'string' &&
    typeof record.startedAt === 'string'
  )
}

export function parseHostRecords(text: string): HostRecord[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecord)
  } catch {
    return []
  }
}

export function upsertHostRecord(records: readonly HostRecord[], record: HostRecord): HostRecord[] {
  return [...records.filter((entry) => entry.hostPid !== record.hostPid), record]
}

export function removeHostRecords(records: readonly HostRecord[], hostPid: number): HostRecord[] {
  return records.filter((entry) => entry.hostPid !== hostPid)
}

export interface StaleHost {
  record: HostRecord
  /** host-gone：宿主自己没了，只是条目过期；shell-gone：宿主是上一次壳留下的孤儿 */
  reason: 'host-gone' | 'shell-gone'
}

/** 纯判据：哪些条目该清、哪些还活着（另一个壳正在用它）。 */
export function selectStaleHosts(
  records: readonly HostRecord[],
  isAlive: (pid: number) => boolean,
): StaleHost[] {
  const stale: StaleHost[] = []
  for (const record of records) {
    if (!isAlive(record.hostPid)) {
      stale.push({ record, reason: 'host-gone' })
      continue
    }
    if (!isAlive(record.shellPid)) stale.push({ record, reason: 'shell-gone' })
  }
  return stale
}

export function readHostRecords(file: string): HostRecord[] {
  if (!existsSync(file)) return []
  try {
    return parseHostRecords(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function writeHostRecords(file: string, records: readonly HostRecord[]): void {
  try {
    writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`)
  } catch {}
}

export interface SweepOptions {
  file: string
  isAlive?: (pid: number) => boolean
  kill?: (pid: number) => void
  log?: (line: string) => void
}

export interface SweepResult {
  /** 被清掉的孤儿宿主 pid（shell-gone） */
  killed: number[]
  /** 被清掉的过期条目 pid（宿主自己已死） */
  pruned: number[]
  /** 清扫后仍活着的条目（别的壳正在用） */
  remaining: HostRecord[]
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** 启动时调用：杀掉上一次壳留下的孤儿宿主，清掉过期条目，写回台账。 */
export function sweepStaleHosts(options: SweepOptions): SweepResult {
  const isAlive = options.isAlive ?? defaultIsAlive
  const log = options.log ?? (() => {})
  const records = readHostRecords(options.file)
  const stale = selectStaleHosts(records, isAlive)
  const killed: number[] = []
  const pruned: number[] = []
  let remaining = [...records]
  for (const entry of stale) {
    remaining = removeHostRecords(remaining, entry.record.hostPid)
    if (entry.reason === 'host-gone') {
      pruned.push(entry.record.hostPid)
      continue
    }
    // shell-gone：宿主是孤儿（上一次壳崩溃/被 SIGKILL 留下的），必须杀掉
    try {
      ;(options.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM')))(entry.record.hostPid)
      killed.push(entry.record.hostPid)
      log(`清扫孤儿宿主：pid = ${String(entry.record.hostPid)}（壳 pid ${String(entry.record.shellPid)} 已不在）`)
    } catch (error) {
      log(`清扫孤儿宿主失败：pid = ${String(entry.record.hostPid)}（${String(error)}）`)
    }
  }
  if (stale.length > 0) writeHostRecords(options.file, remaining)
  return { killed, pruned, remaining }
}
