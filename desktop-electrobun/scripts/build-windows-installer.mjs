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

/** 找 Windows 构建目录：优先 stable-windows-x64，其次名字带 windows 的最新一个。 */
function pickBuildDir() {
  if (!existsSync(buildRoot)) return null
  const entries = readdirSync(buildRoot).filter((name) => !name.startsWith('.'))
  const stable = entries.filter((name) => name.startsWith('stable-windows'))
  const windows = entries.filter((name) => name.includes('windows'))
  const chosen = (stable.length > 0 ? stable : windows).sort().pop()
  return chosen === undefined ? null : join(buildRoot, chosen)
}

/** 在构建目录里找「应用目录」：含 launcher.exe（Electrobun Windows 的可执行外壳）的那层。 */
function findAppDir(root, depth = 0) {
  if (depth > 3 || !existsSync(root)) return null
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    if (existsSync(join(full, 'launcher.exe'))) return full
    const hit = findAppDir(full, depth + 1)
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
const appDir = findAppDir(buildDir)
if (appDir === null) {
  console.error(`[installer] ${buildDir} 里找不到应用目录（launcher.exe 那层）`)
  process.exit(1)
}
const appDirName = appDir.slice(buildDir.length + 1).split(sep)[0] ?? ''
const iconPath = join(projectRoot, 'resources', 'app-icon.ico')
if (!existsSync(iconPath)) {
  console.error('[installer] 缺 resources/app-icon.ico（先跑 prepare:bundle 或提交仓内源）')
  process.exit(1)
}

// 应用目录可能上万文件（CEF），逐条 File /r 会爆命令行：改成在 NSIS 里对整目录 /r 递归。
// OutFile 固定落 artifacts/（与 mac dmg 同一个交付目录）。
const outFile = join(projectRoot, 'artifacts', 'windows-x64-DeepSeekHarnessDesktopBUN-setup.exe')
const nsi = `
!define APP_NAME "DeepSeek Harness Desktop BUN"
!define APP_ID "DeepSeekHarnessDesktopBUN"
!define APP_DIR_NAME "${nsiEscape(appDirName)}"

Name "$\${APP_NAME}"
OutFile "${nsiEscape(outFile)}"
InstallDir "$LOCALAPPDATA\\$\${APP_ID}"
InstallDirRegKey HKCU "Software\\$\${APP_ID}" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUnInstDetails show
Icon "${nsiEscape(iconPath)}"
UninstallIcon "${nsiEscape(iconPath)}"
Caption "$\${APP_NAME} 安装程序"
SpaceTexts none

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "install"
  SetOutPath "$INSTDIR\\$\${APP_DIR_NAME}"
  File /r "${nsiEscape(appDir)}\\*.*"
  WriteUninstaller "$INSTDIR\\$\${APP_DIR_NAME}\\uninstall.exe"
  WriteRegStr HKCU "Software\\$\${APP_ID}" "InstallDir" $INSTDIR
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$\${APP_ID}" "DisplayName" "$\${APP_NAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$\${APP_ID}" "DisplayIcon" "$INSTDIR\\$\${APP_DIR_NAME}\\launcher.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$\${APP_ID}" "UninstallString" "$INSTDIR\\$\${APP_DIR_NAME}\\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\\$\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\\$\${APP_NAME}\\$\${APP_NAME}.lnk" "$INSTDIR\\$\${APP_DIR_NAME}\\launcher.exe"
  CreateShortCut "$SMPROGRAMS\\$\${APP_NAME}\\卸载.lnk" "$INSTDIR\\$\${APP_DIR_NAME}\\uninstall.exe"
SectionEnd

Section "un.install"
  ; 卸载器的 $INSTDIR 从安装时写的注册表恢复（用户自定义目录也要卸干净）
  ReadRegStr $INSTDIR HKCU "Software\\$\${APP_ID}" "InstallDir"
  Delete "$SMPROGRAMS\\$\${APP_NAME}\\$\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\\$\${APP_NAME}\\卸载.lnk"
  RMDir "$SMPROGRAMS\\$\${APP_NAME}"
  RMDir /r "$INSTDIR\\$\${APP_DIR_NAME}"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$\${APP_ID}"
  DeleteRegKey HKCU "Software\\$\${APP_ID}"
SectionEnd
`

const nsiPath = join(projectRoot, 'build', 'installer-windows.nsi')
await Bun.write(nsiPath, nsi)
const sourceCount = listFilesRecursive(appDir).length
console.log(`[installer] 应用目录：${appDir}（${String(sourceCount)} 个文件）`)
console.log(`[installer] NSIS 脚本：${nsiPath}`)

const makensis = spawnSync('makensis', [nsiPath], { stdio: 'inherit' })
if (makensis.status !== 0 || makensis.error !== undefined) {
  console.error('[installer] makensis 失败（PATH 里没有 NSIS？GitHub 镜像自带；本地 choco install nsis）')
  process.exit(1)
}
const info = statSync(outFile)
if (info.size < 1_000_000) {
  console.error(`[installer] 产物异常地小：${outFile}（${String(info.size)} B）`)
  process.exit(1)
}
console.log(`[installer] 完成：${outFile}（${String(info.size)} B）`)
