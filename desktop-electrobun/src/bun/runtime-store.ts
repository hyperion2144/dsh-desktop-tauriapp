// 运行时目录的 IO 半边：扫描已装版本、清单读写、回收站、目录抓取、外部 dsh 定位。
//
// 与旧壳 desktop/src-tauri/src/runtime/registry.rs 对齐的几条约定：
// - 有效性判据 = `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js` 是文件（旧壳 is_valid_runtime）；
// - 版本号取自 `<root>/node_modules/@deepseek-ai/dsh/package.json`（不是目录名）；
// - 卸载不直接 unlink：先 rename 进 `.trash`，真正删除推迟到下次壳启动（旧壳 #114——
//   直接删会改到与运行树 hardlink 共享 inode 的 ctime/size，触发 dsh 插件 rebuilt → 白屏）；
// - 目录抓取失败不抛给调用方：返回 `{entries, error}`，设置面板降级显示已下载版本（旧壳 #107）。

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_GITHUB_REPO,
  INSTALLED_MANIFEST,
  NPM_PACKAGE,
  RUNTIMES_DIR,
  RUNTIME_TRASH_DIR,
  isRuntimeVersion,
  mergeInstalled,
  parseGithubCatalog,
  parseInstalledManifest,
  parseNpmCatalog,
  removeInstalledEntry,
  serializeInstalledManifest,
  sortRuntimeVersionsDesc,
  upsertInstalled,
  type CatalogEntry,
  type InstalledRuntime,
} from '../shared/runtime-catalog.ts'

export interface RuntimeStoreLogger {
  (message: string): void
}

export function runtimesDir(appSupport: string): string {
  return join(appSupport, RUNTIMES_DIR)
}

export function runtimeDirOf(appSupport: string, version: string): string {
  return join(runtimesDir(appSupport), version)
}

export function runtimeTrashDir(appSupport: string): string {
  return join(runtimesDir(appSupport), RUNTIME_TRASH_DIR)
}

export function installedManifestPath(appSupport: string): string {
  return join(runtimesDir(appSupport), INSTALLED_MANIFEST)
}

/** 运行时树的 dsh 包根（root 布局；外部 CLI 树是另一套，见 packageRootOf）。 */
export function dshPackageRootOf(runtimeDir: string): string {
  return join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
}

export function isRuntimeTreeValid(runtimeDir: string): boolean {
  return existsSync(join(dshPackageRootOf(runtimeDir), 'lib', 'bin.js'))
}

/** 运行时树里 dsh 的真实版本号（读 package.json；读不到返回 null）。 */
export function readRuntimeVersion(runtimeDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dshPackageRootOf(runtimeDir), 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** 扫描 appSupport/runtimes 下有效的版本目录（跳过 .trash 与半成品）。 */
export function scanInstalledVersions(appSupport: string): string[] {
  const root = runtimesDir(appSupport)
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return sortRuntimeVersionsDesc(
    entries.filter((version) => isRuntimeVersion(version) && isRuntimeTreeValid(runtimeDirOf(appSupport, version))),
  )
}

export function readInstalledManifest(appSupport: string): InstalledRuntime[] {
  try {
    return parseInstalledManifest(readFileSync(installedManifestPath(appSupport), 'utf8'))
  } catch {
    return []
  }
}

export function writeInstalledManifest(appSupport: string, list: readonly InstalledRuntime[]): void {
  const path = installedManifestPath(appSupport)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeInstalledManifest(list))
}

/** 已装运行时行：清单为准、目录扫描补漏（面板的 installed 数组）。 */
export function listInstalledRuntimes(appSupport: string): InstalledRuntime[] {
  return mergeInstalled(readInstalledManifest(appSupport), scanInstalledVersions(appSupport))
}

export function recordInstalledRuntime(appSupport: string, entry: InstalledRuntime): InstalledRuntime[] {
  const next = upsertInstalled(readInstalledManifest(appSupport), entry)
  writeInstalledManifest(appSupport, next)
  return next
}

export function forgetInstalledRuntime(appSupport: string, version: string): InstalledRuntime[] {
  const next = removeInstalledEntry(readInstalledManifest(appSupport), version)
  writeInstalledManifest(appSupport, next)
  return next
}

/**
 * 卸载：先移进回收站（rename 是原子的，且不动 inode），清单里立刻摘掉，
 * 真正删除留给下次启动的 purgeRuntimeTrash。
 */
export function trashInstalledRuntime(appSupport: string, version: string, log?: RuntimeStoreLogger): void {
  const dir = runtimeDirOf(appSupport, version)
  const trash = runtimeTrashDir(appSupport)
  mkdirSync(trash, { recursive: true })
  if (existsSync(dir)) {
    const target = join(trash, `${String(Date.now())}-${version}`)
    renameSync(dir, target)
    log?.(`运行时 dsh ${version} 已移入回收站（下次启动清理）：${target}`)
  } else {
    log?.(`运行时 dsh ${version} 目录不存在，只清理清单`)
  }
  forgetInstalledRuntime(appSupport, version)
}

/** 清空回收站（壳启动、spawn dsh 之前调用；失败只记日志，不阻塞启动）。 */
export function purgeRuntimeTrash(appSupport: string, log?: RuntimeStoreLogger): number {
  const trash = runtimeTrashDir(appSupport)
  if (!existsSync(trash)) return 0
  let removed = 0
  for (const entry of readdirSync(trash, { withFileTypes: true })) {
    const target = join(trash, entry.name)
    try {
      rmSync(target, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      log?.(`回收站清理失败：${target}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return removed
}

export interface CatalogResult {
  entries: CatalogEntry[]
  error?: string
}

export interface FetchCatalogInput {
  source: string
  repo?: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
  log?: RuntimeStoreLogger
}

/** 版本目录抓取：github → releases API；npm → registry 元数据。失败不算异常（error 交给面板）。 */
export async function fetchRuntimeCatalog(input: FetchCatalogInput): Promise<CatalogResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, input.timeoutMs ?? 12_000)
  try {
    if (input.source === 'npm') {
      const response = await fetchImpl(`https://registry.npmjs.org/${NPM_PACKAGE}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: controller.signal,
      })
      if (!response.ok) return { entries: [], error: `npm registry 查询失败：HTTP ${String(response.status)}` }
      return { entries: parseNpmCatalog(await response.json()) }
    }
    const repo = input.repo !== undefined && input.repo !== null && input.repo.trim() !== '' ? input.repo.trim() : DEFAULT_GITHUB_REPO
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${String(20)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop-tauriapp' },
      signal: controller.signal,
    })
    if (!response.ok) return { entries: [], error: `GitHub releases 查询失败：HTTP ${String(response.status)}` }
    return { entries: parseGithubCatalog(await response.json()) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.log?.(`[runtime] 版本目录拉取失败（降级为仅本地已装）：${message}`)
    return { entries: [], error: message }
  } finally {
    clearTimeout(timeout)
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 版本号键：`0.2.1-alpha.10` → [0,2,1,10]（用于 nvm 目录挑最高版本）。 */
function versionKey(dir: string): number[] {
  const name = dir.split('/').pop() ?? ''
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(name)
  if (match === null) return [0, 0, 0]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 找外部 dsh 可执行文件（旧壳 process/lifecycle.rs::find_dsh_bin 的等价物）：
 * ① `DSH_BIN` 环境变量 ② PATH ③ 常见安装位置（含 nvm 最高版本、npx 缓存最新目录）。
 */
export function resolveExternalDsh(
  env: Record<string, string | undefined>,
  options: {
    home?: string
    isFileImpl?: (path: string) => boolean
    /** 覆盖「常见安装位置」这一层（测试用；给了就不再扫 nvm / npx 缓存） */
    commonCandidates?: readonly string[]
    log?: RuntimeStoreLogger
  } = {},
): string | null {
  const file = options.isFileImpl ?? isFile
  const explicit = env.DSH_BIN
  if (explicit !== undefined && explicit !== '') {
    if (file(explicit)) {
      options.log?.(`外部 dsh：使用 DSH_BIN = ${explicit}`)
      return resolve(explicit)
    }
    options.log?.(`DSH_BIN 指向的文件不存在：${explicit}`)
  }
  for (const dir of (env.PATH ?? '').split(':').filter((entry) => entry !== '')) {
    const candidate = join(dir, 'dsh')
    if (file(candidate)) {
      options.log?.(`外部 dsh：在 PATH 中找到 ${candidate}`)
      return resolve(candidate)
    }
  }
  const home = options.home ?? env.HOME ?? ''
  const candidates: string[] = [...(options.commonCandidates ?? ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh', join(home, '.npm-global', 'bin', 'dsh')])]
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  for (const candidate of options.commonCandidates === undefined ? [] : candidates) {
    if (file(candidate)) {
      options.log?.(`外部 dsh：找到 ${candidate}`)
      return resolve(candidate)
    }
  }
  if (options.commonCandidates !== undefined) return null
  try {
    const dirs = readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(nvmRoot, entry.name))
      .sort((a, b) => {
        const left = versionKey(a)
        const right = versionKey(b)
        for (let index = 0; index < 3; index += 1) {
          const l = left[index] ?? 0
          const r = right[index] ?? 0
          if (l !== r) return l - r
        }
        return 0
      })
    for (const dir of dirs.reverse()) candidates.push(join(dir, 'bin', 'dsh'))
  } catch {}
  const npxRoot = join(home, '.npm', '_npx')
  try {
    const dirs = readdirSync(npxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(npxRoot, entry.name))
      .sort((a, b) => {
        const left = statSync(a).mtimeMs
        const right = statSync(b).mtimeMs
        return left - right
      })
    for (const dir of dirs.reverse()) candidates.push(join(dir, 'node_modules', '.bin', 'dsh'))
  } catch {}
  for (const candidate of candidates) {
    if (file(candidate)) {
      options.log?.(`外部 dsh：找到 ${candidate}`)
      return resolve(candidate)
    }
  }
  return null
}

/**
 * 外部 dsh 的包根：从 bin 的真实路径往上找 `@deepseek-ai/dsh` 包目录。
 * 例：`/opt/homebrew/bin/dsh` → `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`。
 */
export function externalPackageRoot(bin: string, realpathImpl: (path: string) => string = realpathSync): string | null {
  let real = bin
  try {
    real = realpathImpl(bin)
  } catch {}
  let dir = dirname(real)
  for (let depth = 0; depth < 8; depth += 1) {
    if (isFile(join(dir, 'lib', 'bin.js')) && isFile(join(dir, 'package.json'))) return dir
    const nested = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    if (isFile(join(nested, 'lib', 'bin.js'))) return nested
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** 外部安装的版本号（读包根 package.json）。 */
export function externalVersion(packageRoot: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

export interface ExternalDshResolution {
  bin: string
  packageRoot: string
  version: string | null
  /** 看过但用不了的候选（诊断：壳要能说清为啥没用它） */
  skipped: string[]
}

/**
 * 从「壳自己装的 dsh 垫片脚本」里抠出真正的 bin.js 路径（旧壳 runtime/bin-dsh/dsh 就是这种）：
 *   #!/bin/sh
 *   exec "…/Contents/MacOS/dsh-node" "…/@deepseek-ai/dsh/lib/bin.js" "$@"
 * 外部路径跟着用户 PATH 走时常常先撞到这个垫片，能认出来就不用让用户去改 PATH。
 */
export function binFromShimScript(path: string): string | null {
  let text: string
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 8 * 1024) return null
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const match = /([^\s"']*[/\\]lib[/\\]bin\.js)/.exec(text)
  if (match === null || match[1] === undefined) return null
  const candidate = match[1]
  return isFile(candidate) ? candidate : null
}

/**
 * 外部 dsh 的可用性判定：沿候选链找到第一个「能定位到包根」的（旧壳只找到 bin 就收，
 * 但新壳要用它的树 + 我们的 Bun 起宿主，定位不到包根就没法用）。
 */
export function resolveExternalRuntime(
  env: Record<string, string | undefined>,
  options: {
    home?: string
    isFileImpl?: (path: string) => boolean
    commonCandidates?: readonly string[]
    log?: RuntimeStoreLogger
  } = {},
): ExternalDshResolution | null {
  const bin = resolveExternalDsh(env, options)
  const skipped: string[] = []
  const tryBin = (candidate: string): ExternalDshResolution | null => {
    const root = externalPackageRoot(candidate)
    if (root !== null) return { bin: candidate, packageRoot: root, version: externalVersion(root), skipped }
    const fromShim = binFromShimScript(candidate)
    if (fromShim !== null) {
      const shimRoot = externalPackageRoot(fromShim)
      if (shimRoot !== null) {
        options.log?.(`外部 dsh：${candidate} 是壳的垫片脚本，指向 ${fromShim}`)
        return { bin: candidate, packageRoot: shimRoot, version: externalVersion(shimRoot), skipped }
      }
    }
    skipped.push(`${candidate}（定位不到 @deepseek-ai/dsh 包根）`)
    return null
  }
  if (bin !== null) {
    const hit = tryBin(bin)
    if (hit !== null) return hit
  }
  // 第一个候选不可用时继续往后找（PATH 上常见的垫片脚本会排在真安装前面）
  for (const candidate of externalCandidates(env, options)) {
    if (candidate === bin) continue
    const hit = tryBin(candidate)
    if (hit !== null) return hit
  }
  return null
}

/** 候选链（与 resolveExternalDsh 同序），供「第一个用不了就试下一个」用。 */
function externalCandidates(
  env: Record<string, string | undefined>,
  options: { home?: string; commonCandidates?: readonly string[] } = {},
): string[] {
  const home = options.home ?? env.HOME ?? ''
  const list: string[] = []
  const explicit = env.DSH_BIN
  if (explicit !== undefined && explicit !== '') list.push(resolve(explicit))
  for (const dir of (env.PATH ?? '').split(':').filter((entry) => entry !== '')) list.push(join(dir, 'dsh'))
  list.push(...(options.commonCandidates ?? ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh', join(home, '.npm-global', 'bin', 'dsh')]))
  return list.filter((value, index) => list.indexOf(value) === index)
}
