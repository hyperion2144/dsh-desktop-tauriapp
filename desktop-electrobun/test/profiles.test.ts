// profile 列表与过滤（纯 fs，缝 ② 可测）。
//
// 这条过滤的由来：`<DSH_HOME>/profiles/` 下还住着 `node_modules` 之类的目录，早先直接列目录
// 就会把它们当成 profile 摆进托盘（维护者实机截图：「PROFILE 窗口」子菜单里多了个 node_modules）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { PROFILE_MARKERS, isProfileDir, listProfiles, profilesDir, runtimeLabel } from '../src/bun/profiles.ts'

const roots: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
  roots.push(dir)
  return dir
}

/** 造一个「像 profile」的目录（dsh 写模板时会落下的那几份文件）。 */
function makeProfile(home: string, name: string, markers: readonly string[] = PROFILE_MARKERS): string {
  const dir = join(profilesDir(home), name)
  mkdirSync(dir, { recursive: true })
  for (const marker of markers) writeFileSync(join(dir, marker), '', 'utf8')
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('profile 列表', () => {
  test('只列带标志文件的目录，node_modules 这类不算 profile', () => {
    const home = tempHome()
    makeProfile(home, 'desktop')
    makeProfile(home, 'web')
    mkdirSync(join(profilesDir(home), 'node_modules'), { recursive: true })
    mkdirSync(join(profilesDir(home), 'cache'), { recursive: true })

    expect(listProfiles(home, 'desktop')).toEqual(['desktop', 'web'])
  })

  test('缺一个标志文件就不算（cordis.yml 是 dsh 自己写的，缺了多半是别的目录）', () => {
    const home = tempHome()
    makeProfile(home, 'half', ['package.json'])
    mkdirSync(profilesDir(home), { recursive: true })

    expect(isProfileDir(join(profilesDir(home), 'half'))).toBe(false)
    expect(listProfiles(home, 'desktop')).toEqual(['desktop'])
  })

  test('当前 profile 永远在列表里（哪怕它还没被建出来）', () => {
    const home = tempHome()
    makeProfile(home, 'web')

    expect(listProfiles(home, 'desktop')).toEqual(['desktop', 'web'])
    expect(listProfiles(home, 'web')).toEqual(['web'])
  })

  test('profiles 目录不存在时只回当前 profile', () => {
    const home = tempHome()
    expect(listProfiles(home, 'desktop')).toEqual(['desktop'])
  })

  test('排序稳定（localeCompare，与直接 sort 的差别在大小写）', () => {
    const home = tempHome()
    for (const name of ['zeta', 'alpha', 'Beta']) makeProfile(home, name)

    expect(listProfiles(home, 'alpha')).toEqual(['alpha', 'Beta', 'zeta'])
  })
})

describe('运行时标签', () => {
  test('取目录名（Windows 反斜杠路径只在 Windows 上成立）', () => {
    expect(runtimeLabel('/Users/x/runtimes/0.2.1-alpha.2')).toBe('内置 0.2.1-alpha.2')
    // node:path 的平台风味跟着运行时走：macOS/Linux 上 basename 不认反斜杠，只有 Windows 才认。
    if (process.platform === 'win32') {
      expect(runtimeLabel('C:\\Users\\x\\runtimes\\0.2.1-alpha.2')).toBe('内置 0.2.1-alpha.2')
    }
  })
})
