// 桌面档快捷键偏好（旧壳 `desktop/src-tauri/src/shortcuts.rs`，issue #187 的等价物）。
//
// 壳只做两件事：**尺寸上限** + **原子写**；JSON 由页面侧适配器
// （`src/client/platform-keyboard.ts`）解析与序列化，未知字段与未来 schemaVersion 原样保留
// ——所以这里既不 parse 也不 stringify。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const KEYBINDINGS_FILE = 'desktop-keybindings.json'
/** 上限 256 KiB（旧壳 `MAX_KEYBINDINGS_BYTES`）：挡住「整份配置写进快捷键档」这类事故。 */
export const MAX_KEYBINDINGS_BYTES = 256 * 1024

export function keybindingsPath(home: string): string {
  return join(home, KEYBINDINGS_FILE)
}

/** 读原始文本；文件不存在回 null（页面侧按「用默认绑定」处理）。 */
export function readKeybindings(home: string): string | null {
  try {
    return readFileSync(keybindingsPath(home), 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw new Error(`读取快捷键文件失败：${describe(error)}`)
  }
}

/** 原子写（先 `.json.tmp` 再 rename）；超限直接抛错且不落地。 */
export function writeKeybindings(home: string, raw: string): void {
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_KEYBINDINGS_BYTES) {
    throw new Error(`快捷键文件过大（${bytes} 字节，上限 ${MAX_KEYBINDINGS_BYTES}）`)
  }
  const path = keybindingsPath(home)
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (error) {
    throw new Error(`创建快捷键目录失败：${describe(error)}`)
  }
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, raw)
    renameSync(tmp, path)
  } catch (error) {
    throw new Error(`写快捷键文件失败：${describe(error)}`)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
