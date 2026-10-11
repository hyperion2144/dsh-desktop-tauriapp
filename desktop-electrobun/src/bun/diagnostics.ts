// 诊断导出（IO）：把快照写成 `$DSH_HOME/diagnostics/diag-<时间戳>.json`。
//
// 为什么落到文件而不是只回 JSON：用户报问题时要能「点一下，然后把文件发过来」，
// 而不是让他在开发者工具里复制一坨 JSON。导出后顺手在文件管理器里选中它（macOS `open -R`）。

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diagnosticsFileName } from '../shared/diagnostics.ts'

export const DIAGNOSTICS_DIR = 'diagnostics'

export interface ExportDiagnosticsInput {
  home: string
  snapshot: Record<string, unknown>
  now: Date
  /** 在文件管理器里选中文件（主进程注入；缺省不动） */
  reveal?: (path: string) => void
  log?: (line: string) => void
}

export interface ExportDiagnosticsResult {
  path: string
  bytes: number
}

export function diagnosticsDir(home: string): string {
  return join(home, DIAGNOSTICS_DIR)
}

export function exportDiagnostics(input: ExportDiagnosticsInput): ExportDiagnosticsResult {
  const dir = diagnosticsDir(input.home)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, diagnosticsFileName(input.now))
  const text = `${JSON.stringify(input.snapshot, null, 2)}\n`
  writeFileSync(path, text, 'utf8')
  let bytes = Buffer.byteLength(text)
  try {
    bytes = statSync(path).size
  } catch {}
  input.log?.(`[diag] 诊断已导出：${path}（${String(bytes)} 字节）`)
  input.reveal?.(path)
  return { path, bytes }
}
