#!/usr/bin/env bun
/**
 * Windows 安装程序打包（A2/A4）：把 `hutch electrobun build` 的 Windows 产物装进 NSIS。
 *
 * 为什么要有这一步：Electrobun 的 Windows 产物是「构建目录 + payload 归档（*.tar.zst）」，
 * 没有可直接双击的安装器；旧壳（Tauri）给的是 -setup.exe。这里用 NSIS 补上等价物：
 *   · 可直接执行的 setup.exe（A2）
 *   · 安装程序与应用图标（win.icon 同源 resources/app-icon.ico，A2）
 *   · 目录选择页（InstallDir + InstallDirRegKey，A4 可选安装目录）
 *   · 每用户安装（RequestExecutionLevel user，不需要管理员）+ 开始菜单快捷方式 + 卸载器
 *
 * 用法（Windows CI 或本机）：
 *   bun run scripts/build-windows-installer.mjs            # 自动找 build/stable-windows-x64
 *   makensis 必须在 PATH（GitHub windows-latest 镜像自带 NSIS；缺了先 choco install nsis）
 *
 * 退出码：0 = 安装器已生成；1 = 找不到产物 / makensis 失败。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(import.meta.dir, '..')
const buildRoot = join(projectRoot, 'build')

/** 找 Windows 构建目录：Electrobun 在 Windows 上的目录名不带 'windows' 字样（CI 实测），
 * 所以不按名字猜——挨个看哪份里能找到 launcher.exe，优先 stable-* 与最新名。 */
function pickBuildDir() {
  if (!existsSync(buildRoot)) return null
  const entries = readdirSync(buildRoot).filter((name) => !name.startsWith('.'))
  const stable = entries.filter((name) => name.startsWith('stable-'))
  const ordered = (stable.length > 0 ? stable : entries).sort().reverse()
  for (const name of ordered) {
    const dir = join(buildRoot, name)
    if (findLauncher(dir) !== null) return dir
  }
  return null
}

/** 找 launcher.exe 的完整路径（depth ≤ 4）：Windows 的应用根下是 bin/launcher.exe。 */
function findLauncher(root, depth = 0) {
  if (depth > 4 || !existsSync(root)) return null
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isFile() && entry === 'launcher.exe') return full
    if (!info.isDirectory()) continue
    const hit = findLauncher(full, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

function listFilesRecursive(root, base = root, out = []) {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) listFilesRecursive(full, base, out)
    else out.push(full)
  }
  return out
}

/** NSIS 字符串转义：双引号与 $ 需要转（$ 在 NSIS 里有变量语义）。 */
function nsiEscape(text) {
  return text.replaceAll('$', '$$').replaceAll('"', '$\\"')
}

const buildDir = pickBuildDir()
if (buildDir === null) {
  console.error(`[installer] build/ 下没有 Windows 构建目录：${buildRoot}`)
  process.exit(1)
}
// 应用根 = 构建目录下唯一的顶层目录（mac 是 .app，Windows 是 DeepSeekHarnessDesktopBUN/）。
// 打包整棵树：launcher + Resources/payload 归档都要装下去，首启自解压才有的解。
const launcher = findLauncher(buildDir)
if (launcher === null) {
  console.error(`[installer] ${buildDir} 里找不到 launcher.exe`)
  process.exit(1)
}
const topLevel = readdirSync(buildDir).filter((name) => {
  try {
    return statSync(join(buildDir, name)).isDirectory()
  } catch {
    return false
  }
})
if (topLevel.length !== 1) {
  console.error(`[installer] 构建目录顶层应有且只有一个应用目录，实际：${topLevel.join(', ')}`)
  process.exit(1)
}
const appDir = join(buildDir, topLevel[0] ?? '')
const appDirName = topLevel[0] ?? ''
const iconPath = join(projectRoot, 'resources', 'app-icon.ico')
if (!existsSync(iconPath)) {
  console.error('[installer] 缺 resources/app-icon.ico（先跑 prepare:bundle 或提交仓内源）')
  process.exit(1)
}

// 应用目录可能上万文件（CEF），逐条 File /r 会爆命令行：改成在 NSIS 里对整目录 /r 递归。
// OutFile 固定落 artifacts/（与 mac dmg 同一个交付目录）。
const outFile = join(projectRoot, 'artifacts', 'windows-x64-DeepSeekHarnessDesktopBUN-setup.exe')
const nsiTemplate = `
!define APP_NAME "DeepSeek Harness Desktop BUN"
!define APP_ID "DeepSeekHarnessDesktopBUN"
!define APP_DIR_NAME "${nsiEscape(appDirName)}"

Name "@@APP_NAME@@"
OutFile "${nsiEscape(outFile)}"
InstallDir "$LOCALAPPDATA\\@@APP_ID@@"
InstallDirRegKey HKCU "Software\\@@APP_ID@@" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUnInstDetails show
Icon "${nsiEscape(iconPath)}"
UninstallIcon "${nsiEscape(iconPath)}"
Caption "@@APP_NAME@@ 安装程序"
SpaceTexts none

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "install"
  SetOutPath "$INSTDIR\\@@APP_DIR_NAME@@"
  File /r "${nsiEscape(appDir)}\\*.*"
  @@PAYLOAD_RENAME@@  ; Windows 自解压约定：<launcher 同目录>/.installer/<stem>.tar.zst + <stem>.metadata.json
  WriteUninstaller "$INSTDIR\\@@APP_DIR_NAME@@\\uninstall.exe"
  WriteRegStr HKCU "Software\\@@APP_ID@@" "InstallDir" $INSTDIR
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "DisplayName" "@@APP_NAME@@"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "DisplayIcon" "$INSTDIR\\@@APP_DIR_NAME@@\\launcher.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@" "UninstallString" "$INSTDIR\\@@APP_DIR_NAME@@\\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\\@@APP_NAME@@"
  CreateShortCut "$SMPROGRAMS\\@@APP_NAME@@\\@@APP_NAME@@.lnk" "$INSTDIR\\@@APP_DIR_NAME@@\\launcher.exe"
  CreateShortCut "$SMPROGRAMS\\@@APP_NAME@@\\卸载.lnk" "$INSTDIR\\@@APP_DIR_NAME@@\\uninstall.exe"
SectionEnd

Section "un.install"
  ; 卸载器的 $INSTDIR 从安装时写的注册表恢复（用户自定义目录也要卸干净）
  ReadRegStr $INSTDIR HKCU "Software\\@@APP_ID@@" "InstallDir"
  Delete "$SMPROGRAMS\\@@APP_NAME@@\\@@APP_NAME@@.lnk"
  Delete "$SMPROGRAMS\\@@APP_NAME@@\\卸载.lnk"
  RMDir "$SMPROGRAMS\\@@APP_NAME@@"
  RMDir /r "$INSTDIR\\@@APP_DIR_NAME@@"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\@@APP_ID@@"
  DeleteRegKey HKCU "Software\\@@APP_ID@@"
SectionEnd`
  // Windows 自解压约定（extractor/main.zig extractFromSelf）：exe 同目录的 .installer/<stem>.tar.zst + <stem>.metadata.json，
  // 退回同目录裸 <stem>.tar.zst/<stem>.metadata.json。hutch 产出的 payload 在 Resources/<hash>.tar.zst，装完就地改名挪过去。
  const payloadDir = join(appDir, 'Resources')
  const payloadListing = existsSync(payloadDir) ? readdirSync(payloadDir) : []
  const payloadArchive = payloadListing.find((name) => name.endsWith('.tar.zst'))
  const payloadMetadata = payloadListing.find((name) => name === 'metadata.json')
  let payloadRename = '; 未找到 Resources/<hash>.tar.zst，跳过自解压重命名（无法首启自装）'
  if (payloadArchive !== undefined && payloadMetadata !== undefined) {
    const escapedPayload = nsiEscape(payloadArchive)
    payloadRename = [
      `  CreateDirectory "$INSTDIR\\@@APP_DIR_NAME@@\\bin\\.installer"`,
      `  Rename "$INSTDIR\\@@APP_DIR_NAME@@\\Resources\\${escapedPayload}" "$INSTDIR\\@@APP_DIR_NAME@@\\bin\\.installer\\launcher.tar.zst"`,
      `  Rename "$INSTDIR\\@@APP_DIR_NAME@@\\Resources\\metadata.json" "$INSTDIR\\@@APP_DIR_NAME@@\\bin\\.installer\\launcher.metadata.json"`,
    ].join('\n')
  }
const nsi = nsiTemplate.replaceAll('@@PAYLOAD_RENAME@@', payloadRename).replaceAll('@@APP_NAME@@', 'DeepSeek Harness Desktop BUN').replaceAll('@@APP_ID@@', 'DeepSeekHarnessDesktopBUN').replaceAll('@@APP_DIR_NAME@@', appDirName)

const nsiPath = join(projectRoot, 'build', 'installer-windows.nsi')
await Bun.write(nsiPath, nsi)
const sourceCount = listFilesRecursive(appDir).length
console.log(`[installer] 应用目录：${appDir}（${String(sourceCount)} 个文件）`)
console.log(`[installer] NSIS 脚本：${nsiPath}`)
/** 定位 makensis：PATH 上先找，找不到再探 choco/NSIS 的固定安装位置（CI 刚装完时 PATH 可能还没刷新）。 */
function resolveMakensis() {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['makensis'], { encoding: 'utf8' })
  const fromPath = typeof probe.stdout === 'string' ? probe.stdout.split(/\r?\n/)[0]?.trim() ?? '' : ''
  if (probe.status === 0 && fromPath !== '') return fromPath
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\NSIS\\makensis.exe',
        'C:\\ProgramData\\chocolatey\\lib\\nsis\\tools\\nsis\\Bin\\makensis.exe',
        'C:\\ProgramData\\chocolatey\\bin\\makensis.exe',
      ]
    : ['/usr/local/bin/makensis', '/opt/homebrew/bin/makensis']
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const makensisPath = resolveMakensis()
if (makensisPath === null) {
  console.error('[installer] 找不到 makensis（GitHub 镜像自带；本地 choco install nsis）')
  process.exit(1)
}
console.log(`[installer] makensis：${makensisPath}`)
const makensis = spawnSync(makensisPath, [nsiPath], { stdio: 'inherit' })
if (makensis.status !== 0 || makensis.error !== undefined) {
  console.error('[installer] makensis 编译失败（看上方 NSIS 输出定位 .nsi 行号）')
  process.exit(1)
}
const info = statSync(outFile)
if (info.size < 1_000_000) {
  console.error(`[installer] 产物异常地小：${outFile}（${String(info.size)} B）`)
  process.exit(1)
}
console.log(`[installer] 完成：${outFile}（${String(info.size)} B）`)
