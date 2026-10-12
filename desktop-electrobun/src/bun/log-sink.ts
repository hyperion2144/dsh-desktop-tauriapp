// 日志文件写入 + 轮转（IO 层，策略在 ../shared/log-file.ts）。
//
// 壳的日志以前是「一行行 append 到 $DSH_HOME/shell.log，从不轮转」——长跑必然无限涨。
// 这里给它两件事：本地时区时间戳 + 有界轮转（默认 10 MB × 5 份）。页面控制台日志用同一个
// 类写 `$DSH_HOME/dsh-desktop-webview.log`（旧壳的路径，习惯与 grep 脚本照旧能用）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { LOG_KEEP, LOG_MAX_BYTES, formatLogLine, rotatePlan, shouldRotate } from '../shared/log-file.ts'

export interface LogSinkOptions {
  file: string
  maxBytes?: number
  keep?: number
  now?: () => Date
  /** 镜像到 stdout 的方式（壳日志镜像、页面日志默认不镜像——旧壳同口径） */
  stdout?: (line: string) => void
  onRotate?: (info: { moved: number; deleted: number }) => void
  /** 多久重新 stat 一次当前文件（默认 1000ms；测试传 0 关掉缓存） */
  statIntervalMs?: number
}

export interface LogSink {
  path: string
  /** 追加一段文本（调用方负责换行与格式）；超限先轮转 */
  write(text: string): void
  /** 追加一行壳日志（自己加本地时区时间戳） */
  line(message: string): void
  size(): number
  tail(lines: number): string[]
  rotate(): void
}

export function createLogSink(options: LogSinkOptions): LogSink {
  const file = options.file
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const keep = options.keep ?? LOG_KEEP
  const now = options.now ?? (() => new Date())
  const statIntervalMs = options.statIntervalMs ?? 1000
  const dir = dirname(file)
  const base = basename(file)
  mkdirSync(dir, { recursive: true })
  let size = currentSize()
  // 每秒最多重新 stat 一次：日志是单写者，但外部工具（或测试）可能清空/灌大文件，
  // 靠纯内存记账会让上限失效。
  let statAt = Date.now()

  function currentSize(): number {
    try {
      return existsSync(file) ? statSync(file).size : 0
    } catch {
      return 0
    }
  }

  function siblings(): string[] {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }

  function rotate(): void {
    const plan = rotatePlan(base, siblings(), keep)
    let moved = 0
    let deleted = 0
    // 先删最旧的，再逐级改名：不容易把还没搬走的文件覆盖掉
    for (const name of plan.deletes) {
      try {
        rmSync(join(dir, name))
        deleted += 1
      } catch {}
    }
    for (const move of plan.moves) {
      try {
        renameSync(join(dir, move.from), join(dir, move.to))
        moved += 1
      } catch {}
    }
    if (moved > 0 || deleted > 0) options.onRotate?.({ moved, deleted })
    size = 0
  }

  const write = (text: string): void => {
    const nowMs = Date.now()
    if (nowMs - statAt >= statIntervalMs) {
      size = currentSize()
      statAt = nowMs
    }
    if (text === '') return
    const bytes = Buffer.byteLength(text)
    if (shouldRotate(size, bytes, maxBytes)) rotate()
    try {
      appendFileSync(file, text)
      size += bytes
    } catch {}
  }

  return {
    path: file,
    write,
    line(message) {
      const text = `${formatLogLine(message, now())}\n`
      options.stdout?.(text.trimEnd())
      write(text)
    },
    size() {
      size = currentSize()
      return size
    },
    tail(lines) {
      if (lines <= 0) return []
      try {
        const content = readFileSync(file, 'utf8')
        const all = content.split('\n')
        if (all[all.length - 1] === '') all.pop()
        return all.slice(-lines)
      } catch {
        return []
      }
    },
    rotate,
  }
}

/** 诊断快照里报日志文件本身的一句话（路径 + 体积 + 有没有历史份）。 */
export function describeLogFile(file: string): { path: string; bytes: number; rotated: number } {
  let bytes = 0
  try {
    bytes = existsSync(file) ? statSync(file).size : 0
  } catch {}
  let rotated = 0
  try {
    const base = basename(file)
    rotated = readdirSync(dirname(file)).filter((name) => name.startsWith(`${base}.`)).length
  } catch {}
  return { path: file, bytes, rotated }
}
