// 插件 staging：把壳要注入的插件包「物化」进 profile 的模块池，并写出 `--patch` 注入清单。
//
// 迁移自旧壳 `desktop/src-tauri/src/process/plugin.rs`：
//   - `desktop_plugin_dir` / `mobile_package_dir`（:15-231）：定位包目录（打包态从
//     `Contents/Resources/plugins/<name>`，开发态回退仓库活代码——`target/` 里的资源拷贝是
//     构建期快照，改插件源码不重打包就永远读旧的）；
//   - `materialize_pool_package`（:236-297）：把包挂进 `<profile>/node_modules`（unix 符号链接，
//     幂等；scoped 包名先补父目录，否则 symlink 直接 ENOENT，dsh 报 Cannot find package）；
//   - `desktop_plugin_patch_path`（:78-118）：写 `<app-data>/desktop-plugin-inject.yml`。
//
// 与旧壳的一处**有意差异**：注入行只写「真的物化成功的包」。旧壳固定写三行，缺包时交给 dsh
// 报解析失败；新壳在缺包时干脆不写那一行并留日志（worktree 里 `mobile/` 子模块没拉时也能起）。

import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { injectYml, insertRows, type InsertRow } from '../shared/inject-yml.ts'

/** 壳自己的插件包名（`package.json` 的 name，也是 profile 池里的挂载名）。 */
export const DESKTOP_PLUGIN_PACKAGE = 'dsh-desktop-tauriapp'
/** 手机访问插件（仓内 `mobile/dsh-mobile-access`）。 */
export const MOBILE_ACCESS_PACKAGE = 'dsh-mobile-access'
/** 移动布局插件（仓内 `mobile/dsh-mobile-nav`，上游 v2.3.0 起包名为 dsh-web-mobile）。 */
export const MOBILE_LAYOUT_REPO_DIR = 'dsh-mobile-nav'

export interface PluginPaths {
  /** 仓库根（开发态） */
  repoRoot: string
  /** 打包态资源根（`Contents/Resources`），没有就是 null */
  resourcesDir: string | null
}

export interface StagedPlugin {
  name: string
  dir: string
  /** 挂进池子的路径 */
  link: string
}

export interface StageResult {
  pool: string
  /** 注入清单文件路径 */
  injectFile: string
  staged: StagedPlugin[]
  /** 想挂但没找到包目录的（会在注入清单里被略过） */
  missing: string[]
}

/** 定位一个包目录：打包态资源优先（安装后仓库不在身边），开发态回退仓库活代码。 */
export function locatePackage(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(join(candidate, 'package.json'))) return resolve(candidate)
  }
  return null
}

/** 壳插件包目录：`DSH_DESKTOP_PLUGIN` > 打包态 `Resources/plugins/<name>` > 仓库根。 */
export function desktopPluginDir(paths: PluginPaths, env: Record<string, string | undefined> = {}): string | null {
  const explicit = env.DSH_DESKTOP_PLUGIN ?? ''
  const candidates = [
    explicit,
    paths.resourcesDir === null ? '' : join(paths.resourcesDir, 'plugins', DESKTOP_PLUGIN_PACKAGE),
    paths.repoRoot,
  ]
  return locatePackage(candidates)
}

/** 手机侧插件包目录：打包态 `Resources/plugins/<name>` > 仓库 `mobile/<rel>`。 */
export function mobilePackageDir(paths: PluginPaths, name: string, rel: string): string | null {
  const candidates = [
    paths.resourcesDir === null ? '' : join(paths.resourcesDir, 'plugins', name),
    join(paths.repoRoot, 'mobile', rel),
  ]
  return locatePackage(candidates)
}

/**
 * 挂进 profile 模块池（幂等）。已挂对目标就什么都不做；挂到别处（或旧复制体）先摘干净。
 * scoped 包名（`@scope/name`）会自动补父目录。
 */
export function materializePoolPackage(pool: string, linkName: string, dir: string): void {
  const link = join(pool, linkName)
  const parent = dirname(link)
  mkdirSync(parent, { recursive: true })
  const target = resolve(dir)
  try {
    if (resolve(readlinkSync(link)) === target) return
  } catch {
    // 不是链接（可能不存在，也可能是旧复制体）
  }
  if (existsSync(link)) rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
}

/**
 * 把三件套物化进 profile 池并写出注入清单，返回实际挂上的包。
 * `home`＝DSH_HOME，`profile`＝profile 名，`appSupport`＝写注入清单的目录。
 */
export function stagePlugins(options: {
  home: string
  profile: string
  appSupport: string
  paths: PluginPaths
  runtimeVersion?: string
  muxHeartbeatMs?: number
  desktopLayoutOnPhones?: boolean
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}): StageResult {
  const log = options.log ?? ((): void => {})
  const env = options.env ?? {}
  const pool = join(options.home, 'profiles', options.profile, 'node_modules')
  mkdirSync(pool, { recursive: true })

  const staged: StagedPlugin[] = []
  const missing: string[] = []
  const stage = (name: string, dir: string | null): void => {
    if (dir === null) {
      missing.push(name)
      return
    }
    materializePoolPackage(pool, name, dir)
    staged.push({ name, dir, link: join(pool, name) })
  }

  stage(DESKTOP_PLUGIN_PACKAGE, desktopPluginDir(options.paths, env))
  stage(MOBILE_ACCESS_PACKAGE, mobilePackageDir(options.paths, MOBILE_ACCESS_PACKAGE, MOBILE_ACCESS_PACKAGE))
  stage(
    'dsh-web-mobile',
    mobilePackageDir(options.paths, 'dsh-web-mobile', MOBILE_LAYOUT_REPO_DIR) ??
      mobilePackageDir(options.paths, MOBILE_LAYOUT_REPO_DIR, MOBILE_LAYOUT_REPO_DIR),
  )

  const available = new Set(staged.map((entry) => entry.name))
  const rows: InsertRow[] = insertRows({
    desktopPlugin: available.has(DESKTOP_PLUGIN_PACKAGE) ? DESKTOP_PLUGIN_PACKAGE : undefined,
    mobileAccess: available.has(MOBILE_ACCESS_PACKAGE) ? MOBILE_ACCESS_PACKAGE : undefined,
    mobileLayout: available.has('dsh-web-mobile') ? 'dsh-web-mobile' : undefined,
    desktopLayoutOnPhones: options.desktopLayoutOnPhones,
  })

  const content = injectYml({
    runtimeVersion: options.runtimeVersion,
    muxHeartbeatMs: options.muxHeartbeatMs,
    rows,
  })
  mkdirSync(options.appSupport, { recursive: true })
  const injectFile = join(options.appSupport, 'desktop-plugin-inject.yml')
  // 幂等：内容没变就不碰文件（保留 mtime，方便人工判断它最后一次真的变了是什么时候）
  let same = false
  try {
    same = readFileSync(injectFile, 'utf8') === content
  } catch {
    same = false
  }
  if (!same) writeFileSync(injectFile, content)

  log(
    `插件物化：${staged.map((entry) => entry.name).join('、') || '（无）'}` +
      (missing.length > 0 ? ` | 缺包跳过：${missing.join('、')}` : '') +
      ` | 注入清单 ${injectFile}`,
  )
  return { pool, injectFile, staged, missing }
}

/**
 * 退出时把本实例挂进 profile 池的链接拆掉（旧壳 `cleanup_desktop_plugin_links` 的等价物）。
 *
 * 为什么必须拆：dsh 的 `--patch` 注入清单是我们自己生成的，链接却留在用户 profile 里；
 * 不拆的话，用户回到旧 Tauri 壳（或换回安装版）时，profile 池里会挂着一份**已经不存在的**
 * 包目录（新壳被删除/移动后 symlink 悬空）⇒ 插件解析失败。
 *
 * 只删「还指向本实例自己那份包目录」的链接：升级窗口期/并行实例下不动别人的。
 * 不穿透实体目录：只有 readlink 能读出目标时才动（复制体不动）。
 */
export interface CleanupResult {
  removed: string[]
  kept: string[]
}

export function cleanupStagedPlugins(
  staged: readonly StagedPlugin[],
  log: (line: string) => void = (): void => {},
): CleanupResult {
  const removed: string[] = []
  const kept: string[] = []
  for (const entry of staged) {
    let target = ''
    try {
      target = readlinkSync(entry.link)
    } catch {
      // 不是链接（复制体、或已经被删）：不碰
      kept.push(entry.link)
      continue
    }
    const absolute = resolve(dirname(entry.link), target)
    if (absolute !== resolve(entry.dir)) {
      log(`[exit] 跳过他实例的插件链接 ${entry.link} -> ${target}`)
      kept.push(entry.link)
      continue
    }
    try {
      rmSync(entry.link, { force: true })
      removed.push(entry.link)
    } catch (error) {
      log(`[exit] 清理插件链接失败 ${entry.link}：${String(error)}`)
      kept.push(entry.link)
    }
  }
  if (removed.length > 0) log(`[exit] 已清理插件链接 ${removed.length} 个：${removed.join('、')}`)
  return { removed, kept }
}
