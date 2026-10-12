#!/usr/bin/env bun
/**
 * 构建产物断言（CI 门禁 + 本地手验）：每个平台的包都要证明「它真的带 CEF」。
 *
 * 为什么必须有这道门：Electrobun 里 `renderer: 'cef'` 在**没打 CEF** 时会静默回落系统
 * webview（mac `nativeWrapper.mm:8359`、win `nativeWrapper.cpp:8944`、linux `nativeWrapper.cpp:591`），
 * 界面上看不出任何异常——但那就等于把 #200 那族 JavaScriptCore 崩溃原样带回来。所以不靠
 * 「构建时没报错」，而是打包后直接翻产物：payload 归档里有 CEF 运行时、`version.json` 的
 * channel 与更新源对得上。
 *
 * 用法：
 *   bun run scripts/assert-artifact.mjs                 # 自动找 build/ 下最新的 <env>-<os>-<arch>
 *   bun run scripts/assert-artifact.mjs <构建目录|.app>  # 指定产物
 *
 * 退出码：0 = 通过；1 = 断言失败（缺 CEF / 缺 version.json / 读不出归档）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..')
const buildRoot = join(projectRoot, 'build')

/** 各平台的 CEF 运行时标志（tar 列表里的路径片段）。 */
function cefMarkers(platform) {
  if (platform === 'darwin') {
    return [
      'Chromium Embedded Framework.framework/Chromium Embedded Framework',
      'Chromium Embedded Framework.framework/Libraries/libcef_sandbox.dylib',
    ]
  }
  if (platform === 'win32') return ['libcef.dll', 'chrome_elf.dll']
  return ['libcef.so', 'chrome-sandbox']
}

function listDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** 找 payload 归档（Electrobun 的更新包：mac 在 .app/Contents/Resources 下，win/linux 在构建目录里）。 */
function findPayloads(root, depth = 0) {
  if (depth > 4 || !existsSync(root)) return []
  const found = []
  for (const entry of listDir(root)) {
    const full = join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (entry.endsWith('.app') || !entry.startsWith('.')) found.push(...findPayloads(full, depth + 1))
      continue
    }
    if (entry.endsWith('.tar.zst')) found.push(full)
  }
  return found
}

/** 自动挑构建目录：优先 stable-<平台>-<架构>，其次最新的一个。 */
function pickTarget() {
  const explicit = process.argv[2]
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const candidates = listDir(buildRoot).filter((name) => !name.startsWith('.'))
  const stable = candidates.filter((name) => name.startsWith('stable-'))
  const chosen = (stable.length > 0 ? stable : candidates).sort().pop()
  if (chosen === undefined) {
    console.error(`[assert] build/ 下没有构建目录：${buildRoot}`)
    process.exit(1)
  }
  return join(buildRoot, chosen)
}

/** `tar --zstd -tf` 拿列表（macOS/Linux 的 bsdtar 与 Windows 自带的 tar 都支持；失败再退一次）。 */
function tarList(archive) {
  for (const args of [['--zstd', '-tf'], ['-tf']]) {
    const result = spawnSync('tar', [...args, archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout.split('\n')
  }
  return null
}

function tarExtract(archive, member) {
  for (const args of [['--zstd', '-xOf'], ['-xOf']]) {
    const result = spawnSync('tar', [...args, archive, member], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout
  }
  return null
}

const target = pickTarget()
const platform = process.platform
const payloads = findPayloads(target)
const problems = []

console.log(`[assert] 产物目录：${target}`)
console.log(`[assert] 平台：${platform}`)

if (payloads.length === 0) {
  problems.push('产物里没有 payload 归档（*.tar.zst）——Electrobun 的包结构变了？')
}

/** 二进制安全地把归档里的某个成员解到磁盘（内层归档可能很大，由调用方负责删）。 */
function tarExtractTo(archive, member, dest) {
  for (const args of [['--zstd', '-xOf'], ['-xOf']]) {
    const result = spawnSync('tar', [...args, archive, member], { maxBuffer: 2 * 1024 * 1024 * 1024 })
    if (result.status === 0 && result.stdout !== null && result.stdout.length > 0) {
      writeFileSync(dest, result.stdout)
      return true
    }
  }
  return false
}

/**
 * 断言一份归档。两类都认：
 *   · 叶子（真正的应用 payload）→ 必须有 CEF 运行时 + 可用的 version.json；
 *   · 包装层（Windows 的 `*-Setup.tar.zst` 就是这种）→ 里面还有内层 `*.tar.zst`，
 *     解出来递归断言。
 * 路径比较一律先把 `\` 归一成 `/`：Windows 上 tar 列表用的是反斜杠（CI 实测）。
 */
function inspect(archive, label, depth = 0) {
  const listing = tarList(archive)
  if (listing === null) {
    problems.push(`读不出归档列表：${label}（tar 不支持 zstd？装 zstd 或换 bsdtar）`)
    return
  }
  const norm = listing.map((line) => line.replace(/\\/g, '/')).filter((line) => line !== '')
  const versionLine = listing.find((line) => {
    const normalized = line.replace(/\\/g, '/')
    return normalized === 'version.json' || normalized.endsWith('/version.json')
  })
  const nested = norm.filter((line) => line.endsWith('.tar.zst'))
  if (versionLine === undefined && nested.length > 0 && depth < 2) {
    console.log(`[assert] ${label} → 包装层（内含 ${String(nested.length)} 份内层归档），逐份解出来再断言`)
    for (const member of nested) {
      const scratch = join(tmpdir(), `dsh-assert-${String(process.pid)}-${String(depth)}.tar.zst`)
      try {
        if (tarExtractTo(archive, member, scratch)) inspect(scratch, `${label} → ${member}`, depth + 1)
        else problems.push(`解不出内层归档：${label} → ${member}`)
      } finally {
        rmSync(scratch, { force: true })
      }
    }
    return
  }
  const joined = norm.join('\n')
  for (const marker of cefMarkers(platform)) {
    if (!joined.includes(marker)) problems.push(`${label} 里缺 CEF 标志：${marker}`)
  }
  if (versionLine === undefined) {
    problems.push(`${label} 里没有 version.json（更新与版本号都靠它）`)
    return
  }
  const raw = tarExtract(archive, versionLine)
  try {
    const parsed = JSON.parse(raw ?? '')
    const channel = String(parsed.channel ?? '')
    const baseUrl = String(parsed.baseUrl ?? '')
    const version = String(parsed.version ?? '')
    console.log(`[assert] ${label} → version=${version} channel=${channel} baseUrl=${baseUrl || '(空)'}`)
    if (version === '') problems.push(`${label} 的 version.json 没有版本号`)
    if (channel === '') problems.push(`${label} 的 version.json 没有 channel`)
    // dev 构建本来就不带更新源（框架也拒绍更新 dev）；stable 必须带，否则自动更新永远不可用。
    if (channel === 'stable' && baseUrl === '') {
      problems.push(`${label}：stable 包没有 baseUrl（release.baseUrl 配错层了？）`)
    }
  } catch (error) {
    problems.push(`${label} 的 version.json 解析失败：${String(error)}`)
  }
}

for (const payload of payloads) inspect(payload, payload.slice(target.length + 1))

// 安装包形态也顺带报一下（dmg / Setup.zip / tar.gz 都是预期产物，缺了不判失败，只提示）。
const installers = listDir(target).filter((name) => /\.(dmg|zip|tar\.gz|tar\.zst)$/.test(name))
console.log(`[assert] 目录内产物：${installers.length === 0 ? '(只有 app 目录)' : installers.join(', ')}`)

if (problems.length > 0) {
  console.error('[assert] 失败：')
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}
console.log(`[assert] 通过：${payloads.length} 份 payload 都带 CEF 运行时与可用的 version.json`)
