/**
 * 日志文件策略（纯逻辑，无 IO）——#220 的「日志与诊断」。
 *
 * 旧壳（`desktop/src-tauri/src/lib.rs:114-131`）用 tauri-plugin-log：stdout +
 * `~/Library/Logs/com.arcreel.dsh-desktop-tauriapp/dsh-desktop-tauriapp.log`，**本地时区**、
 * 单文件 10 MB、`KeepAll` 轮转。实测那台机器上堆了 **90+ 个 10 MB 的历史文件**（≈900 MB）——
 * `KeepAll` 在长跑桌面上等于不封顶。
 *
 * 新壳保留「本地时区 + 单文件 10 MB」这两个好用的点，但**轮转留固定份数**（默认 5 份，
 * 上限 50 MB），并在超过时删最旧的一份。页面控制台另写一份（旧壳的
 * `$DSH_HOME/dsh-desktop-webview.log`），同一套轮转规则。
 */

/** 单份日志上限（与旧壳一致）。 */
export const LOG_MAX_BYTES = 10_000_000

/** 保留份数（含当前那份）：1 份当前 + 4 份历史 = 上限 50 MB。 */
export const LOG_KEEP = 5

/** 页面控制台日志的级别（旧壳 `log_console` 的映射表）。 */
export type PageLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'log'

/** 未知/缺省级别落到 `log`（旧壳的 `_ => "[log]  "`）。 */
export function classifyLevel(raw: string): PageLogLevel {
  return raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug' || raw === 'log' ? raw : 'log'
}

/** 级别前缀（**故意与旧壳逐字一致**，两边日志能对着 grep）。 */
export function pageLogPrefix(level: PageLogLevel): string {
  switch (level) {
    case 'error':
      return '[error]'
    case 'warn':
      return '[warn] '
    case 'info':
      return '[info] '
    case 'debug':
      return '[debug]'
    default:
      return '[log]  '
  }
}

/**
 * 页面日志要不要镜像进壳日志。
 * 旧壳只在 `warn|error` 时镜像（原文：「控制台输出量大时会让 log 噪声翻倍」）。
 */
export function mirrorToShellLog(level: PageLogLevel): boolean {
  return level === 'warn' || level === 'error'
}

/** 本地时区时间戳（旧壳注释：本地时区，排障不用脑内换算）。 */
export function formatStamp(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const ms = pad(now.getMilliseconds(), 3)
  return (
    `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}`
  )
}

/** 一行壳日志（时间戳 + 正文，正文里本来就有 `[shell]` 之类的前缀）。 */
export function formatLogLine(line: string, now: Date): string {
  return `${formatStamp(now)} ${line}`
}

/**
 * 页面控制台一条消息要写的行（多行逐行加前缀，便于 grep）。
 * 形状照旧壳：首行 `[level] [page=url] 第一行`，后续行缩进对齐。
 */
export function pageLogLines(input: { level: PageLogLevel; msg: string; pageUrl: string | null }): string[] {
  const prefix = pageLogPrefix(input.level)
  const page = input.pageUrl === null || input.pageUrl === '' ? '?' : input.pageUrl
  // 结尾换行不算一行（对齐 Rust `msg.lines()`；调用方每条都补换行，语义等价）
  const body = input.msg.endsWith('\n') ? input.msg.slice(0, -1) : input.msg
  const lines = body.split('\n')
  const out: string[] = []
  for (const [index, line] of lines.entries()) {
    out.push(index === 0 ? `${prefix} [page=${page}] ${line}` : `${prefix}            ${line}`)
  }
  return out
}

export interface RotatePlan {
  /** 当前文件要先改名的目标（体积已超限时才非空） */
  moves: { from: string; to: string }[]
  /** 轮转后要删掉的路径（最旧的） */
  deletes: string[]
}

/** 第 n 份历史文件名（`shell.log` → `shell.log.1`）。 */
export function rotatedName(base: string, index: number): string {
  return `${base}.${String(index)}`
}

/** 体积是否到轮转线。 */
export function shouldRotate(size: number, incoming: number, maxBytes: number = LOG_MAX_BYTES): boolean {
  return size > 0 && size + incoming > maxBytes
}

/**
 * 轮转计划：`base` → `base.1`，`base.1` → `base.2`……直到 `keep-1`，更旧的删掉。
 * `keep` 是「保留份数」（含当前那份）：keep=5 ⇒ 历史最多 `base.1..base.4`。
 */
export function rotatePlan(base: string, existing: readonly string[], keep: number = LOG_KEEP): RotatePlan {
  const moves: { from: string; to: string }[] = []
  const deletes: string[] = []
  const limit = Math.max(0, keep - 1)
  // 从最旧的开始规划，避免把还没搬走的文件覆盖掉
  for (let index = limit; index >= 1; index -= 1) {
    const from = index === 1 ? base : rotatedName(base, index - 1)
    if (!existing.includes(from)) continue
    moves.push({ from, to: rotatedName(base, index) })
  }
  for (const name of existing) {
    if (!name.startsWith(`${base}.`)) continue
    const raw = name.slice(base.length + 1)
    const index = Number(raw)
    if (!Number.isInteger(index)) continue
    // 轮转后只留 keep 份（当前 + keep-1 份历史）⇒ 位次 >= limit 的内容直接丢
    if (index >= limit) deletes.push(name)
  }
  return { moves, deletes }
}
