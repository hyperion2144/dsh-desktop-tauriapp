// 运行时目录（纯逻辑）：旧壳 desktop/src-tauri/src/runtime/registry.rs 的等价物。
//
// 布局（与旧壳一致）：`<appSupport>/runtimes/<version>/`，结构与随包内置树同构
// （`node_modules/@deepseek-ai/dsh/lib/bin.js`）。清单 `runtimes/installed.json`
// 记录来源与安装时间；settings 的 `dsh_runtime` 指向选中的已下载版本。
//
// 本模块不碰文件系统：抓取结果的解析、版本比较、清单读写内容、选中判定都在这儿，
// 便于用桩数据把边界（预发布号大小、坏 JSON、渠道标注、清单去重）钉死。



export const NPM_PACKAGE = '@deepseek-ai/dsh'
export const DEFAULT_GITHUB_REPO = 'deepseek-ai/deepseek-harness'
export const RUNTIMES_DIR = 'runtimes'
/** 运行时回收站（旧壳 #114）：卸载先 rename 到此，真正删除推迟到下次启动 */
export const RUNTIME_TRASH_DIR = '.trash'
export const INSTALLED_MANIFEST = 'installed.json'
/** 目录抓取上限（与旧壳一致：各源取最近 20 条） */
export const MAX_CATALOG = 20

export interface CatalogEntry {
  version: string
  /** 渠道标注：latest / alpha / rc / 空（普通版本） */
  channel: string
}

export interface InstalledRuntime {
  version: string
  source: string
  installed_at: number
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function isRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}

interface ParsedVersion {
  core: number[]
  pre: string[]
}

function parseVersion(version: string): ParsedVersion | null {
  if (!isRuntimeVersion(version)) return null
  const [core, pre] = version.split('-', 2) as [string, string | undefined]
  return {
    core: core.split('.').map((part) => Number.parseInt(part, 10)),
    pre: pre === undefined ? [] : pre.split('.'),
  }
}

/** 预发布段比较：纯数字按数值（alpha.10 > alpha.2），其余按字典序；数字段比非数字段小。 */
function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // 有预发布段的一方更小（1.0.0-rc.1 < 1.0.0）
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = /^\d+$/.test(left) ? Number.parseInt(left, 10) : null
    const rightNumber = /^\d+$/.test(right) ? Number.parseInt(right, 10) : null
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
      continue
    }
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** 语义化版本比较；解析不了的按字符串比较（绝不抛）。 */
export function compareRuntimeVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a === b ? 0 : a < b ? -1 : 1
  for (let index = 0; index < 3; index += 1) {
    const l = left.core[index] ?? 0
    const r = right.core[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return comparePre(left.pre, right.pre)
}

export function sortRuntimeVersionsDesc(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => compareRuntimeVersions(b, a))
}

/** 渠道标注：命中 dist-tag 就用它，否则按版本号里的预发布段猜。 */
export function runtimeChannel(version: string, tags: { latest?: string; alpha?: string; rc?: string } = {}): string {
  if (tags.latest !== undefined && tags.latest !== '' && tags.latest === version) return 'latest'
  if (tags.alpha !== undefined && tags.alpha !== '' && tags.alpha === version) return 'alpha'
  if (tags.rc !== undefined && tags.rc !== '' && tags.rc === version) return 'rc'
  if (version.includes('-alpha')) return 'alpha'
  if (version.includes('-rc')) return 'rc'
  return ''
}

/** GitHub releases 载荷 → 目录条目（tag 形如 `dsh-v0.1.5-rc.2`：先剥 dsh- 再剥 v）。 */
export function parseGithubCatalog(payload: unknown): CatalogEntry[] {
  const list = Array.isArray(payload) ? payload : []
  const entries: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue
    const tag = (row as { tag_name?: unknown }).tag_name
    if (typeof tag !== 'string') continue
    const version = tag.replace(/^dsh-/, '').replace(/^v/, '')
    if (!isRuntimeVersion(version) || seen.has(version)) continue
    seen.add(version)
    // GitHub 没有 dist-tags：渠道按 tag 文本标（旧壳同口径：alpha / rc / 其余算 latest）
    entries.push({ version, channel: tag.includes('alpha') ? 'alpha' : tag.includes('rc') ? 'rc' : 'latest' })
    if (entries.length >= MAX_CATALOG) break
  }
  return entries
}

/** npm registry 载荷 → 目录条目（dist-tags 标渠道，其余取版本列表，按版本排序取前 N）。 */
export function parseNpmCatalog(payload: unknown): CatalogEntry[] {
  if (typeof payload !== 'object' || payload === null) return []
  const meta = payload as { 'dist-tags'?: unknown; versions?: unknown }
  const tags = typeof meta['dist-tags'] === 'object' && meta['dist-tags'] !== null ? (meta['dist-tags'] as Record<string, unknown>) : {}
  const latest = typeof tags.latest === 'string' ? tags.latest : undefined
  const alpha = typeof tags.alpha === 'string' ? tags.alpha : undefined
  const rc = typeof tags.rc === 'string' ? tags.rc : undefined
  const versions =
    typeof meta.versions === 'object' && meta.versions !== null ? Object.keys(meta.versions as Record<string, unknown>) : []
  const valid = versions.filter(isRuntimeVersion)
  // dist-tag 指到的版本一定在列表里（面板上「最新/预览」不该因为按版本号排到 20 名开外而消失）
  const tagged = [latest, alpha, rc].filter((value): value is string => isRuntimeVersion(value)).filter((value, index, all) => all.indexOf(value) === index)
  const rest = sortRuntimeVersionsDesc(valid.filter((version) => !tagged.includes(version)))
  return [...tagged, ...rest]
    .slice(0, MAX_CATALOG)
    .map((version) => ({ version, channel: runtimeChannel(version, { latest, alpha, rc }) }))
}

/** 清单解析：坏 JSON / 非数组 / 缺字段一律丢弃该行（不抛）。 */
export function parseInstalledManifest(text: string): InstalledRuntime[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { runtimes?: unknown }).runtimes) ? ((parsed as { runtimes: unknown[] }).runtimes) : []
  const out: InstalledRuntime[] = []
  const seen = new Set<string>()
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as { version?: unknown; source?: unknown; installed_at?: unknown }
    if (typeof record.version !== 'string' || record.version === '' || seen.has(record.version)) continue
    seen.add(record.version)
    out.push({
      version: record.version,
      source: typeof record.source === 'string' ? record.source : '',
      installed_at: typeof record.installed_at === 'number' && Number.isFinite(record.installed_at) ? record.installed_at : 0,
    })
  }
  return out
}

export function serializeInstalledManifest(list: readonly InstalledRuntime[]): string {
  const sorted = sortRuntimeVersionsDesc(list.map((entry) => entry.version)).map(
    (version) => list.find((entry) => entry.version === version) as InstalledRuntime,
  )
  return `${JSON.stringify({ runtimes: sorted }, null, 2)}\n`
}

export function upsertInstalled(list: readonly InstalledRuntime[], entry: InstalledRuntime): InstalledRuntime[] {
  return [...list.filter((row) => row.version !== entry.version), entry]
}

export function removeInstalledEntry(list: readonly InstalledRuntime[], version: string): InstalledRuntime[] {
  return list.filter((row) => row.version !== version)
}

/** 从 `dsh --version` 输出里取版本号（形如 `0.1.7-rc.2`；取不到返回 null）。 */
export function parseCliVersion(text: string): string | null {
  for (const raw of text.split(/\s+/)) {
    // `dsh/0.2.1-alpha.2`、`v0.2.1`、`0.1.7-rc.2,` 都要能认出来
    const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
    const cleaned = tail.replace(/^v/, '').replace(/[),;]+$/, '')
    if (isRuntimeVersion(cleaned)) return cleaned
  }
  return null
}

/**
 * 选中哪个已下载版本（旧壳语义）：
 * 偏好版本仍装着就用它；否则用装着的最高版本；一个都没有就返回 null（= 回内置兜底）。
 */
export function selectRuntimeVersion(input: {
  installed: readonly string[]
  preferred?: string | null
  builtin?: string | null
}): string | null {
  const installed = input.installed.filter(isRuntimeVersion)
  const preferred = input.preferred ?? null
  if (preferred !== null && preferred !== '' && installed.includes(preferred)) return preferred
  const sorted = sortRuntimeVersionsDesc(installed)
  return sorted[0] ?? null
}

/** 已安装版本行（设置面板的 installed 数组）：清单为准、目录扫描补漏。 */
export function mergeInstalled(
  fromManifest: readonly InstalledRuntime[],
  fromDisk: readonly string[],
): InstalledRuntime[] {
  const byVersion = new Map<string, InstalledRuntime>()
  for (const version of fromDisk) {
    if (!isRuntimeVersion(version)) continue
    byVersion.set(version, { version, source: '', installed_at: 0 })
  }
  for (const row of fromManifest) {
    const existing = byVersion.get(row.version)
    byVersion.set(row.version, existing === undefined ? row : { ...row, source: row.source === '' ? existing.source : row.source })
  }
  return sortRuntimeVersionsDesc([...byVersion.keys()]).map((version) => byVersion.get(version) as InstalledRuntime)
}
