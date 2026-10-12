// 运行时下载安装：把 `@deepseek-ai/dsh@<version>` 装成一棵 hoisted 运行时树
// （旧壳 `desktop/src-tauri/src/runtime/registry.rs::pnpm_add_runtime` 的等价物）。
//
// 与旧壳的两处差别（都是本仓的既定方向）：
// ① 包管理器跑在**我们的 Bun** 上（`<bun> <pnpm.cjs> add …`），不再依赖系统 Node（#211 的结论）；
// ② 安装进度是壳侧单飞状态，面板每 600ms 轮询 `runtime_download_status` 读它（页面是 loopback origin，
//   事件通道照旧不用）。
//
// 旧壳踩过的坑全部照抄：独立 store（#114）、`packages: []` 截断 workspace 向上搜索（#95）、
// hoisted 平铺（#95）、allowBuilds 白名单（#135）、错误尾巴优先 stderr 再回退 stdout（#95 Bug 1）。

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { NPM_PACKAGE, isRuntimeVersion } from '../shared/runtime-catalog.ts'
import { runtimeNpmrc, runtimeWorkspaceYaml } from '../shared/profile-template.ts'
import { isRuntimeTreeValid, runtimeDirOf, runtimesDir } from './runtime-store.ts'

export const INSTALL_TIMEOUT_MS = 15 * 60_000
/** 失败报错里保留的输出行数（旧壳同口径：stderr 去噪后截尾 12 行） */
export const OUTPUT_TAIL_LINES = 12

export interface PnpmProgress {
  resolved: number
  downloaded: number
  added: number
}

// pnpm 11 的 default reporter 在 resolved 与 downloaded 之间多一段 `reused N,`（旧壳的解析器没算它，
// 于是从来没读到过进度）；这里把 reused 当可选段，新旧两种格式都认。
const PROGRESS_PATTERN =
  /Progress:\s*resolved\s+([\d,]+),\s*(?:reused\s+[\d,]+,\s*)?downloaded\s+([\d,]+),\s*added\s+([\d,]+)/

/** `Progress: resolved 1,234, downloaded 5, added 2` → 三个数字（非进度行回 null）。 */
export function parsePnpmProgress(line: string): PnpmProgress | null {
  const match = PROGRESS_PATTERN.exec(line)
  if (match === null) return null
  const toNumber = (raw: string | undefined): number => Number.parseInt((raw ?? '').replace(/,/g, ''), 10) || 0
  return { resolved: toNumber(match[1]), downloaded: toNumber(match[2]), added: toNumber(match[3]) }
}

/** node 的 TLS 告警与 `(node:1) Warning:` 噪声（旧壳同款过滤）。 */
function denoise(text: string): string {
  return text
    // pnpm 的 default reporter 会打 ANSI 光标控制码（进度行靠它原地重画），报错里不需要它们
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .filter((line) => !line.includes('NODE_TLS_REJECT_UNAUTHORIZED'))
    .filter((line) => !/^\(node:\d+\)/.test(line.trim()))
    .join('\n')
}

export function tailLines(text: string, count = OUTPUT_TAIL_LINES): string {
  const lines = denoise(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  return lines.slice(-count).join('\n')
}

/** 错误尾巴：stderr 有真东西就用它，否则回退 stdout（pnpm 非 TTY 下把 ERR_* 打到 stdout）。 */
export function pickInstallerErrorTail(stderr: string, stdout: string): string {
  const fromErr = tailLines(stderr)
  if (fromErr !== '') return fromErr
  return tailLines(stdout)
}

/** node 垫片：pnpm 的构建脚本会找 PATH 上叫 `node` 的命令，而本仓只有 Bun。 */
export function nodeShimScript(bunPath: string): string {
  return `#!/bin/sh\nexec "${bunPath}" "$@"\n`
}

export function ensureNodeShim(input: {
  appSupport: string
  bunPath: string
  hasNode: boolean
  isFileImpl?: (path: string) => boolean
  log?: (line: string) => void
}): string | null {
  // 系统里有 node 就不插手：让构建脚本用它最稳（我们不改用户的工具链）。
  if (input.hasNode) return null
  const dir = join(runtimesDir(input.appSupport), '.node-shim')
  const link = join(dir, 'node')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(link, nodeShimScript(input.bunPath), { mode: 0o755 })
    input.log?.(`运行时安装：PATH 上没有 node，已用 Bun 垫片（${link}）`)
    return dir
  } catch (error) {
    input.log?.(`运行时安装：node 垫片创建失败（${error instanceof Error ? error.message : String(error)}）`)
    return null
  }
}

export interface ResolvePnpmInput {
  env?: Record<string, string | undefined>
  /** 当前生效运行时树（内置或已下载） */
  runtimeRoot?: string | null
  builtinDir?: string | null
  appSupport: string
  isFileImpl?: (path: string) => boolean
}

/**
 * pnpm.cjs 的定位：显式 env > 当前运行时树 > 随包内置树 > 任一已下载树。
 * 内置树里那份是 `prepare-builtin-runtime.mjs` 装的 `pnpm@11.16.0`（`node_modules/pnpm/bin/pnpm.cjs`）。
 */
export function resolvePnpmCjs(input: ResolvePnpmInput): string | null {
  const env = input.env ?? process.env
  const file = input.isFileImpl ?? ((path: string) => existsSync(path))
  const explicit = env.DSH_SHELL_PNPM
  if (explicit !== undefined && explicit !== '') {
    if (file(explicit)) return explicit
  }
  const roots = [input.runtimeRoot ?? null, input.builtinDir ?? null]
  for (const root of roots) {
    if (root === null || root === '') continue
    const candidate = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (file(candidate)) return candidate
  }
  let entries: string[] = []
  try {
    entries = readdirSync(runtimesDir(input.appSupport), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    entries = []
  }
  for (const version of entries) {
    const candidate = join(runtimeDirOf(input.appSupport, version), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (file(candidate)) return candidate
  }
  return null
}

function lineSplitter(onLine: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder()
  let buffer = ''
  return (chunk: Uint8Array): void => {
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
}

async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (stream === null || stream === undefined) return
  const push = lineSplitter(onLine)
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) push(chunk)
}

export interface InstallRuntimeInput {
  appSupport: string
  version: string
  bunPath: string
  pnpmCjs: string
  /** 需要时把 `node` 垫片目录放到 PATH 最前（见 ensureNodeShim） */
  nodeShimDir?: string | null
  env?: Record<string, string | undefined>
  timeoutMs?: number
  onProgress?: (progress: PnpmProgress) => void
  onLog?: (line: string) => void
  spawnImpl?: (command: string[], options: Record<string, unknown>) => { exited: Promise<number>; stdout?: unknown; stderr?: unknown; kill?: () => void }
}

/**
 * 装一棵运行时树。失败时把半成品目录删掉并带上可读原因（面板直接显示它）。
 * 成功判据不是退出码而是 `isRuntimeTreeValid`（旧壳同判据）。
 */
export async function installRuntime(input: InstallRuntimeInput): Promise<void> {
  if (!isRuntimeVersion(input.version)) throw new Error(`版本号不合法：${input.version}`)
  const dir = runtimeDirOf(input.appSupport, input.version)
  if (isRuntimeTreeValid(dir)) throw new Error(`dsh ${input.version} 已经装好了`)
  const storeDir = join(runtimesDir(input.appSupport), '.pnpm-store')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: `dsh-runtime-${input.version}`, private: true }, null, 2)}\n`)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), runtimeWorkspaceYaml(storeDir))
  writeFileSync(join(dir, '.npmrc'), runtimeNpmrc(storeDir))

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...(input.env ?? {}) })) {
    if (value !== undefined) env[key] = value
  }
  if (input.nodeShimDir !== undefined && input.nodeShimDir !== null && input.nodeShimDir !== '') {
    // Windows 上 PATH 的分隔符是 `;`
    env.PATH = `${input.nodeShimDir}${delimiter}${env.PATH ?? ''}`
  }
  const spawn = input.spawnImpl ?? ((command: string[], options: Record<string, unknown>) => Bun.spawn(command, options as never))
  input.onLog?.(`运行时安装：${input.bunPath} ${input.pnpmCjs} add ${NPM_PACKAGE}@${input.version}（cwd = ${dir}）`)
  // `--reporter=default`：非 TTY 下 pnpm 默认走 append-only，**不打 Progress 行**（本机实测），
  // 面板的进度就永远是 0；显式要 default reporter 才有进度可读（旧壳没带这个旗标，一直读不到）。
  const proc = spawn([input.bunPath, input.pnpmCjs, 'add', '--reporter=default', `${NPM_PACKAGE}@${input.version}`], {
    cwd: dir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  }) as {
    exited: Promise<number>
    stdout?: ReadableStream<Uint8Array> | null
    stderr?: ReadableStream<Uint8Array> | null
    kill?: () => void
  }

  let stdoutTail = ''
  let stderrTail = ''
  const timeoutMs = input.timeoutMs ?? INSTALL_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill?.()
    } catch {}
  }, timeoutMs)
  try {
    await Promise.all([
      pump(proc.stdout, (line) => {
        const progress = parsePnpmProgress(line)
        if (progress !== null) {
          input.onProgress?.(progress)
          return
        }
        stdoutTail = `${stdoutTail}${line}\n`.slice(-8000)
      }),
      pump(proc.stderr, (line) => {
        stderrTail = `${stderrTail}${line}\n`.slice(-8000)
      }),
    ])
    const code = await proc.exited
    if (timedOut) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`dsh ${input.version} 安装超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    if (code !== 0) {
      const tail = pickInstallerErrorTail(stderrTail, stdoutTail)
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`dsh ${input.version} 安装失败（exit ${String(code)}）${tail === '' ? '' : `：\n${tail}`}`)
    }
  } finally {
    clearTimeout(timer)
  }
  if (!isRuntimeTreeValid(dir)) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`dsh ${input.version} 装完了但运行时树不完整（缺 node_modules/@deepseek-ai/dsh/lib/bin.js）`)
  }
}

/** 面板轮询读到的下载状态（旧壳 `runtime_download_status` 同形状）。 */
export interface RuntimeDownloadStatus {
  active: boolean
  version: string
  resolved: number
  downloaded: number
  added: number
  error: string
}

export interface RuntimeDownloader {
  /** 单飞：已有任务在跑就直接抛「已有运行时下载任务」（旧壳同文案，面板认这个串） */
  start: (version: string, source: string) => Promise<{ ok: true; version: string }>
  status: () => RuntimeDownloadStatus
}

export interface DownloaderDeps {
  /** 真正的安装动作（service 里接 installRuntime） */
  install: (version: string, onProgress: (progress: PnpmProgress) => void) => Promise<void>
  /** 装成功后记进 installed.json */
  record: (version: string, source: string) => void
  log?: (line: string) => void
}

export function createRuntimeDownloader(deps: DownloaderDeps): RuntimeDownloader {
  let status: RuntimeDownloadStatus = { active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '' }
  return {
    status: () => ({ ...status }),
    start: async (version, source) => {
      if (status.active) throw new Error('已有运行时下载任务')
      status = { active: true, version, resolved: 0, downloaded: 0, added: 0, error: '' }
      try {
        await deps.install(version, (progress) => {
          status = { ...status, resolved: progress.resolved, downloaded: progress.downloaded, added: progress.added }
        })
        deps.record(version, source)
        status = { active: false, version, resolved: status.resolved, downloaded: status.downloaded, added: status.added, error: '' }
        deps.log?.(`运行时安装完成：dsh ${version}（来源 ${source}）`)
        return { ok: true as const, version }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        status = { active: false, version, resolved: status.resolved, downloaded: status.downloaded, added: status.added, error: message }
        deps.log?.(`运行时安装失败：dsh ${version} —— ${message}`)
        throw error
      }
    },
  }
}
