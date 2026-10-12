// 通知授权桥（缝 ② 纯逻辑 + 门禁）。
//
// 守的是什么：macOS 上「已授权」以前是写死的（维护者一眼看穿），现在由我们自己的 UN 桥
// （`native/notify_un.m`，旧壳 `network/notify_un.rs` 的等价物）真读、真申请。这一层要守住两件事：
//   1. 状态码 → 面板文案的映射（含被拒时引导去系统设置，旧壳的行为）；
//   2. **进程身份门**：裸 bun（CI / 黑盒 / `bun run`）没有 CFBundleIdentifier，这时碰 UN 会让
//      Bun 直接 panic（实测「A C++ exception occurred」）——所以库的定位与可用性判断必须先拦住。

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  hasBundleIdentity,
  resolveNotifyLib,
  createNativeNotify,
  NOTIFY_LIB_NAME,
} from '../src/bun/notify-un.ts'
import {
  MACOS_NOTIFICATION_SETTINGS_URL,
  permissionFromCode,
  permissionHint,
  permissionLabel,
  isPermissionGranted,
  type NotifyPermission,
} from '../src/shared/notify-permission.ts'

const APP_EXEC = '/Applications/DeepSeek Harness Desktop.app/Contents/MacOS/bun'
const BARE_EXEC = '/Users/x/.hutch/toolchains/bun/1.4.0/macos-arm64/bun'


// 这条断言依赖仓内 native/libdsh-notify.dylib（build:native 的产物，不入库）。
// 本地/CI 里没先跑 build:native、或本就不是 macOS 时跳过，而不是判失败。
const REPO_NATIVE_LIB = join(import.meta.dir, '..', 'native', NOTIFY_LIB_NAME)
const dylibBuilt = existsSync(REPO_NATIVE_LIB)
describe('授权状态映射（旧壳 notify_un.rs 的 permission_state）', () => {
  test('原生码 → 状态：3 已授权、2 已拒绝、1 未决定、其余不可用', () => {
    expect(permissionFromCode(3)).toBe('granted')
    expect(permissionFromCode(2)).toBe('denied')
    expect(permissionFromCode(1)).toBe('not_determined')
    expect(permissionFromCode(0)).toBe('unavailable')
    // 没见过的码宁可说不可用，也不要说成已授权（否则面板骗人）
    expect(permissionFromCode(99)).toBe('unavailable')
    expect(permissionFromCode(-1)).toBe('unavailable')
  })

  test('只有 granted 才算已授权', () => {
    expect(isPermissionGranted('granted')).toBe(true)
    for (const other of ['denied', 'not_determined', 'unavailable'] as NotifyPermission[]) {
      expect(isPermissionGranted(other)).toBe(false)
    }
  })

  test('面板文案：四种状态各一句话', () => {
    expect(permissionLabel('granted')).toBe('已授权')
    expect(permissionLabel('denied')).toBe('已拒绝')
    expect(permissionLabel('not_determined')).toBe('未决定')
    expect(permissionLabel('unavailable')).toBe('不可用')
  })

  test('被拒时引导去系统设置（旧壳原话「可在系统设置→通知中手动开启」）', () => {
    const hint = permissionHint('denied', 'darwin')
    expect(hint).toContain('系统设置')
    expect(hint).toContain('通知')
    expect(hint).toContain('DeepSeek Harness Desktop')
    // 非 macOS 不给 macOS 专属路径
    expect(permissionHint('denied', 'win32')).not.toContain('DeepSeek Harness Desktop')
    expect(permissionHint('granted')).toContain('允许')
    expect(permissionHint('not_determined')).toContain('弹窗')
    // 不可用要说清「开发态裸进程没身份、打包后可用」，别让人以为是用户没授权
    expect(permissionHint('unavailable')).toContain('打包后可用')
  })

  test('系统设置深链指向通知面板', () => {
    expect(MACOS_NOTIFICATION_SETTINGS_URL).toContain('systempreferences')
  })
})

describe('进程身份门（裸进程里碰 UN 会让 Bun 崩）', () => {
  test('只有 .app/Contents/MacOS 下的可执行体算有身份', () => {
    expect(hasBundleIdentity(APP_EXEC)).toBe(true)
    expect(hasBundleIdentity('/Applications/X.app/Contents/MacOS/X')).toBe(true)
    expect(hasBundleIdentity(BARE_EXEC)).toBe(false)
    // dev 的 .app 也算（hutch electrobun dev 起的就是 dev .app）
    expect(
      hasBundleIdentity(
        '/repo/desktop-electrobun/build/dev-macos-arm64/DeepSeek Harness Desktop BUN-dev.app/Contents/MacOS/bun',
      ),
    ).toBe(true)
    // 只是名字里带 .app 的普通路径不算
    expect(hasBundleIdentity('/tmp/foo.app/bun')).toBe(false)
  })

  test('没身份时直接判不可用，连库都不找（避免 dlopen 之后误调 UN）', () => {
    const logs: string[] = []
    const bridge = createNativeNotify({
      platform: 'darwin',
      execPath: BARE_EXEC,
      log: (line) => logs.push(line),
    })
    expect(bridge.available).toBe(false)
    expect(bridge.status()).toBe('unavailable')
    expect(bridge.request()).toBe('unavailable')
    expect(bridge.post({ title: 't', body: 'b', sound: true })).toBe(false)
    expect(logs.some((line) => line.includes('.app 身份'))).toBe(true)
  })

  test('非 macOS 不找库，直接不可用', () => {
    const logs: string[] = []
    const bridge = createNativeNotify({ platform: 'win32', execPath: APP_EXEC, log: (l) => logs.push(l) })
    expect(bridge.available).toBe(false)
    expect(logs.some((line) => line.includes('没有 UN 桥'))).toBe(true)
  })
})

describe('库定位顺序（环境变量 > 包内 runtime > 可执行体同级 > 仓内 native/）', () => {
  test('DSH_SHELL_NOTIFY_LIB 优先', () => {
    const path = resolveNotifyLib({
      env: { DSH_SHELL_NOTIFY_LIB: '/custom/lib.dylib' },
      execPath: APP_EXEC,
      resourcesDir: '/res',
      exists: () => true,
    })
    expect(path).toBe('/custom/lib.dylib')
  })

  test('没环境变量时：先看包内 Resources/runtime，再看可执行体同级', () => {
    const seen: string[] = []
    const path = resolveNotifyLib({
      env: {},
      execPath: APP_EXEC,
      resourcesDir: '/res',
      exists: (candidate) => {
        seen.push(candidate)
        // 断言与实现都走 join，Windows 上的反斜杠路径才不会把 exists 断成 false
        return candidate.startsWith(join('/res'))
      },
    })
    expect(path).toBe(join('/res', 'runtime', NOTIFY_LIB_NAME))
    expect(seen[0]).toBe(join('/res', 'runtime', NOTIFY_LIB_NAME))
  })

  test('包内没有时退到可执行体同级（Resources/app/runtime 优先于 Resources/runtime）', () => {
    const seen: string[] = []
    const path = resolveNotifyLib({
      env: {},
      execPath: APP_EXEC,
      resourcesDir: null,
      exists: (candidate) => {
        seen.push(candidate)
        return candidate.includes(join('Contents', 'Resources', 'runtime'))
      },
    })
    expect(path).toBe(join('/Applications/DeepSeek Harness Desktop.app/Contents/Resources/runtime', NOTIFY_LIB_NAME))
    // Electrobun 真正的位置先被问过（Resources/app/runtime），只是这次里没有
    expect(seen[0]).toBe(
      join('/Applications/DeepSeek Harness Desktop.app/Contents/Resources/app/runtime', NOTIFY_LIB_NAME),
    )
  })

  test('打包/dev 的真实位置：Contents/Resources/app/runtime（Electrobun 的包内根）', () => {
    const path = resolveNotifyLib({
      env: {},
      execPath: APP_EXEC,
      resourcesDir: null,
      exists: (candidate) => candidate.includes(join('Resources', 'app', 'runtime')),
    })
    expect(path).toBe(join('/Applications/DeepSeek Harness Desktop.app/Contents/Resources/app/runtime', NOTIFY_LIB_NAME))
  })

  test('开发态：仓内 desktop-electrobun/native/ 也能找到', () => {
    const path = resolveNotifyLib({
      env: {},
      execPath: BARE_EXEC,
      resourcesDir: null,
      // 前面三个候选都不在，只有仓内 native/ 命中
      exists: (candidate) => candidate.includes(`${join('desktop-electrobun', 'native')}`),
    })
    expect(path?.endsWith(join('native', NOTIFY_LIB_NAME))).toBe(true)
  })

  test('哪儿都没有 ⇒ null（调用方报「没找到」而不是崩）', () => {
    expect(resolveNotifyLib({ env: {}, execPath: BARE_EXEC, resourcesDir: null, exists: () => false })).toBeNull()
  })

  test.skipIf(!dylibBuilt)('本仓的 dylib 就位：dev .app 身份下桥可用（只 dlopen，不调 UN）', () => {
    const logs: string[] = []
    const bridge = createNativeNotify({ platform: 'darwin', execPath: APP_EXEC, log: (l) => logs.push(l) })
    expect(bridge.available).toBe(true)
    expect(bridge.libPath?.endsWith(NOTIFY_LIB_NAME)).toBe(true)
    expect(logs).toEqual([])
  })
})
